-- schema_v10_variable_bills.sql — flag a recurring bill as variable-amount (RUN ONCE)
-- ---------------------------------------------------------------------------
-- A "variable" bill (e.g. Electric/SRP, a credit-card payment) has an amount
-- that changes month to month. The app then projects it from the rolling
-- average of recent ACTUAL payments (billExpected) instead of the fixed modeled
-- amount. This is DISPLAY/calendar only — the debt-firepower math stays on the
-- contracted figure so the payoff countdown can't wobble.
-- SAFE TO RUN: additive single column with a default; re-running is a no-op.
-- ---------------------------------------------------------------------------
alter table public.recurring
  add column if not exists variable boolean not null default false;
