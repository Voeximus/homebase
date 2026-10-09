import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readEveryRowSql, SQL_PAGE_ROWS } from "../scripts/read-every-row.mjs";

// FOUND 2026-10-09: the two Management-API readers of the ledger took a window
// and were trusted as the whole thing — tests/live-selfaudit.test.ts the newest
// 2,000 rows, scripts/snapshot.mjs the newest 500 (with 835 in the table). Both
// now page through scripts/read-every-row.mjs. A fake `q` here answers the SQL the
// way Postgres would, from a 2,500-row ledger.

type Row = { id: string; date: string };

function ledger(n = 2500): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${String(i).padStart(5, "0")}`,
    date: `2026-${String(1 + Math.floor(i / 700)).padStart(2, "0")}-${String(1 + (Math.floor(i / 25) % 28)).padStart(2, "0")}`,
  }));
}

/** Answers `select … order by … limit N offset M` from `rows`, ordered as asked. */
function fakeSql(rows: Row[], opts: { failOn?: number } = {}) {
  const asked: string[] = [];
  const q = async (sql: string): Promise<unknown> => {
    asked.push(sql);
    if (asked.length === opts.failOn) throw new Error("500 upstream connect error");
    const m = /order by (.+?) limit (\d+) offset (\d+)$/.exec(sql);
    if (!m) throw new Error(`unexpected statement: ${sql}`);
    const keys = m[1].split(",").map((k) => {
      const [col, dir] = k.trim().split(/\s+/);
      return { col, desc: dir === "desc" };
    });
    const sorted = [...rows].sort((a, b) => {
      for (const { col, desc } of keys) {
        const x = (a as Record<string, string>)[col];
        const y = (b as Record<string, string>)[col];
        if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
    return sorted.slice(Number(m[3]), Number(m[3]) + Number(m[2]));
  };
  return { q, asked };
}

describe("readEveryRowSql — the whole ledger through the Management API", () => {
  it("reads all 2,500 rows, newest first, in pages that end their order on id", async () => {
    const rows = ledger();
    const { q, asked } = fakeSql(rows);
    const got = (await readEveryRowSql(q, { table: "transactions", orderBy: "date desc" })) as Row[];

    expect(got).toHaveLength(2500);
    expect(new Set(got.map((r) => r.id)).size).toBe(2500);
    expect(got[0].date >= got[got.length - 1].date).toBe(true);
    expect(SQL_PAGE_ROWS).toBe(500);
    expect(asked).toEqual([0, 500, 1000, 1500, 2000, 2500].map(
      (off) => `select * from transactions order by date desc, id limit 500 offset ${off}`,
    ));
  });

  it("a failure on page 2 throws, and nothing from page 1 is returned", async () => {
    const { q, asked } = fakeSql(ledger(), { failOn: 2 });
    await expect(readEveryRowSql(q, { table: "transactions", orderBy: "date desc" })).rejects.toThrow(/upstream connect error/);
    expect(asked).toHaveLength(2);
  });

  it("no order given is still a total order", async () => {
    const { q, asked } = fakeSql(ledger(30));
    expect(await readEveryRowSql(q, { table: "paid_bills" })).toHaveLength(30);
    expect(asked).toEqual(["select * from paid_bills order by id limit 500 offset 0"]);
  });

  it("a row written between two pages is not taken twice", async () => {
    const rows = ledger();
    const { q: inner } = fakeSql(rows);
    let n = 0;
    const q = async (sql: string) => {
      if (++n === 2) rows.push({ id: "znew", date: "2026-12-31" });
      return inner(sql);
    };
    const got = (await readEveryRowSql(q, { table: "transactions", orderBy: "date desc" })) as Row[];
    expect(new Set(got.map((r) => r.id)).size).toBe(got.length);
    expect(got).toHaveLength(2500);
  });
});

describe("scripts/snapshot.mjs — the snapshot holds the whole ledger", () => {
  it("writes all 2,500 transactions, paged, not the newest 500", () => {
    // The real script, run as itself in a scratch copy of the repo layout, with
    // `fetch` answered by a fake Management API. A scratch copy because the
    // script writes into ../docs/snapshots beside itself, and the real folder is
    // where tests/museSnapshot.test.ts looks for the newest snapshot.
    const dir = mkdtempSync(join(tmpdir(), "hb-snapshot-"));
    try {
      mkdirSync(join(dir, "scripts"));
      copyFileSync("scripts/snapshot.mjs", join(dir, "scripts", "snapshot.mjs"));
      copyFileSync("scripts/read-every-row.mjs", join(dir, "scripts", "read-every-row.mjs"));
      const log = join(dir, "queries.json");
      const preload = join(dir, "fake-api.mjs");
      writeFileSync(
        preload,
        `
import { writeFileSync } from "node:fs";
const asked = [];
const ledger = Array.from({ length: 2500 }, (_, i) => ({
  id: "t" + String(i).padStart(5, "0"),
  date: "2026-" + String(1 + Math.floor(i / 700)).padStart(2, "0") + "-" + String(1 + (Math.floor(i / 25) % 28)).padStart(2, "0"),
  created_at: "2026-10-09T00:00:00Z",
  amount: "1.00",
  type: "expense",
}));
globalThis.fetch = async (_url, init) => {
  const sql = JSON.parse(init.body).query;
  asked.push(sql);
  writeFileSync(${JSON.stringify(log)}, JSON.stringify(asked));
  let rows = [];
  if (/ from transactions /.test(sql)) {
    // Newest first, then id: the order the snapshot asks for (created_at is the
    // same on every row here).
    const sorted = [...ledger].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
    const page = / limit (\\d+) offset (\\d+)$/.exec(sql);
    const bare = / limit (\\d+)$/.exec(sql);
    rows = page ? sorted.slice(Number(page[2]), Number(page[2]) + Number(page[1])) : bare ? sorted.slice(0, Number(bare[1])) : sorted;
  }
  return new Response(JSON.stringify(rows), { status: 200 });
};
`,
      );
      execFileSync(process.execPath, ["--import", pathToFileURL(preload).href, join(dir, "scripts", "snapshot.mjs")], {
        cwd: dir,
        env: { ...process.env, SUPABASE_PAT: "test-not-a-token" },
        stdio: "pipe",
      });

      const outDir = join(dir, "docs", "snapshots");
      const [file] = readdirSync(outDir);
      const snap = JSON.parse(readFileSync(join(outDir, file), "utf8"));
      expect(snap.transactions).toHaveLength(2500);
      expect(new Set(snap.transactions.map((r: Row) => r.id)).size).toBe(2500);

      const asked = JSON.parse(readFileSync(log, "utf8")) as string[];
      const ledgerReads = asked.filter((s) => / from transactions /.test(s));
      expect(ledgerReads.length).toBe(6);
      for (const s of ledgerReads) expect(s).toMatch(/order by date desc, created_at desc, id limit 500 offset \d+$/);
      // paid_bills was "limit 200"; it is paged the same way now.
      expect(asked.filter((s) => / from paid_bills /.test(s))).toEqual([
        "select * from paid_bills order by month desc, id limit 500 offset 0",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
