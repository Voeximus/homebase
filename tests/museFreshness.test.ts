// How old is the answer — tested on its own, because it is on EVERY reply.
//
// The freshness stamp is the one thing in the read door that is not a tool: it is
// stamped once in handler.ts onto every successful answer. So a mistake in it is a
// mistake in all of them at once, which is the argument for testing it here as
// arithmetic and wording rather than only through a door.
//
// THREE THINGS THIS FILE IS ACTUALLY GUARDING, and each one is a real failure shape:
//
//   1. Rounding direction. `minutesSince` floors, and `sayAge` floors the unit
//      below — so the age always reads OLDER than it is, never newer. A stamp that
//      says "less than a minute ago" about a 91-minute-old sync is the exact bug
//      the stamp exists to prevent, wearing the stamp's clothes.
//   2. The needs_reauth case beating a recent sync. Two connections, one frozen and
//      one syncing fine, is how a stale balance hides: the healthy one keeps
//      last_sync_at current while the frozen one's accounts sit where they were.
//      The sentence has to lead with the frozen one.
//   3. No stored string in the sentence. `says` goes out on every reply, and the
//      strings on a bank_connections row (institution, status, last_error) are
//      written by the bank, not by us. Rule 4 scrubs every outbound string; the
//      stamp's answer to Rule 4 is to carry none, which is checkable.

import { describe, expect, it } from "vitest";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler.ts";
import { TOOLS } from "../supabase/functions/_shared/muse/tools.ts";
import type { Db, DbRow } from "../supabase/functions/_shared/muse/paging.ts";
import {
  BANK_STALE_MIN,
  REFRESH_COOLDOWN_MIN,
  REFRESH_TICK_MIN,
  freshnessOf,
  freshnessUnknown,
  refreshDecision,
  sayAge,
  type FreshConnection,
} from "../supabase/functions/_shared/muse/freshness.ts";

/** A real instant, not an Arizona-fields Date — the same thing handler.ts hands in.
 *  Getting this wrong is a seven-hour error on the machine the doors run on, which
 *  is why the handler takes both halves out of clockNow() rather than re-deriving
 *  one from the other. */
const NOW = new Date("2026-09-27T15:40:00.000Z");

/** A stored timestamptz `minutes` before NOW, spelled the way PostgREST spells it. */
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const conn = (over: Partial<FreshConnection> = {}): FreshConnection => ({
  status: "ok",
  lastSyncAt: ago(4),
  refreshRequestedAt: null,
  ...over,
});

describe("sayAge rounds towards older, always", () => {
  it("never calls something recent that is not", () => {
    expect(sayAge(0)).toBe("less than a minute ago");
    expect(sayAge(1)).toBe("less than a minute ago");
    expect(sayAge(2)).toBe("2 minutes ago");
    expect(sayAge(89)).toBe("89 minutes ago");
  });

  it("crosses to hours and days without ever rounding up", () => {
    // 90 → "1 hours" reads badly and is TRUE; 119 must not become 2.
    expect(sayAge(90)).toBe("1 hours ago");
    expect(sayAge(119)).toBe("1 hours ago");
    expect(sayAge(120)).toBe("2 hours ago");
    // 47h59m is still hours; 48h is the day boundary.
    expect(sayAge(48 * 60 - 1)).toBe("47 hours ago");
    expect(sayAge(48 * 60)).toBe("2 days ago");
    expect(sayAge(71 * 60)).toBe("2 days ago");
    expect(sayAge(72 * 60)).toBe("3 days ago");
  });
});

describe("the stamp on a healthy feed", () => {
  it("reports the NEWEST sync across the connections", () => {
    const f = freshnessOf([conn({ lastSyncAt: ago(40) }), conn({ lastSyncAt: ago(6) })], NOW);
    expect(f.bank_synced_minutes_ago).toBe(6);
    expect(f.bank_last_sync_at).toBe(ago(6));
    expect(f.says).toContain("6 minutes ago");
    expect(f.needs_reauth).toBe(false);
    expect(f.refresh_pending).toBe(false);
  });

  it("says nothing alarming inside the stale window", () => {
    const f = freshnessOf([conn({ lastSyncAt: ago(BANK_STALE_MIN - 1) })], NOW);
    expect(f.says).toContain("Current as of");
    expect(f.says).not.toContain("older than it should be");
  });

  it("calls it old at the stale window, and names where to look", () => {
    const f = freshnessOf([conn({ lastSyncAt: ago(BANK_STALE_MIN) })], NOW);
    expect(f.says).toContain("older than it should be");
    expect(f.says).toContain("finance.bank_status");
    expect(f.says).toContain(String(REFRESH_TICK_MIN));
  });
});

describe("the cases that hide a stale number", () => {
  it("leads with needs_reauth even when another connection synced a moment ago", () => {
    const f = freshnessOf(
      [conn({ status: "needs_reauth", lastSyncAt: ago(4000) }), conn({ lastSyncAt: ago(2) })],
      NOW,
    );
    expect(f.needs_reauth).toBe(true);
    expect(f.says).toContain("needs re-authorising");
    // The reassuring two-minute age must NOT be the sentence.
    expect(f.says).not.toContain("Current as of");
  });

  it("does not pretend a never-synced connection is current", () => {
    const f = freshnessOf([conn({ lastSyncAt: null })], NOW);
    expect(f.bank_synced_minutes_ago).toBeNull();
    expect(f.says).toContain("unconfirmed");
  });

  it("ignores a timestamp it cannot read rather than treating it as now", () => {
    // A value with no zone on the end is one whose zone we would have to guess.
    const f = freshnessOf([conn({ lastSyncAt: "2026-09-27 08:30:00" })], NOW);
    expect(f.bank_synced_minutes_ago).toBeNull();
    expect(f.says).toContain("unconfirmed");
  });

  it("says there is no feed when there are no connections, and does not call that stale", () => {
    const f = freshnessOf([], NOW);
    expect(f.says).toContain("no bank feed connected");
    expect(f.says).not.toContain("older than it should be");
    expect(f.bank_synced_minutes_ago).toBeNull();
  });
});

describe("an outstanding refresh", () => {
  it("is pending while the ask is newer than the sync", () => {
    const f = freshnessOf([conn({ lastSyncAt: ago(30), refreshRequestedAt: ago(3) })], NOW);
    expect(f.refresh_pending).toBe(true);
    expect(f.says).toContain("has not landed yet");
  });

  it("retires itself once a sync lands past it — nothing is cleared", () => {
    const f = freshnessOf([conn({ lastSyncAt: ago(2), refreshRequestedAt: ago(9) })], NOW);
    expect(f.refresh_pending).toBe(false);
    expect(f.says).not.toContain("has not landed yet");
  });

  it("is pending when a connection has never synced at all", () => {
    const f = freshnessOf([conn({ lastSyncAt: null, refreshRequestedAt: ago(1) })], NOW);
    expect(f.refresh_pending).toBe(true);
  });
});

describe("the cooldown", () => {
  it("allows the first ask and refuses to call it done", () => {
    const d = refreshDecision([conn()], NOW);
    expect(d.allowed).toBe(true);
    expect(d.wait_minutes).toBe(0);
    expect(d.says).toContain("NOT instant");
    expect(d.says).toContain("has not moved yet");
  });

  it("refuses inside the window and says how long is left", () => {
    const d = refreshDecision([conn({ refreshRequestedAt: ago(3) })], NOW);
    expect(d.allowed).toBe(false);
    expect(d.wait_minutes).toBe(REFRESH_COOLDOWN_MIN - 3);
    expect(d.says).toContain("already asked for");
  });

  it("allows it again exactly at the window, not a minute before", () => {
    expect(refreshDecision([conn({ refreshRequestedAt: ago(REFRESH_COOLDOWN_MIN - 1) })], NOW).allowed)
      .toBe(false);
    expect(refreshDecision([conn({ refreshRequestedAt: ago(REFRESH_COOLDOWN_MIN) })], NOW).allowed)
      .toBe(true);
  });

  it("measures from the ASK, not from the sync — a connection that never lands is still capped", () => {
    // Asked 2 minutes ago, and no sync has ever succeeded. Measuring from
    // last_sync_at would leave this askable forever.
    const d = refreshDecision([conn({ lastSyncAt: null, refreshRequestedAt: ago(2) })], NOW);
    expect(d.allowed).toBe(false);
  });

  it("refuses when there is no bank to refresh, without a cooldown sentence", () => {
    const d = refreshDecision([], NOW);
    expect(d.allowed).toBe(false);
    expect(d.says).toContain("no bank connected");
    expect(d.says).not.toContain("Wait about");
  });
});

describe("Rule 4 — the stamp carries no string anybody else wrote", () => {
  const nasty: FreshConnection[] = [
    {
      status: "needs_reauth",
      lastSyncAt: ago(5),
      refreshRequestedAt: ago(1),
    },
    {
      // A status the app has never written, in case one arrives from a provider.
      status: "ITEM_LOGIN_REQUIRED <script>",
      lastSyncAt: ago(500),
      refreshRequestedAt: null,
    },
  ];

  it("never puts a status word into the sentence", () => {
    const f = freshnessOf(nasty, NOW);
    expect(f.says).not.toContain("script");
    expect(f.says).not.toContain("ITEM_LOGIN_REQUIRED");
  });

  it("carries no character a scrubber would have to strip", () => {
    // Stated as the negative on purpose: the claim is not "the sentence looks tidy",
    // it is "nothing in it could have come from a string somebody else wrote". The
    // markup and interpolation characters are the ones that matter.
    const dangerous = /[<>{}[\]\\`$|]/;
    for (const says of [
      freshnessOf(nasty, NOW).says,
      freshnessOf([], NOW).says,
      freshnessUnknown().says,
      refreshDecision(nasty, NOW).says,
      refreshDecision([conn()], NOW).says,
    ]) {
      expect(says).not.toMatch(dangerous);
    }
  });
});

describe("the unknown stamp", () => {
  it("says it does not know instead of implying the feed is fresh", () => {
    const f = freshnessUnknown();
    expect(f.bank_synced_minutes_ago).toBeNull();
    expect(f.bank_last_sync_at).toBeNull();
    expect(f.says).toContain("do not know how current this is");
    // And it must not read as an outage: the figures themselves were read whole.
    expect(f.says).toContain("read whole");
  });
});

// ── through the real door ─────────────────────────────────────────────────────
//
// The block above tests the judgement. This one tests that it is actually ATTACHED,
// which is the part a refactor breaks silently: the stamp is applied at one line in
// handler.ts, and a tool that somehow answered around that line would go out with no
// age on it and read as current.
//
// So this walks the door's OWN catalogue rather than a list typed here. A tool added
// next week is in this test the moment it is in TOOLS, and a tool that stops carrying
// the stamp fails here rather than being noticed in a chat.

const SECRET = "gino-read-secret-that-is-long-enough-1234";

/** Rows enough for every tool to answer something. The figures do not matter here —
 *  what matters is that a reply comes back 200 and carries the stamp. */
const tablesWith = (connections: DbRow[]): Record<string, DbRow[]> => ({
  accounts: [{ id: "a1", name: "Checking", owner: "Gino", type: "checking", balance: "100.00", sort_order: 1, created_at: "2026-01-01T00:00:00Z" }],
  transactions: [{ id: "t1", date: "2026-09-20", amount: "42.00", type: "expense", category_id: "groceries", description: "Store", account_id: "a1", created_at: "2026-09-20T12:00:00Z" }],
  recurring: [],
  debts: [],
  savings_goals: [],
  paid_bills: [],
  merchant_rules: [],
  body_weights: [],
  meal_days: [],
  macro_targets: [],
  workouts: [],
  workout_routines: [],
  reminders: [],
  pending_preview: [],
  muse_undo: [],
  bank_connections: connections,
});

const bankRow = (over: Partial<DbRow> = {}): DbRow => ({
  id: "c1",
  owner: "Joint",
  institution: "A Bank",
  status: "ok",
  last_sync_at: ago(6),
  last_error: null,
  consecutive_failures: 0,
  ...over,
});

function fakeDb(tables: Record<string, DbRow[]>): Db {
  return {
    select({ table, orderBy, eq }) {
      const rows = () =>
        (tables[table] ?? [])
          .filter((r) => Object.entries(eq ?? {}).every(([k, v]) => String(r[k]) === v))
          .slice()
          .sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      return { count: async () => rows().length, page: async (from, to) => rows().slice(from, to + 1) };
    },
  };
}

const deps = (tables: Record<string, DbRow[]>) => ({
  db: fakeDb(tables),
  secrets: { gino: SECRET, xinyan: "xinyan-read-secret-that-is-long-enough-1234" },
  // The same instant the stamp is measured against, handed in rather than read —
  // Rule 2. `ago()` above is relative to NOW, so the two agree by construction.
  at: NOW,
  baseUrl: "https://example.test/functions/v1/muse-read",
  audit: { record: async () => {} },
  limit: { bump: async () => 1 },
});

/** A value for one declared argument. Named cases first, then the type, so a new
 *  tool with a new argument gets something plausible instead of a 400. */
function stub(name: string, type: string): unknown {
  if (name === "from") return "2026-09-01";
  if (name === "to") return "2026-09-30";
  if (name === "month") return "2026-09";
  if (name === "id") return "t1";
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return false;
  return "x";
}

const callTool = async (t: { name: string; args?: readonly { name: string; type: string; required: boolean }[] }, tables: Record<string, DbRow[]>) => {
  const body: Record<string, unknown> = {};
  for (const a of t.args ?? []) if (a.required) body[a.name] = stub(a.name, a.type);
  const res = await handleMuseRead(
    new Request(`https://example.test/functions/v1/muse-read/${t.name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    deps(tables),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("the stamp is on every reply the read door gives", () => {
  it("stamps every tool in the door's own catalogue", async () => {
    const tables = tablesWith([bankRow()]);
    const unstamped: string[] = [];
    const undriven: string[] = [];
    for (const t of TOOLS) {
      const { status, body } = await callTool(t, tables);
      if (status !== 200) {
        // Not evidence either way about the stamp — but it IS a gap in this sweep,
        // and the assertion below refuses to let the sweep quietly shrink. The
        // message carries what the door said, so whoever adds the next tool can fix
        // `stub()` above in one look instead of debugging this file.
        undriven.push(`${t.name} → ${status} ${String(body.says ?? body.error ?? "")}`);
        continue;
      }
      const fresh = body.fresh as Record<string, unknown> | undefined;
      if (!fresh || typeof fresh.says !== "string") unstamped.push(t.name);
    }
    expect(unstamped, "these tools answered with no freshness stamp").toEqual([]);
    // EVERY tool in the catalogue must be driven here. A tool added by a later merge
    // that this sweep cannot call is a tool whose reply nothing checks — so the fix is
    // a case in `stub()` or a row in `tablesWith`, never a smaller assertion.
    expect(undriven, "this sweep could not drive these tools — give stub() a case").toEqual([]);
  });

  it("says the real age, not a default", async () => {
    const { body } = await callTool({ name: "finance.position" }, tablesWith([bankRow({ last_sync_at: ago(6) })]));
    const fresh = body.fresh as Record<string, unknown>;
    expect(fresh.bank_synced_minutes_ago).toBe(6);
    expect(fresh.says).toContain("6 minutes ago");
  });

  it("warns on a feed that has stopped, on a tool that has nothing to do with banks", async () => {
    // health.macros_today knows nothing about a bank, and it still has to carry the
    // age: an assistant summarising a day does not branch per tool.
    const { body } = await callTool(
      { name: "health.macros_today" },
      tablesWith([bankRow({ last_sync_at: ago(4 * 24 * 60) })]),
    );
    expect((body.fresh as Record<string, unknown>).says).toContain("4 days ago");
  });

  it("answers, with the age unknown, when the connections table cannot be read", async () => {
    const tables = tablesWith([bankRow()]);
    const broken: Db = {
      select(q) {
        const inner = fakeDb(tables).select(q);
        if (q.table !== "bank_connections") return inner;
        return { count: async () => 1, page: async () => { throw new Error("connections unreachable"); } };
      },
    };
    const res = await handleMuseRead(
      new Request("https://example.test/functions/v1/muse-read/finance.position", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: "{}",
      }),
      { ...deps(tables), db: broken },
    );
    // The FIGURES still came through the paged loader, so the answer stands; only
    // the footnote gives up. This is the one place the door does not fail closed,
    // and it is asserted here so nobody "fixes" it into a refusal by accident.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cash_available ?? body.total ?? body.tool).toBeDefined();
    expect((body.fresh as Record<string, unknown>).says).toContain("do not know how current this is");
  });
});
