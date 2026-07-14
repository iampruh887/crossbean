-- Performance migration. Run in the Supabase SQL editor after 0007.
-- Two wins:
--   (6) a generated body_snippet column so the note list ships snippets, not
--       full bodies.
--   (7) set-based RLS: evaluate vault membership ONCE per statement (a hashed
--       subplan) instead of calling vault_role() once per row.

begin;

-- (6) cheap list snippet
alter table public.notes add column if not exists body_snippet text
  generated always as (left(body, 200)) stored;

-- (7) membership as set-returning SECURITY DEFINER helpers (definer avoids RLS
-- recursion on vault_members; the caller's policies use them as `IN (select …)`
-- which Postgres evaluates once per statement and hashes).
create or replace function public.my_vault_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select vault_id from public.vault_members where user_id = public.clerk_uid()
$$;
create or replace function public.my_editable_vault_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select vault_id from public.vault_members
  where user_id = public.clerk_uid() and role in ('owner','editor')
$$;

-- notes
drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select
  using (vault_id in (select public.my_vault_ids()));
drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert
  with check (vault_id in (select public.my_editable_vault_ids()));
drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update
  using (vault_id in (select public.my_editable_vault_ids()));
drop policy if exists notes_delete on public.notes;
create policy notes_delete on public.notes for delete
  using (vault_id in (select public.my_editable_vault_ids()));

-- links (inherit access from the source note's vault)
drop policy if exists links_select on public.links;
create policy links_select on public.links for select
  using (exists (select 1 from public.notes n where n.id = src and n.vault_id in (select public.my_vault_ids())));
drop policy if exists links_write on public.links;
create policy links_write on public.links for insert
  with check (exists (select 1 from public.notes n where n.id = src and n.vault_id in (select public.my_editable_vault_ids())));
drop policy if exists links_delete on public.links;
create policy links_delete on public.links for delete
  using (exists (select 1 from public.notes n where n.id = src and n.vault_id in (select public.my_editable_vault_ids())));

-- note_embeddings (inherit access from the note's vault)
drop policy if exists embeddings_select on public.note_embeddings;
create policy embeddings_select on public.note_embeddings for select
  using (exists (select 1 from public.notes n where n.id = note_id and n.vault_id in (select public.my_vault_ids())));
drop policy if exists embeddings_insert on public.note_embeddings;
create policy embeddings_insert on public.note_embeddings for insert
  with check (exists (select 1 from public.notes n where n.id = note_id and n.vault_id in (select public.my_editable_vault_ids())));
drop policy if exists embeddings_update on public.note_embeddings;
create policy embeddings_update on public.note_embeddings for update
  using (exists (select 1 from public.notes n where n.id = note_id and n.vault_id in (select public.my_editable_vault_ids())));
drop policy if exists embeddings_delete on public.note_embeddings;
create policy embeddings_delete on public.note_embeddings for delete
  using (exists (select 1 from public.notes n where n.id = note_id and n.vault_id in (select public.my_editable_vault_ids())));

commit;
