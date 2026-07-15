-- Attachments: files (images, PDFs, etc.) associated with a note.
-- Inherits vault membership access from the parent note, using the same
-- my_vault_ids() / my_editable_vault_ids() helpers introduced in 0008.
-- Run in the Supabase SQL editor after 0008.

begin;

create table if not exists public.attachments (
  id        bigint generated always as identity primary key,
  note_id   bigint not null references public.notes(id) on delete cascade,
  url       text   not null,
  name      text   not null,
  mime      text   not null,
  added_at  timestamptz not null default now()
);

create index if not exists attachments_note_id_idx on public.attachments (note_id);

alter table public.attachments enable row level security;

-- SELECT: visible when the parent note's vault is accessible to the caller.
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select
  using (exists (
    select 1 from public.notes n
    where n.id = note_id
      and n.vault_id in (select public.my_vault_ids())
  ));

-- INSERT: allowed when the parent note's vault is editable by the caller.
drop policy if exists attachments_insert on public.attachments;
create policy attachments_insert on public.attachments for insert
  with check (exists (
    select 1 from public.notes n
    where n.id = note_id
      and n.vault_id in (select public.my_editable_vault_ids())
  ));

-- UPDATE: using + with check both require editable vault membership.
drop policy if exists attachments_update on public.attachments;
create policy attachments_update on public.attachments for update
  using (exists (
    select 1 from public.notes n
    where n.id = note_id
      and n.vault_id in (select public.my_editable_vault_ids())
  ))
  with check (exists (
    select 1 from public.notes n
    where n.id = note_id
      and n.vault_id in (select public.my_editable_vault_ids())
  ));

-- DELETE: allowed when the parent note's vault is editable by the caller.
drop policy if exists attachments_delete on public.attachments;
create policy attachments_delete on public.attachments for delete
  using (exists (
    select 1 from public.notes n
    where n.id = note_id
      and n.vault_id in (select public.my_editable_vault_ids())
  ));

commit;
