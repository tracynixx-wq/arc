create or replace function public.claim_telegram_jobs(p_worker_id text, p_batch_size integer default 1)
returns setof public.telegram_jobs language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select id from public.telegram_jobs
    where status='queued'
      and attempts<max_attempts
      and (
        (job_type='ingest' and available_at<=now())
        or (job_type='send_archive' and payload->>'delivery_mode' in ('native','document') and available_at<=now())
      )
    order by sequence_no,created_at for update skip locked
    limit greatest(1,least(coalesce(p_batch_size,1),10))
  )
  update public.telegram_jobs j set status='running',locked_at=now(),locked_by=p_worker_id,
    heartbeat_at=now(),started_at=coalesce(started_at,now()),attempts=attempts+1
  from candidates where j.id=candidates.id returning j.*;
$$;
revoke all on function public.claim_telegram_jobs(text,integer) from public,anon,authenticated;
grant execute on function public.claim_telegram_jobs(text,integer) to service_role;
