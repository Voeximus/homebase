-- schema_v42_flow_override.sql  —  2026-10-01  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- ONE COLUMN: what a HUMAN says a transaction is, when the derivation is wrong.
--
-- THE ASK
--   "We need to make sure every type of transaction also has a category or
--    identifier so things like bank transfers aren't mistaken."
--
--   He was right, and the reason he was right is three wrong answers in one
--   conversation. "What do we net per month" came back as a $780 deficit, then
--   break-even, then +$400 — none of them an arithmetic error, all of them correct
--   sums of rows nobody had classified. The worst case: both credit cards are synced,
--   so every card payment appears TWICE, once leaving checking and once arriving at
--   the card, and a single $2,500 payment inflated one month's income AND its
--   spending by $2,500.
--
-- WHY THIS IS AN OVERRIDE AND NOT THE ANSWER ITSELF
--   The obvious design is a `flow` column holding the classification for all 796 rows,
--   backfilled once. That is a CACHE of a derivation, and a cache drifts: improve a
--   rule in flow.ts and 796 stored rows quietly disagree with it, with nothing to say
--   which is right. The repo has spent this whole week finding numbers that were stale
--   rather than wrong.
--
--   So the derivation stays live — src/lib/flow.ts classifies every row on every read,
--   from the household's own accounts — and this column holds ONLY the cases where a
--   person looked at the answer and said no. Null is the normal state and means "the
--   derived answer stands". Nothing to backfill, nothing to drift, and a correction is
--   permanent.
--
-- WHAT THE FIVE VALUES MEAN, because the check constraint cannot say it:
--   earned    money into the household from outside it
--   spent     real consumption
--   moved     between their own accounts — appears twice, nets to zero
--   repaid    cash to a liability; the household is not poorer, just rearranged
--   returned  money back for something already counted as spent
--
--   Only `earned` and `spent` change what they are worth. That is the whole point of
--   the split, and it is why `moved` and `repaid` must never be guessed at.

alter table public.transactions
  add column if not exists flow_override text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_flow_override_check'
  ) then
    -- Spelled out rather than referencing an enum type: the five values live in
    -- src/lib/flow.ts as a TypeScript union, and a Postgres enum would be a second
    -- place to change when they move. The check is the fence; flow.ts is the meaning.
    alter table public.transactions
      add constraint transactions_flow_override_check
      check (flow_override is null or flow_override in ('earned', 'spent', 'moved', 'repaid', 'returned'));
  end if;
end $$;

-- Only the overridden rows are ever looked up by this, and they are a handful out of
-- hundreds, so the index is partial. A full index would be mostly nulls.
create index if not exists transactions_flow_override_idx
  on public.transactions (flow_override)
  where flow_override is not null;

comment on column public.transactions.flow_override is
  'What a person says this row is, overruling src/lib/flow.ts. NULL means the derived answer stands — that is the normal case. One of: earned, spent, moved, repaid, returned.';
