import { describe, it, expect } from "vitest";
import { recentCycleSpend, typicalCycleSpend, payCycleFor } from "../src/lib/plan";
import type { Transaction } from "../src/types";

const txn = (date: string, amount: number, categoryId = "groceries"): Transaction => ({
  id: `t-${date}-${amount}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Store",
  createdAt: `${date}T12:00:00Z`,
});

// Aug 18 2026 → the current cycle is Aug 15–30, so the six COMPLETE cycles behind
// it end on Aug 14.
const NOW = new Date(2026, 7, 18, 12);

describe("recentCycleSpend — the dial's reference point", () => {
  it("returns complete cycles only, oldest first", () => {
    const c = recentCycleSpend([], NOW, 6);
    expect(c).toHaveLength(6);
    expect(c[c.length - 1].end).toBe("2026-08-14");
    // strictly increasing, and none of them is the cycle we are standing in
    const current = payCycleFor(NOW);
    for (const x of c) expect(x.start < current.start).toBe(true);
    for (let i = 1; i < c.length; i++) expect(c[i].start > c[i - 1].start).toBe(true);
  });

  it("EXCLUDES the cycle in progress", () => {
    // The live cycle is partly spent, so including it would make the household's
    // own history look cheaper than it is — at exactly the moment they are
    // deciding what to spend.
    const current = payCycleFor(NOW); // 2026-08-15 .. 2026-08-30
    const spentToday = [txn("2026-08-16", 271.42)];
    const c = recentCycleSpend(spentToday, NOW, 6);
    expect(c.some((x) => x.start === current.start)).toBe(false);
    expect(c.reduce((s, x) => s + x.spent, 0)).toBe(0);
  });

  it("sums the graded spend that falls inside each cycle", () => {
    const t = [
      txn("2026-08-01", 100), // cycle 2026-07-31 .. 2026-08-14
      txn("2026-08-10", 50), //  same cycle
      txn("2026-07-20", 200), // cycle 2026-07-15 .. 2026-07-30
    ];
    const c = recentCycleSpend(t, NOW, 6);
    const byStart = Object.fromEntries(c.map((x) => [x.start, x.spent]));
    expect(byStart["2026-07-31"]).toBeCloseTo(150, 2);
    expect(byStart["2026-07-15"]).toBeCloseTo(200, 2);
  });

  it("ignores bill payments — a bill is not variable spending", () => {
    const t = [
      txn("2026-08-01", 100),
      {
        ...txn("2026-08-02", 1732.16, "housing"),
        appliesTo: { kind: "bill" as const, recurringId: "rent", monthKey: "2026-08", day: 1 },
      },
    ];
    const c = recentCycleSpend(t, NOW, 6);
    expect(c.find((x) => x.start === "2026-07-31")!.spent).toBeCloseTo(100, 2);
  });
});

describe("typicalCycleSpend — median, not mean", () => {
  it("is not dragged by one heavy cycle", () => {
    const cycles = [490, 606, 1032, 1124, 1334, 4200].map((spent, i) => ({
      start: `2026-0${i + 1}-01`,
      end: `2026-0${i + 1}-14`,
      label: "x",
      spent,
    }));
    // mean would be $1,464 — a figure this household has never once lived on.
    expect(typicalCycleSpend(cycles)).toBeCloseTo((1032 + 1124) / 2, 2);
  });

  it("handles an odd count and an empty history", () => {
    const mk = (spent: number) => ({ start: "s" + spent, end: "e", label: "x", spent });
    expect(typicalCycleSpend([mk(10), mk(30), mk(20)])).toBe(20);
    expect(typicalCycleSpend([])).toBe(0);
  });
});
