-- schema_v44_debt_closed.sql  —  2026-10-10  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE COLUMN: when a debt was CLOSED — finished, and kept.
--
-- NUMBERED v44, NOT v43, ON PURPOSE. This file was written as v43 on 2026-10-10, the same
-- day another branch took that number for schema_v43_review_dismissals.sql. Two files
-- sharing a number are two files somebody runs in an order nobody chose, or skips one of,
-- so this one moved — and every sentence that names it (the write door's refusal, the
-- comments, API.md, the tests) moved with it in the same commit. The two do not touch
-- each other — that one adds a table, this one a column on public.debts — so either can
-- be run first.
--
-- THE GAP
--   Nothing could change a debt once it was added. The app has addDebt, link and
--   unlink (src/store/FinanceStore.tsx) and no update and no delete; the write door
--   had add_debt, link_debt_to_card and unlink_debt_card. A scan of the door's own
--   calls on 2026-10-10 found the cost: a card's minimum payment changes after every
--   statement, finance.debts reads the stored one out loud, and the only fix was raw
--   SQL — no audit row, no way back. finance.edit_debt fixes the name, the minimum and
--   the rate with columns that already exist. Closing a finished debt needs this one.
--
-- WHY A FLAG AND NOT A DELETE
--   A debt's history is the record that it was paid: every payment that went at it
--   carries its id in applies_to.debtId, and a deleted debt leaves each of those
--   pointing at nothing — the orphan the app's own links-point-somewhere self-check
--   exists to report. The app never deletes a bill for the same reason (it turns one
--   off). So a closed debt stays, with its history, at its zero balance, and this
--   column says when it was finished.
--
-- WHAT READS IT, AND WHAT DOES NOT
--   · finance.edit_debt writes it (closed: true / false), through the undo-fenced
--     compare-and-set like every other door write, and system.undo puts it back.
--     The door refuses to close a debt that still shows money owed, or one that still
--     follows a card (the bank would set its balance again on the next sync).
--   · finance.debts on the read door says `closed` per debt.
--   · The app does not read it yet. It does not need to for its numbers: only a debt at
--     a zero balance can be closed, and the plan, the payoff and the calendar already
--     treat a debt at zero as finished.
--
-- BEFORE THIS FILE IS RUN
--   finance.edit_debt still changes a name, a minimum and a rate. Asked to close or
--   re-open a debt it refuses with a sentence naming this file, because it reads
--   `closed_at` on its own and only when asked to. The read door's `select *` simply
--   finds no such key and reports every debt open, which is true until this exists.
--
-- RLS AND GRANTS: none to add. The column inherits public.debts' "Household access"
-- policy and its grants (schema.sql); the door writes with the service role, exactly as
-- it writes the other debt columns.

alter table public.debts
  add column if not exists closed_at timestamptz;

comment on column public.debts.closed_at is
  'When this debt was closed: finished and kept, never deleted. NULL while it is open. '
  'Set and cleared by the write door''s finance.edit_debt; only a debt at a zero balance '
  'that follows no card can be closed.';
