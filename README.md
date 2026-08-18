# Homebase

A private finance + health PWA for a two-person household. Installable, cloud-synced,
live bank feed. Built by Gino Cirino for himself and Xinyan Li.

Not a product. Two users. It runs a real household's money.

---

## 👉 New here? Read [`docs/ACCOUNTANT_BRIEF.md`](docs/ACCOUNTANT_BRIEF.md) first.

That is the handover document: how to get access, how to read the live data, the
current financial picture, and — most importantly — **the accounting conventions
that are not visible in the code.** Several of them look like bugs and are not.
Changing one without reading the brief will silently corrupt what the household
believes about its own money.

---

## Stack

- **Vite + React 19 + TypeScript + Tailwind v4**, `lucide-react` icons
- **Supabase** — Postgres, auth, realtime sync, edge functions
- **Plaid** — live Bank of America feed (⚠️ production only, no sandbox)
- **PWA** — installable, web push, prompt-style updates
- **GitHub Pages** — deploys on push to `main`

## Running it

```bash
npm install
npm run dev
```

Needs a `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
Vite reads env at startup — restart the dev server after editing it.

```bash
npm run build      # tsc -b + categorizer sync check + vite build
npm run lint
npm run snapshot   # SUPABASE_PAT=<token> npm run snapshot — dump live finance state
```

## Layout

```
src/
  types.ts                 the domain model — best-commented file, start here
  lib/
    plan.ts                budget envelope, pay cycles, payoff schedule
    schedule.ts            the calendar engine — cadence, anchors, bill windows
    forecast.ts            12-month projection, built on monthlySchedule
    changelog.ts           releases — the TOP entry defines APP_VERSION
  store/FinanceStore.tsx   Supabase-backed, realtime, optimistic writes
  views/redesign/          the five tabs: Home, Activity, Insights, Bills, Forecast
supabase/
  schema_v*.sql            migrations in order, v1 → v27
  functions/               plaid, plaid-webhook, cron-notify, notify, announce-update
docs/
  ACCOUNTANT_BRIEF.md      ⭐ start here
  HANDOFF.md               historical session log, reverse-chronological
```

## Shipping a release

Add a new entry at the **top** of `src/lib/changelog.ts` with a fresh `version`.
`APP_VERSION` derives from it, and the deploy workflow fires a push notification to
both phones only when that version changes — so ordinary commits stay quiet.

Write the notes in plain language about what the user experienced, not what the
code does.

**Edge functions deploy automatically** when anything under `supabase/functions/`
or `supabase/config.toml` changes — see the `functions` job in the workflow. It
requires the `SUPABASE_ACCESS_TOKEN` repo secret.

⚠️ They still carry their **own copies** of the scheduling rules — they do not
share `src/lib`. Automatic deployment ships whatever those copies say; it does not
keep them in agreement. Port model changes by hand.

⚠️ `supabase/config.toml` declares which functions are public (`verify_jwt =
false`). Three must stay that way or release notifications and the Plaid webhook
break. Read the comment in that file before touching it.

## Docs

| File | What it is |
|---|---|
| [`docs/ACCOUNTANT_BRIEF.md`](docs/ACCOUNTANT_BRIEF.md) | **The handover.** Access, data model, the rules, the trap catalog. |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Historical session log — what changed when, and why. |
| [`docs/STATUS.md`](docs/STATUS.md) | Superseded. Kept for history only. |
