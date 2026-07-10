-- Every new user gets a personal vault so the app is usable immediately.

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.vaults (name, owner_id) values ('Personal', new.id)
    returning id into v_id;
  insert into public.vault_members (vault_id, user_id, role)
    values (v_id, new.id, 'owner');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
