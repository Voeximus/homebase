# Homebase → Muse: the bridge plan

Written 2026-09-26. Revised the same day after a hard review — twelve blockers and
thirteen smaller problems were found in the first draft, and every one of them is
addressed below. Where a fix could not be settled from a desk, it became a test on
his phone instead of a guess. One document, meant to be built from.

## How to read the tags

Every factual claim below carries one of these. I am being strict about it because
Meta shipped Muse eighteen days ago and most of what is written about it is wrong.

- `[verified: url]` — that page was opened while writing this revision, and the
  words quoted are on it.
- `[verified by research: url]` — a Meta-owned page, opened and quoted by the
  research pass that fed the first draft. Not re-opened. Treat as solid but
  second-hand.
- `[blog only: url]` — one person's write-up. Could be right. Could be stale.
- `[unverified]` — nobody has confirmed this. Usually because Meta has published
  nothing.
- `[code: path:line]` — read out of this repo. This is the most reliable category
  in the whole document.
- `[from him]` — something Gino said. Not checkable, and if it is wrong the plan
  changes, so it is flagged rather than folded in silently.

### The other marker: ⏱ PHONE TEST FIRST

Several good ideas in here rest on Muse behaviour that Meta has not written down
anywhere. None of them are deleted. Each one is parked behind a block like this:

> ⏱ **PHONE TEST FIRST — about 20 minutes.** Exactly what to do, and what result
> means go / stop.

All of those tests are collected in §9 Phase 0 and cost nothing but his time.
Nothing downstream of a failed test gets built.

---

## 1. What Muse can and cannot do

### The one sentence the whole plan rests on

Meta's own security write-up says:

> "Muse can also write its own custom connectors for other services you care
> about if they have their own APIs or CLIs."

`[verified: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse]`

And the help centre confirms the ordinary-person version of it:

> "If you want to connect to a service not yet available in the Connector list,
> you can ask Muse to create a Custom Connector."

`[verified: https://www.meta.com/help/artificial-intelligence/1687253048996149/]`

That is the doorway. You do not need Meta's permission, a partnership, a review,
or a place in a public directory. You give Homebase a small public API and ask
Muse to build against it, from the phone, in a chat.

### Available today

| What | How well established |
|---|---|
| Muse exists, launched 8 Sep 2026, US, iOS + Android + muse.ai | `[verified by research: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/]` |
| Muse can build its own connector to any service with an API | `[verified: research.meta.ai security blog]` |
| It can read from that connector, and write to it if you allow | `[verified: https://www.meta.com/help/artificial-intelligence/1687253048996149/]` — "Many Connectors can also be set up so that Muse is only able to retrieve data, but not take actions" |
| Your API key is held in a "Secure Credentials Store" and the AI model never sees it — it sees a stand-in, and the real key is swapped in as the request leaves | `[verified: https://www.meta.com/help/artificial-intelligence/1687253048996149/]` + `[verified: research.meta.ai security blog]` — "The agent never sees real tokens, which means any attempt to coerce the agent to reveal the actual secrets via prompt-injection or otherwise is futile." |
| Recurring tasks: daily, weekly, or a custom interval | `[verified: https://www.meta.com/help/artificial-intelligence/1484325780075655/]` |
| Reminders arrive as **chat messages**, not notifications | `[verified: https://www.meta.com/help/artificial-intelligence/1484325780075655/]` — "Reminders are delivered as messages in your conversation with Muse." I asked that page for any sentence containing notification, push, alert, alarm, snooze or sound. There are none. |
| Muse is free up to a usage limit, and there is a paid tier above it | `[verified: https://www.meta.com/help/subscriptions/1625680452306909/]` — "If you reach your free usage limit and want more usage, you can upgrade to a paid subscription, or you can wait until your free usage limit refreshes." **No price is published on that page.** See §8. |

### The calendar — I got this wrong in the first draft, and it matters

The first draft said Muse already connects to Google Workspace, so it reaches his
calendar with no Homebase work at all. **That is not supported.** I opened the
connectors help page again and read every named service on it. The connectors it
names are Facebook, Instagram, Threads, Gmail, Apple Health and Android SMS. The
word Google appears exactly once, in a legal footnote: "When connecting to Google,
the use of information received from Workspace APIs will adhere to the Google User
Data Policy, including the Limited Use requirements."
`[verified: https://www.meta.com/help/artificial-intelligence/1687253048996149/]`

A footnote about a policy is not a list entry. So:

**Claim: Muse can read and write his Google Calendar.** `[unverified]`

This is the half of his sentence that was actually right, and the whole "zero
Homebase work on the calendar" conclusion rests on it, so it gets a test rather
than a tag.

> ⏱ **PHONE TEST FIRST — 10 minutes. This is Phone Test 4 in §9.**
> On his phone, open Muse → Connectors and look for Google, Google Calendar or
> Google Workspace in the list. If it is there, connect it, then ask Muse "what is
> on my calendar Thursday" and then "put Homebase test at 3pm Friday on my
> calendar" and check the Google Calendar app.
> **Reads work → the plan stands as written.** **Reads work, writes do not →
> `schedule.bill_events` still earns its place, Muse just reads it out instead of
> writing events.** **No Google connector at all → the calendar comes back into
> Homebase's scope and this plan grows a section it does not have yet. Stop and
> re-plan before Phase 1.**

### Not available, and this is the honest part

**Google Clock is not a thing Muse can do, and never will be from the cloud.**
There is no clock or alarm connector in Meta's documentation. It could not exist
as a cloud connector even if Meta wanted it — Google Clock has no cloud API for
anyone, and the only documented way to create an Android alarm is an on-device
Intent (`ACTION_SET_ALARM`) that needs a permission and an app running on the
phone. `[verified by research: https://developer.android.com/reference/android/provider/AlarmClock]`
A server cannot reach into a phone and set an alarm. Calendar maybe. Clock no.

He said waking up is not the deciding issue, so this is a footnote rather than a
blocker — but the premise as spoken was half wrong and he should know which half.

**Muse does not speak MCP on the phone.** The words "MCP" and "Model Context
Protocol" appear nowhere in Meta's launch post, the connectors help page, or the
security blog — I checked the security blog directly for it and it is absent
`[verified: research.meta.ai security blog]`. MCP shows up only in Muse Code (a
terminal tool for programmers, which cannot be driven from a phone
`[verified by research: https://github.com/meta-models/muse-code-sdk/issues/36]`)
and in a separate developer-preview sign-up sheet. Anyone who says "just expose
Homebase over MCP" is describing a different Meta product. **The Homebase side is
a plain REST API.** That is less work anyway.

**There is no household Muse.** Muse is tied to one Meta Account. Nothing in
Meta's help centre describes two people sharing one Muse.
`[verified by research: https://www.meta.com/help/artificial-intelligence/1331373868832401/]`
Homebase is deliberately two people sharing one ledger on two phones. That part
of Homebase has no Muse equivalent and cannot be handed over. Gino and Xinyan
would each need their own Muse and their own connectors pointing at the same
Homebase.

**Meta does not check any of this.** Same page as the doorway quote:

> "Meta doesn't review custom connectors or how they use your information, so
> grant access with caution and review the provider's privacy policies."

`[verified: https://www.meta.com/help/artificial-intelligence/1687253048996149/]`

Whatever protection the Homebase door has is the only protection there is.

**Nobody can read the contract.** `muse.ai/platform/terms` returns HTTP 401
Unauthorized. No fee, no revenue share, no rate limits, and no quotas are
published anywhere. `[verified by research: https://muse.ai/platform/terms]`
Do not plan capacity or cost from any number in any blog — two of the most-quoted
figures turned out to be about an unrelated job-listings API and about Meta's
developer coding tool.

**Nobody has published what a phone-built connector accepts on the wire, either.**
The first draft cited `dev.meta.ai/products/connectors` for "OpenAPI is accepted".
I opened it. It is a **different product** — the enterprise "Meta AI Connectors"
developer preview, application-gated ("Spots are limited. We're selecting
developers in waves based on readiness and alignment"), whose own sign-up form
asks for a "REST API (OpenAPI / Swagger spec)", whose named auth model is "Use
OAuth account linking so people can securely connect their existing account to
your service", and which sends Muse builders elsewhere: "Build with Muse
Connectors — Learn more (https://muse.ai/platform)"
`[verified: https://dev.meta.ai/products/connectors]`. And muse.ai/platform is the
page behind the 401.

So two things the first draft treated as settled are not:

- **Serving an OpenAPI description helps Muse build the connector.** `[unverified]`
  Serving it still costs nothing, so we serve it. We just do not claim it is what
  Muse reads.
- **A Custom Connector accepts a long-lived static bearer token.** `[unverified]`
  The only Meta page that names an auth scheme for connectors names OAuth. All of
  §4 and §9 Phase 1 rest on the static token.

> ⏱ **PHONE TEST FIRST — 20 minutes. This is Phone Test 2 in §9.**
> Stand up the throwaway endpoint from Phone Test 1 and ask Muse to build a
> connector against it. When it asks how to authenticate, give it the secret and
> see what it does with it. Test three transports in one sitting: the secret in
> `Authorization: Bearer`, the same secret in a custom header `X-Muse-Token`, and
> a deliberately malformed `Authorization` value.
> **A static secret works in either header → build as written, and record which
> header in §2 as verified.** **It insists on OAuth → the door needs a minimal
> OAuth authorisation-code flow. That is several days of extra work and it turns
> revoking from "change a secret and redeploy" into token management. Decide
> whether the project is still worth it BEFORE Phase 1, not during it.**

**The load-bearing unknown, still.** Does a Custom Connector *persist* across
conversations, or does he rebuild it every time? One developer's write-up says
Muse saved an integration as a reusable skill available in later conversations
`[blog only: https://parallel.ai/articles/meta-muse-custom-integrations]`. Meta
has published nothing either way `[unverified]`. Redoing setup is his single
biggest frustration with software, so this is Phone Test 1 and everything waits
behind it.

### So which parts of "Muse becomes the assistant" are real?

Real today: asking questions in plain speech and getting Homebase's real numbers
back. Taking a small number of safe actions.

Depends on a test: whether it stays set up. Whether a static token works. Whether
it reaches his calendar at all.

Not real: Muse ringing a reliable bell, Muse setting an alarm, Muse being the
shared place he and Xinyan both see, Muse running the overnight jobs.

---

## 2. The architecture

Homebase stays the system of record. Muse becomes one more mouth on the front of
it — a good one, but not the truth.

### The flow, in words

```
  his phone / her phone
        │
        ├──────────────► Homebase PWA  ──────────────┐   (unchanged; still the
        │                (GitHub Pages)              │    place truth is edited)
        │                                            │
        └──────────────► Muse app                    │
                           │                         │
                           ▼                         │
                    Muse Secure VM (Meta's cloud)    │
                           │                         │
                    Sentinel  (Meta's outbound gate) │
                           │                         │
                    plain HTTPS + one secret         │
                     ┌─────┴─────┐                   │
                     ▼           ▼                   │
        ┌──────────────────┐ ┌──────────────────┐    │
        │ READ DOOR        │ │ WRITE DOOR       │    │
        │ functions/       │ │ functions/       │    │
        │   muse-read      │ │   muse-write     │    │
        │ · own secret     │ │ · own secret     │    │
        │ · reads only     │ │ · queues a tap   │    │
        │ · no write verb  │ │ · never applies  │    │
        └────────┬─────────┘ └────────┬─────────┘    │
                 │                    │              │
                 ▼                    ▼              ▼
             Supabase Postgres (18 tables + 4 new, service role)
                 │                    │
                 │                    └──► muse_pending ──► push ──► he taps in
                 │                                                    the APP,
                 ▼                                                    app writes
             existing push pipeline
             pg_cron → cron-notify / cron-reminders → both phones
```

Two doors, not one. That is a change from the first draft and §3 explains why.

### Where the doors live: Supabase edge functions. Justified.

Yes, and for a reason stronger than convenience: **this repo has already built
and hardened exactly this shape three times.**

`supabase/config.toml` says three of the existing edge functions are deliberately
public because their callers cannot present a Supabase login — the GitHub deploy
workflow, Plaid's servers, and pg_cron `[code: supabase/config.toml]`. Muse's VM is
a fourth caller of exactly that kind. It cannot hold a Supabase session.

And the repo has already learned the trap, in writing. `callerAuth.ts` opens with:

> "Setting `verify_jwt = true` on an edge function does NOT mean 'only a
> signed-in user can call this'. It means 'the request carries a valid project
> credential'. The publishable key is a valid project credential, and it is
> compiled into the browser bundle by design."

`[code: supabase/functions/_shared/callerAuth.ts:1-20]`

That file records a live audit where an anonymous caller holding nothing but the
public key reached the `plaid` function's `disconnect` action, which hard-deletes
every transaction and account on a connection. **So the doors must never be "give
Muse a Supabase login."** That would hand it everything, because 17 of the 18
tables carry the identical rule — any signed-in account may read and write every
row `[code: supabase/schema.sql:46-60]`.

Each door is instead a new public function with its own secret, the same
fail-closed shape `cron-notify` already uses `[code: supabase/functions/cron-notify/index.ts:97-99]`.

Rejected alternatives, briefly:

- **A new server somewhere else.** More to run, more to pay for, nothing gained.
- **Muse talking straight to Supabase's REST API.** This is the dangerous one,
  and it is the obvious shortcut. It skips every guard in the app, because every
  guard in the app lives in the browser — the write guards in `reviewApply.ts`,
  the day-merge logic in `HealthStore.tsx`, the debt resolution in
  `FinanceStore.tsx`. Only three database functions enforce anything server-side.
  Anything talking directly to Postgres is unprotected by construction.
- **MCP.** Not supported on the phone. Verified above.

### What it speaks

Plain HTTPS, JSON, one POST per tool, the secret in a header (which header is
decided by Phone Test 2, not by preference). We also publish an OpenAPI
description at `/muse-read/openapi.json` and `/muse-write/openapi.json` because it
is a few lines and might help — but see §1: nobody has published that Muse reads
one `[unverified]`.

Not MCP. If that ever changes, the same functions get an MCP wrapper later; the
tools do not have to be rewritten.

### Rule 1: the door must not do arithmetic

This is the most important engineering decision in the document, and the repo
already contains the proof.

`cron-notify` needed the same numbers the app shows, so it re-implemented them in
Deno by hand. Its own comments record what happened, three separate times
`[code: supabase/functions/cron-notify/index.ts]`:

- "a semiannual insurance bill and a yearly membership were pinging the phones on
  their due DAY of EVERY month"
- "the phones were being told a support payment paused until November, a car
  payment that starts in September, and a dental plan that ends in January were
  all due tonight"
- "a push said 'Electric $85' while every screen in the app said $100"

Every one of those is a hand-written mirror drifting from the real function. A
door that re-derives firepower, the forecast low point, or the audit will drift
the same way — and it will drift into a chat, where there is no screen beside it
showing the right number.

So: **the doors import the real modules.** They are importable — no React, no
Supabase client, pure functions over `AppData` `[code: src/types.ts:206]`.

### Rule 2: the door must not read the clock either

This one nearly shipped as a bug, and it would have looked like an architecture
problem instead of a clock problem.

The shared modules read the machine's own calendar date when you do not hand them
one. There are eight such defaults `[code: src/lib/forecast.ts:81, src/lib/ledgerReview.ts:409,
src/lib/plan.ts:198,677,723, src/lib/recurring.ts:42,64, src/lib/selfAudit.ts:98]`.
`todayISO()` returns the **local** calendar date, and `format.ts` spells out in its
own comment why it must: the household is in Arizona (UTC-7, no DST), and
"from 5pm local onward UTC has already rolled over and every entry was stamped
with TOMORROW's date" `[code: src/lib/format.ts:20-32]`.

A Supabase edge function runs in UTC. So from 5 PM Arizona onward, a door that let
one of those defaults fire would answer about **tomorrow** — a different pay cycle,
different bills due, a different low day — and on the last evening of a month, about
the next month. `cron-notify` already had to hand-fix this with
`new Date(Date.now() - 7 * 3600 * 1000)` `[code: supabase/functions/cron-notify/index.ts:101]`.

He works nights `[from him]`. Roughly 6 PM to 6 AM is almost entirely inside the
broken window. This is not an edge case for him; it is most of his waking day.

The rule, and it goes in the door's code as a comment as well as here:

1. One helper, `supabase/functions/_shared/muse/az.ts`, returns the Arizona `now`.
   It does **not** use the subtract-seven-hours trick, because that only works
   while the runtime happens to be UTC. It builds the date from the IANA zone so
   it is right whatever the machine thinks:

   ```ts
   // The Arizona "now", as a Date whose LOCAL fields are Arizona's — which is
   // what every copied module reads (getFullYear/getMonth/getDate).
   export function nowAZ(at: Date = new Date()): Date {
     const f = new Intl.DateTimeFormat("en-US", {
       timeZone: "America/Phoenix",
       year: "numeric", month: "2-digit", day: "2-digit",
       hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
     }).formatToParts(at);
     const g = (t: string) => Number(f.find((p) => p.type === t)!.value);
     return new Date(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
   }
   ```

2. Build it **once** at the top of the request and pass it explicitly into every
   entry point. Never let a default fire.
3. CI greps the doors' own files (`supabase/functions/muse-read/**`,
   `muse-write/**`) for `new Date(`, `Date.now(` and `todayISO(`, and fails the
   build. The only allowed clock reading in the whole door is inside `az.ts`.
4. A test runs every tool twice, once with the machine clock in UTC and once in
   Arizona, and requires byte-identical output. That is the test that catches a
   forgotten argument, which the grep cannot.

### Rule 3: the door must not assemble a function's inputs either

This is the rule the first draft was missing, and it is why the first draft picked
the wrong Phase 1 tool.

The number on the hero tile is **not** `planMath().firepower`. The app computes it
as `planMath().firepower − overspendMonth − outsideBudgetCash`, where both
subtractions are assembled in a view module `[code: src/views/redesign/buildVMs.ts:107-128]`.
A door that called `planMath` and reported `firepower` would return a real number
from a real shared function and still disagree with his screen — and by Rule 1's
own logic, the door assembling those subtractions itself *is* the door doing
arithmetic.

`forecast()` is worse. Its inputs (`openingCash`, `cycleSpend`, `cardPay`,
`cardDebtId`) are assembled **nowhere in the app at all** — see the next section.

So: **input assembly lives in a shared pure function that the app also calls.**
Where that function does not exist yet, writing it is part of the phase, not part
of the door. Concretely, Phase 1 extracts the numbers-only part of `buildVMs.ts`
into `src/lib/headline.ts`, which both `buildVMs` and the door import. `buildVMs.ts`
has no React in it `[code: src/views/redesign/buildVMs.ts:6-39]`, so this is a move,
not a rewrite.

### Rule 4: every string that leaves the door is scrubbed

The first draft only thought about injection in one direction — a web page talking
Muse into calling the door. The other direction is the more likely one and it was
missing.

Everything the door says lands in Muse's context as **trusted output from a
connector he installed**. And some of those strings are typed by people:
`transactions.description` is free text either of them enters
`[code: supabase/schema.sql:9-18]`, and a bank descriptor or a payment memo line is
written by whoever sent the money. Recurring row names flow into the forecast, bill
names flow into `next_bills`, and merchant descriptors flow into `worth_a_look`
via `merchantKey(tx.description)` `[code: src/lib/ledgerReview.ts:743]`. "No raw
ledger rows" does not touch any of this, because names and sentences are not rows.

So, in the door's code, one function every outbound string passes through:

- strip newlines and control characters,
- cap at 64 characters,
- strip anything URL-shaped (`http`, `://`, `www.`) and anything instruction-shaped
  (`ignore previous`, `system:`, `assistant:`, backticks, `{{`),
- **never emit `description` or a raw bank descriptor at all**, under any tool,
- prefer ids and numbers to names wherever a name is not needed.

If a string cannot survive that, the door sends the id instead and lets the app be
the place names are read.

### Rule 5: every table read is paged, and fails closed

PostgREST silently truncates a select at 1000 rows. This repo has already paid for
that lesson and written it down: "Page explicitly: PostgREST caps a select (1000
rows by default) and truncates SILENTLY, and a first sync can span 24 months — a
half-armed guard would look like it worked and still double part of the history"
`[code: supabase/functions/plaid/index.ts:391-395]`.

The doors have to load whole tables to build `AppData`. Today's ledger is small,
so a bare select would work and keep working until it quietly did not — and then
every number Muse speaks (the forecast, firepower, all eight audit checks) would be
computed from a truncated ledger, in a chat, with no screen beside it. That is the
exact failure this whole plan exists to prevent.

So: every read in the door uses the `range(from, from + PAGE - 1)` loop already
written in `plaid/index.ts`, and on top of it compares the number of rows returned
against a `select(count)` on the same filter. If they disagree, the door answers
"I could not read the ledger cleanly" and nothing else. It never computes from a
partial set.

The app's own loader has the same exposure — a bare `select("*")` with no range
`[code: src/store/FinanceStore.tsx:596]`. Worth fixing while the lesson is in hand,
but it is app work outside this plan's scope; noted here so it is not lost.

### How the shared copies are kept honest: generate them, do not copy them

The first draft said to copy ten modules into `_shared/` and add them to the
existing drift guard. Both halves of that were wrong.

**The existing guard cannot accept these files.** `scripts/check-categorizer-sync.mjs`
normalises exactly one difference — a same-folder `from "./name.ts"` becomes
`from "./name"` — and every pair it watches only imports siblings
`[code: scripts/check-categorizer-sync.mjs, the norm function]`. But twelve modules
in `src/lib` import `"../types"`, a parent path that must be spelled differently in
a flat edge folder `[code: src/lib/plan.ts:8, forecast.ts:1, schedule.ts:1,
recurring.ts:1, household.ts:6, ledgerReview.ts:1, selfAudit.ts:1, reviewEngine.ts:30,
reviewTypes.ts:26]`. Adding them to `PAIRS` fails the build on the first commit,
forever.

**And it is not ten files.** The real list, walked import by import:

| File | Lines | Why it is on the list |
|---|---|---|
| `src/types.ts` | 216 | every module imports it |
| `src/lib/format.ts` | 76 | dates and money |
| `src/lib/household.ts` | 90 | cadence maths |
| `src/lib/recurring.ts` | 98 | balances, live-on |
| `src/lib/plan.ts` | 789 | firepower, pay cycles, payoff |
| `src/lib/schedule.ts` | 459 | bill calendar, due-before-payday |
| `src/lib/forecast.ts` | 260 | the low point |
| `src/lib/selfAudit.ts` | 619 | the eight checks |
| `src/lib/categorize.ts` | 942 | pulled in by `ledgerReview` — **already has an edge copy** |
| `src/lib/categorizeData.ts` | 138 | pulled in by `categorize` — **already has an edge copy** |
| `src/lib/i18n.ts` | 44 | `ledgerReview` and `reviewEngine` build text through `t()` |
| `src/lib/i18n_zh.ts` | 933 | pulled in by `i18n` |
| `src/lib/i18n_zh_auto.ts` | 528 | pulled in by `i18n_zh` |
| `src/lib/muscleRegions.ts` | 66 | pulled in by `i18n_zh` — yes, really |
| `src/lib/exerciseData.ts` | 216 | pulled in by `muscleRegions` |
| `src/lib/reviewTypes.ts` | 161 | the fix descriptors |
| `src/lib/ledgerReview.ts` | 1154 | the eight judgement rules |
| `src/lib/reviewEngine.ts` | 253 | wraps them |
| `src/lib/headline.ts` | new | Rule 3 — extracted from `buildVMs.ts` |
| `src/lib/nutrition.ts` | 213 | health side |
| `src/lib/mealLog.ts` | 185 | health side |
| `src/lib/adherence.ts` | 165 | health side |
| `src/lib/weightLog.ts` | 56 | health side |
| `src/lib/workoutLog.ts` | 229 | health side |
| `src/lib/trainingMath.ts` | 288 | health side |

**Twenty-five files, about 8,200 lines**, against seven guarded pairs today. Note
the third row from the bottom of the finance block: the Chinese translation file
drags the *exercise library* into the finance door, because `i18n_zh` imports
`muscleRegions` which imports `exerciseData`. Nobody would ever guess that by hand.
"No new invention, the existing pattern extended" undersold this badly.

**So the copies are generated, not hand-maintained.** A small script,
`scripts/gen-muse-shared.mjs`, wired into `npm run build`:

- reads the list above,
- writes each file into `supabase/functions/_shared/muse/`,
- rewrites `from "../types"` → `from "./types.ts"` and `from "./x"` → `from "./x.ts"`,
- stamps a header on each: `// GENERATED — DO NOT EDIT. Source: src/lib/plan.ts.
  Run: npm run gen:muse-shared`,
- and in `--check` mode (what CI runs) regenerates into memory and fails the build
  if any file on disk differs.

Drift becomes impossible rather than merely caught. The seven existing pairs stay
exactly as they are; this is a separate folder and a separate script.

One source change is needed before `i18n.ts` can be generated: it reads browser
storage as a side effect while assigning a module-level variable
`[code: src/lib/i18n.ts:11-14]`. In Deno, touching `localStorage` can throw, and if
it throws at import time the whole function fails to start — not one tool, the whole
door. Wrap that initialiser in try/catch inside `i18n.ts` itself. One line, correct
on both sides, and the generated copy stays a faithful copy.

Then, because the generated copy has no browser storage to read from, the door sets
the language explicitly at the top of every request from the person's own setting —
`setLangVar(lang)` `[code: src/lib/i18n.ts:19-21]`. Without that line, every
suggestion sentence reaching Xinyan's Muse comes back in English. One line, but it
has to be written before Phase 3 hands her a token, not after she notices.

### The snapshot alternative, and where it is actually right

Having the app write a summary row that the door reads is worse for the fast reads,
because the snapshot is only as fresh as the last time somebody opened the app, and
the whole point of an assistant is answering when the app is closed.

But it is the right answer for the two slow tools, and §9 Phase 2 measures which
those are. A Supabase edge function gets **2 seconds of CPU time** per request,
**256 MB of memory**, and a **20 MB bundle** `[verified: https://supabase.com/docs/guides/functions/limits]`.
`finance.audit` runs eight checks over the whole ledger (619 lines) and
`finance.worth_a_look` runs eight rules that loop recurring rows against charge
cycles against transactions (1,154 lines), on top of parsing about ten tables and
cold-starting 8,200 lines of TypeScript. At today's ledger size that is almost
certainly fine. The first draft asserted it; Phase 2 measures it instead.

---

## 3. The tool catalogue

### Permission classes — and why CONFIRM is gone

The first draft had a class called CONFIRM, meaning "a write, and Gino taps
approve in Muse". **That is not a control Homebase can enforce, and it collapses
after one tap.** Meta's own wording for the approval choices:

> "Always allow: Muse can take this type of action for this Connector in the
> future without asking again"

`[verified: https://www.meta.com/help/artificial-intelligence/1385290430137537/]`

The unit is a *type of action* on a *connector*, in the future — not this one
action. And the security blog says: "Read-only, **previously allowed**, or
demonstrably low-risk actions can proceed without interruption"
`[verified: research.meta.ai security blog]`. The first draft quoted that sentence
in §5 and dropped the middle term, which is the one that breaks its own model.

Meta never defines how wide "type of action" is. So with one door, the moment he
taps Always allow to make weigh-ins frictionless — which the first draft
explicitly recommended — he may also have silently and permanently auto-approved
charge categorising, bill-amount edits and push notifications. The door cannot
tell an approved write from an auto-approved one, so **it must treat every write
as unattended.**

Two changes follow.

**Change one: two doors, two secrets, two connectors.** `muse-read` holds the reads.
`muse-write` holds everything that changes anything. Whatever grain "type of action"
turns out to have, an Always-allow granted on one connector cannot reach the other.

> ⏱ **PHONE TEST FIRST — 15 minutes. This is Phone Test 5 in §9, and it runs in
> Phase 3 once two write tools exist.** Grant "Always allow" on one write, then ask
> for a *different* write on the same connector and watch whether it asks again.
> **It asks → the grain is per tool and the split is belt-and-braces.** **It does
> not ask → the grain is per connector, and the split is the only thing standing
> between a weigh-in and a money write.** Either way the split stays; this test
> tells us how much it is carrying.

**Change two: confirmation moves inside Homebase, where it can be enforced.** The
app already has the shape for it — "nothing writes to Supabase without a tap… one
descriptor into one store call, in response to one tap, from a sheet where the
person is looking at both numbers" `[code: src/views/redesign/reviewApply.ts:1-19]`.

So the classes are now:

- **READ** — Muse may call it freely, on the read door. No side effects.
- **QUEUED** — the write door writes a row to `muse_pending`, fires the existing
  push, and **nothing changes in the ledger**. The write lands only when he taps
  it in the app, where the existing re-read-and-refuse guards run. If he never
  taps, it expires in 24 hours.
- **DIRECT-SMALL** — a short list of writes whose worst case is "a wrong row he
  can see and delete", allowed to land without a tap. Exactly three things qualify
  (below), and every one is visible in the app within one screen.
- **FORBIDDEN** — the door has no such endpoint. Not "disabled". Absent.

And the standing instruction: **do not use Always allow for anything**, because it
buys friction back on the read door where nothing is at risk, and on the write door
it buys nothing at all now that the tap lives in Homebase.

"Already computed" below means the function exists and is tested; the door only has
to call it with an explicit Arizona `now` and shape the reply.

**These tables are the DESIGN, not the built door.** They list what was planned and
in what phase. What actually shipped is **eleven reads and seven writes**, and
`API.md` is the built list — it is generated against the doors' own code and a test
fails the build if the two disagree. Four tools named in these tables do not exist
anywhere yet: `health.adherence`, `health.lookup_barcode`, `health.add_food` and
`schedule.bill_events`. "Already computed" for those four means the *maths* exists,
not the tool. Three more — `finance.forecast`, `finance.firepower` and
`finance.next_bills` — are declared as absent in the door's own source, with the
reason, and the door says so in every 404. **Where a row here and `API.md` disagree
about what a tool takes or returns, `API.md` is right and this row is the older
intention.** Two of them are marked inline below for exactly that reason.

### Finance — reads (read door)

| Tool | What it answers | In | Out | Class | State |
|---|---|---|---|---|---|
| `finance.audit` | Does the app disagree with itself. | none | 8 checks, each ok or fail with counts | READ | **ready** — `selfAudit(data, now)`, one call, one argument, no assembly `[code: src/lib/selfAudit.ts:98]`, and it renders on a screen `[code: src/views/redesign/FinanceTabs.tsx:168, ProfileTab.tsx:325]` |
| `finance.next_bills` | What is due before the next paycheck. | none | name, day, amount, paid yet or not | READ | **ready after `headline.ts`** — `dueBeforeNextPayday` renders today, but its window is assembled in the view `[code: src/views/redesign/BillsSheet.tsx:136-146]` |
| `finance.firepower` | Dollars a month free to aim at the debt. | none | firepower, income, fixed bills, variable spend | READ | **needs `headline.ts`** — Rule 3. The screen's number has two subtractions `planMath` does not know about `[code: src/views/redesign/buildVMs.ts:107-128]` |
| `finance.position` | How much can we actually spend right now. | none | available, pending hold, per-account | READ | already computed — `totalBalance`, `totalPendingHold`, `cashAccounts` `[code: src/lib/recurring.ts]`. **This row said "posted" and the built door has no posted figure at all** — `available` is the bank's own available, already reduced by everything processing, and `pending_hold` sits beside it as context. `API.md` is blunt that the two must never be added. |
| `finance.budget_status` | How much is left in the envelope this month. | none | per line: target, spent, left; envelope total | READ | already computed — `sumTargets`, `spentByCategory` `[code: src/lib/plan.ts]` |
| `finance.debts` | What we owe, in the order the plan attacks it. | none | ordered debts, balances, original balance, APR and minimum where recorded, and the total off `planMath` | READ | already computed — `orderedDebts`, `planMath` `[code: src/lib/plan.ts:142,437,549]`. **As built it returns no payoff month and no debt-free date** — `payoffSchedule()` takes seven arguments the app assembles in a view module, so a door that assembled them would be the door doing the arithmetic. It ships when that assembly is a shared function. `API.md` calls an invented payoff date the most tempting wrong number in the system. |
| `finance.spend_by_category` | Where the money went, **over whole months**. | from, to | category totals only, **no individual rows** | READ | already computed — `spentByCategoryBetween` `[code: src/lib/plan.ts:617]`. **As built the boundaries are fixed to months:** `from` is the first of a month, `to` is the last day of a month or today, 24 months at most. A free choice of dates lets a caller walk a window one day at a time until category totals become a list of charges, which is what `finance.search_transactions` is forbidden for. A week is answered by `finance.budget_status` instead. |
| `finance.forecast` | **The lowest the balance gets, and the day it happens.** | months ahead (default 3) | per month: low `{day, balance}`, ending balance, in/out | READ | **blocked — see below** |
| `finance.worth_a_look` | What looks off but is a judgement call. | none | **redacted — see below** | READ | needs a redaction layer |
| `finance.search_transactions` | Return individual ledger rows. | — | — | **FORBIDDEN in v1** | this is the tool that turns a chat into a copy of the ledger |

**`finance.forecast` is blocked, and this was the first draft's worst mistake.**
It made the forecast the one tool Phase 1 shipped, and the Phase 1 gate "open the
app's forecast screen side by side". **There is no forecast screen.** `forecast()`
and `summarize()` have no caller anywhere in the app — the only importers of
`forecast.ts` are `ledgerReview.ts` and `selfAudit.ts`, and they take `addMonths`
only. A case-insensitive search for "forecast" across the views finds one code
comment `[code: src/views/redesign/TxnSheet.tsx:72]`. Git history shows a Forecast
tab existed and did not survive the redesign. So `forecast()` is dead code today,
and its inputs are assembled nowhere, which means the door would have to assemble
them — the exact thing Rule 3 forbids.

**Restoring the forecast view is a Phase 2 item, and the tool ships after it, not
before.** That is the right order anyway: the app is ground truth, and there is no
ground here yet.

**`finance.worth_a_look` gets a redaction layer or it does not ship.** As written it
returns exactly what `search_transactions` is banned for. The engine's own sentence
list interpolates single charges — "{amount} at {merchant} on {date}", "{count}
charges of {amount} on {date} in the same account", "The app plans {modelled} a
month. The last charge, on {date}, was {actual}" `[code: src/lib/ledgerReview.ts:446-479]`
— where `{merchant}` is `merchantKey(tx.description)`, i.e. the bank descriptor or
a hand-typed description `[code: src/lib/ledgerReview.ts:743]`. And each suggestion
carries `evidence` plus a `fix` descriptor holding raw transaction and recurring ids
`[code: src/lib/ledgerReview.ts:100-152]`. One READ tool, no cap, no tap, and it is
a per-charge feed of merchant, amount and date.

So the door returns only:

```
{ rule: "W1", kind: "amount_drift", amount: 100, monthKey: "2026-09",
  bill: "<recurring id>", sentence: "<from the door's own template>" }
```

Never `detail`, never `evidence`, never `fix`, never a merchant string, never a
single charge's date. Amounts rounded to the dollar. The sentence is regenerated by
the door from a fixed template that may name a **bill row** and nothing else, and it
goes through Rule 4's scrubber on the way out. If a rule cannot be said without
naming a merchant or a charge date — W5a and W7 are the two — the door returns the
rule and the count and says "open the app to see which charge".

### Finance — writes (write door)

| Tool | What it does | Class | Why |
|---|---|---|---|
| `finance.categorize_charge` | Put one charge in a category, and optionally learn the merchant. | QUEUED | genuinely useful and reversible, and the tap already exists in the app. |
| `finance.note_known_amount` | Record what a variable bill actually came to. | QUEUED | one field, reversible, and it makes every downstream number better. |
| `finance.add_transaction` | Add a cash charge the bank will never see. | QUEUED | allowed only for `type: expense` with no `applies_to` — it may not settle a bill. |
| settle a bill cycle / mark paid / write `paid_bills` | — | **FORBIDDEN** | the repair files are the argument. A $6 parking charge settled September's rent and moved the month by $1,732. `one-payment-per-cycle` and `settled-means-settled` are two of the eight audit checks; an unattended write is exactly how they break. |
| anything touching `debts` balances, `savings_goals`, Plaid link/sync/disconnect | — | **FORBIDDEN** | `disconnect` hard-deletes accounts and transactions with a service-role client that RLS does not constrain `[code: supabase/functions/_shared/callerAuth.ts:11-18]`. Never reachable from a chat. |
| delete anything | — | **FORBIDDEN** | no delete verb exists in either door. |

### Health — reads (read door) — seven of them

The first draft said "five health reads" and listed six. It is seven now, because
two live features had no tool at all.

| Tool | What it answers | In | Out | Class | State |
|---|---|---|---|---|---|
| `health.macros_today` | What is left to eat today. | person | target, eaten, remaining | READ | already computed — `dayTotals`, `remaining` `[code: src/lib/mealLog.ts]` — **but read the night-shift problem in §5 before shipping it** |
| `health.next_workout` | What am I training today, and what did I lift last time. | person | the routine, plus `last_lift` per exercise | READ | **new, and missing from the first draft.** `workout_routines` is a real table with real UI `[code: src/store/HealthStore.tsx:302, supabase/schema_v15_health_sync.sql:47]` |
| `health.training_volume` | Am I training each region enough. | person | hard sets per region over 7 days, band label | READ | already computed — `hardSetsByRegion`, `bandLabel` |
| `health.weight_trend` | Which way is the weight going. | person | latest, weekly average, lb/week trend | READ | already computed — `weightLog.ts` |
| `health.adherence` | How many days did I actually log. | person, window | day statuses, weekly buckets | READ | already computed — `adherenceStats` |
| `health.last_lift` | When did I last train this, and with what. | person, exercise | last session, top set, estimated 1RM | READ | already computed — `trainingMath.ts` |
| `health.lookup_barcode` | What food is this barcode. | EAN-13 | food with macros | READ | already an edge function — reuse `food-lookup` |

### Health — writes (write door)

| Tool | What it does | Class | Why |
|---|---|---|---|
| `health.log_weight` | Record a weigh-in. | **DIRECT-SMALL** | one number, one row in `body_weights`, visible on the weight screen, deletable in two taps. The best first write in the system. |
| `health.log_saved_meal` | Log one of the household's saved meals by name. | **DIRECT-SMALL** | **new, and the first draft missed it entirely.** `saved_meals` is a real table `[code: src/store/HealthStore.tsx:324]`; the macros are already known and there is nothing to parse. "Log my usual breakfast" is the safest and most useful write in the whole system, and it belongs *ahead* of free-form meal logging, not behind it. Still does the read-modify-write dance below. |
| `health.log_meal` | Add free-form food to today's log. | QUEUED | **danger worth naming:** `meal_days` stores the entire day as one JSON document keyed on person + date `[code: supabase/schema_v15_health_sync.sql]`. A blind write clobbers everything logged on the phone that day. The door must read, modify and write, and must re-read immediately before writing. It still races the phone. Last phase, not the first. |
| `health.add_food` | Add a food to the shared library. | QUEUED | fine for `foods`, but it is shared, so it gets a tap. |
| write `food_cache` | — | **FORBIDDEN** | that table is read-only to clients on purpose, because a client that could write it could poison a shared nutrition database for both people `[code: supabase/schema_v35_food_cache.sql]`. |
| tick a set, run the rest timer | — | **stays in the app** | a phone in your hand between sets is already the right interface. |

### Schedule and the bell

| Tool | What | Class | Phase |
|---|---|---|---|
| — | Read or write his Google Calendar | — | **probably not ours, but unproven.** See §1 and Phone Test 4. |
| — | Set a phone alarm | — | **impossible for anyone.** See §1. |
| `schedule.bill_events` | Hand Muse the next N bill due dates in a shape it can put on a calendar or read out. | READ | **Phase 2.** The first draft listed this tool and then assigned it to no phase, so nobody would have built it — and it is the one tool that touches the calendar he actually named out loud. |
| `schedule.remind` | Write a reminder into Homebase, which Homebase's own cron delivers as a real push. | **DIRECT-SMALL**, capped | **Phase 3.** Replaces `notify.ping`. See §5 — this is the biggest change in the revision. |

---

## 4. Auth and safety

### How the doors know who is calling

**Not a Supabase login.** Covered above — a Supabase login is all-or-nothing
across all 18 tables.

Instead: **one long random secret per person per door.** Four secrets:
`MUSE_READ_GINO`, `MUSE_WRITE_GINO`, `MUSE_READ_XINYAN`, `MUSE_WRITE_XINYAN`,
stored as edge-function secrets and compared with the timing-safe `safeEqual`
already in the repo `[code: supabase/functions/_shared/callerAuth.ts:44-50]`. Fail
closed: no secret, unknown secret, or an empty configured value all deny.

Which header the secret travels in is decided by Phone Test 2, not by preference.
The first draft moved it from the query string (which all three existing public
functions use `[code: supabase/config.toml]`) to `Authorization: Bearer` for a good
reason — secrets in URLs end up in logs — but `Authorization` is also the slot
Supabase's own JWT layer inspects, and no function in this repo has ever relied on
it while `verify_jwt = false`. Test it, then write the answer down as verified.

Revoking is: change the secret, redeploy that function. Under a minute, and it
cannot half-work. Rotate every 90 days, and immediately if a phone is lost. Losing
her phone revokes her two secrets and not his.

### Who a row belongs to — a new column, not an old one

The first draft claimed a free win here: stamp `created_by` from the secret and a
column that already exists starts carrying meaning, with no database change.
**That column cannot hold what we want to put in it.** `created_by` is declared
`uuid default auth.uid()` on transactions, debts and savings_goals
`[code: supabase/schema.sql:17,29,40]`. And there is one shared household login —
"The household login is shared, so the *device* — not the account — remembers who
is holding it", which is why the person lives in a browser value
`[code: src/lib/owner.ts:1-6]`. So there is no per-person auth id to point at.
Writing `"gino"` into a uuid column is a type error, and inventing uuids makes rows
that look like they reference real auth users and do not. (Separately: a door
running as the service role gets `auth.uid()` = NULL, so rows it creates lose that
column's default anyway.)

The first draft was right that nothing in the app reads `created_by` today. The
conclusion it drew is not available.

**So: add a `person text` column** (`'gino' | 'xinyan'`) to the tables the doors
write, in the same migration that creates the new tables. A schema change is
already in scope, so this costs nothing extra. Stamp it from the secret, never from
the request body. Leave `created_by` alone.

### The new tables, with the locks on

The first draft wrote two new tables with no row-level security and no grant
changes. Supabase's own documentation carries a danger notice — "A table in an
exposed schema without RLS is readable and writable by any role with a grant on it.
Enable RLS on every table in an exposed schema" — and new tables in `public` start
with every privilege already granted to the anonymous and signed-in roles
`[verified: https://supabase.com/docs/guides/database/postgres/row-level-security]`.
The key that unlocks that is public by design `[code: supabase/functions/_shared/callerAuth.ts:1-9]`.

As written, any stranger could have read the entire record of what the assistant
asked for, deleted rows out of it, and zeroed the rate-limit counters — which also
defeats the cap on notifications. An unprotected audit log is worse than none,
because it looks like accountability and is not. Every other schema file in this
repo enables RLS explicitly `[code: supabase/schema_v15_health_sync.sql:45-47,
supabase/schema_v35_food_cache.sql:26]`; that one forgot.

The migration, sketched — to be reviewed before it runs, not pasted:

```sql
-- schema_v36_muse_bridge.sql

create table if not exists public.muse_audit (
  id       uuid primary key default gen_random_uuid(),
  at       timestamptz not null default now(),
  person   text not null check (person in ('gino','xinyan')),
  door     text not null check (door in ('read','write')),
  tool     text not null,
  args     jsonb not null default '{}'::jsonb,   -- amounts and descriptors redacted
  outcome  text not null check (outcome in ('ok','denied','rate_limited','error')),
  row_ids  uuid[] not null default '{}',
  ms       int,
  idem_key text,                                  -- see "the same write twice"
  result   jsonb                                  -- what was returned, for a replay
);
create unique index if not exists muse_audit_idem
  on public.muse_audit (person, tool, idem_key) where idem_key is not null;

create table if not exists public.muse_calls (
  person text not null,
  bucket text not null,      -- 'read:2026-09-26T14' | 'write:2026-09-26T14' | 'remind:2026-09-26'
  n      int not null default 0,
  primary key (person, bucket)
);

create table if not exists public.muse_pending (
  id         uuid primary key default gen_random_uuid(),
  at         timestamptz not null default now(),
  person     text not null check (person in ('gino','xinyan')),
  tool       text not null,
  payload    jsonb not null,
  summary    text not null,   -- the sentence the app shows him, built by the door
  state      text not null default 'waiting'
             check (state in ('waiting','applied','rejected','expired')),
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.reminders (
  id         uuid primary key default gen_random_uuid(),
  person     text not null check (person in ('gino','xinyan')),
  due_at     timestamptz not null,
  repeats    text not null default 'once' check (repeats in ('once','daily','weekly')),
  message    text not null,   -- capped and scrubbed by the door before it lands
  source     text not null default 'muse',
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

-- Locks. Every one of these lines is load-bearing.
alter table public.muse_audit   enable row level security;
alter table public.muse_calls   enable row level security;
alter table public.muse_pending enable row level security;
alter table public.reminders    enable row level security;

revoke all on public.muse_audit   from anon, authenticated;
revoke all on public.muse_calls   from anon, authenticated;
revoke all on public.muse_pending from anon, authenticated;
revoke all on public.reminders    from anon, authenticated;

-- muse_calls gets NO grant and NO policy: only the service role, inside the door.

-- the settings screen shows the log, read-only
grant select on public.muse_audit to authenticated;
create policy "muse_audit read" on public.muse_audit
  for select to authenticated using (true);

-- the app shows queued writes and records his decision
grant select, update on public.muse_pending to authenticated;
create policy "muse_pending read" on public.muse_pending
  for select to authenticated using (true);
create policy "muse_pending decide" on public.muse_pending
  for update to authenticated using (state = 'waiting');

-- reminders are his own list, editable in the app
grant select, insert, update, delete on public.reminders to authenticated;
create policy "reminders household" on public.reminders
  for all to authenticated using (true) with check (true);
```

And then the check that proves it: from a browser holding nothing but the
publishable key, select from all four tables. `muse_calls`, `muse_pending` inserts,
and every write to `muse_audit` must come back empty or refused. That is a Phase 1
gate, not a code review item.

### The same write twice

Nothing in the first draft stopped a duplicate. A connector's HTTP call can be
retried by Muse on a timeout, by Sentinel, or by him asking again after a slow
reply — and `finance.add_transaction` or `health.log_weight` would each create a
fresh row every time. The hourly rate limit does not help: ten writes an hour is
ten duplicates. This matters more here than in most systems, because a duplicate
charge is already a failure the app has a rule for (the `duplicate` W5 suggestion
`[code: src/lib/ledgerReview.ts]`), and because the whole argument for allowing
these writes is that they are reversible — and a silent duplicate is only
reversible once somebody notices it.

So: **every write requires an `Idempotency-Key` header.** It is stored in
`muse_audit` under the unique index above. A repeat returns the first result and
writes nothing. Free side benefit: the audit log can then answer "did that actually
happen" without guessing.

### What an assistant may never do

Enforced by absence, not by a flag:

1. Move money. There is no such endpoint, and Plaid is not reachable from either door.
2. Delete anything. There is no delete verb.
3. Settle a bill cycle or write `paid_bills`.
4. Return raw ledger rows, account numbers, or bank descriptors.
5. Change `debts` balances or `savings_goals`.
6. Write `food_cache`.
7. Reach any other edge function. The doors call Postgres and the push helper
   directly. They do not proxy `plaid`, `notify`, or anything else.
8. Read the clock, assemble a function's inputs, or emit an unscrubbed string
   (Rules 2, 3 and 4).

Also in the doors' own code comments: the response cap. Every read returns
**computed summaries and at most a few dozen numbers**. No endpoint returns an
unbounded list. This is both a privacy control and the only defence available
against limits Meta has not published.

### Rate limits

Meta publishes none for connectors — every specific number circulating turned out
to belong to a different product `[verified by research: https://dev.meta.ai/docs/pricing-rate-limits]`.
So we set our own, counted in the locked-down `muse_calls` table:

- 60 reads per person per hour.
- 10 writes per person per hour.
- 10 new reminders per person per day, and at most 20 open reminders at once.
- Over the limit: HTTP 429 with a plain-English message, because Muse will read it
  and say it out loud.

### The risk that survives all of this

Meta's credential design is genuinely good — the model never sees the secret
`[verified: research.meta.ai security blog]`. But hiding a secret from the model
does not stop the model from using it. If a web page talks the agent into acting,
the secret gets used against Homebase and it never had to leak. Sentinel is the
only thing standing there, and Meta says so itself: "Sentinel is the sole
permission authority for connector actions and network egress"
`[verified: research.meta.ai security blog]`. It is classifiers plus a model trained
to resist injection — good odds, not a guarantee.

And the other direction, which Rule 4 exists for: anything either of them types into
a description, and anything a bank or a payer writes into a memo line, becomes text
in Muse's context labelled as coming from a connector he trusts. Someone who can get
a string into a memo line can get words into his assistant's head.

Meta names this pattern itself: private data, plus untrusted web content, plus the
ability to send things out. A finance connector on a web-browsing agent is inside
that pattern by Meta's own definition. **That is the reason the write list is as
short as it is, the reason the tap lives in Homebase, and the reason no raw string
leaves the door.**

---

## 5. Notifications: who rings the bell

**Homebase keeps the bell. Muse does not get it.** This is not a close call.

The evidence: Meta's reminder page says "Reminders are delivered as messages in
your conversation with Muse" and never once uses the words notification, push,
alert, alarm, snooze or sound — I asked the page for every such sentence and there
are none `[verified: https://www.meta.com/help/artificial-intelligence/1484325780075655/]`.
Meta also hedges the timing itself: "Your Muse will aim to send you a reminder at
the scheduled time" `[verified by research: https://www.meta.com/help/artificial-intelligence/1331373868832401/]`.
Nobody writes "aim to" about something they guarantee.

A general notification channel does exist — the App Store listing says Muse "sends
a notification when something needs your attention"
`[verified by research: https://apps.apple.com/us/app/muse-from-meta/id6760173601]`
— but Meta never connects that to a scheduled reminder in writing.

> ⏱ **PHONE TEST FIRST — 20 minutes, mostly waiting. This is Phone Test 3 in §9.**
> Ask Muse to remind him of something 15 minutes from now. Lock the phone, put Muse
> in the background, and do not touch it. Does anything arrive on the lock screen,
> or only in the chat when he next opens it? Repeat once with the phone on Do Not
> Disturb. **A real notification arrives → good to know, but the plan does not
> change; Homebase's push is still the one we control.** **Nothing arrives →
> confirmed, and §5's whole design is necessary rather than cautious.**

### Where the first draft contradicted itself

It argued for keeping the bell because "At 2:45 AM there is no human" — and then
made `notify.ping` a CONFIRM tool, so a Muse task firing at 2:45 AM would sit
waiting for a tap that is not coming. The headline upgrade was blocked by the
document's own diagnosis.

And underneath that, a plumbing problem: the existing `notify` function is **not**
public. It keeps `verify_jwt = true` because the app calls it with a real signed-in
session, and `config.toml` says so in as many words: "`notify` and `plaid` are
intentionally absent: they are called from the app with a real user session"
`[code: supabase/config.toml]`. A door has no session. "Calls the existing push
path" therefore meant either handing the door a project-wide credential — the exact
trap `callerAuth.ts` warns about — or something unspecified.

### The design that actually works

**Two concrete changes.**

**One: the door imports `sendPush` directly**, from
`supabase/functions/_shared/webpush.ts`, the same way `cron-notify` does. It does
not call the `notify` function. No session, no project credential, no proxy.

**Two: Muse does not do the scheduling. Homebase does.** `schedule.remind` writes a
row into the `reminders` table **while he is awake and talking**. A new pg_cron job
runs a small `cron-reminders` function every 15 minutes, picks up anything due, and
pushes it. That reaches him at 2:45 AM using the only part of this system that
already works unattended, needs no approval at the moment it fires, and rests on no
undocumented Meta behaviour at all. It also means he can see and delete his
reminders in the app — something Muse's own reminders cannot offer, because they are
"created and cancelled only by talking to Muse or tapping in the app. No API"
`[verified: https://www.meta.com/help/artificial-intelligence/1484325780075655/]`.

`schedule.remind` is DIRECT-SMALL rather than QUEUED because its worst case is a
capped, marked notification on his own phone that he can delete — and requiring a
tap to create a reminder would defeat the one feature that makes this worth
building. A reminder aimed at the **other** person is QUEUED. And the guards are
tight, because this is the one tool that reaches out of the system to a lock screen:

- **`person` is forced from the secret.** If the request body carries it, the call
  is refused, the same rule as `person` on a write. This is not a default — the
  first draft said "default the owner to whoever the token names", and a default is
  not a guard. It matters because `sendPush` fans out to **every stored
  subscription** when the owner is undefined `[code: supabase/functions/_shared/webpush.ts:21-27]`,
  so an omitted field is not "just Gino", it is the whole household. An undefined
  person is a refusal, never a fan-out.
- **The message is capped at 80 characters, newlines and URLs stripped**, through
  Rule 4's scrubber. Today `notify` passes `title` and `body` straight through with
  no length limit and no sanitising `[code: supabase/functions/notify/index.ts:35-44]`
  — and this is precisely the harm `callerAuth.ts` records closing: "`notify` would
  push arbitrary text to both household phones."
- **A fixed marker on the front.** Every reminder body begins `Muse: ` so both
  phones can see at a glance that an assistant wrote it and Homebase did not.
- **v1 may ship with canned messages only** — a small list ("read the electric
  bill", "weigh in", "log breakfast") plus a bill name from the ledger — and free
  text added later if the marker and the cap prove enough. Cheaper to start closed.

### The 8 PM push is at the wrong hour, and there is only one of it

The first draft's table said "Nightly and 8 PM pushes — stays". Two problems.

First, that phrasing makes it sound like two schedules. **There is exactly one.**
One pg_cron job at 03:00 UTC — 8 PM Arizona — running one function that does two
jobs, the meal-log nudge and the bills-due heads-up
`[code: supabase/schema_v22_notify_triggers.sql:20, supabase/functions/cron-notify/index.ts:1-3]`.

Second, he is about to work 12-hour nights, four to five days a week, for about
three months `[from him]`. 8 PM is when he is clocking in or driving. "Stays"
endorsed the worst available hour without looking at it.

**Move the cron.** It is a one-line schedule change and it should happen before any
of this is built. **He picks the hour; this is his call, not a technical one.**

This draft suggested 3:30 PM (22:30 UTC). **That is wrong and `ROUTINES.md` J1 says
why: 3:30 PM is inside his sleep window**, which runs 9:00 AM to 4:00 PM seven days
a week from 2 October. The answer `ROUTINES.md` lands on is **6:05 PM** — after
dinner, before the 7:15 PM commute, still early enough to act on a bill before the
shift, and the same hour as the evening money check so there is one money moment a
day rather than two. Use 6:05 PM unless he says otherwise.

### The bigger night-shift problem: whose day is it

This one is not cosmetic. Everything on the meal side is keyed to the **calendar
date**: `meal_days` is stored per person per date, and `dayTotals`, `remaining` and
`adherenceStats` all read that date `[code: src/lib/mealLog.ts, src/lib/adherence.ts,
supabase/schema_v15_health_sync.sql]`. A man who eats his main meal at 1 AM has it
filed under the **next** date. So the "you haven't logged anything today" nudge
fires wrongly, and `health.macros_today` will state remaining calories with
confidence and be wrong.

In the app he can page between two dates and spot it in a second. In a chat he gets
one number and no way to notice. That is the failure this whole plan is built to
prevent, arriving through a door nobody was watching.

Two options, and one of them has to be chosen before `health.macros_today` ships:

- **Add a per-person day-start hour.** His day starts at noon, say. One shared
  helper, used by `macros_today`, the nudge and `adherence` alike, so all three
  agree. More work, and it is the honest answer.
- **Or state it plainly in the tool's own reply**: "for the calendar day, which
  splits your night". Cheap, and it at least does not lie.

Do not ship a life assistant that quietly mis-states his food on the four nights a
week he is at work.

### The honest footnote, said once

Neither push is an alarm. Both are ordinary notifications that Android and iOS
silence under Do Not Disturb. The only thing that reliably wakes a person is an
alarm set on the phone, and no cloud service can set one. Homebase's push does not
win by being loud — it wins by being built, timed by him, and not depending on
undocumented Meta behaviour.

`[unverified]` One more option exists and is worth a look later: Meta reportedly
gave Muse its own email address you can forward to. If true, `cron-notify` could
email Muse and put Homebase's findings into his Muse feed — a one-line change to a
channel that already works. Nobody has confirmed it, so it sits here and nothing
depends on it.

---

## 6. What transfers, what stays, what runs in both

"Upgraded and streamlined into Muse's capability" is the goal, so the honest
answer has to include where moving something makes it worse.

| Function | Verdict | Why |
|---|---|---|
| **Asking "how are we doing"** | **→ Muse** | This is the real win. Spoken questions against exact numbers. Today it takes opening the app and reading four screens. |
| **The eight audit checks** | **stays, read from Muse** | It must keep running in the app, because it is exact and it is what earns the right to say "this did not add up". Muse may report the result. Muse may never present its own opinion beside it — `selfAudit.ts` draws that line itself `[code: src/lib/selfAudit.ts]`. |
| **Firepower / debt payoff** | **both** | Read-only in Muse, and only through `headline.ts` so the spoken number is the screen's number. |
| **The forecast low point** | **both, after the screen comes back** | §3. The function exists, the screen does not. |
| **"Worth a look" suggestions** | **both, read-only and redacted in Muse** | The app shows the charge; Muse says the rule and the count. Applying a fix stays a tap in the app. |
| **Categorising a charge** | **→ Muse, queued for a tap** | Small and reversible, and a genuine improvement: he can clear the queue by talking while walking, then approve a batch with a tap. |
| **Recording what a variable bill came to** | **→ Muse, queued for a tap** | One field, improves everything downstream. |
| **Settling a bill cycle / marking paid** | **stays, human only** | The repair files are a written record of what unattended settlement costs: a $6 parking charge settled rent and moved the month by $1,732. |
| **Bank feed / Plaid** | **stays — and see §8 risk 1** | Muse can already reach banks itself through Plaid `[verified by research: https://plaid.com/blog/meta-muse/]`, so Homebase's value to Muse is not the raw feed — it is the categories, merchant rules, bills, debts, envelope, forecast, the eight checks and the $1,400 floor. But whether we are *allowed* to forward any of it is an open question, not an assumption. |
| **Logging a saved meal** | **→ Muse** | New in this revision and the best early write: a named meal, macros already known, nothing to parse. |
| **Logging a free-form meal** | **both, last phase** | The whole day is one JSON document, so a careless write erases the phone's work. Earn this one. |
| **Scanning a barcode or a nutrition label** | **stays in the app** | Camera, focus check, sharpness check, the whole verify pipeline. Muse may look up a barcode *number*, not scan one. |
| **Ticking a set / rest timer** | **stays in the app** | Phone in hand between sets already wins. |
| **Body weight** | **→ Muse** | Say a number, it lands. First write to build. |
| **What am I training today** | **→ Muse** | New in this revision — the routine plus what he lifted last time. |
| **Training volume / weight trend / adherence** | **both, read-only in Muse** | Already computed, nothing to do but expose. |
| **The one daily push** | **stays, at a different hour** | §5. And it is one schedule, not two. |
| **Reminders** | **→ Homebase, written by Muse** | §5. Muse writes the row while he is awake; Homebase's cron delivers it. |
| **Shared truth between him and Xinyan** | **stays, permanently** | There is no household Muse. This cannot transfer. It is the reason the app does not go away. |
| **Calendar** | **probably → Muse, unproven** | §1, Phone Test 4. |
| **Alarms** | **nowhere** | Not possible for any cloud service. |

### The loss the first draft missed

It was honest about most of what gets worse — no alarms, no shared household view,
no raw rows, no number on a screen beside the spoken one. It missed the biggest one.

**In the app he sees things he did not ask about.** The curve, the bill calendar,
the envelope, all at once. That is how he catches the charge that is wrong. A chat
answers the question asked and nothing else. So the part of Homebase that earns its
keep — noticing what you were not looking for — is exactly the part that does not
survive the move. "Worth a look" is the nearest replacement and it only speaks when
spoken to.

One change follows from that, and it is cheap: **the daily push (and the new
15-minute reminder job) carries any *new* "worth a look" finding to his phone
unasked.** The noticing stays with Homebase while the asking moves to Muse. Because
a suggestion's key already changes when its evidence changes
`[code: src/lib/ledgerReview.ts:154-158]`, "new since yesterday" is a set
difference, not new logic.

The short version: **every read moves to Muse, no write moves without a tap or a
hard cap, and the app keeps everything that needs a camera, a tap between sets, two
people looking at the same screen, or a glance at something you were not looking
for.**

---

## 7. What this costs to run, and what it costs him

The first draft had no dollar figure anywhere and counted time only in build days.
Both are decisions he makes per pay cycle, with $186.99 of headroom on the card, so
they go at the front.

### Money

| Line | Amount | Basis |
|---|---|---|
| Muse subscription | **unknown — check in the app before Phase 1** | Muse is free up to a usage limit and there is a paid tier above it; no price is published on the help page `[verified: https://www.meta.com/help/subscriptions/1625680452306909/]`. Every connector call spends that quota. |
| Supabase edge function calls | **$0 expected** | The free plan includes 500,000 invocations a month `[verified: https://supabase.com/pricing]`. Our own caps (60 reads + 10 writes per person per hour) top out near 100,000 a month for two people even if he hammered it all day — about a fifth of the allowance at the absolute ceiling. Realistic use is a few hundred. |
| Database size | **$0 expected** | Free plan includes 500 MB `[verified: https://supabase.com/pricing]`. The four new tables are small; `muse_audit` is the only one that grows, and it can be trimmed to 90 days. |
| Push | **$0** | Already running, unchanged. |
| Plaid | **unchanged** | But see §8 risk 1 — the question there is permission, not price. |

**If a paid Muse subscription turns out to be required, add it to the `recurring`
table like any other bill** so the forecast, firepower and the envelope all see it.
An assistant that quietly costs money the forecast does not know about is the one
thing this app exists to prevent.

### His minutes

Every gate in §9 needs him, on his phone, next to a screen. During a three-month
night-shift block his attention is the scarce input, not the build time.

| Phase | Build | **His time** |
|---|---|---|
| Phase 0 — five phone tests | 2 hours (the throwaway endpoint) | **60 min**, plus one overnight wait |
| Phase 0.5 — approve the wording | 1 hour | **20 min** |
| Phase 1 — the door + three questions | 3–4 days | **40 min** |
| Phase 2 — the rest of the reads | 3–4 days | **45 min** |
| Phase 3 — two people, reminders, audit list | 2 days | **30 min** |
| Phase 4 — the first writes | 2–3 days | **40 min** |
| Phase 5 — free-form meals | 2 days | **30 min** |
| **Total** | **13–17 build days** | **about 3.5 hours** |

The first draft said "under two weeks of building". With the file generator, the
`headline.ts` extraction, the forecast screen, the four tables and the redaction
layer, that was low. Thirteen to seventeen days is the honest number, and half of
it can stop after Phase 2 with most of the value already delivered.

---

## 8. Risks and decisions for Gino

**1. Plaid's rules may not allow the finance half at all. This is a gate, not a
footnote.** Homebase is the Plaid developer, and the first draft never asked whether
we may forward Plaid data to Meta. Plaid's Developer Policy forbids "transfer,
syndicate, or otherwise distribute the Services or End User Data without express
prior written permission from Plaid", forbids "sell or rent End User Data to
marketers or any other third party", and forbids "access or use the Services for any
purpose other than for which it is provided by us"
`[verified: https://plaid.com/developer-policy/]`. Meanwhile Muse's training setting
is on by default — "This setting is on when you first use Muse" — and the personal
information Meta says it strips is "names, email addresses, phone numbers and Social
Security Numbers", which does **not** include balances, amounts, merchants or bill
names `[verified: https://www.meta.com/help/artificial-intelligence/1047255454427887/]`.
`next_bills`, `spend_by_category`, `audit` and `worth_a_look` are all derived from
Plaid data. Computed summaries reduce the volume; they do not obviously stop it
being End User Data.
→ **Gate, in Phase 0:** read the Developer Policy properly and write down the
decision about summaries before the finance tools are built. And the training
setting must be confirmed **off** before the first finance call — a precondition,
not a recommendation. If the question cannot be settled, take the fallback: health
and schedule only, and let Muse reach banking through Plaid itself, which is the
arrangement Plaid has already consented to.

**2. Xinyan has not been asked, and Phase 1 already exposes her.** This was filed as
a recommendation in the first draft's risk list while Phase 1 shipped a tool built
from the household's shared `recurring` rows — which include her paycheques — and
the shared `transactions` and `accounts` tables. His secret, his phone, Meta's
training setting on by default. So the first thing built would have sent a second
adult's income and spending into Meta's model pipeline before the section saying to
ask her had been read.
→ **Gate, in Phase 0, ahead of any code:** ask her, and get an answer in writing,
**about finance and about health separately**. If she says no to finance, Phase 1
becomes a health read scoped to Gino only and the finance tools wait. This is the
one item in the plan that is somebody else's decision.

**3. Meta gets to keep this.** Training is on by default (quoted above). Deletion is
admitted to be partial: "Muse may still remember information it learned from what
you deleted" `[verified by research: https://www.meta.com/help/artificial-intelligence/2225571704857152/]`.
No retention period is published on any Meta Muse page, and none of them mentions
human review — silence, not a denial. Meta is not a HIPAA-covered entity, so none of
the health protection you would assume applies.
→ Turn training off before the first call. Expose computed summaries only. Scrub
every string (Rule 4).

**4. Muse might change, break, or go away.** It is eighteen days old, the developer
terms are behind a 401, and Meta already shipped and pulled a different feature
under this same name in July.
→ Build the doors as a **product-neutral household API**, not as a Muse connector.
Plain REST behind a secret works for Muse, for Claude, for a shortcut on his phone,
for anything. And keep the rule: nothing lives only in Muse. If Muse vanishes
tomorrow, the app still does everything it does today and we have lost one mouth,
not the system.

**5. A static secret may not be accepted at all.** §1. If only OAuth works, the door
needs an authorisation-code flow: several days more work, and revoking stops being
"change a secret and redeploy".
→ Phone Test 2, in Phase 0, before anything is built.

**6. It may not stay set up.** Whether a Custom Connector persists across
conversations rests on one blog post.
→ Phone Test 1. If it does not persist, the honest answer is to stop — rebuilding
the connector every session is exactly the frustration this was supposed to remove.

**7. The numbers could drift, and in a chat there is nothing to compare against.**
`cron-notify` already did this three times and told the phones wrong things.
→ Rules 1, 2, 3 and 5, plus the generator. This is a decision to make once, at the
start, because retrofitting it later means rewriting every tool.

**8. A web-browsing agent with a finance connector is inside the risk pattern Meta
itself names.** Private data, untrusted web content, the ability to send things out.
Meta does not review custom connectors at all.
→ Accept it, with the write list kept short, the tap inside Homebase, no raw strings
out, and the audit log built in Phase 1 rather than promised for later.

---

## 9. The build plan

### Phase 0 — answer the questions, write no Homebase code (his time: 60 min + an overnight wait; build: 2 hours)

**Four gates that are not tests, and must be closed first:**

- **G1. Xinyan asked and answered, in writing, about finance and about health
  separately.** §8 risk 2.
- **G2. Muse's training setting confirmed off** on his phone, before any finance
  call. §8 risk 3.
- **G3. Plaid's Developer Policy read, and the decision about forwarding computed
  summaries written down.** §8 risk 1.
- **G4. He picks the new hour for the daily push**, and it is changed. One line.
  §5.

**Then the five phone tests.** The throwaway endpoint they run against must itself
be a real Supabase edge function with `verify_jwt = false` — otherwise the tests
prove things about the Muse side and nothing about the transport this repo will
actually use.

1. **Persistence.** Build a connector against the throwaway endpoint. Then close
   the app, and the next day, in a brand-new conversation, ask again. Still
   answers → continue. Does not → stop and rethink.
2. **Auth scheme and transport.** §1. Static secret in `Authorization`, the same in
   `X-Muse-Token`, and a malformed `Authorization`. Whichever passes cleanly gets
   written into §2 as verified. OAuth-only → re-price the project before Phase 1.
3. **Does a Muse reminder actually notify.** §5. 15 minutes, phone locked, then
   again on Do Not Disturb.
4. **The calendar.** §1. Is there a Google connector at all; does a read work; does
   a write work.
5. **The Always-allow grain.** §3. This one has to wait for Phase 3, when two write
   tools exist. Listed here so it is not forgotten.

### Phase 0.5 — he approves the words before they exist (build: 1 hour; his time: 20 min)

He has rejected whole builds because they were made before he saw anything, and
that is a standing rule, not a mood. In a chat assistant **the thing he reacts to is
not the architecture, it is the exact sentences that come back.** The first draft
decided that wording in passing — one aside about calling the forecast a "planned
floor" — and otherwise left it to whoever wrote the endpoint.

So: a flat page listing about a dozen questions and the exact words each answer
comes back as. Include the awkward ones:

- What can I spend, when the $1,400 floor is in the way.
- Where is the low point — and how it says "planned floor" rather than "what will
  happen", given the 3 Sep low came in at $783.66 against a $325 forecast, $459
  pessimistic because the forecast does not know about income it was not told about.
- What it says when the audit **fails**.
- What it says when it could not read the ledger cleanly (Rule 5).
- What it says when a write is waiting for his tap.
- What "worth a look" sounds like once merchants and charge dates are redacted out
  of it (§3).
- What `macros_today` says on a night shift (§5).

He edits the wording. It gets built from what he approved. That settles tone once
instead of arguing it per tool.

### Phase 1 — the door, and the three questions he asks every pay cycle (build: 3–4 days; his time: 40 min)

The first draft shipped one read-only tool that spoke a number he could already see
on a screen, and called that "the thing he actually asked for". It is not — it
proves the pipe and adds no new ability. It also picked the one number with no
screen behind it. Both fixed. Phase 1 now answers the three questions he actually
asks:

**1. Does the app disagree with itself?** → `finance.audit`

The cleanest possible first tool: `selfAudit(data, nowAZ())` — one function, one
argument, no input assembly, and it renders on a real screen today
`[code: src/views/redesign/FinanceTabs.tsx:168, ProfileTab.tsx:325]`.

**2. What is due before the next paycheck?** → `finance.next_bills`

**3. How much is free to aim at the debt?** → `finance.firepower`

Both of these need `headline.ts` first (Rule 3), because today their windows and
subtractions are assembled inside view code.

**The work, in order:**

- `scripts/gen-muse-shared.mjs` and `npm run gen:muse-shared`, wired into
  `npm run build` in `--check` mode. Prove it on **one** file before writing any
  tool code: generate `types.ts` + `format.ts`, run `npm run build`, and confirm it
  passes and then fails when you edit the copy by hand.
- The try/catch in `src/lib/i18n.ts` (§2), so the door can start at all.
- `src/lib/headline.ts` — extract the numbers-only part of `buildVMs.ts`
  (firepower after overspend and outside-budget cash; the pay-cycle window;
  `dueBeforeNextPayday`'s month list) into a pure function both `buildVMs` and the
  door call. Tests for it. **No behaviour change on screen — that is the point.**
- `supabase/functions/_shared/muse/az.ts` — `nowAZ()`, and the CI grep that forbids
  clock reading anywhere else in the doors.
- `supabase/functions/muse-read/index.ts` — public in `config.toml` for the
  documented reason, guarded by `MUSE_READ_GINO`, `safeEqual`, fails closed. Paged
  reads with the count check (Rule 5). Rule 4's scrubber on every outbound string.
- `schema_v36_muse_bridge.sql` — all four tables **with the RLS, revokes and grants
  in the same file** (§4).
- The three tools above, plus `openapi.json`.
- Write to `muse_audit` on every call, reads included.

**Phase 1 gates:**

1. **Two clocks.** Ask the same three questions at **7 PM Arizona** and again at
   **2 AM Arizona**, and compare each against the app on the phone. Both must match.
   This is the gate that catches Rule 2, and it is the one the first draft could not
   have caught because it asked for "to the cent" against a screen that does not
   exist.
2. **To the cent.** Each of the three numbers, side by side with its screen. Not
   "close" — identical. A mismatch means the door derived or assembled something.
3. **The test suite runs twice**, machine clock in UTC and in Arizona, byte-identical
   output.
4. **Wrong secret, empty secret, no secret.** All three return 401 and nothing else.
   Then the write door's secret against the read door: also 401.
5. **The tables are locked.** From a browser holding only the publishable key, try
   to read `muse_audit`, `muse_calls`, `muse_pending`, `reminders`, and try to
   insert into `muse_calls`. Everything empty or refused.
6. **Ask for something forbidden** — "pay the electric bill", "delete that charge",
   "show me my transactions". No such tool, and it says so. If it improvises a way,
   the catalogue has a hole.
7. **Open `muse_audit`.** Every call above appears, right person, right door, and no
   dollar amounts in the logged arguments.
8. **Note how often Sentinel asked for approval, and which choices it offered.**
   Undocumented; only measurable by doing it.

**What Phase 1 proves, stated plainly:** the pipe works, on his real phone, and the
numbers match his screens at two different hours. It answers three questions he
already has answers to, faster. It adds no new ability. That is the correct first
slice and it is not the finished thing.

### Phase 2 — the rest of the reads, and the forecast screen (build: 3–4 days; his time: 45 min)

- Restore the forecast view in the app, with its input assembly in a shared pure
  function — **then** ship `finance.forecast`. In that order. §3.
- The remaining finance reads: `position`, `budget_status`, `debts`,
  `spend_by_category`.
- `finance.worth_a_look`, **with the redaction layer** (§3) — and generate
  `ledgerReview`, `reviewEngine`, `categorize`, `i18n` and the rest of that closure.
  Note the edge copy always answers in the language the door sets explicitly (§2);
  without that line it is always English.
- The seven health reads, including the two new ones (`health.next_workout`, and
  `macros_today` only after §5's day-start decision is made).
- `schedule.bill_events` — explicitly in this phase, because the first draft left it
  in the tool table with no phase and nobody would have built it.
- **Measure the limits** (§2): log the millisecond figure `muse_audit` already has a
  column for, and load-test `audit` and `worth_a_look` against a copy of the ledger
  at 1,000, 2,500 and 5,000 transactions against the 2-second CPU ceiling
  `[verified: https://supabase.com/docs/guides/functions/limits]`. If either runs
  long, those two tools — and only those two — move to a precomputed row refreshed
  on a schedule.

**Gate.** Ten questions asked aloud, answers checked against the app, at two
different hours. Include the ones that need care: "what's left in groceries", "when
does the card clear", "how many hard sets for back this week", "did the audit pass",
"what should I train today". Any disagreement is a bug in the door, never in the app.

### Phase 3 — two people, and the bell (build: 2 days; his time: 30 min)

- `MUSE_READ_XINYAN`, and the language set from her setting.
- The `person` column, stamped from the secret, never from the body.
- Rate limits live, counted in the locked `muse_calls`.
- `reminders` + `cron-reminders` on a 15-minute pg_cron job, importing `sendPush`
  directly. `schedule.remind` with `person` forced, the 80-character cap, the
  scrubber, the `Muse: ` marker, and canned messages only to start (§5).
- The daily push starts carrying new "worth a look" findings unasked (§6).
- The audit list in the app's settings screen, so he can see on his phone everything
  either assistant asked for.
- **Phone Test 5** — the Always-allow grain (§3).

**Gates.** Her secret returns her health figures and not his. A reminder written at
11 PM lands as a real push at 2:45 AM without anybody tapping anything. A reminder
with no `person` in the body goes to **him only**, never both phones. Eleven
reminders in a day: the eleventh gets a 429 he can hear. A reminder with a URL and
three newlines in it arrives as one clean capped line beginning `Muse: `.

### Phase 4 — the first writes, through the tap (build: 2–3 days; his time: 40 min)

- `muse-write` as its own function with its own secrets.
- `health.log_weight` first — one number, DIRECT-SMALL.
- `health.log_saved_meal` second — by name, out of `saved_meals`, macros already
  known. This is a far better second write than free-form food and the first draft
  did not have it at all.
- Then the QUEUED path end to end: `finance.categorize_charge` and
  `finance.note_known_amount` write a `muse_pending` row, fire the push, and change
  nothing until he taps in the app.
- `Idempotency-Key` required on every write, unique in `muse_audit` (§4).

**Gates.** Run the self-audit, do one of each write through Muse, run it again:
**eight zeroes before, eight zeroes after.** Then undo each in the app and confirm it
undoes cleanly. Send the same write twice with the same key: one row, and the second
call returns the first answer. Leave a queued write untapped for 24 hours and
confirm it expires instead of landing.

### Phase 5 — free-form meals, and only if Phase 4 was clean (build: 2 days; his time: 30 min)

`health.log_meal`, QUEUED, with read-modify-write on the day document and a re-read
immediately before the write. Test by logging from Muse and from the phone within
the same minute and confirming nothing is lost. If either is lost, the day-document
write is unsafe and comes back out.

### Deliberately not scheduled

Any bill settlement. Any money movement. Any raw transaction search. Reconsider in
six months, or never.

---

## 10. The standing rule for every test above

**The app is ground truth.** None of these gates count as passed from a probe, a
curl, or a headless script. It counts when he does it on his phone and sees it. When
a probe and he disagree, he is right.

And one addition this revision earned: **every number gate runs at two hours, once
in the evening and once in the small hours.** A number that is right at noon and
wrong at 7 PM is the failure mode this system is most likely to have, and it is
invisible to any test run in the middle of a working day.
