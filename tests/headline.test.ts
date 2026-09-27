// src/lib/headline.ts — the assembly a screen and the Muse read door share.
//
// WHY THIS FILE EXISTS. Some of the app's figures are not one function call but a
// SEQUENCE of them, and the sequence used to live inside a view module. The budget
// envelope was five calls in a particular order with a particular window, written
// out in src/views/redesign/buildVMs.ts; the read door needed the same number and
// held its own copy of those five lines; and tests/museSnapshot.test.ts wrote them a
// third time in order to check the door. Nothing tied the three together, so a change
// to how the screen grades the envelope would have changed the screen and left the
// door answering the old way — in a chat, where there is no screen beside the number
// to notice. That is the "$85 versus $100" failure cron-notify already had, arriving
// through the tool he would use most.
//
// Two claims are checked here:
//   1. the extraction is FAITHFUL — envelopeStatus does the same five calls in the
//      same order and returns the same numbers as doing them by hand;
//   2. both callers actually go through it, rather than keeping a copy.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { envelopeStatus } from "../src/lib/headline";
import {
  LEAN_VARIABLE,
  lineSpent,
  payCycleFor,
  perCycle,
  spentByCategoryBetween,
  sumTargets,
  variableSpentBetween,
} from "../src/lib/plan";
import type { Transaction } from "../src/types";

const txn = (date: string, amount: number, categoryId = "groceries"): Transaction => ({
  id: `t-${date}-${amount}-${categoryId}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Store",
  createdAt: `${date}T12:00:00Z`,
});

// Mid-cycle, so the window has charges on both sides of it and a partial period is
// being graded — the case a month-shaped calculation gets wrong.
const NOW = new Date(2026, 8, 20, 19, 0, 0);

const LEDGER: Transaction[] = [
  txn("2026-09-16", 206.09),
  txn("2026-09-18", 61.4, "dining"),
  txn("2026-09-20", 42.0),
  txn("2026-09-22", 18.5, "pets"),
  // Outside the cycle on both sides, so a wrong window shows up as a wrong number.
  txn("2026-08-20", 500.0),
  txn("2026-10-05", 500.0),
  // Not graded against the envelope at all: electronics belongs to no line.
  txn("2026-09-19", 300.0, "electronics"),
  // A split fans across two lines, which is the case a per-line copy gets wrong.
  {
    ...txn("2026-09-21", 100.0),
    splits: [
      { categoryId: "groceries", amount: 70 },
      { categoryId: "pets", amount: 30 },
    ],
  },
];

describe("envelopeStatus is the sequence, not a new calculation", () => {
  it("returns exactly what the five calls return, in the same order", () => {
    const monthlyTarget = sumTargets(LEAN_VARIABLE);
    const cycle = payCycleFor(NOW);
    const target = perCycle(monthlyTarget);
    const spent = variableSpentBetween(LEDGER, cycle.start, cycle.end);
    const byCat = spentByCategoryBetween(LEDGER, cycle.start, cycle.end);

    const got = envelopeStatus(LEDGER, NOW);
    expect(got.monthlyTarget).toBe(monthlyTarget);
    expect(got.cycle).toEqual(cycle);
    expect(got.target).toBe(target);
    expect(got.spent).toBe(spent);
    expect(got.byCat).toEqual(byCat);
  });

  it("prices every line the way the bar does", () => {
    const { byCat, lines } = envelopeStatus(LEDGER, NOW);
    expect(lines).toHaveLength(LEAN_VARIABLE.length);
    for (const l of LEAN_VARIABLE) {
      const line = lines.find((x) => x.key === l.key)!;
      expect(line, l.key).toBeDefined();
      expect(line.target, l.key).toBe(perCycle(l.target));
      expect(line.spent, l.key).toBe(lineSpent(l, byCat));
      expect(line.label, l.key).toBe(l.label);
      expect(line.cats, l.key).toEqual(l.cats);
    }
  });

  it("grades the pay cycle rather than the month, and a split lands on both lines", () => {
    const { cycle, spent, byCat } = envelopeStatus(LEDGER, NOW);
    // The cycle contains 20 Sep and excludes 20 Aug and 5 Oct.
    expect(cycle.start <= "2026-09-20" && "2026-09-20" <= cycle.end).toBe(true);
    expect(cycle.start > "2026-08-20").toBe(true);
    expect(cycle.end < "2026-10-05").toBe(true);
    // 70 of the split's 100 on groceries, 30 on pets.
    expect(byCat.groceries).toBe(206.09 + 42 + 70);
    expect(byCat.pets).toBe(18.5 + 30);
    // Electronics is real cash out and is graded against no line, so it is in the
    // partition and not in the envelope's spend.
    expect(byCat.electronics).toBe(300);
    expect(spent).toBe(206.09 + 42 + 70 + 61.4 + 18.5 + 30);
  });

  it("reads no clock of its own", () => {
    // The edge runtime is UTC. From 5 PM Arizona onward a fired default answers about
    // tomorrow — a different pay cycle, a different set of charges — and NOW above is
    // 7 PM deliberately. `now` is a required argument, so there is no default to fire.
    const src = readFileSync("src/lib/headline.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toMatch(/new Date\(|Date\.now\(|todayISO\(/);
  });
});

describe("both callers go through it", () => {
  it("the screen builds its envelope from headline.ts", () => {
    const src = readFileSync("src/views/redesign/buildVMs.ts", "utf8");
    expect(src).toMatch(/import \{ envelopeStatus \} from "\.\.\/\.\.\/lib\/headline"/);
    expect(src).toContain("envelopeStatus(data.transactions, now)");
    // And it no longer re-runs the sequence itself.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toContain("payCycleFor(now)");
    expect(code).not.toContain("perCycle(monthlyTarget)");
    expect(code).not.toContain("lineSpent(");
  });

  it("the read door does too, through the generated copy", () => {
    const src = readFileSync("supabase/functions/_shared/muse/tools.ts", "utf8");
    expect(src).toMatch(/import \{ envelopeStatus \} from "\.\/lib\/headline\.ts"/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toContain("payCycleFor(");
    expect(code).not.toContain("perCycle(");
    expect(code).not.toContain("variableSpentBetween(");
  });

  it("the generated copy is on the generator's list, so it cannot be hand-edited", () => {
    const gen = readFileSync("scripts/gen-muse-shared.mjs", "utf8");
    expect(gen).toContain('"src/lib/headline.ts"');
    const copy = readFileSync("supabase/functions/_shared/muse/lib/headline.ts", "utf8");
    expect(copy).toContain("GENERATED — DO NOT EDIT");
  });
});
