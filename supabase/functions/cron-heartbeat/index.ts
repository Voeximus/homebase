// cron-heartbeat — hourly, run by pg_cron. Pushes only when something BREAKS.
//
// WHY THIS EXISTS SEPARATELY FROM THE DAILY PASS
//   The daily pass organises, audits and fixes, and it needs judgement — so it runs
//   as Claude on his desktop, which means it runs when that machine is awake. That
//   is fine for deciding whether a Zelle transfer was dinner or skincare. It is not
//   fine for "the bank feed stopped four days ago", because that is a FACT rather
//   than a judgement, and a fact he needs while the desktop is off is a fact the
//   desktop cannot be trusted to deliver.
//
//   So the two halves split by what they are. NOTICING is mechanical and lives here,
//   hosted, needing nothing switched on. JUDGING stays with the pass. If this machine
//   is off for a week he still gets told the feed died; he just does not get it fixed
//   until somebody looks.
//
// ONE COPY OF THE JUDGEMENT. Every threshold and every sentence comes from
// _shared/muse/heartbeat.ts — the same pure module system.heartbeat calls. This file
// is plumbing: it reads rows and hands them over. A second opinion about what counts
// as broken is how one system ends up with two answers to the same question, and this
// one would be the answer nobody was reading.
//
// IT PUSHES ON THE EDGE, NOT ON THE STATE
//   An hourly job that pushes whenever something is wrong sends the same buzz every
//   hour until it is fixed, and a notification that repeats is a notification that
//   gets turned off — after which this is exactly as useful as not existing, while
//   looking like it works. So it pushes only for checks that were NOT alarming last
//   run, and it finds "last run" in job_runs, the table the heartbeat already reads.
//   No new state, no new table.
//
//   The cost of that choice, said plainly: if he misses the one push, nothing chases
//   him. That is deliberate. The daily pass reads the same heartbeat and will say it
//   again in the morning, and system.heartbeat answers the moment anyone asks.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";
import { safeEqual } from "../_shared/muse/safeEqual.ts";
import { recordFinished } from "../_shared/jobRun.ts";
import { heartbeatFrom, previousAlarms } from "../_shared/muse/heartbeatFrom.ts";
import { createLoader } from "../_shared/muse/load.ts";
import { supabaseDb } from "../_shared/supabaseDb.ts";
import { nowAZ } from "../_shared/muse/az.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TOKEN = Deno.env.get("CRON_TOKEN") ?? "";
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

/** Who gets told when the machinery breaks. The push_subscriptions spelling, which
 *  is what webpush.ts matches on. */
const ALERT_OWNER = Deno.env.get("HEARTBEAT_OWNER") ?? "Gino";


Deno.serve(async (req) => {
  // Fail CLOSED, constant time, like every other scheduled function here.
  if (!TOKEN || !safeEqual(new URL(req.url).searchParams.get("token") ?? "", TOKEN)) {
    return new Response("forbidden", { status: 403 });
  }

  // ONE clock reading, passed down. Same rule the doors hold themselves to.
  const at = new Date();
  const now = nowAZ(at);

  let caught: string | null = null;
  let pushed = 0;
  let alarms = 0;

  try {
    // EVERY ROW, PAGED — through the same Loader and the same builder Muse's
    // system.heartbeat uses (heartbeatFrom.ts). This function used to run its own
    // `select` on job_runs with no limit and no order, and Supabase capped it at
    // 1,000 rows. Past that, the 15-minute jobs' newest rows were the ones dropped,
    // so from 2026-10-02 it reported the bank sync and reminders as stopped every
    // hour while both were running — and an alarm stuck on is an alarm that cannot
    // announce a real outage.
    const load = createLoader(supabaseDb(admin));
    const result = await heartbeatFrom(load, now, at);
    const alarming = result.checks.filter((c) => c.status === "alarm");
    alarms = alarming.length;

    // What was already broken last time this ran — read from the SAME complete load,
    // because the old lookup searched the same capped page and lost its own last row.
    const known = await previousAlarms(load);
    const fresh = alarming.filter((c) => !known.has(c.id));

    if (fresh.length > 0) {
      // ONE push for all of them, not one each. Three things breaking at once is one
      // event to him, and three buzzes in a second is how a phone gets silenced.
      const body = fresh.length === 1
        ? fresh[0].says
        : `${fresh.length} things need looking at. ${fresh.map((c) => c.says).join(" ")}`;
      // NAMED OWNER, ALWAYS. sendPush fans out to EVERY stored subscription when the
      // owner is left undefined — cron-reminders' own comment says so, and the first
      // live test of this function proved it by buzzing all six devices in the house.
      // These are infrastructure alarms: "cron-bank-sync last finished three hours
      // ago" is his to act on and is pure noise on her phone. A household alert that
      // wakes the person who cannot fix it is how both people learn to ignore it.
      const res = await sendPush(admin, { title: "Homebase", body, url: APP, tag: "heartbeat" }, ALERT_OWNER);
      pushed = res.sent;
      if (res.sent === 0) {
        console.error("cron-heartbeat: something broke and it reached no device", fresh.map((c) => c.id));
      }
    }

    await recordFinished(admin, "cron-heartbeat", {
      ok: true,
      // `alarming` is what the NEXT run compares against, so it is the whole current
      // set rather than only what was new — otherwise a fault that persists would
      // look fresh again an hour later and buzz forever.
      detail: { alarming: alarming.map((c) => c.id), alarms, unknown: result.unknown, pushed, new: fresh.length },
    });

    return new Response(JSON.stringify({ ok: true, alarms, pushed, new: fresh.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    caught = String((e as Error)?.message ?? e).slice(0, 200);
    console.error("cron-heartbeat", caught);
    // A heartbeat that cannot read is not a healthy heartbeat, and it says so in its
    // own row rather than reporting a clean bill it never checked.
    await recordFinished(admin, "cron-heartbeat", { ok: false, detail: { alarms, pushed }, error: caught });
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
