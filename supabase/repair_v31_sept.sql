-- repair_v31_sept.sql — 2026-09-08
--
-- Repairs for rows already written. The code fixes shipping alongside stop each
-- cause, but the importer never rewrites an existing row's category or bill link,
-- so these have to be said explicitly.
--
-- Rows the user categorized by hand are left alone throughout.

begin;

-- ── 1. A $120 payment settled a bill that starts in November ──────────────────
-- "Zelle payment to mon" on 2026-09-02 claimed Mom / 2026-09, but that recurring
-- row has starts_on = 2026-11-01, so no September installment can render: the
-- claim attaches to nothing AND the $120 drops out of the budget, because a row
-- carrying an applies_to is never graded. The window filter in the importer was
-- being undone by an all-rows fallback; that is fixed. This releases the row.
--
-- It is NOT re-filed as a bill payment, because which it is depends on something
-- only Gino knows: whether support to his mother has restarted early. Flagged for
-- him to answer.
update public.transactions
   set applies_to = null, category_id = 'other', needs_review = true
 where date = '2026-09-02' and amount = 120.00
   and applies_to->>'recurringId' = '7a0743fa-855d-4922-894e-d5654b712970';

-- ── 2. Two rows the bank sent that never reached the ledger ───────────────────
-- record_only: the balances come from the bank's own figure and already reflect
-- these, so the rows restore the RECORD without moving a balance.
--
-- The $40 is the sibling of the $120 above — same day, same account, same
-- recipient. The current code classifies it correctly as spending; Plaid has
-- simply not delivered it. Inserting it with the same description means the
-- content-dedup guard will absorb the feed's copy if it ever arrives, so this
-- cannot double.
--
-- The $20 is a cash withdrawal that was read as a cash DEPOSIT: the merchant key
-- "BKOFAMERICA ATM" carries the history label "Cash deposit", which maps to skip.
-- Correct for a deposit, silently wrong for a withdrawal.
insert into public.transactions
  (date, amount, type, category_id, description, raw_description, account_id, needs_review, record_only)
values
  ('2026-09-02', 40.00, 'expense', 'other', 'Zelle payment to mon Conf# wmbzhdkcc',
   'Zelle payment to mon Conf# wmbzhdkcc',
   '5a9f43d2-1b73-42eb-b4dc-6d1903bca21f', true, true),
  ('2026-08-31', 20.00, 'expense', 'other', 'Bkofamerica Atm',
   'BKOFAMERICA ATM 08/31 #000001616 WITHDRWL BROADWAY & MCCLINT TEMPE AZ',
   'eb0816f5-58e2-4348-be7d-450eefc7bc0c', true, true);

-- ── 3. Money that moved between their own accounts is not spending ────────────
-- Bank of America has started writing "TRANSFER TO ACCT #0366 ON 09/06 VIA WEB"
-- where it used to write "Online Banking transfer to CHK 0366". The new form
-- matched nothing, so $147.00 moving from the joint account to Xinyan's was
-- recorded as Misc spending against a $125/mo line.
update public.transactions
   set applies_to = '{"kind":"transfer"}'::jsonb, needs_review = false
 where date = '2026-09-06' and amount = 147.00
   and coalesce(raw_description, description) ilike 'TRANSFER TO ACCT #0366%';

-- ── 4. Spot Pet is in the ledger twice ────────────────────────────────────────
-- The real charge arrived from the bank on 09/04 and is still pending; a pending
-- row cannot settle its bill, so the bill read unpaid and it was hand-marked. Now
-- both exist. The hand-typed one goes; the real one settles the bill when it
-- posts.
delete from public.transactions
 where description = 'Spot Pet insurance (already paid)'
   and account_id is null
   and date = '2026-09-06';

-- ── 5. Car insurance: model the instalments that are actually left ────────────
-- The row was a flat $340.66 on the 30th for three months — an average. The real
-- schedule is $295.29 (paid 8 Sept), $363.30 on 31 Oct and $363.39 on 30 Nov. The
-- total was right and every individual month was wrong, and because September's
-- instalment has ALREADY gone out, the app was still showing a $340.66 insurance
-- bill due on 30 September that will never arrive.
--
-- Retuned to the two instalments that remain. The two differ by nine cents, so one
-- row at $363.35 reproduces them to within a cent of the true $726.69.
update public.recurring
   set name = 'Car insurance — last two instalments',
       amount = 363.35,
       due_days = array[30],
       starts_on = '2026-10-01',
       ends_on = '2026-11-30',
       note = 'GEICO, current term. Real instalments: $295.29 paid 2026-09-08, '
              || '$363.30 on 31 Oct, $363.39 on 30 Nov. Nothing in Dec or Jan; the '
              || 'new term starts 1 Feb 2027 at ~$290.59/mo (separate row). Modelled '
              || 'at $363.35 x2 because the two remaining instalments differ by 9c.'
 where id = 'c02d969b-61ed-485e-b826-9f3b132030c2';

-- September's instalment is real, paid, and now has no modelled cycle to settle.
-- `bills` keeps it visible and out of the discretionary envelope while still
-- cutting what can go at the card.
update public.transactions
   set category_id = 'bills', needs_review = false
 where date = '2026-09-08' and amount = 295.29 and description = 'GEICO';

commit;
