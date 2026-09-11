-- repair_v34_labels_and_queue.sql — 2026-09-10
--
-- Gino, after reading a month of his own ledger against three fresh BoA
-- statements (4662, 1211, 0366, 08/03–09/10):
--
--   "tons of transactions that are said to need to be reviewed and it is
--    confusing because when i click on the transaction to review it its already
--    given a category which is a waste of my time. Also it looks like
--    transactions that are in processing state go into this review box as well
--    and it also seems like often bills that are due and paid get treated as a
--    transaction, and it seems many transactions are being routed to other
--    instead of a proper category"
--
-- Four separate defects. The code fixes stop them recurring; this file repairs
-- the rows that are already wrong, because a code fix only ever reached charges
-- that had not been imported yet — which is itself one of the four.

begin;

-- ── 1. A car-insurance payment that belongs to no modelled bill ───────────────
-- $295.29 to GEICO on 2026-09-08, sitting in Misc flagged "needs review".
--
-- I expected this to be a labelling failure and it is not. The GEICO rule fires
-- correctly and names the bill "Car insurance" — there is simply no car-insurance
-- row modelled for SEPTEMBER. The two that exist are:
--
--     Car insurance — last two instalments   $363.35   2026-10-01 → 2026-11-30
--     Car insurance (both cars)              $290.59   from 2027-02-01
--
-- September falls in the gap between them, so the importer did the right thing
-- with the wrong model: "bill rule matched but no such recurring row → record it
-- as spending and ask." It is not a mislabel; it is a hole in the insurance term.
--
-- NOT linking it to a cycle, because there is no cycle to link it to, and
-- inventing one to make a row look tidy is how a ledger starts lying. It takes
-- `bills` — real cash, visible, on no budget line — and stops asking.
update public.transactions
   set category_id = 'bills', needs_review = false
 where date = '2026-09-08' and amount = 295.29
   and coalesce(raw_description, description) ilike '%GEICO%'
   and applies_to is null;

-- ── 2. Rows the labeller can now name, that it could not name when they landed ─
-- `travel` and `education` are categories the app DISPLAYS and the categorizer
-- could not REACH — his own "Travel/Other" hand-label mapped to `other`, and
-- there was no education rule at all. So a whole Las Vegas trip and an ASU
-- enrollment fee read as "Misc / uncategorized".
--
-- Both sit on the SAME budget line as `other`, so not one dollar moves between
-- lines. The rows just say what they are.
update public.transactions set category_id = 'travel', needs_review = false
 where coalesce(user_categorized, false) = false
   and category_id = 'other'
   and coalesce(raw_description, description) ~* 'USA TRAVEL CENTER|MORTON''S TRAVE|BOOKING\.COM|SUNRISE INN|AMERICAN AIR';

update public.transactions set category_id = 'education', needs_review = false
 where coalesce(user_categorized, false) = false
   and category_id = 'other'
   and coalesce(raw_description, description) ~* 'ASU\.EDU|UNIVERSAL PATHWAYS|ARIZONA STATE UNIVERSITY';

-- The merchants that had no rule at all. Each one is a real line from the three
-- statements he sent, and each was sitting in Misc.
update public.transactions set category_id = 'dining', needs_review = false
 where coalesce(user_categorized, false) = false and category_id = 'other'
   and coalesce(raw_description, description) ~* 'NANA''S SANDWICH|SUZUYA PATISSERIE|WHAT''S CREPE|INREACH';

update public.transactions set category_id = 'groceries', needs_review = false
 where coalesce(user_categorized, false) = false and category_id = 'other'
   and coalesce(raw_description, description) ~* 'SMITHS #';

update public.transactions set category_id = 'shopping', needs_review = false
 where coalesce(user_categorized, false) = false and category_id = 'other'
   and coalesce(raw_description, description) ~* 'HM\.COM|YSLBEAUTY|CSC SERVICEWORKS';

update public.transactions set category_id = 'subscriptions', needs_review = false
 where coalesce(user_categorized, false) = false and category_id = 'other'
   and coalesce(raw_description, description) ~* 'GODADDY|GROK XAI|GOOGLE ONE|\mCOLAB\M';

-- ── 3. Learned rules that teach the labeller to give up ───────────────────────
-- A learned rule beats every other rule in the categorizer — that is the point of
-- it, one tap and the answer is permanent. Which means a rule whose answer is
-- `other` is a standing instruction to file that merchant in Misc forever, and no
-- later rule can rescue it. Three had accumulated: Google One, Grok/xAI and SWA
-- (Southwest Airlines). The code now refuses to learn `other` at all.
delete from public.merchant_rules where kind = 'variable' and category_id = 'other';

-- Circle K and QuikTrip sell fuel and sell sandwiches, under one merchant name.
-- A single merchant->category rule is structurally incapable of being right for
-- both — "Circle K → dining" re-filed every fill-up as a meal, and six Circle K
-- charges are sitting in `dining` because of it. The app already refuses to offer
-- "Remember this merchant" on these; these two rules predate that guard.
--
-- Removing them does not guess the other way: the charges fall back to the
-- multi-department branch, which flags them and asks once, which is the honest
-- answer when the bank line does not say which counter he stood at.
delete from public.merchant_rules where pattern in ('CIRCLE K', 'QUIKTRIP', 'MORTON''S TRAVEL PLAZA');

-- ── 4. An internal transfer booked as income while it was processing ──────────
-- $39.00, "TRANSFER FROM ACCT #1211 ON 09/10 VIA WEB" — his own money moving
-- between his own two checking accounts. The settled wording ("Online Banking
-- transfer from CHK 1211") was recognised; the PENDING wording was not, so the
-- same dollars were counted as new income for as long as the hold lasted.
delete from public.transactions
 where status = 'pending'
   and type = 'income'
   and coalesce(raw_description, description) ~* '\mTRANSFER (FROM|TO) (ACCT|ACCOUNT|CHK|SAV)\M';

-- ── 5. Stop asking questions that already have answers ────────────────────────
-- The review queue's own rule — not a data problem, but these rows were flagged
-- by the importer at low confidence and have since been given a real category by
-- a rule that now exists. Leave anything still sitting in Misc asking.
update public.transactions set needs_review = false
 where needs_review is true
   and category_id <> 'other'
   and applies_to is null
   and coalesce(user_categorized, false) = false
   and coalesce(raw_description, description) ~* 'BOOKING\.COM|SUNRISE INN|USA TRAVEL CENTER|MORTON''S TRAVE|ASU\.EDU|UNIVERSAL PATHWAYS|SMITHS #|HM\.COM|NANA''S SANDWICH|SUZUYA|WHAT''S CREPE';

commit;
