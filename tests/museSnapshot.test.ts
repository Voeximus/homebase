// ── The Muse READ door, against the household's real numbers ──────────────────
//
// WHY THIS FILE EXISTS BESIDE museRead.test.ts
//
// That file drives the door with a fixture built to trip it: a canary descriptor
// in every description, a split that does not add up, a charge pointing at a
// deleted bill, a name with a link inside it. It proves the MECHANISM.
//
// This one proves the mechanism holds against data nobody designed. The newest
// file in docs/snapshots/ is a read-only export of the live finance tables — 500
// transactions, 23 recurring rows, 83 merchant rules, real bank descriptors
// written by Bank of America and by Plaid. Three things only show up here:
//
//   · a real descriptor is not URL-shaped or instruction-shaped, so the scrubber
//     does not touch it — the only thing keeping it out is that no tool reads the
//     column. That is a claim about every tool, and 476 real strings test it
//     harder than one canary does.
//   · the transactions table holds exactly as many rows as paging.ts asks for in
//     one page, which is the boundary where "a full page" and "a truncated page"
//     are easiest to confuse.
//   · the numbers. Three figures are checked against the app's own modules in
//     src/lib, called directly on the same snapshot, to the cent. The generator
//     already proves the edge copies are byte-identical; this proves they compute
//     the same answer, which is a different claim.
//
// THE SNAPSHOT IS GITIGNORED, because it holds real balances. With no snapshot on
// disk every test here skips and says so. Nothing in it is ever printed: the
// assertions are on counts and on numbers, never on the strings themselves.
//
// AND WHAT IT IS NOT. A snapshot is not the ledger. scripts/snapshot.mjs caps
// transactions at the most recent 500 rows, so anything the app computes from
// older history differs here — see the note on the audit cross-check below. The
// door reads the whole table in production (Rule 5); this file feeds it a window.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler";
import { createAuditSink, type AuditRow } from "../supabase/functions/_shared/muse/audit";
import { PAGE, type Db, type DbQuery, type DbRow } from "../supabase/functions/_shared/muse/paging";
import { TOOLS } from "../supabase/functions/_shared/muse/tools";
import { toAppData } from "../supabase/functions/_shared/muse/rows";
import { nowAZ } from "../supabase/functions/_shared/muse/az";
import { cashAccounts, totalBalance, totalPendingHold } from "../src/lib/recurring";
import {
  LEAN_VARIABLE,
  lineSpent,
  payCycleFor,
  perCycle,
  planMath,
  spentByCategoryBetween,
  sumTargets,
  variableSpentBetween,
} from "../src/lib/plan";
import { selfAudit } from "../src/lib/selfAudit";
import { isoDate } from "../src/lib/format";

const SNAP_DIR = "docs/snapshots";
const GINO = "gino-read-secret-that-is-long-enough-1234";
const XINYAN = "xinyan-read-secret-that-is-long-enough-1234";

/** The newest snapshot, or null. Newest by filename, which is the timestamp. */
function newest(): { file: string; takenAt: string; tables: Record<string, DbRow[]> } | null {
  if (!existsSync(SNAP_DIR)) return null;
  const files = readdirSync(SNAP_DIR).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) return null;
  const file = files[files.length - 1];
  const raw = JSON.parse(readFileSync(join(SNAP_DIR, file), "utf8")) as Record<string, unknown>;
  const tables: Record<string, DbRow[]> = {};
  for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) tables[k] = v as DbRow[];
  // The snapshot is the finance half only. Empty rather than missing, so every
  // health tool runs its no-data path for real instead of being skipped.
  for (const t of ["body_weights", "meal_days", "macro_targets", "workouts", "workout_routines"]) {
    tables[t] ??= [];
  }
  return { file, takenAt: String(raw.takenAt ?? ""), tables };
}

const SNAP = newest();

/**
 * The instant to ask about, derived from the snapshot rather than hardcoded, so
 * this file stays right when a newer snapshot replaces the one it was written
 * against.
 *
 * 05:00 UTC on the snapshot's own UTC date is 22:00 the PREVIOUS day in Arizona —
 * a different calendar day, and across a month end a different month. That is the
 * gap a fired clock default falls into, and it is most of his waking day: he works
 * roughly 6 PM to 6 AM.
 */
const AT = new Date(`${(SNAP?.takenAt || "2026-09-26T00:00:00Z").slice(0, 10)}T05:00:00.000Z`);

function snapshotDb(tables: Record<string, DbRow[]>, shortPage?: string): Db {
  return {
    select(q: DbQuery) {
      const rows = () =>
        (tables[q.table] ?? [])
          .filter((r) => Object.entries(q.eq ?? {}).every(([k, v]) => String(r[k]) === v))
          .slice()
          .sort((a, b) => String(a[q.orderBy]).localeCompare(String(b[q.orderBy])));
      return {
        count: () => Promise.resolve(rows().length),
        page: (from: number, to: number) => {
          const slice = rows().slice(from, to + 1);
          return Promise.resolve(shortPage === q.table ? slice.slice(0, Math.max(0, slice.length - 1)) : slice);
        },
      };
    },
  };
}

const audited: AuditRow[] = [];

function deps(shortPage?: string) {
  return {
    db: snapshotDb(SNAP!.tables, shortPage),
    secrets: { gino: GINO, xinyan: XINYAN },
    at: AT,
    baseUrl: "https://example.test/functions/v1/muse-read",
    audit: createAuditSink({
      insert: (_t, row) => {
        audited.push(row as unknown as AuditRow);
        return Promise.resolve();
      },
    }),
  };
}

function ask(tool: string, body: unknown = {}, secret: string | null = GINO, shortPage?: string) {
  return handleMuseRead(
    new Request(`https://example.test/functions/v1/muse-read/${tool}`, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } : {},
      body: JSON.stringify(body ?? {}),
    }),
    deps(shortPage),
  );
}

/** Every tool, with arguments that suit the snapshot's own window. */
function everyTool(): { tool: string; body: Record<string, unknown> }[] {
  const month = AT.toISOString().slice(0, 7);
  const lastDay = new Date(Date.UTC(AT.getUTCFullYear(), AT.getUTCMonth() + 1, 0)).getUTCDate();
  return [
    { tool: "finance.audit", body: {} },
    { tool: "finance.position", body: {} },
    { tool: "finance.budget_status", body: {} },
    { tool: "finance.debts", body: {} },
    { tool: "finance.spend_by_category", body: { from: `${month}-01`, to: `${month}-${lastDay}` } },
    { tool: "finance.worth_a_look", body: {} },
    { tool: "health.macros_today", body: {} },
    { tool: "health.weight_trend", body: {} },
    { tool: "health.training_volume", body: {} },
    { tool: "health.last_lift", body: { exercise: "leg press" } },
    { tool: "health.next_workout", body: {} },
  ];
}

async function underTZ<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    process.env.TZ = prev;
  }
}

/** Every reply, as text, keyed by tool. */
async function allReplies(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { tool, body } of everyTool()) out[tool] = await (await ask(tool, body)).text();
  return out;
}

const describeSnapshot = SNAP ? describe : describe.skip;

if (!SNAP) {
  // Not a silent skip. The snapshot is gitignored, so this is the ordinary state
  // on a fresh clone, and the line says how to get one.
  console.warn(
    `museSnapshot.test.ts: no snapshot in ${SNAP_DIR}/ — skipping. ` +
      `Make one with: SUPABASE_PAT=<token> node scripts/snapshot.mjs`,
  );
}

describeSnapshot("the read door against the real ledger", () => {
  it("names every tool in the catalogue, so this file cannot fall behind it", () => {
    expect(everyTool().map((t) => t.tool).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("answers every tool, with no tool failing on real data", async () => {
    for (const { tool, body } of everyTool()) {
      const res = await ask(tool, body);
      expect(res.status, `${tool} did not answer`).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.tool).toBe(tool);
      expect(json).not.toHaveProperty("error");
    }
  });

  it("gives the same answer under TZ=UTC and under TZ=America/Phoenix", async () => {
    for (const { tool, body } of everyTool()) {
      const utc = await underTZ("UTC", async () => (await ask(tool, body)).text());
      const az = await underTZ("America/Phoenix", async () => (await ask(tool, body)).text());
      expect(az, `${tool} answered differently in the two timezones`).toBe(utc);
    }
  });

  it("refuses with no key and with a wrong key, and says nothing about the data", async () => {
    for (const secret of [null, "not-the-secret-but-long-enough-xxxx"]) {
      const res = await ask("finance.position", {}, secret);
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ error: "unauthorized", says: "That key does not open this door." });
    }
  });

  it("refuses a tool it does not have, and names what it does", async () => {
    const res = await ask("finance.search_transactions");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_tool");
    expect(body.tools).toEqual(TOOLS.map((t) => t.name));
  });

  // ── Rule 4, against strings the bank wrote ──────────────────────────────────
  it("lets no real bank descriptor out, under any tool", async () => {
    const replies = await allReplies();
    // Every distinct string in `description` and `raw_description`. A descriptor is
    // not URL-shaped or instruction-shaped, so the scrubber would pass it through
    // untouched — the only thing keeping it out is that no tool reads the column.
    const descriptors = new Set<string>();
    for (const t of SNAP!.tables.transactions ?? []) {
      for (const col of ["description", "raw_description"]) {
        const v = t[col];
        if (typeof v === "string" && v.trim().length >= 5) descriptors.add(v.trim());
      }
    }
    expect(descriptors.size).toBeGreaterThan(50);

    // A descriptor that is ALSO a bill, debt or account name is not evidence of a
    // leak: those names are his, and the door is allowed to say them. Real case —
    // a debt called "Affirm" and a charge described "Affirm" are the same eight
    // characters, and the string in the reply came off the debt.
    const his = new Set<string>();
    for (const r of SNAP!.tables.recurring ?? []) if (typeof r.name === "string") his.add(r.name.trim());
    for (const d of SNAP!.tables.debts ?? []) if (typeof d.name === "string") his.add(d.name.trim());
    for (const a of SNAP!.tables.accounts ?? []) if (typeof a.name === "string") his.add(a.name.trim());

    // Counted, never printed: a failure message must not be a second copy of the
    // ledger. The tool name is enough to find it.
    const leaks: string[] = [];
    for (const d of descriptors) {
      if (his.has(d)) continue;
      for (const [tool, text] of Object.entries(replies)) {
        if (text.includes(d)) leaks.push(tool);
      }
    }
    expect(leaks, `descriptors reached: ${[...new Set(leaks)].join(", ")}`).toEqual([]);
  });

  it("sends no newline, no URL and no control character on real data", async () => {
    // The control-character check counts code points instead of using a character
    // class, for the reason scrub.ts records in its own comment: U+2028 and U+2029
    // ARE line terminators, so a regex literal containing them reads as if the
    // expression ended. Writing one here failed the build, which is the comment
    // earning its keep.
    const controlCount = (s: string) => {
      let n = 0;
      for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) n++;
      }
      return n;
    };
    for (const [tool, text] of Object.entries(await allReplies())) {
      expect(text, `${tool} sent a newline`).not.toMatch(/\n|\\n/);
      expect(text, `${tool} sent a URL`).not.toMatch(/https?:|:\/\/|www\./);
      expect(controlCount(text), `${tool} sent a control character`).toBe(0);
    }
  });

  it("never reads accounts.last4, whatever a card is called", async () => {
    const replies = await allReplies();
    // The column itself. A last-4 he typed into a DEBT's own name is a different
    // thing and is deliberate — the app's own screen shows "Card …4728" — so the
    // check is on the accounts he holds, not on the digits.
    for (const a of SNAP!.tables.accounts ?? []) {
      const l4 = a.last4;
      if (typeof l4 !== "string" || !l4) continue;
      const fromAccountsOnly = Object.entries(replies).filter(
        ([, text]) => text.includes(l4) && !text.includes(`…${l4}`),
      );
      expect(fromAccountsOnly.map(([t]) => t), "a bare account last4 got out").toEqual([]);
    }
  });

  it("says worth a look without a merchant, a charge date or an engine field", async () => {
    const body = JSON.parse(await (await ask("finance.worth_a_look")).text()) as Record<string, unknown>;
    const suggestions = (body.suggestions ?? []) as Record<string, unknown>[];
    const allowed = new Set(["rule", "kind", "sentence", "amount", "month", "bill", "count"]);
    for (const s of suggestions) {
      for (const k of Object.keys(s)) expect(allowed, `worth_a_look sent ${k}`).toContain(k);
    }
    // A bill CYCLE is "2026-09". A charge DATE is "2026-09-18". The second one is
    // what W5a and W7 are made of, and they come back as a count instead.
    expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(body.dismissals_known).toBe(false);
  });

  // ── Rule 5, at the page boundary the real table sits on ─────────────────────
  it("reads a table that fills exactly one page without mistaking it for a truncation", async () => {
    const n = (SNAP!.tables.transactions ?? []).length;
    // scripts/snapshot.mjs caps at 500 and paging.ts asks for 500 at a time, so
    // this is the case where a full page and a trimmed page look alike. If the cap
    // ever changes this stops being the interesting case, and the test says so
    // instead of pretending.
    if (n !== PAGE) {
      console.warn(`museSnapshot: transactions is ${n} rows, not the ${PAGE}-row page size — boundary not exercised`);
    }
    const res = await ask("finance.audit");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.checks as unknown[]).length).toBe(8);
  });

  it("gives no number at all when a page of the real table comes back short", async () => {
    const res = await ask("finance.audit", {}, GINO, "transactions");
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("ledger_unreadable");
    expect(body.table).toBe("transactions");
    expect(body).not.toHaveProperty("checks");
    expect(body).not.toHaveProperty("failures");
  });
});

// ── Rule 1, to the cent, against the app's own modules ────────────────────────
//
// The door imports generated copies of src/lib. scripts/check-categorizer-sync.mjs
// proves those copies are byte-identical to their sources; these prove they produce
// the same numbers on the same data, which is the claim that matters when a figure
// is spoken in a chat with no screen beside it.
describeSnapshot("Rule 1 — the door's number is the app's number", () => {
  const appData = () =>
    toAppData({
      transactions: SNAP!.tables.transactions ?? [],
      debts: SNAP!.tables.debts ?? [],
      goals: SNAP!.tables.savings_goals ?? [],
      accounts: SNAP!.tables.accounts ?? [],
      recurring: SNAP!.tables.recurring ?? [],
      paidBills: SNAP!.tables.paid_bills ?? [],
      merchantRules: SNAP!.tables.merchant_rules ?? [],
    });
  const cents = (n: number) => Math.round(n * 100) / 100;

  it("1 — available cash equals totalBalance, cards excluded", async () => {
    const body = JSON.parse(await (await ask("finance.position")).text()) as Record<string, unknown>;
    const data = appData();
    expect(body.available).toBe(cents(totalBalance(data.accounts)));
    expect(body.still_processing).toBe(cents(totalPendingHold(data.accounts)));
    expect((body.accounts as unknown[]).length).toBe(cashAccounts(data.accounts).length);
    // A third leg with no repo code in it: plain arithmetic on the raw rows. If the
    // column mapping in rows.ts ever drifted, the two above would still agree with
    // each other and this one would not.
    const raw = (SNAP!.tables.accounts ?? [])
      .filter((a) => !/credit/i.test(String(a.type ?? "")))
      .reduce((s, a) => s + Number(a.balance ?? 0), 0);
    expect(body.available).toBe(cents(raw));
  });

  it("2 — total owed equals planMath's totalDebt", async () => {
    const body = JSON.parse(await (await ask("finance.debts")).text()) as Record<string, unknown>;
    const data = appData();
    const math = planMath(
      data.recurring,
      data.debts,
      sumTargets(LEAN_VARIABLE),
      isoDate(nowAZ(AT)),
      data.transactions,
    );
    expect(body.total).toBe(cents(math.totalDebt));
    const raw = (SNAP!.tables.debts ?? []).reduce((s, d) => s + Number(d.balance ?? 0), 0);
    expect(body.total).toBe(cents(raw));
  });

  it("3 — the envelope and every line match the sequence buildVMs runs", async () => {
    const body = JSON.parse(await (await ask("finance.budget_status")).text()) as Record<string, unknown>;
    const data = appData();
    const az = nowAZ(AT);
    const monthly = sumTargets(LEAN_VARIABLE);
    const cycle = payCycleFor(az);
    const target = perCycle(monthly);
    const spent = variableSpentBetween(data.transactions, cycle.start, cycle.end);
    const byCat = spentByCategoryBetween(data.transactions, cycle.start, cycle.end);

    expect(body.envelope).toEqual({
      target: cents(target),
      spent: cents(spent),
      left: cents(target - spent),
    });
    expect((body.cycle as Record<string, unknown>).start).toBe(cycle.start);
    expect((body.cycle as Record<string, unknown>).end).toBe(cycle.end);
    expect((body.cycle as Record<string, unknown>).day).toBe(cycle.dayIndex);

    const lines = body.lines as Record<string, unknown>[];
    expect(lines).toHaveLength(LEAN_VARIABLE.length);
    for (const l of LEAN_VARIABLE) {
      const shown = lines.find((x) => x.key === l.key)!;
      expect(shown, `no line for ${l.key}`).toBeDefined();
      expect(shown.target, l.key).toBe(cents(perCycle(l.target)));
      expect(shown.spent, l.key).toBe(cents(lineSpent(l, byCat)));
      expect(shown.left, l.key).toBe(cents(perCycle(l.target) - lineSpent(l, byCat)));
    }
  });

  it("4 — the self-audit passes and fails on exactly the checks the app's does", async () => {
    // Same data in, same verdict out, check for check. What this canNOT tell you is
    // whether the LIVE audit agrees: the snapshot is the most recent 500 charges,
    // and links-point-somewhere walks every charge, so a window can only ever show
    // fewer broken links than the whole ledger has. The gate for "does the app
    // disagree with itself" is his phone, beside the screen.
    const body = JSON.parse(await (await ask("finance.audit")).text()) as Record<string, unknown>;
    const app = selfAudit(appData(), nowAZ(AT));
    expect(body.clean).toBe(app.clean);
    expect(body.failures).toBe(app.failures);
    const shown = body.checks as { id: string; status: string }[];
    expect(shown.map((c) => c.id)).toEqual(app.checks.map((c) => c.id));
    expect(shown.map((c) => c.status)).toEqual(app.checks.map((c) => c.status));
  });
});
