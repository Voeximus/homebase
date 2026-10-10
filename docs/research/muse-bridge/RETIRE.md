# Retiring the screens

Written 2026-09-26. This is the document that stops a one-way door being walked
through by accident.

Homebase is being retired as an app. The database and the maths stay; Muse
becomes the way Gino touches it. That is a good plan. It is also the kind of
plan where the damage does not show up on the day you do it — it shows up six
weeks later, at 2 AM, when the thing you needed was on a screen you deleted.

So this document does one job: **list everything that exists only because a
screen exists, and say where each piece has to land before that screen goes.**

## The answer up front

**Do not remove anything yet.** Neither door is deployed. Three of the four
questions he asks every pay cycle are not built. Four of the seven write tools
write a row that nothing in the app can approve, so they currently do nothing at
all. And the daily push still fires at 8 PM Arizona — which from 2 October is
the hour he clocks in.

The order is: **finish the door, then close four holes, then start removing
screens — and stop while roughly one screen is still standing.** The app does
not go to zero. It goes to one page that does the four things no cloud service
can do.

---

## 0. Where things actually stand, so nothing below is a surprise

| Thing | State |
|---|---|
| `supabase/functions/muse-read/` | written, tested, **not deployed** |
| `supabase/functions/muse-write/` | written, tested, **not deployed** |
| `supabase/functions/cron-reminders/` | written, **not deployed**, and no pg_cron job exists for it |
| `supabase/schema_v36_muse_bridge.sql` | written, **not run** |
| Read tools live | 11 — the `TOOLS` array in `supabase/functions/_shared/muse/tools.ts` |
| Write tools live | 7 — the `TOOLS` map in `supabase/functions/muse-write/tools.ts`, three direct and four queued |
| `finance.forecast`, `finance.firepower`, `finance.next_bills`, `finance.search_transactions` | **declared as not built, with the reason** — the `ABSENT` array in `_shared/muse/tools.ts`, which the door serves in its own description and returns with every 404. `src/lib/headline.ts` exists now (the budget envelope moved into it), but the first three still need their own assembly moved there and their wording agreed; the fourth is forbidden rather than pending. |
| The queued-write tap in the app | **does not exist.** Nothing in `src/` mentions `muse_pending`. |
| A reminders list in the app | **does not exist.** Nothing in `src/` reads the `reminders` table. |
| The daily push | still `'0 3 * * *'` = 8 PM Arizona — `supabase/schema_v22_notify_triggers.sql:31` |
| The deploy workflow | lists seven functions and none of the three new ones — `.github/workflows/deploy.yml:109` |

One thing is already right, and it is the most important one: **`npm run build`
already refuses to let the doors' copy of the maths drift.**
`scripts/check-categorizer-sync.mjs:73` runs `scripts/gen-muse-shared.mjs
--check`. That is what makes §6 — what you may delete — answerable at all.

---

## 1. What lives only in the UI

Three kinds of thing. Device state, actions, and views.

### 1a. Every piece of state kept on the phone

Twenty-four keys. Most are furniture. Six are not, and two of those would lose
real work.

**The three that would lose real data**

| Key | Where | What it is | What happens when the screen goes |
|---|---|---|---|
| `hb-review-dismissed` | `src/lib/doctorDismissals.ts:26`, cap 300 keys at line 34 | Every "worth a look" suggestion he has waved away, on this phone | ⚠️ **The suggestions come back forever.** `finance.worth_a_look` already reports `dismissals_known: false` and tells the assistant to say "this includes anything you have already dismissed". With no Activity tab there is nowhere to dismiss anything ever again, and Muse reads out last week's settled items every time. |
| `hb-active-<person>:<workout id>` | `src/lib/activeJournal.ts:48` (plus the legacy one-slot key at :50) | The crash-safe copy of a session being edited: the workout, how many edits it holds, how many of those the server has confirmed, what this phone deleted inside it, and the last confirmed version to diff against | ⚠️ **Sets logged in the gym with no signal exist only here** until a save lands. There is no door tool that writes a workout at all. If the workout screen goes, this file has no reason to exist and no replacement. |
| `hb-del-<workout id>` | `src/store/HealthStore.tsx:69`, written at :653, cleared at :662 | A workout deleted on this phone whose delete has not reached the server yet | ⚠️ A deleted session **comes back** on the next open if this mark is lost before the delete lands. |

**The three load-bearing settings**

| Key | Where | What it is | Where it must land |
|---|---|---|---|
| `hb-owner` | `src/lib/owner.ts:6`; also read directly by `src/lib/plaidClient.ts:11` and `src/lib/push.ts:14` | Which person this physical device is. The household login is shared, so the device remembers, not the account | **Already replaced.** The doors decide the person from which token called, and refuse a `person` field in the body. But `push.ts` and `plaidClient.ts` still read this key, so it must survive as long as push and Plaid do — which is forever. |
| `hb-lang` | `src/components/LanguageProvider.tsx:32`, read at `src/lib/i18n.ts:23-24` | English or Chinese | ⚠️ **The door has no browser storage.** `i18n.ts` falls back to English when `localStorage` is absent. Unless the door calls `setLangVar()` from the person's own setting, every sentence reaching Xinyan's Muse comes back in English. That setting has to live somewhere the door can read — a column, not a phone. |
| `hb-push-off` | `src/lib/push.ts:23` | "I deliberately switched push off on this device" | ⚠️ This flag is the only thing that stops `syncPushSubscription()` re-subscribing a phone he turned off (`push.ts:158`). Lose it and the bell comes back on by itself. |

**The two unfinished migrations — do not clear site data**

| Key | Where | What it is |
|---|---|---|
| `hb-health-migrated`, and the old data it guards: `hb-meallog-*`, `hb-workouts-<person>`, `hb-routines-<person>` | `src/store/HealthStore.tsx:340` (guard), `:346-378` (the lift), `:379` (the flag) | Pre-Supabase health history, lifted to the cloud once per device. The flag says it already ran. Old meal days, workouts and routines may still be sitting in a phone's storage on a device that never opened the app after the migration shipped. |
| `hb-foods-custom` | `src/lib/nutrition.ts:164` | The custom food library, local-first. `src/store/FinanceStore.tsx:418-443` lifts it to the `foods` table and clears it **only after a confirmed insert** |

Both of these are reasons to check each phone before wiping any of them. Two
phones, two chances to lose food entries and workout history that never reached
Postgres.

**Two small pieces of real data**

| Key | Where | What it is |
|---|---|---|
| `hb-dish-share` | `src/views/MealBuilder.tsx:448`, default 0.5 | His usual share of a dish cooked for two. A meal-logging default with no equivalent in `health.log_saved_meal`. |
| `hb-nudge-snooze-<person>-<date>` | `src/views/MealBuilder.tsx:208` | "Stop nudging me about logging today." A real dismissal, with nothing server-side behind it. |

**Live-session scratch — dies with the screen and should**

`hb-rest-<person>` (`src/lib/restTimer.ts:91`) holds the rest timer's end time,
and `hb-session-start-<workout id>` (`src/lib/sessionOps.ts:355`) holds when a
session started. Both are meaningless without the screen they drive.

**Furniture — safe to lose, all of it**

`hb-mode` (`src/App.tsx:139`), `hb-lens` (`src/lib/lens.ts:10`),
`hb-health-theme` (`src/lib/healthTheme.ts:31`), `hb-health-sub`
(`src/views/HealthView.tsx:49`), `hb-fin-tab`
(`src/views/redesign/FinanceTabs.tsx:125`), `hb-workout-view` and
`hb-workout-mode` (`src/views/WorkoutSection.tsx:77,83`), `hb-meal-mode`
(`src/views/MealBuilder.tsx:111`), `hb-saved-open`
(`src/views/MealBuilder.tsx:204,1297`), `hb-seen-version`
(`src/components/WhatsNew.tsx:6`).

One of these is worth a sentence rather than a shrug. `hb-lens` is the "me vs
all" switch. **The door has no lens** — every finance answer is the whole
household. So the moment his Muse answers a money question, it is speaking about
her income too. That is correct for a shared ledger and it is also a thing she
should be told, not discover. It belongs in §4.

### 1b. Every action, and whether a door can do it

`src/store/FinanceStore.tsx:221-300` declares 30 finance actions.
`src/store/HealthStore.tsx:150-162` declares 13 health ones. The write door has
seven tools. Here is the gap.

**Finance — covered**

| Action | Door |
|---|---|
| `setTransactionCategory` (+ `saveMerchantRule`) | `finance.categorize_charge`, queued, with a `learn_merchant` flag (`muse-write/tools.ts:430-436`) |
| the variable-bill amount | `finance.note_known_amount`, queued |
| `addTransaction` | `finance.add_transaction`, queued, expenses only, may never point at a bill |

**Finance — forbidden on purpose, and rightly**

`payBill`, `markBillPaid`, `setPaidBill`, `deleteTransaction`, anything touching
`debts` balances or `savings_goals`, anything touching Plaid. The repair files
`supabase/repair_v29_bill_attribution.sql` through `repair_v34` are the
argument. Leave these alone.

**Finance — no door, nothing planned, and the screen is the only way**

| Action | Where the only button is | Why it matters |
|---|---|---|
| `unlinkFromBill` | `src/views/redesign/TxnSheet.tsx`, `FinanceTabs.tsx` | ⚠️ **The store's own comment says "Nothing else in the app can undo a bill link."** This is the repair tool for the failure that moved September by $1,732. If `TxnSheet` goes, a wrongly matched charge is permanently wrongly matched outside the Supabase dashboard. |
| `setAccountBalance` | `src/views/sheets.tsx:39` `AccountsSheet` | ⚠️ Reconciling an account to the real bank figure. Every number the door speaks is built on these balances. |
| `setTransactionSplits` | `TxnSheet.tsx` | Splitting one charge across categories. One of the self-checks (`splits-sum`) tests that splits still add up. |
| `setAsideTransaction`, `excludeFromBudget` | `TxnSheet.tsx`, `LedgerSheet.tsx` | Taking a real purchase out of the variable budget, or marking it owed back |
| `settleReimbursable`, `unsettleReimbursable` | `src/views/redesign/OwedSheet.tsx` | Closing out money owed back |
| `acknowledgeAnomaly` | `src/views/redesign/AnomalySheet.tsx` | Clearing an "unusual purchase" flag |
| `makeRecurringBill`, `setRecurringVariable` | `TxnSheet.tsx`, `LedgerSheet.tsx`, `FinanceTabs.tsx` | Turning a charge into a bill; marking a bill variable |
| `linkDebtToCard`, `unlinkDebtCard`, `createDebtFromCard` | `src/views/sheets.tsx:578-693` | Keeping a card's balance auto-synced from the bank |
| `commitImport` | `src/components/ImportSheet.tsx` | Importing a statement. Needs a file picker, so it cannot leave a device anyway (§2). |
| `seedHousehold`, `resetAll` | `src/views/sheets.tsx:694` `SettingsSheet` | First-run and nuclear. Should never be reachable from a chat. |
| the fixes in `src/views/redesign/reviewApply.ts` | `ReviewSheet.tsx` | The one place a "worth a look" suggestion turns into a write, with a re-read-and-refuse guard at tap time |

Three finance actions have **no UI caller and no door** — `addDebt`,
`setPaidBill`, `deleteFood`. They are already dead. Noted so nobody counts them
as a loss.

**Health — covered**

`health.log_weight` and `health.log_saved_meal` land straight away.
`health.log_meal` is queued.

**Health — no door, and two of them are load-bearing**

| Action | Where the only button is | Why it matters |
|---|---|---|
| `addSavedMeal`, `updateSavedMeal`, `deleteSavedMeal` | `src/views/MealBuilder.tsx` | ⚠️ **`health.log_saved_meal` is the best write in the whole system and it eats saved meals.** The only place a saved meal can be created is the Meal Builder. Retire that screen first and the good write slowly starves — and the new night-shift plan needs **seven** new saved meals (two pre-workout bowls, two dinners, two break meals, and the 8:45 AM snack). |
| `setMacroTarget` | `MealBuilder.tsx`, `MealLab.tsx` | ⚠️ His targets change **on 2 October** — the new plan is about 2,700 calories and 125 g protein, against whatever is stored now. `health.macros_today` reads the target and reports "remaining" against it. Set the new targets while the screen still exists. |
| `upsertWorkout`, `deleteWorkout` | `src/views/WorkoutSection.tsx`, `src/views/workout/*` | Every set and rep. No door tool writes a workout. `health.next_workout` and `health.last_lift` can only read what a screen put there. |
| `addRoutine`, `deleteRoutine` | `WorkoutSection.tsx` | The routines `health.next_workout` reads out |
| `deleteWeight`, `clearWeights` | `src/views/CalibrationGauge.tsx` | Correcting a weigh-in. The door can log one and cannot fix one. |
| `setDay` beyond adding food | `MealBuilder.tsx` | Removing or editing an item already in today's log |
| `addFood` | `MealBuilder.tsx`, the label flow | Adding to the shared food library |

**The shape of it:** the door can *answer* almost everything and *change* very
little. That is deliberate and correct. It also means retiring a screen removes
an ability, not a habit — and the abilities above are the ones you reach for on
the bad day, not the ordinary one.

### 1c. What he stops being able to see

The door answers eleven questions. The app shows considerably more. These have
no tool and none is planned:

- the bill calendar (`src/views/redesign/BillCalendar.tsx`) — the month laid out
- any individual charge, ever — forbidden by design, and the right call
- the needs-review count and the anomaly queue (`ActivityTab.tsx`,
  `AnomalySheet.tsx`)
- money owed back (`OwedSheet.tsx`)
- the payoff schedule and debt-free month — `finance.debts` explicitly refuses
  to compute it (`API.md`, the `finance.debts` section)
- the logging streak — listed as planned, not built
- the exercise library, the body map, per-set history, progress charts
  (`src/views/workout/*`, `src/components/workout/BodyMap.tsx`)
- a barcode looked up — `health.lookup_barcode` is planned, not built, though
  the `food-lookup` edge function already exists

And the loss `PLAN.md` §6 already named, which is the real one: **in the app he
sees things he did not ask about.** The curve, the bills and the envelope at
once. That is how a wrong charge gets caught. A chat answers the question asked.
`worth_a_look` is the nearest replacement and it only speaks when spoken to.

`PLAN.md` §6 has the cheap fix: make the daily push carry any *new* "worth a
look" finding unasked. **Build that before the Activity tab goes, not after.**
It is the only thing that keeps the noticing.

---

## 2. What genuinely cannot leave a device

Four things, plus three worth naming. For each: the smallest surface that has to
survive, and whether Muse replaces it.

### The Plaid link, and re-authorisation

**The chain:** `createLinkToken()` (`src/lib/plaidClient.ts:17`) asks the edge
function for a token and stashes it in `hb-plaid-link-token` → `usePlaidLink`
opens Plaid's own UI (`src/views/sheets.tsx:537` `ConnectBank`) → a real bank
sends the browser to the bank's site → the bank redirects back to the app's URL
with `?oauth_state_id=` → `src/components/PlaidOAuthReturn.tsx` catches it,
reads the stashed token, and re-opens Link exactly where it left off →
`exchangePublicToken()` hands the public token back to the function, which puts
the access token in Vault.

**Why it cannot move.** Four reasons, any one of which is fatal: Plaid's Link UI
is a browser widget, the bank's OAuth redirect must land on a page Plaid has
been told about, the token has to survive a full page reload, and the human has
to type bank credentials into the bank's own site. A server cannot do any of it.
Meta's own agent cannot do it on his behalf either — that is entering financial
credentials, which is exactly the thing an agent must not be asked to do.

**Muse does not replace it.** Muse can reach banks through Plaid itself
(`PLAN.md` §6) — but that is Muse's own connection, not Homebase's, and it does
not keep Homebase's ledger fed.

**Smallest surviving surface:** one button that says "Connect a bank" and
handles the redirect. In today's code that is `ConnectBank` in
`src/views/sheets.tsx:537` plus `src/components/PlaidOAuthReturn.tsx` mounted
above everything (`src/App.tsx:171`). Both stay, permanently.

**And the part people forget:** Plaid connections expire and banks force
re-login. When that happens the feed goes quiet, the ledger silently stops
updating, and every number Muse speaks is confidently stale. **There is nothing
in the system today that tells anybody this has happened.** A door that answers
from a ledger that stopped three weeks ago is worse than a door that refuses.
Before the last screen goes: `finance.position` should carry the age of the
newest transaction, and the daily push should complain when it exceeds two days.

### The camera paths

Two of them, and they are not the same.

**The barcode scanner** — `src/components/BarcodeScanner.tsx:171` opens the
camera with `getUserMedia` and decodes an EAN-13. The number then goes to the
`food-lookup` edge function.

**The nutrition-label reader** — `src/components/LabelScanner.tsx:207` (camera,
plus a file input at :387 with no `capture` attribute on purpose) →
`src/components/LabelScanFlow.tsx` → OCR in a worker
(`src/lib/labelScan/ocr/*`), a sharpness check
(`src/lib/labelScan/sharpness.ts`), a parse, a verify pass
(`src/lib/labelScan/verify.ts`) → `src/components/LabelConfirmSheet.tsx` for the
human check. Roughly 2,000 lines and eleven test files.

**Muse replaces one of these and not the other.** Muse reads nutrition labels
from photos — confirmed. So the label reader has a real replacement, and it is a
better one: he photographs a label in Muse, Muse returns calories, protein,
carbs, fat, and the write door adds the food. **That is the single biggest
deletion available in this whole retirement** — around 2,000 lines of OCR
pipeline plus its fixtures, gone.

But Muse cannot decode a barcode from a photo into a lookup against the
household's own food cache. `health.lookup_barcode` is planned and not built.
So: **build `health.lookup_barcode` first** (the `food-lookup` function already
does the work), keep a small camera button that only reads a barcode number, and
retire the whole label pipeline behind it.

**One caution before deleting the label reader.** The verify pipeline exists
because a mis-read label poisons the food library for both people, silently,
forever. Muse's label reading has no verify pass and no sharpness check. Its
output needs a **queued** tool so a human sees the numbers before they land —
call it `health.add_food`. **That tool does not exist yet**, on either door, and
it is not on the planned list in `API.md` either: it is a new build, and it is a
prerequisite for this deletion rather than something already waiting. Do not make
it a direct write because it feels convenient.

### The push subscription

This is the sharpest item in the document, and it is easy to miss.

`src/lib/push.ts:156` `syncPushSubscription()` re-asserts this phone's row in
`push_subscriptions` on **every app open** (`src/App.tsx:157-159`). The comment
above it records why: the row and the browser's subscription drift apart
silently — the sender prunes the row on a dead endpoint, reinstalling the PWA
mints a new endpoint, the upsert can just fail — and the browser goes on
reporting a healthy subscription the whole time. That is how this household ended
up with "a healthy notify function, a cron job succeeding every night, and ZERO
registered devices, with no symptom anywhere in the UI." Forty-four nights.

**So: retiring the app quietly retires the bell.** The row is the deliverable
half, the app is the only thing that writes it, and nothing outside the app can.
If he stops opening Homebase, the row is never re-asserted, and the first time it
goes stale nobody finds out — including at 2:45 AM, which is the entire reason
`cron-reminders` was designed the way it was.

**Muse does not replace it.** Muse's reminders arrive as chat messages, and its
notification does not override Do Not Disturb and cannot be confirmed delivered.
Homebase's push is the only channel anybody here controls.

**Smallest surviving surface, and it is not a screen:**

1. The Keep Screen (§3, Stage 5) keeps the push toggle — today's `PushRow` in
   `src/views/redesign/ProfileTab.tsx:180`. It already distinguishes "the browser
   is subscribed" from "the server has a row", which is the distinction that hid
   the outage.
2. **`cron-notify` should refuse to be quiet about an empty table.** If
   `push_subscriptions` has no row for a person on the day a push was due, that
   is a fault, and today nothing says so. One check, one line in the log.
3. Open the Keep Screen weekly. That is a habit, which is a weak control — hence
   point 2.

### The update prompt

`src/components/UpdatePrompt.tsx` polls for a new service worker every 20
minutes and on every foreground, shows a pill, and on tap always ends in a hard
reset: drop every cache, unregister the worker, reload with a cache-busting
query (`nuke()` at :65). Its own comment explains why the graceful path is not
trusted — it fails silently in two different ways that look identical.

**Once the app is one page nobody opens, this mostly stops mattering** — there is
nothing to update. But it does not stop mattering entirely, because the Keep
Screen is the page that fixes Plaid and push, and a Keep Screen stuck on a
months-old cached shell is a Keep Screen that cannot do its job on the day you
need it.

**Smallest surviving surface:** keep `UpdatePrompt` mounted on the Keep Screen
(`src/App.tsx:109`). It is 121 lines and it is the only recovery path from a
stuck service worker. **Muse does not replace it** and cannot.

### Three more, named so they are not discovered later

**The workout screen between sets.** The rest timer stores an end time so a
sleeping phone comes back right (`src/lib/restTimer.ts`), a two-tone beep plus
vibration (`src/lib/restAlert.ts`), and a screen wake lock
(`src/lib/wakeLock.ts`). A phone in your hand between sets is already the right
interface. Nothing about this moves to a chat.

**Importing a statement.** `src/components/ImportSheet.tsx` needs a file picker
and a PDF parser. Cannot leave a device.

**Two people looking at the same numbers.** There is no household Muse. Each
person's Muse is their own. This is the one thing that cannot transfer at all,
and it is §4.

---

## 3. The order of retirement

Six stages. Each one is reversible in a single move, and each one carries the
test that tells you it was a mistake. **The test is the point.** A stage without
one is a guess.

The standing rule from `PLAN.md` §10 applies to every stage: **the app is ground
truth, and a stage passes when he sees it pass on his phone, not when a script
says so.**

### Stage 0 — before a single screen changes

Nothing is removed. This is the "do not start yet" list.

- The four gates in `PLAN.md` §9 Phase 0: Xinyan asked and answered in writing
  about money and health separately; Muse's training setting confirmed off;
  Plaid's Developer Policy read and the decision written down; **and he picks the
  new hour for the daily push.**
- **Move the daily push off 8 PM.** One line at
  `supabase/schema_v22_notify_triggers.sql:31`. From 2 October, 8 PM Arizona is
  when he is clocking in or driving. This is not part of the retirement — it is
  broken now and it gets worse on 2 October.
- **Add `muse-read`, `muse-write` and `cron-reminders` to
  `.github/workflows/deploy.yml:109`.** Today an edit to a door looks shipped and
  is not running. That is survivable while the app is there to contradict it. It
  is not survivable afterwards.
- **Set the new macro targets while the Meal Builder still exists** — the daily
  target, **2,700 calories and 125 g protein**. `health.macros_today` reports
  remaining against whatever is stored, so until this is done the door's
  "remaining" is measured against last quarter's goal. Do not store 2,500 / 130 —
  that is what the four meals as written add up to, not the target, and
  `ROUTINES.md` J2 explains the difference.
- **Create the night-shift saved meals while the Meal Builder still exists** —
  the two pre-workout bowls, the two dinners, the two 1 AM break meals, and the
  8:45 AM fruit-and-rice-cakes. **Seven saved meals.** `health.log_saved_meal` is
  only as good as this list, and this is the only screen that can write it.
- Run `schema_v36_muse_bridge.sql`. Deploy the read door. Schedule the 15-minute
  job. Then paste `MUSE-SKILL.md` into Muse and do the nine checks in `SETUP.md` —
  1–6 for the read door, 7–9 for the write door and the reminder pipeline.

**How would I know Stage 0 was a mistake?** The nine checks in `SETUP.md` fail —
in particular check 3, the two-clock test. If the pay-cycle window moves when he
asks after midnight, stop. Everything downstream inherits that bug and it is
invisible at noon.

**Undo:** set the read key to a fresh random value nobody has. The door refuses
every call. The app never knew the door existed.

### Stage 1 — the door lives beside the app, and nothing is removed

He asks Muse instead of opening the app, for a month, with every screen still
there. This is the stage that is cheap to run and expensive to skip.

Build in this stage, because these are what he actually asks:

- `src/lib/headline.ts`, then `finance.firepower` and `finance.next_bills`
- the forecast view in the app, then `finance.forecast` — in that order, because
  the app is ground truth and there is no ground for the forecast yet
- `health.lookup_barcode`, so the barcode path has a door before the camera
  question comes up
- the transaction-age warning on `finance.position` (§2, Plaid)

**How would I know Stage 1 was a mistake?** He keeps opening the app for the
same thing, three or four times, after a month. That is not a failure of
discipline — it is the door missing a tool. Write down which thing it was; it is
the next tool to build, and the screen it lives on is not retirable yet.

Second test, and it is the one that catches the quiet failure: **once a week,
ask Muse the same question twice, an hour apart, and once compare against the
app.** If the numbers ever disagree, the door derived something, and everything
built on top of it is suspect.

**Undo:** revoke the key. Nothing else changed.

### Stage 2 — close the four holes

No screens go until all four are shut. Each one is a thing the current design
promises and the current code does not do.

1. **The queued-write tap.** Four tools write a `muse_pending` row; nothing in
   the app can approve one. Build the sheet — it belongs beside
   `src/views/redesign/reviewApply.ts`, which already has exactly the right
   shape: one descriptor, one store call, one tap, a re-read at tap time, and a
   refusal that is never silent. **Without this, four of seven write tools do
   nothing at all.**
2. **The reminders list.** `PLAN.md` §5 sells reminders partly on "he can see and
   delete his reminders in the app". Nothing reads the table. A reminder written
   for the wrong day can currently only be fixed in the Supabase dashboard. On a
   night shift that is a reminder that buzzes at the wrong hour every day until
   somebody opens a laptop.
3. **Dismissals become household state.** A table, so a dismissal survives a
   phone and reaches the other one. `src/lib/doctorDismissals.ts:98`
   `mergeDismissed()` is already written and waiting for it — the file calls it
   "spec piece 3". Then `finance.worth_a_look` can stop saying
   `dismissals_known: false`.
   **2026-10-10: the door half is built.** `supabase/schema_v43_review_dismissals.sql`
   is written (not yet run), `finance.dismiss_suggestion` writes it with an undo, and
   `finance.worth_a_look` hands out each suggestion's key, leaves dismissed ones out
   and says `dismissals_known: true` once the table exists. The app half —
   `mergeDismissed()` reading the table — is not done. The same day added
   `finance.confirm_charges` (the needs-review backlog in batches) and
   `finance.unusual` (the anomaly queue, off the rule moved into `src/lib/unusual.ts`).
4. **New findings get pushed unasked.** The daily push carries any new "worth a
   look" finding. `PLAN.md` §6 is right that this is cheap — a suggestion's key
   already changes when its evidence changes, so "new since yesterday" is a set
   difference. This is the thing that keeps the noticing after the screens go.

**How would I know Stage 2 was a mistake?** Queue a write from Muse, leave it,
and see whether the tap arrives and lands. Then run the self-audit before and
after: **every check clean before, every check clean after.** Count them off the
screen rather than from memory — there are eight today and the number grows with
the app, which is why `API.md` tells the assistant the same thing. If a queued
write breaks a check, the tap is doing something the app's own guards would have
refused.

**Undo:** each of the four is additive. Turning one off leaves the app exactly as
it is today.

### Stage 3 — retire the read-only screens

The first screens to go are the ones he only ever *looked* at. No action is lost,
because there was no action.

Retire: `src/views/redesign/HomeTab.tsx`, `src/views/redesign/InsightsTab.tsx`,
the forecast view, `src/views/redesign/BillCalendar.tsx`,
`src/views/redesign/CategorySheet.tsx`,
`src/views/redesign/BillsSheet.tsx` (reading half),
`src/views/workout/ProgressTab.tsx`.

Keep, for now: everything with a button that writes.

**How would I know Stage 3 was a mistake?** One question: **could he still catch
a wrong charge?** Before removing these, spend two weeks with the unasked
"worth a look" push running and count how many things it surfaced that he acted
on. If the answer is zero, the noticing did not transfer, and the Insights and
Home tabs were doing more than they looked like they were doing. Put them back.

**Undo:** they are React components behind a tab switch. Restore the tab.

### Stage 4 — retire the health logging screens, most of them

Retire: the label-scanning pipeline (Muse reads labels — the single biggest
deletion available), the free-form food builder, the weight entry screen.

**Do not retire in this stage:**

- **the saved-meal editor** — `health.log_saved_meal` depends on it, and it is
  the best write in the system
- **the active workout session** (`src/views/workout/ActiveSession.tsx`,
  `SetRow.tsx`, `src/components/workout/RestDock.tsx`) — no door writes a
  workout, and the phone between sets already wins
- **a way to correct a weigh-in** — the door can log one and cannot fix one

**How would I know Stage 4 was a mistake?** Two tests. First: for two weeks, log
every meal through Muse and check `health.macros_today` against what he actually
ate. On a night shift the calendar-day split is a real trap — the reply carries a
note about it and a note is not a fix. If the number is wrong more than once,
the day-start-hour decision in `PLAN.md` §5 has to be made properly before
anything else goes. Second: does a food added by Muse from a label photo arrive
with right numbers? Check five in a row against the packet.

**Undo:** the label pipeline is a lot of files. **Do not delete it in this
stage — only stop routing to it.** Deletion is Stage 6 and it is separate for
exactly this reason.

### Stage 5 — shrink to the Keep Screen

Everything else goes. What stays is one page with, in this order:

1. **Connect a bank / fix the bank** — `ConnectBank` from
   `src/views/sheets.tsx:537`, plus `src/components/PlaidOAuthReturn.tsx`
   mounted above it
2. **Push on/off, with the server-row truth** — `PushRow` from
   `src/views/redesign/ProfileTab.tsx:180`
3. **Reconcile an account to the bank figure** — `setAccountBalance`, from
   `AccountsSheet`
4. **The self-audit panel** — `AuditPanel` at
   `src/views/redesign/ProfileTab.tsx:55`. Its own comment says it exists
   because a check nobody can read is not a check.
5. **The pending-writes tap** — Stage 2's sheet
6. **The reminders list** — Stage 2's list
7. **Unlink a charge from a bill** — the only undo for the $1,732 failure
8. **The update pill** — `src/components/UpdatePrompt.tsx`
9. **The barcode button** — if `health.lookup_barcode` proved itself
10. **The active workout session** — until something better exists
11. **The saved-meal editor** — the supply line for the good write
12. **Language and owner** — `hb-lang` and `hb-owner`, because `push.ts` and
    `plaidClient.ts` read the second one directly

That is not a small screen. It is also not five tabs, two stores and 15,000
lines of views.

**How would I know Stage 5 was a mistake?** The honest test is a bad day, not a
good one. **Run the fallback drill in §5 before you get here, from the Keep
Screen only.** If any step in that drill needs a screen that is gone, the Keep
Screen is wrong.

**Undo:** the removed views are in git. Restoring one tab is a revert. This is
the last stage where that is comfortably true, which is why Stage 6 is separate.

### Stage 6 — actually delete files

Months after Stage 5, once a full pay cycle and a full Plaid re-auth and a real
2 AM reminder have all happened without a screen. **This is the one-way door.**
§6 says exactly what may go and what may never.

**How would I know Stage 6 was a mistake?** You would not, quickly — that is
what makes it the one-way door. So it gets a different kind of test: **tag the
commit before it, and write the tag name in this file.** Then a mistake is a
`git checkout`, not an archaeology project.

---

## 4. Xinyan

She uses the app in Chinese on an iPhone. She may not want Muse at all. That is
allowed, and the plan has to work if the answer is no.

### What is true in the code today

- **There is no household Muse.** Muse is tied to one Meta account. Each person
  would need their own Muse, their own connector, their own two keys. Homebase is
  deliberately two people sharing one ledger on two phones. **That part has no
  Muse equivalent and cannot be handed over.** It is the reason the app does not
  reach zero.
- **The door has no lens.** `hb-lens` (`src/lib/lens.ts:10`) lets a phone show
  "just me" or "the whole household". Every finance answer from the door is
  household-wide, because the tables are. So his Muse already speaks her income
  and her spending. She should be told that in those words before the first
  finance call, not after.
- **Her language is a phone setting.** `hb-lang` lives in
  `localStorage` (`LanguageProvider.tsx:32`), and `src/lib/i18n.ts:23-24` falls
  back to English when storage is absent — which it always is inside a Deno edge
  function. Unless the door calls `setLangVar()` from a stored per-person
  setting, **every sentence her Muse says comes back in English.** One line, and
  it has to be written before she is handed a key, not after she notices.
- **Her push is fragile in a way his is not.** `src/lib/push.ts:1-6` records it:
  iOS only delivers push to a PWA installed to the home screen. If her Homebase
  is a browser tab rather than a home-screen app, she gets no push at all, and
  nothing in the UI says so.

### The option where her half keeps a screen and his does not

**This is the recommended arrangement, and it costs nothing extra.** The app
keeps existing anyway for the Keep Screen. Letting her keep more of it than he
does is a routing decision, not a second codebase.

Concretely:

- She keeps the finance tabs, the meal builder, the workout screens — the app as
  it is today, in Chinese.
- He gets the Keep Screen and Muse.
- Same Supabase, same tables, same maths. Nothing forks.
- Her writes are the ordinary app writes, with every guard already in place. She
  never touches a door, so she never needs a key, and there is nothing about
  Meta's training setting to explain to her.
- If she later wants Muse, she gets `MUSE_READ_XINYAN` and `MUSE_WRITE_XINYAN`
  and nothing about his setup changes. Losing her phone revokes her keys and not
  his (`SETUP.md`, the revoking section).

**The gate this creates, and it is a real one.** If she keeps screens, then the
screens she keeps cannot be deleted in Stage 6. Look back at §1b: the actions
with no door — `unlinkFromBill`, `setAccountBalance`, `settleReimbursable`,
`makeRecurringBill`, the whole `reviewApply.ts` path — are mostly on screens she
would keep. **So her keeping a screen is also his insurance.** The abilities he
loses by retiring are still reachable, by her, on her phone. That is worth more
than it sounds.

**What she must never lose:** the Chinese. Every retirement step that touches a
shared component has to keep `t()` working on her side. `src/lib/i18n_zh.ts` and
`src/lib/i18n_zh_auto.ts` are about 1,480 lines between them and they are pinned
undeletable anyway (§6) because the door's own closure drags them in.

### If she says no to finance

`PLAN.md` §8 risk 2 is blunt about this and it is right. The shared `recurring`
rows carry her paycheques; the shared `transactions` and `accounts` are both
theirs. The first finance question his Muse answers sends her data to Meta, with
training on by default. **Ask her, get the answer in writing, money and health
separately, before the read door is deployed.** If she says no to finance, the
read door ships with the health tools only and the finance tools wait. That is a
smaller Stage 1, not a cancelled one.

---

## 5. If Muse changes, is discontinued, or the door breaks at 2 AM

Muse is eighteen days old. Its developer terms are behind an HTTP 401. Meta
shipped and pulled a different feature under this same name in July. Plan for it
going away.

### What is actually in the path of a failure

The good news first, and it is structural rather than lucky:

| If this breaks | What stops | What keeps running |
|---|---|---|
| Muse the product | asking questions in speech | everything else |
| the read door | asking questions in speech | the app, the bank feed, both cron jobs, every reminder already written |
| the write door | logging by speech | the app's own writes |
| `cron-reminders` | reminders stop firing | the app, the bank feed, the daily push |
| `cron-notify` | the daily push stops | the app, the bank feed, reminders |

**Nothing in the household's operation goes through Muse.** The bank feed is
Plaid → `plaid-webhook` → Postgres. The bell is pg_cron → `cron-reminders` →
`sendPush` → the phone. Muse is a mouth on the front. That is the whole reason
`PLAN.md` §8 risk 4 says to build the doors as a product-neutral household API
rather than a Muse connector, and it is worth restating: **plain REST behind a
secret works for Muse, for Claude, for a shortcut on his phone, for anything.**

### The 2 AM answer, specifically

A reminder he asked for at 11 PM is already a row in `reminders`. `pg_cron` picks
it up every 15 minutes and `cron-reminders` pushes it. **Muse is not in that
path.** If Muse is down at 2 AM, the reminder still fires.

What does not work at 2 AM: asking a new question, and logging something. Both
wait until morning. Neither is an emergency.

### The failures that would actually hurt, ranked

1. **The push row goes stale and nobody notices.** §2. The app is the only thing
   that re-asserts it, and the app is the thing being retired. This has already
   happened once for 44 nights. **Highest risk in the entire retirement, and it
   is not a Muse risk at all.**
2. **The Plaid connection expires and the ledger goes quiet.** Every number Muse
   speaks stays confident and gets steadily more wrong. Nothing warns anybody
   today.
3. **A door edit looks deployed and is not.** `.github/workflows/deploy.yml:109`.
   Fixed in Stage 0, and worth re-checking at every stage.
4. **The generated copy of the maths drifts.** Already guarded —
   `check-categorizer-sync.mjs:73`. Do not remove that guard for any reason.
5. **One shared household login.** `src/lib/owner.ts:1-3`. Every guard in the
   doors is a key check, not a login check, so this is not new exposure — but it
   means there is no per-person recovery story.
6. **Muse starts costing money.** No price is published. `PLAN.md` §7 has the
   right answer: if it becomes a subscription, put it in the `recurring` table
   like any other bill, so the forecast and the envelope see it. An assistant
   that quietly costs money the forecast does not know about is the one thing
   this app exists to prevent.

### The fallback drill

Write this on the Keep Screen itself, in plain words, because the person reading
it will be tired.

**"Muse is not answering."** Open Homebase. Everything works. That is the whole
fallback — the app was never removed, only shrunk, and the numbers were always
computed by the same code.

**"Muse is answering and the number looks wrong."** Believe the app, always. Then
check one thing: is `finance.position` reporting a newest-transaction date more
than two days old? If yes, the bank feed is stale and it is a Plaid problem, not
a Muse problem — reconnect from the Keep Screen.

**"Reminders stopped arriving."** Three things, in this order. Open the Keep
Screen and look at the push row — does it say the server has a row for this
device? If not, tap it. Then check the `reminders` table for rows with `sent_at`
still empty and a `due_at` in the past. Then check whether the pg_cron job for
`cron-reminders` still exists.

**"Muse has been discontinued."** Nothing urgent. Revoke both keys. The app still
does everything it did, and the doors are plain REST — point Claude, or a phone
shortcut, at the same two addresses with the same two keys. **Nothing lives only
in Muse**, which is the rule that makes this paragraph short.

**The one thing that would be a real loss:** if Stage 6 has already deleted the
screens and Muse goes away, he is back to the Keep Screen with no forecast, no
insights, no bill calendar. That is recoverable from git and it is not
recoverable from memory. Hence the tag in Stage 6.

### The standing rule

**Nothing lives only in Muse.** Not a number, not a reminder, not a decision, not
a setting. Every reminder is a row in `reminders`. Every write is a row in
Postgres and a line in `muse_audit`. Every number is computed by code the app
also runs. If Muse vanishes tomorrow, one mouth is lost and no state is.

---

## 6. What to delete from the repo, and what must never go

### Undeletable, permanently

**The 22 modules the generator copies.** `scripts/gen-muse-shared.mjs` lists
them, and `npm run build` fails if the generated copy differs by a space
(`scripts/check-categorizer-sync.mjs:73`). The doors import these. Deleting one
breaks the door, not a screen:

```
src/types.ts              src/lib/format.ts         src/lib/seed.ts
src/lib/household.ts      src/lib/recurring.ts      src/lib/plan.ts
src/lib/schedule.ts       src/lib/forecast.ts       src/lib/selfAudit.ts
src/lib/categorize.ts     src/lib/categorizeData.ts src/lib/ledgerReview.ts
src/lib/i18n.ts           src/lib/i18n_zh.ts        src/lib/i18n_zh_auto.ts
src/lib/muscleRegions.ts  src/lib/exerciseData.ts   src/lib/nutrition.ts
src/lib/mealLog.ts        src/lib/weightLog.ts      src/lib/workoutLog.ts
src/lib/trainingMath.ts
```

Four of those are surprises worth knowing before somebody "tidies up":
`i18n_zh.ts` pulls in `muscleRegions.ts`, which pulls in `exerciseData.ts` — so
**the Chinese translations drag the entire exercise library into the finance
door.** The generator's own comments say so. Nobody would guess it, and deleting
`exerciseData.ts` after the workout screens go would break `finance.audit`.

**Also undeletable:** `src/lib/reviewTypes.ts` and `src/lib/reviewEngine.ts` if
the pending-tap sheet keeps using `src/views/redesign/reviewApply.ts` (it
should — that file is the only place in the app where a suggestion becomes a
write, and it re-reads and refuses at tap time).

**And:** `supabase/functions/_shared/muse/**`, `supabase/functions/muse-read/**`,
`supabase/functions/muse-write/**`, `supabase/functions/cron-reminders/**`,
`supabase/functions/_shared/webpush.ts`, `supabase/functions/cron-notify/**`,
`supabase/functions/plaid/**`, `supabase/functions/plaid-webhook/**`,
`supabase/functions/food-lookup/**`. Every `supabase/schema_v*.sql` and every
`supabase/repair_v*.sql` — they are the migration history and the written record
of what was fixed.

**Every test stays.** `tests/museRead.test.ts`, `tests/museWrite.test.ts`,
`tests/museSnapshot.test.ts`, `tests/selfAudit.test.ts`,
`tests/ledgerReview.test.ts`, `tests/forecast.test.ts`, `tests/payoff.test.ts`,
`tests/money.test.ts`, `tests/dates.test.ts`, `tests/backtest.test.ts`. These are
what make the doors' numbers trustworthy. A test for a deleted screen can go with
the screen; a test for the maths never can.

### The build is the guard rail — use it

`npm run build` is `tsc -b && node scripts/check-categorizer-sync.mjs && vite
build`. Three things follow, and together they mean **a wrong deletion fails the
build rather than shipping quietly:**

- `tsc -b` type-checks all of `src/`. Delete a view a kept file still imports and
  the build fails.
- `check-categorizer-sync.mjs` runs the generator in `--check` mode, greps the
  door folders for any clock reading outside `_shared/muse/az.ts`, refuses a
  second copy of a shared helper, and type-checks the doors. Delete a generated
  source and the build fails.
- **After every deletion, run `npm run build` and `npm test`.** Both green, or
  the deletion is wrong.

### Per stage

**Stages 0-2 — delete nothing.** Only additions.

**Stage 3 — after the read-only screens stop being routed to**

Safe to delete once nothing imports them: `src/views/redesign/HomeTab.tsx`,
`src/views/redesign/InsightsTab.tsx`, `src/views/redesign/BillCalendar.tsx`,
`src/views/redesign/CategorySheet.tsx`, `src/views/workout/ProgressTab.tsx`, and
the dev harness that only exists for those tabs —
`src/views/redesign/DesignLab.tsx`. The five dev harnesses are already excluded
from the production bundle (`src/App.tsx:19-44`), so deleting one changes nothing
a user sees. `src/dev/DoctorLab.tsx` and `src/dev/doctorExamples.ts` belong to the
review path, so they go with it at Stage 6, not here.

Keep: `src/views/redesign/buildVMs.ts` and `src/views/redesign/vm.ts` until
`src/lib/headline.ts` has taken over the numbers part, and then keep whatever
the Keep Screen still needs.

**Stage 4 — after Muse's label reading has been right five times in a row**

The largest deletion in the project. All of it, together:

```
src/lib/labelScan/**            (21 files)
src/lib/labelScanFlow.ts        src/lib/labelSave.ts
src/lib/labelConfirmState.ts
src/components/LabelScanner.tsx src/components/LabelScanFlow.tsx
src/components/LabelConfirmSheet.tsx
src/views/redesign/LabelLab.tsx
tests/labelScan.*.test.ts       (9 files)
tests/labelConfirmState.test.ts
scripts/ocr-smoke.ts
```

Keep `src/components/BarcodeScanner.tsx`, `src/lib/barcode.ts` and
`src/lib/gtin.ts` — they are the barcode path, which Muse does not replace, and
they are small.

Also in this stage, if the free-form food builder is gone: most of
`src/views/MealBuilder.tsx`, but **not the saved-meal editor inside it.** That
is a split, not a delete, and it is the one refactor in this whole document that
has to be done carefully rather than with `rm`.

**Stage 5 — after a full pay cycle on the Keep Screen**

Delete nothing. Route away from it and leave it in place. This stage exists so
that a mistake is a routing change.

**Stage 6 — the one-way door**

`git tag pre-retirement` first, and write the tag name here:

> Tag before the first Stage 6 deletion: `_______________`

Then, and only then, the tabs and sheets the Keep Screen does not use:
`src/views/redesign/ActivityTab.tsx`, `TxnSheet.tsx`,
`src/components/LedgerSheet.tsx`, `OwedSheet.tsx`, `AnomalySheet.tsx`,
`src/components/ImportSheet.tsx`, `src/lib/importPdf.ts`,
`src/lib/importStatement.ts`, `src/views/HealthView.tsx`,
`src/views/WorkoutSection.tsx` and `src/views/workout/**` if something better
ever replaces the between-sets screen.

`src/views/sheets.tsx` is the awkward one: 756 lines holding `AccountsSheet`,
`SprintSheet`, `MarkSentSheet`, `PayBillSheet`, `ConnectBank`,
`CreditCardLinks` and `SettingsSheet`. The Keep Screen needs `ConnectBank` and
`AccountsSheet` out of it, so this file gets split rather than deleted — and the
split is worth doing at Stage 5, while the whole thing still renders, not at
Stage 6 when only part of it is reachable.

And the store actions nothing calls any more, which is a genuine simplification
rather than a loss: the three already dead today (`addDebt`, `setPaidBill`,
`deleteFood`) plus whatever else falls out.

**Never, at any stage:** `src/store/FinanceStore.tsx` and
`src/store/HealthStore.tsx`. The Keep Screen needs them, and `HealthStore.tsx`
holds the sync-merge logic (`src/lib/syncMerge.ts`, `src/lib/activeJournal.ts`,
`src/lib/sessionOps.ts`) that stops two phones undoing each other's work.

---

## The short version

**Before anything:** move the 8 PM push, add the three functions to the deploy
list, set the new macro targets, build the seven night-shift saved meals, ask
Xinyan.

**Then:** build `headline.ts` and the three missing reads, build the queued-write
tap, build the reminders list, make dismissals household state, push new findings
unasked.

**Then:** retire the screens he only looked at, then the label pipeline, then
route down to one Keep Screen — bank, push, reconcile, audit, pending taps,
reminders, unlink, update, barcode, workout, saved meals, language.

**Then wait months, tag the commit, and only then delete files.**

**Her half keeps a screen. That is not a compromise — it is the backup copy of
every ability the door does not have.**

**The app does not reach zero, and the thing most likely to break is not Muse. It
is the push row that only the app re-asserts, and the bank connection that
nothing currently warns you about.**
