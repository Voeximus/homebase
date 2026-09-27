// cron-bank-sync — every 15 minutes, run by pg_cron. Pulls the bank feed.
//
// PUBLIC (verify_jwt=false), guarded by ?token=CRON_TOKEN — the same guard, the same
// secret and the same caller as cron-notify and cron-reminders. pg_cron cannot hold a
// Supabase session.
//
// WHY THIS EXISTS AT ALL
//
//   Search the app for who pulls the bank and there are exactly two callers, both of
//   them a person looking at something:
//
//     src/App.tsx:151                       syncNow()      — on launch
//     src/views/redesign/FinanceTabs.tsx    syncNow(true)  — pull-to-refresh
//
//   That is the whole of it. There was no scheduled bank pull anywhere in this
//   project — `select jobname from cron.job` had homebase-daily-notify and
//   homebase-reminders on it and nothing else.
//
//   While the app WAS the product that was a reasonable design: you saw fresh numbers
//   because looking at them was what fetched them. Muse being the interface inverts
//   it. Nobody opens the app, so nothing calls syncNow, so the ledger stops moving —
//   and the doors go on answering, with the app's own arithmetic, off a database that
//   last changed days ago. That is the worst failure shape this project has: not a
//   wrong number, a RIGHT number about last Tuesday, spoken today as though it were
//   about today, with no screen beside it to disagree.
//
// WHY IT IS A FUNCTION AND NOT JUST A cron.schedule POINTED AT `plaid`
//
//   `plaid` is verify_jwt = true and its own guard (_shared/callerAuth.ts) accepts a
//   signed-in user or the SERVICE ROLE key. A cron job has no user, so pointing
//   net.http_post straight at it means writing the service-role key into the command
//   string of a row in `cron.job` — the key that RLS does not constrain, the one that
//   reaches `disconnect`, which hard-deletes accounts and their whole transaction
//   history. The existing jobs put CRON_TOKEN in that string, and CRON_TOKEN opens two
//   narrow cron functions; the service-role key opens everything.
//
//   So the cron job carries the weak secret, and the strong one stays where the
//   platform already keeps it: SUPABASE_SERVICE_ROLE_KEY is injected into an edge
//   function's environment automatically, so this file needs no new secret created
//   anywhere. That is the whole reason it is fourteen lines of work wrapped in a
//   guard.
//
// WHAT IT DECIDES, AND IT IS ONLY ONE THING: force.
//
//   `/transactions/sync` is a cursor delta — it returns what the bank has already
//   posted and is cheap to call often. That is the routine pull, and it runs every
//   tick.
//
//   `/transactions/refresh` nudges the BANK to go and look, and Plaid rate-limits it.
//   It runs only when somebody asked, which is what `refresh_requested_at` records
//   (supabase/schema_v39_bank_refresh.sql, and finance.refresh_bank on the write
//   door). A request is outstanding while it is NEWER than the connection's last good
//   sync, so nothing here clears a flag: the sync landing past it is what retires it,
//   which means there is no clearing write to race and no row a crash can leave
//   pending forever.
//
// IT WRITES NOTHING ITSELF. Every row that moves is moved by `plaid`, inside its own
// reconcile, which is the code the app has always used. A second writer against the
// ledger is the drift this whole bridge exists to avoid.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { safeEqual } from "../_shared/muse/safeEqual.ts";
import { recordRun } from "../_shared/jobRun.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN = Deno.env.get("CRON_TOKEN") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

/** Is a refresh outstanding on any connection? Newer-than-last-sync is the test.
 *  A row we cannot read is treated as NOT outstanding: the routine pull still runs,
 *  and the worst case is that an asked-for refresh waits for the next tick. */
async function refreshAsked(): Promise<boolean> {
  const { data, error } = await admin
    .from("bank_connections")
    .select("last_sync_at, refresh_requested_at");
  if (error) {
    // Includes the case where schema_v39 has not been run and the column does not
    // exist. Logged, not fatal — the routine sync below is the part that matters.
    console.warn("cron-bank-sync: could not read refresh requests:", error.message);
    return false;
  }
  return (data ?? []).some((r) => {
    if (typeof r.refresh_requested_at !== "string") return false;
    const asked = Date.parse(r.refresh_requested_at);
    if (!Number.isFinite(asked)) return false;
    const synced = typeof r.last_sync_at === "string" ? Date.parse(r.last_sync_at) : NaN;
    return !Number.isFinite(synced) || asked > synced;
  });
}

Deno.serve(async (req) => {
  // Fail CLOSED: a missing or empty CRON_TOKEN denies everything. It never opens the
  // function up, and the comparison is length-independent so a wrong token cannot be
  // recovered by timing.
  if (!TOKEN || !safeEqual(new URL(req.url).searchParams.get("token") ?? "", TOKEN)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!SERVICE_KEY) {
    // Cannot happen on the platform, which injects it — but a local run without it
    // would otherwise call `plaid` with an empty bearer and get a 401 it could not
    // explain.
    console.error("cron-bank-sync: no service role key in the environment");
    return new Response("misconfigured", { status: 500 });
  }

  const force = await refreshAsked();
  return await recordRun(admin, "cron-bank-sync", async () => {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/plaid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ action: "sync", force }),
    });
    // The body is not forwarded to the caller. pg_cron is the caller and reads
    // nothing; a bank's own error text and a list of merchant names have no business
    // in an HTTP response that a misconfigured job could point anywhere.
    if (!res.ok) {
      console.error("cron-bank-sync: plaid answered", res.status);
      return {
        ok: false,
        detail: { forced: force, plaid_status: res.status },
        result: new Response(JSON.stringify({ ok: false, forced: force, plaid: res.status }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    // WHAT THE SYNC ACTUALLY MOVED, which is the point of recording the run at all.
    // "It ran" and "it did anything" are different claims, and the failure this whole
    // table exists for — months with no bank pull — would have looked like a run that
    // kept succeeding while the ledger stopped moving.
    //
    // NUMBERS ONLY, and that is the same rule the comment above states about the
    // response body: a bank's error text and a list of merchant names have no
    // business leaving this function. Filtering by TYPE rather than by field name
    // keeps that true even if the sync's shape changes underneath.
    return {
      ok: true,
      detail: { forced: force, ...(await countsFrom(res)) },
      result: new Response(JSON.stringify({ ok: true, forced: force }), {
        headers: { "Content-Type": "application/json" },
      }),
    };
  } catch (e) {
    console.error("cron-bank-sync failed:", String((e as Error)?.message ?? e));
    return {
      ok: false,
      detail: { forced: force, threw: true },
      result: new Response(JSON.stringify({ ok: false, forced: force }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  });
});

/**
 * The numeric half of the sync's own answer, per connection, and nothing else.
 *
 * Reading the body here is not a contradiction of "the body is not forwarded": it is
 * read, reduced to counts, and stored where only the service role can see it. What
 * never leaves is the text — descriptors, merchant names, a bank's error prose.
 */
async function countsFrom(res: Response): Promise<Record<string, number>> {
  try {
    const body = await res.json();
    const per = Array.isArray(body?.synced) ? body.synced : [];
    const totals: Record<string, number> = { connections: per.length, failed: 0 };
    for (const one of per) {
      if (one && typeof one === "object") {
        if ("error" in one) totals.failed += 1;
        for (const [k, v] of Object.entries(one)) {
          if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
        }
      }
    }
    return totals;
  } catch {
    // A body that will not parse is not a reason to fail a sync that worked.
    return {};
  }
}
