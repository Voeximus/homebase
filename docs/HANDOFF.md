# Homebase — Session Handoff / Current State

_Last updated: 2026-06-18. This is the regrounding doc for resuming work on Homebase (and for the next post-compact session). Read this first, then `C:\Users\ginoc\.claude\projects\C--\memory\project_homebase.md` for the deep history._

---

## What it is
A personal finance **+ health** PWA for **Gino** and his wife **Xinyan**, used daily on their phones. One app, **two modes** toggled at the top:
- **Finance** — a debt-payoff "Mission Control" one-pager.
- **Health** — two-person diet/training plans + a calibration gauge + a macro meal builder.

The unifying idea: the app is a **calibration instrument** — Finance calibrates money off the ledger, Health calibrates two bodies off the weekly scale. "Measure, don't infer."

## Live + repo + deploy
- **Live:** https://voeximus.github.io/homebase/ (GitHub Pages, installable PWA).
- **Repo:** github.com/Voeximus/homebase (authed `gh` account **Voeximus**).
- **Deploy:** push to `main` → GitHub Actions builds + deploys (~60–90s). `.github/workflows/deploy.yml`. Build secrets `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` are set in the repo.
- Local path: `C:\Users\ginoc\Documents\homebase`.

## Stack + dev workflow
- Vite + React 19 + TypeScript + Tailwind v4 + lucide-react. Supabase (Postgres + auth + realtime). vite-plugin-pwa. @zxing/browser (barcode, lazy). pdfjs-dist (PDF import, lazy).
- **Run dev server:** `preview_start` name **`homebase`** (config `C:\.claude\launch.json`, port 5173). The **serverId rotates every session and dies between sessions** — call `preview_start` to get a fresh one; if screenshots start timing out (the realtime websocket blocks network-idle on a long-lived page), **stop + start a fresh server** for a clean screenshot window. Mobile viewport: `preview_resize` 390×844.
- **Build/typecheck:** `npm run build`. **PATH refresh required first** in PowerShell:
  `$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')`
- **Commit messages:** write to a temp file and `git commit -F file` (heredoc/inline quoting breaks on the `"`/`'` in messages). End with the Co-Authored-By trailer.
- **preview_click does NOT reach React** in this env (synthetic events). To click in-app, use `preview_eval` with a real DOM `.click()`. Reading state: `preview_eval` / `preview_snapshot` / `preview_inspect` (reliable); screenshots work on a fresh server but flake on a stale one.

## Architecture
Provider tree: `App → AuthProvider → AuthGate → FinanceProvider → Shell → LanguageProvider → (OnePager | HealthView)`.
- **AuthProvider** (`auth/AuthProvider.tsx`) — Supabase email/password session.
- **FinanceProvider** (`store/FinanceStore.tsx`) — THE data store: loads all tables, realtime-subscribes, and exposes the **pipelined money engine** (`applyMoneyEvent` moves cash + writes a ledger row + fans out to a linked debt/goal) plus actions: `payBill`, `payDebtExtra`, `markBillPaid`, `commitImport`, `setAccountBalance`, `setTransactionCategory`, `deleteTransaction`, `saveMerchantRule`, `addFood`/`deleteFood`, `seedHousehold`, `resetAll`.
- **Shell** (`App.tsx`) — holds `mode` ('finance'|'health', `hb-mode`), `owner` ('gino'|'xinyan', `hb-owner`), `lens` ('me'|'all', `hb-lens`), and in-memory `entered`. While not `entered` it renders `WelcomeScreen` (the front door, shown every cold launch); after, OnePager / HealthView with owner + lens props.
- **LanguageProvider** (`components/LanguageProvider.tsx`) — holds `lang` ('en'|'zh', `hb-lang`); **remounts its children via `key={lang}`** so every module-level `t()` re-evaluates on toggle (no data refetch since it's below FinanceProvider).

## Features + key files
**Finance — `views/OnePager.tsx`** (one scrolling page; sticky collapsing header + jump-chip scroll-spy):
- Hero "next move" (the VERB — what to send, when, split across debts, from `payoffSchedule`); "Mark sent" → confirm sheet loops `payDebtExtra`.
- Cash + 90-day streak ring · debt "runner road" to the Nov '26 finish · firepower + spent · 6-envelope budget (drill→relabel/delete) · bills chips + collapsed calendar + coming-up · activity + log/import + floating ＋. SettingsSheet (seed/import/clear) lives at the bottom of this file.
- Math/data: `lib/plan.ts` (planMath, orderedDebts, payoffSchedule, commitmentProgress, variableSpentThisMonth, spentByCategory, lineSpent, LEAN_VARIABLE, UPCOMING_INCOME, ONE_TIMES, HABITS, SAVINGS_SPLIT), `lib/schedule.ts`, `lib/recurring.ts`, `lib/household.ts` (SEED_*), `lib/format.ts`.
- Import/categorizer: `lib/{importStatement,importPdf,categorize,categorizeData}.ts` + `components/ImportSheet.tsx` (CSV+PDF, trained on his MasterLedger, dedup, NPC clarify-cards → `merchant_rules`).

**Health — `views/HealthView.tsx`** (sub-toggle `hb-health-sub` = 'plan'|'kitchen'):
- PLAN: per-person Gino(BUILD)/Xinyan(CUT) toggle (`hb-health-person`), accents Gino `#ef8136` / Xinyan `#2dd1c0`. Snapshot, daily-fuel macros, training (4 sessions + 5-week table), why-it-works, the calibration gauge (enter 7-day weight + weeks → rate → verdict; Xinyan also progress-to-118). Inputs persist per-person in localStorage.
- KITCHEN: **`views/MealBuilder.tsx`** + **`lib/nutrition.ts`** — pick ingredients → per-person grams. `solveMeal(foods, target)` fills veg→carbs→protein→fat to each person's meal target (settable ⅓/½/full-day) so one plate yields two portions; flags overshoots. ~24 seeded foods + custom foods.
- Barcode: **`components/BarcodeScanner.tsx`** (back camera via @zxing, lazy) + **`lib/barcode.ts`** (OpenFoodFacts lookup, free/no-key) → prefill the Add-Food form. Camera needs HTTPS (works on the live site; untested in preview = no camera).

**i18n (English / 简体中文)** — `lib/i18n.ts` (`t(s, vars?)`, module-level current lang) + `lib/i18n_zh.ts` (hand-curated SEED) + `lib/i18n_zh_auto.ts` (~464 workflow-generated translations; SEED overrides on conflict). Toggle = `LangToggle` (中/EN) in both headers. ~470 strings wrapped across the views/components; interpolated sentences use `{placeholder}` templates so word order is correct; money/dates/names/dynamic-data stay raw; untranslated → English fallback.

**PWA / mobile** — `vite.config.ts` (manifest, theme `#0a0d12`, icons incl. 1024px), `index.html` (viewport-fit=cover, theme-color), `public/favicon.svg` (graphite house, cyan→green) + generated icons, `pwa-assets.config.ts` (`@vite-pwa/assets-generator` devDep, dark bg / no white padding). Touch polish + safe-areas in `index.css` (the instrument theme `@theme` tokens live here too).

**Welcome + owner lens (NEW 2026-06-19)** — `components/WelcomeScreen.tsx` is the front gate (gated in `Shell` via in-memory `entered`, so it shows every cold launch). First launch → "whose phone is this?" → "you're {name}?" confirm → binds the device (`lib/owner.ts`, `hb-owner`); thereafter it greets by name + shows the **throw-rail** (a filled two-segment Finance/Health switch) → throw to enter. The owner is then a **lens** (`lib/lens.ts` filters + persisted `hb-lens`, default `me`; `components/LensToggle.tsx` Mine/Household in each header): **Finance · Mine** = your accounts' cash (Joint as a small line) + your activity, with the shared next-move + sprint on top and budget/bills collapsed (also off the jump chips); **Health · Mine** = locks to the owner and hides the person toggle. "Household" restores the full picture in both. The household math is unchanged — the lens only changes display. Owner-change-in-Settings: offered, NOT built (today: clear `hb-owner`).

## Data model + Supabase
- Project `ganzefaciiyibselizqi`, `https://ganzefaciiyibselizqi.supabase.co`. Auth email+password; **RLS = authenticated-full (shared household)**. Tables: accounts, recurring, transactions, debts, savings_goals, paid_bills, merchant_rules, **foods** (v6). DDL in `supabase/schema*.sql`.
- **Test account = `claude-test@homebase.app` / `homebase123`** (an RLS backdoor; only in memory, not public). Do live-data fixes via a Node script signed in as this account (see the `feedback-do-reconciliation-for-him` memory). The publishable key `sb_publishable_907KbW_QmcTvL-wFHg-8yA_roZe8u_2` is the anon key — safe in the public bundle.

### ⚠️ Reconciled financial baseline (for any future restore)
Accounts: **Geo $1,566.26 · Xinyan $751.00 · Joint $18.74 = cash $2,336.00**. Debts: **Anthropic $99.10 · Amazon $189.68 · …6813 $591.09 · Mom-China $800 · …4728 $4,156.78 @26.49% = $5,836.65** (pre-test every debt is AT its original_balance — no prior payments recorded).

### ⚠️ NO SANDBOX (load-bearing)
Every tap in the deployed/preview app writes to the **live Supabase DB**. On 2026-06-18 Gino feature-tested thinking it was a sandbox → 7 stray `payDebtExtra` rows drove cash to −$266; restored exactly via a reversal script. **Health-mode food library + gauge + meal selection are local-first (localStorage) and do NOT touch Supabase** until `foods` syncs. A "practice mode" was offered, not built.

## OPEN ITEMS / pending Gino actions
1. ✅ **DONE (2026-06-18):** Gino ran `supabase/schema_v6.sql` — the `foods` table is live (RLS verified, reachable). **Food-library cloud sync is ON.** Each device's local foods migrate up on next open.
2. ✅ **DONE (2026-06-19):** new sign-ups are **disabled** in Supabase → Auth (verified by screenshot) — the open-signup hole the audit flagged is closed. RLS stays authenticated-full for the shared household; the test account still works.
3. To see the **new app icon** on a phone, remove + re-add the home-screen shortcut (PWA icons cache).
4. **Offered, not built:** owner-change in Settings (welcome owner currently changes only by clearing `hb-owner`); a "practice mode"/demo login (sandbox); logging the weekly scale over time (health trend).
6. **NEXT (Gino's plan):** redesign each mode's *layout* — how Finance and Health display info, now per **Mine vs Household** lens. The lens is the foundation; the layouts are the next pass.
5. **⚠️ NEVER re-seed** ("Clear all data" / re-seed wipes the reconciliation; merchant_rules + foods survive resetAll by design).

## Mode-layout redesign (2026-06-19) — lens-aware layouts
Each mode now has a distinct **Mine** vs **Household** layout:
- **Finance · Mine** — sticky header pins a 2-cell **vitals strip** (cash · debt); body = **upcoming bills** + your **activity**. No hero/sprint/budget.
- **Finance · Household** — a grid of **titled containers** (`ContainerCard`): Cash · Debt · Bills · Budget · Activity. `openContainer` state drills into one full-page (Debt = next-move hero + sprint + progress) with a `‹ All` back. Each section is gated `openContainer === "x"`; old jump-chips/`SECTIONS`/`useActiveSection` removed.
- **Health · Mine** — curated dashboard: `MacroNeeds` (from `lib/nutrition` `DAILY`) + a big **Scan a barcode** button (→ Meal Builder tab) + `PersonalWorkouts` (compact). Meal Builder is the other sub-tab.
- **Health · Household** — the full per-person plan (Gino/Xinyan toggle + `GinoPlan`/`XinyanPlan`), unchanged.
- Follow-up: the Health "Scan a barcode" button navigates to the Meal Builder tab; wiring it to auto-open the scanner (autoScan prop through MealBuilder→AddFoodSheet) is a refinement, not done.

## Backend audit (2026-06-19)
A 25-agent code audit + a read-only live-data check. **Live data is pristine** (cash $2,336.00, debts $5,836.65 all at original, 0 orphans, 0 non-reversible rows). Verified-correct: ledger math + exact reversibility (appliedAmount), the two earlier-fixed bugs, no-double-move on settled markers, lens-is-display-only, only the anon key in the bundle. Fixes shipped: SEED Xinyan 1095.75→751.00 (`89dd9cb`); **fail-closed money writes** — `applyMoneyEvent` now captures each balance-write error and `resyncLedger()`s to server truth so the UI can't keep a value that didn't persist (`5d69461`). **✅ `supabase/schema_v7_rpc.sql` RUN (Gino, 2026-06-19) + verified ($0 round-trip) + engine WIRED** — `FinanceStore.applyMoneyEvent` now calls `supabase.rpc("apply_money_event", …)` and `deleteTransaction` calls `reverse_money_event`, so the ledger row + cash/debt/goal move (or reverse) in ONE atomic transaction with in-row deltas (audit #2/#4 closed; `8edf108`). The old multi-step absolute-write path is gone; on any rpc error the client `resyncLedger()`s. Secondary direct-balance setters (`setAccountBalance`, `payDebt`, `contributeGoal`) still do absolute writes — lower-traffic, could move to deltas in a later pass. Import dedup is client-only (low risk: imported rows carry account_id:null, never double-move the anchored baseline) — a DB unique index is the durable fix.

## This session's commits (newest first)
- `5d69461` audit: fail-closed money writes + atomic-RPC migration (pending run)
- `89dd9cb` audit: SEED Xinyan balance → reconciled 751.00
- `8820ddf` Meal builder: large one-tap Scan + 'meals per day' question
- `3a5d277` Health Personal — curated dashboard (macros · scan · workouts)
- `962f66d` Finance Full — drill-in titled containers
- `e1ab062` Finance Personal — lean view (cash/debt + upcoming bills + activity)
- `76342b0` Finance — lens toggle into header
- `0d19667` Finance Mine — pinned vitals strip
- `171c550` Per-person owner lens — Mine / Household (filter + collapse)
- `4e2235e` Welcome switch — filled two-segment pill
- `634d6f0` Welcome screen — per-device owner + throw-rail mode switch
- `4517f3c` Simplified Chinese (中文) toggle
- `ccd647b` Food library cloud sync (Supabase) + high-res app icons
- `5a689b7` Mobile-app treatment (install shell + touch polish)
- `5b4df65` Meal builder: barcode scan + OpenFoodFacts
- `28a484f` Health mode — two-body plans, calibration gauge, meal builder
- `6fa469a` Redesign: unified "Mission Control" one-pager + instrument theme
- (`9b21d6b` and earlier = the pre-redesign pipelined-ledger app)

## Working with Gino (style)
Director/game-designer; AI-paired build. WHAT is his, HOW is mine. One piece at a time, design-lens language, no yes-man, state confidence, measure-don't-infer, never manufacture scope panic. He test-drives live (his loop is test→insight→architecture). Reconcile/setup chores: **do them FOR him** via script, never hand him manual setup. Full collaboration detail in the memory files (`feedback_*`).
