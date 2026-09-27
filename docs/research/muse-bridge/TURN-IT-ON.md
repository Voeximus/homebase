# Turn it on — the short version

One page, in order. `SETUP.md` is the long version with the reasoning; this is the
sequence and nothing else. Commands are PowerShell, run from the repo folder.

Your project is `ganzefaciiyibselizqi`. The two addresses are:

```
https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-read
https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-write
```

**Before step 1:** Xinyan has to have said yes, about money and about health
separately — the shared ledger carries her pay and her spending, so your first
finance question sends her data too. And turn Muse's training setting off; it is on
when you start.

---

## 1. Make two keys

Run this twice. Each run prints one 64-character key. The first is your READ key, the
second your WRITE key. They must be different strings.

```powershell
$b = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
-join ($b | ForEach-Object { $_.ToString('x2') })
```

Put both in your password manager now, labelled `MUSE_READ_GINO` and
`MUSE_WRITE_GINO`. Never put a key in a web address, a Google Doc, a chat message or
a commit. A key shorter than 24 characters is treated as no key at all, so a
half-paste locks the door rather than opening it — that is deliberate.

## 2. Put the keys on the project

Write them to a file **outside the repo**, send it, then delete it. This keeps the
keys out of your PowerShell history.

```powershell
@"
MUSE_READ_GINO=<the first key>
MUSE_WRITE_GINO=<the second key>
"@ | Set-Content C:\Users\ginoc\muse-secrets.local

$env:SUPABASE_ACCESS_TOKEN = "<your Supabase personal access token>"
npx supabase secrets set --env-file C:\Users\ginoc\muse-secrets.local --project-ref ganzefaciiyibselizqi
Remove-Item C:\Users\ginoc\muse-secrets.local
```

Check they landed. This prints names and fingerprints, never values:

```powershell
npx supabase secrets list --project-ref ganzefaciiyibselizqi
```

Her keys are two more names later — `MUSE_READ_XINYAN`, `MUSE_WRITE_XINYAN`. Losing
her phone revokes hers and not yours.

## 3. Run the two SQL files, in this order

In the Supabase SQL editor: `supabase/schema_v36_muse_bridge.sql`, then
`supabase/schema_v37_reminder_edits.sql`. The second one is not optional. Without it
the reminder tools fail loudly — and `schedule.list_reminders` keeps answering while
listing cancelled reminders as if they were still coming, which is the quiet kind of
wrong. Confirm it landed:

```sql
select column_name from information_schema.columns
 where table_name = 'reminders' and column_name = 'canceled_at';
```

One row back means yes.

## 4. Deploy the read door and prove it before deploying the rest

```powershell
npx supabase functions deploy muse-read --project-ref ganzefaciiyibselizqi
```

Do step 6 against this alone first. A read that is wrong tells you something and
costs nothing. When those pass:

```powershell
npx supabase functions deploy muse-write --project-ref ganzefaciiyibselizqi
npx supabase functions deploy cron-reminders --project-ref ganzefaciiyibselizqi
```

**Fix this once, or every later change will look shipped and not be running.**
`.github/workflows/deploy.yml` deploys functions by name, and its list does not
include `muse-read`, `muse-write` or `cron-reminders`. Add all three to the
`for fn in ...` line, or redeploy by hand every time you change a door. This is the
same trap that left `cron-notify` two schema versions behind the app.

## 5. Schedule the 15-minute job

Skip this and reminders never arrive and queued writes are never cleared out — both
silently. `CRON_TOKEN` already exists on the project; it is the one `cron-notify`
uses, and it is in your password manager, not in the dashboard. In the SQL editor,
replacing the token:

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

Confirm: `select jobname, schedule, active from cron.job where jobname = 'homebase-reminders';`
— one row, `*/15 * * * *`, active. A wrong token fails 403 every fifteen minutes and
tells you nothing, which is why check 5 below is a reminder you actually wait for.

## 6. Give each Muse its key, then paste the rules

On your phone, ask Muse for a custom connector:

> Build me a connector to my own API. The base address is
> `https://ganzefaciiyibselizqi.supabase.co/functions/v1`. Every call is a POST with a
> JSON body. Authenticate with a bearer key in the `Authorization` header, or in
> `X-Muse-Token` if you cannot set `Authorization` — the door takes either. I will
> give you the key in your secure credential entry, not in this chat. The description
> of every call is at `/muse-read/openapi.json`, fetched with the same key. Read it
> first.

Paste the key **only** into Muse's secure credential store. If Muse asks you to type
it into the conversation, stop — that puts it in a transcript. If there is no
credential store, this path does not go ahead.

Then tell it two more things:

> Do not use "always allow" on this connector. Every number you tell me comes from the
> API — if a figure isn't there, say so instead of working it out.

**Then paste PASTE 1 from `MUSE-SKILL.md`.** Do this before step 7, because step 7's
checks are questions you ask Muse, and it needs the tools and the rules first. If Muse
cannot fetch the door's description before it holds the key, paste `API.md` instead —
there are no secrets in either file.

Her Muse gets the same treatment with her own keys. Same doors, different key; the
key is what tells the door who is asking.

Leave PASTE 2 — your schedule, the $1,400 floor, the meal plan — until the checks
below pass. No point teaching Muse your week before you know the door answers.

## 7. The five checks that prove it

Each one passes when **you** see it pass on your phone, not when a script says so. If
a probe and your phone disagree, your phone is right.

1. **It answers.** *"Ask Homebase whether the app disagrees with itself."* You get the
   checks back. If it instead describes what it would do, ask which tool it called —
   if it cannot name one, the connector is not wired up.
2. **The numbers match to the cent.** Ask for the cash position and what is left in
   groceries this cycle, then open the app and look. Identical, not close. Any
   difference is a bug in the door, never in the app.
3. **It survives the clock.** Ask the same two questions at 7 PM and again after
   midnight. The pay-cycle dates must be the same window both times. If the answers
   jump a day after about 5 PM, stop — that is the failure this whole design exists
   to prevent, and it is invisible if you only test at noon.
4. **No key gets nothing.** Open
   `https://ganzefaciiyibselizqi.supabase.co/functions/v1/muse-read/finance.position`
   in your phone browser. You should get a refusal and no numbers.
5. **A write lands, and twice is once.** *"Tell Homebase I weighed 198.4 this
   morning."* It should say it logged 198.4 for today, and the weight screen should
   show it. Ask again in the same words: you should get one entry, not two. If the
   reply says the weigh-in was *queued* or *waiting*, something is wrong — a weigh-in
   lands straight away.

Then look at `muse_audit` in the Supabase table editor: one row per question you
asked, right person, right tool, and no dollar amounts in the logged arguments.

## 8. Undoing a mistake

**There is no undo tool yet.** It is written but not merged, so today undo means:

- **A reminder** — ask Muse to cancel or change it. Those are real tools and they
  work.
- **A weigh-in or a meal** — fix it in the app. The door wrote a row; the app owns it.
- **Anything about money** — nothing on the write door changes the ledger. The
  money-side writes only write the request down and expire after 24 hours, so there is
  nothing to undo. The app is where money actually changes.
- **Nothing at all** — worst case, the door has written a weight row and some log
  rows. No door tool can move money, settle a bill, change a debt, delete a charge or
  touch the bank connection. Those do not exist here; they are not switched off.

## 9. Revoking a key

Under a minute, and it cannot half-work:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<your Supabase personal access token>"
npx supabase secrets set MUSE_READ_GINO=<a fresh key from step 1> --project-ref ganzefaciiyibselizqi
npx supabase functions deploy muse-read --project-ref ganzefaciiyibselizqi
```

The old key dies the moment the function restarts. Then delete the connector in Muse
or it keeps calling with a dead key. Do this immediately if a phone goes missing, if a
key lands somewhere it should not, or if `muse_audit` shows calls you did not make.
Otherwise every 90 days.

To shut the whole thing off instead of rotating it: set the key to a fresh random
value and give it to nobody. Every call is then refused.

## 10. If something is wrong at 2 AM

**Do the first thing and go back to sleep. Nothing here is urgent, because nothing in
Homebase depends on these doors existing.** The app works exactly the same with both
doors dead.

1. **Muse said a number and you think it is wrong.** Believe the app, not Muse. Open
   the app and look. Do not act on the number.
2. **You want it to stop right now.** Delete the connector in Muse on your phone. That
   is one tap and needs no laptop. If you cannot, turn the phone's internet off — the
   door cannot be reached from a plane.
3. **You think a key leaked.** Step 9, from your laptop. If there is no laptop, step
   2 and do step 9 in the morning.
4. **Reminders are not arriving.** In order of likelihood: the step 5 job does not
   exist, its token is wrong, this phone has no push subscription, or the phone is on
   Do Not Disturb. This is a notification, not an alarm — nothing in any cloud can set
   an alarm. Leave it until morning.
5. **Every call is refused.** The secret is probably missing or half-pasted, which
   locks the door on purpose. `npx supabase secrets list` in the morning.
6. **You cannot tell what happened.** `muse_audit` in the Supabase table editor is one
   row per call, with the person, the tool and whether it worked. No amounts are
   logged. Assume it tells you everything that was asked.

Anything not on this list: write down what you heard, word for word, and leave it. A
wrong number that you did not act on has cost nothing.
