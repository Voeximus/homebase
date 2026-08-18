# Homebase — Handover Brief for an Incoming Assistant

> **Read this before touching anything.** It is the entry point. Everything else
> in `docs/` is either a historical log (`HANDOFF.md`) or superseded (`STATUS.md`).
>
> **Written 2026-08-17.** The *rules* here are durable. The *numbers* are a
> snapshot — re-verify them live before advising on money.

---

## 0. What you are taking over

Homebase is a personal finance + health PWA that **Gino Cirino** built for himself
and his partner **Xinyan Li**. It is not a product. It has two users, it runs their
actual household, and its numbers get used for real decisions — whether a car is
affordable, whether a $3,005 filing fee breaks next month's rent.

Your job is not "maintain a React app." It is **keep the model of their money
honest, and tell Gino the truth about it.** The app is the instrument; the
accounting is the work.

Two things follow, and they are the reason this file exists:

1. **A wrong number is worse than a missing feature.** This app has been
   *confidently wrong* several times — double-counted charges, a yearly membership
   billing monthly, a stale estimate projecting $130 for a $93 bill. Every one
   looked fine on screen. Treat numbers as guilty until traced to a source.
2. **The important decisions are not in the schema.** They are conventions settled
   over months. **Section 5 is those conventions.** If you read one section, read
   that one — nothing in the code tells you *why* biweekly income is multiplied by
   2 instead of 26/12, and "fixing" it silently destroys a deliberate
   conservatism.

---

## 1. Access checklist — what Gino must hand over

Nothing secret is stored in this repo, by design.

| What | Where | Notes |
|---|---|---|
| **GitHub repo** | `github.com/Voeximus/homebase` | Push to `main` = deploy. Needs collaborator access. |
| **Supabase project** | ref `ganzefaciiyibselizqi` (free tier) | The database. Dashboard login. |
| **Supabase PAT** | supabase.com, under account/profile settings → Access Tokens. Starts `sbp_`. The dashboard's navigation moves — search its settings for "access token" rather than following a fixed path. | Needed to run SQL outside the dashboard, and by CI to deploy edge functions (`SUPABASE_ACCESS_TOKEN`). **Never commit it.** |
| **`.env.local`** | repo root, gitignored | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. |
| **GitHub Actions secrets** | repo → Settings → Secrets | Same two, plus `ANNOUNCE_TOKEN`. Build fails without them. |
| **Plaid credentials** | Supabase edge function secrets | Live Bank of America feed. **Production keys — there is no sandbox.** |
| **App logins** | Gino + Xinyan's accounts | Email+password. Signups should stay disabled; ask before creating an account. |

If you cannot hold a PAT across sessions, expect to be handed it each time — or
have Gino run the snapshot script in §2 and paste the output.

---

## 2. How to look at the data

### Fast path — snapshot script

```bash
SUPABASE_PAT=your_token_here node scripts/snapshot.mjs
```

Dumps every finance table to `docs/snapshots/` as timestamped JSON, and prints a
summary. Run it at the start of any session where money is in question. Snapshots
are gitignored — they contain real balances.

### Direct path — Supabase Management API

DDL and arbitrary SQL do **not** work through the publishable key. Use the
Management API with the PAT. Every migration and data correction in this project
went through this endpoint:

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/ganzefaciiyibselizqi/database/query" -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" -d '{"query":"select name, amount, cadence, due_days, active from recurring order by name"}'
```

It returns JSON and will happily run `alter table`.

> ⚠️ **A write can report an internal error and still have succeeded.** That has
> happened here and left a duplicate row behind. **Always `select` after a
> mutation.** Do not trust the write's own response.

### The app's own view

`npm run dev`, then open the preview. Logging in blocks network-idle because of
the realtime websocket, so screenshots frequently time out — read the DOM instead.

---

## 3. The household — snapshot as of 2026-08-17

### People

- **Gino** — night shift at "Treasure of Tech", variable hourly, modeled at an
  **$1,800/check floor**, paid **semi-monthly** (15th + month end) → $3,600/mo.
  Starting at ASU. Owns Knotted Studios LLC.
- **Xinyan** — PhD student at ASU (Data Science, Analytics & Engineering), funded
  as a 50% FTE Graduate Research Associate. **$1,346.40 gross biweekly, ~$1,187.42
  net**, 26 pay periods/yr. Tuition fully remitted, health insurance covered. The
  appointment is limited-term and renews per semester — this is a real fragility,
  not a formality.

**Combined modeled income $5,974.84/mo** — deliberately conservative, see Rule 1.

### The car (new, 2026-08-16)

2012 Honda Civic EX, 173,520 mi. Cash price $6,800, $8,418.40 out the door,
$1,250 down. Financed **48 months at $232.67**, first payment **2026-09-30**.
Total sale price $12,418.16; finance charge $3,999.76. Xinyan primary buyer, Gino
co-buyer, both titled owners.

A $175 pre-purchase inspection found exactly one Poor item: **the right rear shock
has leaked out** (~$250–400 to replace, not yet done). A minor oil seep is being
monitored.

### Insurance

GEICO. **Xinyan is the named insured.** Adding the Civic took the 6-month premium
from $639.42 to $1,743.55. Remaining installments this term: $295.29 (Sept),
$363.30 (Oct 31), $363.39 (Nov 30) = $1,021.98. Nothing in Dec/Jan. New term from
**Feb 2027 at ~$290.59/mo**.

> ⚠️ **Known simplification:** those three uneven installments are stored as one
> row at their **average, $340.66**. Sept–Nov totals are off by up to ±$23. Fix it
> if precision matters in those months.

> ⚠️ **Unconfirmed:** whether Gino is listed as a **driver** on the policy. He is
> the daily driver on a policy where Xinyan is the named insured. If he is not
> listed, an insurer can dispute a claim. Confirm this early.

### The monthly shape

| Month | Bills | Note |
|---|---|---|
| Aug 2026 | ~$2,456 | no car yet — both car lines start Sept 30 |
| Sep 2026 | ~$3,029 | car arrives |
| Nov 2026 | ~$3,307 | **tightest month**, ~$447 surplus |
| Dec–Jan | ~$2,967 | insurance term gap |
| Feb 2027+ | ~$3,106 | new insurance term |

Lowest projected cash: **$644.59 on 2026-09-03**. Never negative. Recovers to
roughly $5,448 by end of November.

### Recurring rows worth knowing

```
Rent                            $1,732.16   due 1
Mom (support)                   $300        paused, restarts 2026-11-01
Cherry (dental plan)            $151.72     ends 2027-01-31
ALEKS (math subscription)       $21.57      ends 2026-10-14
Verizon                         $93         due 24   (known_amount override)
Electric (SRP)                  $100        (known_amount override — clear once a winter bill posts)
Claude Max                      inactive
Car payment (Civic)             $232.67     due 30, starts 2026-09-30
Car insurance (current term)    $340.66     due 30, 2026-09-30 → 2026-11-30
Car insurance (both cars)       $290.59     due 1,  starts 2027-02-01
Xinyan paycheck                 biweekly, anchor 2026-08-07
```

---

## 4. The data model

**`src/types.ts` is the real reference** — it is unusually well commented. What is
non-obvious:

**`recurring`** — every bill, paycheck, and internal transfer.
- `direction`: `in` | `out` | `transfer`. Transfers move money between their own
  accounts and are excluded from income/bill math.
- `cadence`: weekly → yearly. **`due_days` alone lies for cadences longer than a
  month** — see Rule 4.
- `anchor_date` — for quarterly/semiannual/yearly, *which* month it fires. For
  biweekly, a date it is known to have landed, so real dates can be stepped.
- `starts_on` / `ends_on` — a bill's lifetime. This is how a support payment
  paused until November turns itself back on with nobody remembering.
- `known_amount` — for a variable bill, the amount you have actually read. Beats
  the rolling-average estimator. Clear it to hand the estimate back.
- `linked_debt_id` — a card-payment bill. Clear the debt and the bill stops
  rendering; charge the card again and it returns. Self-correcting both ways.

**`transactions`** — the ledger, one row per money event.
- `raw_description` is the untouched bank descriptor. `description` is Plaid's
  cleaned merchant name, which is **lossy** — the raw string is the only reason a
  fuel pump is distinguishable from the store at the same brand.
- `applies_to` (JSON) links one money event to a bill, debt, goal, or transfer.
  This is the join that lets bills mark themselves paid.
- `splits` — one cash event allocated across several budget categories.

**`debts`**, **`accounts`**, **`savings_goals`**, **`paid_bills`**,
**`merchant_rules`**, **`push_subscriptions`** — see `src/types.ts` and
`supabase/schema_v*.sql`, numbered in application order (v1 → v27).

---

## 5. The rules — conventions you must not "fix"

These are decisions, not accidents. Each one was argued and settled. Changing any
of them changes what the household believes about its own money.

### Rule 1 — Biweekly income is multiplied by **2**, not 26/12
`CADENCE_TO_MONTHLY.biweekly = 2` in `src/lib/household.ts`.

This looks like a bug. It is not. 26/12 = 2.167 would be arithmetically correct
and **the budget deliberately refuses it.** The plan assumes two checks a month;
the ~2 months a year that carry a third check are treated as *upside*, not as
budgeted income. Gino chose this. It understates annual income by roughly $2,375
on purpose.

> I called this a bug once and was wrong. Don't repeat it.

### Rule 2 — The budget grades per **pay cycle**; bills stay **calendar-monthly**
Money lands on the 15th and the last day. Rent is due on the 1st. So variable
spending is graded on the cycle that funds it — a charge on the evening of the
31st belongs to the run that check pays for, not to the month that happens to
contain it. Bills are *not* re-scoped, because rent really is due on the 1st.

`PAY_DAYS = [15, 31]` where 31 is a month-end sentinel resolving to the real last
day. See `payCycleFor()` in `src/lib/plan.ts`.

### Rule 3 — A variable bill projects from **actuals**, not its stored amount
`billExpected()` averages the last 3 real payments tagged to that bill. The stored
`amount` is only a fallback until a real payment is seen. This is why bills track
reality instead of the number someone typed in six months ago.

The override is `known_amount` — set it when you have *read* the bill and know the
estimator is wrong. Verizon projected $130 because a $209 catch-up payment covering
two months was polluting the average; the true figure was $93.

### Rule 4 — `due_days` is not a schedule for anything longer than monthly
A yearly membership with `due_days: [16]` and `cadence: yearly` fires **once**, in
its `anchor_date` month. Read `due_days` alone and you will bill it twelve times.
This exact bug shipped, was fixed, and then **I reproduced it months later** by
reading `due_days: [16]` and ignoring `cadence: yearly, anchor_date: 2026-06-16`
sitting right next to it.

`firesInMonth()` in `src/lib/schedule.ts` is the gate. Always go through it.

### Rule 5 — Periodic bills land at **full charge in their month**, never amortized
A semiannual $639 premium is a $639 event in February — not $106.50 across twelve
months. `monthlyAmount()` gives the budget-average view; the *calendar* must show
the real lump. Both views are correct for different questions; do not let one leak
into the other.

### Rule 6 — Per-payment amounts divide by the **full** day count, then filter
When a bill has multiple due days and a start/end window, compute
`amount / allDays.length` **first**, then drop out-of-window days. Dividing by the
survivors doubles the remaining payment in a month the bill starts or stops
partway. There is a fixture that fails on the naive version. Leave it there.

### Rule 7 — A bill lives on its **due day**, even when paid early
Paying the July 17 bill on June 30 still renders on July 17, labeled "paid Jun 30."
The bill does not move. This keeps early payments on the right cycle and makes
Plaid's posting lag harmless. Paid status is month-scoped via
`applies_to.month_key`, never a `day <= today` heuristic.

### Rule 8 — Card-payment bills are gated on the **live debt balance**
Not on an `active` flag. Balance hits zero, the bill stops rendering; charge the
card again and it returns. Nothing to remember to clean up, and it self-corrects
in both directions.

### Rule 9 — Some categories are **outside** the budget, deliberately
Three categories are on **no** budget line, so `inAnyLine()` returns false and they
are never graded against the envelope:

- **`interest`** — never leaves checking. The bank folds it into the card balance,
  which the debt total already reads. Grading it too would double-count it. It is
  the one that does **not** appear in `OUTSIDE_BUDGET_CASH_CATS`.
- **`electronics`** — Gino's original carve-out: "outside the budget, but it still
  takes from what can go at debt."
- **`car`** — the cost of *owning* the vehicle: down payment, pre-purchase
  inspection, registration/title, repairs. One-time capital costs of a decision
  already made. Grading a $1,250 down payment would blow a month's envelope to no
  purpose; ignoring it entirely would overstate debt firepower. So it is ungraded
  but still subtracted from firepower.

**Gas is not one of these.** Filling the tank is `transport`, ongoing consumption,
graded every cycle. Owning ≠ driving.

`car` is assigned **by hand on purpose** — the categorizer does not auto-route to
it. If it did, every oil change would quietly escape the budget. Do not add
merchant patterns for it without thinking that through.

### Rule 10 — The bank feed is the source of truth; manual rows are placeholders
A manual "already paid" note plus the real bank charge = the same money counted
twice. That happened, for $791.14. The real charge now marks the bill paid on its
own, and seed placeholders get cleaned up when the feed covers the same
bill+month. **Never hand-enter something the feed will also deliver.**

### Rule 11 — Edge functions do **not** share the app's `src/lib`
`supabase/functions/*` are separate deployments carrying their own copies of the
scheduling rules. `cron-notify` once drifted two schema versions behind and
started pinging a semiannual premium monthly while asking a paid-off card for its
minimum — with every deploy still reporting green.

**Deployment is now automatic** (as of 2026-08-17): the `functions` job in
`.github/workflows/deploy.yml` deploys all five whenever anything under
`supabase/functions/` or `supabase/config.toml` changes. It needs the
`SUPABASE_ACCESS_TOKEN` repo secret; without it the job raises a loud warning
annotation rather than failing the run or passing silently.

**The duplication problem is NOT solved.** Automatic deployment ships whatever the
copies say — it does not keep them in agreement. Any model rule you change in
`src/lib` still has to be ported by hand:

- `billCycleFor()` in `src/lib/schedule.ts` ↔ `billAppliesTo` in
  `supabase/functions/plaid/index.ts`
- `firesInMonth()` and the linked-debt gate ↔ `cron-notify`
- `src/lib/categorize.ts` + `categorizeData.ts` ↔ `supabase/functions/_shared/` —
  these two **are** guarded: `npm run build` fails on drift.

### Rule 11a — `verify_jwt` is version-controlled, not a dashboard setting
`supabase/config.toml` declares `verify_jwt = false` for `announce-update`,
`plaid-webhook` and `cron-notify`. They must stay public because their callers
(GitHub Actions, Plaid, pg_cron) cannot present a Supabase JWT; each one instead
checks its own shared secret from the query string and fails closed.

That setting used to live only in the dashboard, which meant any CLI deploy could
silently reset it — turning release notifications into a 401 that nothing in the
app would surface. Do not remove those entries. `notify` and `plaid` are correctly
absent: they are called from the app with a real user session.

### Rule 12 — Never claim something is fixed from your own probe
Gino's standing instruction, and it is correct here. Headless checks and
incremental typechecks give false greens. The user test is the gate. When your
probe and his experience disagree, **he is right.**

---

## 6. Codebase map

```
src/
  types.ts                 the domain model — best-commented file, start here
  lib/
    plan.ts                budget envelope, pay cycles, payoff schedule, billExpected()
    schedule.ts            the calendar engine — firesInMonth, biweeklyDaysIn, inWindow
    forecast.ts            12-month projection built on monthlySchedule (can't drift from it)
    recurring.ts           monthlyAmount, account flows, cash vs credit
    household.ts           CADENCE_TO_MONTHLY + seed data
    categorize.ts          merchant → category, with learned rules
    changelog.ts           releases; the TOP entry defines APP_VERSION
    plaidClient.ts / push.ts / supabase.ts
  store/
    FinanceStore.tsx       Supabase-backed, realtime, optimistic writes; snake→camel mapping
  views/redesign/          the 5 tabs: Home, Activity, Insights, Bills, Forecast
supabase/
  schema_v*.sql            migrations in order, v1 → v27
  functions/               plaid, plaid-webhook, cron-notify, notify, announce-update
```

The five tabs are `TabNav.tsx`; the forecast dials are `ForecastTab.tsx`.

---

## 7. Shipping

**Deploy:** push to `main`. `.github/workflows/deploy.yml` builds and publishes to
GitHub Pages.

**Release:** add a new entry at the **top** of `src/lib/changelog.ts` with a fresh
`version`. `APP_VERSION` derives from it. The deploy workflow compares the top
version against the previous commit's and — only if it changed — fires a push
notification to both phones. Ordinary commits stay quiet.

Write changelog notes in **plain language about what the user experienced**, not
what the code does. Existing entries are the model: "Verizon reads $93 instead of
$130. The app was averaging in a catch-up payment that covered two months."

**Edge functions do not deploy on push.** Redeploy them separately whenever you
change one.

**Build:** `npm run build` runs `tsc -b`, a categorizer sync check, then `vite
build`. Incremental typecheck can give a false green — when it matters, do a clean
build.

---

## 8. Trap catalog — everything that has actually gone wrong

| Trap | What happened | Guard |
|---|---|---|
| **Yearly billed monthly** | Sam's Club membership rendered as a bill every month | Read `cadence` + `anchor_date`, never `due_days` alone |
| **Double-counted payment** | Manual "already paid" row + real bank charge = $791.14 of phantom spending | Let the feed mark bills paid |
| **Stale variable estimate** | Verizon projected $130 vs a real $93; electric $83 vs $100 | `known_amount` when you've read the bill |
| **Edge function drift** | `cron-notify` two schema versions behind; semiannual bill pinged monthly | Deploy is automatic now; porting rules by hand is still on you |
| **Deploy that deployed nothing** | A `git commit && git push` one-liner was run from the wrong directory, so the `&&` chain died at `git add`. Actions never ran, and "the deploy didn't work" looked like a Supabase problem | Check `git log origin/main -1` before blaming the pipeline |
| **Push silently dead** | `push_subscriptions` was empty for 44 nights while cron reported success | `syncPushSubscription()` re-asserts on every open |
| **Update button no-op** | Two distinct silent failures, identical symptom | Button now always ends in cache-clear + unregister + reload |
| **Write "failed" but succeeded** | Left a duplicate insurance row | `select` after every mutation |
| **Fuel vs groceries** | Same merchant, both categories; $143 landed in the wrong line | `raw_description`, and ask when ambiguous |
| **Slider snap** | Default 716 on a step-25 slider jumped to 725 on first touch | Match default to step, or `step=1` |
| **False green typecheck** | Incremental `tsc -b` passed on code that failed a clean build | Clean build before claiming shipped |

**No Plaid sandbox.** The feed is production and touches real Bank of America
accounts. Do not experiment against it.

---

## 9. Open threads

- [ ] **Confirm Gino is a listed driver** on the GEICO policy.
- [ ] **Lienholder / loss payee** on the auto policy — deliberately deferred until
      the loan is assigned and the welcome letter names the actual bank. The
      creditor is still the dealer (Courtesy).
- [ ] **Right rear shock** replacement, ~$250–400.
- [ ] **Clear the electric `known_amount`** once a real winter bill posts.
- [ ] **Split the insurance row** into its three real installments if Sept–Nov
      precision matters.
- [ ] **ASU's actual monthly charge** for Gino — still unknown, not yet a bill.
- [ ] **Desert Financial application** result.
- [ ] **Immigration filing** — I-130/I-485/I-765/I-131, ~$3,005. Paying it in
      September breaks October rent; **November 2026 is the first safe window.**
      Gino is a US citizen; Xinyan is a funded PhD student in nonimmigrant status.
      There is a separate research brief for this — ask him for it.

---

## 10. How Gino works

Worth knowing, because it changes how you should report.

- **Every message is transcribed speech.** Ellipses, restarts, trail-offs. Read
  the intent, not the surface. Take the charitable reading first.
- **He wants pushback, not agreement.** State plainly what is verified versus
  untested. He undersells his own work; don't inflate it either.
- **Plain language, no jargon.** Standing instruction. Jargon-dense reports once
  made him build a wrong model of what was happening.
- **Say less.** One load-bearing point per message. Over-supply is the documented
  failure mode with him.
- **He acts faster than you model.** He will have already updated the address,
  already signed with the insurer, already bought the car. Ask what's true now
  before advising on what to do next.
- **Visual over textual** for anything structural — he thinks in images.
- **Do the reconciliation for him.** Bringing the data current yourself, rather
  than asking him to re-explain it, is the single most valuable habit here.
