// cron-audit — daily, run by pg_cron. Runs every self-check against the real ledger
// and says so the morning something newly breaks.
//
// WHY THIS EXISTS. selfAudit.ts holds nine checks that are exactly zero in a healthy
// ledger — do the bills add up the same way everywhere, is any bill paid twice, does
// every link point at something real, was each bill paid from its own account. Until
// today they ran in exactly two places: when the app's Profile screen opened, and
// when someone asked Muse for finance.audit. The app is the thing being retired, so
// in practice the checks ran when somebody thought to ask — which is never on the day
// it matters.
//
// So they run themselves, once a day, against the whole ledger.
//
// WHY THIS IS NOT THE HEARTBEAT. heartbeat.ts says it in its first line: the
// heartbeat asks "is anything still arriving", the audit asks "are the numbers
// consistent", and a ledger whose feed died last week passes every audit check
// because it is consistent about last week. Two different questions, two jobs. The
// heartbeat watches THIS job for liveness exactly as it watches the bank sync — if
// cron-audit stops running, that is a heartbeat alarm.
//
// IT PUSHES ON THE EDGE, NOT ON THE STATE, for the reason the heartbeat gives: a push
// that repeats every morning until something is fixed is a push that gets turned off.
// It compares against its own previous row in job_runs, so a failing check buzzes
// once, and a SECOND different failure while the first is still open buzzes again.
//
// WHAT IT STORES. Check ids and counts only — never a check's `detail`. Three of the
// nine details quote a raw bank descriptor, job_runs is read by system.heartbeat,
// and system.heartbeat answers through a door whose first rule is that a descriptor
// never reaches the model. The details are one finance.audit away for anyone who
// needs them, already scrubbed.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendPush } from "../_shared/webpush.ts";
import { safeEqual } from "../_shared/muse/safeEqual.ts";
import { recordFinished } from "../_shared/jobRun.ts";
import { nowAZ } from "../_shared/muse/az.ts";
import { createLoader } from "../_shared/muse/load.ts";
import { supabaseDb } from "../_shared/supabaseDb.ts";
import { selfAudit } from "../_shared/muse/lib/selfAudit.ts";
import { DEFAULT_ALERT_OWNER } from "../_shared/muse/heartbeat.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const TOKEN = Deno.env.get("CRON_TOKEN") ?? "";
const APP = Deno.env.get("APP_URL") ?? "https://voeximus.github.io/homebase/";

/** Who is told. Bookkeeping errors are his to act on — the same reasoning, and the
 *  same environment variable, as the heartbeat's infrastructure alarms. A push with
 *  no owner fans out to every device in the household. */
const ALERT_OWNER = Deno.env.get("HEARTBEAT_OWNER") ?? DEFAULT_ALERT_OWNER;

const JOB = "cron-audit";

Deno.serve(async (req) => {
  // Fail CLOSED, constant time, like every other scheduled function here.
  if (!TOKEN || !safeEqual(new URL(req.url).searchParams.get("token") ?? "", TOKEN)) {
    return new Response("forbidden", { status: 403 });
  }

  // ONE clock reading, passed down. The audit's "this month and last" window is
  // computed from it, and it is the Arizona wall clock the doors use, so the
  // scheduled run and finance.audit agree on which month it is.
  const now = nowAZ(new Date());

  let failing: string[] = [];
  let pushed = 0;

  try {
    // The same loader finance.audit uses, over the same adapter. If this ever loaded
    // the ledger differently, the morning push and the spoken answer could disagree
    // about the same data — and the one nobody can see is the one that would be wrong.
    const data = await createLoader(supabaseDb(admin)).appData();
    const result = selfAudit(data, now);
    const failed = result.checks.filter((c) => c.status === "fail");
    failing = failed.map((c) => c.id);

    const { data: prevRows, error: prevErr } = await admin
      .from("job_runs")
      .select("detail, finished_at")
      .eq("job", JOB)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1);
    if (prevErr) throw new Error(prevErr.message);
    const known = new Set(
      ((prevRows?.[0]?.detail as Record<string, unknown> | null)?.["failing"] as string[] | undefined) ?? [],
    );
    const fresh = failed.filter((c) => !known.has(c.id));

    if (fresh.length > 0) {
      // The check's QUESTION, not its detail: a question is a fixed sentence written
      // in selfAudit.ts, never built from ledger rows, so it is safe anywhere. The
      // detail — which bill, which charge — is one finance.audit away.
      const body =
        fresh.length === 1
          ? `A check failed: ${fresh[0].question} Ask Muse for finance.audit to see which.`
          : `${fresh.length} checks failed: ${fresh.map((c) => c.question).join(" ")} Ask Muse for finance.audit.`;
      const res = await sendPush(admin, { title: "Homebase", body, url: APP, tag: "audit" }, ALERT_OWNER);
      pushed = res.sent;
      if (res.sent === 0) console.error("cron-audit: a check failed and it reached no device", failing);
    }

    await recordFinished(admin, JOB, {
      ok: true,
      // `failing` is the whole current set, not just what was new — it is what the
      // next run compares against, so a fault that persists does not look fresh
      // again tomorrow and buzz every morning.
      detail: { failing, failures: result.failures, checks: result.checks.length, pushed, new: fresh.length },
    });

    return new Response(JSON.stringify({ ok: true, clean: result.clean, failing, pushed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    const caught = String((e as Error)?.message ?? e).slice(0, 200);
    console.error(JOB, caught);
    // An audit that could not read the ledger has not found it clean, and its row
    // says so rather than recording a pass it never checked.
    await recordFinished(admin, JOB, { ok: false, detail: { failing, pushed }, error: caught });
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
