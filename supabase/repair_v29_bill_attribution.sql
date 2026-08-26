-- repair_v29_bill_attribution.sql — 2026-08-25
--
-- A one-time data repair. The code fixes that ship alongside it stop these from
-- happening again, but they cannot heal what is already written: the importer's
-- upsert ends with `applies_to = coalesce(existing, excluded)`, which by design
-- never overwrites a bill link, and the Plaid cursor is persisted after every
-- successful sync, so a dropped row is never re-delivered.
--
-- Everything below was reconciled line-by-line against two Bank of America
-- statements (Gino …4662 and Xinyan …0366, pulled 2026-08-25) and the card …4728
-- account summary. Account BALANCES are already correct — they come from Plaid's
-- reported figure, not from summing this table — so every insert here is
-- record_only: it restores the record of money that left, without moving a
-- balance that already reflects it.

begin;

-- ── 1. Release September's rent ───────────────────────────────────────────────
-- A $6.00 parking charge at "Parkinsafe Nollie" matched the rent rule written for
-- the landlord "Nollie MA" and settled the SEPTEMBER rent cycle. The calendar
-- read "Sep 1 — Rent — PAID $6.00"; September's bills fell from $2,979.70 to
-- $1,247.54 and the projected September low point flipped from −$721.47 to
-- +$1,010.69 — a sign change on the tightest month of the household's year.
update public.transactions
   set applies_to   = null,
       category_id  = 'transport',
       needs_review = false
 where id = '862d38cf-d287-4065-be78-3f45ac95ecb5'
   and amount = 6.00
   and applies_to->>'recurringId' = 'c55f3c3f-2294-494e-a2ae-a173d92d7114';

-- ── 2. Restore the five charges the importer discarded ────────────────────────
-- When a payment landed in a bill cycle another payment had already settled, the
-- importer did a bare `continue`: the row was written nowhere and left no trace.
-- $108.27 of real spending vanished this way in August alone. These are those
-- rows, taken from the statements, carrying no applies_to (the cycles they
-- collided with really are settled) and the category their bill would have given
-- them, so they land outside the discretionary envelope where they belong.
insert into public.transactions
  (date, amount, type, category_id, description, raw_description, account_id, needs_review, record_only)
values
  -- Verizon paid twice in August: $209.45 on the 3rd catching up, then the
  -- ordinary $93.03 on the 24th. The second one did not exist in the ledger.
  ('2026-08-24',  93.03, 'expense', 'utilities', 'Vz Wireless Vw',
   'VZ WIRELESS VW DES:VZW WEBPAY ID:6378845 INDN:GIOVANNI *CIRINO CO ID:XXXXX51800',
   '5a9f43d2-1b73-42eb-b4dc-6d1903bca21f', true, true),
  -- Two of the three $6 parking charges, eaten by the rent collision above.
  ('2026-08-16',   6.00, 'expense', 'transport', 'Parkinsafe Nollie',
   'CHECKCARD 0816 PARKINSAFE NOLLIE PARKINSAFE.COAZ',
   '5a9f43d2-1b73-42eb-b4dc-6d1903bca21f', false, true),
  ('2026-08-20',   6.00, 'expense', 'transport', 'Parkinsafe Nollie',
   'CHECKCARD 0820 PARKINSAFE NOLLIE PARKINSAFE.COAZ',
   '5a9f43d2-1b73-42eb-b4dc-6d1903bca21f', false, true),
  -- A $2.00 payment on 07-16 had already claimed the August cycle of the …6813
  -- card bill, so this $3.24 payment was dropped.
  ('2026-08-13',   3.24, 'expense', 'other', 'Mobile Banking payment to CRD 6813 Confirmation# z3avx58ga',
   'Mobile Banking payment to CRD 6813 Confirmation# z3avx58ga',
   '77f37a71-474a-47d1-9dd3-1a7da33567a6', true, true);

-- ── 3. ALEKS: one charge, one row ─────────────────────────────────────────────
-- merchantKey() cuts "MHE*ALEKS" at the "*", so the learned key was the bare
-- "MHE" — a publisher, not a product, and far too blunt to carry a bill link. The
-- real bank charge was therefore filed as ordinary subscription spend while a
-- hand-typed "already paid" placeholder settled the bill. Two rows, one charge,
-- $21.57 double-counted, every month. Give the real charge the bill link and drop
-- the placeholder.
update public.transactions
   set applies_to = jsonb_build_object(
         'kind', 'bill',
         'recurringId', '1ecd8b32-b317-49c7-9735-72360bfcc4e0',
         'monthKey', '2026-08',
         'day', 15,
         'installmentIndex', 0,
         'settled', true),
       needs_review = false
 where date = '2026-08-17'
   and amount = 21.57
   and provider is not null
   and applies_to is null;

delete from public.transactions
 where id = '45ac845e-9352-4713-8f69-7f4616f3f14b'
   and account_id is null
   and description = 'ALEKS calculus (already paid)';

-- ── 4. Cherry pays a bill AND a debt ──────────────────────────────────────────
-- Cherry is both a modeled monthly bill and a feed-tracked debt. August's payment
-- settled only the debt, so the Bills tab showed Cherry unpaid in a month it had
-- been paid — $151.72 of phantom obligation, recurring until the row's ends_on in
-- January. July's row already carries both links; match it.
update public.transactions
   set applies_to = applies_to || jsonb_build_object(
         'kind', 'bill',
         'recurringId', '3e870919-9ffb-4832-851a-2bb1c5885673',
         'monthKey', '2026-08',
         'day', 24,
         'installmentIndex', 0)
 where id = '96cc237c-f56b-423b-9cda-dead24fadc2c'
   and applies_to->>'kind' = 'debt';

-- ── 5. Cosmetics are not "uncategorized" ──────────────────────────────────────
-- Plaid truncates "SP HOURGLASSCOSME" to the clean name "Hourglas", which matched
-- nothing, so $78.29 sat in the $125/mo Misc line. Health/Personal folds into
-- shopping, and a HOUR GLASS COSMETIC rule was already taught — it just could
-- never fire on that key.
update public.transactions
   set category_id = 'shopping', needs_review = false
 where date = '2026-08-23' and amount = 78.29 and category_id = 'other';

-- ── 6. A question that was answered should stop being asked ───────────────────
-- needs_review means "the app could not tell — answer this". Setting a category
-- by hand IS the answer, but the write path never cleared the flag, so 27 rows
-- the user had already resolved stayed flagged forever and the review list never
-- emptied.
update public.transactions
   set needs_review = false
 where needs_review is true
   and user_categorized is true;

commit;
