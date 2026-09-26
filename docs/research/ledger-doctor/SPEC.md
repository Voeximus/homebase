# Worth a look — the review layer, and one new exact check

**Status:** design decided, nothing built.
**Written:** 2026-09-26, against snapshot `docs/snapshots/homebase-2026-09-26T22-04-42-456Z.json`.
**Why it exists:** a weekly audit by hand found six problems the app's seven self-checks could not see. Gino: *"the automatic ability of the app to be able to self organize the inputs is important across the entire finance mode."*

---

## 0. The one thing this document decides

There are **two different kinds of wrong**, and the app has only ever had words for the first.

| | A failed check | A thing worth a look |
|---|---|---|
| Means | **The app disagrees with itself.** Two of its own numbers describe the same money differently. | **The app noticed something about your money.** Every number is self-consistent; the model may be out of date. |
| Truth | Certain. A defect, never a judgement call. | A guess with evidence. Can be wrong. |
| Count in a healthy app | Exactly zero. | Can be more than zero and still be fine. |
| Lives in | `src/lib/selfAudit.ts` — unchanged rules | `src/lib/ledgerReview.ts` — new file |
| Shown as | red, in Profile, no buttons | amber, in Activity, one tap to fix |
| Wording | "did not add up" | "worth a look" |

Everything below follows from keeping those two apart. `selfAudit.ts` promises the user, in its own closing paragraph, that *"anything other than a perfect match is a real mistake, not a rounding difference, which is why there is no 'maybe' here."* Nothing with a threshold in it may render next to that sentence.

**Name.** Not "ledger doctor" — doctor implies illness and diagnosis, which is exactly the flavour we are trying to keep out of it. User-facing name: **Worth a look**. Code: `ledgerReview.ts`, `Suggestion`, `reviewLedger()`.

---

## PART A — the new exact check

### A.1 What was kept: **one** check. `links-point-somewhere`.

> Every link a ledger row carries must point at a row that still exists.

A transaction's `appliesTo` names other objects by id: `recurringId`, `debtId`, `goalId`, `settledByTxnId`. Delete the object and the id stays behind. Nothing in the app ever checks, and both existing checks that read bill links open with `if (!rec) continue;` — they skip a broken link silently (`selfAudit.ts:365`, `selfAudit.ts:417`).

**Why it is exact.** It is not arithmetic and has no tolerance. Either the id resolves or it does not. There is no ledger in which pointing at a row that does not exist is correct. It is the same shape as check 3 (`no-orphan-categories`) — set membership, not comparison — and it has the same consequence: **money on no screen.** A row carrying any `appliesTo` is excluded from the budget partition (`plan.ts:639`, `!t.appliesTo`) and from every bill cycle (`!rec` → skip), so a dangling link is spending that counts against no budget line, settles no bill, and shows a blank name wherever the bill name is resolved.

**It fires on the live ledger today.** Four rows, **$165.00**, all pointing at recurring row `b04df2be-824e-4e71-b332-b6ee07c94944`, which no longer exists:

```
2026-06-15   $85.00   "Mobile Banking payment to CRD 6813 …"   category: other
2026-07-06   $35.00   "Mobile Banking payment to CRD 6813 …"   category: other
2026-08-25   $25.00   "Mobile Banking payment to CRD 6813 …"   category: bills
2026-09-16   $20.00   "Mobile Banking payment to CRD 6813 …"   category: bills
                      all four: applies_to.kind = "bill",
                      applies_to.recurringId = b04df2be-… (deleted),
                      monthKeys 2026-06, 2026-07, 2026-09, 2026-10
```

That row was the **phantom $35/mo card-payment bill from finding 4**, deleted by hand earlier today. Deleting the bill left its four payments dangling. **The hand-repair created a new silent hole while closing an old one** — which is the argument for this whole piece of work, made by the data.

**The rule in code.**

```
For every transaction t with t.appliesTo:
  if t.appliesTo.recurringId    and no recurring row has that id   -> broken
  if t.appliesTo.debtId         and no debt has that id            -> broken
  if t.appliesTo.goalId         and no goal has that id            -> broken
  if t.appliesTo.settledByTxnId and no transaction has that id     -> broken
Also, for completeness of the same idea, on the model rows:
  if recurring.linkedDebtId     and no debt has that id            -> broken
  if transaction.accountId      and no account has that id         -> broken
count of broken links must be 0
```

`accountId` and `recurring.linkedDebtId` are in scope because they fail the same way (a payment attributed to an account that is gone). Both are zero today; including them costs nothing and closes the family.

**The check's shape, matching the file's conventions** (`id`, `question`, `status`, `detail`, no `a`/`b` since it is not a comparison):

- `id`: `links-point-somewhere`
- `question`: `"Does every charge still point at something real?"`
- pass: `"All {n} links in the ledger point at a bill, debt, goal or account that exists."`
- fail: `"{n} charges point at something that was deleted, so ${total} of real spending counts against no budget and settles no bill: {date} {description} (${amount}) …"`

**What the user does about it.** The exact panel has no buttons and keeps none. The failure line ends with a pointer: *"Worth a look has a one-tap fix for this."* The fix is `unlinkFromBill(id)` — see §D.1.

**One consequence to expect.** `tests/live-selfaudit.test.ts` asserts the live household passes everything. With this check added, that test **fails until those four rows are repaired** — which is the check working, not a broken test. The test is `describe.skipIf(!PAT)`, so `npx vitest run` stays green offline; only a deliberate `SUPABASE_PAT=… vitest run tests/live-selfaudit.test.ts` sees it.

---

### A.2 What was rejected, and the counter-example that killed each

The task named the **Cherry double-count as the motivating case for a new exact check.** Traced properly, it does not survive the bar. Here is the honest accounting.

**Rejected 1 — "a manual 'already paid' marker must not coexist with a real bank row for the same obligation."**

This is the narrowest true form of the Cherry case, and it is nearly exact. What it needs in order not to fire on a correct ledger is:
1. a **date-to-cycle mapping** for the bank row, because a `kind:"debt"` row carries no `monthKey` — the only mapping available is `billCycleFor`, whose window is `GRACE_MS = 7 * 86400000` (`schedule.ts:227`); and
2. an **amount match**, to avoid firing when the bank row is a genuine extra payment toward the same debt inside the same cycle (paying Cherry's instalment in cash *and* putting $50 against the principal by card).

Point 1 imports a tuned constant — seven days, chosen to make early payments roll forward — into a file whose whole claim is "there are no thresholds to tune." Point 2 is defensible but not definitional: two equal payments to one instalment loan inside one cycle is unusual, not impossible. **Two judgement-shaped pieces means it is a suggestion, not a check.** It becomes suggestion **W5b** with its thresholds stated out loud, which is a more honest place for it.

Note also what the existing check 7 (`one-payment-per-cycle`) already covers: two `kind:"bill"` rows on one cycle. The Cherry duplicate escaped it because the two rows claimed **different kinds** — the bank row claimed the debt, the manual row claimed the bill. That asymmetry is the whole defect and it cannot be seen without a date window.

**Rejected 2 — "an active out-bill linked to a debt at $0 is a phantom."**

Counter-example from the live data: `Card payment (…4728)` → debt `3d2728db` (balance $3,904.83). Pay that card to zero and the debt reads $0 for as long as the balance stays there — and the recurring row is still **correct**, because the card will be used again next month. `schedule.ts:164-167` already handles this by gating the calendar on the live balance *"so it self-corrects BOTH ways — charge the card again and the bill comes back on its own."* A check that fires the month you pay off your card is a check that trains you to ignore it. Becomes suggestion **W2**, scoped to rows with no `linkedDebtId` (where the $0 test does not apply at all) and to instalment debts.

**Rejected 3 — reimbursable symmetry ("one credit settles at most one reimbursable").**

Counter-example, live: on 2026-09-02 a $40 and a $120 front were both repaid by **one $160 credit**. That is a correct household event the model cannot express (`FinanceStore.tsx:1117` lets a credit be claimed once through the app; the second link was written by hand). A one-to-one check reports a real, correctly-recorded event as a defect. Only the **dangling-reference half** is exact, and it is already inside A.1 (`settledByTxnId` must resolve). Live data has two reimbursables whose credits carry no back-link (2026-09-15 $120, 2026-08-19 $50) — asymmetric, and both fine.

**Rejected 4 — "a bill's cycle is due and nothing matches it" (finding 3, the missing $120 Zelle).**

Already rejected in the file's own header (`selfAudit.ts:48-50`): the app has no independent second source for cash. The bank balance **is** the anchor and it is set from the bank's own number, not derived from the ledger, so there is no quantity that goes non-zero when a bank row is absent. Becomes suggestion **W4**.

**Rejected 5 — amount drift, unmodelled subscription.**

Tolerances by construction. Variable bills are already excluded from checks 1 and 6 *because* the modelled figure is an estimate by design (`selfAudit.ts:342-344`). Suggestions **W1** and **W3**.

**A note for the header comment.** When `links-point-somewhere` is added, extend the rejected list in `selfAudit.ts:40-50` with rejections 1, 2 and 3 above, in the same voice. That list is the file's memory of its own bar; the Cherry case is the best entry it will ever have, because it is the one that was *nearly* exact.

---

## PART B — Worth a look

### B.0 One engine, not six heuristics

Six separate heuristics would drift apart the way the five cycle-key implementations did. All six findings are the **same operation**: match the modelled rows against the real charges, then look at what did not pair up.

```
left  = the model:  active recurring rows, expanded into cycles
right = reality:    posted ledger rows

  paired, amounts agree        -> nothing to say
  paired, amounts disagree     -> W1  amount drift
  left-over on the LEFT        -> W2  phantom bill        (no charge for 3 cycles)
                                 W4  missing charge      (this cycle only, after paid ones)
  left-over on the RIGHT       -> W3  unmodelled repeat   (same charge, 3+ months)
                                 W7  charge that matches a bill you already model
  two on the RIGHT, one obligation -> W5  possible duplicate
  income row that fired once only   -> W6  one-off income that landed
```

One pass, one module, one result type. `reviewLedger(data, now)` is pure — no I/O, no clock beyond `now` — exactly like `selfAudit`.

### B.1 The shared vocabulary

```ts
export type SuggestionKind =
  | "drift" | "phantom" | "unmodelled" | "missing" | "duplicate" | "income-landed" | "unlinked";

export interface Suggestion {
  /** Stable, and it CHANGES when the evidence changes — see B.9 on dismissal. */
  key: string;
  kind: SuggestionKind;
  /** One plain sentence, the headline. Already through t(). */
  title: string;
  /** The evidence, in dollars and dates. Already through t(). */
  detail: string;
  /** Dollars this is about, for sorting. Not a claim about cash. */
  amount: number;
  /** The one-tap fix, or null when only a person can decide. */
  fix: SuggestionFix | null;
  /** Ids the user can open to look at the evidence. */
  txnIds?: string[];
  recurringId?: string;
}
```

**Two numbers are borrowed, not invented.** Every amount comparison uses the band the bank feed's own bill matcher already uses to decide two amounts are "the same bill" (`matchBillByDayAmount`, `plaid/index.ts:183-185`):

```
band(row) = row.variable ? max(15.00, 0.15 * modelled)
                         : max( 2.00, 0.03 * modelled)
```

and every date-to-cycle question uses the seven-day grace the feed and the calendar already share (`GRACE_MS`, `schedule.ts:227` / `plaid/index.ts:102`). Borrowing beats inventing: a charge the app's own matcher would have called "the same bill" is by definition not worth mentioning, and a charge outside that band is the one the matcher itself would have refused.

**Three gates apply to every suggestion, without exception:**

1. **Posted only.** `pending` rows are skipped — a pending row can vanish or change amount when it posts. (Live: 3 pending rows today, incl. a $68.42 Zelle.)
2. **The row must have existed.** A cycle that closed before `recurring.createdAt` is not evidence against that row. Without this gate, `Grok AI` and `Claude Pro (Gino)` — both created at 22:04 today — are each accused of three missed cycles they could not have had.
3. **Windows are honoured.** `startsOn` / `endsOn`, using `liveOn`, never re-derived.

---

### B.2 W1 — amount drift

> The app thinks this bill is one amount; the last charge was another.

```
for each active recurring row r, direction "out":
    skip if r.linkedDebtId              (you choose a card payment; it is not billed)
    skip if r.variable and r.knownAmount == null   (that figure IS the average of actuals)
    modelled = r.knownAmount ?? r.amount;  skip unless modelled > 0
    last = the most recent posted charge whose appliesTo links r
    skip if there is none
    fire when  abs(last.amount - modelled) > band(r)
```

**Thresholds and why.** `band()` from B.1. Nothing else. In particular **no averaging** — the comparison is against the *single most recent* charge, not the mean of the last three. The mean is wrong here and the live data proves it: Spotify's last four charges are 14.04, 14.04, 14.04, **27.00**. The mean of the last three is $18.36, so a mean-based rule would keep insisting the correct modelled $27.00 is wrong for two more months. The last charge is a fact about what the biller now charges; the mean is a guess about the future.

**Window.** One charge — the latest linked one, whenever it was.

**What it says.** Title: `"Spotify now charges more than the app expects"`. Detail: `"The app plans $14.04 a month. The last charge, on 10 Sep, was $27.00 — $12.96 more."`

**One tap.** *"Use $27.00 from now on"* → §D.2.

**How it can be wrong.** It fires on the first divergent charge, so a one-off — a late fee rolled into the bill, a two-month catch-up (Verizon's real $209.45 on 3 Aug covering two months) — reads as a new price. That is the deliberate trade: the cost of being wrong is one dismissal; the cost of missing it is a wrong forecast for months. It is also why this is a suggestion and not a check.

**Live today: 0 fire.** Every fixed row's last charge equals its modelled amount to the cent. With `linkedDebtId` rows *not* excluded it would falsely fire on `Card payment (…4728)` (modelled $129.00, last charge $300.00) — that exclusion is load-bearing.

---

### B.3 W2 — phantom bill

> The app plans for this bill every month. Nothing has been charged for three cycles.

```
for each active recurring row r, direction "out", cadence in {weekly, biweekly, semimonthly, monthly}:
    cycles = the closed cycles of r, newest first, where a cycle is closed when
             dueDate + 7 days < today, and the cycle is inside r's window,
             and dueDate >= r.createdAt
    skip if fewer than 3 closed cycles
    fire when NONE of the newest 3 has a linked charge
```

**Thresholds and why.** **Three** cycles. One missed cycle is a late bill; two is a coincidence a household actually has (Verizon's 2026-07 cycle is genuinely empty because August's $209.45 covered it). Three consecutive misses on a monthly bill is a quarter of silence — long enough that "this bill no longer exists" is the better explanation, and short enough to catch a cancelled subscription before it has distorted a full forecast cycle. Longer-than-monthly cadences are out of scope: three missed yearly cycles is three years.

**Window.** The three newest closed cycles.

**What it says.** Title: `"Affirm may be finished"`. Detail: `"The app still plans $200.00 a month for Affirm, but nothing has been charged for it since June. That is $600.00 of planned money that is not leaving."`

**One tap.** *"Turn this bill off"* → sets `active = false` (§D.3). **Never a delete** — deleting the row is what produced today's $165 of dangling links.

**How it can be wrong.** A bill paid outside the app for three months, or a bill whose real charges exist but were never *linked* (see W7 — the two are often the same money seen from opposite ends). The engine looks at links, not at cash, so an unlinked charge reads as no charge.

**Live today: 0 fire,** with the `createdAt` gate. Without it, two fire — `Claude Pro (Gino)` and `Grok AI`, both created at 22:04:28 today. The gate is load-bearing. Note that `Claude Pro (Gino)` would otherwise be a *correct* hit: it is a second $21.62 Anthropic row whose day-8 cycles have never been charged. See open question 3.

---

### B.4 W3 — unmodelled repeat

> The same charge has landed every month for three months and the app does not know about it.

```
window = the last 6 whole-or-part months
rows   = posted expense rows with no appliesTo, not recordOnly
group by merchantKey(description)     -- the production normalizer, not a new one
for each group g:
    months = distinct YYYY-MM in g;                     require months >= 3
    require g.length <= months + 1        -- about one charge a month, not a habit
    med = median(amounts of g)
    require EVERY amount in g within max(2.00, 0.03*med) of med
    skip if any active out-row's name normalizes to this same key (billKey or merchantKey, EXACT)
    fire
```

**Thresholds and why.** The discriminating fact about a subscription is not how often you buy there, it is that **the amount never changes**. Both extra conditions exist because the obvious rule is useless — "same merchant in 3 of 6 months" fires on Safeway, Circle K, Chipotle, Sam's Club, QuikTrip, 99 Ranch and Amazon on this ledger. `g.length <= months + 1` rejects a habit (Sam's Club: 38 charges in 4 months). "Every amount within the band" rejects variety (Chipotle: 14 charges, 10 within band). Three months because two is a coincidence; the amount rule is doing the real work, so three is enough. Six-month window because the ledger holds five months and a longer window would mostly be empty.

**Window.** Six months.

**What it says.** Title: `"Google One looks like a monthly subscription"`. Detail: `"$1.99 charged in July, August and September, always the same amount. It is not in your bills, so nothing plans for it."`

**One tap.** *"Add it as a monthly bill"* → §D.4. This is the only suggestion whose fix **creates** a model row, and it is the one that most needs a confirm step, because a wrong bill row silently distorts firepower.

**How it can be wrong — and a limitation worth stating plainly.** Any perfectly-regular non-subscription (the same $45 haircut on the same day each month) reads as a subscription. And **this rule would not have caught Grok, the case it was written for.** The three real charges are `Grok Xai $30.00` (16 Jun), `Grok Xai $16.00` (5 Aug), `Grok Ai $29.99` (22 Sep) — two different `merchantKey` values and three different amounts. Neither the grouping nor the amount test holds. There is no honest rule that catches that from history alone; W7 catches it from the other side once a row exists. See open question 2.

**Live today: 0 fire.** `AMAZON PRIME` (4 charges, all $16.20, 3 months) is the only group that passes the shape test, and it is correctly suppressed because an active `Amazon Prime` row exists — but its charges are **not linked to it**, which is W7's job.

---

### B.5 W4 — missing charge

> Every previous cycle of this bill was charged. This one was not.

```
same cycle list as W2
require at least 3 closed cycles
fire when the NEWEST closed cycle has no linked charge
       and the two before it both do
```

**Thresholds and why.** Two clean cycles behind it is what separates "this bill is reliable and this month broke the pattern" from "this bill is erratic." It is deliberately the narrow, high-confidence complement of W2: W2 says *the bill is over*, W4 says *the bill is late or the charge is missing*. They can never both fire on one row.

**Window.** The three newest closed cycles.

**What it says.** Title: `"Rent has not been charged this month"`. Detail: `"Rent is $1,726.88, due on the 1st. It was charged in July and August, and this month nothing matches it. Either it has not gone out yet or the charge is not in the app."`

**One tap.** **None.** The two possible fixes are "record it as paid" (writes a money marker) and "link a charge to it" (settles a cycle). Both are §D.6 — not auto-applicable. The suggestion offers *"Show me the bill"* and *"Look for the charge"*, which open existing sheets.

**How it can be wrong.** A bill paid early enough to roll into the previous cycle (the grace window puts a 30 Jun payment on the July bill), a bill genuinely not yet due within grace, a bill whose charge landed but under a descriptor nothing matched.

**Live today: 0 fire.** Verizon's empty 2026-07 cycle does not fire because W4 only looks at the *newest* closed cycle, and Verizon's newest is paid.

---

### B.6 W5 — possible duplicate

Two shapes, two confidence levels. Both are the Cherry case; only the second one would have caught it.

**W5a — the same charge entered twice.**

```
group posted rows by (accountId, date, amount, type)
fire on a group of 2+ containing at least one row with provider == null
                              and at least one row with provider != null
```

`accountId` must match, and the group must mix a hand-entered row with a bank row. **Both conditions are load-bearing.** Dropping `accountId` or the manual/bank mix turns up six real repeated charges on this ledger that are not duplicates at all: `BKOFAMERICA ATM $60.00` twice on 15 Sep, `PARKINSAFE NOLLIE $6.00` twice on 8 Sep, `CITY OF FLAGSTAFF $1.00` twice on 15 Jul, `365 RETAIL MARKETS $1.80` on two different accounts, and a `TEMPORARY CREDIT ADJUSTMENT $9.99` **six times** on one day. Same day, same amount, same merchant is a normal thing for a real bank feed to contain.

**Threshold:** none. Exact date, exact amount, exact account. It is still a suggestion rather than a check because a person genuinely can buy the same coffee twice in a day and also type one of them in.

Title: `"This charge may be in twice"`. Detail: `"Two charges of $151.72 on 24 Sep in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra."`
One tap: *"Remove the hand-entered one"* → `deleteTransaction(manualId)` (§D.5). Safe: `reverse_money_event` moves no cash for a row with no `accountId`/`provider`.

**W5b — the same obligation claimed twice.** *(the real Cherry shape)*

```
for each posted row m where  m.provider == null
                       and  m.accountId == null
                       and  m.appliesTo.kind == "bill"
                       and  m.appliesTo.settled === true          -- a markBillPaid marker
    r = the recurring row m points at;  skip if none (that is the exact check's business)
    cycle = (r, m.appliesTo.monthKey, installment ordinal)    via cycleKeyOf
    evidence B1: another row claims the same cycle          -> already a CHECK failure, skip
    evidence B2: r.linkedDebtId is set, and a posted row x exists with
                 x.provider != null
                 x.appliesTo.debtId == r.linkedDebtId
                 billCycleFor(r.dueDays, x.date) lands on m's cycle
                 abs(x.amount - m.amount) <= band(r)
                 -> fire
```

`markBillPaid` means, in the type's own words, *"already paid, already in my anchored balance"* (`types.ts:34`) — a stand-in for a bank row the app cannot see. When the bank row arrives, the stand-in is the duplicate. The amount match and the seven-day cycle window are what make it a suggestion rather than a check (§A.2, rejection 1); both are stated in the wording so the user can judge.

Title: `"Cherry may be recorded twice for September"`. Detail: `"You marked Cherry paid by hand for September at $151.72. The bank also shows a $151.72 Cherry charge on 24 Sep that went against the Cherry balance. If they are the same payment, September is counting $151.72 twice."`
One tap: *"Remove the hand-entered one"* → `deleteTransaction(markerId)` (§D.5).

**How it can be wrong.** A genuine extra payment toward the same instalment loan inside one cycle, of coincidentally the same size as the instalment.

**Live today: 0 fire** for both. Three manual settled markers exist (Mom 2026-07 $300, Mom 2026-06 $400, Verizon 2026-05 $82.98); none of their recurring rows has a `linkedDebtId`, so W5b has nothing to compare. W5a finds no mixed-provenance pair.

---

### B.7 W6 — one-off income that has landed

> You told the app to expect this money every month. It looks like it arrived once.

```
for each active recurring row r, direction "in":
    skip if r was created less than 2 months ago
    band = max(15.00, 0.15 * r.amount)
    months = distinct YYYY-MM of posted income rows with no appliesTo
             whose amount is within band of r.amount
    fire when months.size == 1
```

**Thresholds and why.** `r.amount` on an income row is the **per-arrival** figure (a semimonthly row of $1,400 models $2,800 a month — `CADENCE_TO_MONTHLY.semimonthly = 2`), so it is compared directly against deposits. The band is the variable band, 15%, because a check is never the round number you were told: the real deposit for a "$1,100/month" expectation was **$1,137.20** (3.4% out), and a real paycheck varies by hours. `months.size == 1` is the whole discriminator: **real recurring income matches in many months; a one-off mislabelled as recurring matches in exactly one.** Two months' age so a genuinely new paycheck is not accused in its first month.

**Window.** All posted income in the ledger.

**What it says.** Title: `"The car insurance check looks like it already came in"`. Detail: `"The app expects $1,100.00 a month. One deposit of $1,137.20 arrived on 25 Sep and nothing like it before. If that was a one-off, the app is counting it every month from here."`

**One tap.** *"It was one-off — stop expecting it"* → sets `endsOn` to the last day of the month the deposit landed (§D.3). Not `active = false`: `endsOn` keeps the history truthful, so past months still show the income they really had.

**How it can be wrong.** A new recurring income in its second month, or an income whose amount changed enough that older arrivals fall outside the band.

**Live today: 0 fire.** `Gino paycheck` matches in 2 months, `Xinyan paycheck` in 5. The pre-repair `car insurance check $1,100/mo` row would have matched in exactly 1 (Sept, $1,137.20) and fired.

---

### B.8 W7 — a charge that matches a bill you already model

> This charge looks like your Amazon Prime bill, and nothing connected the two.

This is the suggestion the six findings did not name and the live data most needs. It also explains W2 and W4 from the other side: a bill with "no charges" usually has charges that were never linked.

```
candidates = posted expense rows with no appliesTo, not recordOnly, last 6 months
for each candidate c and each active out-row r live on c.date:
    require  billKey(merchantKey(c.description)) == billKey(r.name)
             -- EXACT normalized equality. NO prefix matching.
    modelled = r.knownAmount ?? r.amount
    require  abs(c.amount - modelled) <= band(r)
    cycle    = billCycleFor(r.dueDays, c.date)
    skip if that cycle already has a linked charge
at most ONE suggestion per (r, cycle): keep the charge nearest the due day
```

**Thresholds and why.** The exact-equality rule is the entire design, and the live data shows why nothing looser works. Reusing `matchRecurringName`'s prefix arm matches `SAM'S CLUB` (a $130 grocery run) to `Sam's Club membership` ($16.22/yr) and `AMAZON` (a $159 order) to `Amazon Prime`. Reusing `matchBillByDayAmount`'s day+amount arm on unrestricted spending is worse: on this ledger it pairs Chipotle with Spotify, Circle K with Grok AI, Safeway with Lemonade, and a Zelle transfer with Verizon — **over a hundred false matches in four months.** That heuristic is only safe inside the feed because it runs *after* the categorizer has already decided the charge is a bill. Outside that guard it must not be used at all. Exact normalized name plus the amount band is the only version that holds.

**Window.** Six months, cycles only.

**What it says.** Title: `"This charge looks like your Amazon Prime bill"`. Detail: `"$16.20 at Amazon Prime on 23 Sep. Your Amazon Prime bill is $16.20, due on the 23rd, and the app has it as unpaid. Right now this is counted as ordinary spending as well as a bill still to come."`

**One tap.** *"Yes, that is the bill"* → writes the bill link (§D.6) — the one fix that settles a cycle, and therefore the one that must never run without a tap.

**How it can be wrong.** A genuine one-off purchase at the same merchant for the same amount as the subscription.

**Live today: 4 fire, all correct.**

```
Amazon Prime  2026-07 cycle  <- 2026-07-23  $16.20  "Amazon Prime"
Amazon Prime  2026-08 cycle  <- 2026-08-24  $16.20  "Amazon Prime"
Amazon Prime  2026-09 cycle  <- 2026-09-23  $16.20  "Amazon Prime"
Grok AI       2026-09 cycle  <- 2026-09-22  $29.99  "Grok Ai"
```

Every one is real: `Amazon Prime` is modelled at $16.20 due on the 23rd and has been charged $16.20 every month with nothing linked, and the new `Grok AI` row's first charge is sitting unlinked in `utilities`. There is a fifth $16.20 Amazon Prime charge on 2026-08-31 which the grace window puts in the September cycle; the 09-23 charge is nearer the due day and wins, leaving 08-31 with no suggestion. That leftover is out of scope for v1 — say so rather than guess at it.

**This is also the answer to Grok.** W3 cannot find Grok from history. W7 finds it the moment a row exists, from the other side.

---

### B.9 Which of these can fire on a correct ledger, and how dismissal works

**Can fire when nothing is wrong:** W1 (a one-off charge), W2 (a bill paid outside the app), W3 (a regular non-subscription), W4 (an early or genuinely-late bill), W5a (the same purchase twice in a day, one typed in), W5b (a real extra payment of the same size), W6 (a second-month recurring income), W7 (a one-off at a subscription merchant).

**That is all of them.** Every suggestion can be wrong. That is the difference from a check, and the UI must say it in those words — `"Worth a look — not mistakes, just things the app noticed"`.

**Dismissal: the key carries the evidence.**

```
drift:<recurringId>:<last charge amount in cents>
phantom:<recurringId>:<newest closed cycle monthKey>
unmodelled:<merchantKey>:<median amount in cents>
missing:<recurringId>:<cycle monthKey>:<installment ordinal>
duplicate:<txnId a>:<txnId b>            (ids sorted, so the key is order-free)
income-landed:<recurringId>:<matching txnId>
unlinked:<recurringId>:<cycle monthKey>:<txnId>
```

Dismissing writes the key to a new table. A dismissed key never renders again. Because the **evidence is inside the key**, re-surfacing is automatic and no snooze, expiry or re-ask logic is needed:

- Spotify drifts to $27.00, he dismisses it, Spotify later drifts to $35.00 → new key → asks again. Correct.
- A phantom bill is dismissed this month; next month a fourth cycle closes → new `monthKey` → asks again. Slightly annoying and honest; if it proves noisy, widen the key to `phantom:<recurringId>` in v2 rather than adding a snooze.
- An unmodelled merchant's amount changes → new key → asks again. Correct.

New table, following the `saved_meals` pattern in `schema_v20` exactly (additive, idempotent, `for all to authenticated`, added to the realtime publication):

```sql
-- schema_v36_ledger_review.sql  (RUN ONCE)
create table if not exists public.review_dismissals (
  key        text primary key,
  kind       text not null,
  created_at timestamptz not null default now()
);
```

Household-wide, not per-person, like every other table here — two phones, one ledger. Dismissing on one phone dismisses on both, which is the same contract `anomaly_ack` already has.

---

## PART C — where it appears

**Decision: Activity, not Profile.** One new card at the top of `ActivityTab`, and one new sheet. It is **not** in the self-check panel, for the reason in §0: `AuditPanel`'s closing paragraph promises exactness, and a threshold rendered under that sentence makes the sentence a lie. It is not on Home either — Home already carries `Unusual purchases`, `~processing`, and `Owed to you`, and a fourth amber card there is the definition of nagging.

Activity is right because that is where the *charges* are, which is what every suggestion is about, and it is a tab you open on purpose.

**The card** — same geometry as the existing `Unusual purchases` card (`HomeTab.tsx:212-232`), amber instead of pink:

```
┌────────────────────────────────────────────┐
│ [!]  Worth a look                       ›  │   icon Lightbulb, 9x9 rounded-xl
│      4 things the app noticed               │   bg #2a2416, colour #e3b341
└────────────────────────────────────────────┘   card bg #241f12, border #4a3f1c
```

Zero suggestions → **the card is not rendered at all.** No green "all clear" card. `AuditPanel` earns its quiet always-there line by being exact; a guesser that says "nothing to report" is just taking up space. (The empty state still exists *inside* the sheet, for when the last one is fixed while it is open: green `Check`, `"Nothing to look at — the bills and the charges agree."`)

**Badge.** Plain count on the Activity tab label, `#e3b341`, in the same pill the needs-review chip uses (`ActivityTab.tsx:212`). Suggestions and needs-review are counted separately and never summed — one is "the app has a question about a category", the other is "the app has a question about a bill".

**The sheet** — `ReviewSheet.tsx`, built from `AnomalySheet.tsx`, which is already the right shape: centred modal, `#0f141c`, amber top border, one card per item, two buttons per card. Changes from `AnomalySheet`:

- Header: `"Worth a look"` / `"Not mistakes — things the app noticed about your bills and charges. Fix or dismiss."`
- Each card: title in `#e6edf3`, detail in `#8b97a6`, amount right-aligned `num`, then the buttons.
- Left button (`#0e2230` / `#34c5e8`) is the fix, labelled with what it does — `"Use $27.00 from now on"`, `"Turn this bill off"`, `"Yes, that is the bill"`. Never `"Fix"`.
- Right button (`#13211a` / `#46d18a`) is always `"Looks fine — dismiss"`, the same words `AnomalySheet` already uses.
- No fix available (W4) → left button becomes `"Show me the bill"` in `#232d3a` / `#8b97a6` and opens the existing sheet.
- Sorted by `amount` descending, so the biggest money is first.

**After a fix is applied:** the card is replaced in place by one green line — `Check` icon, `"Done — Spotify is $27.00 from now on."` — which stays until the sheet closes. It does not vanish: he tapped, and the tap has to have a visible consequence. The whole list recomputes from the changed `data`, so a fix that resolves two suggestions clears both.

**Never a push notification.** `cron-notify` stays the only thing that reaches the phone, and it stays about bills due.

**Where the two layers reference each other.** `AuditPanel`'s failure detail for `links-point-somewhere` ends with `"Worth a look has a one-tap fix for this."` That is the only crossing, and it points from the certain thing to the actionable thing, never the reverse.

---

## PART D — applying a fix

**The rule over all of it: nothing writes to Supabase without a tap.** `reviewLedger()` is pure and returns text and a `fix` descriptor; it performs no writes. Every fix is one store call, one row, in response to one tap, from a sheet where the person is looking at both numbers.

### D.1 Dangling link (the exact check's fix)

`unlinkFromBill(txnId)` — **exists**, `FinanceStore.tsx:1031`. Writes `applies_to = null`. Moves no cash; already exposed in `TxnSheet` with the bill named. Reversible by re-running the match.

Effect of applying it to today's four rows: $45.00 returns to category `bills` (in `OUTSIDE_BUDGET_CASH_CATS`, so no budget bar moves and firepower is unaffected) and $120.00 returns to category `other` (the Misc line, in past cycles). No new orphan-category failure — both ids are already accounted for. Verified against `plan.ts:110-121`.

### D.2 Amount drift

Needs **one new store action**, because *nothing in the app can change a recurring row's amount today*. `setRecurringVariable` is the only generic field write on `recurring` (`FinanceStore.tsx:1231`), and `known_amount` is read in four places and **written by nothing**.

```
setRecurringAmount(id, { amount?: number; knownAmount?: number | null })
  fixed row    -> update recurring set amount = <last charge>
  variable row -> update recurring set known_amount = <last charge>
```

One column, one row, no money. Pattern copied from `setRecurringVariable` verbatim: optimistic `setData`, `invalidate(seq.current, "recurring")`, then the update. No migration needed — both columns exist. (`known_amount` has no migration file in `supabase/` but is live in the DB and read by the client and by `cron-notify`; the new `schema_v36` file should add `alter table recurring add column if not exists known_amount numeric` so the tracked migrations finally describe the real schema.)

### D.3 Phantom bill, one-off income

```
setRecurringActive(id, active: boolean)        -- phantom: active = false
setRecurringWindow(id, { endsOn: string | null })  -- income: endsOn = last day of the month it landed
```

Both are one column on one row, no money. **Neither deletes.** Deleting a recurring row is what produced the $165 of dangling links, and it is explicitly out of scope for any one-tap fix — if he wants a row gone, that is a deliberate act elsewhere, and it should unlink its transactions first.

### D.4 Unmodelled repeat

Needs a new action. `makeRecurringBill` (`FinanceStore.tsx:1177`) must **not** be reused: it hardcodes `category_id: "subscriptions"`, sets `amount` from the single charge in hand, and upserts a permanent `merchant_rules` row that then outranks every built-in rule with no way to delete it anywhere in the app.

```
addRecurringFromCharges({ name, amount, dueDay, categoryId, cadence: "monthly" })
  -> insert one recurring row; writes NO merchant rule; links NO transaction
```

`amount` is the median of the matched charges, not the newest. `dueDay` is the most common day among them. `categoryId` comes from the charges' own most common category, and if that is `other` the fix button is disabled and the card says `"Give it a category first"` — because a bill row landing in an ungraded category is the `utilities` defect check 3 exists to catch.

It does not link the existing charges. Those become W7 suggestions on the next recompute, one per cycle, each with its own tap. Two taps instead of one, and each tap settles exactly one cycle with the numbers on screen.

### D.5 Possible duplicate

`deleteTransaction(manualId)` — **exists**, `FinanceStore.tsx:922`. Safe **only** for the hand-entered row, and only because `reverse_money_event` restores cash solely when `account_id is not null and provider is null and not record_only` (`schema_v28_record_only.sql:80-121`), and the optimistic mirror gates on `!txn.provider && !txn.recordOnly` (`FinanceStore.tsx:955-963`). A `markBillPaid` marker has `account_id = null`, so nothing moves.

**Hard rule: the fix never offers to delete the bank row.** Plaid re-delivers it on the next cursor page, and deleting real bank history is the one action in this spec that destroys data the app cannot rebuild. If a duplicate group contains no manual row, there is **no fix** — the card shows both charges and the buttons are `"Open both"` and `"Looks fine — dismiss"`.

### D.6 Missing charge, and linking a charge to a bill

```
linkTransactionToBill(txnId, recurringId)
  cycle = billCycleFor(recurring.dueDays, txn.date)
  update transactions set applies_to = {
    kind: "bill", recurringId, monthKey: cycle.monthKey,
    day: cycle.day, installmentIndex: <ordinal of cycle.day in sorted dueDays>
  }
  -- and nothing else. No `settled` field, matching payBill (FinanceStore.tsx:721)
     and makeRecurringBill (:1215): absent means settled, while settled:false would
     make monthCalendar skip the row (schedule.ts:327-332) and leave the money in
     neither the budget nor the bill.
```

This is the **most dangerous write in the spec** — it settles a bill cycle, which is the mistake the relabel sweep refuses to make from a bulk pass on purpose (`plaid/index.ts:830-836`, which sets `needs_review` instead of linking). Three guards:

1. One tap, one charge, one cycle. Never a batch, never a "fix all".
2. The card shows both amounts before the tap, the way `TxnSheet.tsx:252-274` already does for the reverse action. Comparing the two numbers is what makes it safe.
3. Refuse if the cycle already has a linked charge — re-read `data` at tap time, not at render time, because the feed may have linked it in between.

`unlinkFromBill` is the undo and is already in `TxnSheet`.

### D.7 What can never be auto-applied

| Not offered | Why |
|---|---|
| Delete a bank (`provider`) transaction | Plaid re-delivers it; real history the app cannot rebuild |
| Delete a recurring row | Leaves dangling links — today's $165 |
| Write a `merchant_rules` row | Permanent, outranks built-in rules, no delete UI anywhere |
| `markBillPaid` / `payBill` from a suggestion | Writes a money movement |
| Any fix applied to more than one row per tap | Batch settlement of bill cycles is the one mistake that costs real money |
| Any write at all during a recompute | `reviewLedger()` is pure |

---

## PART E — build plan

Four pieces. 1 and 2 are independent and can land in either order; 3 needs 2; 4 needs 3.

### Piece 1 — the exact check *(smallest, ships alone, fixes a live $165 hole)*

**Owns:** `src/lib/selfAudit.ts`, `tests/selfAudit.test.ts`.
**Does:** adds `linksPointSomewhere(data)` as check 8; exports `cycleKeyOf` (piece 3 needs it and must not re-implement it — there are already five cycle-key implementations); extends the rejected-checks list in the header comment with §A.2's three rejections.

Acceptance:
- healthy fixture → `clean === true`, 8 checks.
- a txn with `appliesTo.recurringId` pointing at a missing row → fail, detail names the date, the description and the amount.
- same for `debtId`, `goalId`, `settledByTxnId`, `accountId`, `recurring.linkedDebtId`.
- a txn with `appliesTo` and no ids at all (`kind:"transfer"`) → passes.
- the existing "every check states its question in plain language" test still passes.
- `npx vitest run` green offline.

Against the real snapshot: **fails with 4 offenders totalling $165.00**, all `recurringId = b04df2be-824e-4e71-b332-b6ee07c94944`, dates 2026-06-15 $85.00, 2026-07-06 $35.00, 2026-08-25 $25.00, 2026-09-16 $20.00.

### Piece 2 — the engine

**Owns:** `src/lib/ledgerReview.ts` (new), `tests/ledgerReview.test.ts` (new).
**Reads only:** `AppData` + `now`. Imports `merchantKey`/`billKey`/`matchRecurringName` from `categorize.ts`, `billCycleFor` from `schedule.ts`, `billExpected`/`liveOn` from `plan.ts`/`recurring.ts`, `cycleKeyOf` from `selfAudit.ts`. **Writes no new copy of any of them.**
**Exports:** `reviewLedger(data, now, dismissedKeys): Suggestion[]`.

Acceptance — one synthetic fixture per finding, because the live ledger no longer reproduces any of the six:

| Fixture | Expect |
|---|---|
| Spotify modelled 14.04, charges 14.04/14.04/14.04/27.00 | one `drift`, `key = drift:<id>:2700` |
| the same, but the row has a `linkedDebtId` | nothing |
| Affirm $200/mo, no linked charge for 3 closed cycles | one `phantom` |
| the same, but `createdAt` is after the oldest cycle | nothing |
| the same, with a charge in the middle cycle | nothing |
| Grok $29.99 in 3 of 6 months, identical amount, no row | one `unmodelled` |
| the same, amounts 30.00/16.00/29.99 | nothing *(documents the real Grok limitation)* |
| 38 Sam's Club charges over 4 months | nothing |
| Rent paid in the 2 older cycles, empty in the newest | one `missing`, `fix === null` |
| $151.72 manual marker + $151.72 bank row on the linked debt, same cycle | one `duplicate` (W5b) |
| same day/amount/account, one manual + one bank | one `duplicate` (W5a) |
| same day/amount, both bank | nothing |
| income row $1,100/mo, one $1,137.20 deposit, row 3 months old | one `income-landed` |
| the same, deposits in 3 months | nothing |
| the same, row created 3 weeks ago | nothing |
| $16.20 "Amazon Prime" unlinked + a $16.20 "Amazon Prime" bill on the 23rd | one `unlinked` |
| $130 "Sam's Club" + a $16.22 "Sam's Club membership" bill | nothing |
| $25.19 "Chipotle" on the 11th + a $27.00 "Spotify" bill on the 10th | nothing |
| two matching charges in one cycle | exactly one `unlinked`, the nearer to the due day |
| every fixture, with the suggestion's key in `dismissedKeys` | nothing |
| a pending row in every fixture's position | nothing |

Against the real snapshot, with today as `now`, the total must be **exactly 4** and all four `unlinked`:

```
unlinked  Amazon Prime  2026-07   2026-07-23  $16.20
unlinked  Amazon Prime  2026-08   2026-08-24  $16.20
unlinked  Amazon Prime  2026-09   2026-09-23  $16.20
unlinked  Grok AI       2026-09   2026-09-22  $29.99
drift 0 · phantom 0 · unmodelled 0 · missing 0 · duplicate 0 · income-landed 0
```

A snapshot harness like `tests/live-selfaudit.test.ts` — skipped unless the snapshot file is present — is the right home for that assertion, so it never depends on the network.

### Piece 3 — the writes

**Owns:** `src/store/FinanceStore.tsx` (interface + 4 new actions), `supabase/schema_v36_ledger_review.sql` (new).
**Adds:** `setRecurringAmount`, `setRecurringActive`, `setRecurringWindow`, `addRecurringFromCharges`, `linkTransactionToBill`, `dismissSuggestion`, and `reviewDismissals` in `AppData`.
**Migration:** `review_dismissals` table (§B.9) + `alter table recurring add column if not exists known_amount numeric` so the tracked migrations finally match the live schema. Additive and idempotent, `saved_meals` pattern from `schema_v20`.

Acceptance: `npx tsc --noEmit -p tsconfig.app.json`; every new action follows `setRecurringVariable`'s shape (optimistic `setData`, `invalidate`, then the write, `console.error` on failure); `linkTransactionToBill` refuses when the cycle is already claimed, re-reading `dataRef.current` at call time. **No write runs anywhere except from a tap handler.** Nothing in this piece is exercised against the live DB by a test.

### Piece 4 — the screen

**Owns:** `src/views/redesign/ReviewSheet.tsx` (new, from `AnomalySheet.tsx`), `src/views/redesign/ActivityTab.tsx` (the card + the badge), `src/views/redesign/FinanceTabs.tsx` (one `useMemo`, mirroring the `audit` one at `:161`, and the sheet's open state), `src/lib/i18n_zh.ts` (translations), `src/lib/changelog.ts` (one entry).
**Does not touch:** `ProfileTab.tsx` beyond the one pointer sentence in the `links-point-somewhere` detail.

Acceptance: zero suggestions → no card rendered anywhere; every string through `t()` with a `ZH` entry; only tokens listed in §C; the sheet is reachable and dismissable on a 375px-wide screen; `npx eslint` clean on every touched file.

### Before finishing, on every piece

```
npx tsc --noEmit -p tsconfig.app.json
npx vitest run
npx eslint <the files you touched>
```

No Supabase writes, no `npm run snapshot` against live, no commits.

---

## Three things only Gino can decide

1. **The $165 of dangling links — unlink or delete?** Unlinking (recommended) turns them back into ordinary spending: $45 into `bills`, which is outside the budget by design, and $120 into Misc in June and July, which will make those two past cycles read higher — correctly, because that money really did leave. Deleting them would hide $165 of real charges. Recommend unlink; it needs a yes because it changes numbers he has already looked at.

2. **How hard should W3 hunt for unmodelled subscriptions?** As specified it groups by the production `merchantKey`, fires on nothing today, and **would not have caught Grok** (`Grok Xai` → `Grok Ai`, $30.00 → $16.00 → $29.99). Grouping by the first word instead finds one more real thing — Google One at $1.99/month, charged in July, August and September, not modelled — at the cost of looser matching. Recommend shipping `merchantKey` and adding `Google One` as a bill by hand, since W7 now catches the Grok shape from the other side.

3. **Is `Claude Pro (Gino)` (day 8, $21.62) a second real subscription, or a duplicate of `Claude Pro` (day 20, $21.62)?** There are two unlinked $21.62 Anthropic charges — 8 Sep (already linked to the day-20 row) and 21 Sep (unlinked). If it is one subscription, that row is a phantom bill overstating fixed costs by $21.62/month and should be turned off. If it is two, the row is right and its due day is wrong (the charge lands on the 21st, not the 8th), which is why W7's exact-name rule cannot link it. The engine cannot tell; only he knows how many Anthropic subscriptions he pays for.
