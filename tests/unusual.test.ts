// The unusual-purchase rule, now that it lives in src/lib/unusual.ts.
//
// MOVED 2026-10-10 out of src/views/redesign/buildVMs.ts so the read door's
// finance.unusual and the Activity screen answer from one function. Two promises:
//
//   1. the rule is the rule the screen always applied — checked against a verbatim copy
//      of the inline code that was removed (LEGACY below), over a ledger built to hit
//      every branch of it;
//   2. the screen still draws exactly what it drew before the move.
//
// Every merchant and amount here is made up.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppData, Transaction } from "../src/types";
import { unusualCharges, UNUSUAL_MIN_AMOUNT } from "../src/lib/unusual";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { buildFinanceVMs } from "../src/views/redesign/buildVMs";

let seq = 0;
const tx = (over: Partial<Transaction>): Transaction => ({
  id: `t${++seq}`,
  date: "2026-10-05",
  amount: 10,
  type: "expense",
  categoryId: "dining",
  description: "MADE UP CAFE",
  createdAt: "2026-10-05T12:00:00Z",
  ...over,
});

/** The block buildVMs.ts ran before 2026-10-10, word for word but for the names it
 *  reads (`visible`, `monthKey`, `catName`), which are parameters here. */
function LEGACY(visible: Transaction[], monthKey: string, catName: (id: string) => string) {
  const monthFree = visible.filter(
    (t) => t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo && !t.pending,
  );
  const byCatAmts: Record<string, number[]> = {};
  monthFree.forEach((t) => (byCatAmts[t.categoryId] ??= []).push(t.amount));
  return monthFree
    .filter((t) => {
      if (t.anomalyAck) return false;
      const arr = byCatAmts[t.categoryId];
      if (arr.length < 3 || t.amount <= 25) return false;
      const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
      return t.amount > 2.5 * mean;
    })
    .map((t) => {
      const arr = byCatAmts[t.categoryId];
      const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
      return {
        id: t.id,
        merchant: t.description || catName(t.categoryId),
        catId: t.categoryId,
        catLabel: catName(t.categoryId),
        amount: t.amount,
        ratio: mean > 0 ? t.amount / mean : 0,
      };
    });
}

/** A month built to reach every branch: an unusual charge, one exactly at the floor,
 *  one just under the ratio, a dismissed one, a category with too few charges, and the
 *  four kinds of row the rule must not look at. */
function october(): Transaction[] {
  seq = 0;
  return [
    tx({ amount: 9 }),
    tx({ amount: 11 }),
    tx({ amount: 10 }),
    tx({ amount: 80, description: "MADE UP STEAKHOUSE" }), // unusual: 80 > 2.5 × 28, the dining mean
    tx({ categoryId: "pets", amount: 5 }),
    tx({ categoryId: "pets", amount: 5 }),
    tx({ categoryId: "pets", amount: UNUSUAL_MIN_AMOUNT }), // at the floor: never unusual
    tx({ categoryId: "shopping", amount: 20 }),
    tx({ categoryId: "shopping", amount: 20 }),
    tx({ categoryId: "shopping", amount: 20 }),
    tx({ categoryId: "shopping", amount: 49 }), // 49 < 2.5 × 27.25: just under
    tx({ categoryId: "transport", amount: 4 }),
    tx({ categoryId: "transport", amount: 4 }),
    tx({ categoryId: "transport", amount: 4 }),
    tx({ categoryId: "transport", amount: 60, anomalyAck: true }), // dismissed
    tx({ categoryId: "car", amount: 900 }), // only one in its category
    tx({ amount: 700, pending: true }), // still processing
    tx({ amount: 700, appliesTo: { kind: "transfer" } }), // attached
    tx({ amount: 700, type: "income" }), // money in
    tx({ amount: 700, date: "2026-09-28" }), // last month
    tx({ amount: 30, description: "" }), // no description: the screen falls back to the category
  ];
}

describe("unusualCharges is the rule the screen always applied", () => {
  it("flags exactly what the old inline code flagged, in the same order, with the same ratio", () => {
    const rows = october();
    const catName = (id: string) => `name of ${id}`;
    const legacy = LEGACY(rows, "2026-10", catName);
    const now = unusualCharges(rows, "2026-10");
    expect(now.map((u) => u.tx.id)).toEqual(legacy.map((l) => l.id));
    expect(now.map((u) => u.ratio)).toEqual(legacy.map((l) => l.ratio));
    // And the one the month was built around is the one it found.
    expect(now.map((u) => u.tx.description)).toEqual(["MADE UP STEAKHOUSE"]);
  });

  it("leaves a dismissed charge out — and still counts it towards its category's average", () => {
    const rows = october();
    expect(unusualCharges(rows, "2026-10").some((u) => u.tx.anomalyAck)).toBe(false);
    const all = unusualCharges(rows, "2026-10", { includeDismissed: true });
    const dismissed = all.filter((u) => u.dismissed);
    expect(dismissed).toHaveLength(1);
    // transport: 4, 4, 4 and the dismissed 60 — the mean includes the 60.
    expect(dismissed[0].mean).toBe(18);
    expect(dismissed[0].inCategory).toBe(4);
  });

  it("answers about the month it is handed, never the clock's", () => {
    expect(unusualCharges(october(), "2026-09")).toEqual([]);
  });
});

describe("the Activity screen draws what it drew before the move", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the same unusual purchases, with the same fields", () => {
    // The screen reads the real clock (it is a screen), so the clock is pinned to the
    // month the ledger is in.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T19:00:00Z"));
    const rows = october();
    const data: AppData = {
      transactions: rows,
      debts: [],
      goals: [],
      categories: DEFAULT_CATEGORIES,
      accounts: [],
      recurring: [],
      paidBills: [],
      merchantRules: [],
      foods: [],
    };
    const vms = buildFinanceVMs(data, "gino", "all", { email: "someone@example.test", lang: "en" });
    const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? id;
    // `visible` drops settled and set-aside-excluded rows and sorts newest first; for
    // this ledger (nothing settled, nothing set aside, all on one day bar one) that is
    // a stable sort of the same rows, which is what is rebuilt here.
    const visible = [...rows].sort((a, b) =>
      a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
    );
    const legacy = LEGACY(visible, "2026-10", catName);
    expect(vms.home.anomalies).toEqual(legacy);
    expect(vms.home.anomalyCount).toBe(legacy.length);
    expect(vms.home.anomalyIds).toEqual(legacy.map((l) => l.id));
  });
});
