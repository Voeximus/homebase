-- schema_v39_bank_refresh.sql  —  2026-09-27  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- The bank feed keeps pulling after the screens stop being opened.
--
-- THE HOLE THIS CLOSES, and it is not a small one
--
--   Search the app for who pulls the bank and there are exactly two callers, both
--   of them a person looking at something:
--
--     src/App.tsx:151                 syncNow()       — on launch
--     src/views/redesign/FinanceTabs  syncNow(true)   — pull-to-refresh
--
--   That is the whole of it. `grep -rn "action: \"sync\"" src/` finds one line, in
--   src/lib/plaidClient.ts, and both callers are screens. There is no scheduled
--   bank pull anywhere in this project: `select jobname from cron.job` has
--   homebase-daily-notify and homebase-reminders on it and nothing else.
--
--   While the app WAS the product that was a reasonable design — you saw fresh
--   numbers because looking at them was what fetched them. Muse being the
--   interface inverts it. Nobody opens the app, so nothing calls syncNow, so the
--   ledger stops moving — and the read door goes on answering, with the app's own
--   arithmetic, off a database that last changed days ago. That is the worst
--   failure shape this project has: not a wrong number, a RIGHT number about last
--   Tuesday, spoken today as though it were about today, with no screen beside it
--   to notice.
--
--   His words for what he wanted: "routinely refresh the status of the database so
--   when I ask for numbers it always as up to date as possible."
--
-- THE TWO HALVES
--
--   1. A scheduled pull. Every 15 minutes, pg_cron calls the new
--      `cron-bank-sync` edge function, which calls `plaid`'s existing `sync`
--      action. The pull itself is not reimplemented — `sync` already reconciles,
--      writes posted rows and updates bank-truth balances, and a second writer
--      against the ledger is the drift this whole bridge exists to avoid.
--
--      WHY A FUNCTION IN BETWEEN, since `plaid` already does the work. `plaid` is
--      verify_jwt = true and its guard (functions/_shared/callerAuth.ts) accepts a
--      signed-in user or the SERVICE ROLE key. A cron job has no user — so
--      pointing net.http_post straight at `plaid` means writing the service-role
--      key into the command string of a row in `cron.job`. That is the key RLS
--      does not constrain, and it reaches `disconnect`, which hard-deletes
--      accounts and their whole transaction history. The existing jobs put
--      CRON_TOKEN in that string and CRON_TOKEN opens two narrow cron functions;
--      the service-role key opens everything. So the weak secret goes in the
--      database and the strong one stays in the function's own environment, where
--      the platform already injects it — no new secret to create anywhere.
--
--   2. `refresh_requested_at`, below. The doors may not call another edge function
--      — that is item 7 of what an assistant may never do, enforced by neither
--      door importing a client or a URL — so `finance.refresh_bank` cannot pull the
--      bank itself. It writes the ASK, and cron-bank-sync honours it on its next
--      run by passing force = true, which is what nudges the bank to go and look.
--      This is why the tool's own sentence says "within about 15 minutes" and
--      refuses to report it as done.
--
-- WHY THE FLAG IS NEVER CLEARED
--   `refresh_requested_at` is compared against `last_sync_at`, not consumed. A
--   request is outstanding while it is NEWER than the last good sync, and it
--   retires itself the moment a sync lands past it. So there is no clearing write
--   to race, no row a crash can leave pending forever, and the read door's
--   freshness stamp can answer "still waiting" from the same two columns without
--   writing anything. The cooldown in
--   supabase/functions/_shared/muse/freshness.ts is measured from this column for
--   the same reason: a pull that never lands never moves last_sync_at, and a
--   window measured from last_sync_at would let a broken connection be asked
--   forever.

-- ── 1. the asked-for-a-pull column ───────────────────────────────────────────
alter table public.bank_connections
  add column if not exists refresh_requested_at timestamptz;

comment on column public.bank_connections.refresh_requested_at is
  'When a refresh was last ASKED for (by the write door''s system.refresh, or by hand). '
  'Outstanding while it is newer than last_sync_at; never cleared — a landed sync retires it.';

-- Partial index: the scheduled job asks "is anything outstanding" every 15
-- minutes, forever. Two or three rows makes that free either way, but the query
-- below is the one statement in this project that runs 96 times a day unattended.
create index if not exists bank_connections_refresh_pending_idx
  on public.bank_connections (refresh_requested_at)
  where refresh_requested_at is not null;

-- ── 2. the scheduled pull ────────────────────────────────────────────────────
-- NOT RUN BY THIS FILE. Same convention as schema_v22 and schema_v36: the
-- cron.schedule call is left commented out because it carries a project ref and a
-- token, and it is pasted into the SQL editor by hand once. Nothing in the repo
-- can schedule it and nothing in the repo should be able to.
--
-- Check what is scheduled with:  select jobname, schedule from cron.job;
--
-- ONE JOB, at the same 15-minute grain as homebase-reminders, so the whole system
-- has one unattended tick and one sentence that explains it. cron-bank-sync
-- decides for itself whether to force: the routine pull is `/transactions/sync`,
-- a cursor delta that is cheap to call often, and force adds
-- `/transactions/refresh`, which nudges the BANK and is rate-limited by Plaid.
-- Force is used only when `refresh_requested_at` below says somebody asked.
--
-- CRON_TOKEN already exists on this project — it is the same secret cron-notify
-- and cron-reminders use. Replace PASTE_CRON_TOKEN_HERE with the real value from
-- the password manager; the dashboard will not show it to you.
--
-- do $g$ begin
--   if exists (select 1 from cron.job where jobname='homebase-bank-sync')
--     then perform cron.unschedule('homebase-bank-sync'); end if;
-- end $g$;
-- select cron.schedule('homebase-bank-sync', '*/15 * * * *',
--   $j$ select net.http_post(
--         url := 'https://ganzefaciiyibselizqi.supabase.co/functions/v1/cron-bank-sync?token=PASTE_CRON_TOKEN_HERE',
--         headers := '{"Content-Type":"application/json"}'::jsonb,
--         body := '{}'::jsonb) $j$);

-- ── 3. what is still NOT true until this file and that job are both done ─────
-- Three things have to happen, and none of them happens by merging code:
--
--   · this file has to be run, or `refresh_requested_at` does not exist and
--     finance.refresh_bank refuses with "the database is missing the column";
--   · `cron-bank-sync` has to be DEPLOYED
--     (npx supabase functions deploy cron-bank-sync --project-ref ganzefaciiyibselizqi);
--   · the cron.schedule above has to be pasted in.
--
-- Until all three are done the bank feed still only moves when he opens the app,
-- and "routinely refresh" is not delivered by any file in this repo. The freshness
-- stamp on every read reply is still honest in that state — it will say the sync
-- is hours old, because it will be. That is the point of stamping it: the system
-- says what is true about itself before anybody has to notice.
