-- repair_v33_two_answers.sql — 2026-09-08
--
-- Two rows the app could not decide on its own, answered by Gino and applied.
-- Kept here because a hand-typed UPDATE with no record is how a ledger drifts.

begin;

-- ── 1. The $20 of cash ───────────────────────────────────────────────────────
-- An ATM withdrawal is the one charge no descriptor can ever explain — the bank
-- knows the money left, not what it bought. It was the last row still asking.
-- Gino: "the 20 bucks was for a dining out thing." Marked user_categorized so no
-- future re-sync can overwrite an answer only he could give.
update public.transactions
   set category_id = 'dining', needs_review = false, user_categorized = true
 where date = '2026-08-31' and amount = 20.00
   and coalesce(raw_description, description) ilike '%BKOFAMERICA ATM%WITHDRWL%';

-- ── 2. The $1,100 car-insurance check ────────────────────────────────────────
-- Expected "sometime this month". The DAY is unknown, and the day is the whole
-- question for a low point — money arriving on the 2nd rescues a dip that money
-- arriving on the 28th does not. So it sits on the 30th: late enough that it
-- cannot rescue anything earlier, which makes every low point between now and
-- then a floor rather than a guess. If it lands sooner, that is upside.
--
-- Same reasoning as the $1,400 paycheck floor. Delete this row once the money is
-- actually in — it is a placeholder for a one-off, not a recurring bill.
insert into public.recurring
  (name, amount, direction, cadence, category_id, owner, active, due_days, starts_on, ends_on, variable, note)
select 'Car insurance check (one-off)', 1100.00, 'in', 'monthly', 'other-income', 'Xinyan',
       true, array[30], '2026-09-01', '2026-09-30', false,
       'Gino 2026-09-08: a $1,100 check from the car insurance, expected "sometime this month". '
       'Placed on the 30th because the day is unknown and late is the conservative end. '
       'DELETE this row once the money lands and the real deposit is in the ledger.'
 where not exists (select 1 from public.recurring where name = 'Car insurance check (one-off)');

commit;
