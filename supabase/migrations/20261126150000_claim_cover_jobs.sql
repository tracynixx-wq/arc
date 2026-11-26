create or replace function public.claim_cover_jobs(p_worker_id text, p_batch_size integer default 1)
returns setof public.processing_jobs language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select id from public.processing_jobs
    where status='queued' and job_type in('cover','cover_regenerate')
      and attempts<max_attempts and available_at<=now()
    order by priority desc,available_at,created_at
    for update skip locked limit greatest(1,least(coalesce(p_batch_size,1),4))
  )
  update public.processing_jobs j set status='running',locked_at=now(),locked_by=p_worker_id,
    heartbeat_at=now(),started_at=coalesce(started_at,now()),attempts=attempts+1
  from candidates where j.id=candidates.id returning j.*;
$$;
revoke all on function public.claim_cover_jobs(text,integer) from public,anon,authenticated;
grant execute on function public.claim_cover_jobs(text,integer) to service_role;
