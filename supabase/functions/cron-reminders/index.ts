// cron-reminders — every 15 minutes, run by pg_cron.
//   • Delivers reminders that are due, as a real Web Push.
//   • Marks queued writes nobody tapped within 24 hours as expired.
// PUBLIC (verify_jwt=false), guarded by ?token=CRON_TOKEN — the same guard and the
// same caller as cron-notify. pg_cron cannot hold a Supabase session.
//
// WHY THIS EXISTS AT ALL
//   An assistant's own reminders are chat messages. Meta's reminder page says
//   "Reminders are delivered as messages in your conversation with Muse" and never
//   once says notification, push, alert, alarm, snooze or sound — and it hedges the
//   timing itself: "Your Muse will aim to send you a reminder at the scheduled
//   time". Nobody writes "aim to" about something they guarantee.
//
//   So the assistant writes the row while he is awake and talking, and Homebase
//   delivers it. That reaches him at 2:45 AM using the one part of the system that
//   already works unattended and rests on no undocumented behaviour.
//
//   Honest footnote, said once: this is an ordinary notification, not an alarm.
//   Android and iOS silence it under Do Not Disturb. Nothing in any cloud can set
//   a phone alarm — that needs an on-device intent. This wins by being built and
//   by being timed by him, not by being loud.
//
// TWO ORDERING DECISIONS, BOTH DELIBERATE
//   1. The row is CLAIMED before the push is sent. If the push then fails, the
//      reminder is not retried. The other order — push, then mark — turns one
//      failed write into a buzz every 15 minutes forever, and a notification storm
//      is worse than one missed reminder. Delivery cannot be confirmed by anybody
//      in this pipeline anyway, so pretending otherwise would buy nothing.
//   2. The owner is always named. sendPush fans out to EVERY stored subscription
//      when the owner is undefined, so a row with an unrecognized person is
//      SKIPPED, never sent. An undefined person is not "just Gino", it is the
//      whole household.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";
import { planFor, type Repeats } from "./schedule.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TOKEN = Deno.env.get("CRON_TOKEN") ?? "";
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

/** The push_subscriptions "owner" spelling for each person. */
const OWNER: Record<string, string> = { gino: "Gino", xinyan: "Xinyan" };

/** How many reminders one run will deliver. A backlog drains over the following
 *  runs instead of arriving as one wall of buzzes. */
const MAX_PER_RUN = 20;

interface ReminderRow {
  id: string;
  person: string;
  message: string;
  due_at: string;
  repeats: string;
}

Deno.serve(async (req) => {
  // Fail CLOSED: a missing or empty CRON_TOKEN denies everything. It never
  // disables the check.
  if (!TOKEN || new URL(req.url).searchParams.get("token") !== TOKEN) {
    return new Response("forbidden", { status: 403 });
  }

  // One clock reading. Everything below compares instants — no calendar date is
  // involved anywhere in this function, which is why no timezone comes into it.
  const now = new Date();
  const nowISO = now.toISOString();

  let sent = 0;
  let skipped = 0;
  let expired = 0;
  let backlog = false;

  try {
    const { data: rows, error } = await admin
      .from("reminders")
      .select("id, person, message, due_at, repeats")
      .is("sent_at", null)
      .lte("due_at", nowISO)
      .order("due_at", { ascending: true })
      .limit(MAX_PER_RUN + 1);
    if (error) throw new Error(`read reminders: ${error.message}`);

    const due = (rows ?? []) as ReminderRow[];
    backlog = due.length > MAX_PER_RUN;

    for (const r of due.slice(0, MAX_PER_RUN)) {
      const owner = OWNER[r.person];
      if (!owner) {
        console.error("cron-reminders: reminder", r.id, "has no recognized person — skipped, never fanned out");
        skipped++;
        continue;
      }
      const plan = planFor(new Date(r.due_at), r.repeats as Repeats, now);

      // CLAIM. Conditional on the row still being unsent AND still sitting at the
      // due time we read, so two overlapping runs cannot both take it.
      const claim = plan.nextDueAt
        ? { due_at: plan.nextDueAt.toISOString(), last_sent_at: nowISO }
        : { sent_at: nowISO, last_sent_at: nowISO };
      const { data: claimed, error: claimErr } = await admin
        .from("reminders")
        .update(claim)
        .eq("id", r.id)
        .eq("due_at", r.due_at)
        .is("sent_at", null)
        .select("id");
      if (claimErr) throw new Error(`claim reminder: ${claimErr.message}`);
      if ((claimed ?? []).length !== 1) continue; // another run got it

      if (!plan.send) {
        console.log("cron-reminders: skipped", r.id, plan.why);
        skipped++;
        continue;
      }

      // The message already carries its marker and was capped and cleaned by the
      // door. It is sent as it is stored — nothing is added to it here, so what he
      // sees on the lock screen is what the app's list shows.
      const res = await sendPush(
        admin,
        { title: "Reminder", body: r.message, url: APP, tag: `reminder-${r.id}` },
        owner,
      );
      if (res.sent === 0) {
        console.error("cron-reminders:", r.id, "reached no device for", owner, "— marked delivered anyway");
      }
      sent++;
    }

    // Queued writes nobody tapped. The 24-hour expiry has to actually happen, or
    // "it expires if you do not tap it" is a sentence and not a rule. The database
    // side of it is already in place: muse_pending's update policy only lets the
    // app decide a row while its state is 'waiting'.
    const { data: gone, error: expErr } = await admin
      .from("muse_pending")
      .update({ state: "expired", decided_at: nowISO })
      .eq("state", "waiting")
      .lte("expires_at", nowISO)
      .select("id");
    if (expErr) throw new Error(`expire muse_pending: ${expErr.message}`);
    expired = (gone ?? []).length;
  } catch (e) {
    console.error("cron-reminders", String((e as Error)?.message ?? e).slice(0, 200));
  }

  return new Response(JSON.stringify({ ok: true, at: nowISO, sent, skipped, expired, backlog }), {
    headers: { "Content-Type": "application/json" },
  });
});
