import { describe, it, expect } from "vitest";
import { PAGE_ROWS, readEveryRow, TableUnreadable, type PagedClient, type PagedQuery } from "../src/lib/pagedRead";

// The paged read both stores load the ledger through (FOUND 2026-10-09: a bare
// select stops at 1,000 rows and says nothing). Driven here by a fake client that
// behaves the way PostgREST does where it matters:
//
//   · it never returns more than 1,000 rows, whatever was asked for;
//   · it breaks a tie in the requested order DIFFERENTLY on every request, which a
//     real database is allowed to do — so a read whose order is not total skips
//     some rows and repeats others, the way it would against the real table.

type Row = { id: string; date: string };
const SERVER_MAX_ROWS = 1000;

/** 2,500 ledger rows, 25 to a day, so newest-first leaves ties everywhere. */
function ledger(n = 2500): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const day = String(1 + (Math.floor(i / 25) % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(i / 700)).padStart(2, "0");
    rows.push({ id: `t${String(i).padStart(5, "0")}`, date: `2026-${month}-${day}` });
  }
  // Inserted out of order, as a real table's physical order would be.
  return rows.sort((a, b) => (a.id.split("").reverse().join("") < b.id.split("").reverse().join("") ? -1 : 1));
}

/** A small deterministic shuffle, so each request breaks ties its own way. */
function jitter(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

interface Call {
  table: string;
  order: [string, boolean][];
  range: [number, number];
}

function fakeClient(
  table: Row[],
  opts: {
    /** 1-based request number that comes back as an error. */
    errorOn?: number;
    /** 1-based request number whose promise rejects outright (network gone). */
    throwOn?: number;
    /** Run before answering request N — the other phone writing mid-read. */
    before?: (n: number, rows: Row[]) => void;
    /** Ignore `.range()` entirely, as a misconfigured server would. */
    ignoreRange?: boolean;
    /** Hand back `data: null` with no error. */
    nullOn?: number;
  } = {},
) {
  const calls: Call[] = [];
  const client: PagedClient = {
    from(t: string) {
      return {
        select() {
          const order: [string, boolean][] = [];
          const q: PagedQuery = {
            order(column, options) {
              order.push([column, options.ascending]);
              return q;
            },
            range(from, to) {
              calls.push({ table: t, order: [...order], range: [from, to] });
              const n = calls.length;
              opts.before?.(n, table);
              if (n === opts.throwOn) return Promise.reject(new Error("Failed to fetch"));
              if (n === opts.errorOn) return Promise.resolve({ data: null, error: { message: "connection reset" } });
              if (n === opts.nullOn) return Promise.resolve({ data: null, error: null });
              const rand = jitter(n * 7919);
              const tiebreak = new Map(table.map((r) => [r.id, rand()]));
              const sorted = [...table].sort((a, b) => {
                for (const [col, asc] of order) {
                  const x = (a as Record<string, string>)[col];
                  const y = (b as Record<string, string>)[col];
                  if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
                }
                return tiebreak.get(a.id)! - tiebreak.get(b.id)!;
              });
              const page = opts.ignoreRange ? sorted : sorted.slice(from, to + 1);
              return Promise.resolve({ data: page.slice(0, SERVER_MAX_ROWS), error: null });
            },
          };
          return q;
        },
      };
    },
  };
  return { client, calls };
}

const newestFirst = (rows: Row[]) =>
  [...rows].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.id < b.id ? -1 : 1));

describe("readEveryRow — the whole table, a page at a time", () => {
  it("reads all 2,500 rows past the 1,000-row cut, each exactly once, newest first", async () => {
    const rows = ledger();
    const { client, calls } = fakeClient(rows);
    const got = await readEveryRow<Row>(client, "transactions", [{ column: "date", ascending: false }]);

    expect(got).toHaveLength(2500);
    expect(new Set(got.map((r) => r.id)).size).toBe(2500);
    expect(got.map((r) => r.id)).toEqual(newestFirst(rows).map((r) => r.id));

    // Pages of 500 (under the server's 1,000), read until one comes back short.
    expect(PAGE_ROWS).toBeLessThan(SERVER_MAX_ROWS);
    expect(calls.map((c) => c.range)).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
      [1500, 1999],
      [2000, 2499],
      [2500, 2999],
    ]);
  });

  it("ends every request's order on id, so ties cannot shuffle rows between pages", async () => {
    const { client, calls } = fakeClient(ledger());
    await readEveryRow(client, "transactions", [
      { column: "date", ascending: false },
      { column: "created_at", ascending: false },
    ]);
    for (const c of calls) {
      expect(c.table).toBe("transactions");
      expect(c.order).toEqual([
        ["date", false],
        ["created_at", false],
        ["id", true],
      ]);
    }
  });

  it("with no order given, still pages in a total order (id)", async () => {
    const { client, calls } = fakeClient(ledger(1200));
    const got = await readEveryRow<Row>(client, "paid_bills");
    expect(got).toHaveLength(1200);
    expect(calls.every((c) => JSON.stringify(c.order) === JSON.stringify([["id", true]]))).toBe(true);
  });

  it("a table smaller than one page is one request", async () => {
    const { client, calls } = fakeClient(ledger(12));
    expect(await readEveryRow(client, "meal_days")).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("an error on page 2 throws — and hands back none of page 1", async () => {
    const { client, calls } = fakeClient(ledger(), { errorOn: 2 });
    let got: unknown = "untouched";
    let err: unknown;
    try {
      got = await readEveryRow(client, "transactions");
    } catch (e) {
      err = e;
    }
    expect(got).toBe("untouched");
    expect(err).toBeInstanceOf(TableUnreadable);
    expect((err as TableUnreadable).table).toBe("transactions");
    expect((err as Error).message).toMatch(/page from 500 failed \(connection reset\)/);
    // It stopped there rather than reading on past the hole.
    expect(calls).toHaveLength(2);
  });

  it("a request that rejects outright (no network) throws the same way", async () => {
    const { client } = fakeClient(ledger(), { throwOn: 2 });
    await expect(readEveryRow(client, "transactions")).rejects.toThrow(/page from 500 failed \(Failed to fetch\)/);
  });

  it("no rows and no error is not an empty table", async () => {
    const { client } = fakeClient(ledger(), { nullOn: 1 });
    await expect(readEveryRow(client, "transactions")).rejects.toBeInstanceOf(TableUnreadable);
  });

  it("a server that ignores the range is refused rather than read forever", async () => {
    const { client } = fakeClient(ledger(), { ignoreRange: true });
    await expect(readEveryRow(client, "transactions")).rejects.toThrow(/1000 rows where 500 were asked for/);
  });

  it("a charge written between two pages does not come back twice", async () => {
    // The other phone's sync lands after page 1. Newest first, the new row pushes
    // every row down one place, so the last row of page 1 is also the first row
    // of page 2 — and a ledger holding it twice double-counts it on every screen.
    const rows = ledger();
    const { client } = fakeClient(rows, {
      before: (n, table) => {
        if (n === 2) table.push({ id: "znew", date: "2026-12-31" });
      },
    });
    const got = await readEveryRow<Row>(client, "transactions", [{ column: "date", ascending: false }]);
    const ids = got.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every row that was there when the read began is there once. The new one
    // arrives with the refetch its own realtime event triggers.
    expect(ids).toHaveLength(2500);
  });

  it("a row without an id stops the read — the duplicate check could not see it", async () => {
    const rows = ledger(10) as Partial<Row>[];
    delete rows[3].id;
    const { client } = fakeClient(rows as Row[]);
    await expect(readEveryRow(client, "transactions")).rejects.toThrow(/without an id/);
  });
});
