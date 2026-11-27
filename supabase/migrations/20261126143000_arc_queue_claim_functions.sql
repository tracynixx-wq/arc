alter table public.telegram_jobs
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists idempotency_key text;
create unique index if not exists telegram_jobs_idempotency_idx
  on public.telegram_jobs(idempotency_key) where idempotency_key is not null;

create or replace function public.claim_processing_jobs(p_worker_id text, p_batch_size integer default 1)
returns setof public.processing_jobs language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select id from public.processing_jobs
    where status='queued' and available_at<=now() and attempts<max_attempts
    order by priority desc,available_at,created_at
    for update skip locked limit greatest(1,least(coalesce(p_batch_size,1),10))
  )
  update public.processing_jobs j set status='running',locked_at=now(),locked_by=p_worker_id,
    heartbeat_at=now(),started_at=coalesce(started_at,now()),attempts=attempts+1
  from candidates where j.id=candidates.id returning j.*;
$$;

create or replace function public.claim_telegram_jobs(p_worker_id text, p_batch_size integer default 1)
returns setof public.telegram_jobs language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select id from public.telegram_jobs
    where status='queued' and attempts<max_attempts
    order by sequence_no,created_at
    for update skip locked limit greatest(1,least(coalesce(p_batch_size,1),10))
  )
  update public.telegram_jobs j set status='running',locked_at=now(),locked_by=p_worker_id,
    heartbeat_at=now(),started_at=coalesce(started_at,now()),attempts=attempts+1
  from candidates where j.id=candidates.id returning j.*;
$$;

create or replace function public.recover_stale_jobs(p_stale_after_seconds integer default 600)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare recovered integer := 0; changed integer := 0;
begin
  update public.processing_jobs set
    status=case when attempts<max_attempts then 'queued' else 'failed' end,
    locked_at=null,locked_by=null,heartbeat_at=null,
    available_at=case when attempts<max_attempts then now()+interval '30 seconds' else available_at end,
    finished_at=case when attempts>=max_attempts then now() else null end,
    error=jsonb_build_object('code','stale_lease_recovered','message','Worker heartbeat expired')
  where status='running' and coalesce(heartbeat_at,locked_at,started_at)<now()-make_interval(secs=>greatest(60,p_stale_after_seconds));
  get diagnostics changed=row_count; recovered:=recovered+changed;

  update public.telegram_jobs set
    status=case when attempts<max_attempts then 'queued' else 'failed' end,
    locked_at=null,locked_by=null,heartbeat_at=null,
    finished_at=case when attempts>=max_attempts then now() else null end,
    error=jsonb_build_object('code','stale_lease_recovered','message','Worker heartbeat expired')
  where status='running' and coalesce(heartbeat_at,locked_at,started_at)<now()-make_interval(secs=>greatest(60,p_stale_after_seconds));
  get diagnostics changed=row_count; recovered:=recovered+changed;
  return recovered;
end;
$$;
revoke all on function public.claim_processing_jobs(text,integer) from public,anon,authenticated;
revoke all on function public.claim_telegram_jobs(text,integer) from public,anon,authenticated;
revoke all on function public.recover_stale_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_processing_jobs(text,integer) to service_role;
grant execute on function public.claim_telegram_jobs(text,integer) to service_role;
grant execute on function public.recover_stale_jobs(integer) to service_role;
