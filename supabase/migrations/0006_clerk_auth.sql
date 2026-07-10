-- Switch identity from Supabase Auth to Clerk (third-party auth).
-- Clerk issues the JWTs; Supabase verifies them and RLS keys on the Clerk
-- user id in the `sub` claim (a text id like "user_2abc...", not a uuid).
-- Prereq (dashboards): activate the Supabase integration in Clerk, then add
-- Clerk as a provider under Supabase → Authentication → Sign In / Providers.
--
-- Safe to run on a fresh project right after 0001–0005. Destructive to any
-- existing users/vaults (there shouldn't be any yet).

-- The caller's Clerk user id.
create or replace function public.clerk_uid() returns text
language sql stable set search_path = '' as $$
  select nullif(auth.jwt()->>'sub', '')
$$;

-- ---- identity plumbing moves off auth.users --------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- Clean out anything created under the old uuid identities.
truncate public.vault_members, public.notes, public.links, public.note_embeddings cascade;
delete from public.vaults;

-- user_id/owner_id become Clerk text ids (and stop referencing auth.users).
alter table public.vaults drop constraint vaults_owner_id_fkey;
alter table public.vaults alter column owner_id type text using owner_id::text;

drop policy if exists members_delete on public.vault_members;
alter table public.vault_members drop constraint vault_members_user_id_fkey;
alter table public.vault_members alter column user_id type text using user_id::text;

-- Emails for invite-by-email live here now (auth.users is out of the picture).
-- Each user upserts their own row on login; lookups happen in definer RPCs.
create table public.profiles (
  user_id    text primary key,
  email      text not null,
  updated_at timestamptz not null default now()
);
create unique index profiles_email_idx on public.profiles (lower(email));
alter table public.profiles enable row level security;
create policy profiles_own_select on public.profiles for select
  using (user_id = public.clerk_uid());
create policy profiles_own_insert on public.profiles for insert
  with check (user_id = public.clerk_uid());
create policy profiles_own_update on public.profiles for update
  using (user_id = public.clerk_uid());

-- ---- re-key membership on the Clerk id -------------------------------------
-- Same signature as 0002, so every existing policy (notes, links, embeddings,
-- storage) picks this up without being touched.
create or replace function public.vault_role(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.vault_members
  where vault_id = p_vault and user_id = public.clerk_uid()
$$;

create policy members_delete on public.vault_members for delete
  using (public.vault_role(vault_id) = 'owner' or user_id = public.clerk_uid());

-- ---- RPCs re-keyed on the Clerk id -----------------------------------------
create or replace function public.create_vault(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if public.clerk_uid() is null then raise exception 'not authenticated'; end if;
  insert into public.vaults (name, owner_id) values (trim(p_name), public.clerk_uid())
    returning id into v_id;
  insert into public.vault_members (vault_id, user_id, role)
    values (v_id, public.clerk_uid(), 'owner');
  return v_id;
end $$;

create or replace function public.invite_to_vault(p_vault uuid, p_email text, p_role text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_user text;
begin
  if public.vault_role(p_vault) <> 'owner' then
    raise exception 'only the vault owner can invite';
  end if;
  if p_role not in ('editor','viewer') then
    raise exception 'role must be editor or viewer';
  end if;
  select user_id into v_user from public.profiles
    where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'no crossbean account with that email (they need to sign in once first)';
  end if;
  insert into public.vault_members (vault_id, user_id, role)
    values (p_vault, v_user, p_role)
    on conflict (vault_id, user_id) do update set role = excluded.role;
end $$;

-- return type changes (user_id uuid → text), so replace isn't allowed
drop function public.list_vault_members(uuid);
create function public.list_vault_members(p_vault uuid)
returns table (user_id text, email text, role text)
language plpgsql security definer set search_path = '' as $$
begin
  if public.vault_role(p_vault) is null then
    raise exception 'not a member of this vault';
  end if;
  return query
    select m.user_id, coalesce(p.email, m.user_id), m.role
    from public.vault_members m
    left join public.profiles p on p.user_id = m.user_id
    where m.vault_id = p_vault
    order by m.added_at;
end $$;
