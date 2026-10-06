// Money moving between their own accounts is not spending, in the budget too.
//
// ASKED 2026-10-05. October's household line was carrying a $250 and a $50 Zelle
// from Xinyan to Gino. His reaction: "Well it shouldn't I thought that was already
// fixed." Half of it was — flow.ts had paired those two transfers on 10-04, but only
// the net-worth figures read flow.ts. The budget's partition (spentByCategoryBetween)
// never asked, so it counted Xinyan's half as $300 of household spending.
//
// These are the live October rows, by amount and confirmation code.
import { describe, expect, it } from "vitest";
import { spentByCategoryBetween, variableSpentThisMonth } from "../src/lib/plan";
import { transferIds } from "../src/lib/flow";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Transaction } from "../src/types";

let n = 0;
const row = (over: Partial<Transaction>): Transaction =>
  ({ id: `t${++n}`, date: "2026-10-04", amount: 0, type: "expense", categoryId: "shopping",
     description: "", accountId: "xinyan", createdAt: "2026-10-04T12:00:00Z", ...over }) as Transaction;

// The two real pairs: Xinyan sends, Gino receives, same code, same amount.
const OCTOBER = (): Transaction[] => [
  row({ amount: 250, type: "expense", accountId: "xinyan", description: "Zelle Transfer CONF# YOMIM8KBL; GIO" }),
  row({ amount: 250, type: "income", accountId: "gino", categoryId: "other-income", description: "Zelle Transfer Conf# YOMIM8KBL; XINYAN LI" }),
  row({ amount: 50, type: "expense", accountId: "xinyan", description: "Zelle Transfer CONF# XZ31RH99F; GIO" }),
  row({ amount: 50, type: "income", accountId: "gino", categoryId: "other-income", description: "Zelle Transfer Conf# XZ31RH99F; XINYAN LI" }),
  // A Zelle to someone OUTSIDE the household: one row, its own code. Real spending.
  row({ amount: 40, type: "expense", accountId: "xinyan", description: "Zelle Transfer CONF# UGNG0672V; PINGTING YANG" }),
  // Ordinary household spending, so the line is not empty.
  row({ amount: 29.82, type: "expense", accountId: "xinyan", description: "Walmart" }),
];

const shopping = (txns: Transaction[]) => spentByCategoryBetween(txns, "2026-10-01", "2026-10-31").shopping ?? 0;

describe("the budget leaves out transfers between their own accounts", () => {
  it("counts the October household line without the $300 that never left", () => {
    // $40 to Pingting + $29.82 at Walmart. Not $369.82.
    expect(shopping(OCTOBER())).toBeCloseTo(69.82, 2);
  });

  it("still counts a Zelle to someone outside the household", () => {
    const txns = OCTOBER().filter((t) => !t.description.includes("YOMIM8KBL") && !t.description.includes("XZ31RH99F"));
    expect(shopping(txns)).toBeCloseTo(69.82, 2);
    expect([...transferIds(txns)]).toEqual([]);
  });

  it("leaves out a row a person marked as moved by hand, paired or not", () => {
    const txns = [row({ amount: 120, type: "expense", accountId: "xinyan", description: "Venmo", flowOverride: "moved" })];
    expect(shopping(txns)).toBe(0);
  });

  it("keeps a row a person marked as spent, even if it looks like half a transfer", () => {
    // A correction by hand outranks the inference — rule 0 in flowOf, and here too.
    const txns = OCTOBER().map((t) => (t.description.includes("YOMIM8KBL") && t.type === "expense" ? { ...t, flowOverride: "spent" as const } : t));
    expect(shopping(txns)).toBeCloseTo(69.82 + 250, 2);
  });

  it("pairs across a window boundary — the halves can post on different days", () => {
    // Sent on the 30th, received on the 1st. A window of October alone must still
    // know the September half was a transfer, or half a transfer turns back into
    // spending at every month edge.
    const txns = [
      row({ date: "2026-09-30", amount: 100, type: "expense", accountId: "xinyan", description: "Zelle CONF# EDGECASE1; GIO" }),
      row({ date: "2026-10-01", amount: 100, type: "income", accountId: "gino", categoryId: "other-income", description: "Zelle Conf# EDGECASE1; XINYAN LI" }),
    ];
    expect(spentByCategoryBetween(txns, "2026-09-01", "2026-09-30").shopping ?? 0).toBe(0);
  });

  it("moves spent-this-month too, since it is built on the same partition", () => {
    expect(variableSpentThisMonth(OCTOBER(), "2026-10")).toBeCloseTo(69.82, 2);
  });
});

describe("bar and rows still agree with transfers in the ledger", () => {
  it("bar-vs-rows passes — the rows leave out exactly what the bar leaves out", () => {
    const data: AppData = {
      transactions: OCTOBER(), debts: [], goals: [], categories: DEFAULT_CATEGORIES,
      accounts: [], recurring: [], paidBills: [], merchantRules: [], foods: [],
    } as unknown as AppData;
    const check = selfAudit(data, new Date(2026, 9, 5, 12)).checks.find((c) => c.id === "bar-vs-rows")!;
    expect(check.status).toBe("ok");
  });
});
