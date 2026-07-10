-- crossbean web: multi-user vaults with notes, wikilinks, and pgvector embeddings.
-- Run migrations in order (0001 → 0005) in the Supabase SQL editor or via `supabase db push`.

create extension if not exists vector with schema extensions;

create table public.vaults (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.vault_members (
  vault_id  uuid not null references public.vaults(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null check (role in ('owner','editor','viewer')),
  added_at  timestamptz not null default now(),
  primary key (vault_id, user_id)
);

create table public.notes (
  id         bigint generated always as identity primary key,
  vault_id   uuid not null references public.vaults(id) on delete cascade,
  title      text not null default 'Untitled',
  body       text not null default '',
  grp        text,
  updated_at timestamptz not null default now()
);
create index notes_vault_idx on public.notes (vault_id, updated_at desc);

create table public.links (
  src bigint not null references public.notes(id) on delete cascade,
  dst bigint not null references public.notes(id) on delete cascade,
  primary key (src, dst)
);
create index links_dst_idx on public.links (dst);

create table public.note_embeddings (
  note_id   bigint primary key references public.notes(id) on delete cascade,
  embedding extensions.vector(384) not null -- all-MiniLM-L6-v2
);
create index note_embeddings_hnsw on public.note_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);

-- keep notes.updated_at honest
create function public.touch_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();
