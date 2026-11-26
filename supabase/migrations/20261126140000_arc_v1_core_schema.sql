create extension if not exists pgcrypto;

create table public.owner_settings (
 id uuid primary key default gen_random_uuid(), telegram_user_id bigint not null unique,
 telegram_chat_id bigint, display_name text, timezone text not null default 'Europe/Riga',
 settings jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.media (
 id uuid primary key default gen_random_uuid(), sha256 char(64) not null unique,
 filename text not null, display_name text, description text, extension text,
 mime_type text not null, size_bytes bigint not null check(size_bytes>=0),
 media_type text not null check(media_type in('photo','video','gif','other')),
 source_message_id bigint, source_chat_id bigint, album_group_id text, album_position integer,
 original_created_at timestamptz, uploaded_at timestamptz not null default now(),
 duration_ms bigint, width integer, height integer, fps numeric(8,3),
 metadata jsonb not null default '{}'::jsonb,
 processing_status text not null default 'queued' check(processing_status in('queued','processing','ready','partial','failed')),
 integrity_status text not null default 'pending' check(integrity_status in('pending','verified','failed')),
 is_trashed boolean not null default false, trashed_at timestamptz, purged_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((is_trashed and trashed_at is not null) or not is_trashed)
);
create index media_uploaded_at_idx on public.media(uploaded_at desc,id);
create index media_type_uploaded_at_idx on public.media(media_type,uploaded_at desc);
create index media_trash_idx on public.media(is_trashed,trashed_at desc);
create index media_filename_search_idx on public.media using gin(to_tsvector('simple',coalesce(filename,'')||' '||coalesce(display_name,'')||' '||coalesce(description,'')));

create table public.media_files (
 id uuid primary key default gen_random_uuid(), media_id uuid not null references public.media(id) on delete cascade,
 file_role text not null check(file_role in('original','cover','preview','backup')),
 storage_bucket text not null, storage_key text not null, version_number integer not null default 1 check(version_number>0),
 sha256 char(64) not null, size_bytes bigint not null check(size_bytes>=0), mime_type text not null,
 is_current boolean not null default true, created_at timestamptz not null default now(),
 unique(storage_bucket,storage_key), unique(media_id,file_role,version_number)
);
create unique index media_files_one_current_role_idx on public.media_files(media_id,file_role) where is_current;
create table public.media_versions (
 id uuid primary key default gen_random_uuid(), media_id uuid not null references public.media(id) on delete cascade,
 prior_file_id uuid not null references public.media_files(id) on delete restrict,
 replaced_by_file_id uuid references public.media_files(id) on delete set null,
 reason text not null default 'same_name_replacement', created_at timestamptz not null default now()
);
create table public.collections (
 id uuid primary key default gen_random_uuid(), name text not null unique, description text,
 is_system boolean not null default false, system_key text unique, sort_order integer not null default 0,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.media_collections (
 media_id uuid not null references public.media(id) on delete cascade,
 collection_id uuid not null references public.collections(id) on delete cascade,
 added_at timestamptz not null default now(), primary key(media_id,collection_id)
);
create index media_collections_collection_idx on public.media_collections(collection_id,added_at desc);
create table public.tags (
 id uuid primary key default gen_random_uuid(), name text not null unique, color text,
 created_at timestamptz not null default now()
);
create table public.media_tags (
 media_id uuid not null references public.media(id) on delete cascade,
 tag_id uuid not null references public.tags(id) on delete cascade,
 added_at timestamptz not null default now(), primary key(media_id,tag_id)
);
create index media_tags_tag_idx on public.media_tags(tag_id,media_id);
create table public.favorites (
 media_id uuid primary key references public.media(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table public.processing_jobs (
 id uuid primary key default gen_random_uuid(), media_id uuid references public.media(id) on delete set null,
 job_type text not null check(job_type in('ingest','cover','cover_regenerate','backup','integrity','zip_export','telegram_send','restore')),
 status text not null default 'queued' check(status in('queued','running','succeeded','failed','cancelled')),
 priority smallint not null default 50, attempts integer not null default 0 check(attempts>=0),
 max_attempts integer not null default 5 check(max_attempts>0), idempotency_key text not null unique,
 payload jsonb not null default '{}'::jsonb, result jsonb, error jsonb,
 available_at timestamptz not null default now(), locked_at timestamptz, locked_by text,
 heartbeat_at timestamptz, started_at timestamptz, finished_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index processing_jobs_claim_idx on public.processing_jobs(status,priority desc,available_at,created_at);
create table public.telegram_jobs (
 id uuid primary key default gen_random_uuid(),
 job_type text not null check(job_type in('ingest','send_archive','delete_source')),
 status text not null default 'queued' check(status in('queued','running','succeeded','failed','cancelled')),
 telegram_update_id bigint, telegram_message_id bigint, telegram_chat_id bigint,
 media_id uuid references public.media(id) on delete set null, sequence_no bigserial,
 attempts integer not null default 0, max_attempts integer not null default 5,
 payload jsonb not null default '{}'::jsonb, error jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index telegram_jobs_update_unique_idx on public.telegram_jobs(telegram_update_id) where telegram_update_id is not null;
create index telegram_jobs_queue_idx on public.telegram_jobs(status,sequence_no);
create table public.export_jobs (
 id uuid primary key default gen_random_uuid(),
 status text not null default 'queued' check(status in('queued','running','succeeded','failed','cancelled','expired')),
 format text not null default 'zip' check(format='zip'), options jsonb not null default '{}'::jsonb,
 storage_bucket text, storage_key text, part_count integer, expires_at timestamptz, error jsonb,
 created_at timestamptz not null default now(), finished_at timestamptz
);
create table public.activity_logs (
 id bigserial primary key, actor_type text not null default 'owner', action text not null,
 entity_type text, entity_id uuid, details jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
create index activity_logs_created_idx on public.activity_logs(created_at desc);
create table public.backup_jobs (
 id uuid primary key default gen_random_uuid(),
 status text not null default 'queued' check(status in('queued','running','succeeded','failed','cancelled')),
 backup_scope text not null default 'full' check(backup_scope in('full','database','originals','covers','settings')),
 destination text, manifest jsonb, checksum char(64), attempts integer not null default 0,
 error jsonb, started_at timestamptz, finished_at timestamptz, created_at timestamptz not null default now()
);
create table public.sessions (
 id uuid primary key default gen_random_uuid(), token_hash char(64) not null unique,
 telegram_user_id bigint not null, user_agent text, ip_hash char(64),
 last_seen_at timestamptz not null default now(), revoked_at timestamptz, created_at timestamptz not null default now()
);
create index sessions_owner_idx on public.sessions(telegram_user_id,revoked_at);
create table public.telegram_deliveries (
 id uuid primary key default gen_random_uuid(), media_id uuid not null references public.media(id) on delete cascade,
 telegram_chat_id bigint not null, telegram_message_id bigint,
 delivery_mode text not null check(delivery_mode in('native','document')),
 status text not null default 'queued' check(status in('queued','sent','failed','skipped')),
 error jsonb, sent_at timestamptz, created_at timestamptz not null default now(),
 unique(media_id,telegram_chat_id)
);
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at=now(); return new; end; $$;
create trigger owner_settings_updated_at before update on public.owner_settings for each row execute function public.set_updated_at();
create trigger media_updated_at before update on public.media for each row execute function public.set_updated_at();
create trigger collections_updated_at before update on public.collections for each row execute function public.set_updated_at();
create trigger processing_jobs_updated_at before update on public.processing_jobs for each row execute function public.set_updated_at();
create trigger telegram_jobs_updated_at before update on public.telegram_jobs for each row execute function public.set_updated_at();
insert into public.collections(name,description,is_system,system_key,sort_order) values
('Все медиа','Полная библиотека',true,'all',0),('Недавно добавленные','Последние поступления',true,'recent',1),
('Избранное','Отмеченные файлы',true,'favorites',2),('Видео','Видеофайлы',true,'videos',3),
('GIF','GIF-анимации',true,'gifs',4),('Фото','Изображения',true,'photos',5),
('Корзина','Удалённые файлы',true,'trash',6) on conflict(system_key) do nothing;
alter table public.owner_settings enable row level security;
alter table public.media enable row level security;
alter table public.media_files enable row level security;
alter table public.media_versions enable row level security;
alter table public.collections enable row level security;
alter table public.media_collections enable row level security;
alter table public.tags enable row level security;
alter table public.media_tags enable row level security;
alter table public.favorites enable row level security;
alter table public.processing_jobs enable row level security;
alter table public.telegram_jobs enable row level security;
alter table public.export_jobs enable row level security;
alter table public.activity_logs enable row level security;
alter table public.backup_jobs enable row level security;
alter table public.sessions enable row level security;
alter table public.telegram_deliveries enable row level security;
insert into storage.buckets(id,name,public,file_size_limit) values
('arc-originals','arc-originals',false,null),('arc-covers','arc-covers',false,null),
('arc-backups','arc-backups',false,null),('arc-temporary','arc-temporary',false,null)
on conflict(id) do update set public=false,file_size_limit=null;
