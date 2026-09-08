-- repair_v32_relabel.sql — 2026-09-08
--
-- Relabelling pass. Gino: "the app failed to understand a lot of transactions."
-- These are the rows a person reading their own ledger could not make sense of.

begin;

-- ── 1. Money he sent his mother and got straight back ────────────────────────
-- $40 + $120 out on 2026-09-02, and $160 back from KATHERINE CIRINO the same day.
-- That is not support and it is not income — it is the same $160 making a round
-- trip, and counting it as both spending AND earnings overstates each side.
--
-- There is already a precedent in his own data: 2026-06-23 $200 out, repaid
-- 06-24, marked as a settled set-aside. Same shape here.
update public.transactions
   set applies_to = jsonb_build_object(
         'kind', 'setaside', 'reason', 'reimbursable', 'settled', true,
         'settledAt', '2026-09-02T12:00:00Z',
         'settledByTxnId', '1764511b-d271-45aa-a560-6d0f212406e4',
         'note', 'Fronted to mom, repaid the same day'),
       needs_review = false
 where id in ('e14fc895-4b86-4764-9728-c002942c0bce',   -- $120 out
              'ae484ac8-cee8-460b-8a1d-164004cf2f77');  -- $40 out

update public.transactions
   set applies_to = jsonb_build_object(
         'kind', 'setaside', 'reason', 'reimbursable', 'settled', true,
         'settledAt', '2026-09-02T12:00:00Z',
         'settledByTxnId', 'e14fc895-4b86-4764-9728-c002942c0bce',
         'note', 'Mom repaying the $160 fronted the same day')
 where id = '1764511b-d271-45aa-a560-6d0f212406e4';     -- $160 back

-- The same thing happened in August, and only ONE leg is in the ledger: $50 came
-- back from Katherine on 08-19, but the $50 that went out that morning was
-- dropped by the old $250 assistance gate (it classified as skip, which wrote the
-- row nowhere). So August currently shows $50 of income that was really a
-- repayment. Restore the outgoing leg and pair them.
insert into public.transactions
  (date, amount, type, category_id, description, raw_description, account_id, record_only, needs_review, applies_to)
values
  ('2026-08-19', 50.00, 'expense', 'other', 'Zelle payment to mon Conf# vy1k9fudi',
   'Zelle payment to mon Conf# vy1k9fudi',
   '5a9f43d2-1b73-42eb-b4dc-6d1903bca21f', true, false,
   jsonb_build_object('kind','setaside','reason','reimbursable','settled',true,
     'settledAt','2026-08-19T12:00:00Z',
     'settledByTxnId','fba728da-e2bc-4e70-be78-2abcbe51566a',
     'note','Fronted to mom, repaid the same day'));

update public.transactions
   set applies_to = jsonb_build_object(
         'kind','setaside','reason','reimbursable','settled',true,
         'settledAt','2026-08-19T12:00:00Z',
         'note','Mom repaying the $50 fronted the same day')
 where id = 'fba728da-e2bc-4e70-be78-2abcbe51566a';     -- $50 back

-- ── 2. The Las Vegas trip reads as "Misc / uncategorized" ────────────────────
-- A hotel and two travel plazas in the holding pen is exactly what "doesn't make
-- sense" looks like on screen. `travel` sits on the SAME budget line as `other`,
-- so not one dollar moves between lines — the rows just say what they are.
update public.transactions set category_id = 'travel', needs_review = false
 where date >= '2026-09-01'
   and coalesce(raw_description, description) ~* 'BOOKING\.COM|SUNRISE INN|USA TRAVEL CENTER'
   and coalesce(user_categorized, false) = false;

-- ── 3. Tuition is not Misc either ────────────────────────────────────────────
-- ASU Universal Pathways — the Earned Admission route he is enrolling on. It will
-- recur, so it gets a name now rather than the twentieth time it lands.
update public.transactions set category_id = 'education', needs_review = false
 where coalesce(raw_description, description) ~* 'ASU UNIVERSAL PATHWAYS|ASU\.EDU'
   and coalesce(user_categorized, false) = false;

-- ── 4. Smith's is a grocery store ────────────────────────────────────────────
update public.transactions set category_id = 'groceries', needs_review = false
 where coalesce(raw_description, description) ilike 'SMITHS #%'
   and coalesce(user_categorized, false) = false;

-- ── 5. A card payment is a card payment ──────────────────────────────────────
update public.transactions set category_id = 'bills', needs_review = false
 where date = '2026-08-13' and amount = 3.24
   and coalesce(raw_description, description) ilike '%CRD 6813%';

-- ── 6. "paycheck" is a category id no catalog ever defined ───────────────────
-- The importer was writing it until 2026-08-25; DEFAULT_CATEGORIES defines
-- `salary`, which is also what both recurring income rows use. 21 rows and
-- $33,033.19 of income have been displaying under a fallback label and a fallback
-- colour this whole time.
update public.transactions set category_id = 'salary' where category_id = 'paycheck';

-- ── 7. Stop asking questions the app can now answer itself ───────────────────
-- QuikTrip writes OUTSIDE/INSIDE on every line and Sam's Club charges outside the
-- one-tank range are decided by amount, so these are settled, not open questions.
-- The genuinely undecidable middle (a $34.91 warehouse run) keeps asking.
update public.transactions set needs_review = false
 where needs_review is true
   and coalesce(raw_description, description) ~* '\mOUTSIDE\M|\mINSIDE\M';

update public.transactions set needs_review = false
 where needs_review is true
   and coalesce(raw_description, description) ilike '%SAMS CLUB%'
   and (amount > 70 or amount < 8);

-- Verizon's extra August payment and the restored ATM/Zelle rows have been read
-- and understood; they do not need to keep asking.
update public.transactions set needs_review = false
 where date = '2026-08-24' and amount = 93.03 and category_id = 'utilities';

commit;
