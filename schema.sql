create table if not exists media (
  id bigserial primary key,
  user_id bigint not null,
  section text not null check (section in ('videos','circles','leaks')),
  kind text not null,
  file_id text not null,
  file_unique_id text not null,
  created_at timestamptz default now(),
  unique (user_id, file_unique_id)
);

create index if not exists media_user_section_idx on media (user_id, section, id desc);

-- бот ходит с service_role ключом, RLS включаем, чтобы anon-ключом никто не читал
alter table media enable row level security;
