-- Requeue only retryable thumbnail failures.
-- Review the failed rows first; this script deliberately excludes known oversized
-- Telegram downloads because they require a different download transport.
--
-- Preview:
-- select id, kind, thumbnail_error
-- from public.media
-- where thumbnail_status = 'failed'
-- order by id;

update public.media
set thumbnail_status = 'pending',
    thumbnail_error = null,
    thumbnail_updated_at = now()
where kind in ('video', 'video_note', 'animation')
  and thumbnail_status = 'failed'
  and coalesce(thumbnail_error, '') not ilike '%exceeds its download limit%'
  and coalesce(thumbnail_error, '') not ilike '%file is too big%'
  and coalesce(thumbnail_error, '') not ilike '%20 mib%'
  and coalesce(thumbnail_error, '') not ilike '%20 mb%';

-- Verify:
-- select thumbnail_status, count(*)
-- from public.media
-- where kind in ('video', 'video_note', 'animation')
-- group by thumbnail_status
-- order by thumbnail_status;
