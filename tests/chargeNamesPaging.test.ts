// The one whole-ledger read on the write door, against a stand-in for PostgREST.
//
// ADDED 2026-10-09 with finance.learn_merchant's "does any charge carry this key?".
// That question is only worth asking if the answer covers EVERY charge: a read that
// PostgREST silently capped at 1,000 rows would have the door tell him "this rule
// matches nothing yet" about a rule that matches charges it simply never read — the
// same false all-clear the rest of the door's paging exists to prevent.
//
// dbFinanceSupabase.ts imports supabase-js only as a TYPE, so it loads here, and the
// client it is handed is a small fake that behaves like PostgREST where it matters:
// it orders, it ranges, it counts on the same filter, and it can be made to trim a
// page, move under the reader, or fail.

import { describe, expect, it } from "vitest";
import { financeDb } from "../supabase/functions/muse-write/dbFinanceSupabase.ts";

interface Row {
  id: string;
  date: string;
  type: "income" | "expense";
  description: string;
  raw_description: string;
}

interface Call {
  table: string;
  cols: string;
  count: string | null;
  eq: [string, unknown][];
  order: [string, boolean][];
  range: [number, number];
}

function ledger(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      // Many rows share a date, which is the case where ordering by date alone could
      // skip or repeat a row across a page boundary.
      date: `2026-0${1 + (i % 9)}-1${i % 10}`,
      type: i % 7 === 0 ? "income" : "expense",
      description: `MERCHANT ${i}`,
      raw_description: `CHECKCARD 0101 MERCHANT ${i} XXXX1234`,
    });
  }
  return rows;
}

function fakeAdmin(rows: Row[], opts: { serverCap?: number; grow?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Partial<Call> & { eq: [string, unknown][]; order: [string, boolean][] } = { table, eq: [], order: [] };
      const b = {
        select(cols: string, o?: { count?: string }) {
          call.cols = cols;
          call.count = o?.count ?? null;
          return b;
        },
        eq(col: string, v: unknown) {
          call.eq.push([col, v]);
          return b;
        },
        order(col: string, o?: { ascending?: boolean }) {
          call.order.push([col, o?.ascending ?? true]);
          return b;
        },
        range(from: number, to: number) {
          call.range = [from, to];
          calls.push(call as Call);
          if (opts.fail) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
          // A write lands between the first page and the second.
          if (opts.grow && calls.length === 2) {
            rows.push({ ...rows[1], id: "ffffffff-0000-0000-0000-000000000000", date: "2026-12-31" });
          }
          let out = rows.filter((r) => call.eq.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v));
          const count = out.length;
          out = [...out].sort((a, b2) => {
            for (const [col, asc] of call.order) {
              const x = String((a as unknown as Record<string, unknown>)[col]);
              const y = String((b2 as unknown as Record<string, unknown>)[col]);
              if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          let page = out.slice(from, to + 1);
          if (opts.serverCap) page = page.slice(0, opts.serverCap);
          // Only the columns asked for, the way PostgREST answers.
          const asked = (call.cols ?? "").split(",").map((s) => s.trim());
          const data = page.map((r) => Object.fromEntries(asked.map((c) => [c, (r as unknown as Record<string, unknown>)[c]])));
          return Promise.resolve({ data, error: null, count: call.count ? count : null });
        },
      };
      return b;
    },
  };
  return { admin, calls };
}

describe("chargeNames reads every charge, in a total order, or nothing", () => {
  it("pages past PostgREST's 1,000-row cap and returns each charge exactly once", async () => {
    const rows = ledger(2400);
    const { admin, calls } = fakeAdmin(rows, { serverCap: 1000 });
    const names = await financeDb(admin as never).chargeNames();
    const expected = rows.filter((r) => r.type === "expense").map((r) => r.description);
    expect(names.length).toBe(expected.length);
    expect(new Set(names).size).toBe(expected.length);
    expect([...names].sort()).toEqual([...expected].sort());
    // Several pages, each a short stride under the server's own cap.
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) {
      expect(c.range[1] - c.range[0] + 1).toBeLessThan(1000);
    }
  });

  it("orders by date AND id, so equal dates cannot slip across a page boundary", async () => {
    const { admin, calls } = fakeAdmin(ledger(30));
    await financeDb(admin as never).chargeNames();
    for (const c of calls) expect(c.order).toEqual([["date", false], ["id", true]]);
  });

  it("asks for the clean name and the id only — never raw_description — and only money out", async () => {
    const { admin, calls } = fakeAdmin(ledger(30));
    await financeDb(admin as never).chargeNames();
    for (const c of calls) {
      expect(c.table).toBe("transactions");
      expect(c.cols).toBe("id, description");
      expect(c.cols).not.toContain("raw_description");
      expect(c.eq).toEqual([["type", "expense"]]);
      expect(c.count).toBe("exact");
    }
  });

  it("stops on the first short page, including an empty one after an exact multiple", async () => {
    // 1,000 charges and no deposits: two full pages, then an empty one that ends it.
    const rows = ledger(1000).map((r) => ({ ...r, type: "expense" as const }));
    const { admin, calls } = fakeAdmin(rows);
    const names = await financeDb(admin as never).chargeNames();
    expect(names.length).toBe(1000);
    expect(calls.map((c) => c.range[0])).toEqual([0, 500, 1000]);
  });

  it("throws when a page comes back trimmed — a short page is never mistaken for the end", async () => {
    const { admin } = fakeAdmin(ledger(900), { serverCap: 100 });
    await expect(financeDb(admin as never).chargeNames()).rejects.toThrow(/rows exist and \d+ came back/);
  });

  it("throws when the ledger moves while it is being read", async () => {
    const { admin } = fakeAdmin(ledger(1200), { grow: true });
    await expect(financeDb(admin as never).chargeNames()).rejects.toThrow(/changed while it was read/);
  });

  it("throws on an error rather than answering with an empty list", async () => {
    const { admin } = fakeAdmin(ledger(10), { fail: true });
    await expect(financeDb(admin as never).chargeNames()).rejects.toThrow(/read charge names: boom/);
  });
});
