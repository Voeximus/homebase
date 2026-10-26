-- schema_v47_dropped_lines.sql  —  2026-10-26  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE TABLE: the bank lines the sync chose NOT to write into the ledger.
--
-- THE GAP
--   The bank sync (supabase/functions/plaid/index.ts) drops some posted bank lines on
--   purpose — money moving between the household's own accounts, a card payment arriving
--   at the card, a remittance, anything the categorizer calls `skip`. Each of those was
--   a `continue`: the line was written nowhere, with no trace in the app or in either
--   door. Most of them are right to drop. But a rule that is wrong drops REAL money
--   without a sound — that is how a Zelle to someone outside the household was missing
--   from the ledger until the statements were reconciled by hand on 2026-10-10 — and the
--   bank feed never re-sends a line that has not changed at the bank, so nothing ever
--   brought it back.
--
-- WHAT A ROW MEANS
--   One posted bank line the sync dropped, keyed by the bank's own id, so a re-sync of
--   the same line writes the same row again (an upsert on provider_txn_id) rather than a
--   second one. It holds what the line was — the account, the date, the amount, which
--   way the money went — a SCRUBBED description, and the reason the sync gave for
--   dropping it, in plain words.
--
--   `description` is the sync's cleaned name for the line, never the bank's raw
--   descriptor, with the bank's ID tail cut off and the same cleaning every door string
--   goes through (supabase/functions/_shared/droppedLines.ts). A confirmation code
--   ("Conf# …") is kept on purpose: it is the one thing that says two lines are the two
--   halves of the same transfer, and the ledger's own descriptions already carry it.
--
--   `amount` is a magnitude, the way the ledger stores every amount; the direction is in
--   `direction` ('out' = money left the account, 'in' = it arrived).
--
-- WHO WRITES IT
--   The bank sync, with the service role, straight after the ledger write. A failed
--   write here never fails a sync — the ledger is already written — and before this
--   file is run the write simply fails and is logged.
--
-- WHO READS IT
--   finance.worth_a_look on the read door, which lists any line from the last 14 days
--   that is NOT one half of a transfer between the household's own accounts — a
--   friends-and-family Zelle, a remittance, anything a rule skipped that may have been
--   real money. Before this file is run the door reads the table as empty and says
--   nothing about it. The app's screens do not read it (their look does not change).
--
-- THE LOCKS ARE THE POINT — same rule as schema_v36, v40, v43, v45 and v46
--   A new table in `public` starts with every privilege already granted to the anonymous
--   and signed-in roles, and Homebase's publishable key is served to the whole internet
--   inside the browser bundle on purpose. Every `enable row level security` and every
--   `revoke` below is load-bearing.
-- ---------------------------------------------------------------------------

-- ── 1. the table ─────────────────────────────────────────────────────────────
create table if not exists public.dropped_lines (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null default 'plaid',
  -- The bank's own id for the line. UNIQUE, and a full unique constraint rather than a
  -- partial index, so the sync's upsert can name it as its conflict target.
  provider_txn_id  text not null unique,
  -- The ledger account the line belongs to. Removed with the account: a line of an
  -- account the household took out of the app is not worth a look.
  account_id       uuid references public.accounts(id) on delete cascade,
  date             date not null,
  amount           numeric(12,2) not null check (amount >= 0),
  direction        text not null check (direction in ('in', 'out')),
  description      text,
  reason           text not null,
  created_at       timestamptz not null default now()
);

create index if not exists dropped_lines_date_idx on public.dropped_lines (date);

comment on table public.dropped_lines is
  'Posted bank lines the sync chose not to write into the ledger (transfers between the household''s own accounts, remittances, anything the categorizer skips), one row per bank id. Written by the plaid function; read by finance.worth_a_look, which lists the ones from the last 14 days that are not one half of an own-account transfer.';
comment on column public.dropped_lines.description is
  'The sync''s cleaned name for the line with the bank''s ID tail cut off and door-style cleaning applied — never the raw descriptor. A Conf# code is kept: it pairs the two halves of a transfer.';
comment on column public.dropped_lines.reason is
  'Why the sync dropped the line, in plain words (the categorizer''s own reason).';

-- ── 2. the locks ─────────────────────────────────────────────────────────────
alter table public.dropped_lines enable row level security;
revoke all on public.dropped_lines from anon, authenticated;

-- The household may READ it in the app. Nothing in the app reads it yet, and the grant is
-- here so the day a screen shows it is app code, not another migration. No insert,
-- update or delete for a signed-in user: only the sync writes it, with the service role,
-- and a row a person could edit would be a record of a bank line that the bank never
-- sent. `anon` gets nothing, so the publishable key in the browser bundle cannot reach it.
grant select on public.dropped_lines to authenticated;
drop policy if exists "dropped_lines household" on public.dropped_lines;
create policy "dropped_lines household" on public.dropped_lines
  for select to authenticated using (true);

-- NOT added to supabase_realtime, deliberately. No screen watches it.

-- ── 3. housekeeping, by hand ─────────────────────────────────────────────────
-- A few rows a week (mostly the two halves of the household's own transfers). Nothing
-- prunes it automatically: an unattended delete is exactly what this project keeps out
-- of its cron jobs. The door only ever looks 14 days back, so any row older than that
-- is safe to remove if it is ever worth the bother:
--
--   delete from public.dropped_lines where date < current_date - 400;
