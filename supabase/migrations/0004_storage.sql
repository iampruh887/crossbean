-- Image attachments live in Storage under attachments/<vault_id>/<uuid>.<ext>.
-- The bucket is public-read so markdown <img> tags work with stable URLs;
-- writes require edit rights on the vault named by the first path segment.
-- (Trade-off: anyone with an image's exact URL can view that image.)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', true,
  15728640, -- 15 MB, matches the desktop app
  array['image/png','image/jpeg','image/gif','image/webp','image/svg+xml']
)
on conflict (id) do nothing;

create policy attachments_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and public.can_edit(((storage.foldername(name))[1])::uuid)
  );

create policy attachments_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and public.can_edit(((storage.foldername(name))[1])::uuid)
  );
