# Homebase audit — confirmed findings (2026-08-18)

Each survived an adversarial skeptic whose job was to refute it. `SKEPTIC` notes
are corrections to the proposed fix and take precedence over it.


---

## 1. [CRITICAL] plaid edge function has no caller check — the public publishable key is full authorization, enabling ledger wipe and transaction exfiltration

**File:** `supabase/functions/plaid/index.ts:613` · dimension: security

### Evidence
The handler at line 613 parses `payload.action` and dispatches with zero authorization logic:

```ts
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const payload = await req.json();
    switch (payload.action) {
      case "link_token": return await linkToken(payload);
      ...
      case "disconnect": return await disconnect(payload);
```

The header comment at line 11 claims `"JWT-verified (no unauthenticated surface)"`. That is false. `verify_jwt=true` only requires *a* valid project credential, and the publishable key is one — it is compiled into the public bundle (`grep -rl sb_publishable dist/` -> `dist/assets/index-DPREcaKI.js`, served at https://voeximus.github.io/homebase/) and the repo is public (`api.github.com/repos/Voeximus/homebase` -> `"private": false`).

Confirmed live with a deliberately invalid action (no side effects):

```
$ curl -X POST .../functions/v1/plaid -d '{"action":"__audit_probe_no_side_effect"}'
HTTP 401

$ curl -X POST .../functions/v1/plaid \
    -H "Authorization: Bearer sb_publishable_907KbW_QmcTvL-wFHg-8yA_roZe8u_2" \
    -H "apikey: sb_publishable_907KbW_QmcTvL-wFHg-8yA_roZe8u_2" \
    -d '{"action":"__audit_probe_no_side_effect"}'
{"error":"unknown action: __audit_probe_no_side_effect"}
HTTP 400
```

The 400 proves the request reached the switch statement. Every action is therefore reachable by anyone on the internet. The function holds a service-role client (line 31), so RLS does not constrain it.

### Failure scenario
An attacker reads the publishable key out of https://voeximus.github.io/homebase/assets/index-DPREcaKI.js, then:

Step 1 — `POST {"action":"sync"}`. `syncAll` (line 586) falls through to the no-connection_id branch and returns `json({ synced: out })` at line 597, where each entry is `{ id: <bank_connections uuid>, posted, pending, reversed, newRows }`. `newRows` carries `{description, amount}` for every transaction landed this sync — live bank descriptors and dollar amounts handed to an unauthenticated caller. It also leaks the connection UUIDs the next step needs. (`{"action":"set_webhook"}` leaks the same UUIDs more cheaply, via `json({ set: out })`.)

Step 2 — `POST {"action":"disconnect","connection_id":"<uuid from step 1>"}`. `disconnect` (line 602) runs, with the service role:
```ts
if (ids.length) await admin.from("transactions").delete().in("account_id", ids);
await admin.from("accounts").delete().eq("connection_id", conn);
await admin.from("bank_connections").delete().eq("id", conn);
```
That is a hard delete of every account on the connection and every transaction on those accounts — including hand-entered rows, which match on `account_id` just as feed rows do. There is no soft-delete and no confirmation. Result: the household's entire ledger is gone.

Secondary: `{"action":"link_token"}` mints Link tokens against the production Plaid client, and `{"action":"exchange", public_token}` inserts an attacker's own bank accounts into the household ledger and consumes billable Plaid items. `Access-Control-Allow-Origin: "*"` (line 35) additionally makes all of this callable from any web page a household member visits.

### Proposed fix
Add an explicit caller check as the first statement inside `Deno.serve` at line 613, before `payload.action` is read. The only two legitimate callers are a signed-in household user and the internal call from `plaid-webhook` (which presents `SUPABASE_SERVICE_ROLE_KEY` as its bearer):

```ts
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {   // internal webhook path
    const { data: { user } } = await createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${bearer}` } } },
    ).auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  // ...existing switch
```

`auth.getUser()` rejects the publishable key (it carries no user), which is exactly the gap. Also narrow `CORS["Access-Control-Allow-Origin"]` at line 35 from `"*"` to `Deno.env.get("APP_URL")`, and correct the comment at line 11 — `verify_jwt` is not an authorization check.

### SKEPTIC correction (authoritative)
Core is right -- auth.getUser() rejects the publishable key, which is exactly the gap -- but the snippet as written has three problems.

1. OUTAGE RISK. SUPABASE_ANON_KEY is not reliably injected on a project using the new publishable-key system (this project ships sb_publishable_ and may have legacy JWT keys disabled). If it is unset, Deno.env.get("SUPABASE_ANON_KEY")! yields undefined, createClient throws, and the catch returns 500 on EVERY request -- a security fix that becomes a total outage. Drop the second client and use the existing admin client with the token passed explicitly:
    const { data: { user } } = await admin.auth.getUser(bearer);
    if (!user) return json({ error: "unauthorized" }, 401);
No env dependency, no extra client. (The service-role bypass above it is still needed for plaid-webhook, and getUser correctly rejects the service-role key too since it carries no sub claim.)

2. INCOMPLETE -- authenticate is not authorize. src/auth/LoginScreen.tsx wires supabase.auth.signUp, so if email signup is open in the Supabase dashboard, an attacker self-registers and still reaches disconnect with a valid user. Either confirm signups are disabled, or gate on household membership (allowlist the two user ids / a profiles-membership check) rather than merely "a user exists".

3. WILL SILENTLY BREAK THE DAILY SYNC IF UNCHECKED. plaid/index.ts:8-9 says a daily pg_cron job triggers sync, and schema_v22_notify_triggers.sql:26 notes the live job lives in cron.job, not the repo. Run `select jobname, command from cron.job` first -- if that job presents the publishable key rather than the service-role key, this fix 401s it and the daily sync dies with nothing in the app surfacing it (the exact failure mode config.toml's own comment warns about).

Minor: compare the service-role key in constant time rather than with !==. CORS narrowing at line 33 is fine as defense-in-depth but is NOT the load-bearing hole -- the attacker supplies the key themselves rather than riding a victim's credentials, so narrowing the origin alone fixes nothing. Correcting the line 11 comment is right.

---

## 2. [HIGH] reverse_money_event credits the account balance for rows that never debited it (bank-feed + imported transactions)

**File:** `supabase/schema_v18_finalization.sql:36` · dimension: schema-integrity

### Evidence
reverse_money_event (live definition, v18; identical in schema_v7_rpc.sql:100) reverses cash for ANY row carrying an account_id, gated only on `settled`:

```sql
  if coalesce((v.applies_to->>'settled')::boolean, false) then
    delete from public.transactions where id = p_txn_id; return;
  end if;
  if v.account_id is not null then
    update public.accounts
      set balance = balance - (case when v.type = 'income' then v.amount else -v.amount end)
      where id = v.account_id;
  end if;
```

But two of the three insert paths write `account_id` while deliberately moving NO cash:

- `commitImport` — src/store/FinanceStore.tsx:603 `account_id: it.appliesTo?.settled ? null : accountId ?? null,` with the comment two lines above: "Imported rows are records only; no balance moves." Statement-import variable rows carry no appliesTo at all (src/components/ImportSheet.tsx:161 pushes `{date, amount, categoryId, description}` with no appliesTo), so they are neither settled nor account-less.
- `apply_bank_sync` — inserts every posted feed row with `account_id = p_account_id` (schema_v26_keep_category.sql), documented in schema_v9_bankfeed_rpc.sql: "Record-only (no balance delta) — the balance is set below from the bank's own number, so transactions can never drift it."

The delete button in src/views/redesign/TxnSheet.tsx:271 is rendered for every transaction with no provider/import gating, and calls `deleteTransaction` → `supabase.rpc("reverse_money_event")` (src/store/FinanceStore.tsx:729). The optimistic local mirror at src/store/FinanceStore.tsx:748-757 applies the same wrong delta immediately.

### Failure scenario
Account "Geo" (not bank-connected, balance anchored at $1,240.00). Gino imports a BofA statement into Geo; it contains a $63.41 dining charge, which commitImport inserts as type='expense', account_id=Geo, applies_to=NULL. Geo correctly stays $1,240.00 (the statement is history already reflected in the anchor). He later taps that row and hits "Delete transaction" because it duplicates a feed row. reverse_money_event runs `balance = balance - (-63.41)` → Geo becomes $1,303.41. Cash reads $63.41 higher than the bank, and everything derived from it (the cash tile, totalBalance in src/lib/recurring.ts:59, the deploy/lump-now plan) is inflated by that amount permanently. For a bank-connected account the same bug fires but is masked at the next sync when apply_bank_sync re-anchors the balance — so the wrong number is invisible rather than absent, and is live on-screen until the next sync lands.

### Proposed fix
Make the cash reversal conditional on the row having actually moved cash, instead of on `settled`. Add `alter table public.transactions add column if not exists moved_cash boolean not null default false;`, set it true only where cash really moves — in `apply_money_event` (`insert ... moved_cash = (p_account_id is not null)`) and in `addTransaction` (src/store/FinanceStore.tsx:683, which does its own `accounts.update({balance: nb})`) — and change reverse_money_event's branch to `if v.account_id is not null and v.moved_cash then`. Backfill with `update public.transactions set moved_cash = true where account_id is not null and provider is null and applies_to is null and created_at < '<deploy ts>'` only after confirming which of those rows came from commitImport. As an immediate one-line mitigation that fixes the whole bank-feed half with no schema change, add `and v.provider is null` to the branch condition.

### SKEPTIC correction (authoritative)
The one-line mitigation is right; the schema half of the fix is wrong as written, and it misses the client mirror.

1) WRONG: `moved_cash boolean not null default false` inverts the bug for all history. The 62 backup rows with provider=null + account_id + applies_to=null are produced by BOTH commitImport (record-only) and addTransaction / apply_money_event (genuine cash movers), and no stored column distinguishes them — the proposed backfill predicate (`provider is null and applies_to is null`) matches both groups identically, so there is no way to "confirm which came from commitImport" after the fact. Shipping default false means deleting a real manual expense stops restoring cash, i.e. the same class of wrong number in the opposite direction, on every pre-existing row.

Safer shapes: (a) make the flag nullable — `moved_cash boolean` with NULL meaning "legacy, behave as today" — and gate on `if v.account_id is not null and coalesce(v.moved_cash, true) then`, so only rows written after deploy change behavior; or (b) skip the flag entirely and add an explicit record-only marker on the WRITE side: have commitImport stamp `applies_to = {"recordOnly": true}` (or a `record_only boolean default false` column) on its variable rows, and gate the cash branch on `not coalesce((v.applies_to->>'recordOnly')::boolean, false)`. (b) is additive, needs no backfill, and is safe by default. Note that simply nulling account_id in commitImport is NOT equivalent — that field is deliberately carried for display / per-person activity (see the comment at FinanceStore.tsx:600-602).

2) INCOMPLETE: the fix must also change the optimistic local mirror at src/store/FinanceStore.tsx:748-757, which currently gates only on `txn.accountId && !at?.settled` and applies the same wrong delta client-side. deleteTransaction does not resyncLedger on success, so without this the in-app cash is wrong until a realtime event or reload lands even after the RPC is fixed.

3) CORRECT as stated: adding `and v.provider is null` to the cash branch is safe and fixes the whole bank-feed half with no schema change — apply_bank_sync never moves per-row cash, so no provider row should ever be reversed. Ship that first.

---

## 3. [HIGH] Plaid sync's content-level dedup guard is never armed — re-linking the bank duplicates the entire ledger

**File:** `supabase/functions/plaid/index.ts:329` · dimension: ledger-categorize

### Evidence
`const ops = reconcile({ added, modified, removed }, contentKey);` — the third parameter of `reconcile(sync, contentKey, existingContentKeys: Set<string> = new Set())` (supabase/functions/_shared/plaidSync.ts:69-72) is never passed, so the guard at plaidSync.ts:89 `if (!existingContentKeys.has(contentKey(row))) ops.upsertPosted.push(row);` always pushes. The `contentKey` helper (index.ts:54) is built and then only used as the key function, never against anything. The only remaining dedup is the DB partial unique index `uq_txn_provider on (provider, provider_txn_id) where provider_txn_id is not null` (schema_v8_bankfeed.sql), which manual/CSV rows (provider NULL) do not participate in, and which is scoped to one Plaid item's ids.

### Failure scenario
The app's only bank-link path is a FRESH link: `createLinkToken()` (src/lib/plaidClient.ts:19-25) never sends `connection_id`, so `linkToken()` always takes the `body.products = ["transactions"]` branch (index.ts:170) rather than update mode. `ConnectBank` (src/views/sheets.tsx:517-553) exposes that button unconditionally and there is no reconnect UI anywhere (`grep -rn "needs_reauth|Reconnect" src` returns nothing), so the only remedy when a connection goes stale is to press "Connect a bank" again. That mints a NEW Plaid item with NEW transaction_ids and NEW account_ids, `exchange()` inserts a second copy of every account (index.ts:213-226, no dedupe on provider_account_id), and `syncConnection` then pulls the full history on a fresh cursor. Every historical transaction is inserted a second time — the unique index cannot fire because the ids differ. Result: July variable spend of $1,731 reads $3,462, `totalBalance` double-counts every account, and every budget/firepower number derived from them is doubled. The same hole double-counts any single row already entered by CSV/PDF import or by hand.

### Proposed fix
Load the existing content keys before reconciling and pass them in: query `transactions` for rows in the delta's date range (or the last ~90 days), build `new Set(rows.map(r => `${r.date}|${(r.type==="income"?Number(r.amount):-Number(r.amount)).toFixed(2)}|${merchantKey(r.description)}`))`, and call `reconcile({added,modified,removed}, contentKey, existingKeys)`. Separately, make `exchange()` upsert accounts on `provider_account_id`/`last4` instead of blind-inserting, and add an update-mode path that passes `connection_id` to `link_token` when a connection already exists for the institution.

### SKEPTIC correction (authoritative)
The proposed fix is right in direction but unsafe as written — arming the set unconditionally drops rows that MUST be kept. I proved both regressions with the ported reconcile():

1. Cursor-reset / full re-pull breaks. A row already in the ledger under the SAME provider_txn_id is re-delivered in `added`; its content key matches its own DB row, so upsertPosted = 0 and the healing upsert never runs. docs/HANDOFF.md documents that re-pull as the operational tool used for the v25 raw_description backfill and the v26 keep_category re-check. Guard must be skipped for rows whose provider_txn_id is already known — the function already builds `seenProviderIds` (index.ts, from the paidRows query): apply the content check only when `!seenProviderIds.has(row.providerTxnId)`.

2. A second genuinely identical charge is silently deleted from spend. Two $5.00 coffees at the same merchant on the same day, one already banked -> upsertPosted = 0, understating real spend. Consume the key (delete it from the Set on first match) so at most ONE pre-existing row is absorbed per key, and prefer flagging `needs_review` over dropping outright.

3. Scope the set correctly, and note it solves only half of what the report claims. For the manual/CSV overlap, build the set from rows with `provider_txn_id is null` only. For the re-link case you need rows from OTHER connections, which is a different query. The sign/merchantKey construction in the proposed fix is correct and matches importStatement.ts:139-152.

4. The account duplication is a separate defect the content key cannot touch: `exchange()` blind-inserts at index.ts:220 with no dedupe and there is no DB constraint. A code-level upsert alone is fragile — add `create unique index ... on public.accounts (provider_account_id) where provider_account_id is not null` alongside it, or duplicate accounts will keep doubling `totalBalance` (src/lib/recurring.ts:59-62) regardless of transaction dedup.

5. Two corrections to the report's failure scenario. Bills do NOT double on a re-link — index.ts:393 `if (paidBill.has(key) && !seenProviderIds.has(row.providerTxnId)) continue;` blocks them, and paidBill is built from every row with applies_to regardless of connection. What doubles is variable spend, income, and tracked-debt payments; the last is the worst, because the recompute `balance = tracked_baseline - sum(payments)` (index.ts:485-497) then drives debt balances TOO LOW. Also, the report omits that `disconnect` (index.ts:602) already exists in the edge function but is unexposed in the UI — surfacing it is a cheaper stopgap than the update-mode path while `link_token`'s connection_id branch (index.ts:170) stays dead.

---

## 4. [HIGH] A failed subscription upsert permanently strands the device: hb-push-off blocks the self-heal forever while the UI still says "On"

**File:** `src/lib/push.ts:105` · dimension: pwa-push

### Evidence
push.ts:101-106 — the OFF flag is cleared ONLY on the success path:
```
  if (error) {
    console.error("push subscribe save", error);
    return "default";          // <- returns WITHOUT clearing OFF_KEY
  }
  localStorage.removeItem(OFF_KEY);
  return "subscribed";
```
push.ts:128 — the self-heal is gated on that flag: `if (optedOut()) return; // switched off on purpose — leave it off`
push.ts:37-50 — getPushStatus() never reads OFF_KEY and never reads the DB; it returns "subscribed" purely on `reg.pushManager.getSubscription()`.
Note enablePush() has already called `reg.pushManager.subscribe()` (push.ts:86-89) BEFORE the upsert, so the browser subscription exists even when the row write fails.

### Failure scenario
1) User taps Notifications off → disablePush() sets hb-push-off="1", deletes the row, unsubscribes. 2) Days later they tap it back on while the phone is on a dead cell connection (or the Supabase JWT has expired, or RLS rejects): Notification.requestPermission() → "granted", pushManager.subscribe() succeeds (browser now HAS a live subscription), the upsert returns an error → line 101-104 returns "default" and line 105 never runs, so hb-push-off is still "1". 3) From that moment on, every app open calls syncPushSubscription() which early-returns at line 128 forever, and getPushStatus() sees the live browser subscription and returns "subscribed" → ProfileTab renders "On — transaction & health alerts on this phone". Result: zero rows in push_subscriptions, the self-heal permanently disabled, and the UI reporting On. This is precisely the 44-night state, and it is now unrecoverable without the user blindly toggling off and on again.

### Proposed fix
Clear the opt-out the moment the user opts IN, not after the network round-trip: move `localStorage.removeItem(OFF_KEY);` to immediately after `if (perm !== "granted") return ...` (push.ts:81), before the subscribe/upsert. Additionally make getPushStatus() consult the flag — `if (optedOut()) return "default";` before the getSubscription() check — so the UI can never render "On" while the self-heal is switched off.

### SKEPTIC correction (authoritative)
The fix is right in substance; two refinements.

(1) Part 1 is the actual repair and is sufficient on its own: move `localStorage.removeItem(OFF_KEY);` to immediately after the granted check at push.ts:81, before the subscribe/upsert. That matches the flag's own documented meaning ("This flag records the intent", lines 18-23) -- the intent is expressed at the tap, not at the round-trip. With it, a failed upsert is repaired automatically by syncPushSubscription() on the next open, so nothing is permanent. Verify there is no regression the other way: after this change the flag can only be set by disablePush(), and syncPushSubscription() never subscribes while opted out, so clearing it early cannot cause an unwanted re-subscribe.

(2) Part 2 (getPushStatus() returning "default" when optedOut()) is NOT redundant belt-and-braces -- keep it, but for a different reason than stated: with part 1 applied it no longer guards the enablePush path at all, it guards the disablePush path, where OFF_KEY is set at line 164 before the unsubscribe at 170 can throw. That is the remaining route to "flag on, browser subscription live, row deleted, UI says On".

(3) Incomplete as proposed: the failed write is still swallowed into a console.error and a status that reads as a plain "Off", so the user gets no signal that saving failed. Since this row is the deliverable half of the feature, enablePush() should distinguish "could not save" from "not enabled" and ProfileTab should say so (e.g. a "Couldn't save - retry" subtitle), otherwise the only feedback for a failed enable is a toggle that silently springs back.

---

## 5. [HIGH] planMath() ignores startsOn/endsOn, so dormant bills are charged against firepower today — Home/Insights disagree with Bills/Forecast by ~$1,164/mo

**File:** `src/lib/recurring.ts:43` · dimension: contradictions

### Evidence
src/lib/recurring.ts:43-48 — `for (const r of recurring) { if (!r.active || r.direction === "transfer") continue; const m = monthlyAmount(r); ... else bills += m; }`. There is NO startsOn/endsOn check, and no linked-debt gate. Compare src/lib/schedule.ts:144 and :193, where every calendar/forecast entry passes through `inWindow(r, monthKey, d)`. src/lib/plan.ts:126-133 consumes it directly: `const hh = householdMonthly(recurring); const fixed = hh.bills + RENTERS_INSURANCE; ... const firepower = income - fixedNonDebt - variable;` and src/views/redesign/buildVMs.ts:104 calls `planMath(data.recurring, ...)` on the unfiltered store list. src/types.ts:154-157 states the contract this breaks: "A future startsOn is a bill that is scheduled but dormant — it turns itself on, so a support payment paused until November needs nobody to remember to restore it." src/lib/changelog.ts (2026.08.16a) makes the user-facing promise: "The car payment ($232.67, first one Sept 30) and the rewritten insurance are both bills now, each with its own start date — so they stay out of August." That promise holds only for the calendar, not for firepower.

### Failure scenario
Inputs: the four active rows named in docs/ACCOUNTANT_BRIEF.md §3 whose start dates have not arrived — Car payment (Civic) $232.67 starts 2026-09-30; Car insurance (current term) $340.66 starts 2026-09-30; Car insurance (both cars) $290.59 starts 2027-02-01; Mom (support) $300 starts 2026-11-01. Today is 2026-08-18. None of them can fire in August. Wrong output: householdMonthly() adds all four to `bills`, so planMath's `fixed` is $1,163.92 too high for August. None of the four matches DEBT_PAYMENT_RX (/card payment|affirm/i — "Car payment" is not "card payment"), so none is added back, and `fixedNonDebt` carries the full $1,163.92. Home's "available at debt this month" hero (HomeVM.firepower) and Insights' "Living" / "At debt" stats (InsightsTab.tsx:187-189) therefore read roughly $913/mo instead of ~$1,919 — while the Forecast tab, built on the window-aware monthlySchedule, shows August bills at ~$2,456 exactly as the brief's table says. Two screens in the same app, over $1,000 apart, and the low one is the number used to decide what to send at the card. The same gap runs in reverse once a bill's ends_on passes (Cherry 2027-01-31, ALEKS 2026-10-14): the row stays active and keeps being charged forever. payoffSchedule() is fed projFirepower from the same figure (buildVMs.ts:371), so the debt-free date is pushed out too.

### Proposed fix
Give householdMonthly() the month it is modeling and honor the same gates the calendar uses. Change the signature to `householdMonthly(recurring: Recurring[], monthKey?: string, debts?: Debt[])` and inside the loop skip a row when (a) `monthKey` is given and no day in `r.dueDays ?? []` passes `inWindow(r, monthKey, d)` (for a row with no dueDays, test day 1 and the last day of the month), and (b) `r.linkedDebtId` resolves to a debt with `balance <= 0`. Then have planMath() take and forward the current monthKey, and have buildVMs.ts:104 pass `monthKeyOf(now)` and `data.debts`. Import inWindow from ./schedule (schedule.ts already imports from plan.ts, so move inWindow into a shared module or into recurring.ts to avoid the cycle). Do the same in scripts/snapshot.mjs, which has its own liveToday() but applies it only to the display split, not to any per-month view.

### SKEPTIC correction (authoritative)
Directionally right, but as written it introduces a new bug and includes one unnecessary change.

1) BREAKS FIREPOWER: part (b), adding a linkedDebtId/balance gate inside householdMonthly, must not be done alone. planMath's DEBT_PAYMENT_RX filter (plan.ts:129-131) has no such gate, so removing a cleared card's row from `bills` while it still counts in debtPaymentsInFixed gives fixedNonDebt = (fixed - m) - m, OVERSTATING firepower by that card's minimum. Either gate both places or drop the debt gate from this fix entirely — it is firepower-neutral today, so it is a separate concern.

2) INCOMPLETE for partial months: an all-or-nothing skip overstates a month a bill starts/stops partway. A row with dueDays [15,30] whose startsOn is the 20th should contribute amount/2, not the full monthly figure. Mirror Rule 6 / monthlySchedule: divide by the FULL day count first, filter out-of-window days, then sum the survivors.

3) Do NOT bring firesInMonth in with inWindow. Spreading quarterly/semiannual/yearly across 12 months in householdMonthly is deliberate (Rule 5 / convention 4); only the lifetime window belongs here.

4) Gate income rows too, and decide accountFlow() explicitly. The loop covers direction "in" as well — a future-dated income row would OVERSTATE income and hence firepower, the dangerous direction. accountFlow() in the same file is equally window-blind.

5) scripts/snapshot.mjs needs NO change. liveToday() is already applied to both the income and bills totals (not just a display split) — it is the correct reference implementation, and the reason this is a defect rather than a convention.

6) inWindow placement is fine: schedule.ts already imports monthlyAmount from recurring.ts and recurring.ts imports only household.ts, so moving inWindow into recurring.ts creates no cycle.

7) Magnitude caveat: the $1,163.92 figure assumes Mom's stored row is $300/mo. The repo's 2026-06-19 backup has "Mom | 600 | monthly | [15,30]" ($300/check). RLS blocks anon reads (/rest/v1/recurring returns []), so the live amount is unverified; if it is still $600 the August gap is ~$1,464. Existence and direction are unaffected.

---

## 6. [HIGH] householdMonthly ignores recurring.starts_on / ends_on, so dormant and finished bills still consume firepower

**File:** `src/lib/recurring.ts:43` · dimension: schema-integrity

### Evidence
householdMonthly filters only on `active` and `direction`:

```ts
for (const r of recurring) {
  if (!r.active || r.direction === "transfer") continue;
  const m = monthlyAmount(r);
  if (r.direction === "in") income += m; else bills += m;
}
```

The window columns added in schema_v27_bill_windows.sql are mapped into the model (FinanceStore.tsx:111-112) and enforced by the calendar path only — src/lib/schedule.ts:80 `inWindow()`, applied at schedule.ts:144 and schedule.ts:195, which the Forecast tab inherits through monthlySchedule (src/lib/forecast.ts:74). Nothing applies it on the plan path: src/lib/plan.ts:126 `const hh = householdMonthly(recurring);` feeds `fixed`, `fixedNonDebt` and `firepower`, and src/views/redesign/buildVMs.ts:104 calls `planMath(data.recurring, ...)` with the full unfiltered list. `accountFlow` (recurring.ts:16) has the same omission.

### Failure scenario
Set `starts_on = '2026-11-01'` on the Mom support row (amount 300, cadence semimonthly, active=true) — the exact case schema_v27_bill_windows.sql was written for ("Mom resumes on 2026-11-01 at $300 with nobody remembering to do it"). In August the Bills calendar and the Forecast tab correctly omit it, but householdMonthly adds 300 × CADENCE_TO_MONTHLY.semimonthly (=2) = $600 to `bills`, so planMath.fixedNonDebt is $600 too high and the Home hero "available this month" tile (buildVMs.ts:132 `firepower`) reads $600 too low. projFirepower feeds payoffSchedule, so the debt-free date is pushed out by months on money that isn't being spent. The mirror case is worse because it is silent forever: an `ends_on` in the past (a dental loan's final payment, ALEKS cancelled at term start) keeps its full amount in `bills` and keeps cutting firepower with nothing on the calendar to explain it — and the Bills screen and the Home tile now disagree about the same month.

### Proposed fix
Add a window guard and apply it on the plan path. In src/lib/recurring.ts add `export function liveOn(r: Recurring, isoDate: string) { if (r.startsOn && isoDate < r.startsOn) return false; if (r.endsOn && isoDate > r.endsOn) return false; return true; }`, give householdMonthly and accountFlow an `isoDate = new Date().toISOString().slice(0,10)` parameter, and add `if (!liveOn(r, isoDate)) continue;` next to the existing `if (!r.active)` check. Pass the same date down from planMath (src/lib/plan.ts:126) so the hero tile, the payoff schedule and the calendar all read one window.

### SKEPTIC correction (authoritative)
The direction is right but the fix is incomplete in two places and overstates what it achieves in a third.

1. MUST ALSO GUARD debtPaymentsInFixed (src/lib/plan.ts:128-130). That reduce runs its own filter -- `r.active && r.direction === "out" && DEBT_PAYMENT_RX.test(r.name)` -- independent of householdMonthly, and `fixedNonDebt = fixed - debtPaymentsInFixed`. If householdMonthly stops adding a windowed-out card-payment/Affirm row to `bills` while this filter keeps subtracting it, fixedNonDebt drops below reality and firepower reads TOO HIGH -- an overstatement of available cash, which is the worse failure direction. Today no row matching /card payment|affirm/i carries a window, so it is latent, but it fires the moment one does (exactly the ends_on case the schema was written for: a finite loan's last payment). Add the same liveOn guard to that filter.

2. payoffSchedule (src/lib/plan.ts:309-322) takes a SCALAR monthlyFirepower and holds it constant across every projected payday. Evaluating the window at today's date fixes the "available this month" tile but makes the projection ignore the $573.33/mo of car lines that start 2026-09-30 forever -- the debt-free date flips from too pessimistic to too optimistic. The projection needs the window evaluated per projected month (forecast.ts:74 already does the right thing by rebuilding monthlySchedule per monthKey); a single today-snapshot figure cannot be correct for both horizons. At minimum this limitation should be recorded rather than silently traded.

3. The claim that this makes "the hero tile, the payoff schedule and the calendar all read one window" is not accurate for boundary months. liveOn is all-or-nothing on a single date, while the calendar prorates (monthly / allDays.length computed on the FULL day count, then out-of-window days dropped -- Rule 6). For ALEKS ending 2026-10-14, the plan counts the full $21.57 on Oct 1 and $0 on Oct 20 even though the charge already posted, while the calendar shows the surviving fraction. The two still disagree in any month a bill starts or stops partway.

Minor, out of scope but adjacent: the backup/restore insert at src/store/FinanceStore.tsx:1137 writes due_days but not starts_on/ends_on, so a restore silently drops every window.

---

## 7. [HIGH] Statement-import dedup cannot recognize a Plaid feed row, so importing a covered period double-counts every charge

**File:** `src/lib/importStatement.ts:139` · dimension: ledger-categorize

### Evidence
`const dupeKey = (date, amount, desc) => `${date}|${amount.toFixed(2)}|${merchantKey(desc)}`;` and the `seen` set built from it at lines 151-153. But feed rows store Plaid's clean `merchant_name` in `description` (supabase/functions/_shared/plaidSync.ts:51 `description: t.merchant_name || t.name`) while CSV/PDF rows carry the raw BofA descriptor. Verified with the real `merchantKey` implementation: "CHIPOTLE MEX G 2915 TEMPE AZ" -> "CHIPOTLE MEX G" vs "Chipotle Mexican Grill" -> "CHIPOTLE MEXICAN GRILL"; "WHOLEFDS TMP#10250 TEMPE" -> "WHOLEFDS TMP#10250 TEMPE" vs "Whole Foods Market" -> "WHOLE FOODS MARKET"; "SAMSCLUB #4956 GAS 07/16" -> "SAMSCLUB" vs "Sams Club" -> "SAMS CLUB"; "VZ WIRELESS VW 0714" -> "VZ WIRELESS VW" vs "Verizon" -> "VERIZON". All DIFFERENT. The whole categorizeData.ts dictionary (keys like "WM SUPERCENTER", "CVS/PHARMACY #", "TRADER JOE S #") is itself evidence that BofA descriptors normalize to keys Plaid's clean names never produce.

### Failure scenario
Plaid has already synced July. Gino opens Profile -> Import (src/views/redesign/FinanceTabs.tsx:287) and drops in the July BofA CSV to check the numbers. `buildImportPlan` computes `dupeKey("2026-07-14", -18.42, "CHIPOTLE MEX G 2915 TEMPE AZ")` = "2026-07-14|-18.42|CHIPOTLE MEX G" and looks for it in `seen`, which holds the feed row's "2026-07-14|-18.42|CHIPOTLE MEXICAN GRILL". No match, so the row is presented as new, the preview shows "0 already in here", and `commitImport` inserts a second $18.42 dining row. Repeat for every variable line on the statement: July dining, groceries, gas and misc all roughly double, the lean-budget bar and `avgVariableSpend` (which drives the debt-free date) both inflate, and `firepower` drops by the phantom overspend.

### Proposed fix
Dedup on content that survives both sources, not on the description. Either (a) also index `existing` by `raw_description` — `seen` should contain a key for BOTH `merchantKey(t.description)` and `merchantKey(t.rawDescription)` when the latter is present, since the feed now stores the raw BofA descriptor (schema_v25) which is exactly what the CSV/PDF carries; or (b) fall back to a date+amount-only match and surface those as "possible duplicate — confirm" rather than silently adding. Option (a) is exact for feed rows written since v25.

### SKEPTIC correction (authoritative)
Proposed fix (a) rests on a false premise and would not work. `raw_description` is NOT the BofA statement descriptor: supabase/functions/_shared/plaidSync.ts:53 sets `raw: t.name` — Plaid's own name field. In the household's real backup, Plaid `name` renders as "CHECKCARD 0616 QT 465 INSIDE PHOENIX AZ XXXXX1661XXXXXXXXXX7754" / "PURCHASE 0615 GROK XAI WWW.GROK.COM CA ...", while the BofA CSV/PDF export renders the SAME charge as "QT 465 INSIDE 06/16 PURCHASE PHOENIX AZ". merchantKey() strips at the first 3+ digit run, so those Plaid raws collapse to the literal keys "CHECKCARD" and "PURCHASE" — indexing them adds no match for the very rows that miss today, and it plants a junk bucket ("date|amount|CHECKCARD") that could falsely mark an unrelated same-day same-amount CHECKCARD charge as a duplicate, silently dropping real spend. Measured better fix: key on merchantKey(stripStatementNoise(desc)) — stripStatementNoise already exists in src/lib/categorize.ts and removes the CHECKCARD/PURCHASE/RECURRING prefixes, MMDD tokens and masked card digits — with prefix tolerance between the two keys. Replayed over the 36 real plaid-vs-import collision pairs in _homebase_backup_2026-06-19T11-48-34-437Z.json that raises the catch rate from 18/36 to 32/36. The remaining 4 are clean-merchant-name vs truncated-descriptor ("CHIPOTLE MEXICAN GRILL" vs "CHIPOTLE MEX G"), which no description normalization can bridge — those need the claim's option (b): surface date+amount-only matches as "possible duplicate — confirm", defaulted to include:false rather than silently added. Also worth noting while fixing: the reverse direction is unguarded too — supabase/functions/plaid/index.ts:329 calls reconcile() with only two arguments, so `existingContentKeys` defaults to an empty Set and the feed never dedups against previously imported rows at all.

---

## 8. [HIGH] "Remember merchant" on a bill-payment row writes a `variable` rule that permanently outranks the bill rules

**File:** `src/views/redesign/TxnSheet.tsx:173` · dimension: ledger-categorize

### Evidence
The category grid renders for every transaction — its only guard is `{!hasSplits && (...)}` (TxnSheet.tsx:144), with no check on `txn.appliesTo` — and `remember` defaults to true (`const [remember, setRemember] = useState(true);`, line 35). Tapping a category runs `await saveMerchantRule({ pattern: merchantKey(txn.description), kind: "variable", categoryId: c.id })` (lines 173-177). In `classifyCore`, the learned-rule lookup is step 1 (src/lib/categorize.ts:344-350) and returns `{ kind: "variable", ... }` with `confidence: "high"`; `BILL_RULES` is not reached until line 399. Only `/ANTHROPIC|CLAUDE\.AI|CLAUDE (PRO|MAX|SUB)|ZELLE PAYMENT TO MON/` opts out via `amountGated` (line 340). The Plaid function loads these rules into `learned` on every sync (supabase/functions/plaid/index.ts, `merchant_rules` select).

### Failure scenario
Gino taps Bills -> Verizon -> "Pay now". `payBill` writes a ledger row with `description: rec.name` = "Verizon" and `appliesTo: {kind:"bill", ...}` and NO `settled` flag (src/store/FinanceStore.tsx:558-568), so unlike feed/import bill rows it survives the `!tx.appliesTo?.settled` filter and appears in Activity. He taps it and picks "Household + Hygiene" to fix the icon; Remember is on by default, so `VERIZON -> {kind:"variable", categoryId:"shopping"}` is saved. Plaid's merchant_name for that biller is "Verizon", so `merchantKey` = "VERIZON" matches. From the next sync on, every Verizon charge classifies variable: $103.40/mo lands in the graded budget instead of settling the bill, the Verizon bill shows unpaid on the calendar and inflates `leftThisMonth`, and `billExpected` stops seeing actuals. Same for Spotify and T-Mobile, whose recurring names also equal their Plaid merchant names. This is the exact failure the Anthropic `amountGated` carve-out was added to stop, reached through the UI instead.

### Proposed fix
In TxnSheet, do not offer (or do not persist) a merchant rule when the transaction is bill-linked: gate the `saveMerchantRule` call on `!txn.appliesTo`, or force `remember` to false and hide the toggle when `txn.appliesTo?.kind === "bill"`. Belt-and-braces: in `classifyCore`, skip a learned `variable` rule when the descriptor also matches a `BILL_RULES` / `BILL_ALIASES` entry, the same way `amountGated` opts specific merchants out of learned-rule precedence.

### SKEPTIC correction (authoritative)
The UI guard is right but the scope and the belt-and-braces half are both off.

(1) INCOMPLETE — LedgerSheet.tsx has the identical hole and must be fixed in the same change. Its row tap does `setRemember(true); setEdit(tx)` for EVERY row including bill-linked ones (LedgerSheet.tsx:129-133; its list comes from FinanceTabs ledgerTxns, which also filters only on `settled`), then the category grid writes the same unguarded variable rule (LedgerSheet.tsx:209-217). Worse, the "Not living spend — skip & exclude" button (LedgerSheet.tsx:271) writes `{pattern, kind:"skip"}` — and a learned skip hits `if (c.kind === "skip") continue;` at plaid/index.ts:377, so the row is never inserted at all. That is silent LOSS of a real charge from the ledger, strictly worse than miscategorizing it. Gate both call sites on `!txn.appliesTo`.

(2) DROP the classifyCore change. Skipping a learned `variable` rule whenever the descriptor also matches BILL_RULES/BILL_ALIASES directly contradicts the documented and load-bearing invariant at categorize.ts:344 ("A rule you taught the app wins over everything"), and would silently neuter legitimate rules for any merchant that happens to collide with a bill pattern — with no UI feedback that the rule you just saved is dead. The amountGated carve-out is a two-entry allowlist for descriptors whose answer depends on AMOUNT; generalizing it to all BILL_RULES is a different and riskier change. Fix at the write site, not the read site.

(3) Suggested belt-and-braces instead: in saveMerchantRule (FinanceStore.tsx:620), refuse to persist a `variable`/`skip` rule whose pattern resolves to a modeled recurring row — reuse the existing matchRecurringName(rule.pattern, dataRef.current.recurring) from categorize.ts:65 — and log/toast rather than writing. That covers ImportSheet.tsx:127 and any future caller too.

(4) Separately worth noting (not required for this fix): given there is no merchant-rule delete UI, any guard is prevention-only — a rule already written by this path can't be undone in-app.

---

## 9. [HIGH] notify edge function is reachable with the public publishable key — arbitrary push notification text to both household phones

**File:** `supabase/functions/notify/index.ts:21` · dimension: security

### Evidence
Same root cause as the `plaid` finding. The handler reads `p.title` / `p.body` straight from the request and sends (lines 24-33):

```ts
const p = await req.json();
const app = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";
const url = typeof p.url === "string" && p.url.startsWith(app) ? p.url : app;
const res = await sendPush(admin, { title: p.title ?? "Homebase", body: p.body ?? "", url, tag: p.tag }, p.owner);
```

The `url` is correctly clamped to `APP_URL`; `title` and `body` are not validated at all, and there is no caller check. The header comment at line 2 asserts `"(JWT-verified: service-role/cron/app)"`, which does not hold.

Confirmed live using a malformed body, so that the request passes the auth gate but throws at `req.json()` before any push is sent:

```
$ curl -X POST .../functions/v1/notify -d 'not-json'
HTTP 401

$ curl -X POST .../functions/v1/notify \
    -H "Authorization: Bearer sb_publishable_907KbW_QmcTvL-wFHg-8yA_roZe8u_2" \
    -H "apikey: sb_publishable_907KbW_QmcTvL-wFHg-8yA_roZe8u_2" -d 'not-json'
{"error":"Unexpected token 'o', \"not-json\" is not valid JSON"}
HTTP 500
```

The 500 (a parse error from inside the handler) rather than 401 proves auth was satisfied by the publishable key alone.

### Failure scenario
An attacker with the key from the public bundle sends `POST /functions/v1/notify` with body `{"title":"Homebase security alert","body":"Fraud detected on Geo ...4662 - call 555-0100 to verify","owner":"Gino"}`. `sendPush` fans it out to every row in `push_subscriptions` for that owner plus `Joint`, and `webpush.sendNotification` is called with `urgency: "high"`, so it lands on the lock screen immediately. The notification renders with the Homebase icon and badge (`public/push-sw.js` lines 25-30), so it is indistinguishable from a genuine app alert. Two people who trust this app for real money decisions get an authentic-looking fraud-alert phish, repeatable at will. The attacker can also flood both phones as denial-of-service, and can enumerate the household by owner (`"Gino"` vs `"Xinyan"` produce different `sent` counts in the JSON response, which is returned to the caller).

### Proposed fix
Apply the same authorization gate as the `plaid` fix, at the top of `Deno.serve` (line 21) before `req.json()`:

```ts
const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
if (bearer !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
  const { data: { user } } = await createClient(
    Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${bearer}` } } },
  ).auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
}
```

Also narrow `CORS["Access-Control-Allow-Origin"]` at line 13 from `"*"` to `Deno.env.get("APP_URL")`, and fix the comment at line 2.

### SKEPTIC correction (authoritative)
The gate is the right idea but the snippet has two problems and one omission. (a) It builds a second client from `SUPABASE_ANON_KEY`. This project has migrated to the new key format (the app ships `sb_publishable_*`), and on projects with legacy keys disabled `SUPABASE_ANON_KEY` can be empty — `createClient(url, "")` throws, and the throw lands in the handler's own catch only if placed inside the try, otherwise it 500s every request. Use the client that already exists instead: `const { data: { user } } = await admin.auth.getUser(bearer);` — the service-role client validates a user access token directly, no anon key needed, and it correctly returns no user for `sb_publishable_*`. (b) The service-role branch is dead weight here: nothing in the repo calls `notify` with the service role key (crons call cron-notify, the webhook calls plaid-webhook, the deploy calls announce-update, the app invokes only `plaid`). Keep it only if manual curl testing matters; note that if `SUPABASE_SERVICE_ROLE_KEY` is unset the comparison is always true and it correctly falls through to the user check, so it still fails closed. (c) Narrowing `Access-Control-Allow-Origin` from `*` to `APP_URL` does NOT mitigate this at all — my reproduction was plain curl, which ignores CORS entirely. It is fine as hygiene but must not be counted as part of the fix. Stronger option worth considering given `notify` has zero production callers: delete the function outright, or gate it on a query-string shared secret exactly like announce-update/cron-notify, which removes the surface rather than narrowing it. Also fix the two stale assertions: supabase/functions/notify/index.ts:2 and docs/ACCOUNTANT_BRIEF.md:319, and re-check the same reasoning in supabase/config.toml's comment about `plaid`, which rests on the identical false premise.

---

## 10. [MEDIUM] cron-notify never reads starts_on / ends_on — it pushes "bill due" for bills the app knows are dormant or finished

**File:** `supabase/functions/cron-notify/index.ts:76` · dimension: edge-drift

### Evidence
cron-notify/index.ts:74-77 selects:
  .select("id, name, due_days, amount, direction, active, cadence, anchor_date, linked_debt_id")
No starts_on / ends_on, and the bill loop (lines 93-104) has no lifetime check at all.

The client does have one — src/lib/schedule.ts:
  export function inWindow(r: Recurring, monthKey: string | undefined, day: number): boolean {
    if (!r.startsOn && !r.endsOn) return true;
    ...
    if (r.startsOn && iso < r.startsOn) return false;
    if (r.endsOn && iso > r.endsOn) return false;
  }
and monthlySchedule() calls it per due day: `if (!inWindow(r, monthKey, d)) continue;`

schema_v27_bill_windows.sql added the columns on the stated premise that "Mom resumes on 2026-11-01 at $300 with nobody remembering to do it" and "ALEKS stops billing when the term starts, on its own". docs/ACCOUNTANT_BRIEF.md:147-156 lists the live rows carrying windows: Mom $300 "paused, restarts 2026-11-01"; Cherry "ends 2027-01-31"; ALEKS "ends 2026-10-14"; Car payment (Civic) "due 30, starts 2026-09-30"; Car insurance (both cars) "due 1, starts 2027-02-01". A windowed row stays active=true — that is the whole point of v27 — so cron's `.eq("active", true)` filter does not exclude any of them.

### Failure scenario
Cron runs 8 PM AZ on 2026-08-29. Mom (active, direction out, cadence monthly, due_days [15,30], starts_on 2026-11-01) has dd=30 == dom+1 → the phones get "📅 Bill tomorrow — Mom · $600.00" for a support payment that is paused until November and shows nothing on the app's calendar. Same false push on Aug 30, Sep 14/15, Sep 29/30, Oct 14/15, Oct 29/30. Same night, Car payment (Civic) (due_days [30], starts_on 2026-09-30) fires "Car payment · $232.67" a month before the loan's first payment exists. Car insurance (both cars) (due_days [1], starts_on 2027-02-01) fires "$290.59 today" on the 1st of Sep, Oct, Nov, Dec and Jan. After 2026-10-14 ALEKS keeps pinging $21.57 monthly forever; after 2027-01-31 Cherry keeps pinging $151.72 monthly forever.

### Proposed fix
Add starts_on, ends_on to the select on line 76, port inWindow into cron-notify, and call it inside the due_days loop before pushing:

  function inWindow(startsOn: string|null, endsOn: string|null, monthKey: string, day: number): boolean {
    if (!startsOn && !endsOn) return true;
    const iso = `${monthKey}-${String(day).padStart(2, "0")}`;
    if (startsOn && iso < startsOn) return false;
    if (endsOn && iso > endsOn) return false;
    return true;
  }

then at line 100, after `if (!rel) continue;`:
  if (!inWindow(r.starts_on ?? null, r.ends_on ?? null, monthKey, dd)) continue;

Pass the CLAMPED dd (matching schedule.ts inWindow, which clamps with Math.min(day, lastDay)).

### SKEPTIC correction (authoritative)
The fix is correct as written, including the subtle part. Passing the already-clamped `dd` matches `schedule.ts inWindow`, which clamps with `Math.min(day, lastDay)` — so a Mom row (due_days [15,30]) in a 28-day February resolves to `2026-02-28` in both copies. And the ported version needs no clamp of its own precisely because `dd` is pre-clamped at line 98.

Placement after `if (!rel) continue;` is fine and cheap. Note that the `monthKey` used is always the right month for `dd`: cron's "tomorrow" is `dd === dom + 1`, which can never match on the last day of a month (`dom + 1 > daysInMonth`), so there is no cross-month case where the window would be evaluated against the wrong month. That also means the fix cannot introduce a new miss.

Two things the fix does not address, which are separate drifts of the same Rule 11 class and should not be folded in silently:
- cron pushes `Number(r.amount)` while the app uses `knownAmount`/`billExpected()` for variable rows, so a variable bill's push amount can disagree with the screen (e.g. Electric, which carries a known_amount override).
- cron places every cadence on `due_days`, while `schedule.ts` places a biweekly row on stepped anchor dates via `biweeklyDaysIn()` (commit 0c7268f). Only matters if a biweekly `direction: "out"` row exists; I saw none in the brief.

If this is fixed, `docs/ACCOUNTANT_BRIEF.md:307` should gain `inWindow()` to the ported-rules list, otherwise the next window rule change drifts the same way a third time.

---

## 11. [MEDIUM] The `utilities` category is on no budget line AND not in OUTSIDE_BUDGET_CASH_CATS — money assigned to it disappears from the budget and from firepower

**File:** `src/lib/plan.ts:74` · dimension: contradictions

### Evidence
LEAN_VARIABLE (plan.ts:30-61) covers exactly: groceries, transport, dining, shopping, health, subscriptions, entertainment, housing, pets, other, kids. `OUTSIDE_BUDGET_CASH_CATS = ["electronics", "car"]` (plan.ts:74). DEFAULT_CATEGORIES (seed.ts:16) defines `{ id: "utilities", name: "Utilities", icon: "💡", type: "expense" }`. Enumerating every expense category against the lines leaves exactly two uncovered: `interest` (deliberate, documented at plan.ts:71-73 and 76-80) and `utilities` (documented nowhere). plan.ts:76-80 states the intended invariant and names only three exceptions: "`electronics`, `car` and `interest` deliberately belong to NO line". plan.ts:43-45 states the design rule this breaks: housing was folded in "so a stray charge in any of them still COUNTS against the envelope instead of escaping it — an uncovered category is invisible to the budget." src/lib/changelog.ts (2026.07.15a) sold this to the user as fixed: "Fixed a hole where some purchases didn't count toward your budget at all — anything you buy now lands on a budget line, so a mislabel can shift a category but can never make money disappear." docs/ACCOUNTANT_BRIEF.md:262 repeats it: "Three categories are on **no** budget line". The category is user-selectable: TxnSheet.tsx:44 builds its picker from `data.categories.filter((c) => c.type === "expense" || c.type === "both")`, which includes utilities, and the split editor uses the same list.

### Failure scenario
Inputs: a $180 city water/sewer charge lands in the feed as needs_review (HANDOFF records 181 such rows) and the user taps it and picks "Utilities" — the obvious choice, sitting directly under "Housing" in the picker. The row has no appliesTo. Wrong output: spentByCategoryBetween returns {utilities: 180}; `inAnyLine("utilities")` is false, so variableSpentThisMonth and variableSpentBetween both exclude it — the budget bars and the $1,600 envelope do not move. `OUTSIDE_BUDGET_CASH_CATS` does not contain it, so `outsideBudgetCash` in buildVMs.ts:124 is 0 and firepower is not reduced either. The donut (buildVMs.ts:201, built only from budget lines) omits it entirely. $180 of real cash left the account and is invisible on every finance screen; firepower — the number that decides what gets sent at the 26.49% card — overstates by $180. The same happens to any split slice allocated to utilities.

### Proposed fix
Decide which of the two documented shapes utilities is and encode it. Either (a) add "utilities" to the household line's cats in plan.ts:46 so a stray utility charge is graded (bills already carry appliesTo and are excluded by spentByCategoryBetween's `!t.appliesTo` filter, so this cannot double-count real bill payments), or (b) if it is meant to be ungraded like electronics, add "utilities" to OUTSIDE_BUDGET_CASH_CATS at plan.ts:74 so it still cuts firepower. Then add a build-time assertion that every DEFAULT_CATEGORIES expense id is either covered by a LEAN_VARIABLE line or listed in an explicit UNGRADED set (electronics, car, interest) — this class of hole has now shipped twice (changelog 2026.07.15a fixed it for `other`/`housing`) and only a check can keep it closed. Update ACCOUNTANT_BRIEF.md:262 to match.

### SKEPTIC correction (authoritative)
Direction is right, one part of the rationale is wrong and the option choice needs a caveat.

WRONG RATIONALE: "bills already carry appliesTo ... so this cannot double-count real bill payments" is only true for bills that auto-matched. The repo documents the opposite case — `matchRecurringName` (categorize.ts:65-84) exists precisely because "bills didn't auto-flip to paid because the bank's descriptor name didn't string-equal the modeled bill name." An unmatched SRP payment has NO appliesTo while its $85 is already inside `fixed` via householdMonthly. Under fix (a) that $85 gets graded against the $350 Household envelope; under fix (b) it comes off firepower a second time. Both options double-count in that case — the fix must state which error it prefers, not claim there is none.

OPTION CHOICE: prefer (b), adding "utilities" to OUTSIDE_BUDGET_CASH_CATS, not (a). A utility is non-discretionary; folding it into the discretionary Household + Hygiene envelope makes that line fail for a bill the user cannot choose not to pay — the same objection that earned `car` its carve-out. (b) keeps the envelope honest and still cuts firepower, which is the number that decides what gets sent at the 26.49% card. Note this changes OUTSIDE_BUDGET_CASH_CATS's own doc comment, which currently justifies itself as one-time capital costs — utilities is a recurring cost, so the comment needs rewriting, not just extending.

BETTER STILL, alongside (b): model the actually-missing utilities (SW Gas, city water/sewer) as recurring rows in src/lib/household.ts and add BILL_RULES entries, so their payments get appliesTo and land in `fixed` where they belong. (b) is the safety net for anything not yet modeled.

BUILD-TIME ASSERTION: good and it will work — `data.categories` is a static `DEFAULT_CATEGORIES` (FinanceStore.tsx:253) with no user-add path (no addCategory / no insert into a categories table anywhere in src), so the id set is closed and a compile-time check over it is complete. Put it where `npm run build` already runs checks (scripts/, alongside check-categorizer-sync.mjs), and have it assert over DEFAULT_CATEGORIES expense+both ids, not just expense — `both`-typed ids would slip through the narrower check.

ALSO MISSING FROM THE FIX: buildVMs.ts:214 `envLabel` must stop falling back to `catName` for an ungraded category. Even after (b), a utilities row would still be badged `→ Utilities` by fateOf (buildVMs.ts:534) as if it hit an envelope. Ungraded categories need the "not in budget" badge shape, or the display stays wrong while the math gets fixed.

---

## 12. [MEDIUM] cron-notify ignores known_amount and the rolling-average estimate, so variable bills notify a stale modeled figure

**File:** `supabase/functions/cron-notify/index.ts:102` · dimension: edge-drift

### Evidence
cron-notify/index.ts:76 does not select known_amount or variable, and line 102 uses Number(r.amount) unconditionally.

The client projects variable bills through billExpected (src/lib/plan.ts:154-176):
  export function billExpected(bill: Recurring, transactions: Transaction[]): number {
    if (!bill.variable) return bill.amount;
    if (bill.knownAmount != null) return bill.knownAmount;
    ... mean of the last 3 tagged actuals ...
  }
and monthlySchedule() routes every out-direction variable row through it:
  const monthly = r.direction !== "in" && r.variable && transactions ? billExpected(r, transactions) : monthlyAmount(r);

src/store/FinanceStore.tsx:113 maps the column: `knownAmount: r.known_amount != null ? Number(r.known_amount) : undefined`.

Live overrides per docs/ACCOUNTANT_BRIEF.md:151-152:
  Verizon        $93   due 24  (known_amount override)
  Electric (SRP) $100          (known_amount override — clear once a winter bill posts)
and the brief's failure table (line 384) records the gap those overrides exist to close: "Verizon projected $130 vs a real $93; electric $83 vs $100". The stored recurring.amount for Electric (SRP) is 85 and for Verizon 83 in the backup JSON.

### Failure scenario
Cron runs the evening Electric (SRP) is due. The row is variable with known_amount = 100 and amount = 85, so the push reads "Electric (SRP) · $85.00" while the app's bill calendar, the pay sheet's pre-filled amount, and dueBeforeNextPayday all read $100.00 — the figure Gino actually entered after reading the bill. Verizon behaves the same way (push shows the stored amount, app shows the $93 override). Even with no override set, a variable bill whose last three actuals average $130 still pushes the stored $83.

### Proposed fix
Add `variable, known_amount` to the select on line 76, and widen the transactions query on line 78 from `.select("applies_to")` to `.select("applies_to, amount, date, type")` so the rolling average can be computed. Then port billExpected: for a row with variable === true use Number(r.known_amount) when non-null, otherwise the mean of the amounts of the last 3 expense rows whose applies_to.kind === 'bill' and applies_to.recurringId === r.id (sorted most-recent-first by date, then applies_to.monthKey, then applies_to.day — the same ordering as plan.ts), falling back to Number(r.amount) when there are none. Feed that figure into the perPayment calculation from the previous finding.

### SKEPTIC correction (authoritative)
The fix is right in direction but incomplete in one place and over-specified in another.

Correct and verified: adding `variable, known_amount` to the line-76 select; widening line 78 from `.select("applies_to")` to `.select("applies_to, amount, date, type")`. supabase/schema.sql:12-13 stores `amount numeric(12,2)` as a positive magnitude with `type text check (type in ('income','expense'))`, so filtering `type === 'expense'` is enough and no sign handling is needed. The existing `.not("applies_to","is",null)` filter can stay — billExpected only ever consumes rows whose appliesTo.kind === "bill", so the filter is a strict superset. Port the tie-break exactly as plan.ts:163-171 has it (date desc, then applies_to.monthKey desc, then applies_to.day desc), and mirror mapRecurring's coercion: treat the row as variable only when `r.variable === true`, and take the override only when `r.known_amount != null` (0 is a legitimate override and must not be swallowed by a truthiness test).

The gap: billExpected returns a MONTHLY figure, but line 102 pushes one entry per element of r.due_days. Feeding billExpected's return straight into `amount` would overstate any variable bill with more than one due day (a $600/month row on due_days [15,30] would push $600 on each date instead of $300). The fix defers this to "the perPayment calculation from the previous finding," which only works if that finding actually lands; if it does not, this change must itself divide by r.due_days.length — and per deliberate convention 5, by the FULL due-day count, before any out-of-window filtering, not by the surviving count.

Out of scope but adjacent, do not silently fold in: cron-notify also never learned starts_on/ends_on (schema_v27), so a dormant or ended bill can still ping. That is separate drift and needs its own finding, not a rider on this one.

---

## 13. [MEDIUM] cron-notify's "tomorrow" reminder can never fire across a month boundary, so rent (due day 1) gets no day-before warning

**File:** `supabase/functions/cron-notify/index.ts:99` · dimension: edge-drift

### Evidence
cron-notify/index.ts:45-51 derives a single month:
  const monthKey = today.slice(0, 7);
  const dom = az.getUTCDate();
  const daysInMonth = new Date(Date.UTC(az.getUTCFullYear(), az.getUTCMonth() + 1, 0)).getUTCDate();
and line 98-99 only ever compares against days inside it:
  const dd = Math.min(d, daysInMonth);
  const rel = dd === dom ? "today" : dd === dom + 1 ? "tomorrow" : null;

On the last day of a month dom === daysInMonth, so dom + 1 === daysInMonth + 1, and dd is clamped to at most daysInMonth. The "tomorrow" arm is therefore unreachable on the final day of every month, and next month's rows are never scanned.

Rent is due_days [1] (backup JSON, amount 1715; docs/ACCOUNTANT_BRIEF.md:147 lists it at $1,732.16). docs/HANDOFF.md records why the day-before matters: "Rent drafts from the JOINT …1211 (holds ~$3) → funded by transfer before the 1st."

### Failure scenario
Cron runs 8 PM AZ on 2026-08-31. dom = 31, daysInMonth = 31. Rent's dd = min(1,31) = 1; 1 !== 31 and 1 !== 32, so no push. The only rent reminder ever sent arrives at 8 PM on the 1st — after the draft has already been attempted against an account that normally holds about $3. Every bill due on the 1st is affected: Rent, and (once live) Car insurance (both cars) $290.59. Bills due mid-month are unaffected, which is why the gap is invisible in testing.

### Proposed fix
When dom === daysInMonth, also evaluate the next month. Compute a second (nextMonthKey, nextDaysInMonth) pair and, inside the loop, treat `Math.min(d, nextDaysInMonth) === 1` as rel "tomorrow" — checking paidSet with nextMonthKey and applying the same firesInMonth / window / linked-debt gates against nextMonthKey, so an early-paid or out-of-window row is still suppressed.

### SKEPTIC correction (authoritative)
Directionally correct and it does name the right gates to re-apply (paidSet under nextMonthKey, firesInMonth against nextMonthKey, linked-debt), but three corrections:

1. There is no "window" gate in cron-notify to re-apply. The function filters only on `active`, `direction === "out"`, `linked_debt_id`/cleared-debt, and `firesInMonth`. It never reads start/end dates. Copying a nonexistent gate into the new branch will not compile against the current select list (`id, name, due_days, amount, direction, active, cadence, anchor_date, linked_debt_id`) — and the new pass must not add one, or month-end behavior would diverge from mid-month.

2. `Math.min(d, nextDaysInMonth) === 1` is redundant: nextDaysInMonth is always >= 28, so the clamp can never produce 1 from anything but d === 1. Write `d === 1` and say why (tomorrow, on a month-end run, is by definition the 1st).

3. Prefer a two-pass loop over a special-case `if (dom === daysInMonth)` branch. Compute tomorrow's real date once —
   const tmr = new Date(az.getTime() + 86400000);
   const tmrKey = tmr.toISOString().slice(0,10).slice(0,7);
   const tmrDom = tmr.getUTCDate();
   const tmrDim = new Date(Date.UTC(tmr.getUTCFullYear(), tmr.getUTCMonth()+1, 0)).getUTCDate();
— then run the identical per-row gate body twice: once as (monthKey, dom, daysInMonth, "today") and once as (tmrKey, tmrDom, tmrDim, "tomorrow"). That collapses the special case into the general one, keeps both arms using the same clamp semantics, and removes the standing risk that a future edit to the gates gets ported to one branch and not the other — the exact drift docs/HANDOFF.md:5 already records for this file. Keep the paid-check key on the raw day (`${r.id}|${tmrKey}|${d}`), matching how paidKey() stores `at.day`.

---

## 14. [MEDIUM] Pending-charge insert uses ON CONFLICT against a PARTIAL unique index, so it errors and no pending row is ever written

**File:** `supabase/functions/plaid/index.ts:546` · dimension: schema-integrity

### Evidence
The insert asks Postgres to infer an arbiter index:

```js
const { error: pErr } = await admin.from("transactions")
  .upsert(pendingRows, { onConflict: "provider,provider_txn_id", ignoreDuplicates: true });
if (pErr) console.warn("pending upsert:", pErr.message);
```

The only unique index on those columns is partial — schema_v8_bankfeed.sql:33-35:

```sql
create unique index if not exists uq_txn_provider
  on public.transactions (provider, provider_txn_id)
  where provider_txn_id is not null;
```

PostgREST renders this as `ON CONFLICT (provider, provider_txn_id) DO NOTHING` with no WHERE predicate, and Postgres cannot select a partial index as the arbiter unless the statement's ON CONFLICT carries a predicate implying the index predicate — it raises 42P10, "there is no unique or exclusion constraint matching the ON CONFLICT specification", at plan time regardless of whether any row actually conflicts. The error is swallowed by `console.warn`, so the sync still reports `{ pending: n }` in its result and `status:'ok'`. The code's own comment 37 lines above (line 509) says the opposite of what it does: "We delete-then-insert (avoids ON CONFLICT on the partial provider index)." The RPC path gets this right — apply_bank_sync spells the predicate out: `on conflict (provider, provider_txn_id) where provider_txn_id is not null`.

### Failure scenario
Plaid returns a pending $48.90 card charge. reconcile puts it in ops.pendingUpsert; the delete at line 514 removes any prior pending row; pendingRows gets one entry; the upsert at line 546 fails with 42P10 and is logged as a warning only. No row with status='pending' is ever created, so mapTxn's `pending: r.status === "pending"` (FinanceStore.tsx:50) is never true, and the "processing" badge that types.ts:73-76 documents never appears for any charge. The user sees nothing between the swipe and the post — the exact gap the feature was built to close — and the sync reports success.

### Proposed fix
Drop the conflict clause: the hard-scoped delete immediately above already guarantees no pending row with those ids survives, so replace the call with `await admin.from("transactions").insert(pendingRows)` and surface the error (throw, or write it to bank_connections.last_error) instead of console.warn. If an idempotent upsert is genuinely wanted here, add a non-partial unique index on (provider, provider_txn_id) or move the write into an RPC that spells out `on conflict (provider, provider_txn_id) where provider_txn_id is not null`, the way apply_bank_sync does.

### SKEPTIC correction (authoritative)
The insert half is right; the error-handling half would make things worse. Do NOT throw. `cursor` is persisted only at index.ts:552, AFTER the pending block. If the pending write throws, the cursor never advances, the catch block (index.ts:568-586) sets status:'error' and increments consecutive_failures, and the next sync replays the identical delta and fails the same way — a permanent sync wedge, strictly worse than the current swallow. Writing to bank_connections.last_error also does not work as proposed, because line 552 immediately overwrites it with `last_error: null, status: "ok"`; any diagnostic write must happen after that update, or be folded into it.

Also note `.upsert(pendingRows, { ignoreDuplicates: true })` with onConflict simply dropped is NOT a valid alternative: per QueryBuilder.hs:117-119, `if null oncCols then mempty` means PostgREST emits no ON CONFLICT clause at all, degrading to a plain INSERT that raises 23505 on any duplicate.

Recommended: keep the plain `.insert(pendingRows)` (the delete at 514-521 is hard-scoped to provider='plaid' AND status='pending' AND provider_txn_id IN removeIds, and removeIds includes every ops.pendingUpsert providerTxnId, so no pending row with those ids survives), and make the failure visible without aborting — e.g. capture pErr and fold `last_error` into the same line-552 update instead of nulling it. The alternative of moving the write into an RPC that spells `on conflict (provider, provider_txn_id) where provider_txn_id is not null` is the more robust option and also covers the institutions where Plaid flips a txn from pending to posted in place under the SAME transaction_id. The third suggestion — adding a non-partial unique index — is unnecessary: it would not break hand-entered rows (Postgres unique indexes are NULLS DISTINCT by default) but it is a schema change that buys nothing over the two options above.

---

## 15. [MEDIUM] Budget drill-in list counts pending charges the bar excludes, so the rows never sum to the number they explain

**File:** `src/views/redesign/buildVMs.ts:163` · dimension: ledger-categorize

### Evidence
`if (t.type !== "expense" || t.date < cycle.start || t.date > cycle.end || t.appliesTo) continue;` — no `!t.pending`. The bar it sits next to comes from `lineSpent(l, byCat)` where `byCat = spentByCategoryBetween(...)`, whose predicate IS pending-aware: `t.type === "expense" && t.date >= startISO && t.date <= endISO && !t.appliesTo && !t.pending` (src/lib/plan.ts:459-464). `mapTxn` sets `pending: r.status === "pending"` (FinanceStore.tsx:50), and the Plaid function inserts pending rows as `type: "expense"`, `status: "pending"`, no `applies_to`, dated inside the cycle. CategorySheet renders `vm.spent` and `vm.txns` in the same panel (src/views/redesign/CategorySheet.tsx:78-118) with no pending marker on the rows. The comment directly above line 163 claims "the same partition spentByCategoryBetween uses, so the rows always sum to the bar."

### Failure scenario
A $62.18 Fry's charge is still processing (Plaid pending) and dated inside the current pay cycle. The Groceries envelope bar reads $412.00 / $600 from `spentByCategoryBetween`, but tapping it opens a list whose rows sum to $474.18 — a $62.18 discrepancy with nothing on screen explaining it. This is the same bar-vs-list divergence ($79.58 vs $44.13) the comment block at lines 150-158 was written to close.

### Proposed fix
Add `|| t.pending` to the skip condition on line 163 so the drill-in list uses the identical predicate as `spentByCategoryBetween`. If pending charges should be visible there, render them in a separate "still processing" section that is explicitly excluded from the sum.

### SKEPTIC correction (authoritative)
The one-line fix is correct but the second option is the better one for this codebase, and the proposal understates the work it needs. Adding `|| t.pending` at buildVMs.ts:163 does restore the invariant, but it makes the drill-in the only surface that hides still-processing charges: HomeTab.tsx:247 and ActivityTab.tsx:50 already show pending rows with a "◌ Processing" badge, and buildVMs.ts:552-553 already carries `pending` onto ActivityRow. Hiding them here means a charge visible on Home and Activity vanishes from the category it belongs to.

Preferred: keep the rows, mark them, exclude them from the sum. That requires three edits the proposal does not name — (1) add `pending?: boolean` to the `EnvelopeVM` txn type at CategorySheet.tsx:15, (2) carry `pending: !!t.pending` through the `raw` array and the `txns` map in buildVMs.ts:159-190, (3) render the "Processing" badge in the CategorySheet row and either group pending rows into their own section or annotate the bar with the held amount. Whichever route is chosen, the invariant to hold is that the non-pending rows sum to `vm.spent`, and the comment at buildVMs.ts:164-166 should be updated to state the pending exclusion explicitly rather than just the split partition — that comment's silence on pending is what let the two predicates drift.

---

## 16. [MEDIUM] Unanchored `76\b` in the fuel keyword rule files unknown merchants with a 76-ending store number as gas

**File:** `src/lib/categorize.ts:247` · dimension: ledger-categorize

### Evidence
`{ re: /CHEVRON|SHELL|CIRCLE K|\bQT\b|QUIKTRIP|FRYS FUEL|ARCO|\bMOBIL\b|EXXON|SUNOCO|KWIK|CONOCO|76\b/i, appCategory: "transport" }` — the `76` alternative (the Phillips 66 "76" brand) has a trailing `\b` but no leading `\b`, so it matches "76" anywhere followed by a non-word character. This rule is FIRST in `KEYWORD_FALLBACK`, ahead of the groceries, dining and shopping rules, and `classify` tests the full descriptor, not `merchantKey`. Verified by executing the real regexes: "TARGET T-3176 PHOENIX AZ" -> transport; "SPROUTS FARMERS MKT 176 TEMPE" -> transport; "CHECKCARD 0714 IKEA TEMPE 476 AZ" -> transport; "PANERA BREAD #3876 MESA AZ" -> transport. ("AMAZON MKTPL #A176BC" correctly falls through to shopping because the following char is a word char.) The identical line exists in the deployed copy at supabase/functions/_shared/categorize.ts:247, so both the import path and the live bank feed are affected. That the dictionary already contains "TARGET T-2176" confirms BofA writes store numbers in this shape.

### Failure scenario
A Target store not in the 131-merchant dictionary posts as "TARGET T-3176 PHOENIX AZ" for $84.20. No learned rule, no dictionary hit, so it reaches KEYWORD_FALLBACK, matches `76\b` on "T-3176 ", and is filed `transport` with `confidence: "low"`. It lands on the "Gas + convenience" line ($200 target) instead of "Household + Hygiene" ($350). On the feed path it is also written with `needs_review: true` but the wrong category sticks until someone notices. Multiple such charges in a month push the gas line over budget while household reads under — the same class of wrong-line error that drove the documented $402-vs-$259 fuel misread.

### Proposed fix
Anchor both sides: change `76\b` to `\b76\b` in src/lib/categorize.ts:247 and in the mirrored supabase/functions/_shared/categorize.ts:247. Even `\b76\b` still matches a bare "176"? No — `\b` before 7 requires a non-word char immediately before, so "T-3176" no longer matches while a real "76 STATION 4412" still does. Run scripts/check-categorizer-sync.mjs after editing to keep the two copies in step.

### SKEPTIC correction (authoritative)
The proposed `\b76\b` is correct and I verified it kills every demonstrated failure: "T-3176", "MKT 176", "STORE 76"-style interiors, and the masked tail "…7276" all stop matching (the char before the `7` is a word char), while "76 STATION 4412 MESA AZ" still matches. Applying it to both `src/lib/categorize.ts:247` and `supabase/functions/_shared/categorize.ts:247` is mandatory, and that is already enforced — `scripts/check-categorizer-sync.mjs` does a full normalized text compare of the two files and runs inside `npm run build`, so editing one alone fails the build.

Two things the fix does not cover, worth adding:
1. Residual overbreadth. `\b76\b` still matches a standalone "76" token anywhere — a store number "SOME STORE 76 MESA AZ" or a street address "76 W MAIN ST" would still be filed as fuel. If you want it tight, require fuel context on that one alternative, e.g. `\b76\b(?=\s*(GAS|FUEL|STATION|#|\d))` — but that is a judgment call, not a defect.
2. Phillips 66 itself is not in the rule at all. There is no `PHILLIPS ?66` alternative, so the parent brand's own descriptor falls through to "other". Worth adding while you are in the line.

Deeper root cause, optional: `KEYWORD_FALLBACK` runs against the raw descriptor BEFORE the `stripStatementNoise` retry, which is why a card-mask digit can outrank a dictionary merchant. Anchoring `76` fixes the sharp edge; running the keyword pass on the noise-stripped text first (or at least preferring the cleaned dictionary hit over an uncleaned keyword guess) would close the class. That is a refactor, not required for this fix.

---

## 17. [MEDIUM] CSV/PDF import never passes the raw descriptor to classify(), so the fuel-vs-store fix does not apply to imports

**File:** `src/lib/importStatement.ts:172` · dimension: ledger-categorize

### Evidence
`const c = classify(r.description, r.amount, learned);` — the fourth argument `raw` is omitted. `resolveDepartment` returns early on a missing raw: `if (!raw) return null;` (src/lib/categorize.ts:164), so the `dept === "fuel"` branch (line 325) and the `ambiguous` branch (line 291) can never fire on an import. But for a CSV/PDF row, `r.description` IS the untouched bank descriptor — it is the richest form available, not a cleaned name. Verified by executing the real regexes on "SAMSCLUB #4956 GAS 07/16": `MULTI_DEPARTMENT.test` = true, `FUEL_TOKEN.test` = true, so passing it as `raw` yields `dept = "fuel"`; omitting it yields `null`. The Plaid path does pass it (`classify(row.description, row.amount, learned, row.raw)`).

### Failure scenario
A BofA CSV row "SAMSCLUB #4956 GAS 07/16" for $58.31 is imported. With `raw` omitted, `resolveDepartment` returns null, so the pump tag is discarded. Tracing the rest: `merchantKey` = "SAMSCLUB", no dictionary entry (the dict has no "SAMSCLUB" key), and the groceries fallback `SAM'?S? CLUB` requires a literal space so it does not match "SAMSCLUB" either — the charge falls all the way to `{kind:"variable", appCategory:"other", reason:"new merchant"}` and is graded against the $125 Misc line. The gas line under-reads by $58.31 and Misc over-reads by the same, on the exact merchant whose misclassification is documented as having cost $143 and triggered a budget re-cut.

### Proposed fix
Pass the descriptor as its own raw: `const c = classify(r.description, r.amount, learned, r.description);` at src/lib/importStatement.ts:172. `resolveDepartment` is safe with desc === raw (it tests MULTI_DEPARTMENT on desc and FUEL_TOKEN on raw), and the `ambiguous` result already flows into `lowConfidence` -> the existing one-tap clarify card, so untagged warehouse-club charges get asked about instead of guessed.

### SKEPTIC correction (authoritative)
The one-liner is correct and safe as far as it goes — `classify(r.description, r.amount, learned, r.description)` at src/lib/importStatement.ts:172. I checked the false-positive risk: `resolveDepartment` gates on the closed `MULTI_DEPARTMENT` list first, so the SW GAS / SOUTHWEST GAS utility bill can never reach `FUEL_TOKEN`, and `\bGAS\b` is word-anchored (VEGAS/GASTON safe). No bill rule is hijacked, since the fuel branch only fires on warehouse-club/supermarket brands.

But it is incomplete in one respect the claim understates. Turning on `raw` also turns on the `ambiguous` branch for imports, which flips rows that are currently high-confidence into clarify cards — executed: `"CIRCLE K #2709 07/12"` goes from `transport / high` to `transport / low / ambiguous`, and the same happens for every token-less WAL-MART / SAFEWAY / FRYS / COSTCO / SAM'S CLUB row. That is the intended design, but it collides with two things on the import path:

1. `ImportSheet.answerClarify` saves a permanent merchant-keyed rule, and `classify()` deliberately re-flags ambiguous even when a learned rule fired — I ran it: with `learned = {"SAMS CLUB": groceries}` and raw passed, the result is still `confidence:"low", ambiguous:true`. So the saved rule can never silence the card, and the same clarify question re-appears on every future import of those merchants.
2. `buildImportPlan` discards `c.ambiguous` (line 205 reads only `c.confidence === "low"`), so the importer cannot tell "merchant I have never seen" from "genuinely two departments" and offers the same generic card for both.

Recommend the one-line fix plus: carry `ambiguous` onto `VariableItem`, and for ambiguous merchants have the clarify card file the rows for THIS import without calling `saveMerchantRule` (or label it "this time only") — otherwise the fix trades a silent wrong number for a permanently repeating prompt.

---

## 18. [MEDIUM] Import plan does not reserve a bill installment within one run, so a second real payment on the same bill becomes an invisible row

**File:** `src/lib/importStatement.ts:196` · dimension: ledger-categorize

### Evidence
`bills.push({ date: r.date, monthKey, day, amount: Math.abs(r.amount), ... })` — the loop never adds `${rec.id}|${monthKey}|${day}` to the `paidBill` set it checked two lines earlier (line 192). `paidBill` is built once, before the loop, from `existing` only (lines 155-159). The Plaid function does the opposite and correctly reserves the slot: `paidBill.add(key);` after pushing (supabase/functions/plaid/index.ts, bill branch). Every row `commitImport` writes for a bill carries `settled: true` (src/components/ImportSheet.tsx:162), and `settled` rows are filtered out of every ledger surface — `visible` in buildVMs.ts:207 and `ledgerTxns` in FinanceTabs.tsx:163 both start with `.filter((tx) => !tx.appliesTo?.settled)`.

### Failure scenario
Two payments toward "Card payment (…4728)" post in July — $250 on the 3rd and $400 on the 20th — and both are on the same statement. `billCycleFor([15], "2026-07-03")` and `billCycleFor([15], "2026-07-20")` both return `{monthKey:"2026-07", day:15}` (Jul 15 + 7-day grace covers the 20th). `paidBill` is empty for that key at loop start and is never updated, so both rows push and both are committed as settled bill rows for installment 2026-07/15. `monthCalendar` consumes exactly one per installment (src/lib/schedule.ts:338-353) and leaves the other orphaned; because it is `settled` it appears in no ledger, no activity list and no budget. $400 of real money is invisible everywhere except `billExpected`, where BOTH rows enter the "last 3 actuals" rolling average (src/lib/plan.ts:160-174) and drag the projection for that variable bill down toward $325.

### Proposed fix
Reserve the slot as you consume it — add `paidBill.add(`${rec.id}|${monthKey}|${day}`);` immediately after the `bills.push(...)` on line 196, mirroring the feed. Then route the second same-cycle payment somewhere visible (an extra `variable` row flagged low-confidence, or a `duplicates`-style "second payment on this bill" list) rather than letting it disappear.

### SKEPTIC correction (authoritative)
The one-line `paidBill.add(...)` after importStatement.ts:196 is necessary but NOT sufficient, and on its own it is arguably worse-shaped: the second payment then falls into the `duplicates` branch at :192-195, which ImportSheet renders as "{n} already in here — no need to add" (ImportSheet.tsx:318-323) with the description struck through. That tells the user a real, distinct $400 payment is already recorded when in fact nothing is written for it. So the second half of the proposal (route it to a visible surface) is mandatory, not optional — the fix must add a distinct plan bucket, e.g. `extraPayments`, rendered as "second payment on this bill this cycle" and committed as a normal non-settled row or a bill row the calendar can show, rather than reusing `duplicates`.

Also correct the framing that "the Plaid function does the opposite and correctly reserves the slot". It reserves the key (supabase/functions/plaid/index.ts:406) but at :393 it `continue`s on a hit, so a genuine second same-cycle payment is never inserted there either — it avoids the phantom row but still loses the payment. Fixing importStatement alone leaves that gap on the primary ingest path.

Finally, the write-back key should mirror the feed's identity. importStatement keys on `${rec.id}|${monthKey}|${day}` while the feed keys on the installment ORDINAL (`installmentIndex`, plaid/index.ts:83-105, 289). The import path also never stamps `installmentIndex` on the applies_to it writes at ImportSheet.tsx:162, so those rows fall back to installmentIndexForDay on the feed side. Keeping the two key shapes in step is part of the real fix; otherwise a multi-due-day bill can still collide across the two ingest paths.

Separately, the deeper defect surfaced by the Mom run is in monthCalendar (schedule.ts:344-353): a stray payment claiming an already-consumed installment is silently assigned to the NEXT installment and marks it paid. Even with import fixed, any path that produces two payments on one installment (manual markBillPaid plus an import, for example) still triggers that false PAID, so that reduce needs a guard on claimDay distance rather than "nearest wins unconditionally".

---

## 19. [LOW] RENTERS_INSURANCE = 10.59 is hardcoded into planMath only — the repo contradicts itself about whether the recurring row exists, and it is wrong either way

**File:** `src/lib/plan.ts:87` · dimension: contradictions

### Evidence
plan.ts:85-87: "Renters insurance — a fixed cost found during the audit, **not yet in the live recurring table**, so it's folded into the plan's fixed total here." `export const RENTERS_INSURANCE = 10.59;` consumed at plan.ts:128 `const fixed = hh.bills + RENTERS_INSURANCE;`. Nothing else in src/ reads the constant — grep for `RENTERS_INSURANCE` returns only those two lines. Three other places assert the opposite, that a live row named "LEMONADE INSURANCE" DOES exist: schedule.ts:9 declares DUE_DAYS as "Day-of-month each recurring item posts, detected from Mar–Jun 2026 bank history (**keyed by the recurring row's NAME**)" and schedule.ts:19 lists `"LEMONADE INSURANCE": [18]`; categorize.ts:179 heads BILL_RULES with "A line that matches one of these IS a modeled recurring bill" and :188 maps `{ re: /LEMONADE/i, bill: "LEMONADE INSURANCE" }`; categorize.ts:208 repeats it in BILL_ALIASES. The seed file the categorizer comment points at contains no such name at all (household.ts:49-70 is a sanitized placeholder set). HANDOFF.md:12 documents this exact shape as a live bug that was fixed by deletion: "Deleted the learned `CLUB → bill \"Club\"` rule — it named a bill that doesn't exist, so it could only dead-end (that's why the Sam's Club membership never settled)."

### Failure scenario
Branch A — the plan.ts comment is right and no LEMONADE INSURANCE row exists. Then the $10.59 Lemonade charge hits BILL_RULES, `matchRecurringName` returns null, and importStatement.ts:181-184 files it as `appCategory: "other"` (the plaid path, functions/plaid/index.ts:378-386, sends it to needs_review). It lands on the Misc line and is graded against the $125 misc envelope, while planMath has ALREADY subtracted $10.59 as a fixed cost — the same dollar counted twice, and since real variable spend runs ~$1,730 against a $1,600 envelope (HANDOFF), the overspend path in buildVMs.ts:117 makes that second count bite firepower directly. Branch B — the comment is stale and the row exists. Then hh.bills already contains $10.59 and plan.ts:128 adds it again: `fixed` and `fixedNonDebt` are $10.59 too high, firepower $10.59 too low. In both branches the Forecast tab and the Bills tab (built on monthlySchedule) disagree with Insights' "Living" stat by $10.59/mo, because the constant exists in no other code path.

### Proposed fix
Resolve which branch is true against the live table (`select name, amount, cadence, due_days, active from recurring where name ilike '%lemonade%'`). If the row exists, delete RENTERS_INSURANCE and change plan.ts:128 to `const fixed = hh.bills;`. If it does not, create the recurring row (name "LEMONADE INSURANCE", $10.59, monthly, due_days [18], the name the categorizer already matches) and then delete the constant and the `+ RENTERS_INSURANCE` term — the row makes it appear in the calendar, forecast and firepower from one source, which is what every other bill does. Do not leave a fixed cost living only inside planMath; nothing else in the app can see it.

### SKEPTIC correction (authoritative)
The fix is half right; drop the two-branch framing and the Branch-A remedy.

1. Do NOT "create the recurring row." That branch is refuted, and acting on it would create a SECOND Lemonade row — the exact duplicate-spawn bug already cleaned up once (`LEMONADE INSURANCE ×3` → 4 junk rows deleted). That would make the double-count structural instead of arithmetic.

2. The correct and only change: delete `RENTERS_INSURANCE` (plan.ts:87), delete the stale comment at plan.ts:85-86, and make plan.ts:128 read `const fixed = hh.bills;`. `debtPaymentsInFixed`, `fixedNonDebt` and `firepower` all flow from that with no other edits, and nothing else imports the constant.

3. Confirm before deleting using the repo's own read-only tool, not ad-hoc SQL: `SUPABASE_PAT=<token> node scripts/snapshot.mjs` (`scripts/snapshot.mjs` — "READ-ONLY, every query is a select") and check the `recurring` dump for the Lemonade row's `amount`/`cadence`/`active`. The one thing the repo cannot prove is that the row is still `active:true` today (`matchRecurringName` at `categorize.ts:65-83` does not filter on `active`, so the "12 names resolve" verification would pass even for an inactive row). If the snapshot shows it inactive, the constant is currently load-bearing and the right fix is to reactivate/repair the row, then still delete the constant — never leave a fixed cost visible only to planMath.

4. Missing from the proposed fix: the sentence in plan.ts is not the only stale assertion. Once the constant is gone, nothing prevents the next "found during the audit" cost from being folded in the same way. Worth a line in `docs/HANDOFF.md` recording that fixed costs live in `recurring` only — that is the durable part of this finding, more than the $10.59.

---

## 20. [LOW] cron-notify's paid-check keys on the raw due day while both writers store the month-clamped day, so a paid bill re-pings in short months

**File:** `supabase/functions/cron-notify/index.ts:101` · dimension: edge-drift

### Evidence
cron-notify/index.ts:97-101 clamps for the date comparison but not for the paid lookup:
  for (const d of r.due_days) {
    const dd = Math.min(d, daysInMonth);
    const rel = dd === dom ? "today" : dd === dom + 1 ? "tomorrow" : null;
    if (!rel) continue;
    if (paidSet.has(`${r.id}|${monthKey}|${d}`)) continue;   // ← raw d, not dd

Both writers store the CLAMPED day:
- feed: supabase/functions/plaid/index.ts billAppliesTo() builds candidates with `const day = Math.min(dd, dim);` and returns `day: c.day`.
- app: src/views/redesign/FinanceTabs.tsx openBillPay sets `day: b.day` from a MonthCalBill, and src/lib/schedule.ts monthCalendar sets `const dueDay = clampDay(e.day);` → `day: dueDay`. That value goes to payBill/markBillPaid, which write `appliesTo: { kind: "bill", recurringId, monthKey, day }`.
- CSV import: src/lib/importStatement.ts:191 uses billCycleFor, which also clamps (`const day = Math.min(dd, dim);`).

cron's key builder reads that stored value: `paidKey` = `${at.recurringId}|${at.monthKey}|${at.day}`.

### Failure scenario
February 2027 (28 days), Mom row, due_days [15,30]. The 30th clamps to the 28th everywhere: the app shows the installment on Feb 28 and, when paid, writes applies_to = {recurringId: 7a0743fa…, monthKey: "2027-02", day: 28}. On Feb 28 cron computes dd = min(30,28) = 28 == dom → rel "today", then looks up `7a0743fa…|2027-02|30`, which no row carries → miss → the phones get "📅 Bill today — Mom" for an installment already recorded paid. Same class of miss for any due day above the month length (a day-31 bill in April, June, September or November).

### Proposed fix
Use the clamped day in the lookup on line 101: `if (paidSet.has(`${r.id}|${monthKey}|${dd}`)) continue;`

### SKEPTIC correction (authoritative)
The proposed one-line fix is correct for the reported defect - use dd, not d, at line 101 - and my simulation shows it silences both the Feb 27 and Feb 28 pings while leaving the 31-day-month behavior unchanged. Two caveats worth folding in rather than shipping the line alone: (1) In a month where two due days collapse onto the same clamped day (e.g. due_days [30,31] in February, both -> 28), the clamped key makes one paid installment satisfy both loop iterations and suppress the second reminder. No current household row has that shape, but if it is a concern, key on the installment ordinal the way plaid/index.ts:113 installmentIndexForDay already does instead of on the day. (2) The deeper asymmetry survives the fix: cron does exact key equality on the day while the app (buildVMs.ts:305-310) snaps a recorded day to the nearest scheduled installment. Any writer that stores a non-due day still slips past cron in every month - e.g. makeRecurringBill (FinanceStore.tsx:934, 965) stores day = the transaction's post day, which need not equal any due day. Matching cron's paid check to the app's nearest-installment snap would close the whole class; the dd fix only closes the short-month instance.

---

## 21. [LOW] The Notifications toggle reports the browser's opinion, never the DB row — the one screen built to catch the 44-night failure cannot see it

**File:** `src/views/redesign/ProfileTab.tsx:99` · dimension: pwa-push

### Evidence
ProfileTab.tsx:96-103 — "Repair first, then report", but the repair reports nothing:
```
    syncPushSubscription()
      .catch(() => {})
      .then(getPushStatus)
      .then(setStatus);
```
syncPushSubscription is `Promise<void>` and cannot reject — it swallows everything into console (src/lib/push.ts:155 `if (error) console.error("push resync", error);` and :156-158 `catch (e) { console.error(...) }`), so the `.catch` is dead code.
getPushStatus (src/lib/push.ts:37-50) only calls `reg.pushManager.getSubscription()`. No code path anywhere in the repo ever SELECTs from push_subscriptions on the client to confirm the row exists.

### Failure scenario
The phone is offline (or the Supabase session has expired) when the user opens Profile because notifications stopped. syncPushSubscription()'s upsert errors → console only. getPushStatus() sees the browser subscription and returns "subscribed" → the row renders "On — transaction & health alerts on this phone" (ProfileTab.tsx:124) with zero rows in push_subscriptions. The user is told the device is registered when it is not, which is the same undiagnosable state that ran for 44 nights.

### Proposed fix
Make the repair report its outcome: change syncPushSubscription to `Promise<boolean>` — use `.upsert({...}, {onConflict:"endpoint"}).select("endpoint").maybeSingle()` and return `!error && !!data`. In PushRow, hold that result and render a third state when the browser says subscribed but the row write did not land (e.g. "Not registered on the server — tap to fix") wired to enablePush(), instead of "On".

### SKEPTIC correction (authoritative)
The proposed fix inverts the bug. Making syncPushSubscription return `!error && !!data` collapses five distinct outcomes into `false`: write confirmed-failed, server unreachable, unsupported, permission not granted, and opted-out — the early returns at push.ts:127-128 must become `false` to satisfy a Promise<boolean> signature. Rendering "Not registered on the server — tap to fix" whenever that is false fires the alarm every time a CORRECTLY registered phone is simply offline (row intact, upsert just could not reach the server), which tells a registered user they are unregistered — the exact inverse of the defect. Wiring that state to enablePush() also cannot help: enablePush runs the same upsert against the same unreachable server (push.ts:92) and returns "default" on error, so the tap would silently flip the row to "Off — tap to get alerts".

Correct shape: distinguish CONFIRMED-MISSING from UNKNOWN, and get the confirmation from the thing nothing in the repo reads — the row itself. After the upsert in syncPushSubscription, do `supabase.from("push_subscriptions").select("endpoint").eq("endpoint", sub.endpoint).maybeSingle()`; RLS policy push_subs_auth_all (supabase/schema_v21_push_subscriptions.sql:21, `for all to authenticated using (true) with check (true)`) permits that SELECT. Return a three-valued result — "confirmed" | "missing" | "unknown" — with the early returns at push.ts:127-128 mapping to "unknown", never "missing". In PushRow render: confirmed -> "On"; unknown -> "On · couldn't verify with the server" (never accuse); missing -> the "Not registered — tap to fix" state, and only that state gets the enablePush() wiring, since it is the only one where a retry can accomplish anything.

Two smaller corrections: keep the .catch at ProfileTab.tsx:100 rather than deleting it as dead (push.ts:128's localStorage read sits outside the try and can throw), and guard setStatus at ProfileTab.tsx:102 against unmount. Also note App.tsx:105 already performs this repair at every launch, so only the DISPLAY needs changing — do not add a second repair path.


---

# Round 2 — money math + store/sync (the two dimensions whose agents died)

Numbering continues from the first round. Same rule: `SKEPTIC` corrections are authoritative.

---

## 22. [HIGH] Payoff projection debits a PAY-CYCLE overspend against a MONTHLY pace, so an over-budget month never dents the debt-free date

**File:** `src/views/redesign/buildVMs.ts:370` · dimension: aggregation

### Evidence
const monthDent = Math.max(0, spent - projVariable);
const schedule = payoffSchedule(ordered, projFirepower, now, PAY_DAYS, SAVINGS_SPLIT, monthDent);

// `spent` is per-CYCLE (line 106):  variableSpentBetween(data.transactions, cycle.start, cycle.end)
// `projVariable` is MONTHLY (line 131): avgVariableSpend(..., 3, monthlyTarget)
// `spentMonth` (the month-to-date counterpart) exists at line 103 and is unused here.
// buildVMs.ts:118 states the rule this line breaks: "mixing a per-cycle overspend into it
// would compare half a period against a whole one."

### Failure scenario
Today = Aug 18. projVariable = $1,600/mo. Month-to-date variable spend = $2,300 (a blown month), but the current cycle (Aug 15–30) has only $400 so far. monthDent = max(0, 400 − 1600) = 0, so payoffSchedule receives oneTimeReduction = 0 and projects as if the household is exactly on pace — the $700 already overspent is never debited from any payday. debtFreeBy and the whole attack ladder read optimistically. Worse, the Home hero tile on the same screen DOES subtract it (firepower = math.firepower − overspendMonth, line 125, overspendMonth = $700), so the two numbers describe the same month and disagree. Because a cycle is ~15 days and projVariable is a 30-day figure, monthDent is 0 for essentially every input — the one-time-dent feature is dead.

### Proposed fix
Use the monthly figure already computed: const monthDent = Math.max(0, spentMonth - projVariable);

### SKEPTIC correction (authoritative)
`const monthDent = Math.max(0, spentMonth - projVariable);` is correct — `spentMonth` (line 105) is the month-to-date counterpart and matches the documented intent ("This month's spend above that pace dents the next payday once"). One caveat the claim overstates: this will still not equal the hero tile's `overspendMonth` (line 117), which is measured against `monthlyTarget`, not `projVariable` — that difference is deliberate, so do not "fix" them into agreement.

---

## 23. [HIGH] setAccountBalance silently keeps an unpersisted bank balance — the anchor every other number is derived from

**File:** `src/store/FinanceStore.tsx:989` · dimension: store-writes

### Evidence
async setAccountBalance(accountId, balance) {
  setData((p) => ({ ...p, accounts: p.accounts.map((a) => a.id === accountId ? { ...a, balance } : a) }));
  const { error } = await supabase.from("accounts").update({ balance }).eq("id", accountId);
  if (error) console.error(error);   // line 1000 — no rollback, no resyncLedger()
}

// caller, src/views/sheets.tsx:98 — closes the editor unconditionally
await setAccountBalance(a.id, Math.round(parseFloat(val)*100)/100);
setEdit(null);
// same sheet's own copy: "Set each account to the real balance from your bank — every event moves it from there."

### Failure scenario
Gino opens Cash & accounts, taps the checking account showing a stale $1,240.00, types the real bank figure $412.83, hits Set. The UPDATE fails (RLS denial, expired JWT, offline/flaky mobile connection — supabase-js resolves with `error` rather than throwing, so nothing surfaces). Local state now says $412.83; the editor closes; safe-to-spend, per-pay-cycle variable budget and the bills runway all recompute off $412.83 and look healthy. No DB row changed, so the realtime channel emits no event and loadAccounts() never re-runs — the wrong value persists for the whole session. Next app open, the account is back to $1,240.00 and every derived number moves by $827.17. The inverse is worse: reconciling DOWN to the true balance appears to work, the user spends against it, and the app silently reverts to the higher stale number. addTransaction at line 702 handles this exact failure correctly (`await resyncLedger()`); setAccountBalance — the one write that sets bank truth — does not.

### Proposed fix
Mirror addTransaction: on error, `await resyncLedger()` (or refetch accounts) so the UI drops back to server truth, and surface a toast/thrown error so the sheet does not close on a failed save.

### SKEPTIC correction (authoritative)
The proposed fix (resyncLedger + surface the error, don't close the sheet) is right but incomplete. Checking `error` alone is insufficient: a PostgREST UPDATE whose row is filtered out by RLS matches zero rows and returns `{ error: null }`, so the same silent divergence occurs with no error to test. Use `.update({ balance }).eq("id", accountId).select()` and treat `error || !data?.length` as failure, then `await resyncLedger()` and propagate a failure signal so sheets.tsx:98 keeps `edit` open instead of calling `setEdit(null)`.

---

## 24. [HIGH] addTransaction does a client-side read-modify-write of the account balance; concurrent writes silently lose money

**File:** `src/store/FinanceStore.tsx:704` · dimension: store-races

### Evidence
const acct = dataRef.current.accounts.find((a) => a.id === t.accountId);
if (acct) {
  const nb = acct.balance + (t.type === "income" ? t.amount : -t.amount);
  ...
  await supabase.from("accounts").update({ balance: nb }).eq("id", t.accountId);

// contrast, applyMoneyEvent (line 514): supabase.rpc("apply_money_event", ...)
// "The RPC inserted the ledger row AND moved cash/debt/goal in ONE transaction"

### Failure scenario
Chase checking balance = 1000. Gino's phone adds an expense of 50: reads 1000, writes balance=950. Within the same second (before realtime delivers the accounts UPDATE), Xinyan's phone adds an expense of 30: its dataRef still holds 1000, so it writes balance=970. Both transaction rows persist, but the DB balance ends at 970 instead of 920 — the 50 charge is erased from cash forever. Nothing self-corrects: the value is absolute, not a delta, and the next realtime refetch just re-reads 970. Same loss occurs single-device when the Plaid edge function (syncNow, App.tsx:98) SETs the balance from bank truth between the read and this update. Every other money path deliberately goes through the atomic apply_money_event RPC; only addTransaction bypasses it.

### Proposed fix
Route addTransaction through the apply_money_event RPC (or a new RPC) so the ledger insert and the balance move are one server-side transaction using a relative delta (balance = balance + x), never an absolute value computed from a client snapshot.

### SKEPTIC correction (authoritative)
Route addTransaction through apply_money_event (FinanceStore.tsx:514 pattern) with p_debt_id/p_goal_id null — the RPC already does the insert plus `balance = balance + delta` in one transaction, so no new RPC is needed. Note the RPC returns the ledger row, so the optimistic setData stays as-is; drop the separate `.from("accounts").update({balance: nb})` entirely. One caveat the claim doesn't mention: for a Plaid-LINKED account, a manual entry moving the balance will double-count once the same charge posts from the feed — that's pre-existing behavior, not introduced by the fix, but worth deciding on while touching this path.

---

## 25. [HIGH] Ledger rows are stamped with the UTC date while every budget window is Arizona-local, so evening entries land in the wrong month/cycle

**File:** `src/lib/format.ts:15` · dimension: dates

### Evidence
format.ts:15  `return new Date().toISOString().slice(0, 10);`  (same pattern at FinanceStore.tsx:479 applyMoneyEvent and :575 markBillPaid)
plan.ts:238  `const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1)...` — payCycleFor emits LOCAL dates
buildVMs.ts:42 `monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`` — LOCAL month
AddTransactionSheet.tsx:25 `const [date, setDate] = useState(todayISO());` → written straight to the row (line 60).

### Failure scenario
Ran under TZ=America/Phoenix (UTC-7, no DST). Gino logs a $120 grocery run at 19:00 on Fri Jul 31 2026. todayISO() returns "2026-08-01" (UTC has already rolled over); monthKeyOf(now) returns "2026-07". Measured: variableSpentThisMonth(tx,"2026-07") = 0 instead of 120 — July's graded spend is $120 low, overspendMonth is $120 low, and firepower (buildVMs.ts:117) is $120 too high, which feeds payoffSchedule and the debt-free date. The mirror case: a $120 charge at 17:00 on Thu Aug 14 2026 (last day of the Jul 31–Aug 14 cycle) is stamped "2026-08-15"; variableSpentBetween(cycle.start, cycle.end) = 0 instead of 120, so the cycle budget bar under-reports on the final evening of every cycle. Any entry between 17:00 and midnight AZ is affected.

### Proposed fix
Make todayISO() (and the two `new Date().toISOString().slice(0,10)` sites in FinanceStore.tsx) produce the LOCAL calendar date, matching plan.ts's `iso()` helper: `const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}``. Export plan.ts's `iso` and reuse it so there is one date-stamping function.

### SKEPTIC correction (authoritative)
Proposed fix is correct. Export plan.ts's existing local `iso()` helper (plan.ts:238) and have todayISO() (format.ts:15) plus the two `new Date().toISOString().slice(0,10)` sites in FinanceStore.tsx (:479 applyMoneyEvent, :575 markBillPaid) call it, so one function stamps every calendar date. Two additions: (1) also fix currentMonthKey() (format.ts:18-20), which has the identical UTC bug — it currently has zero callers, so it is a latent trap rather than a live defect, but leaving it half-fixed invites the same bug back; (2) src/lib/mealLog.ts:127 already does the local-date conversion correctly (`new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10)`) — collapse that to the shared helper too rather than leaving three spellings of "local ISO date" in the repo.

---

## 26. [HIGH] HealthStore write retries scheduled after unmount are never cancelled and overwrite newer data with a frozen snapshot

**File:** `src/store/HealthStore.tsx:268` · dimension: store-races

### Evidence
if (attempt < 6) scheduleWrite(key, () => Promise.resolve(retry(attempt + 1)), Math.min(30000, 1000 * 2 ** attempt));

// cleanup (line 223) runs once and only clears timers that already exist:
for (const id of timersMap.values()) clearTimeout(id);
timersMap.clear();
for (const fn of flushFns) { try { fn(); } catch {} }

### Failure scenario
HealthProvider is mounted inside HealthView (src/views/HealthView.tsx:46), which App.tsx unmounts on every Finance/Health mode toggle. Gino edits meal day gino|2026-08-18 to {breakfast}, then taps the mode toggle while the 700ms debounce is pending. Cleanup flushes the write; it fails (subway, offline). onWriteResult then calls scheduleWrite, arming a fresh setTimeout on the now-orphaned timers ref — cleanup has already run and will never run again, so this retry chain (up to 6 attempts, ~60s) survives the unmount. Gino toggles back 5s later: a NEW provider mounts with fresh refs, loads server state, and he adds lunch, which writes successfully. At t=8s the orphaned retry fires writeDay, reads the OLD provider's frozen dataRef.current, and upserts {breakfast} over the row — destroying lunch. The new provider's dirty Set is a different object, so its guard cannot block this, and the resulting realtime event pulls the truncated day back into the UI.

### Proposed fix
Give the effect a `let alive = true` (set false in cleanup) captured by scheduleWrite/onWriteResult and bail out of scheduling or performing any retry when it is false; or clear the timers map again after the flush loop, since the flush itself can arm new timers.

### SKEPTIC correction (authoritative)
Use the `alive` flag (set false in cleanup, checked in scheduleWrite AND at the top of writeDay/writeWorkout). The report's alternative — "clear the timers map again after the flush loop" — does NOT work: the flushed write fails asynchronously after cleanup has already returned, so the second clear runs before the retry timer is ever armed. Also apply the guard to writeWorkout (line 285), which has the same defect.

---

## 27. [MEDIUM] Envelope drill-in lists pending charges that the envelope's own spent figure excludes, so the rows never sum to the bar

**File:** `src/views/redesign/buildVMs.ts:163` · dimension: aggregation

### Evidence
for (const t of data.transactions) {
  if (t.type !== "expense" || t.date < cycle.start || t.date > cycle.end || t.appliesTo) continue;
  ...
  raw.push({ id: t.id, name: ..., date: t.date, amount: amt });
}
return { ..., spent: lineSpent(l, byCat), target: perCycle(l.target), txns: raw.map(...) };

// but the source of `byCat` — plan.ts:458-464 spentByCategoryBetween — also requires !t.pending:
//   t.type === "expense" && t.date >= startISO && t.date <= endISO && !t.appliesTo && !t.pending
// and buildVMs.ts:167 claims "the same partition spentByCategoryBetween uses, so
// the rows always sum to the bar."

### Failure scenario
A $180 Costco charge posts pending on Aug 16, categoryId "groceries", inside the Aug 15–30 cycle. byCat skips it (pending), so envelope.spent = $120 and CategorySheet's header renders "$120 / $300". The txns array does NOT skip it, so the list below the header shows the $180 pending row plus the $120 of posted rows = $300 of visible line items under a bar that says $120. Every other pending gate in this file (sinceMonday line 232, monthFree line 254) filters !t.pending; this one does not. When the charge posts, the sheet total jumps $180 with no new row appearing.

### Proposed fix
Add `|| t.pending` to the continue condition at line 163 so the row list uses the same predicate as spentByCategoryBetween.

### SKEPTIC correction (authoritative)
Fix as proposed — add `|| t.pending` to the `continue` at buildVMs.ts:163 so the row list uses the same predicate as spentByCategoryBetween. Better alternative: keep the pending row but tag it (`pending: true` on the txn VM) and render it greyed with a "Processing" badge and excluded from the implied sum, matching the badge treatment already used at buildVMs.ts:552.

---

## 28. [MEDIUM] Month 0 is the current month counted whole, so income already received and bills already paid are projected as still to come

**File:** `src/lib/forecast.ts:70` · dimension: forecast

### Evidence
for (let i = 0; i < count; i++) {
  const monthKey = addMonths(startMonth, i);

// ForecastTab.tsx:77 — startMonth is TODAY's month
const startMonth = useMemo(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }, []);
// ForecastTab.tsx:148 — header over the list
"Next 12 months · tap a month for its bills"

### Failure scenario
On 2026-08-18 the first row of the list headed "Next 12 months" is Aug 26 at full value: income $5,974.84 (both biweekly rows, due days 15 and 29 — the 15th's $2,987.42 already landed) and bills including Rent $1,715 (due the 1st, paid), Spot Pet $99.93 (4th, paid), Spotify $14.04 (10th), Electric $85 (13th) and both card payments (8th and 15th). Nothing in forecast() consults `transactions` for what has already posted — they are passed only so billExpected() can average past actuals. The user reads "Aug · in $5,975 · out $5,546 · +$429" as money still arriving when ~$3,000 of that income and ~$3,900 of those bills are history, and the run covers only 11 future months. summarize() then folds this stale month into best/worst/total (forecast.ts:150-152). It also charges the card a full extra payment plus a full month of interest in month 0, on a balance (debts.balance is bank-truth) that already reflects this month's posted payment — biasing the payoff month.

### Proposed fix
Either start the projection at addMonths(startMonth, 1) and label the list honestly, or make month 0 partial: skip entries whose due day is before today, and skip income days already past, when i === 0.

### SKEPTIC correction (authoritative)
Do not adopt the proposed fixes as written. Starting at addMonths(startMonth,1) breaks `const next = months[1]` in ForecastTab.tsx:88 (it would silently become month+2) and discards the current-month view. A naive "skip due day < today" filter is also wrong here, because bills are routinely paid early or late — schedule.ts explicitly rejects the "day <= today" heuristic. Correct approach: when i === 0, reuse the existing paid-matching (transactions with appliesTo.kind === "bill" and appliesTo.monthKey === monthKey) to drop installments already settled, drop income days strictly before today, and skip the month-0 card payment plus its interest accrual when a payment for this month has already posted. Separately, exclude month 0 from summarize()'s steady/best/worst/total, or mark it, and relabel the "Next 12 months" header to reflect that the first row is the current month.

---

## 29. [MEDIUM] Refetches have no request sequencing — an older SELECT response can land last and overwrite newer state permanently

**File:** `src/store/FinanceStore.tsx:283` · dimension: store-races

### Evidence
async function loadTransactions() {
  const { data: rows } = await supabase.from("transactions").select("*")...;
  if (active) {
    setData((p) => ({ ...p, transactions: (rows ?? []).map(mapTxn) }));
  }
}
// realtime: .on("postgres_changes", {table: "transactions"}, () => loadTransactions())

### Failure scenario
`active` only guards unmount, never staleness, and every loader unconditionally replaces the whole array. A Plaid sync inserts 20 rows, firing 20 realtime events within milliseconds; 20 overlapping full-table SELECTs are issued. On a phone these resolve out of issue order, so a response captured before the last inserts can resolve last and setData a snapshot missing several transactions. No further event ever arrives, so the Home/Activity totals under-report spending until the app is force-reloaded. Same shape reverts an optimistic edit: user taps a new category on txn T (setTransactionCategory, line 780) while a batch refetch is in flight; the stale response resolving after the UPDATE restores the old category and it sticks. Every loader in both stores (loadDebts, loadAccounts, HealthStore reloadWorkouts/reloadMealDays, etc.) shares the defect.

### Proposed fix
Add a per-table monotonic request id: capture `const my = ++seq.current` before each SELECT and apply setData only when `my === seq.current`. Also coalesce/debounce the burst of realtime events into one refetch.

### SKEPTIC correction (authoritative)
Per-table monotonic request id is right but insufficient. (1) Capture `const my = ++seq.current[table]` before each SELECT and apply setData only if `my === seq.current[table]`. (2) Coalesce the burst: trailing-edge debounce (~250ms) per table so one bulk insert costs one refetch. (3) resyncLedger (FinanceStore.tsx:~446) issues its own four SELECTs outside the effect and must share the same counters, otherwise it stays a third racer. (4) Optimistic writers (importStatement:613, setTransactionCategory:779) should bump the counter at write time so any SELECT issued before the write is discarded rather than reverting the optimistic value.

---

## 30. [MEDIUM] The meal-day dirty guard blocks the merge instead of merging, so a whole-document write destroys the other phone's edits to the same day

**File:** `src/store/HealthStore.tsx:110` · dimension: store-races

### Evidence
// header claim (line 12): "Solo and Together read/write the SAME in-memory state ...
// which is the fix for the multi-mode / multi-device last-writer-wins risk."
for (const r of rows ?? []) {
  if (!dirty.current.has(mdDirty(r.person, r.date))) next[dayKey(r.person, r.date)] = mapDay(r);
}
// setDay (line 309) then writes the ENTIRE document:
// upsert({ person, date, meals: day.meals, ... }, { onConflict: "person,date" })

### Failure scenario
Both phones are on gino / 2026-08-18. Xinyan's phone logs breakfast at 18:00:00; her debounced write commits at 18:00:01 and the row becomes {breakfast}. Gino's phone starts composing lunch at 18:00:00.5 — every item tap calls setDay, which re-adds the dirty key and resets the 700ms debounce, so his key stays dirty for the full 30s he is editing. The realtime event for Xinyan's write arrives at 18:00:01 and reloadMealDays SKIPS the key because it is dirty, so breakfast never enters his state. At 18:00:30 his debounce fires and upserts his whole document, {lunch}, over the row. Breakfast is permanently gone from the DB and disappears from Xinyan's screen on the next refetch. The dirty flag protects the writer but silently discards the reader's merge, which is the exact loss the header comment claims is fixed. upsertWorkout (line 312) has the same whole-session shape.

### Proposed fix
Merge instead of skip: when a remote row arrives for a dirty key, reconcile at the item level (union of meals by id, last-write-wins per item) rather than dropping the remote row, or move meals to a row-per-meal table so two devices never write the same document.

### SKEPTIC correction (authoritative)
Item-level reconcile is right, but fix the mechanism, not just the read path: before upserting, writeDay should re-read the remote row and union meals by id (last-write-wins per meal id) rather than blind-upserting local state, and reloadMealDays should merge remote meals into the dirty key instead of skipping it. Also cover the retry path — during the 1/2/4/8/16/30s backoff the key stays dirty for ~61s and every retry re-writes the same stale document, so the merge must happen inside each retry attempt, not once at edit time. Same shape applies to writeWorkout (whole-session upsert, line 312).

---

## 31. [MEDIUM] Realtime channel is subscribed after the initial SELECTs and its status is never checked, so missed and dropped events are never recovered

**File:** `src/store/FinanceStore.tsx:438` · dimension: store-races

### Evidence
Promise.all([loadTransactions(), loadDebts(), ... ]).finally(...)   // line 383
const channel = supabase.channel("homebase-sync")
  .on("postgres_changes", { table: "transactions" }, () => loadTransactions())
  ...
  .subscribe();                                                     // line 438 — no status callback

// no refetch on SUBSCRIBED, no CHANNEL_ERROR/TIMED_OUT handling,
// and no visibilitychange/focus refetch anywhere in src/ (only UpdatePrompt.tsx)

### Failure scenario
Two gaps, both unrecoverable without a full page reload. (1) Join window: Gino cold-opens the app at 08:00:00.0; his SELECTs resolve at 08:00:00.15 but the websocket JOIN completes at 08:00:00.40. Xinyan's phone inserts a $400 expense at 08:00:00.25 — it is in neither the snapshot nor the event stream, so Gino's dashboard shows $400 more available cash than reality for the whole session. (2) Dropped channel: this is an installed PWA on two phones, so backgrounding and network flaps routinely kill the socket, and an expired JWT yields CHANNEL_ERROR — delivered only to the absent subscribe callback. The store then runs the rest of the session with no realtime and no idea it is offline; the other phone's bill payments and balance changes never arrive, and neither person can tell the numbers are stale. HealthStore.tsx:219 has the identical pattern.

### Proposed fix
Move the initial fetch into the subscribe status callback: `.subscribe((status) => { if (status === 'SUBSCRIBED') refetchAll(); })`, so joining (and every rejoin) re-anchors state and closes the window. Handle CHANNEL_ERROR/TIMED_OUT/CLOSED by resubscribing and surfacing a stale-data indicator, and add a visibilitychange refetch as a backstop.

### SKEPTIC correction (authoritative)
Keep the core fix — pass a status callback and refetch on every SUBSCRIBED so each join/rejoin re-anchors state: `.subscribe((status) => { if (status === 'SUBSCRIBED') refetchAll(); })` — and add a `visibilitychange` refetch in FinanceStore/HealthStore as the backstop (UpdatePrompt's listener only checks the service worker). Drop the manual resubscribe-on-CHANNEL_ERROR/TIMED_OUT: realtime-js already reconnects with backoff and re-auths via `beforeReconnect`, so hand-rolling it risks duplicate channels. Logging those statuses for a stale indicator is fine.

---

## 32. [LOW] dueBeforeNextPayday starts its window at today, so an unpaid bill already past its due day inside the cycle silently drops out

**File:** `src/lib/schedule.ts:426` · dimension: dates

### Evidence
schedule.ts:426  `if (on < todayISO || on > cycleEndISO) continue;`
This re-introduces the exact "day ≤ today means settled" heuristic that monthCalendar's own header (schedule.ts:288-291) rejects: "Paid-status is month-scoped ... never the 'day ≤ today' heuristic". The Plaid lag is explicitly designed to leave a bill sitting on its due day as expected until the payment lands.

### Failure scenario
Verified by running monthCalendar + dueBeforeNextPayday: now = Aug 5 2026, rent $1,715 with dueDays [1], no matching payment in the ledger yet (Plaid post-lag — monthCalendar correctly reports it `paid:false, day:1, amt:1715`). payCycleFor gives the cycle 2026-07-31 → 2026-08-14. dueBeforeNextPayday([aug],"2026-08-05","2026-08-14") returns `{bills: [], total: 0}`. Passing the cycle start instead returns 1715. So the BillsSheet tile tells Gino $0 of the check that landed Jul 31 is still spoken for, when $1,715 of unpaid rent is — a decision-grade understatement of available cash.

### Proposed fix
Lower-bound the window at the cycle START, not today: pass `cycle.start` from BillsSheet.tsx:142 and rename the parameter (`cycleStartISO`). Unpaid bills earlier in the cycle are exactly the ones the 'expected until the payment lands' model exists to keep visible.

### SKEPTIC correction (authoritative)
Passing cycle.start from BillsSheet.tsx:142 (renaming the param cycleStartISO) fixes the reproduced case, but note it is incomplete: an unpaid bill due BEFORE the cycle start still drops out (e.g. an Aug-1 bill still unpaid on Aug 20, when the cycle is Aug 15-31). If the intent is truly "how much of the money on hand is spoken for", the window needs no lower bound at all for unpaid bills within the current month, only the cycleEnd upper bound; if the intent is the forward-looking "what's still coming", the current behavior is correct and only the copy needs to say so.

---

# Residuals — accepted, NOT fixed (2026-08-18)

Recorded so they are not mistaken for closed. Each was raised by a reviewer after
the fix landed and judged not worth blocking the fix it rides on.

## R1. Plaid sync absorbs duplicate rows with no in-app trace
The armed content-dedup guard prevents a re-link from duplicating the ledger
($3,168.61 of phantom spend on the real backup). But absorbed rows are DROPPED,
where the authoritative skeptic prescribed inserting them with `needs_review =
true`. On the real ledger that is **$354.46 across 18 rows per steady-state pass**
with no trace in the app: `absorbed` is returned in the sync result but both
callers discard the response (`App.tsx:98`, `FinanceTabs.tsx:189`), and
`last_error` is written by the function and read nowhere in `src/`.
**Follow-up:** insert absorbed rows flagged `needs_review`, or surface the count.

## R2. Tracked debts can now read TOO HIGH
Absorbed rows never reach `upsertPosted`, and the feed row is the one carrying
`applies_to = {kind:"debt"}`. If a hand-entered row twins a feed debt payment
(Affirm, Mom-China via Remitly), `balance = tracked_baseline − sum(payments)`
misses it. This is the conservative mirror of the bug it replaced. Bills are
unaffected — a hand-entered bill payment carries `applies_to`, so the `paidBill`
guard already blocked the twin. Unmeasured: the backup predates the v14 columns.

## R3. `existingKeys` is a Set, so identical repeated charges collapse
N pre-existing identical rows share one key, so a re-link with genuinely repeated
identical charges leaks duplicates. Measured: 24 of 121 keys carry >1 row, but
**0 of 57 feed keys** are duplicated, so today's re-link leaks nothing. A
`Map<key, count>` is strictly better. The skeptic prescribed the Set.

## R4. Paged scan has no ORDER BY
LIMIT/OFFSET without ORDER BY has no stable order, so a page boundary can skip a
row. Safe direction — a missing key means a *visible* duplicate, never a silent
drop. Also `if ((prior?.length ?? 0) < PAGE) break;` truncates silently if the
project's `db-max-rows` is ever lowered below 1000.

## R5. `uq_txn_provider` is not scoped to status
An incoming pending id that already exists as a posted row raises 23505 and kills
the batch; `ops.pendingUpsert` is not deduped by id either. Both were equally
dead before (42P10 on every sync), so no regression. A one-line dedupe of
`pendingRows` by `provider_txn_id` would harden it.

## R6. Import's ambiguous clarify card was removed, not scoped
The skeptic asked for the card minus `saveMerchantRule`; the card was dropped
entirely (an `ImportSheet.tsx` file-set limit). Measured on 88 real descriptors,
**21 rows flip high→low+ambiguous**. They still import at the same pre-filled
category, so no money moves — the user just loses the prompt.

## R7. The build does not typecheck the edge functions
`tsconfig.app.json` has `"include": ["src"]`, so nothing under
`supabase/functions/` is checked by `npm run build`. Only the CI deploy's bundle
step catches errors there — after a push.
