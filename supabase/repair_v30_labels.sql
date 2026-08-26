-- repair_v30_labels.sql — 2026-08-25
--
-- Second repair pass. Everything here follows a code fix that stops the cause;
-- these rows were written before it and the importer never rewrites an existing
-- row's category or bill link, so they need saying explicitly.
--
-- Rows the USER categorized by hand are deliberately left alone throughout.

begin;

-- ── 1. Charges that cannot have been fuel ─────────────────────────────────────
-- Every bank-CONFIRMED fuel charge in this household's history is a Sam's Club
-- pump sale between $32.83 and $45.28 — one tank for one car. $130.64 is 39
-- gallons at $3.30, about three tanks for a 2012 Civic, and it was sitting on the
-- Gas + convenience line: 36% of August's whole transport total. $4.05 is a snack.
-- The middle of the range is genuinely undecidable and is NOT touched — those
-- rows stay flagged for a one-tap answer, which is now actually shown.
update public.transactions
   set category_id = 'groceries'
 where date = '2026-08-24'
   and amount in (130.64, 4.05)
   and category_id = 'transport'
   and coalesce(user_categorized, false) = false;

-- ── 2. QuikTrip says which side of the building it was ────────────────────────
-- "QT 465 OUTSIDE" is the pump, "QT 465 INSIDE" is the shop, and the bank writes
-- one or the other on every single line — 16 outside and 4 inside across the
-- whole ledger. The categorizer discarded it, so the same station's charges sat
-- split between dining and transport at random.
update public.transactions
   set category_id = 'transport'
 where date in ('2026-08-14', '2026-08-07')
   and amount in (11.04, 9.19)
   and category_id = 'dining'
   and coalesce(raw_description, description) ilike '%OUTSIDE%'
   and coalesce(user_categorized, false) = false;

-- ── 3. Bills that did not exist yet were showing as overdue ───────────────────
-- ALEKS and Cherry carry an end date but no start date, so the calendar rendered
-- them as due — and unpaid — in every month back to April: $541.44 of obligations
-- the household never had. ALEKS began with the August charge; Cherry with July's.
update public.recurring set starts_on = '2026-08-01'
 where id = '1ecd8b32-b317-49c7-9735-72360bfcc4e0' and starts_on is null;
update public.recurring set starts_on = '2026-07-01'
 where id = '3e870919-9ffb-4832-851a-2bb1c5885673' and starts_on is null;

-- ── 4. A $2 top-up was settling a whole card cycle ────────────────────────────
-- A $2.00 payment on 16 July landed one day past the 7-day grace on July's cycle,
-- so it rolled forward and claimed AUGUST — leaving August's card bill reading
-- paid at $2.00 against a $35.00 minimum, and the real $25.00 payment on the 25th
-- with nothing to settle.
--
-- The first attempt at this repair moved it back to July, and the self-audit
-- immediately failed: July was already settled by a $35.00 payment on the 6th. So
-- the $2.00 was never a cycle payment at all — it was an extra top-up. It gets the
-- treatment the importer now gives every extra payment: recorded, visible,
-- ungraded, settling nothing.
update public.transactions
   set applies_to = null, category_id = 'bills'
 where date = '2026-07-16' and amount = 2.00
   and applies_to->>'recurringId' = 'b04df2be-824e-4e71-b332-b6ee07c94944';

-- ── 5. The August insurance payment belonged to no bill ───────────────────────
-- $639.42 to GEICO on 3 August — the old six-month premium, paid before the Civic
-- was added and before either modeled insurance row starts. It carried a bill link
-- flagged settled:false, a shape nothing in the code can write and (until now)
-- nothing read: the payment was graded in no budget and shown on no Bills tab, so
-- $639.42 of real cash was invisible on every finance screen. It becomes a plain
-- bill payment: visible, ungraded, and still cutting what can go at the card.
update public.transactions
   set applies_to = null, category_id = 'bills'
 where date = '2026-08-03' and amount = 639.42
   and applies_to->>'settled' = 'false';

-- ── 6. Amazon Prime is a monthly bill nobody modelled ─────────────────────────
-- $16.20 on 23 July and $16.20 on 24 August, 32 days apart at an identical amount.
-- It was correctly categorized both times and absent from the forecast both times,
-- so the September low point was computed $16.20 light.
insert into public.recurring (name, amount, direction, cadence, category_id, owner, active, due_days, starts_on, variable)
select 'Amazon Prime', 16.20, 'out', 'monthly', 'subscriptions', 'Gino', true, array[23], '2026-07-01', false
 where not exists (select 1 from public.recurring where name = 'Amazon Prime');

commit;
