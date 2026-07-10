-- Row-Level Security: membership is THE security model. All access control
-- lives here in the database — the client is untrusted.

-- The caller's role in a vault, or null. SECURITY DEFINER so policies on
-- vault_members itself can call it without infinite RLS recursion.
create function public.vault_role(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.vault_members
  where vault_id = p_vault and user_id = auth.uid()
$$;

create function public.can_edit(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.vault_role(p_vault) in ('owner','editor')
$$;

alter table public.vaults          enable row level security;
alter table public.vault_members   enable row level security;
alter table public.notes           enable row level security;
alter table public.links           enable row level security;
alter table public.note_embeddings enable row level security;

-- vaults: members see them; only the owner renames/deletes. Creation goes
-- through the create_vault() RPC (security definer), not direct INSERT.
create policy vaults_select on public.vaults for select
  using (public.vault_role(id) is not null);
create policy vaults_update on public.vaults for update
  using (public.vault_role(id) = 'owner');
create policy vaults_delete on public.vaults for delete
  using (public.vault_role(id) = 'owner');

-- vault_members: members can see the roster; owners manage it via RPCs
-- (invite_to_vault / remove_member), except owners may delete rows directly
-- (used for "leave vault" too — anyone can remove themselves).
create policy members_select on public.vault_members for select
  using (public.vault_role(vault_id) is not null);
create policy members_delete on public.vault_members for delete
  using (public.vault_role(vault_id) = 'owner' or user_id = auth.uid());

-- notes: members read; editors and owners write.
create policy notes_select on public.notes for select
  using (public.vault_role(vault_id) is not null);
create policy notes_insert on public.notes for insert
  with check (public.can_edit(vault_id));
create policy notes_update on public.notes for update
  using (public.can_edit(vault_id));
create policy notes_delete on public.notes for delete
  using (public.can_edit(vault_id));

-- links + embeddings inherit access from their source note's vault.
create policy links_select on public.links for select
  using (exists (select 1 from public.notes n where n.id = src
                 and public.vault_role(n.vault_id) is not null));
create policy links_write on public.links for insert
  with check (exists (select 1 from public.notes n where n.id = src
                      and public.can_edit(n.vault_id)));
create policy links_delete on public.links for delete
  using (exists (select 1 from public.notes n where n.id = src
                 and public.can_edit(n.vault_id)));

create policy embeddings_select on public.note_embeddings for select
  using (exists (select 1 from public.notes n where n.id = note_id
                 and public.vault_role(n.vault_id) is not null));
create policy embeddings_insert on public.note_embeddings for insert
  with check (exists (select 1 from public.notes n where n.id = note_id
                      and public.can_edit(n.vault_id)));
create policy embeddings_update on public.note_embeddings for update
  using (exists (select 1 from public.notes n where n.id = note_id
                 and public.can_edit(n.vault_id)));
create policy embeddings_delete on public.note_embeddings for delete
  using (exists (select 1 from public.notes n where n.id = note_id
                 and public.can_edit(n.vault_id)));
