# Homebase — Project Status & Handoff

_Last updated: 2026-06-16. Single source of truth for resuming work (esp. after a context compact)._

Homebase is a **personal finance + (eventually) life-tracking web app** Gino is building for himself and his wife **Xinyan**. Installable PWA + Supabase cloud, shared live across their devices. Non-game project (separate from the Godot stealth game).

---

## 1. Stack & where things live
- **Repo:** `C:\Users\ginoc\Documents\homebase` — Vite + React 19 + TypeScript + Tailwind v4 + `lucide-react`.
- **Backend:** Supabase (`@supabase/supabase-js`). Realtime live-sync.
- **Node 24 LTS** (installed via winget this session; git was already present).
- **Run the dev server:** `preview_start` with name **`homebase`** (config in `C:\.claude\launch.json`, port 5173, runs powershell that refreshes PATH then `npm run dev`). Gino's separate `docs` static server is on 8777 — leave it.
- **Build/typecheck:** `npm run build` (runs `tsc -b && vite build`). In PowerShell, prefix node/npm commands with a PATH refresh:
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`

## 2. Supabase
- **Project ref:** `ganzefaciiyibselizqi` · org "Voeximus's Org" (free) · URL `https://ganzefaciiyibselizqi.supabase.co`.
- **Keys:** publishable key in `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) — client-safe, gitignored via `*.local`.
- **Auth:** email+password; email confirmation is OFF. RLS = any authenticated user has full access (shared household; security = locked signups).
- **Tables:** `accounts`, `recurring`, `transactions`, `debts`, `savings_goals`. DDL in `supabase/schema.sql` (v1) + `supabase/schema_v2.sql` (accounts+recurring). Run in the SQL editor (DDL needs the dashboard, not the publishable key).
- **Seeding:** Settings (⚙) → **"Set up my household"** calls `seedHousehold()` → inserts accounts, recurring, debts (guards against double-seed).
- ⚠️ **Open security TODOs (Gino, in dashboard):** delete test user **`claude-test@homebase.app`** (pwd `homebase123`) — shared-RLS backdoor; sign **Xinyan** up; then **disable new signups**.

## 3. The financial picture (their real numbers — verified, conservative)
**Accounts (live balances, the truth — seed these):** Geo `...4662` **$1,566.26** · Xinyan `...0366` **$1,095.75** · Joint `...1211` **$18.74** · **Total cash $2,680.75**.
- (Note: bank-statement CSV "ending balances" are stale snapshots — always use live online-banking numbers.)

**Income (conservative "2-paycheck month" — biweekly ×2, NOT 26/12):**
- Gino: **$1,800/check** (night-shift floor, variable hourly at "Treasure of Tech") → **$3,600/mo**
- Xinyan: **$1,187.42/check** fixed (ASU) → **$2,374.84/mo**
- **Combined fixed income $5,974.84/mo.** ~2 bonus 3-paycheck months/yr = upside.

**Fixed bills $3,081.19/mo:** Rent **$1,715** (Nollie; full rate from July — a "2 months free" $2,990 concession = ~$498/mo ran Jan–Jun and ENDED; lease 15mo, ~Mar 2027 end, no further increase) · Electric (SRP) ~$85 · **Mom $600** ($300/check from July; was $800 — her rent help + car insurance) · Verizon $83 · Spotify $14.04 · Card …4728 min $135 · Affirm $200 (winding down, ~$289 left, ends in ~1–2mo) · Spot Pet $99.93 · T-Mobile $27.48 · Apple $15.12 (Xinyan) · Claude Pro $21.62 (Xinyan) · Card …6813 min $85.
- **Split: 60/40 (Gino/Xinyan by income).** Shared = rent + electric; Xinyan sends her 40% (**$720/mo**) as one transfer into Geo; Gino pays shared bills. Mom = 100% Gino. Phones personal for now (may merge later).
- **Fixed net = +$2,893.65/mo** (BEFORE variable spend).

**Debts $5,836.65 (payoff target #1):** Card `…4728` **$4,156.78** (19.99% APR, ~maxed $4,300 limit) · Xinyan card `…6813` $591.09 · Affirm Anthropic $99.10 · Affirm Amazon $189.68 · **$800 owed to her mom in China**.

**Variable spend (from history; NOT yet in the app — to map next):** Groceries ~$850/mo · Gas/convenience ~$350 · Dining/takeout ~$490 · plus shopping/health/rideshare. Real breathing room after variable ≈ **~$1,200/mo**.

**Subscriptions:** KEEP — Spotify $14.04 (Gino), Apple $15.12 (Xinyan), Claude Pro $21.62 (Xinyan). **Gino's Claude Max ~$108 = ASTERISKED** (revisit; affordable). CANCELED/out — Uber One (BofA fraud claim), xAI/Grok (refund), Amazon Prime, Replit (canceled 6/16), Audible, Google, RentPlus.

**One-time (excluded from baseline):** China trip ~**$7,950** (visa/passport/flights + overseas remittances + friend Zelles) — returned 2026-06-16 AM, won't recur ~1yr. This (not lifestyle) caused the recent cash crunch.

**Source data:** `C:\Users\ginoc\Desktop\Finances\` — 2 BofA CSVs, paystubs PDF, joint-acct PDF, Lease.pdf, NollieApartmentsLedger.xlsx, 2 "Print Transaction Details" PDFs, 6 screenshots → analysis scripts (`consolidate.mjs`, `analyze.mjs`, `audit.mjs`, `readxlsx.cjs`, `readlease2.cjs`, `readactivity.cjs`) → `MasterLedger.csv` (486 categorized txns). **Re-audited — no missing fixed costs.**

## 4. What's built (all verified, type-clean, live)
- **Auth** (`src/auth/`): AuthProvider + LoginScreen; gate in App.
- **Data model** (`src/types.ts`) + **store** (`src/store/FinanceStore.tsx`): Supabase-backed, realtime, optimistic writes. Multi-account + recurring + transfer concept. `seedHousehold()` + `resetAll()`.
- **Dark full-browser dashboard** (`src/views/Overview.tsx`) — clone of a reference fintech design Gino chose. Top-nav pills (Home/Accounts/Recurring/Debts) + "+Add" + avatar + Logout (in `App.tsx`). Violet (#7c5cff) accent, dark bg (#06070b) w/ radial glows. **3-col grid of EXPANDABLE panels** (each ⤢ opens a detail modal): Cash flow (income-vs-bills 2-line chart), **Where it goes (donut/pie)**, Account card (selectable), Payees, Wallet (total cash + tiles), **Breathing-room gauge** (net/income = 48%), Quick access.
- **Views (all dark-cohesive):** Accounts (per-account pipelines: in/out/net + household total), Recurring (grouped fixed income/bills), Debts (per-debt payoff + add/pay sheets), Transactions/Activity (ledger + add/delete). `Savings.tsx` exists but is light + unreachable from nav (deferred).
- **Shared UI** (`src/components/ui.tsx`): dark Card/Button/Sheet/inputs/Segmented/EmptyState/pickers.
- **Helpers:** `src/lib/recurring.ts` (monthlyAmount, accountFlow, householdMonthly, totalBalance — `CADENCE_TO_MONTHLY.biweekly = 2` conservative), `src/lib/household.ts` (the seed data), `src/lib/seed.ts` (categories), `src/lib/format.ts`.

## 5. Goals (Gino's priority order — drives the budget)
1. **Clear debt — first and foremost** (the $5,836; attack the 19.99% card first / avalanche)
2. **China apartment fund** — set aside into RMB monthly, long horizon
3. **Game-studio capital** — build investment runway for the studio he wants to start
4. **Emergency fund**

## 6. ▶ ROADMAP — projected next steps (resume here, "build upward")
The budget/strategy is the next big build. In order:
1. **Map variable costs** into the app — groceries/gas/dining etc. (seed estimates from history or design the going-forward logging). Needed for true monthly burn.
2. **"This month" view** — next check (~$1,800, but NEXT one is light: sick days used for trip), bills still due this cycle, and free cash remaining.
3. **Time the ~$482 dental deep-clean** against that cash-flow.
4. **4-goal budget/strategy** — allocate the ~$1,200/mo real surplus: debt-first payoff plan, then split toward China RMB fund / studio / emergency. Model payoff timelines.
5. **Live cash-flow chart** — replace the income-vs-bills projection with a REAL time-series of total cash. Needs a balance-snapshot mechanism (record total cash over time; backfill recent month-end balances from statements so it opens with real history, then grows with use). Gino flagged the current projection as "useless / linear."
6. Later: bank-PDF import (Claude API), groceries/macros, broader life-tracking.

## 7. Gotchas / how to operate this repo
- **`preview_screenshot` usually TIMES OUT when logged in** (realtime websocket blocks network-idle). Use **`preview_eval` DOM reads** to verify (read `main` innerText, sample `getComputedStyle`), or query Supabase REST directly with the session token. Screenshots work on the login screen.
- The preview browser is a **separate session** from Gino's browser; to verify against live data, sign in as the test account (`claude-test@homebase.app` / `homebase123`).
- **Built-in PDF `Read` fails** here (no `pdftoppm`/poppler) → use `pdf-parse@1.1.1` + SheetJS `xlsx` (installed in `Desktop/Finances`).
- To verify visually, size viewport wide (`preview_resize` 1440×900) — the dashboard is `lg:grid-cols-3`.
- After editing `.env*`, restart the dev server (Vite reads env at start).
