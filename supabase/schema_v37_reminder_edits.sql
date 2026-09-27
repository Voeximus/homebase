-- schema_v37_reminder_edits.sql  —  2026-09-26  (RUN ONCE, safe to re-run)
-- ---------------------------------------------------------------------------
-- One column, two indexes, and a sentence about why the column is not a delete.
--
-- WHAT THIS IS FOR
--   schema_v36 gave the write door `schedule.remind`, and nothing could take a
--   reminder back. That matters more than it sounds: there is NO reminders screen
--   in the app — nothing under `src/` reads or writes this table — so a reminder
--   set for 3 AM instead of 3 PM could only be fixed in the Supabase dashboard,
--   and until somebody opened the dashboard it woke a person up every night.
--
--   So the write door grows two tools, `schedule.cancel_reminder` and
--   `schedule.update_reminder`, and the read door grows `schedule.list_reminders`
--   so that an assistant can find the id of the one to fix.
--
-- WHY `canceled_at` AND NOT A DELETE — READ THIS BEFORE "SIMPLIFYING" IT
--   No door in this bridge has a delete verb. That is not a style choice; it is
--   item 3 of what an assistant may never do, it is enforced by there being no
--   such function in supabase/functions/muse-write/db.ts, and it is written into
--   the guide the assistant reads. "Cancel" is therefore an UPDATE that sets one
--   timestamp:
--
--     · the row survives, so `muse_audit.row_ids` still points at something real
--       and "did that actually get cancelled" has an answer instead of an absence;
--     · a reminder that had ALREADY gone out can be refused with the time it went,
--       which a deleted row could not tell you — and answering "cancelled" for a
--       push that is already on a lock screen is the worst thing this tool could
--       do;
--     · it is reversible. Clearing the column un-cancels it.
--
--   The spelling is American ("canceled_at") to match `sent_at`/`last_sent_at`'s
--   neighbours in the same table and every other column in this schema. The code
--   that reads it spells it the same way in one mapper
--   (_shared/muse/rows.ts toReminder) and nowhere else.
--
-- WHO MAY TOUCH IT
--   Nothing changes. `reminders` already grants select/insert/update/delete to
--   `authenticated` under the "reminders household" policy, because it is the
--   household's own list and the app is expected to grow a screen for it. A new
--   column on an existing table inherits that grant, so there is no new privilege
--   here — which is exactly why this file adds a column instead of a table.
-- ---------------------------------------------------------------------------

-- ── 1. the column ────────────────────────────────────────────────────────────
alter table public.reminders
  add column if not exists canceled_at timestamptz;
comment on column public.reminders.canceled_at is
  'When somebody called schedule.cancel_reminder. Set instead of deleting the row: no door in the Muse bridge has a delete verb, and a cancelled row is the record that it was cancelled. cron-reminders skips any row where this is not null, and it checks it again on the claim so a cancel landing mid-run wins.';

-- ── 2. what the 15-minute job asks for ───────────────────────────────────────
-- v36's `reminders_due (sent_at, due_at)` is still the right index for the old
-- query. The job's filter now has three parts, so this is the one that covers it.
-- Partial, because the rows it has to find are the tiny live minority: every
-- delivered and every cancelled reminder is permanently outside it.
create index if not exists reminders_deliverable
  on public.reminders (due_at)
  where sent_at is null and canceled_at is null;

-- What `countOpenReminders` asks: how many of this person's reminders are still
-- going to arrive. Cancelling one has to free a slot against REMIND_OPEN_MAX, or
-- twenty cancelled rows would be a wall nothing could ever get past.
create index if not exists reminders_open_per_person
  on public.reminders (person)
  where sent_at is null and canceled_at is null;

-- ── 3. housekeeping, by hand ─────────────────────────────────────────────────
-- Same rule as v36 §9: not scheduled, because an unattended delete is the kind of
-- thing this project keeps out of its cron jobs.
--
-- This is the one table in the bridge that only ever grows, and the read door's
-- `schedule.list_reminders` reads a person's rows WHOLE (Rule 5: paged, and it
-- refuses rather than truncating). MAX_ROWS is 20,000 and the cap is 10 new
-- reminders a person a day, so the door starts refusing to list them somewhere
-- around 2031. A refusal is the right failure — a list of pending reminders
-- silently missing the one that matters is worse than no list — but it is still a
-- failure, so:
--
--   delete from public.reminders
--    where (sent_at is not null or canceled_at is not null)
--      and coalesce(sent_at, canceled_at) < now() - interval '180 days';
