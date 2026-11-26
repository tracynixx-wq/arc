alter table public.media
  add column if not exists thumbnail_status text,
  add column if not exists thumbnail_error text,
  add column if not exists thumbnail_updated_at timestamptz;

update public.media
set thumbnail_status = case
  when kind in ('video', 'video_note', 'animation')
       and thumb_file_id like 'storage:%' then 'ready'
  when kind in ('video', 'video_note', 'animation') then 'pending'
  else 'not_required'
end,
thumbnail_error = null,
thumbnail_updated_at = now()
where thumbnail_status is null;

alter table public.media
  alter column thumbnail_status set default 'pending';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_thumbnail_status_check'
      and conrelid = 'public.media'::regclass
  ) then
    alter table public.media
      add constraint media_thumbnail_status_check
      check (thumbnail_status in ('pending', 'ready', 'failed', 'not_required'));
  end if;
end $$;

create index if not exists media_thumbnail_backfill_idx
  on public.media (thumbnail_status, id)
  where kind in ('video', 'video_note', 'animation');
