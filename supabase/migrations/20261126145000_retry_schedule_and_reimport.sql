alter table public.telegram_jobs
  add column if not exists available_at timestamptz not null default now();
create index if not exists telegram_jobs_available_idx on public.telegram_jobs(status,available_at,sequence_no);
alter table public.media drop constraint if exists media_sha256_key;
create unique index if not exists media_sha256_active_idx on public.media(sha256) where purged_at is null;
create or replace function public.claim_telegram_jobs(p_worker_id text, p_batch_size integer default 1)
returns setof public.telegram_jobs language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select id from public.telegram_jobs
    where status='queued' and attempts<max_attempts and available_at<=now()
    order by sequence_no,created_at for update skip locked
    limit greatest(1,least(coalesce(p_batch_size,1),10))
  )
  update public.telegram_jobs j set status='running',locked_at=now(),locked_by=p_worker_id,
    heartbeat_at=now(),started_at=coalesce(started_at,now()),attempts=attempts+1
  from candidates where j.id=candidates.id returning j.*;
$$;
revoke all on function public.claim_telegram_jobs(text,integer) from public,anon,authenticated;
grant execute on function public.claim_telegram_jobs(text,integer) to service_role;
