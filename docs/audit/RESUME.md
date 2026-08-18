# RESUME HERE — production audit, paused 2026-08-18

Paused mid-flight for a connection drop. This file is the handoff. Read it, then
`docs/audit/FINDINGS.md` (32 verified findings + 7 accepted residuals).

---

## State of the working tree

**Everything through batch 1 is COMMITTED AND PUSHED and is live.**

**The tree is CLEAN and everything is pushed.** Batch 2 was stopped deliberately
rather than left to die mid-write.

Of batch 2's four groups, only `buildvms` finished before the stop. Its work was
inspected, verified against the authoritative skeptic correction, and committed
(`d1f7cd7`) — findings **#22 and #27 are done**. It never got its independent
review pass, so it is the one commit here worth a second look on resume.

The other three groups (`store`, `health`, `forecast`) **wrote nothing**. Their
findings are untouched and listed below.

**First thing on resume:**

```bash
cd /c/Users/ginoc/Documents/homebase && git status --short && npm run build
```

Expect a clean tree and a passing build. If either surprises you, something wrote
after this file was saved — inspect before committing anything.

---

## Done, deployed, verified

| What | Evidence |
|---|---|
| **CRITICAL: anonymous ledger wipe + data exfiltration** on the `plaid` and `notify` edge functions | Live probes with the public key now return `401`; the three deliberately-public functions still return `403` from their own token checks |
| **`cron-notify` pushing bills that aren't due** — 4 drifts | Simulated over real rows across 10 dates, 9 assertions pass |
| **Batch 1** — 9 findings across push, import, categorizer, plaid sync, merchant rules | Commit `2b31d51`; each reviewed by an independent skeptic |
| **Edge functions auto-deploy** from CI | `functions` job in `.github/workflows/deploy.yml` |
| **`verify_jwt` moved into version control** | `supabase/config.toml` |

Commits: `4eadb60` (security) → `7231c54` (cron-notify) → `2b31d51` (batch 1).

---

## NOT done — pick up here

### Batch 2 findings still open (#22 and #27 are DONE, commit `d1f7cd7`)

Details in FINDINGS.md; the numbers there are authoritative.

| # | Sev | File | Defect |
|---|---|---|---|
| 25 | HIGH | `src/lib/format.ts:15` | `todayISO()` is UTC; in Arizona anything after 5pm is stamped **tomorrow**, so an evening purchase on the 31st files into next month's budget and the wrong pay cycle. `FinanceStore.tsx:479,575` repeat it inline. `src/lib/mealLog.ts:127` already does it right — copy that, don't edit it. |
| 23 | HIGH | `FinanceStore.tsx:989` | `setAccountBalance` can silently not persist. **Checking `error` is not enough** — an RLS-filtered UPDATE returns `error:null` with 0 rows. Use `.select()`, treat `error \|\| !data?.length` as failure, resync, and keep the editor open in `sheets.tsx`. |
| 24 | HIGH | `FinanceStore.tsx:704` | `addTransaction` read-modify-writes the balance from client state; two phones at once lose money. |
| 26 | HIGH | `HealthStore.tsx:268` | retries scheduled after unmount overwrite newer data with a frozen snapshot. |
| 30 | MED | `HealthStore.tsx:110` | meal-day dirty guard blocks the merge instead of merging → a whole-document write destroys the other phone's edits. |
| 28 | MED | `forecast.ts:70` | month 0 counted whole, so income already received and bills already paid project as still to come. |
| 29 | MED | `FinanceStore.tsx:283` | refetches have no request sequencing; an older SELECT can land last. |
| 31 | MED | `FinanceStore.tsx:438` | realtime subscribed after the initial SELECTs, status never checked → events missed in the gap never recover. |
| 32 | LOW | `schedule.ts:426` | `dueBeforeNextPayday` starts at today, so an unpaid bill already past its due day inside the cycle drops out. |

### Then, still outstanding

1. ~~No test framework~~ **DONE.** 110 vitest tests, TZ pinned to Phoenix, gating
   the deploy. Plus two live harnesses: `tests/live-selfaudit.test.ts` and
   `tests/backtest.test.ts`. **Still untested: `src/views/redesign/buildVMs.ts`** —
   the largest untested file and the one computing most of what the user sees.
2. **Round 1 findings not yet fixed:** #2 (`reverse_money_event` credits balances
   for rows that never debited — `schema_v18_finalization.sql:36`), #5/#6
   (`planMath`/`householdMonthly` ignore `starts_on`/`ends_on`, so dormant bills
   consume firepower — Home/Insights disagree with Bills/Forecast by ~$1,164/mo),
   #11 (`utilities` is on no budget line AND not in `OUTSIDE_BUDGET_CASH_CATS`,
   so money assigned to it vanishes from both), #19 (`RENTERS_INSURANCE` hardcoded).
3. **7 accepted residuals** — end of `FINDINGS.md`. R1 matters most: the plaid
   dedup guard drops absorbed rows with no in-app trace ($354.46 / 18 rows per pass).
4. **Fix my own false claim:** `ACCOUNTANT_BRIEF.md` Rule 6 says a test fixture
   exists. None does. Correct it when tests actually land.
5. **11 low-severity round-1 findings were never verified** (cap at 26) and 8 from
   round 2. They are excluded from FINDINGS.md, not cleared.

---

## Two things only Gino can do

1. **Confirm the bank feed still works.** Authorization on the `plaid` function
   changed. The attack is provably closed, but a real signed-in session was never
   tested — the test account is banned so no token could be obtained. Open
   Homebase, pull to refresh. If it errors, revert `4eadb60` immediately.
2. **`claude-test@homebase.app` is banned, not deleted.** Still worth removing.

## Deliberate conventions — never "fix" these

Nine of them, listed in `ACCOUNTANT_BRIEF.md` §5. The one that most looks like a
bug and is not: `CADENCE_TO_MONTHLY.biweekly = 2`, not 26/12. Plus convention 9:
the hero tile measures overspend against `monthlyTarget` while the payoff
projection uses `projVariable` — that difference is intentional.

## No changelog bump yet — on purpose

None of this work has bumped `src/lib/changelog.ts`, so no push notification has
fired. Write ONE release note when the fix work is done, so both phones get one
notification instead of six.
