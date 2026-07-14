-- Multi-vault graph: every note across all the vaults the caller belongs to,
-- as one payload. Nodes carry their vault_id (for per-vault coloring/clusters);
-- edges (wikilinks + AI similarity) stay WITHIN each vault, so each vault forms
-- a self-contained cluster. SECURITY INVOKER → RLS limits it to the caller's
-- vaults. Run in the SQL editor after 0006.

create or replace function public.user_graph(p_threshold double precision default 0.3, p_neighbors int default 6)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with my_vaults as (
    select v.id, v.name, v.owner_id
    from public.vaults v
    where public.vault_role(v.id) is not null
  ),
  my_notes as (
    select n.id, n.title, n.vault_id
    from public.notes n
    where n.vault_id in (select id from my_vaults)
  ),
  user_edges as (
    select l.src, l.dst
    from public.links l
    join my_notes a on a.id = l.src
    join my_notes b on b.id = l.dst and b.vault_id = a.vault_id
  ),
  ai_edges as (
    select a.id as src, nb.id as dst, nb.sim
    from my_notes a
    cross join lateral (
      select n2.id, 1 - (e2.embedding operator(extensions.<=>) e1.embedding) as sim
      from public.note_embeddings e1
      join public.note_embeddings e2 on e2.note_id <> e1.note_id
      join my_notes n2 on n2.id = e2.note_id and n2.vault_id = a.vault_id
      where e1.note_id = a.id
      order by e2.embedding operator(extensions.<=>) e1.embedding
      limit greatest(1, least(p_neighbors, 20))
    ) nb
    where nb.sim >= p_threshold and a.id < nb.id -- dedupe symmetric pair
  )
  select jsonb_build_object(
    'vaults', coalesce((
      select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'owner', coalesce(p.email, v.owner_id)))
      from my_vaults v left join public.profiles p on p.user_id = v.owner_id
    ), '[]'::jsonb),
    'nodes', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'vault', vault_id)) from my_notes
    ), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(e) from (
        select jsonb_build_object('source', src, 'target', dst, 'type', 'user') as e from user_edges
        union all
        select jsonb_build_object('source', src, 'target', dst, 'type', 'ai', 'sim', sim) from ai_edges
      ) edges), '[]'::jsonb)
  )
$$;
