// The bank sync's reads of the ledger see every row, in one fixed order, or stop.
//
// FOUND 2026-10-09, reading plaid/index.ts. The duplicate guard paged with .range() and
// no .order(), so Postgres was free to return its rows in a different sequence for each
// page: one row could come back twice and another never, and a row that never came back
// is a duplicate key the guard never armed. The read of rows linked to a bill — which
// decides which bill cycles are already settled — had no paging, no order and no error
// check: past 1,000 rows PostgREST would have truncated it silently, and a failed read
// came back as "nothing is paid". Both now go through readAllPages.
import { describe, expect, it } from "vitest";
import { PAGE, readAllPages } from "../supabase/functions/_shared/readAllPages.ts";

type Call = { order: [string, unknown][]; range?: [number, number] };

/** A fake supabase-js builder over `total` rows, recording what each page asked for. */
function fakeTable(total: number, failOnPage?: number) {
  const calls: Call[] = [];
  const query = () => {
    const call: Call = { order: [] };
    calls.push(call);
    const builder = {
      order(col: string, opts?: unknown) {
        call.order.push([col, opts]);
        return builder;
      },
      range(from: number, to: number) {
        call.range = [from, to];
        if (failOnPage !== undefined && calls.length === failOnPage) {
          return Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } });
        }
        const rows = [];
        for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ id: `row-${i}` });
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return builder;
  };
  return { query, calls };
}

describe("readAllPages", () => {
  it("reads past the 1,000-row cap that PostgREST applies silently", async () => {
    const t = fakeTable(2500);
    const rows = await readAllPages("paid cycles", t.query);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    expect(t.calls.map((c) => c.range)).toEqual([
      [0, PAGE - 1],
      [PAGE, 2 * PAGE - 1],
      [2 * PAGE, 3 * PAGE - 1],
    ]);
  });

  it("asks every page for the same TOTAL order, ending in the primary key", async () => {
    const t = fakeTable(1500);
    await readAllPages("dedup scan", t.query);
    for (const c of t.calls) {
      expect(c.order).toEqual([
        ["date", { ascending: false }],
        ["id", undefined],
      ]);
    }
  });

  it("an exactly-full page is not taken as the end", async () => {
    const t = fakeTable(PAGE);
    expect(await readAllPages("x", t.query)).toHaveLength(PAGE);
    expect(t.calls).toHaveLength(2); // the second, empty page is what proves it ended
  });

  it("throws on an error rather than returning what it had so far", async () => {
    const t = fakeTable(2500, 2);
    await expect(readAllPages("paid cycles", t.query)).rejects.toThrow(/paid cycles: canceling statement/);
  });

  it("throws on an error on the very first page — never 'nothing is paid'", async () => {
    const t = fakeTable(10, 1);
    await expect(readAllPages("paid cycles", t.query)).rejects.toThrow(/paid cycles/);
  });
});
