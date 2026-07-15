-- v23 — non-monthly bills: an anchor month, so a yearly/semiannual charge lands on
-- its anniversary instead of every month.
--
-- WHY: the scheduler drove entirely off `due_days`, which says WHICH DAY but never
-- WHICH MONTH. A yearly membership (due_days [16]) therefore rendered in all twelve
-- months, amortized to 1/12 of its amount — so Gino's $16.22 Sam's Club fee showed
-- as a phantom $1.35 bill every month, and a semiannual premium couldn't be modeled
-- at all. `anchor_date` names one date the bill is known to have fired; the app
-- repeats it every N months from there (see firesInMonth in src/lib/schedule.ts).
--
-- Only meaningful for cadences longer than a month. Monthly and sub-monthly rows
-- leave it NULL — their due_days already carry the whole schedule.

alter table public.recurring
  add column if not exists anchor_date date;

comment on column public.recurring.anchor_date is
  'For quarterly/semiannual/yearly bills: a date the bill is known to fire. It repeats every N months from here, forwards and backwards. NULL for monthly and sub-monthly rows.';

-- Widen the cadence check to match the Cadence union in src/types.ts.
alter table public.recurring drop constraint if exists recurring_cadence_check;
alter table public.recurring add constraint recurring_cadence_check
  check (cadence in ('weekly','biweekly','semimonthly','monthly','quarterly','semiannual','yearly'));

-- The Sam's Club membership: a real yearly bill (charged 2026-06-16), previously
-- duplicated by a hardcoded ANNUAL entry in schedule.ts (now removed) while its
-- recurring row leaked $1.35 into every month.
update public.recurring
   set anchor_date = '2026-06-16', name = 'Sam''s Club membership'
 where name in ('Club', 'Sam''s Club membership');

-- Xinyan's car insurance — a 6-month premium, first modeled cycle 2026-08-01,
-- next 2027-02-01. Previously invisible to the app entirely.
insert into public.recurring
  (name, amount, direction, cadence, category_id, owner, active, variable, due_days, anchor_date, note)
select 'Car insurance (Xinyan)', 639.42, 'out', 'semiannual', 'other', 'Xinyan', true, false,
       array[1], '2026-08-01', '6-month premium; next after Aug 1 is Feb 1'
where not exists (select 1 from public.recurring where name = 'Car insurance (Xinyan)');
