create table if not exists media (
  id bigserial primary key,
  user_id bigint not null,
  section text not null check (section in ('videos','circles','leaks')),
  kind text not null,
  file_id text not null,
  file_unique_id text not null,
  thumb_file_id text,
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
