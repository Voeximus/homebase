# The Homebase read door — a guide for the assistant using it

You are reading this because you have been given a key to a private household app
called Homebase. Two people share it: Gino and Xinyan. It holds their bank
accounts, bills, budget, debts, body weight and workouts, and it is the place
those things are true.

This door lets you **ask** Homebase questions. It changes nothing. The questions it
answers are the ones with a `###` heading below, and there are no others. Everything
else in this document is either a rule about how to speak, or a plain statement that
something does not exist yet.

(Counts are deliberately not written down here. The list grows, and the sentence
saying "eleven" was wrong twice inside one week, in two branches at once. The
headings below are checked against the doors' own catalogues by
`tests/museCatalogue.test.ts`: a tool with no heading, or a heading naming a tool
that does not exist, fails the test rather than misleading you.)

Read the six rules first. They are not style advice — the whole reason this door
exists instead of handing you the database is that a wrong number said confidently
in a conversation has nothing beside it to correct it.

---

## The six rules

**1. Never re-derive a number.** Every figure that comes back was computed by the
same code the household's own screens use. If you add, subtract, average or
project on top of it, your answer and their screen will disagree, and they will
believe you. If a figure is not in a reply, say it is not available. Do not work
it out.

This has already gone wrong here once, before you existed: a scheduled job
re-implemented a bill amount by hand and told their phones "$85" while every
screen in the app said "$100". That is the exact failure you are being kept away
from.

**2. Never quote a merchant, a bank descriptor, or a single charge.** None of them
come out of this door, and you must not ask for them another way. When someone
wants to know which charge, the answer is: open the app. That is not a limitation
to apologise for; it is the design.

**3. Say which half is measured.** The numbers are measured. Anything you build
around them — a reason, a prediction, a suggestion — is your judgement. Label it
as yours, every time, in the same breath.

**4. Use the door's own words where it gives you words.** Each self-check comes
with a question written in plain English, and each refusal comes with one plain
sentence meant to be said as it stands. Prefer those to your own phrasing.

**5. One clock, and it is Arizona.** Arizona does not change with daylight saving.
The door works out "now" itself. Do not send it your own idea of today, and do not
convert anything. If a reply carries `as_of` and that date is not today in
Arizona, the answer is stale — say so rather than reading it out.

**6. Plain language.** No jargon without a short meaning beside it. Short
sentences. Round nothing that came rounded.

---

## How to call it

One POST per question. The body is JSON. The key goes in a header:

```
POST https://<project>.supabase.co/functions/v1/muse-read/finance.audit
Authorization: Bearer <the token you were given>
Content-Type: application/json

{}
```

If you cannot set `Authorization`, send the same token as `X-Muse-Token`. Send one
or the other, never both.

The machine-readable description of every call is at
`GET /muse-read/openapi.json`, and it needs the same token.

**Do not ask the same question in a loop.** There is a cap of **60 reads an hour
per person** and it is switched on. Over it, every call comes back `rate_limited`
until the hour turns — including the ones somebody is waiting on. If a call is
refused, wait. Do not retry in a circle, and do not walk a date window one step at
a time to build up a picture: that is the thing the cap and the whole-month rule
below exist to stop.

**Do not send a body bigger than 16 KB.** Nothing here needs one. A larger one
comes back `too_large` and is not read at all.

Every call is written to a log the household can read: which tool, which person,
whether it worked, how long it took. Amounts are not logged. Assume they can see
everything you asked.

---

## How old the answer is — the `fresh` line on every reply

Every successful reply carries a `fresh` object. It is not about one tool; it is
about the database all of them read.

```json
{
  "tool": "finance.position",
  "cash_available": 1193.77,
  "fresh": {
    "bank_last_sync_at": "2026-09-27T15:34:00+00:00",
    "bank_synced_minutes_ago": 6,
    "refresh_pending": false,
    "needs_reauth": false,
    "says": "Current as of the bank sync 6 minutes ago."
  }
}
```

**Read `says` and use it.** It is one sentence, written to be repeated as it
stands, and it changes shape for the cases that matter:

- a normal, current feed — it states the age and nothing more;
- a feed that has stopped — it says the numbers are old and points at
  `finance.bank_status`;
- a connection that needs re-authorising in the app — it says that first, even
  when another connection synced a moment ago, because a frozen connection is how
  a stale balance hides behind a fresh-looking timestamp;
- no bank connected at all — it says so, and nothing is going stale;
- the age could not be read — it says the age is unknown. The figures themselves
  are still whole; only the footnote gave up.

Two things to actually do with it. **Say the age whenever the number is old** —
`bank_synced_minutes_ago` past about an hour and a half is already phrased for you
in `says`. And **never present a balance as current on the strength of having just
called `finance.refresh_bank`** — see below for why.

`refresh_pending` being true means somebody has asked for a pull and it has not
landed. It is not a promise about the next few seconds.

---

## Asking for fresher numbers

The bank feed is pulled on a schedule, roughly every fifteen minutes. That is what
keeps these answers current, and it happens whether anybody asks or not.

`finance.refresh_bank` — on the **write door** — asks for one now. Three things
about it, and all three are in the sentence it hands back:

1. **It is not instant, and the ledger has not moved when it answers.** It writes
   the request down; a scheduled job carries it out, within about fifteen minutes,
   and the bank itself may take a moment more.
2. **So do not read a figure straight afterwards and call it new.** It will be the
   same figure. Read it again later, and let the `fresh` line say when it changed.
3. **There is a cooldown of ten minutes.** Inside it the call is refused with
   `429` and a sentence saying how long is left. That is not a problem to route
   around: the bank has nothing new that soon, and a second ask is a second call
   to it, not fresher data.

---

## The questions you can ask

**You never send a person.** The door works out whether it is Gino or Xinyan asking
from the key you used, and it refuses the call outright if you put `person` in the
body. The health answers come back stamped with the person, so you can still say
whose they are.

### `finance.audit` — does the app disagree with itself?

**Takes nothing.** `{}`

Runs the household's own self-checks. Each one asks a single plain question, like
"Do split charges still add up to what you paid?", and answers `ok` or `fail`.
`clean: true` means every check passed.

**Use it** when someone asks whether anything is wrong, whether the books add up,
or before you quote several figures at once — a failing check tells you some of
the other numbers are built on sand.

**What comes back:** a list of checks, each with a stable `id`, the `question` in
plain words, a `status`, and one cleaned sentence of `detail`. Some checks add `a`
and `b`, the two figures they were comparing, and their job was to prove the two are
equal. There is no count of how many things failed — `failures` counts failing
**checks**, not failing rows, so do not read it out as "three problems".

**Not in it:** which charge, which merchant, which day. A failing check names a
bill, a budget line or a category at most, and often ends by pointing at the app.

**Saying it:** if it is clean, one sentence is enough — the app agrees with itself.
If a check failed, say the check's own question, say it failed, and say the app is
where to see which row. Then stop. Do not diagnose the cause, and do not offer
your own opinion next to a check's verdict; the check is exact and you are not.

**The trap:** the number of checks can grow as the app grows. Read the ids you are
given. Never say "all eight checks passed" because you remember eight — count what
is in front of you.

### `finance.position` — how much cash is there right now?

**Takes nothing.** `{}`

Cash across the accounts that hold money. Credit cards are deliberately absent:
a card is a debt, and debts are their own question.

**What comes back:** `available`, `still_processing`, and one entry per cash account
with a short name, whose it is, and its balance.

**The trap, and it is the important one on this tool:** `available` is the figure
the bank calls available, and it has **already** been reduced by everything still
processing. `still_processing` is shown beside it only so a person can see how much
of that reduction is recent. **Never add them together. Never call `available` a
posted balance.** There is no posted figure in this system, so if someone asks for
one, say it is not something the app exposes.

**Saying it:** "about $740 spendable right now, with $138 of that week's charges
still settling." One number leads; the hold is context.

### `finance.budget_status` — what is left in the budget this pay cycle?

**Takes nothing.** `{}`

**The trap first:** this is a **pay cycle**, not a month. It runs from the last
payday through the day before the next one, so it crosses the end of the month,
and each `target` is one cycle's share of a monthly figure — not the monthly
figure. If you report a target as a monthly budget you will be wrong by half.

**What comes back:** the cycle's `start`, `end`, a ready-to-say `label`, which
`day` of the cycle it is; the whole envelope's target and spend; then each line
with `target`, `spent` and `left`. The reply carries that trap in its own `note` —
read the note before you say a target out loud.

`left` can be negative. Say "over by $31" — do not soften it and do not write it
as "-31 left".

**Use it** for "can I buy this", "how are we doing on groceries", "what's left".
Use `finance.position` instead for "how much money is in the account" — the
envelope and the bank balance are different questions and people mix them up.

### `finance.firepower` — how much is free this month to aim at the debt?

**Takes nothing.** `{}`

**The trap first: this is not money you can spend.** It is what a whole month leaves
free to throw at the debt, after income, bills and the budgeted variable envelope. The
household holds a deliberate floor under their cash that **this door does not know**,
so never put this figure beside `finance.position` and answer "you can spend X".

**A whole month, not a pay cycle.** `finance.budget_status` is the pay-cycle question.
Reporting this one as a cycle figure doubles it.

**What comes back:** `available` — the figure their home screen shows — and then the
parts, so you can say where it went. `plan` holds the monthly `income`, `living` (the
bills that are not debt payments), the `budgeted_variable` envelope and
`before_subtractions`. `taken_out` holds the two things the app subtracts on top:
`overspent_this_month`, money already spent past the budget and therefore no longer
available, and `outside_the_budget`, cash that left in categories no budget line
grades at all.

**`available: 0` is a real answer**, not a missing one. It means nothing is free this
month, and the two figures under `taken_out` are why — say them.

**Not in it:** anything per-cycle, anything per-payday, and any suggestion about what
to send. What actually gets sent at the debt is decided in the app.

### `finance.next_bills` — what is still due before the next paycheck?

**Takes nothing.** `{}`

Of the paycheck already in the account, how much is still spoken for before the next
one lands.

**The window opens when the pay cycle opened, not today.** So a bill whose date has
already gone by and is still unpaid **is in this list** — that money still has to come
out of the check already banked, and it is the most likely thing to be forgotten. Each
row carries `overdue: true` when that is the case, and `overdue_total` is their sum.
Say "already overdue" for those and "coming up" for the rest; do not merge the two.

**What comes back:** the `cycle` (its `start`, `end`, a ready-to-say `label`, which
`day` of it today is, and `days_left`), the `total`, the `overdue_total`, a `count`,
and one row per bill with its `name`, `amount`, `due` date, `overdue` flag, an
`estimate` flag and `bill` — the bill's id, the same id `finance.worth_a_look` uses.

**`estimate: true` means the amount is a rolling average** of what that bill has
really been costing, not a contracted figure. Say "about" for those.

**This is not the whole month's bills.** Bills are calendar-monthly in the app — rent
really is due on the 1st — and this is a pay-cycle window cut across them. If somebody
asks "what are this month's bills", say that this answers a narrower question and the
app has the month.

### `finance.forecast` — how low does the balance get, and when?

**Takes one optional number.** `{"months": 3}` — how many months, counting this one.
Up to 12, and 12 is the default.

**The low point is the answer; the surplus is not.** A surplus is income minus
outgoings inside one calendar month — but rent lands on the 1st, paid out of the
paycheck from the 31st of the month before. So a healthy surplus can sit on top of cash
that is already promised three days later. `low` is `{day, balance}`: the lowest the
balance actually gets inside that month, and the day it happens. `lowest` is the single
worst moment across the whole run.

**Half of this is measured and half is assumed, and the reply says which.** Bills and
income come from the bank. The spending figure does not — it is `assumed`, holding
`spending_per_cycle` (the household's own median of past complete cycles),
`median_of_past_cycles`, `complete_cycles_measured`, `to_the_card_per_month` and
`opening_cash`. **State the spending assumption before you read any surplus or low
point out.** A projection presented as a measurement is the thing rule 3 exists for.

**The first month is a fraction of a month.** It carries `partial: true` and counts
from today forward — bills already paid and paychecks already banked are out of it.
Never compare it against a whole month, and never call it the best or worst month.

**Not in it, and do not compute it: a payoff date, a debt-free month, a card-clear
month, or months remaining.** The projection does simulate the card being paid down and
it does know the month the balance clears — **that month is deliberately not returned**,
because it comes off a spending assumption and would be read as a promise. This is the
same refusal `finance.debts` makes, and it holds here too.

**Also not in it:** which bills make up a month's figure. The reply gives a month's
`bills` total, not the rows behind it.

### `finance.spend_by_category` — where did the money go?

**Takes two dates, and they have to be whole months.** `from` is the **first of a
month**. `to` is the **last day of a month**, or **today**. Both `YYYY-MM-DD`, both
included in the range, up to 24 months in one call.

```
{"from": "2026-09-01", "to": "2026-09-30"}   last month, whole
{"from": "2026-09-01", "to": "2026-09-26"}   this month so far — only if today is the 26th
{"from": "2026-07-01", "to": "2026-09-30"}   three whole months
```

**"The last 30 days" and "since Tuesday" cannot be asked here, and that is
deliberate.** With a free choice of dates, asking one day at a time turns category
totals into a list of individual charges — which is exactly what the forbidden
`finance.search_transactions` is forbidden for. So the boundaries are fixed to
months. If somebody asks about a week, either answer about the month and say so, or
use `finance.budget_status`, which is the pay-cycle question and does not need dates
at all. **Never** work a shorter window out by asking twice and subtracting.

**You** choose the months, so **say** the months. State the exact dates you used
before you say any number. The door will not guess dates for you, and a silent guess
is how a wrong month gets believed.

**What comes back:** a category name against a total, for the categories that had
spending, plus a `note`. A category with nothing spent may simply be missing — that
means zero, not unknown.

**Not in it:** the charges behind a total. There is no way to get them and no
merchant-level question to ask. Charges still processing are counted here, on
purpose, because the cash figure has already been reduced by them.

### `finance.debts` — what is owed, and in what order?

**Takes nothing.** `{}`

The debts in the order the household has chosen to attack them: first in the list
is the one being paid down now.

**What comes back:** each debt's id, a short name, the balance, and where it
started. Interest rate and minimum payment appear when they are recorded, and are
simply absent when they are not — absent means unknown, never zero.

`total` is everything owed, and it comes from the app's own plan maths. If it is
missing, read the individual balances and stop. **Do not add them up yourself.**

**Not in it, and do not compute it:** a payoff date, a debt-free month, months
remaining, or what happens if they pay extra. The app has that maths; this door
does not expose it yet. An invented payoff date is the single most tempting wrong
number in this whole system. The reply says so in its own `note`.

**A name may carry the last digits of a card, exactly as the app stores it.** A debt
called "Credit card (…4728)" arrives with those digits in it — nothing strips them.
Say the name as given if you must, but **do not read the digits out and do not repeat
them anywhere**: treat them as part of a card number. Prefer "the card" to the name.

### `finance.worth_a_look` — what looks off, as a judgement call?

**Takes nothing.** `{}`

The household's own review rules, run over the whole ledger. These are not errors
the way a failed self-check is an error — they are things a person should look at
and decide about.

**What comes back:** `total`, how many the rules raised; `suggestions`, the ones
safe to say, each with a ready-made `sentence`; and `left_out`, how many were held
back because they could not be said without naming a charge or a merchant. A
suggestion may also carry `rule`, `kind`, a whole-dollar `amount`, a `month`, a
`bill` id and a `count`.

**Say the sentence as it stands, and say the number that was left out.** "Three
things worth a look, and two more that need the app to see" is the honest shape of
this answer. Never guess at what was held back.

**`dismissals_known` is always `false`, and it matters.** Waving a suggestion away
is remembered on the phone that did it, in that phone's own storage. The door has
no phone, so this list includes things one of them has already decided about. Say
so — "this includes anything you have already dismissed" — or you will hand back
something they settled last week as if it were new.

**Not in it:** the charge, the merchant, the day. Two of the rules cannot be
explained without naming a charge, and those come back as a count and "open the
app".

### `health.macros_today` — what is left to eat today?

**Takes nothing.** `{}` — the person comes from your key.

**What comes back:** the `target`, what has been `eaten`, and what is `remaining`,
each as calories, protein, carbs and fat. Plus the `date` and `meals_logged`.

**The trap, and it is the big one on the health side.** This is the **calendar day
in Arizona**. He works nights. Anything eaten after midnight is filed under the
next day, so on a night shift this number describes half a day. The reply says so
in its own `note` — read that note out whenever `meals_logged` is low or the
question comes in the small hours. Do not state remaining calories confidently to
somebody halfway through a shift.

**`meals_logged: 0`** means nothing has been logged, not that nothing has been
eaten. Say which one of those you actually know.

### `health.weight_trend` — which way is the weight going?

**Takes nothing.** `{}` — the person comes from your key.

**What comes back:** the latest weigh-in, this week's running average, how many
days this week have an entry, and the trend in pounds per week. Weeks start
Monday. Negative means losing.

The trend is a proper slope across every entry on file, not the gap between two
mornings, so it is steady and it is worth trusting.

**The traps:**
- `lb_per_week` is `null` when there are fewer than two entries. Say there is not
  enough logged yet. **Do not say zero**, and do not say the weight is holding
  steady — those are different claims and both would be false.
- `week_count: 1` is not a week. If you quote a weekly average built on one
  morning, say so in the same sentence.
- Weight moves a couple of pounds a day on water alone. The trend is the signal;
  the latest number is a data point. Prefer the trend when someone asks how it is
  going.

### `health.training_volume` — is each muscle getting enough work?

**Takes an optional window.** `{}` for the last 7 days, or `{"days": 14}`. One to
ninety.

**What comes back:** one row per muscle that had any work in the window — the
muscle's name, its `hard_sets`, and the `band` that count sits in. Muscles with no
sets are left out rather than reported as zero. `sets_with_no_muscle_data` counts
sets of lifts the library does not know, which are in the workout and in no row.

**The traps:**
- A set counts **once** for each muscle a lift works directly and **half** for each
  one it helps, so `hard_sets` can be a half number. It is not a count of sets
  performed and you must not present it as one. The reply says this in its `note`.
- Say the band as given. Do not turn it into a verdict of your own, and do not tell
  anybody to train more or less — that is a judgement, and rule 3 applies.
- A short window makes everything look thin. Say the window in the same sentence as
  the number.

### `health.last_lift` — when was this last trained, and with what?

**Takes the lift's name.** `{"exercise": "tricep pushdowns"}` — however he says it.
The door matches the name the way the app does, so a near-miss still finds the lift.

**What comes back:** `found`, and when it is true, the `date`, every set with its
weight and reps and whether it was a warm-up, and the `top_set` with an
`estimated_1rm_lb`.

**When `found` is false, say that plainly** — no finished session with working sets
of that lift. It does not mean he has never done it; it means nothing is on file.
Do not offer a number from a different lift.

**`estimated_1rm_lb` is a formula, not a lift he has done.** Say so every single
time you read it out. The reply carries that sentence; use it.

### `health.next_workout` — what is there to train, and what did it look like last time?

**Takes nothing.** `{}` — the person comes from your key.

**Nothing picks a workout.** `picks_one` is `false` and it is always false. The app
lists routines and he chooses; there is no rotation and no "next" anywhere in the
data. So this hands you the routines and what he lifted last time on each exercise,
and **you must not choose for him.** Offering "today is push day" would be inventing
a fact about his training and saying it with the app's authority.

**What comes back:** up to eight routines, each with its name and up to twelve
exercises. Each exercise carries its planned `sets` and `reps`, the date it was
`last_done`, and the `last_top_set` from that day.

**`last_done: null`** means that lift has no finished session on file. Say that
rather than passing over it — an exercise nobody has logged is often the useful
thing in this reply.

### `schedule.list_reminders` — what reminders are still coming?

**Takes an optional page.** `{}`, or `{"limit": 10}`, or `{"offset": 20}`. The
person comes from your key.

This is the one question on this door that is not about the household's own
figures. It lists the reminders the **write** door made, because that is where the
id of a reminder comes from — and without an id, nothing can cancel or change one.

**What comes back:** `total`, how many are still waiting; `shown`, how many are in
this reply; `offset`, where this page started; `more`, whether there are any left;
`next_offset`, the number to send to get the next page (or `null`); and
`reminders`, each with an `id`, its `message`, its `due_at`, the same moment as
Arizona words in `due_arizona`, how it `repeats`, where it came from in `source`,
and whether it is `overdue`.

**The traps:**
- **Only what is still coming.** A reminder that has already been delivered is not
  here, and neither is one that was cancelled. If somebody asks what they were
  reminded about yesterday, the answer is that this door does not keep that.
- **A repeating reminder shows the NEXT time it goes off,** not the time it was
  first set for. A daily reminder that has fired forty times shows tomorrow.
- **`overdue: true` means the delivery job is behind**, not that the reminder was
  cancelled or lost. It will still arrive. Say it that way round.
- **`overdue: null`** means the stored time could not be read. Say the reminder is
  there and that you cannot tell when it is for. Do not call it not-overdue.
- `due_arizona` is already in the household's own clock. Do not convert it.

**Saying it:** read the times, not the ids. An id is a long string of hex and
saying one out loud is noise — hold on to it for the write door instead.

---

---

## The finance questions Phase 2 added

Phase 1 answered the summary questions. These answer the detail ones, and two of them
are a reversal worth knowing about: **individual charges and search used to be
forbidden** and are not any more. He made that trade deliberately — the app shows him
those rows, and an assistant that cannot see a charge cannot answer "what was that $47
on Tuesday". The one part he did not trade away is the raw bank descriptor, and it is
still absent under every tool.

### `finance.categories`

**Takes nothing.** `{}`

**Read this before you write a category anywhere.** The write door refuses a category
id that is not on this list, and it refuses it because a made-up id writes a charge
that belongs to no budget line and shows on no bar.

**What comes back:** every category, with `kind` (income or expense) and
`on_a_budget_line`.

**`other` is the absence of a category, not a category.** Filing one charge there is
fine. Teaching a merchant rule to use it is refused, because that stops the app ever
trying on that merchant again.

### `finance.transaction`

**Takes an id.** `{"id": "…"}`

**What comes back:** one charge in full — amount, date, category, the merchant's
cleaned name, what it is attached to, and its flags. `applies_to` is the field worth
reading twice: a charge quietly attached to a bill is recorded as PAYING that bill.

### `finance.search_transactions`

**Every filter is optional.** `from`, `to`, `min_amount`, `max_amount`, `category_id`,
`merchant`, `kind`, `needs_review`, `still_processing`, `from_bank`, `unattached`,
`limit`.

**No window means the whole ledger, newest first.** The door does not quietly narrow
it to a recent month — so if you want a month, say the month, and then **say the
window you used** before you say any number.

**It tells you when there are more.** `found` is the honest count before the cap and
`more` is true when you are not seeing all of them. Never report `returned` as if it
were `found`.

**`merchant` matches the way the app's own labeller matches**, so "trader joes" finds
the charge however the bank spelled it.

### `finance.accounts`

**Takes nothing.** `{}`

**What comes back:** every account including the credit cards, each flagged
`is_credit`. On a cash account the balance is what can be spent; on a card it is what
is **owed**. Never add the two together.

**Not in it:** any card or account number.

### `finance.bills`

**Takes nothing**, or `{"include_off": true}` to see the switched-off rows too.

**What comes back:** every recurring row in full — cadence, due days, the window it is
alive in, and `planned_monthly`, which is what the plan actually prices it at. For a
variable bill that is the amount somebody recorded, else the rolling average of real
payments.

`live_today` is a separate fact from `active`: a bill paused until November is active
and dormant at the same time.

### `finance.bill_calendar`

**Takes a month**, or nothing for this month. `{"month": "2026-09"}`

**What comes back:** the month's bills on their DUE days, marked paid or not.
`paid_on` is when the payment actually landed, which can be in an earlier month.
`amount_is_an_estimate` means the figure is a rolling average, so do not say it as a
price.

### `finance.paid_bills`

**Takes a month**, or nothing for all of them.

**An empty list is the healthy answer.** A row exists here only where somebody set the
paid state by hand, against what the ledger says.

### `finance.merchant_rules`

**Takes nothing.** `{}`

**What comes back:** what the app has LEARNED about a merchant. A learned rule beats
every built-in rule, so a wrong one is permanent until it is changed. `bill` means the
charge pays that bill, `variable` means ordinary spending in a category, `skip` means
the feed drops the charge entirely.

### `finance.bank_status`

**Takes nothing.** `{}`

**Ask this when a balance looks wrong.** Every figure on the finance side comes from
the last good sync, and a connection that needs re-authorising makes those numbers
stale without making them look stale.

### `finance.bank_pending`

**Takes nothing.** `{}`

**What comes back:** charges the bank has taken but not posted. They are **not in the
ledger** — that is what stops them being counted twice when they post. The amount is
signed the way the bank reports it: negative is money going out.

### `system.changes`

**Takes nothing**, or `{"limit": 20, "undoable_only": true}`

**This is "what did you change?", and it is the question that makes the write door's
bargain honest.** Every change the write door makes is recorded here with the sentence
it said at the time and the token that reverses it.

`state` is one of four, and `means` says each one in plain words:

| state | what it means |
|---|---|
| `undoable` | it landed, and `system.undo` can put it back |
| `undone` | it landed and has since been put back |
| `abandoned` | it did **not** happen — the row had changed, so the door stopped |
| `pending` | the door stopped mid-call and **nobody knows** whether it landed |

**Never read `pending` as done, and never read it as not done.** Say that it needs
checking in the app.

---

## When a call is refused

Every refusal comes back with one plain sentence written to be said as it stands.
Say it. Do not dress it up, and do not fall back on a number from earlier in the
conversation.

The sentence is in `says`. The code below is in `error`, and it is the field to
branch on — there are exactly eight of them and there will never be one that is
not on this list. A test checks this table against the door's own source both
ways, so a code added to one and not the other fails the build.

| `error` | HTTP | What it means | What you do |
|---|---|---|---|
| `bad_request` | 400 | A date, a field, the body or the tool name was not understood. Nothing was read. | Fix it and call once more. If it fails again, say what you sent. |
| `unauthorized` | 401 | No key, the wrong key, or a key for a door this is not. Nothing was read. | Stop. Say the key was not recognised. **Never** try another key, another header, or another path. |
| `unknown_tool` | 404 | There is no such tool here. It is not switched off — it does not exist. | Say the door cannot do that. Do not try a similar-looking path. |
| `use_post` | 405 | You used something other than POST. Only `GET /openapi.json` is not a POST. | Send the same call as a POST. |
| `too_large` | 413 | The body was over 16 KB. It was not read. | Do not send it again. No question here needs a body that size. |
| `rate_limited` | 429 | 60 questions already this hour, per person. Nothing was read. | Wait for the hour to turn. Do not loop, and do not retry with a different window. Say plainly that the door is capped and it will work again shortly. |
| `ledger_unreadable` | 503 | The door could not read the whole ledger, so it refused to compute from part of it. | Say exactly that and give **no** number. This is the door protecting them, working as designed. |
| `failed` | 500 | Something broke inside the door working the answer out. | Say that it could not work the number out. Give no number. Try once, then stop. |

A refusal is never a reason to guess. The right answer to "I could not read the
ledger cleanly" is silence about the number, not a best effort.

---

## What does not exist

These are absent, not disabled. There is no endpoint, no flag, and no way to ask
nicely. If someone asks for one, say plainly that it cannot be done from here and
that the app can do it.

**Never, at any point, by anyone:**

- Move money. **No door in this system moves money**, and no tool anywhere pays a
  bill, transfers, or sends a payment. That is what makes a wrong write recoverable:
  the worst it can do is make a record wrong, and a record can be put back.
- The raw bank descriptor on a charge. The cleaned merchant name comes back from
  `finance.transaction`, `finance.search_transactions` and `finance.bank_pending`;
  what the bank literally wrote does not, under any tool. It is the one string in the
  ledger that nothing in the app has ever cleaned.
- Any card or account number.
- Touching the bank connection. Disconnecting one hard-deletes the accounts and their
  whole transaction history, and nothing can put real bank history back — so it takes
  a code he types in the app, not a message to you.
- Asking about the other person. Each key answers about its own owner.
- Writing anything. **This door has no write verb anywhere in it.** If you are asked
  to change something with the key you have, say plainly that you can only read.

**Reads that are planned but not built yet.** Do not attempt them and do not
approximate them from the tools above:

- the lowest the balance gets and the day it happens. `finance.forecast` answers the
  month-by-month projection now; the low point inside a cycle is a different figure and
  no tool returns it.
- how many days were logged — the streak
- a barcode looked up

**A payoff date, a debt-free month, a card-clear month, or months remaining.** Not
planned — refused. `finance.debts` says so in its own reply and `finance.forecast`
holds back the card-clear month it actually computes. An invented payoff date is the
single most tempting wrong number in this whole system: a balance and a rate are all it
takes to make one up, and you have both.

**And the one worth naming on its own: "what can I spend?"** The household holds a
deliberate floor under the cash — a paycheque amount that is not to be dipped into —
and **this door does not know it**. Nothing here subtracts it, so `finance.position` is
the bank's number and not a spendable one, `finance.budget_status` is one envelope and
not the whole picture, and `finance.firepower` is money earmarked for the debt rather
than money free to spend — it is the figure most likely to be mistaken for an answer
here. Do not put any of them together and answer "you can spend X": say the figures you
were given, say the floor is in none of them, and say the app is where that question is
answered.

**What changed in Phase 2, so you do not hold an old rule.** Individual charges and
search used to be forbidden here, in these words: "returning individual ledger rows
turns a chat into a copy of the ledger". He reversed that deliberately. What he did
not reverse is the bank descriptor above.

**Writes are a separate door with a separate key.** You are holding the read key,
and this door has no write verb anywhere in it. If you are asked to log or change
anything with the key you have, say plainly that you can only read.

For when somebody asks what the other door does: it can change everything the app can
change about the money side — add and delete a hand-entered charge, categorise and split
one, attach one to a bill or release it, record a bill as paid, edit or turn off a bill,
teach a merchant rule, set an account balance, add a debt — and the health side: log and
correct a weigh-in, a meal, a workout and its sets. **Every one of those records what it
replaced and hands back a token**, and `system.undo` on that door puts it back.
`system.changes` on THIS door is how you see what it has done, and `memory.*` is where
what you learn about the household is kept.

It also writes a weigh-in, one of the household's saved meals by name, a reminder for a
given time, a cancel and a change to one.

**One write is still QUEUED, and only one: free-form food.** Queued means that door
writes the request down and **changes nothing** — and today it stays that way, because
the app has no screen for these rows yet, so nothing applies one and it clears itself
after a day. If somebody asks for that one, say it can be written down but it will not
take effect, and that the app is where the change actually gets made.

(Phase 1 had four queued writes. The other three are direct with an undo now, and that
was the right way round: nothing in the app ever read the queue, so the three careful
tools were the three that did nothing.)

---

## Reminders, across both doors

Reminders are the one thing that needs both doors in one breath, so they are written
up together here rather than half in each place.

**The shape of it.** `schedule.remind` on the write door makes one. This door's
`schedule.list_reminders` is the only place an **id** comes from.
`schedule.cancel_reminder` and `schedule.update_reminder` on the write door need
that id. So the order is always: list, then act on the one you were told about.
Never make up an id, and never act on one you remember from earlier in the
conversation — list again.

**There is no reminders screen in the app.** Nothing in Homebase shows this list or
edits it. That is unusual for this bridge, where the answer to almost everything is
"open the app", and it cuts the other way here: **for a wrong reminder, these tools
are the only fix.** So do not tell somebody to change it in the app. Offer to change
it.

**What a repeat can be — say this plainly rather than storing something close:**

- Only once, daily and weekly exist. There is no monthly, no yearly, no every-other-day, no twice a day, and no hourly.
- A weekly reminder repeats on the weekday of the time it was set for. Two different weekdays is two reminders.
- There is no end date and no count. A daily reminder runs until somebody cancels it, and it takes up one of the waiting slots the whole time.
- A repeating reminder more than 12 hours late is skipped for that slot and moves on to the next one, so an outage does not empty a night onto a lock screen at once.

If somebody asks for one of the shapes that does not exist, **say so and offer the
nearest thing you can actually build**, naming what is different about it. "I can do
it every week on a Tuesday, but not Tuesdays and Thursdays — that would be two
reminders" is a true answer. Storing a weekly reminder when somebody said monthly is
not: it would fire four times too often, for years, and nobody would look at a
screen to catch it.

#### `schedule.cancel_reminder` — stop one that has not gone off

**Takes `reminder_id`.** Stops it, whoever asked for it originally, as long as it is
on **your** list.

It is not a delete. The row stays, marked cancelled, so there is a record that it
was stopped. What changes is that it will not arrive. A repeating reminder is
stopped **for good** — there is no "skip just tomorrow", and the reply says so.

**It refuses, and each refusal means something different:**
- *"There is no reminder with that id on your list."* — either there is no such
  reminder, or it is the other person's. You are not told which, and you should not
  guess: say that you cannot find it on their list.
- *"That reminder already went out at …"* — it is on a phone already. **Do not say
  it was cancelled.** Say it already went out, and say when.
- *"That reminder was already cancelled …"* — somebody got there first.
- *"That reminder changed while I was cancelling it — it may have just gone out."* —
  the delivery job was inside the same row at the same second. Nothing was changed.
  List them again before saying anything else.

#### `schedule.update_reminder` — change the time, the words, or how often

**Takes `reminder_id`, and at least one of `at`, `message`, `repeats`.** Same rules
as making a new one: the time must be at least a minute out and no more than a year
ahead, and the message is capped at what fits on a lock screen and has anything
link-shaped taken out of it. It refuses for the same reasons cancel does.

The reply's `changed` lists what actually moved. Read that back rather than
repeating what was asked for — they are not always the same thing.

## One write per thing, across two people

Both of them have their own key, and their assistants do not know about each other.
So the write door keeps one more guard you should expect to meet: **if the same
write, with the same numbers, already came through either key in the last ten
minutes, it is refused** and the reply names who did it — "Xinyan already did that
four minutes ago".

Say that sentence as it stands. It is usually the most useful thing in the
conversation: it means the thing is done, and by whom.

If they really do want it twice — a second weigh-in, two separate charges that
happen to be the same amount — send the identical call again with
`do_it_anyway: true`. Every tool on the write door accepts that field, it changes
nothing about what gets written, and it is recorded. **Do not reach for it by
reflex.** Ask first, unless they have already said "yes, again".

## Two habits that matter more than the rest

**Say the date and the window.** "This pay cycle, Mar 31 to Apr 14" is a different
claim from "this month", and the difference is what makes a number checkable.

**When the door and your memory disagree, the door is right.** Do not remember
last hour's balance. Ask again.
