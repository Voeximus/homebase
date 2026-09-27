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
4. **The database tables exist.** Two files, in the Supabase SQL editor, in this
   order. Both are safe to re-run.
   - `schema_v36_muse_bridge.sql` — the audit log, the rate-limit counters, the
     queued-write table and the reminder list. The door writes a log row for every
     call, so without this every call fails.
   - `schema_v37_muse_memory.sql` — the memory table. Without it the three
     `memory.*` tools fail and nothing else does.

   After each one, check the locks actually landed. This should return four rows for
   v36 and one for v37, every one of them `true`:

   ```sql
   select relname, relrowsecurity from pg_class
    where relname in ('muse_audit','muse_calls','muse_pending','reminders','muse_memory');
   ```

   If any row says `false`, stop. A table in `public` without row-level security is
   readable and writable by anyone who reads the app's JavaScript, and the publishable
   key is in that bundle on purpose.
5. **The doors' code is on `main`.** `supabase/functions/muse-read/`,
   `supabase/functions/muse-write/`, `supabase/functions/cron-reminders/` and the
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

No Docker needed. Start with the read door alone and do Step 5 against it, because
a read that is wrong tells you something and costs nothing. When those checks pass,
the other two go the same way:

```powershell
npx supabase functions deploy muse-write --project-ref ganzefaciiyibselizqi
npx supabase functions deploy cron-reminders --project-ref ganzefaciiyibselizqi
```

**One thing to fix once:** the deploy workflow lists every function by name
(`.github/workflows/deploy.yml`, the `for fn in ...` line). None of these three are
in that list, so a later edit to a door will look shipped and will not be running.
Add `muse-read`, `muse-write` and `cron-reminders` to that line, or deploy by hand
every time you change one. This is the same trap that let `cron-notify` drift two
schema versions behind the app.

## Step 4 — give Muse the key

On your phone, in Muse, ask for a custom connector and give it the address and the
key. Something like:

> Build me a connector to my own API. The base address is
> `https://ganzefaciiyibselizqi.supabase.co/functions/v1`. Every call is a POST
> with a JSON body. Authenticate with a bearer token in the `Authorization`
> header — I will give you the token in your secure credential entry, not in this
> chat. The description of every call is at `/muse-read/openapi.json`, fetched
> with the same token. Read that first.

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

And one more, which is what makes the memory store actually work rather than just
exist:

> Keep everything you learn about me in Homebase, not in your own memory. Call
> `memory.list` at the start of a conversation about me, and `memory.remember` when
> I tell you something standing. Ask me first. Never put a number the app computes
> in there.

If it stores things in Meta's memory instead, you have a memory you cannot read and
cannot take with you, which is the one thing this table was added to fix. Check 7
below is how you find out which it did.

The plain-English rules the assistant should follow are in `API.md` beside this
file. Paste that in too, or point Muse at it; it is written to be read by the
assistant, not by you.

---

## Step 5 — the nine checks

Do these on your phone. A check passes when **you** see it pass — not when a
script says so. If a probe and your phone disagree, your phone is right.

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

**7. The memory survives a new conversation.**
This is the whole point of the memory store, and it is the check nobody can do for
you. Tell it something standing — *"remember that fourteen hundred a check is a
floor and you never raise it."* Then **close Muse, and come back in a brand-new
conversation tomorrow** and ask *"what do you know about how I want my money
handled?"*
Pass: it says the floor back to you, and says you told it — not that the app
measured it.
Fail (two different failures, and they need different fixes):
- it remembers, but there is no row in `muse_memory` → it stored it in Meta's own
  memory instead of calling the tool. Tell it to use `memory.remember`. If it will
  not, the memory store is not doing its job and you have gained nothing portable.
- it does not remember and there IS a row → it is not calling `memory.list` at the
  start of a conversation. Tell it to.

**8. You can read it yourself, and take it with you.**
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

**9. Undo works, and forgetting is not a delete.**
Say *"forget the pay floor."* Then *"actually, put that back."*
Pass: it comes back word for word, and in the table the row was never gone — it had
a `forgotten_at` stamp and then it did not.
Fail: it cannot bring it back, or the row disappeared. A forget that cannot be undone
is the one thing this phase was built to avoid.

Nine passes and the doors are real. Anything else, stop and fix that one thing before
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

Muse will say the door's own sentence out loud. This is what each one means.

| What you hear | What happened | What to do |
|---|---|---|
| "did not recognise the key" | Wrong key, no key, or the write key used on the read door. | Check step 2 landed, then redeploy (step 3). Secrets take effect on a fresh start. |
| "has no such tool" | It asked for something that does not exist here. | Nothing is broken. If it keeps trying, tell it to read the description again. |
| "as many questions as this door answers in an hour" | Too many calls in an hour. The write door counts these today; the read door's own cap is not switched on yet, so a runaway read loop will not be stopped for you. | Wait. If you were not asking that much, something is looping — check `muse_audit` for repeats. |
| "could not read the ledger cleanly" | The door could not read the whole ledger, so it refused to answer from part of it. | Working as designed. Ask again in a minute. If it keeps happening, the ledger has outgrown a page size and the door needs a look. |
| "Dates must look like..." | It sent a date the door did not understand. | Ask your question again with explicit dates. |
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
