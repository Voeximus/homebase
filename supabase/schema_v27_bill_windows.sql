-- v27 — a recurring row can have a LIFETIME, not just an on/off switch.
--
-- Until now the only way to say "Mom's support is paused until November" was to
-- flip active=false and leave a note reminding a human to switch it back. That is
-- exactly the class of state the card-payment bill already avoids by gating live
-- off the debt balance: something to remember to clean up.
--
-- starts_on / ends_on make a bill's window declarative, so:
--   · Mom resumes on 2026-11-01 at $300 with nobody remembering to do it
--   · ALEKS stops billing when the term starts, on its own
--   · Cherry's last payment is a date, not a division problem
--
-- Both are NULL by default, which means "always" — every existing row is
-- unaffected, and a NULL window behaves exactly as it does today.

alter table public.recurring
  add column if not exists starts_on date,
  add column if not exists ends_on   date;

comment on column public.recurring.starts_on is
  'First date this bill may fire. NULL = no lower bound. A future date means the bill is scheduled but dormant — it turns itself on.';
comment on column public.recurring.ends_on is
  'Last date this bill may fire. NULL = no upper bound. Used for finite plans (a dental loan) and for subscriptions with a known cancel date.';
