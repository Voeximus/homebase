// "spent this week" in the Mine lens is part of the household's week, never more than it.
//
// Added 2026-10-31. Every figure and name below is MADE UP: the repo is public.
//
// Both lenses grade the Sun–Sat week with weekView's own rule (line spend, money back
// taken off). Mine used to add up line spend with no money back taken off, so a refund
// on one person's account left their week ABOVE the household's.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AppData, Transaction } from "../src/types";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { buildFinanceVMs } from "../src/views/redesign/buildVMs";
import { gaugeSegs } from "../src/lib/catColor";

let seq = 0;
const tx = (date: string, amount: number, categoryId: string, over: Partial<Transaction> = {}): Transaction => ({
  id: `w${String(++seq).padStart(3, "0")}`,
  date,
  amount,
  type: "expense",
  categoryId,
  description: "Corner Market",
  createdAt: `${date}T12:00:00Z`,
  ...over,
});
const acct = (id: string, owner: Account["owner"]): Account => ({
  id,
  name: `Sample ${id}`,
  owner,
  type: "checking",
  balance: 100,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
});
const appData = (transactions: Transaction[]): AppData => ({
  transactions,
  debts: [],
  goals: [],
  categories: DEFAULT_CATEGORIES,
  accounts: [acct("acct-g", "Gino"), acct("acct-x", "Xinyan")],
  recurring: [],
  paidBills: [],
  merchantRules: [],
  foods: [],
});
const week = (data: AppData, owner: "gino" | "xinyan", lens: "all" | "me") =>
  buildFinanceVMs(data, owner, lens, { email: "someone@example.test", lang: "en" });

describe("spent this week, by lens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes money back off in Mine as it does in All", () => {
    // Wed Oct 28: the week is Sun Oct 25 – Sat Oct 31.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T19:00:00Z"));
    const data = appData([
      tx("2026-10-26", 30, "dining", { description: "Sample Cafe", accountId: "acct-g" }),
      tx("2026-10-26", 80, "shopping", { accountId: "acct-x" }),
      // a refund from the same merchant, on her account
      tx("2026-10-27", 20, "refund", { type: "income", accountId: "acct-x" }),
    ]);
    const all = week(data, "gino", "all");
    expect(all.home.spentThisWeek).toBe(90);
    expect(week(data, "xinyan", "me").home.spentThisWeek).toBe(60);
    expect(week(data, "xinyan", "me").activity.spentThisWeek).toBe(60);
    expect(week(data, "gino", "me").home.spentThisWeek).toBe(30);
  });

  it("never reads a person's week above the household's", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T19:00:00Z"));
    // Every row is hers, so Mine IS the household's week — not $20 more than it.
    const data = appData([
      tx("2026-10-26", 80, "shopping", { accountId: "acct-x" }),
      tx("2026-10-27", 20, "refund", { type: "income", accountId: "acct-x" }),
    ]);
    const all = week(data, "xinyan", "all").home.spentThisWeek;
    const mine = week(data, "xinyan", "me").home.spentThisWeek;
    expect(all).toBe(60);
    expect(mine).toBe(all);
  });
});

describe("the budget ring is a gauge on both tabs", () => {
  it("leaves the unspent part of the target as track", () => {
    expect(gaugeSegs([{ color: "#111111", value: 25 }], 100)).toEqual([
      { color: "#111111", value: 25 },
      { color: "#222b38", value: 75 },
    ]);
  });
  it("is all category over the target, and a bare track with nothing spent", () => {
    expect(gaugeSegs([{ color: "#111111", value: 120 }], 100)).toEqual([
      { color: "#111111", value: 120 },
      { color: "#222b38", value: 0 },
    ]);
    expect(gaugeSegs([], 0)).toEqual([{ color: "#222b38", value: 1 }]);
  });
});
