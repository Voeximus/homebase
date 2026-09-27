# Turning the door on — the steps, in order

For Gino. Everything here is done once. Nothing here writes to the database or
changes the app. Commands are PowerShell, from the repo folder.

The project is `ganzefaciiyibselizqi`, so the door's address is:

```
https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-read
```

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
5. **The door's code is on `main`.** `supabase/functions/muse-read/` and
   `supabase/functions/_shared/muse/`.

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

No Docker needed. Deploy `muse-write` the same way when that half exists.

**One thing to fix once:** the deploy workflow lists every function by name
(`.github/workflows/deploy.yml`, the `for fn in ...` line). `muse-read` is not in
that list, so a later edit to the door will look shipped and will not be running.
Add `muse-read` — and `muse-write` when it exists — to that line, or deploy the
door by hand every time you change it. This is the same trap that let
`cron-notify` drift two schema versions behind the app.

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

If Muse cannot fetch the description with the token, open
`supabase/functions/muse-read/openapi.json` in the repo and paste its contents
into the chat. There are no secrets in that file.

Two more things to tell it, because they are how this stays safe:

> Do not use "always allow" on this connector. And every number you tell me comes
> from the API — if a figure isn't there, say so instead of working it out.

The plain-English rules the assistant should follow are in `API.md` beside this
file. Paste that in too, or point Muse at it; it is written to be read by the
assistant, not by you.

---

## Step 5 — the six checks

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

Six passes and the door is real. Anything else, stop and fix that one thing before
adding the next tool.

---

## When a call is refused

Muse will say the door's own sentence out loud. This is what each one means.

| What you hear | What happened | What to do |
|---|---|---|
| "did not recognise the key" | Wrong key, no key, or the write key used on the read door. | Check step 2 landed, then redeploy (step 3). Secrets take effect on a fresh start. |
| "has no such tool" | It asked for something that does not exist here. | Nothing is broken. If it keeps trying, tell it to read the description again. |
| "as many questions as this door answers in an hour" | Over 60 reads in an hour for you. | Wait. If you were not asking that much, something is looping — check `muse_audit` for repeats. |
| "could not read the ledger cleanly" | The door could not read the whole ledger, so it refused to answer from part of it. | Working as designed. Ask again in a minute. If it keeps happening, the ledger has outgrown a page size and the door needs a look. |
| "Dates must look like..." | It sent a date the door did not understand. | Ask your question again with explicit dates. |

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
