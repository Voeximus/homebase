-- v13 — surface the "still processing" amount.
--
-- Bank of America (via Plaid) doesn't hand us the itemized PENDING transactions
-- until they post — but it does tell us the hold size, as the gap between the
-- account's `current` and `available` balance. We store that gap per account so
-- the app can show "~$X still processing" without inventing pending rows (which
-- would risk a duplicate / double-withdraw when they post). The cash balance
-- stays = the available balance (already net of the hold); this column is a
-- display-only annotation that auto-shrinks to 0 as charges post.
alter table accounts
  add column if not exists pending_hold numeric not null default 0;
