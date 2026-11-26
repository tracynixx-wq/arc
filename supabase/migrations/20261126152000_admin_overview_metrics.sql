create or replace function public.arc_admin_overview()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'media',jsonb_build_object(
      'active',(select count(*) from public.media where is_trashed=false and purged_at is null),
      'trash',(select count(*) from public.media where is_trashed=true and purged_at is null),
      'bytes',(select coalesce(sum(size_bytes),0) from public.media where purged_at is null),
      'photos',(select count(*) from public.media where media_type='photo' and is_trashed=false and purged_at is null),
      'videos',(select count(*) from public.media where media_type='video' and is_trashed=false and purged_at is null),
      'gifs',(select count(*) from public.media where media_type='gif' and is_trashed=false and purged_at is null)
    ),
    'processing_queue',(select coalesce(jsonb_object_agg(status,total),'{}'::jsonb) from (select status,count(*) total from public.processing_jobs group by status) q),
    'telegram_queue',(select coalesce(jsonb_object_agg(status,total),'{}'::jsonb) from (select status,count(*) total from public.telegram_jobs group by status) q),
    'exports',(select coalesce(jsonb_object_agg(status,total),'{}'::jsonb) from (select status,count(*) total from public.export_jobs group by status) q),
    'backups',(select coalesce(jsonb_object_agg(status,total),'{}'::jsonb) from (select status,count(*) total from public.backup_jobs group by status) q),
    'storage_objects',(select coalesce(jsonb_object_agg(storage_bucket,total_bytes),'{}'::jsonb) from (select storage_bucket,sum(size_bytes) total_bytes from public.media_files group by storage_bucket) s)
  );
$$;
revoke all on function public.arc_admin_overview() from public,anon,authenticated;
grant execute on function public.arc_admin_overview() to service_role;
