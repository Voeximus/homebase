// readPages — a caller-built query, read whole, or not at all.
//
// FOUND 2026-10-09. cron-notify decided which bills were "already paid" from ONE bare
// select of every charge attached to something: no order, no range, and the error
// thrown away. PostgREST caps that at 1,000 rows without a word, and that set only grows,
// so past the cap a paid bill whose payment fell outside the returned 1,000 was pinged as
// due tonight. And a failed read came back as `data: null`, which `paid ?? []` turned into
// "nothing has been paid" — every bill due, said confidently, on a day the read failed.
//
// readPages is the loop that replaces it: pages below the server's cap until a short
// one, and an error is thrown, never read as an empty list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LedgerUnreadable, MAX_ROWS, PAGE, readPages } from "../supabase/functions/_shared/muse/paging.ts";

type Row = { id: string };

/** A server holding `n` rows in a stable order, capping every response at `cap` the way
 *  PostgREST does — so a caller that asked for more than the cap gets a page that LOOKS
 *  complete and is not. */
function server(n: number, cap = 1000) {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(6, "0")}` }));
  const asked: [number, number][] = [];
  const page = (from: number, to: number) => {
    asked.push([from, to]);
    const want = Math.min(to - from + 1, cap);
    return Promise.resolve({ data: rows.slice(from, from + want), error: null });
  };
  return { rows, asked, page };
}

describe("readPages", () => {
  it("reads every row of a set far past the 1,000-row cap", async () => {
    const s = server(2_345);
    const got = await readPages("transactions", s.page);
    expect(got).toHaveLength(2_345);
    expect(got.map((r) => r.id)).toEqual(s.rows.map((r) => r.id));
  });

  it("asks for pages below the server's own cap, so a short page is the real end", async () => {
    const s = server(1_200);
    await readPages("transactions", s.page);
    for (const [from, to] of s.asked) expect(to - from + 1).toBe(PAGE);
    expect(PAGE).toBeLessThan(1000);
    // 500, 500, then a short 200 — and it stops there rather than asking again.
    expect(s.asked).toEqual([[0, 499], [500, 999], [1000, 1499]]);
  });

  it("stops on an exact multiple of the page with one empty page, not a loop", async () => {
    const s = server(PAGE * 2);
    const got = await readPages("transactions", s.page);
    expect(got).toHaveLength(PAGE * 2);
    expect(s.asked).toHaveLength(3);
  });

  it("returns an empty list only when the server said there were no rows", async () => {
    const got = await readPages("transactions", server(0).page);
    expect(got).toEqual([]);
  });

  it("THROWS on an error — a failed read is never 'nothing has been paid'", async () => {
    const page = () => Promise.resolve({ data: null, error: { message: "permission denied for table transactions" } });
    await expect(readPages("transactions", page)).rejects.toBeInstanceOf(LedgerUnreadable);
    await expect(readPages("transactions", page)).rejects.toThrow(/permission denied/);
  });

  it("throws when an error arrives on a LATER page, rather than keeping the first", async () => {
    let calls = 0;
    const page = (from: number) => {
      calls++;
      return Promise.resolve(
        from === 0
          ? { data: Array.from({ length: PAGE }, (_, i) => ({ id: String(i) })), error: null }
          : { data: null, error: { message: "canceling statement due to statement timeout" } },
      );
    };
    await expect(readPages("transactions", page)).rejects.toThrow(/statement timeout/);
    expect(calls).toBe(2);
  });

  it("throws when the request itself rejects", async () => {
    const page = () => Promise.reject(new Error("fetch failed"));
    await expect(readPages("transactions", page)).rejects.toThrow(/fetch failed/);
  });

  it("refuses a set bigger than MAX_ROWS rather than spending the function's budget", async () => {
    const page = (from: number, to: number) =>
      Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: String(from + i) })), error: null });
    await expect(readPages("transactions", page)).rejects.toThrow(new RegExp(String(MAX_ROWS)));
  });
});

describe("cron-notify reads bill payments through readPages", () => {
  // The function is a Deno entry point (Deno.serve, jsr: imports), so it cannot be
  // imported here. What CAN be pinned is that the read which decides "already paid" goes
  // through the tested loop, in a total order, and that every read in the bills half
  // checks its error — the two things that were missing.
  const src = readFileSync("supabase/functions/cron-notify/index.ts", "utf8");
  // Comments out, so the explanation of the old bug cannot satisfy or trip the check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("pages the transactions read in a total order", () => {
    const at = code.indexOf('readPages<Row>("transactions"');
    expect(at, "the bill-payment read does not go through readPages").toBeGreaterThan(-1);
    const call = code.slice(at, code.indexOf(");", at));
    expect(call).toContain(".range(from, to)");
    expect(call).toMatch(/\.order\("date", \{ ascending: false \}\)\s*\.order\("id"/);
  });

  it("has no bare select on transactions left", () => {
    // Every .from("transactions") in the file is inside the readPages call.
    const bare = [...code.matchAll(/\.from\("transactions"\)/g)].length;
    expect(bare).toBe(1);
  });

  it("checks the error on the recurring and debts reads instead of reading null as empty", () => {
    expect(code).toMatch(/error: recsErr[\s\S]*if \(recsErr\) throw/);
    expect(code).toMatch(/error: debtsErr[\s\S]*if \(debtsErr\) throw/);
  });
});
