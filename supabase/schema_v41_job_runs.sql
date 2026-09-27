-- schema_v41_job_runs.sql  —  2026-09-27  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: every scheduled job says, in its own words, that it finished.
--
-- THE FAILURE THIS EXISTS FOR
--   For months there was no scheduled bank pull at all. The app's own screens were
--   the only thing that ever triggered one, and nobody noticed, because a ledger
--   that stops receiving charges still answers every question — confidently, with
--   numbers that were true last week. An error is loud. A thing that quietly stops
--   is not, and with the screens being retired every trigger that lived in one is
--   about to become exactly this.
--
-- WHY NOT JUST READ cron.job_run_details
--   Two reasons, and the second is the real one.
--
--   1. It is not readable from here. Only `postgres` holds grants on the cron
--      schema; `service_role`, which is what an edge function runs as, holds none.
--      Checked, not assumed: information_schema.role_table_grants lists postgres
--      and nobody else. So the door physically cannot see it.
--
--   2. It answers a weaker question. pg_cron records that it INVOKED the http
--      call — a 200 from net.http_post means the request left, not that the
--      function did its work. cron-bank-sync can return 200 having synced nothing,
--      and cron-reminders can return 200 having reached no device. A row written
--      by the job itself, at the end, after the work, says the work happened.
--
--   The two are different claims and the second is the one worth alarming on.
--
-- WHAT A ROW MEANS
--   One row per run per job. `ok` is the job's own verdict. `detail` is a short
--   json summary in the job's own terms — how many charges came in, how many
--   reminders reached a device — because "it ran" and "it did anything" are also
--   different claims, and a bank sync that returns zero new charges for four days
--   is the original failure wearing a success's clothes.
--
-- WHAT IT IS NOT
--   Not an audit log — muse_audit already records every call through the doors,
--   with the person who made it. This records unattended work, which has no
--   person. Not a metrics table either: it is read by one heartbeat check, and
--   pruned, and nothing plots it.

create table if not exists public.job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text        not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb,
  error       text
);

-- The heartbeat asks exactly one question — "when did this job last finish well?"
-- — so that is the index, rather than one per column somebody might filter on.
create index if not exists job_runs_job_finished_idx
  on public.job_runs (job, finished_at desc nulls last);

-- SAME RULE AS EVERY OTHER TABLE HERE: locked, and reached only by the service
-- role. A job run says when the house was unattended, which is not a thing to
-- serve to a browser holding the publishable key.
alter table public.job_runs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'job_runs' and policyname = 'job_runs_service_only'
  ) then
    -- No policy for `authenticated` at all. The absence IS the rule: with RLS on
    -- and no policy, every signed-in reader gets nothing, and the service role
    -- bypasses RLS entirely. Spelling out a deny policy would suggest there is
    -- some other path to widen later.
    create policy job_runs_service_only on public.job_runs
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PRUNING, because an unattended table that only grows is its own silent problem.
--
-- 30 days is chosen against the question the heartbeat asks, not against a feeling
-- about retention: the longest interval any job runs at is daily, and the longest
-- normal quiet stretch in the bank feed measured over three months is 3 days. 30
-- days holds every window anything looks at, an order of magnitude over.
create or replace function public.prune_job_runs() returns void
language sql security definer set search_path = public as $$
  delete from public.job_runs where started_at < now() - interval '30 days';
$$;

-- AND IT IS SCHEDULED, which is not a detail. A function that prunes and is never
-- called is this table's own failure mode wearing the fix's clothes — exactly the
-- thing it was built to catch, one level up. Sunday 04:17, off the quarter-hour so
-- it never lands in the same minute as the two */15 jobs.
select cron.schedule('homebase-prune-job-runs', '17 4 * * 0', 'select public.prune_job_runs()')
 where not exists (select 1 from cron.job where jobname = 'homebase-prune-job-runs');

comment on table public.job_runs is
  'One row per run of an unattended job, written by the job itself after the work. Read by system.heartbeat.';
comment on column public.job_runs.detail is
  'The job''s own summary of what it did — not just that it ran. A sync that returns nothing for days is the failure this table exists for.';
