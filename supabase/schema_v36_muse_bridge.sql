-- schema_v36_muse_bridge.sql  —  2026-09-26  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- The database side of the Muse bridge: four tables and one counter function.
--
-- WHAT THIS IS FOR
--   An assistant (Muse today, anything else tomorrow) reaches Homebase through
--   two public edge functions — a READ door and a WRITE door, each with its own
--   secret. This file holds everything the WRITE door needs:
--
--     muse_audit    one row per call, so "did that actually happen" has an
--                   answer instead of a guess. It is also the duplicate guard:
--                   the unique index on the idempotency key is what stops the
--                   same weigh-in landing twice when a call is retried.
--     muse_calls    the rate-limit counters. One row per person per bucket.
--     muse_pending  a write the assistant ASKED for and nothing else. The
--                   ledger does not change until he taps it in the app.
--     reminders     his own reminder list. Homebase's cron delivers these as a
--                   real push, because Muse's reminders arrive as chat messages
--                   and cannot be relied on to reach a lock screen.
--
-- THE LOCKS ARE THE POINT — READ THIS BEFORE EDITING
--   A new table in the `public` schema starts with every privilege already
--   granted to the anonymous and signed-in roles, and Homebase's publishable key
--   is served to the whole internet inside the browser bundle on purpose (see
--   supabase/functions/_shared/callerAuth.ts). So a table created here without
--   RLS and without a revoke is readable and writable by any stranger who reads
--   our JavaScript.
--
--   That is not a theoretical worry for these four tables in particular:
--     · an audit log a stranger can delete from LOOKS like accountability and
--       is not,
--     · muse_calls is where the rate limits live, so a stranger who can zero it
--       removes the cap on notifications,
--     · muse_pending is the "waiting for his tap" queue, so a stranger who can
--       insert into it can put a write in front of him that no assistant asked
--       for,
--     · reminders ends up on a phone's lock screen.
--
--   Every `alter table … enable row level security` and every `revoke` below is
--   load-bearing. If you add a table to this file, add its four lines too.
--
-- WHO MAY TOUCH WHAT, IN WORDS
--   muse_calls    nobody but the service role, inside the door. No grant, no
--                 policy. The app never needs to see a counter.
--   muse_audit    the household may READ it (the settings screen shows the log).
--                 Only the door writes it.
--   muse_pending  the household may read it, and may write exactly two columns on
--                 a row that is still waiting: `state` and `decided_at`. Only the
--                 door creates one, and only the door writes the payload, the tool
--                 name or the summary.
--
--                 The update policy has BOTH halves spelled out, and it has to.
--                 `using (state = 'waiting')` is what makes an expired row
--                 un-applyable in the DATABASE rather than only in the app's code —
--                 but with no `with check`, Postgres reuses the USING expression for
--                 the new row too, which means the state would have to STILL be
--                 'waiting' after the update. That is every approve and every reject
--                 refused, for every row, with an error naming row-level security
--                 rather than the missing clause. So the check names the transition:
--                 a waiting row may become applied or rejected, and nothing may go
--                 back to waiting.
--
--                 And the grant is two columns rather than the table, because
--                 `summary` is the sentence the app is told to show him verbatim. If
--                 a session could rewrite `payload` and `tool` while leaving
--                 `summary` alone, what he approves and what gets applied could be
--                 pulled apart.
--   reminders     the household's own list — read, add, edit, delete in the app.
-- ---------------------------------------------------------------------------

-- ── 1. the audit log, which is also the duplicate guard ───────────────────────
create table if not exists public.muse_audit (
  id       uuid primary key default gen_random_uuid(),
  at       timestamptz not null default now(),
  person   text not null check (person in ('gino','xinyan')),
  door     text not null check (door in ('read','write')),
  tool     text not null,
  -- Redacted on the way in: the tool name, the shape of what was asked, and a
  -- fingerprint of the payload. No dollar amounts, no descriptions, no bank
  -- descriptors. The fingerprint is only there to catch one idempotency key
  -- being reused for a DIFFERENT request; it is not a secret.
  args     jsonb not null default '{}'::jsonb,
  -- 'pending' is not in the plan's sketch and it has to be. The row is written
  -- BEFORE the write is attempted, because the unique index below is the only
  -- thing standing between two simultaneous identical calls and two rows in the
  -- ledger. A row that only appeared afterwards would guard nothing.
  outcome  text not null check (outcome in ('pending','ok','denied','rate_limited','error')),
  row_ids  uuid[] not null default '{}',
  ms       int,
  idem_key text,
  result   jsonb,                                  -- what was returned, for a replay
  note     text                                    -- why it was denied, in plain words
);

-- The duplicate guard. A connector's HTTP call can be retried by the assistant
-- on a timeout, by Meta's outbound gate, or by him asking again after a slow
-- reply — and without this, "log 198.4" twice is two rows. Partial, because a
-- refusal we do not want to burn a key on is recorded with a null key.
create unique index if not exists muse_audit_idem
  on public.muse_audit (person, tool, idem_key) where idem_key is not null;

-- The settings screen lists the newest calls first.
create index if not exists muse_audit_at on public.muse_audit (at desc);

-- ── 2. the rate-limit counters ───────────────────────────────────────────────
create table if not exists public.muse_calls (
  person text not null check (person in ('gino','xinyan')),
  -- 'write:2026-09-26T14' | 'remind:2026-09-26' — the bucket name carries its
  -- own window, so there is no expiry job to forget. Old rows are dead weight,
  -- not stale state; see the trim at the bottom of this file.
  bucket text not null,
  n      int not null default 0,
  primary key (person, bucket)
);

-- Increment and read in ONE statement, because two calls arriving together must
-- not both read 9 and both write 10. Returns the new count; the door compares it
-- against the cap. Service role only — see the revoke below.
create or replace function public.muse_bump(p_person text, p_bucket text)
returns int
language sql
as $$
  insert into public.muse_calls (person, bucket, n)
  values (p_person, p_bucket, 1)
  on conflict (person, bucket) do update set n = muse_calls.n + 1
  returning n;
$$;

-- ── 3. the writes waiting for his tap ────────────────────────────────────────
create table if not exists public.muse_pending (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  person     text not null check (person in ('gino','xinyan')),
  tool       text not null,
  payload    jsonb not null,
  -- The sentence the app shows him, written by the door and already scrubbed.
  -- The app should show THIS and not re-word it, so what he approves is what
  -- was asked for.
  summary    text not null,
  state      text not null default 'waiting'
             check (state in ('waiting','applied','rejected','expired')),
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);
create index if not exists muse_pending_open
  on public.muse_pending (state, expires_at);

-- ── 4. his reminder list ─────────────────────────────────────────────────────
create table if not exists public.reminders (
  id         uuid primary key default gen_random_uuid(),
  person     text not null check (person in ('gino','xinyan')),
  due_at     timestamptz not null,
  repeats    text not null default 'once' check (repeats in ('once','daily','weekly')),
  -- Capped and scrubbed by the door before it lands, and these two checks are
  -- the belt underneath that: a reminder body goes to a lock screen, and today
  -- the older `notify` function passes text through with no length limit and no
  -- cleaning at all. One line, no control characters, nothing longer than a
  -- notification can show.
  message    text not null check (char_length(message) between 1 and 120)
                              check (position(E'\n' in message) = 0)
                              check (position(E'\r' in message) = 0),
  source     text not null default 'muse',
  sent_at    timestamptz,                          -- 'once' rows: delivered, done
  last_sent_at timestamptz,                        -- repeating rows: the last time it fired
  created_at timestamptz not null default now()
);
-- What cron-reminders asks for every 15 minutes: not yet sent, due now.
create index if not exists reminders_due on public.reminders (sent_at, due_at);

-- ── 5. who a row belongs to ──────────────────────────────────────────────────
-- `created_by` cannot carry this. It is `uuid default auth.uid()`, the household
-- shares ONE login, and the door runs as the service role where auth.uid() is
-- NULL — so there is no per-person id to point at and writing 'gino' into a uuid
-- column is a type error. A plain text column instead.
--
-- Nothing writes this yet: the write door never touches `transactions`. It is
-- here so that when the app applies a queued `finance.add_transaction`, stamping
-- who the assistant was acting for is one line of app code and not another
-- migration.
alter table public.transactions
  add column if not exists person text check (person is null or person in ('gino','xinyan'));
comment on column public.transactions.person is
  'Which person an assistant was acting for when this row was queued. NULL for every row a human entered directly. Set by the app when it applies a muse_pending row — not by the door.';

-- ── 6. the locks ─────────────────────────────────────────────────────────────
alter table public.muse_audit   enable row level security;
alter table public.muse_calls   enable row level security;
alter table public.muse_pending enable row level security;
alter table public.reminders    enable row level security;

revoke all on public.muse_audit   from anon, authenticated;
revoke all on public.muse_calls   from anon, authenticated;
revoke all on public.muse_pending from anon, authenticated;
revoke all on public.reminders    from anon, authenticated;

-- A function in `public` is executable by everyone unless you say otherwise,
-- and this one writes the rate-limit counters.
revoke all on function public.muse_bump(text, text) from public, anon, authenticated;
grant execute on function public.muse_bump(text, text) to service_role;

-- muse_calls deliberately gets NO grant and NO policy.

-- the settings screen shows the log, read-only
grant select on public.muse_audit to authenticated;
drop policy if exists "muse_audit read" on public.muse_audit;
create policy "muse_audit read" on public.muse_audit
  for select to authenticated using (true);

-- the app shows queued writes and records his decision — and writes NOTHING else:
-- the decision is two columns, so the payload, the tool and the summary he is shown
-- are writable only by the service role inside the door.
grant select on public.muse_pending to authenticated;
grant update (state, decided_at) on public.muse_pending to authenticated;
drop policy if exists "muse_pending read" on public.muse_pending;
create policy "muse_pending read" on public.muse_pending
  for select to authenticated using (true);
drop policy if exists "muse_pending decide" on public.muse_pending;
-- BOTH halves, and the second one is the transition rather than a copy of the first.
-- With `using` alone, Postgres applies it to the new row as well, so `state` would
-- have to still be 'waiting' after the update — i.e. the app could never record a
-- decision at all. `with check (true)` would be the opposite mistake: it would let a
-- session re-arm an expired or rejected row back to 'waiting'.
create policy "muse_pending decide" on public.muse_pending
  for update to authenticated
  using (state = 'waiting')
  with check (state in ('applied','rejected'));

-- reminders are his own list, editable in the app
grant select, insert, update, delete on public.reminders to authenticated;
drop policy if exists "reminders household" on public.reminders;
create policy "reminders household" on public.reminders
  for all to authenticated using (true) with check (true);

-- ── 7. Realtime ──────────────────────────────────────────────────────────────
-- muse_pending and reminders both show up in the app, and a queued write is
-- worth nothing if the phone only notices it on the next cold start. muse_audit
-- and muse_calls are deliberately left out: nobody watches a log live.
do $$ begin
  alter publication supabase_realtime add table public.muse_pending;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.reminders;
exception when duplicate_object then null; end $$;

-- ── 8. the scheduled job — NOT CREATED BY RUNNING THIS FILE ──────────────────
--
-- ⚠ THIS IS THE ONE THING IN THIS FILE THAT PASTING THE FILE DOES NOT DO, and
-- nothing else in the bridge works without it. The statement is commented out
-- because it needs two values that must not be committed: the project ref and the
-- real CRON_TOKEN. So it lives, filled in, as its own step in
-- docs/research/muse-bridge/SETUP.md ("Schedule the 15-minute job"), with a check
-- you can feel on a locked phone.
--
-- WHAT IS SILENTLY BROKEN UNTIL THAT STEP IS DONE — and it is silent, which is the
-- problem:
--   · `schedule.remind` writes its row, answers "his phone gets this within about
--     15 minutes of 3:00 PM", and no push is ever sent. The tool exists because an
--     assistant's own reminders cannot reach a lock screen, so a reminder that does
--     not arrive is invisible until something that mattered has been missed.
--   · muse_pending rows are never expired, so "it clears itself after 24 hours" is
--     a sentence rather than a rule. The expiry lives in the same job.
--
-- Check it landed with:  select jobname, schedule from cron.job;
--
-- cron-reminders does two things every 15 minutes: delivers reminders that are
-- due, and marks queued writes that nobody tapped as expired. 15 minutes is the
-- delivery grain, so the door tells the caller a reminder "arrives within about
-- 15 minutes of that time" instead of promising the exact minute.
--
-- do $g$ begin
--   if exists (select 1 from cron.job where jobname='homebase-reminders')
--     then perform cron.unschedule('homebase-reminders'); end if;
-- end $g$;
-- select cron.schedule('homebase-reminders', '*/15 * * * *',
--   $j$ select net.http_post(
--         url := 'https://<ref>.supabase.co/functions/v1/cron-reminders?token=<CRON_TOKEN>',
--         headers := '{"Content-Type":"application/json"}'::jsonb,
--         body := '{}'::jsonb) $j$);

-- ── 9. housekeeping, by hand ─────────────────────────────────────────────────
-- Neither of these is scheduled, because neither is urgent and an unattended
-- delete is exactly the kind of thing this project keeps out of the cron jobs.
-- Run them when the tables get big enough to notice:
--
--   delete from public.muse_audit where at < now() - interval '90 days';
--   delete from public.muse_calls
--    where substring(bucket from '[0-9]{4}-[0-9]{2}-[0-9]{2}')
--          < to_char(now() - interval '7 days', 'YYYY-MM-DD');
