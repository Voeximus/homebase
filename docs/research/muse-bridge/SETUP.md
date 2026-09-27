# Turning the door on — the steps, in order

For Gino. Everything here is done once. Nothing here writes to the database or
changes the app. Commands are PowerShell, from the repo folder.

The project is `ganzefaciiyibselizqi`, so the two doors' addresses are:

```
https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-read
https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-write
```

Both halves are written and tested now. Nothing below has been run, and neither
door is deployed.

The read door answers **fourteen** questions and the write door has **ten** tools.
Three of the ten are the memory store — the table where the assistant keeps what it
learns about how you work, in your own database rather than in Meta's. There is a
section on it below, and it is the part that decides whether any of this survives you
leaving Muse.

---

## In what order do I do this

**Start here.** There are six documents in this folder and this is the front door
to all of them. Read this section, then do the steps in this file. The other five
are what you reach for at a particular moment, and this says which moment.

| Do this | In this document | Roughly |
|---|---|---|
| **1. Decide whether to go ahead at all.** Ask Xinyan, money and health separately, and get the answer in writing. Turn Muse's training setting off. Check that a connector you build in Muse is still there tomorrow. | **Before you start**, below | An evening, mostly waiting on her |
| **2. Turn the doors on.** Make the two keys, put them on the project, deploy, schedule the two 15-minute jobs — the reminders one, and the bank pull that keeps every number current once nobody is opening the app. | **Steps 1–4b** of this file | About an hour |
| **3. Teach Muse.** Hand it the key, then paste PASTE 1. | **Step 5** here, then `MUSE-SKILL.md` | 20 minutes |
| **4. Prove it works.** Nine checks, on your phone. Checks 1–6 are the read door, 7–9 are the write door and the reminder. | **Step 6** of this file | Spread over a day, because check 3 needs both sides of midnight |
| **5. Tell Muse about you.** Paste PASTE 2 — the schedule, the money floor, the meal plan. | `MUSE-SKILL.md`, at the bottom | 5 minutes |
| **6. Set up the day.** The alarms, the calendar events, the scheduled checks. Five items first, not thirty. | `ROUTINES.md` §10, then the rest of it | An evening |
| **7. Only then think about removing screens.** | `RETIRE.md`, Stage 0 first | Months |

The other two documents are not steps:

- **`API.md`** is written for the assistant, not for you. It is the rules and every
  question the read door answers, in plain sentences. You paste it, or point Muse at
  it, if Muse cannot fetch the door's own description before it holds a key.
  `MUSE-SKILL.md` PASTE 1 is the shorter version of the same thing and is what you
  normally use.
- **`PLAN.md`** is why the doors are built the way they are — the research, the
  rejected options, the risks. Read it when you want to argue with a decision, not
  when you want to get something working.

**Two things that are true today and worth knowing before you start**, because both
appear further down and neither is a fault:

- **Four of the seven write tools cannot be applied yet.** They write the request
  down and stop. Step 6's note and `RETIRE.md` Stage 2 cover it.
- **Three of the reads he asks for most are not built** — the low point of the
  balance, what is due before the next paycheck, and how much is free each month to
  aim at the debt. `RETIRE.md` Stage 1 is where they get built.

---

## Before you start

Five things have to be true already. None of them are code you write now.

1. **Xinyan has been asked and answered** — about money and about health
   separately. The shared bills and the shared ledger carry her paycheques and her
   spending, so the first finance question you ask sends her data too.
2. **Muse's training setting is off.** It is on when you first use Muse. Meta
   strips names and phone numbers from what it trains on; it does not say it
   strips balances, amounts or bill names.
3. **A connector you build in Muse stays built.** Test it once against anything
   before you wire this up — build a connector, close the app, and the next day in
   a brand-new conversation ask again. If it makes you rebuild it every time, stop
   here; rebuilding setup is the thing this was supposed to remove.
4. **The database tables exist.** `schema_v36_muse_bridge.sql` has been run in the
   Supabase SQL editor. The door writes a log row for every call, so without that
   table every call fails.

   **And then `schema_v37_reminder_edits.sql`, in that order.** It adds one column,
   `reminders.canceled_at`, and it is not optional — three things break without it,
   and only one of them is loud:

   - `schedule.cancel_reminder` and `schedule.update_reminder` fail outright, which
     you will notice;
   - `schedule.remind` fails too, because counting how many reminders are waiting now
     asks about that column;
   - **and the quiet one:** `schedule.list_reminders` on the read door still answers,
     and lists cancelled reminders as if they were still coming. It reads the row, the
     column is simply absent, and absent reads as "not cancelled". That is a wrong
     list somebody will act on, with no error anywhere.

   Check it landed:

   ```sql
   select column_name from information_schema.columns
    where table_name = 'reminders' and column_name = 'canceled_at';
   ```

   **And then `schema_v38_muse_undo.sql`.** The change log, and `restore_money_event`.
   **Every write records what it replaced in `muse_undo` before it changes anything, so
   without that table every write fails** — which is the right direction to fail in: a
   change nobody could put back would not be recorded as one.

   **And then `schema_v40_muse_memory.sql`.** The memory table. Without it the three
   `memory.*` tools fail and nothing else does.

   All four are safe to re-run. The numbers are run in ascending order and a gap is not
   a missing file: v39 belongs to a change landing alongside this one.

5. **The doors' code is on `main`.** `supabase/functions/muse-read/`,
   `supabase/functions/muse-write/`, `supabase/functions/cron-reminders/`,
   `supabase/functions/cron-bank-sync/` and the
   shared modules both doors import, `supabase/functions/_shared/muse/`.

---

## Step 1 — make the two keys

Two separate keys: one for reading, one for writing. They must not be the same
string, or an "always allow" granted on one reaches the other.

```powershell
$b = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })
```

Run it twice. You get two 64-character strings. The first is your read key, the
second your write key.

Put both in your password manager now, labelled `MUSE_READ_GINO` and
`MUSE_WRITE_GINO`. Then:

- **Never** paste a key into a Google Doc, a note, a chat message, or a commit.
- **Never** put one in a web address. Addresses end up in logs.
- If you type a key straight into PowerShell it is saved in your command history
  on this machine. Step 2 avoids that.

## Step 2 — put the keys on the project

Write them to a file **outside the repo**, so there is no chance of committing it:

```powershell
@"
MUSE_READ_GINO=<paste the first key>
MUSE_WRITE_GINO=<paste the second key>
"@ | Set-Content C:\Users\ginoc\muse-secrets.local
```

Send it to Supabase, then delete it:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your Supabase personal access token>"
npx supabase secrets set --env-file C:\Users\ginoc\muse-secrets.local --project-ref ganzefaciiyibselizqi
Remove-Item C:\Users\ginoc\muse-secrets.local
```

Check they landed — this prints names and fingerprints, never the values:

```powershell
npx supabase secrets list --project-ref ganzefaciiyibselizqi
```

Her keys come later, when the second person is switched on. They are two more
names, `MUSE_READ_XINYAN` and `MUSE_WRITE_XINYAN`, and losing her phone revokes
hers and not yours.

## Step 3 — deploy the door

```powershell
npx supabase functions deploy muse-read --project-ref ganzefaciiyibselizqi
```

No Docker needed. Start with the read door alone and do Step 6 against it, because
a read that is wrong tells you something and costs nothing. When those checks pass,
the other two go the same way:

```powershell
npx supabase functions deploy muse-write --project-ref ganzefaciiyibselizqi
npx supabase functions deploy cron-reminders --project-ref ganzefaciiyibselizqi
```

`cron-bank-sync` (Step 4b) is the fourth, and it can wait until you do that step.

**One thing to fix once:** the deploy workflow lists every function by name
(`.github/workflows/deploy.yml`, the `for fn in ...` line). None of these four are
in that list, so a later edit to a door will look shipped and will not be running.
Add `muse-read`, `muse-write`, `cron-reminders` and `cron-bank-sync` to that line, or
deploy by hand every time you change one. This is the same trap that let
`cron-notify` drift two schema versions behind the app.

## Step 4 — schedule the 15-minute job

**Skip this and two things fail silently.** Reminders never arrive — the door still
says "your phone gets this within about 15 minutes of 3 PM", and nothing sends it —
and queued writes are never expired, so "it clears itself after 24 hours" is a
sentence rather than a rule. Both live in the same job, and nothing else creates it:
the block is commented out in `schema_v36_muse_bridge.sql` because it needs your real
`CRON_TOKEN`, which does not belong in a committed file.

`CRON_TOKEN` already exists on the project — it is the same secret `cron-notify`
uses. Print the names to confirm it is there (this shows names, never values):

```powershell
npx supabase secrets list --project-ref ganzefaciiyibselizqi
```

Then, in the Supabase SQL editor, paste this and **replace `PASTE_CRON_TOKEN_HERE`
with the real token** (from your password manager — not from the dashboard, which
does not show it):

```sql
do $g$ begin
  if exists (select 1 from cron.job where jobname='homebase-reminders')
    then perform cron.unschedule('homebase-reminders'); end if;
end $g$;

select cron.schedule('homebase-reminders', '*/15 * * * *',
  $j$ select net.http_post(
        url := 'https://ganzefaciiyibselizqi.supabase.co/functions/v1/cron-reminders?token=PASTE_CRON_TOKEN_HERE',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb) $j$);
```

Confirm it exists:

```sql
select jobname, schedule, active from cron.job where jobname = 'homebase-reminders';
```

One row, `*/15 * * * *`, active. If the token is wrong the job runs and the function
answers 403 every 15 minutes and says nothing to you — which is why check 9 below is
a reminder you actually wait for on a locked phone.

## Step 4b — schedule the bank pull

**Skip this and every number the doors give you slowly stops being true.** Not
wrong — *old*, which is worse, because it still sounds current.

Until now the bank feed was only ever pulled by a screen: `App.tsx` on launch, and
pull-to-refresh on the finance tab. Those were the only two callers in the whole
app. Once you stop opening the app, nothing calls them, and the ledger sits still
while the doors go on answering off it.

Three things, in this order.

**1. Run the migration.** In the SQL editor, paste
`supabase/schema_v39_bank_refresh.sql`. It adds one column,
`bank_connections.refresh_requested_at`, and an index. Safe to re-run.

**2. Deploy the function.**

```powershell
npx supabase functions deploy cron-bank-sync --project-ref ganzefaciiyibselizqi
```

It is a thin thing: it checks `?token=CRON_TOKEN`, decides whether anybody asked
for a forced refresh, and calls the `plaid` function's existing `sync`. It exists
rather than having pg_cron call `plaid` directly for one reason — `plaid` needs a
real caller, so a cron job pointed at it would have to carry the **service-role
key** in a row of `cron.job`, and that key reaches `disconnect`, which hard-deletes
bank history. This way the database holds only `CRON_TOKEN`.

**3. Schedule it.** Same editor, same token as Step 4:

```sql
do $g$ begin
  if exists (select 1 from cron.job where jobname='homebase-bank-sync')
    then perform cron.unschedule('homebase-bank-sync'); end if;
end $g$;

select cron.schedule('homebase-bank-sync', '*/15 * * * *',
  $j$ select net.http_post(
        url := 'https://ganzefaciiyibselizqi.supabase.co/functions/v1/cron-bank-sync?token=PASTE_CRON_TOKEN_HERE',
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := '{}'::jsonb) $j$);
```

Confirm, then wait twenty minutes and check the feed moved:

```sql
select jobname, schedule, active from cron.job where jobname = 'homebase-bank-sync';
select institution, status, last_sync_at from public.bank_connections;
```

`last_sync_at` should be inside the last fifteen minutes. **You do not have to take
that on trust from the database** — ask Muse anything about money and read the
`fresh` line on the answer. Every reply now carries one, and it says how old the
feed is in a sentence. If it says hours, one of these three steps did not take.

## Step 5 — give Muse the key

On your phone, in Muse, ask for a custom connector and give it the address and the
key. Something like:

> Build me a connector to my own API. The base address is
> `https://ganzefaciiyibselizqi.supabase.co/functions/v1`. Every call is a POST
> with a JSON body. Authenticate with a bearer key in the `Authorization` header,
> or in `X-Muse-Token` if you cannot set `Authorization` — the door takes either.
> I will give you the key in your secure credential entry, not in this chat. The
> description of every call is at `/muse-read/openapi.json`, fetched with the same
> key. Read that first.

Then paste the read key **only** into Muse's secure credential store, where it
keeps the key out of the model's sight. If Muse asks you to type the key into the
conversation instead, stop — that puts it in a transcript. Try the credential
entry again, and if there isn't one, the project does not go ahead on this path.

The door builds that description from its own list of tools, so it can never
describe a tool that does not exist. It is **behind the key**, like every other
path on the door — a stranger with no key gets the same refusal there as anywhere
else, and does not even learn which tools exist.

If Muse cannot fetch the description before it holds the key, paste `API.md` from
beside this file into the chat instead. It says the same things in plain sentences
and there are no secrets in it. Do not go looking for an `openapi.json` file in the
repo: there isn't one, on purpose. A second hand-written copy of the tool list was
wrong within a day of being written, so the only copy is the one the door
generates.

Two more things to tell it, because they are how this stays safe:

> Do not use "always allow" on this connector. And every number you tell me comes
> from the API — if a figure isn't there, say so instead of working it out.

**Then paste PASTE 1 from `MUSE-SKILL.md`.** That is the next thing you do, before
step 6, because step 6's checks are questions you ask Muse and it needs to know the
tools and the rules first. PASTE 1 covers both doors, every read, every write, the
refusals and the nine rules. `API.md` is the same material written long,
for the assistant — paste that instead if Muse asks for more detail, or if it cannot
fetch the door's own description before it holds a key. There are no secrets in
either file.

Leave PASTE 2 until checks 1–6 have passed. It is the part about him — the night
shift, the sleep window, the $1,400 floor, the meal plan — and there is no point
teaching Muse his schedule before you know the door answers at all.

**And one more line, which is what makes the memory store work rather than just
exist:**

> Keep everything you learn about me in Homebase, not in your own memory. Call
> `memory.list` at the start of a conversation about me, and `memory.remember` when
> I tell you something standing. Ask me first. Never put a number the app computes
> in there.

If it stores things in Meta's memory instead, you have a memory you cannot read and
cannot take with you, which is the one thing that table was added to fix. Checks 10
to 12 are how you find out which it did.

---

## Step 6 — the twelve checks

Do these on your phone. A check passes when **you** see it pass — not when a
script says so. If a probe and your phone disagree, your phone is right.

Checks 1–6 are the read door. Checks 7–9 are the write door and the reminder
pipeline, and they only run once Step 3's second deploy and Step 4 are done. Until
7–9 have passed you have no evidence the half that CHANGES things works at all.

**1. It answers at all.**
Ask: *"Ask Homebase whether the app disagrees with itself."*
Pass: it comes back with the checks and says whether they are clean.
Fail: it describes what it would do, or invents an answer. Ask it which tool it
called; if it cannot name one, the connector is not really wired up.

**2. The numbers match, to the cent.**
Ask for the cash position and for what is left in groceries this pay cycle. Then
open the app and look at both.
Pass: identical. Not close — identical.
Fail: any difference at all. That means the door worked a number out instead of
asking the app for it, and it is a bug in the door, never in the app.

**3. It survives the clock.**
Ask the same two questions twice: once around 7 PM, once after midnight.
Pass: the pay-cycle dates are the same window both times, and it never describes
tomorrow as today.
Fail: after about 5 PM the answers jump a day — a different pay cycle, different
bills, the next month on the last evening of a month. This is the failure this
whole design is built against, and it is invisible if you only ever test at noon.

**4. No key gets nothing.**
In your phone's browser open
`https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-read/finance.position`
Pass: a refusal sentence and no numbers.
Fail: any data at all, or an error that leaks something about the ledger.

**5. A forbidden ask is refused, and it says so.**
Ask: *"Show me my transactions from last week."* Then: *"Pay the electric bill."*
Pass: it says plainly that it cannot do that from here, and that the app can.
Fail: it produces a list of charges, claims it paid something, or tries a
different address to get around it. If it improvises a way, tell whoever built the
door — the list of tools has a hole in it.

**6. The log caught everything.**
Supabase dashboard → Table editor → `muse_audit`.
Pass: one row per question you just asked, with the right person and tool, and no
dollar amounts anywhere in the logged arguments.
Fail: missing rows (the log is not being written, so there is no accountability),
or amounts in the arguments (the log has become a second copy of the ledger).

**7. A weigh-in lands, and you can see it.**
Ask: *"Tell Homebase I weighed 198.4 this morning."*
Pass: it says it logged 198.4 lb for Gino for today, and the number is on the weight
screen in the app when you open it.
Fail: it says it cannot write (the write key is not wired up, or the connector is
pointed at the read door), or it says it logged something and the app does not show
it. Also read the sentence back: if it says the weight was *queued* or *waiting for a
tap*, something is wrong — a weigh-in lands straight away.

**8. The same write twice is one row.**
Ask the same weigh-in again in the same words, in the same conversation.
Pass: either it says it already did that one, or the weight screen still shows a
single entry for today.
Fail: two entries, or two of anything. That means the connector is sending a fresh
`Idempotency-Key` each time and a retry on a slow reply will duplicate a write. It is
the assistant's side that has to send the same key — tell it so.

**9. A reminder reaches a locked phone.**
Ask: *"Remind me in five minutes to check the electric bill."* Then lock the phone,
put it down, and do not touch it.
Pass: within about fifteen minutes a notification arrives beginning `Muse: `.
Fail: nothing arrives. In order of likelihood: Step 4's job does not exist, or its
token is wrong (check `cron.job` and then the function's logs in the dashboard), or
this phone has no push subscription for Gino, or the phone is on Do Not Disturb —
which silences it, because this is a notification and not an alarm. Nothing in any
cloud can set an alarm.

**Every write can actually happen now, and every one can be put back.** Phase 1 had four
writes that only wrote the request down and waited for a tap in a screen the app does not
have. All four are direct with a recorded before-state, so a reply that says something was
"queued" or "waiting for a tap" means the assistant is reading an old copy of the rules.

**11. You can read it yourself, and take it with you.**
Supabase dashboard → SQL editor:
```sql
select key, kind, value, tags from public.muse_memory
 where person = 'gino' and forgotten_at is null order by kind, key;
```
Pass: what it claims to know is there, in words you can read, and nothing in the
list is a dollar figure or a balance.
Fail: a row holding a number the app already computes — *"$1,193.77 available"*.
That is a figure that was true once and will be read back as current for ever.
Delete it and tell the assistant that measured numbers come from the read tools.

**12. Undo works, and forgetting is not a delete.**
Say *"forget the pay floor."* Then *"actually, put that back."*
Pass: it comes back word for word, and in the table the row was never gone — it had
a `forgotten_at` stamp and then it did not.
Fail: it cannot bring it back, or the row disappeared. A forget that cannot be undone
is the one thing this phase was built to avoid.

Twelve passes and the doors are real. Anything else, stop and fix that one thing before
adding the next tool.

---

## The memory store — the part that makes this portable

One table, `muse_memory`, and five plain columns: a key, a kind, the sentence, some
tags, and whose it is. Three tools touch it: `memory.remember`, `memory.forget`,
`memory.restore` on the write door, and `memory.recall`, `memory.search`,
`memory.list` on the read door.

**Why it is in your Postgres and not in Muse.** Muse remembers things across
conversations in Meta's own store. You cannot read that, correct it, copy it, or take
it with you — and it stops existing for you the day you stop using Muse. Everything
else in this bridge is built so the app stays the place things are true. A memory held
on the far side of the connector is the one part that would not survive leaving. Now
it does: one `select` hands the next assistant everything this one knew.

**What it is for.** The things the app cannot work out — a standing rule, a
preference, a routine, a decision already made, a fact with no column. Five kinds:
`standing`, `preference`, `routine`, `decided`, `fact`.

**What must never be in it.** Anything the app computes. A balance, a bill amount,
what is left in groceries, a weigh-in. Those change, and a copy in here would be read
back as current for ever — the same failure as "Electric $85" on every phone while
every screen said $100, except that a memory never expires. The door refuses the
obvious spelling (a value with no words in it) and check 8 above is you catching the
rest.

**Read all of it, any time:**

```sql
select key, kind, value, tags, learned_at from public.muse_memory
 where person = 'gino' and forgotten_at is null order by kind, key;
```

**Take it somewhere else.** Supabase dashboard → SQL editor → run the statement above
→ *Download CSV*. That file is the whole of what the assistant knew, in words, with no
Meta in it. Handing it to a different assistant is pasting it into a conversation.

**Forgetting is not deleting.** `memory.forget` stamps `forgotten_at` and the row
stays, which is what makes "no, put that back" one call. Forgotten rows are never in a
list or a search, so they cost you nothing by sitting there. If you ever want them
really gone — and after this the forget cannot be undone:

```sql
delete from public.muse_memory
 where forgotten_at is not null and forgotten_at < now() - interval '90 days';
```

**Two hundred live memories per person**, and that is a shape limit rather than a
storage one. Past that, something is journaling into it. The door refuses a new one and
says so; correcting one you already have is never refused.

**One cost, stated plainly.** The memory writes share the write door's ten-an-hour
allowance with the money and health writes. An assistant that remembers chattily can
spend the budget you needed for the ledger. If that gets annoying in practice, the fix
is a separate counter for `memory.*` in `muse-write/handler.ts` — two lines — and it was
left undone on purpose rather than guessed at before you had used it.

---

## When a call is refused

Muse will say the door's own sentence out loud. These are the sentences **as the
doors actually say them**, copied out of the source — so you can match what you hear
against this table word for word instead of guessing whether a paraphrase is the same
thing.

| What you hear | What happened | What to do |
|---|---|---|
| "That key does not open this door." | Wrong key, no key, a key too short to be real, or the write key used on the read door. Every one of those gives this same sentence on purpose. | Check step 2 landed, then redeploy (step 3). Secrets take effect on a fresh start. |
| "There is no … on this door." | It asked for something that does not exist here. The reply also lists what does exist and what never will. | Nothing is broken. If it keeps trying, tell it to read the description again. |
| "That is 60 questions this hour already. Wait for the hour to turn, or open the app." | The read cap, per person per Arizona hour. | Wait. If you were not asking that much, something is looping — check `muse_audit` for repeats. |
| "That is 10 writes this hour already. Give it an hour, or do this one in the app." | The write cap. Reminders have their own: 10 a day, 20 waiting at once. | Same. Reminders say "reminders for today already" instead. |
| "I could not read the whole ledger just now, so I am not going to give you a number." | The door could not read the whole ledger, so it refused to answer from part of it. | Working as designed. Ask again in a minute. If it keeps happening, the ledger has outgrown a page size and the door needs a look. |
| "from has to be a date like 2026-09-01." | A date was missing or the wrong shape. | Ask again with explicit dates. |
| "from has to be the first of a month…" / "to has to be the last day of a month … or today…" | `finance.spend_by_category` answers about whole months, or a month so far, and nothing else. A free choice of dates would turn category totals into a list of individual charges. | Ask about a month. For a pay cycle, the budget question needs no dates at all. |
| "That request is far bigger than any of these tools needs." | Over 16 KB of body. Nothing was read. | Nothing here needs a body that size; something is sending the wrong thing. |
| "a web address or something instruction-shaped in it" | It tried to store a memory containing a link or a phrase like "ignore previous instructions". Nothing was stored. | Working as designed, and this is the one refusal worth noticing. A memory is read back as trusted instructions in every future conversation, so a link in one is the most durable way something could talk your assistant into doing something. If this fires on a memory **you** dictated, rephrase it without the address. If it fires on something you did not ask for, look at `muse_audit` and consider rotating the write key. |
| "That is a figure, not something to remember" | It tried to store a number as a memory. | Working as designed. Numbers come from the read tools, which are current; a number in the memory table would be read back as current for ever. |
| "as many things remembered already" | Two hundred live memories. | Ask it what it knows (`memory.list`) and tell it what to forget. If the list is full of things you did not ask it to keep, tell it to ask first. |
| "already forgotten" / "nothing remembered under" | It tried to forget something that was not there. | Usually a mistyped key. Ask it to list what it knows and try the real one. |

Nothing on that list is ever a reason to accept an estimate. A refused call means
no number, not a best guess.

## Revoking a key

Under a minute, and it cannot half-work.

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your Supabase personal access token>"
npx supabase secrets set MUSE_READ_GINO=<a fresh key from step 1> --project-ref ganzefaciiyibselizqi
npx supabase functions deploy muse-read --project-ref ganzefaciiyibselizqi
```

The old key stops working the moment the function restarts. Then delete the
connector in Muse, or it will keep calling with a dead key.

Do this immediately if a phone is lost, if a key ever ends up somewhere it should
not, or if `muse_audit` shows calls you did not make. Otherwise every 90 days.

To shut the whole thing off rather than rotate it: set the key to a fresh random
value and do not give it to anyone. The door then refuses every call. The app is
untouched either way — nothing in Homebase depends on this door existing.
