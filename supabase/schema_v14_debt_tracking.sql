-- v14 — auto-track NON-bank debts (Affirm, Mom-China) from the bank feed.
--
-- Bank-linked credit cards already auto-update via the v12 trigger (debt.balance
-- = the card's live balance). But Affirm and the Mom-China debt have no linked
-- account. They ARE paid through the bank, though — Affirm posts as an "AFFIRM"
-- debit, the China debt as a "REMITLY" transfer. These columns let the Plaid
-- edge function recognize those payments and keep each debt's balance current as
--   balance = tracked_baseline − sum(matched feed payments since tracked_since)
-- recomputed (SET, not decremented) on every sync → idempotent, no double-count,
-- self-correcting if a payment is reversed. Bank-linked debts ignore this (the
-- trigger owns them); only debts with track_pattern set and provider_account_id
-- NULL are feed-tracked.
alter table debts add column if not exists track_pattern text;       -- e.g. 'AFFIRM', 'RMTLY' (the ACTUAL BofA descriptor; Remitly posts as "RMTLY", not "REMITLY")
alter table debts add column if not exists tracked_baseline numeric; -- the FIXED balance when auto-tracking began (recompute subtracts payments from THIS, never the live balance)
alter table debts add column if not exists tracked_since date;       -- only count matched payments on/after this date

-- A pattern is only "armed" with a fixed baseline + since-date together. Without
-- this, a track_pattern with a NULL baseline would make the recompute fall back to
-- the live balance and re-subtract every sync (walking the debt to zero). The edge
-- function also defends against this, but the constraint makes it impossible.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'debts_track_armed_ck') then
    alter table debts add constraint debts_track_armed_ck
      check (track_pattern is null or (tracked_baseline is not null and tracked_since is not null));
  end if;
end $$;
