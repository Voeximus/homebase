// Check 9: a recent bill is paid from the account that pays it.
//
// Built from the real September Claude Pro case: one Claude Pro bill (Xinyan's,
// paid from her account), and Gino's own $21.62 charge sitting in its September
// slot. Every other check passed on that ledger. This one has to fail on it — and
// has to stay quiet on rent paid from Gino's account in June, which was correct on
// the day and only "disagrees" because the bill moved to Joint later.
import { describe, expect, it } from "vitest";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Account, AppData, Recurring, Transaction } from "../src/types";

const NOW = new Date(2026, 9, 5, 12); // 5 Oct 2026 — so September is "last month"

const acct = (id: string, owner: string): Account =>
  ({ id, name: "Checking", owner, type: "checking", balance: 0, sortOrder: 0, createdAt: "2026-01-01T00:00:00Z" }) as Account;

const bill = (over: Partial<Recurring>): Recurring =>
  ({ id: "b", name: "Bill", amount: 100, direction: "out", cadence: "monthly", active: true,
     dueDays: [20], createdAt: "2026-01-01T00:00:00Z", ...over }) as Recurring;

const paid = (id: string, date: string, amount: number, accountId: string, recurringId: string, monthKey: string): Transaction =>
  ({ id, date, amount, type: "expense", categoryId: "subscriptions", description: "Anthropic", accountId,
     createdAt: `${date}T12:00:00Z`, appliesTo: { kind: "bill", recurringId, monthKey, day: 20, settled: true } }) as Transaction;

const data = (over: Partial<AppData>): AppData => ({
  transactions: [], debts: [], goals: [], categories: DEFAULT_CATEGORIES,
  accounts: [acct("gino", "Gino"), acct("xinyan", "Xinyan"), acct("joint", "Joint")],
  recurring: [], paidBills: [], merchantRules: [], foods: [], ...over,
});

const check9 = (d: AppData) => selfAudit(d, NOW).checks.find((c) => c.id === "paid-from-its-own-account")!;

const CLAUDE_PRO = bill({ id: "pro", name: "Claude Pro", amount: 21.62, accountId: "xinyan" });

describe("paid-from-its-own-account", () => {
  it("FAILS on the real September ledger: Gino's charge in Xinyan's slot", () => {
    const c = check9(data({
      recurring: [CLAUDE_PRO],
      transactions: [paid("g", "2026-09-08", 21.62, "gino", "pro", "2026-09")],
    }));
    expect(c.status).toBe("fail");
    // It names the bill, the cycle, the charge, and both accounts — enough to fix it
    // without opening anything else.
    expect(c.detail).toContain("Claude Pro 2026-09");
    expect(c.detail).toContain("Gino");
    expect(c.detail).toContain("Xinyan");
  });

  it("passes once her own charge holds the slot — the state after the fix", () => {
    const c = check9(data({
      recurring: [CLAUDE_PRO],
      transactions: [paid("x", "2026-09-21", 21.62, "xinyan", "pro", "2026-09")],
    }));
    expect(c.status).toBe("ok");
  });

  it("stays quiet about old history: June rent from Gino, bill now on Joint", () => {
    // Correct on the day it was made. Bills had no paying account until 2026-10-01,
    // so every pre-October link would fail a check with no time scope, and a check
    // that fails on correct history is a check that gets ignored.
    const c = check9(data({
      recurring: [bill({ id: "rent", name: "Rent", amount: 1232.44, accountId: "joint", dueDays: [1] })],
      transactions: [paid("r", "2026-06-01", 1232.44, "gino", "rent", "2026-06")],
    }));
    expect(c.status).toBe("ok");
  });

  it("does catch this month as well as last", () => {
    const c = check9(data({
      recurring: [CLAUDE_PRO],
      transactions: [paid("g", "2026-10-03", 21.62, "gino", "pro", "2026-10")],
    }));
    expect(c.status).toBe("fail");
  });

  it("skips a bill nobody has placed on an account", () => {
    const c = check9(data({
      recurring: [bill({ id: "vet", name: "Vet", accountId: undefined })],
      transactions: [paid("v", "2026-09-20", 100, "gino", "vet", "2026-09")],
    }));
    expect(c.status).toBe("ok");
  });

  it("skips a charge with no account — there is nothing to disagree with", () => {
    const c = check9(data({
      recurring: [CLAUDE_PRO],
      transactions: [{ ...paid("m", "2026-09-20", 21.62, "x", "pro", "2026-09"), accountId: undefined }],
    }));
    expect(c.status).toBe("ok");
  });

  it("counts against the audit as a whole, so `clean` goes false", () => {
    const r = selfAudit(data({
      recurring: [CLAUDE_PRO],
      transactions: [paid("g", "2026-09-08", 21.62, "gino", "pro", "2026-09")],
    }), NOW);
    expect(r.clean).toBe(false);
  });
});
