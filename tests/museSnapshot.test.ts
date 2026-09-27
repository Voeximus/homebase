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
import { SAYS_DESCRIPTION } from "../supabase/functions/_shared/muse/toolsFinance";
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
import {
  billsBeforeNextPayday,
  FALLBACK_CYCLE_SPEND,
  firepowerStatus,
  lowestPoint,
  monthGetter,
  runForecast,
} from "../src/lib/headline";

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
  // `reminders` is on the list for a different reason than the health tables: it is
  // not in the snapshot because scripts/snapshot.mjs exports the finance half, and a
  // reminder is one person's private line on a lock screen. Empty here means
  // schedule.list_reminders runs its genuinely-empty path against real data — total
  // 0, shown 0, more false — which is the reply he will actually get most days.
  for (const t of ["body_weights", "meal_days", "macro_targets", "workouts", "workout_routines", "reminders"]) {
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
    // The hourly read cap. Every call in this file is a fresh count of 1, because
    // what is being measured here is the numbers against the real ledger; the cap
    // itself is exercised in tests/museRead.test.ts.
    limit: { bump: () => Promise.resolve(1) },
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
    { tool: "finance.firepower", body: {} },
    { tool: "finance.next_bills", body: {} },
    { tool: "finance.forecast", body: { months: 12 } },
    { tool: "finance.debts", body: {} },
    { tool: "finance.spend_by_category", body: { from: `${month}-01`, to: `${month}-${lastDay}` } },
    { tool: "finance.worth_a_look", body: {} },
    { tool: "health.macros_today", body: {} },
    { tool: "health.weight_trend", body: {} },
    { tool: "health.training_volume", body: {} },
    { tool: "health.last_lift", body: { exercise: "leg press" } },
    { tool: "health.next_workout", body: {} },
    // Paged deliberately, not called bare: the page arguments are the half of this
    // tool that can be wrong against real data, and offset 0 with an explicit limit
    // is the call the assistant makes first.
    { tool: "schedule.list_reminders", body: { limit: 5, offset: 0 } },
    // Phase 2's finance parity. These are the tools most worth running against the real
    // ledger rather than a fixture, because two of them say a merchant name out loud —
    // so the descriptor check below is now the check that matters, and it runs against
    // the real descriptors rather than a canary somebody wrote.
    { tool: "finance.categories", body: {} },
    { tool: "finance.transaction", body: { id: firstChargeId() } },
    { tool: "finance.search_transactions", body: { limit: 20 } },
    { tool: "finance.accounts", body: {} },
    { tool: "finance.bills", body: {} },
    { tool: "finance.bill_calendar", body: { month } },
    { tool: "finance.paid_bills", body: {} },
    { tool: "finance.merchant_rules", body: {} },
    { tool: "finance.bank_status", body: {} },
    { tool: "finance.bank_pending", body: {} },
    { tool: "system.changes", body: {} },
  ];
}

/** A real charge's id out of the snapshot, so finance.transaction has something to find.
 *  The all-zero uuid when the snapshot has no charges: the tool answers `found: false`
 *  rather than failing, which is itself worth exercising. */
function firstChargeId(): string {
  const rows = SNAP?.tables.transactions ?? [];
  const id = rows[0]?.id;
  return typeof id === "string" ? id : "00000000-0000-0000-0000-000000000000";
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
  /**
   * The tools this file CANNOT drive, and the reason is the snapshot, not the tool.
   *
   * `npm run snapshot` captures the finance tables only — accounts, transactions,
   * recurring, debts, savings_goals, paid_bills, merchant_rules. Phase 2's health and
   * workout tools read meal_days, saved_meals, foods, macro_targets, body_weights,
   * workouts and routines, and schedule.reminders reads reminders. None of those are in
   * the file, so driving those tools here would prove they answer about an empty
   * database, which is not what this file is for: it exists to catch the door
   * disagreeing with HIS REAL numbers.
   *
   * They are covered against a built fixture in tests/museHealthRead.test.ts.
   *
   * PHASE 1'S HEALTH TOOLS ARE SWEPT, and they are not an inconsistency. Each one answers
   * with a SUMMARY — today's macros, the weight trend, training volume — and a summary of
   * nothing is a real answer the door has to give without failing, which is worth proving
   * against the real file. The phase-2 tools answer with ROWS, and a page of no rows
   * proves only that the table is empty.
   *
   * THE CHECK UNDER THE EXCUSE. The test below does not just subtract these names — it
   * asserts the snapshot really is missing their tables. The day `npm run snapshot`
   * starts capturing health data, this fails and says to come and sweep them, instead of
   * quietly staying an exemption nobody revisits.
   */
  const NOT_IN_THE_SNAPSHOT: Record<string, string> = {
    "health.day": "meal_days",
    "health.saved_meals": "saved_meals",
    "health.foods": "foods",
    "health.macro_targets": "macro_targets",
    "health.weight_log": "body_weights",
    "health.adherence": "meal_days",
    "health.workouts": "workouts",
    "health.workout": "workouts",
    "health.exercise_progress": "workouts",
    "health.records": "workouts",
    "health.exercises": "workouts",
    "schedule.reminders": "reminders",
    // The memory store is not in the snapshot either, and for a reason worth keeping
    // separate from the rest: `npm run snapshot` deliberately does not capture it. A
    // memory is a sentence one of them dictated, so a captured copy would put his own
    // words in a git-ignored file on this machine. The three tools are driven against a
    // built fixture in tests/museMemory.test.ts.
    "memory.recall": "muse_memory",
    "memory.search": "muse_memory",
    "memory.list": "muse_memory",
  };

  it("names every tool in the catalogue, so this file cannot fall behind it", () => {
    const swept = everyTool().map((t) => t.tool);
    const skipped = Object.keys(NOT_IN_THE_SNAPSHOT);
    // Nothing is both swept and skipped, so the excuse list cannot hide a tool that is
    // actually being driven and failing.
    for (const name of skipped) expect(swept, `${name} is both swept and skipped`).not.toContain(name);
    expect([...swept, ...skipped].sort()).toEqual(TOOLS.map((t) => t.name).sort());

    // And every excuse is true of the snapshot in hand. EMPTY, not absent: the loader
    // defaults a table the file does not carry to an empty array, which is why the
    // summary tools can be swept at all — so "absent" is never what to check here.
    for (const [tool, table] of Object.entries(NOT_IN_THE_SNAPSHOT)) {
      const rows = (SNAP!.tables as Record<string, unknown[] | undefined>)[table] ?? [];
      expect(rows.length, `${table} has real rows now — sweep ${tool} here`).toBe(0);
    }
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
    // This example has now been wrong twice, in opposite directions, which is worth a
    // line. `finance.search_transactions` was it first, because phase 1 forbade the
    // tool; he reversed that deliberately, so the branch changed it to
    // `finance.forecast` — the read that was waiting on its screen. `main` had already
    // shipped forecast by then. So the example is a name that is on the FORBIDDEN list
    // for a reason that is not "not built yet": the payoff date, which no tool returns
    // and none may be worked out from a balance and a rate.
    const res = await ask("finance.payoff_date");
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_tool");
    expect(body.tools).toEqual(TOOLS.map((t) => t.name));
  });

  // ── Rule 4, against strings the bank wrote ──────────────────────────────────
  // PHASE 2 SPLIT THIS IN TWO, because he changed one half of the promise and not the
  // other, and the halves are now different tests against different columns.
  //
  //   `raw_description` — the untouched bank descriptor — still leaves no tool, ever.
  //   `description` — Plaid's cleaned merchant name, or something one of them typed —
  //   may leave the three tools that declare it in the door's own source.
  //
  // Which is why the first test below is the one that matters more now: it runs against
  // the REAL descriptors out of his own ledger, not against a canary somebody wrote, and
  // real descriptors are the strings a hand-written filter would have missed.
  it("lets no RAW bank descriptor out, under any tool, including the ones that say a merchant", async () => {
    const replies = await allReplies();
    // Only raw_description. It is written verbatim by whoever sent the money and cleaned
    // nowhere in the app, so nothing about its shape would trip the scrubber — the only
    // thing keeping it out is that no tool reads the column.
    const raw = new Set<string>();
    for (const t of SNAP!.tables.transactions ?? []) {
      const v = t.raw_description;
      if (typeof v === "string" && v.trim().length >= 5) raw.add(v.trim());
    }
    expect(raw.size).toBeGreaterThan(20);

    // A descriptor that is ALSO a string the door is allowed to say is not evidence of
    // a leak. Real case — a debt called "Affirm" and a charge described "Affirm" are the
    // same six characters, and the string in the reply came off the debt.
    const his: string[] = [];
    for (const r of SNAP!.tables.recurring ?? []) if (typeof r.name === "string") his.push(r.name.trim());
    for (const d of SNAP!.tables.debts ?? []) if (typeof d.name === "string") his.push(d.name.trim());
    for (const a of SNAP!.tables.accounts ?? []) if (typeof a.name === "string") his.push(a.name.trim());
    // AND, FROM PHASE 2, the CLEAN merchant name. `description` legitimately leaves the
    // three tools that declare it, and the bank sometimes writes a raw descriptor that is
    // exactly the clean name — so without this, a real descriptor that equals a clean one
    // reads as a leak from whichever tool correctly said the clean one. What stops that
    // from hollowing the test out is the SECOND test below: which tools may say a
    // description at all is checked separately, against the door's own exported list.
    for (const t of SNAP!.tables.transactions ?? []) {
      if (typeof t.description === "string") his.push(t.description.trim());
    }

    // HIS NAMES ARE TAKEN OUT OF THE REPLY BEFORE THE SCAN, rather than compared
    // against each descriptor one for one. An equality check was not enough, and the
    // real case that broke it is worth writing down: a bill he calls "Amazon Prime"
    // reached finance.next_bills, correctly — and the ledger separately holds a bank
    // descriptor that is the single word "Amazon". The descriptor is not equal to any
    // of his names, so the excuse list missed it, and the reply "contained a
    // descriptor" only because one of his own names has that word inside it.
    //
    // Removing his names first is the precise version of the claim: the reply may say
    // anything he named, and NOTHING ELSE it says may be a descriptor. It weakens
    // nothing — a descriptor sitting anywhere his names do not account for still fails.
    // Longest name first, so a short name that is a prefix of a longer one cannot eat
    // half of it and leave the tail behind.
    const byLength = [...new Set(his)].filter(Boolean).sort((a, b) => b.length - a.length);
    const withoutHisNames = (text: string) => {
      let out = text;
      for (const name of byLength) out = out.split(name).join("·");
      return out;
    };

    // Counted, never printed: a failure message must not be a second copy of the ledger.
    // The tool name is enough to find it.
    const leaks: string[] = [];
    for (const d of raw) {
      for (const [tool, text] of Object.entries(replies)) {
        if (withoutHisNames(text).includes(d)) leaks.push(tool);
      }
    }
    expect(leaks, `raw descriptors reached: ${[...new Set(leaks)].join(", ")}`).toEqual([]);
  });

  it("says a merchant name ONLY from the tools that declare they do", async () => {
    // The other half. A description reaching a tool that is not on SAYS_DESCRIPTION is a
    // leak, and it is the kind that would happen by accident — somebody adds a field to a
    // shared shaper and a summary tool starts carrying merchant names. The list lives in
    // the door's source so this reads it rather than repeating it.
    const replies = await allReplies();
    const descriptions = new Set<string>();
    for (const t of SNAP!.tables.transactions ?? []) {
      const v = t.description;
      if (typeof v === "string" && v.trim().length >= 8) descriptions.add(v.trim());
    }
    expect(descriptions.size).toBeGreaterThan(20);

    // Same allowance as above, and for the same reason: a charge described "Affirm" and a
    // debt called "Affirm" are one string, and the one in the summary reply came off the
    // debt.
    const hisNames = new Set<string>();
    for (const r of SNAP!.tables.recurring ?? []) if (typeof r.name === "string") hisNames.add(r.name.trim());
    for (const d of SNAP!.tables.debts ?? []) if (typeof d.name === "string") hisNames.add(d.name.trim());
    for (const a of SNAP!.tables.accounts ?? []) if (typeof a.name === "string") hisNames.add(a.name.trim());
    for (const m of SNAP!.tables.merchant_rules ?? []) {
      if (typeof m.bill_name === "string") hisNames.add(m.bill_name.trim());
    }

    // SUBSTRING, not equality, and the real ledger is what taught this. A charge is
    // described "Sam's Club" and the bill he typed is called "Sam's Club membership", so
    // the bill's own name CONTAINS the description — and a reply carrying the bill name
    // reads as carrying the description. The original test made the same allowance for
    // "Affirm" as an exact match; the real data has the substring case as well.
    const hisBlob = [...hisNames].join("\u0000");
    const leaks: string[] = [];
    for (const [tool, text] of Object.entries(replies)) {
      if (SAYS_DESCRIPTION.has(tool)) continue;
      for (const d of descriptions) {
        if (hisBlob.includes(d)) continue;
        if (text.includes(d)) leaks.push(tool);
      }
    }
    expect(leaks, `merchant names reached: ${[...new Set(leaks)].join(", ")}`).toEqual([]);

    // And the positive half, so this is not a test that would pass if the two tools
    // silently stopped working: at least one real merchant name DOES come back from the
    // search, because that is what he asked for.
    const search = replies["finance.search_transactions"];
    const said = [...descriptions].some((d) => search.includes(d));
    expect(said, "finance.search_transactions said no merchant name at all").toBe(true);
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
      // Both spellings of the "card ending" prefix are excused, because every
      // outbound string is NFKC-normalised now (see scrub.ts) and that folds a
      // stored "…" into three dots on the way out.
      const fromAccountsOnly = Object.entries(replies).filter(
        ([, text]) => text.includes(l4) && !text.includes(`…${l4}`) && !text.includes(`...${l4}`),
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

  // ── the three money questions, against data nobody designed ─────────────────
  //
  // These three were ABSENT until their assembly lived in src/lib/headline.ts, and the
  // reason was not caution: each one would have called only real functions, computed
  // every number honestly, and still disagreed with his screen. So the claim to prove
  // is not "the numbers are plausible" — it is "the door's number IS the screen's", on
  // the household's own ledger, to the cent. The oracle is the same headline.ts
  // function the screen calls, run directly on the same snapshot.
  it("5 — firepower is the hero tile's figure, subtractions and all", async () => {
    const body = JSON.parse(await (await ask("finance.firepower")).text()) as Record<string, unknown>;
    const head = firepowerStatus(appData(), nowAZ(AT));
    expect(body.available).toBe(cents(head.firepower));
    expect(body.month).toBe(head.monthKey);
    expect((body.plan as Record<string, unknown>).before_subtractions).toBe(cents(head.math.firepower));
    expect((body.taken_out as Record<string, unknown>).overspent_this_month).toBe(
      cents(head.overspendThisMonth),
    );
    expect((body.taken_out as Record<string, unknown>).outside_the_budget).toBe(
      cents(head.outsideBudgetCash),
    );
    // On the real ledger the two subtractions are NOT zero — this household runs over
    // its lean budget and spends outside it — so a door that had called planMath and
    // stopped would have been wrong here by a figure worth naming. That is the whole
    // reason this tool could not exist before, measured rather than asserted.
    const naive = head.math.firepower;
    expect(head.overspendThisMonth + head.outsideBudgetCash).toBeGreaterThan(0);
    expect(cents(naive)).not.toBe(body.available);
  });

  it("6 — next_bills is the cycle window the Bills sheet shows, to the cent", async () => {
    const body = JSON.parse(await (await ask("finance.next_bills")).text()) as Record<string, unknown>;
    const data = appData();
    const az = nowAZ(AT);
    const want = billsBeforeNextPayday(monthGetter(data, az), az);
    expect(body.total).toBe(cents(want.total));
    expect(body.overdue_total).toBe(cents(want.overdueTotal));
    expect(body.count).toBe(want.bills.length);
    const cycle = body.cycle as Record<string, unknown>;
    expect(cycle.start).toBe(want.cycle.start);
    expect(cycle.end).toBe(want.cycle.end);
    expect(cycle.days_left).toBe(want.daysLeft);
    const bills = body.bills as Record<string, unknown>[];
    expect(bills.map((b) => b.due)).toEqual(want.bills.map((b) => b.due));
    expect(bills.map((b) => b.amount)).toEqual(want.bills.map((b) => cents(b.amount)));
    // Every row's date really is inside the cycle, which is the one thing a caller
    // assembling its own window got wrong in both directions.
    for (const b of bills) {
      expect(String(b.due) >= String(cycle.start), `${b.due} is before the cycle`).toBe(true);
      expect(String(b.due) <= String(cycle.end), `${b.due} is after the cycle`).toBe(true);
    }
  });

  it("7 — the forecast's low point matches the app's own walk, month by month", async () => {
    const body = JSON.parse(await (await ask("finance.forecast", { months: 12 })).text()) as Record<string, unknown>;
    const az = nowAZ(AT);
    const { plan, months } = runForecast(appData(), az, 12);
    const rows = body.months as Record<string, unknown>[];
    expect(rows).toHaveLength(months.length);
    for (let i = 0; i < months.length; i++) {
      const m = months[i];
      expect(rows[i].month, `row ${i}`).toBe(m.monthKey);
      expect(rows[i].income, m.monthKey).toBe(cents(m.income));
      expect(rows[i].bills, m.monthKey).toBe(cents(m.bills));
      expect(rows[i].spend, m.monthKey).toBe(cents(m.spend));
      expect(rows[i].surplus, m.monthKey).toBe(cents(m.surplus));
      expect(rows[i].close, m.monthKey).toBe(cents(m.close!));
      // The shape the question asks for, and the number to the cent.
      expect(rows[i].low, m.monthKey).toEqual({ day: m.low!.day, balance: cents(m.low!.balance) });
    }
    // The single worst moment, from the app's own reduction.
    const worst = lowestPoint(months)!;
    expect(body.lowest).toEqual({
      month: worst.monthKey,
      label: worst.label,
      day: worst.day,
      balance: cents(worst.balance),
    });
    // It really is the minimum across the run, checked without reusing lowestPoint —
    // a third leg, so an agreeing pair cannot both be wrong the same way.
    const lows = months.map((m) => m.low!.balance);
    expect(cents(Math.min(...lows))).toBe((body.lowest as Record<string, unknown>).balance);
    // The assumed half is labelled, and it came from the household's own history
    // rather than the fallback — which is what the retired screen's dial did.
    const assumed = body.assumed as Record<string, unknown>;
    expect(assumed.spending_per_cycle).toBe(cents(plan.opts.cycleSpend));
    expect(assumed.complete_cycles_measured).toBe(plan.cycles.length);
    expect(plan.typicalCycle).toBeGreaterThan(0);
    expect(assumed.spending_per_cycle).not.toBe(FALLBACK_CYCLE_SPEND);
  });

  it("8 — and still returns no payoff date from the real ledger", async () => {
    const body = JSON.parse(await (await ask("finance.forecast", { months: 12 })).text()) as Record<string, unknown>;
    // The note is left out of the scan: it is the sentence that says "no payoff date",
    // so it contains the words on purpose. The data beside it must not.
    const rest = { ...body };
    delete rest.note;
    expect(JSON.stringify(rest)).not.toMatch(/cleared|clears|payoff|debt_free|months_to_go/i);
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
