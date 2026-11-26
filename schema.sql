create table if not exists media (
  id bigserial primary key,
  user_id bigint not null,
  section text not null check (section in ('videos','circles','leaks')),
  kind text not null,
  file_id text not null,
  file_unique_id text not null,
  thumb_file_id text,

  thumbnail_status text not null default 'pending'
    check (thumbnail_status in ('pending','ready','failed','not_required')),
  thumbnail_error text,
  thumbnail_updated_at timestamptz,
  storage_path text,
  storage_status text not null default 'pending'
    check (storage_status in ('pending','ready','failed')),
  storage_error text,
  storage_updated_at timestamptz,
  file_name text,
  is_favorite boolean not null default false,
  created_at timestamptz default now(),
  unique (user_id, file_unique_id)
);

create index if not exists media_user_section_idx on media (user_id, section, id desc);
create index if not exists media_user_favorite_idx on media (user_id, is_favorite, id desc);
create index if not exists media_user_kind_idx on media (user_id, kind, id desc);

create table if not exists user_profiles (
  user_id bigint primary key,
  display_name text,
  accent text not null default '#a98dff',
  theme text not null default 'dark' check (theme in ('dark','light')),
  density text not null default 'comfortable' check (density in ('compact','comfortable')),
  updated_at timestamptz not null default now()
);

alter table media enable row level security;
alter table user_profiles enable row level security;

-- Keep this schema usable for both fresh installs and existing databases.
alter table media add column if not exists thumbnail_status text not null default 'pending';
alter table media add column if not exists thumbnail_error text;
alter table media add column if not exists thumbnail_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_thumbnail_status_check'
      and conrelid = 'media'::regclass
  ) then
    alter table media
      add constraint media_thumbnail_status_check
      check (thumbnail_status in ('pending','ready','failed','not_required'));
  end if;
end $$;

update media
set thumbnail_status = case
  when kind in ('video','video_note','animation') and thumb_file_id like 'storage:%' then 'ready'
  when kind in ('video','video_note','animation') then 'pending'
  else 'not_required'
end
where thumbnail_status is null;

create index if not exists media_thumbnail_backfill_idx
  on media (thumbnail_status, id)
  where kind in ('video','video_note','animation');


-- Private permanent storage for original media files.
alter table media add column if not exists storage_path text;
alter table media add column if not exists storage_status text not null default 'pending';
alter table media add column if not exists storage_error text;
alter table media add column if not exists storage_updated_at timestamptz;
create index if not exists media_storage_status_idx on media (storage_status, id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('arc-originals', 'arc-originals', false, 52428800, null)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
