-- Cross-vault semantic search RPCs.
-- Both functions are SECURITY INVOKER so RLS continues to filter rows to only
-- the vaults the caller belongs to. The my_vaults CTE mirrors 0007_user_graph.sql
-- exactly: vault_role() returns non-null only for vaults the caller is a member
-- of, so no notes from unjoined vaults can leak through.
-- 0003_rpcs.sql does not add explicit GRANT EXECUTE statements (Postgres default
-- grants execute to PUBLIC); these new functions follow the same convention.

-- 1. suggest_notes_cross_vault
--    Top p_k notes most similar to p_note across ALL of the caller's vaults.
--    Modelled on suggest_notes() in 0003 but replaces the single-vault filter
--    (n.vault_id = src.vault_id) with the my_vaults CTE from 0007.
--    p_note itself is excluded from the results.
--    Returns: id bigint, vault_id uuid, sim real  (ordered by sim desc, limit p_k)
create or replace function public.suggest_notes_cross_vault(p_note bigint, p_k int default 6)
returns table (id bigint, vault_id uuid, sim real)
language sql stable security invoker set search_path = '' as $$
  with my_vaults as (
    select v.id
    from public.vaults v
    where public.vault_role(v.id) is not null
  )
  select
    n.id,
    n.vault_id,
    (1 - (e.embedding operator(extensions.<=>) q.embedding))::real as sim
  from public.note_embeddings q
  join public.notes n on n.id <> p_note
                     and n.vault_id in (select id from my_vaults)
  join public.note_embeddings e on e.note_id = n.id
  where q.note_id = p_note
  order by e.embedding operator(extensions.<=>) q.embedding
  limit greatest(1, least(p_k, 50))
$$;

-- 2. match_notes_cross_vault
--    Semantic search using a caller-supplied query embedding across ALL of the
--    caller's vaults. Mirrors match_notes() in 0003 but scoped cross-vault.
--    Returns: id bigint, vault_id uuid, sim real  (ordered by sim desc, limit p_k)
create or replace function public.match_notes_cross_vault(p_query extensions.vector(384), p_k int default 20)
returns table (id bigint, vault_id uuid, sim real)
language sql stable security invoker set search_path = '' as $$
  with my_vaults as (
    select v.id
    from public.vaults v
    where public.vault_role(v.id) is not null
  )
  select
    n.id,
    n.vault_id,
    (1 - (e.embedding operator(extensions.<=>) p_query))::real as sim
  from public.notes n
  join public.note_embeddings e on e.note_id = n.id
  where n.vault_id in (select id from my_vaults)
  order by e.embedding operator(extensions.<=>) p_query
  limit greatest(1, least(p_k, 100))
$$;
