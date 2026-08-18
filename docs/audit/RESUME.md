# RESUME HERE — production audit, paused 2026-08-18

Paused mid-flight for a connection drop. This file is the handoff. Read it, then
`docs/audit/FINDINGS.md` (32 verified findings + 7 accepted residuals).

---

## State of the working tree

**Everything through batch 1 is COMMITTED AND PUSHED and is live.**

⚠️ **Batch 2 was running in the background when the pause hit.** The working tree
may contain PARTIAL, UNREVIEWED edits from up to 4 agents to these files:

```
src/store/FinanceStore.tsx
src/lib/format.ts
src/views/sheets.tsx
src/views/redesign/buildVMs.ts
src/store/HealthStore.tsx
src/lib/forecast.ts
src/lib/schedule.ts
```

**First thing on resume:**

```bash
cd /c/Users/ginoc/Documents/homebase && git status --short && npm run build
```

- Clean tree → batch 2 never wrote. Re-run it.
- Dirty tree → the edits are UNREVIEWED. Do not commit them blind. Either review
  each diff against its finding below, or `git checkout -- <file>` and redo.
- Build fails → almost certainly a half-written file. Revert that file.

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

### Batch 2 findings (details in FINDINGS.md, numbers are authoritative)

| # | Sev | File | Defect |
|---|---|---|---|
| 25 | HIGH | `src/lib/format.ts:15` | `todayISO()` is UTC; in Arizona anything after 5pm is stamped **tomorrow**, so an evening purchase on the 31st files into next month's budget and the wrong pay cycle. `FinanceStore.tsx:479,575` repeat it inline. `src/lib/mealLog.ts:127` already does it right — copy that, don't edit it. |
| 23 | HIGH | `FinanceStore.tsx:989` | `setAccountBalance` can silently not persist. **Checking `error` is not enough** — an RLS-filtered UPDATE returns `error:null` with 0 rows. Use `.select()`, treat `error \|\| !data?.length` as failure, resync, and keep the editor open in `sheets.tsx`. |
| 24 | HIGH | `FinanceStore.tsx:704` | `addTransaction` read-modify-writes the balance from client state; two phones at once lose money. |
| 22 | HIGH | `buildVMs.ts:370` | `monthDent` compares a pay-cycle total to a monthly pace → evaluates 0 for every input, so the overspend penalty is dead code. `spentMonth` is computed nearby and unused. **Convention 9**: the hero tile's disagreement with the projection is deliberate — must survive. |
| 26 | HIGH | `HealthStore.tsx:268` | retries scheduled after unmount overwrite newer data with a frozen snapshot. |
| 30 | MED | `HealthStore.tsx:110` | meal-day dirty guard blocks the merge instead of merging → a whole-document write destroys the other phone's edits. |
| 28 | MED | `forecast.ts:70` | month 0 counted whole, so income already received and bills already paid project as still to come. |
| 27 | MED | `buildVMs.ts:163` | envelope drill-in lists pending charges the bar excludes → rows never sum to the number they explain. |
| 29 | MED | `FinanceStore.tsx:283` | refetches have no request sequencing; an older SELECT can land last. |
| 31 | MED | `FinanceStore.tsx:438` | realtime subscribed after the initial SELECTs, status never checked → events missed in the gap never recover. |
| 32 | LOW | `schedule.ts:426` | `dueBeforeNextPayday` starts at today, so an unpaid bill already past its due day inside the cycle drops out. |

### Then, still outstanding

1. **No test framework at all.** Zero tests under intricate date and money logic.
   This is the largest remaining gap to production-grade. Highest-value targets,
   in order: `biweeklyDaysIn`, `inWindow`, `firesInMonth`, `billCycleFor`,
   `payCycleFor`, `billExpected`, `spentByCategoryBetween`, `forecast`.
   Use vitest — the project already runs vite, so it needs no new config.
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
