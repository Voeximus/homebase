// Every path that syncs the bank says so in job_runs, in numbers only.
//
// FOUND 2026-10-09. A forced refresh's cron-bank-sync run recorded posted 0 / pending 0,
// and five rows landed two seconds later through plaid-webhook — which wrote no
// job_runs row at all. Across 715 cron runs the log summed posted 1 while 45 rows had
// arrived. Most charges reach the ledger through the bank's own push, so a log of the
// quarter-hour pull alone read like a feed that had stopped while it was working.
//
// plaid-webhook's handler now takes its client, fetch and push sender as parameters
// (plaid-webhook/handle.ts), which is what lets these tests drive it with fakes.
import { describe, expect, it } from "vitest";
import { countsFrom, syncCounts } from "../supabase/functions/_shared/syncCounts.ts";
import { handleWebhook, type PushMessage } from "../supabase/functions/plaid-webhook/handle.ts";
import { WATCHED_JOBS } from "../supabase/functions/_shared/muse/heartbeat.ts";

const TOKEN = "test-webhook-token";

/** The sync's answer for one connection, as plaid's syncConnection returns it. */
const SYNC_ANSWER = {
  posted: 3,
  pending: 2,
  reversed: 1,
  absorbed: 0,
  newRows: [
    { description: "Firestone", amount: 412.5, pending: false },
    { description: "Corner Bakery", amount: 8.5, pending: true },
  ],
};

/** Just enough of a Supabase client for recordRun and the connection lookup. */
function fakeAdmin(opts: { conn?: { id: string } | null; connErr?: string } = {}) {
  const opened: Record<string, unknown>[] = [];
  const closed: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table === "job_runs") {
        return {
          insert(row: Record<string, unknown>) {
            opened.push({ ...row });
            return { select: () => ({ single: async () => ({ data: { id: `run-${opened.length}` }, error: null }) }) };
          },
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_col: string, id: string) => {
                closed.push({ id, ...patch });
                return { error: null };
              },
            };
          },
        };
      }
      if (table === "bank_connections") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.conn === undefined ? { id: "conn-1" } : opts.conn,
                error: opts.connErr ? { message: opts.connErr } : null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { admin, opened, closed };
}

function run(
  body: unknown,
  opts: {
    admin?: ReturnType<typeof fakeAdmin>;
    token?: string;
    answer?: Response;
    pushThrows?: boolean;
  } = {},
) {
  const db = opts.admin ?? fakeAdmin();
  const pushes: PushMessage[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const req = new Request(`https://example.test/plaid-webhook?token=${opts.token ?? TOKEN}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const done = handleWebhook(req, {
    admin: db.admin,
    token: TOKEN,
    supabaseUrl: "https://project.example.test",
    serviceKey: "service-key",
    appUrl: "https://app.example.test/",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return opts.answer ?? new Response(JSON.stringify(SYNC_ANSWER), { status: 200 });
    },
    sendPush: async (_admin, payload) => {
      if (opts.pushThrows) throw new Error("push service down");
      pushes.push(payload);
      return { sent: 1 };
    },
  });
  return { done, db, pushes, calls };
}

const PING = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" };

describe("plaid-webhook records the syncs it triggers", () => {
  it("writes a 'plaid-webhook' job_runs row with the sync's counts", async () => {
    const { done, db, calls } = run(PING);
    const res = await done;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: "sync", connection_id: "conn-1" });

    expect(db.opened).toEqual([{ job: "plaid-webhook" }]);
    expect(db.closed).toHaveLength(1);
    expect(db.closed[0].ok).toBe(true);
    expect(db.closed[0].detail).toEqual({ connections: 1, failed: 0, posted: 3, pending: 2, reversed: 1, absorbed: 0 });
  });

  it("records numbers only — no merchant name from newRows reaches the row", async () => {
    const { done, db, pushes } = run(PING);
    await done;
    const stored = JSON.stringify(db.closed);
    expect(stored).not.toContain("Firestone");
    expect(stored).not.toContain("Bakery");
    for (const v of Object.values(db.closed[0].detail as Record<string, unknown>)) expect(typeof v).toBe("number");
    // The phone still gets its notification, which is where the names belong.
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toContain("2 charges");
  });

  it("records a failed sync as a failure, without the bank's error text", async () => {
    const answer = new Response(JSON.stringify({ error: "plaid /transactions/sync 400: ITEM_LOGIN_REQUIRED for Bank of America" }), {
      status: 500,
    });
    const { done, db, pushes } = run(PING, { answer });
    const res = await done;
    expect(res.status).toBe(200); // Plaid still gets its fast 200
    expect(db.closed[0].ok).toBe(false);
    expect(db.closed[0].detail).toEqual({ plaid_status: 500 });
    expect(JSON.stringify(db.closed)).not.toMatch(/ITEM_LOGIN|Bank of America/);
    expect(pushes).toHaveLength(0);
  });

  it("records a lookup that failed as a failure, not as an item we do not have", async () => {
    const { done, db } = run(PING, { admin: fakeAdmin({ connErr: "connection refused" }) });
    await done;
    expect(db.closed[0].ok).toBe(false);
    expect(db.closed[0].detail).toEqual({ threw: true });
  });

  it("records a ping for an item that is not ours as a run that moved nothing", async () => {
    const { done, db, calls } = run(PING, { admin: fakeAdmin({ conn: null }) });
    await done;
    expect(calls).toHaveLength(0);
    expect(db.closed[0].ok).toBe(true);
    expect(db.closed[0].detail).toEqual({ connections: 0 });
  });

  it("a failed push does not turn a sync that worked into a failure", async () => {
    const { done, db } = run(PING, { pushThrows: true });
    const res = await done;
    expect(res.status).toBe(200);
    expect(db.closed[0].ok).toBe(true);
  });

  it("leaves no row for a ping that did no work", async () => {
    for (const body of [
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-1" },
      { webhook_type: "TRANSACTIONS", webhook_code: "SOMETHING_ELSE", item_id: "item-1" },
      { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" },
      "not json",
    ]) {
      const { done, db } = run(body);
      expect((await done).status).toBe(200);
      expect(db.opened).toHaveLength(0);
    }
    const { done, db } = run(PING, { token: "wrong" });
    expect((await done).status).toBe(403);
    expect(db.opened).toHaveLength(0);
  });

  it("is not watched by the heartbeat — it runs when the bank speaks, not on a clock", () => {
    expect(Object.keys(WATCHED_JOBS)).not.toContain("plaid-webhook");
  });
});

describe("syncCounts — one reduction for both callers", () => {
  it("sums cron-bank-sync's every-connection answer, as before", () => {
    const body = {
      synced: [
        { id: "conn-1", posted: 1, pending: 2, reversed: 0, absorbed: 0, newRows: [{ description: "Hardware Store", amount: 40 }] },
        { id: "conn-2", error: "plaid /transactions/sync 400: bank prose" },
      ],
    };
    expect(syncCounts(body)).toEqual({ connections: 2, failed: 1, posted: 1, pending: 2, reversed: 0, absorbed: 0 });
  });

  it("counts the webhook's one-connection answer as a list of one", () => {
    // This shape was counted as NO connections at all before the webhook needed it.
    expect(syncCounts(SYNC_ANSWER)).toEqual({ connections: 1, failed: 0, posted: 3, pending: 2, reversed: 1, absorbed: 0 });
  });

  it("keeps no text, whatever the shape", () => {
    expect(JSON.stringify(syncCounts({ synced: [{ error: "secret prose", name: "Merchant" }] }))).not.toMatch(/prose|Merchant/);
    expect(syncCounts(null)).toEqual({ connections: 0, failed: 0 });
  });

  it("countsFrom reads the response, and a body that will not parse is no reason to fail", async () => {
    expect(await countsFrom(new Response(JSON.stringify({ synced: [{ posted: 4 }] })))).toEqual({
      connections: 1,
      failed: 0,
      posted: 4,
    });
    expect(await countsFrom(new Response("<html>"))).toEqual({});
  });
});
