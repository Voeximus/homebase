// The real fixed skeleton seeded into Homebase (income + bills + transfers +
// debts + account balances). Recurring/debt rows reference accounts by NAME;
// FinanceStore.seedHousehold() inserts accounts first, then resolves names -> ids.
// Everything here is FIXED / won't-change-soon. Variable spend is logged live.

import type { Cadence, RecurringDirection } from "../types";

export interface SeedAccount {
  name: string;
  owner: "Gino" | "Xinyan" | "Joint";
  last4: string;
  type: string;
  balance: number;
  sortOrder: number;
}

export interface SeedRecurring {
  name: string;
  amount: number;
  direction: RecurringDirection;
  cadence: Cadence;
  categoryId?: string;
  account: string; // source account NAME
  toAccount?: string; // destination NAME (transfers)
  owner?: string;
  note?: string;
  dueDays?: number[]; // day(s) of month it posts — the calendar reads this
  linksDebtLast4?: string; // if a debt payment, the …last4 of the debt it pays down
}

export interface SeedDebt {
  name: string;
  balance: number;
  apr?: number;
  minPayment?: number;
  color: string;
}

// NOTE: this is a GENERIC placeholder skeleton (zeroed amounts + masked last4s).
// The household has already been seeded once and the live data is the source of
// truth (seedHousehold is never re-run). The real reconciled baseline figures are
// kept ONLY in the private ops docs — never in this public repo / client bundle.
export const SEED_ACCOUNTS: SeedAccount[] = [
  { name: "Checking A", owner: "Gino", last4: "0000", type: "checking", balance: 0, sortOrder: 0 },
  { name: "Checking B", owner: "Xinyan", last4: "0000", type: "checking", balance: 0, sortOrder: 1 },
  { name: "Joint", owner: "Joint", last4: "0000", type: "checking", balance: 0, sortOrder: 2 },
];

export const SEED_RECURRING: SeedRecurring[] = [
  // --- Income (lands on both paydays) ---
  { name: "Income A", amount: 0, direction: "in", cadence: "semimonthly", categoryId: "salary", account: "Checking A", owner: "Gino", dueDays: [15, 31] },
  { name: "Income B", amount: 0, direction: "in", cadence: "biweekly", categoryId: "salary", account: "Checking B", owner: "Xinyan", dueDays: [15, 29] },

  // --- Shared ---
  { name: "Rent", amount: 0, direction: "out", cadence: "monthly", categoryId: "housing", account: "Checking A", owner: "Shared", dueDays: [1] },
  { name: "Electric", amount: 0, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Checking A", owner: "Shared", dueDays: [13] },
  { name: "Household share", amount: 0, direction: "transfer", cadence: "monthly", account: "Checking B", toAccount: "Checking A", owner: "Xinyan", dueDays: [1] },

  // --- Personal A ---
  { name: "Family support", amount: 0, direction: "out", cadence: "monthly", categoryId: "other", account: "Checking A", owner: "Gino", dueDays: [15, 30] },
  { name: "Phone", amount: 0, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Checking A", owner: "Gino", dueDays: [17] },
  { name: "Music", amount: 0, direction: "out", cadence: "monthly", categoryId: "subscriptions", account: "Checking A", owner: "Gino", dueDays: [10] },
  { name: "Card payment A", amount: 0, direction: "out", cadence: "monthly", categoryId: "other", account: "Checking A", owner: "Gino", dueDays: [15], linksDebtLast4: "0001" },

  // --- Personal B ---
  { name: "Pet insurance", amount: 0, direction: "out", cadence: "monthly", categoryId: "other", account: "Checking B", owner: "Xinyan", dueDays: [4] },
  { name: "Mobile", amount: 0, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Checking B", owner: "Xinyan", dueDays: [29] },
  { name: "AI subscription", amount: 0, direction: "out", cadence: "monthly", categoryId: "subscriptions", account: "Checking B", owner: "Xinyan", dueDays: [20] },
  { name: "Card payment B", amount: 0, direction: "out", cadence: "monthly", categoryId: "other", account: "Checking B", owner: "Xinyan", dueDays: [8], linksDebtLast4: "0002" },
];

export const SEED_DEBTS: SeedDebt[] = [
  { name: "Card (…0001)", balance: 0, apr: 0, minPayment: 0, color: "#ef4444" },
  { name: "Card (…0002)", balance: 0, minPayment: 0, color: "#f59e0b" },
  { name: "Loan", balance: 0, color: "#6366f1" },
  { name: "Family loan", balance: 0, color: "#ec4899" },
];

// Cadence -> monthly multiplier. Biweekly uses ×2 (the conservative
// "2 paychecks a month" view Gino chose) rather than 26÷12 — so the budget
// plans on a normal month and the ~2 extra-check months a year are upside.
export const CADENCE_TO_MONTHLY: Record<Cadence, number> = {
  weekly: 52 / 12,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
};
