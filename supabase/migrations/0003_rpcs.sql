-- RPCs. Vault management runs SECURITY DEFINER (they must touch rows the
-- caller can't yet see); every one re-checks authorization explicitly.
-- Vector search runs SECURITY INVOKER so RLS keeps filtering rows.

-- Create a vault and make the caller its owner, atomically.
create function public.create_vault(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.vaults (name, owner_id) values (trim(p_name), auth.uid())
    returning id into v_id;
  insert into public.vault_members (vault_id, user_id, role)
    values (v_id, auth.uid(), 'owner');
  return v_id;
end $$;

-- Invite a registered user by email. Owner only; can't grant 'owner'.
create function public.invite_to_vault(p_vault uuid, p_email text, p_role text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  if public.vault_role(p_vault) <> 'owner' then
    raise exception 'only the vault owner can invite';
  end if;
  if p_role not in ('editor','viewer') then
    raise exception 'role must be editor or viewer';
  end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'no crossbean account with that email';
  end if;
  insert into public.vault_members (vault_id, user_id, role)
    values (p_vault, v_user, p_role)
    on conflict (vault_id, user_id) do update set role = excluded.role;
end $$;

-- Roster with emails for the share dialog (emails live in auth.users, which
-- clients can't read directly). Any member may view.
create function public.list_vault_members(p_vault uuid)
returns table (user_id uuid, email text, role text)
language plpgsql security definer set search_path = '' as $$
begin
  if public.vault_role(p_vault) is null then
    raise exception 'not a member of this vault';
  end if;
  return query
    select m.user_id, u.email::text, m.role
    from public.vault_members m join auth.users u on u.id = m.user_id
    where m.vault_id = p_vault
    order by m.added_at;
end $$;

-- Semantic search within a vault (RLS filters to vaults the caller can read).
create function public.match_notes(p_vault uuid, p_query extensions.vector(384), p_k int default 20)
returns table (id bigint, sim double precision)
language sql stable security invoker set search_path = '' as $$
  select n.id, 1 - (e.embedding operator(extensions.<=>) p_query) as sim
  from public.notes n
  join public.note_embeddings e on e.note_id = n.id
  where n.vault_id = p_vault
  order by e.embedding operator(extensions.<=>) p_query
  limit greatest(1, least(p_k, 100))
$$;

-- Related-note suggestions for one note, using its stored embedding.
create function public.suggest_notes(p_note bigint, p_k int default 6)
returns table (id bigint, sim double precision)
language sql stable security invoker set search_path = '' as $$
  select n.id, 1 - (e.embedding operator(extensions.<=>) q.embedding) as sim
  from public.note_embeddings q
  join public.notes src on src.id = q.note_id
  join public.notes n on n.vault_id = src.vault_id and n.id <> q.note_id
  join public.note_embeddings e on e.note_id = n.id
  where q.note_id = p_note
  order by e.embedding operator(extensions.<=>) q.embedding
  limit greatest(1, least(p_k, 50))
$$;

-- Knowledge graph for a vault: notes as nodes; explicit wikilink edges plus
-- AI edges (top-N nearest neighbors per note above the similarity threshold).
create function public.vault_graph(p_vault uuid, p_threshold double precision default 0.3, p_neighbors int default 6)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with vault_notes as (
    select n.id, n.title from public.notes n where n.vault_id = p_vault
  ),
  user_edges as (
    select l.src, l.dst from public.links l
    join vault_notes a on a.id = l.src
    join vault_notes b on b.id = l.dst
  ),
  ai_edges as (
    select a.id as src, nb.id as dst, nb.sim
    from vault_notes a
    cross join lateral (
      select n2.id, 1 - (e2.embedding operator(extensions.<=>) e1.embedding) as sim
      from public.note_embeddings e1
      join public.note_embeddings e2 on e2.note_id <> e1.note_id
      join vault_notes n2 on n2.id = e2.note_id
      where e1.note_id = a.id
      order by e2.embedding operator(extensions.<=>) e1.embedding
      limit greatest(1, least(p_neighbors, 20))
    ) nb
    where nb.sim >= p_threshold and a.id < nb.id -- dedupe the symmetric pair
  )
  select jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title)) from vault_notes), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(e) from (
        select jsonb_build_object('source', src, 'target', dst, 'type', 'user') as e from user_edges
        union all
        select jsonb_build_object('source', src, 'target', dst, 'type', 'ai', 'sim', sim) from ai_edges
      ) edges), '[]'::jsonb)
  )
$$;
