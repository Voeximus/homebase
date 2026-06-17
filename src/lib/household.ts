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

export const SEED_ACCOUNTS: SeedAccount[] = [
  { name: "Geo", owner: "Gino", last4: "4662", type: "checking", balance: 1566.26, sortOrder: 0 },
  { name: "Xinyan", owner: "Xinyan", last4: "0366", type: "checking", balance: 1095.75, sortOrder: 1 },
  { name: "Joint", owner: "Joint", last4: "1211", type: "checking", balance: 18.74, sortOrder: 2 },
];

export const SEED_RECURRING: SeedRecurring[] = [
  // --- Income (lands on both paydays) ---
  { name: "Gino paycheck", amount: 1800, direction: "in", cadence: "biweekly", categoryId: "salary", account: "Geo", owner: "Gino", note: "conservative night-shift floor", dueDays: [15, 29] },
  { name: "Xinyan paycheck", amount: 1187.42, direction: "in", cadence: "biweekly", categoryId: "salary", account: "Xinyan", owner: "Xinyan", note: "ASU, fixed", dueDays: [15, 29] },

  // --- Shared (paid from Geo, split 60/40 via Xinyan's transfer in) ---
  { name: "Rent", amount: 1715, direction: "out", cadence: "monthly", categoryId: "housing", account: "Geo", owner: "Shared", note: "Nollie — full rate from July (RentPlus removed)", dueDays: [1] },
  { name: "Electric (SRP)", amount: 85, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Geo", owner: "Shared", note: "varies a little", dueDays: [13] },
  { name: "Xinyan's 40% share", amount: 720, direction: "transfer", cadence: "monthly", account: "Xinyan", toAccount: "Geo", owner: "Xinyan", note: "40% of rent + electric", dueDays: [1] },

  // --- Gino personal (from Geo) ---
  { name: "Mom", amount: 600, direction: "out", cadence: "monthly", categoryId: "other", account: "Geo", owner: "Gino", note: "$300/check from July — her rent help + car insurance", dueDays: [15, 30] },
  { name: "Verizon", amount: 83, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Geo", owner: "Gino", dueDays: [17] },
  { name: "Spotify", amount: 14.04, direction: "out", cadence: "monthly", categoryId: "subscriptions", account: "Geo", owner: "Gino", dueDays: [10] },
  { name: "Card payment (…4728)", amount: 135, direction: "out", cadence: "monthly", categoryId: "other", account: "Geo", owner: "Gino", note: "min payment", dueDays: [15], linksDebtLast4: "4728" },
  { name: "Affirm", amount: 200, direction: "out", cadence: "monthly", categoryId: "other", account: "Geo", owner: "Gino", note: "winding down (~$289 left) — attack via the ladder" },

  // --- Xinyan personal (from Xinyan) ---
  { name: "Spot Pet insurance", amount: 99.93, direction: "out", cadence: "monthly", categoryId: "other", account: "Xinyan", owner: "Xinyan", dueDays: [4] },
  { name: "T-Mobile", amount: 27.48, direction: "out", cadence: "monthly", categoryId: "utilities", account: "Xinyan", owner: "Xinyan", dueDays: [29] },
  { name: "Apple", amount: 15.12, direction: "out", cadence: "monthly", categoryId: "subscriptions", account: "Xinyan", owner: "Xinyan", dueDays: [1] },
  { name: "Claude Pro", amount: 21.62, direction: "out", cadence: "monthly", categoryId: "subscriptions", account: "Xinyan", owner: "Xinyan", dueDays: [20] },
  { name: "Card payment (…6813)", amount: 85, direction: "out", cadence: "monthly", categoryId: "other", account: "Xinyan", owner: "Xinyan", note: "min payment", dueDays: [8], linksDebtLast4: "6813" },
];

export const SEED_DEBTS: SeedDebt[] = [
  { name: "Credit card (…4728)", balance: 4156.78, apr: 26.49, minPayment: 135, color: "#ef4444" },
  { name: "Xinyan card (…6813)", balance: 591.09, minPayment: 85, color: "#f59e0b" },
  { name: "Affirm — Anthropic", balance: 99.1, color: "#6366f1" },
  { name: "Affirm — Amazon", balance: 189.68, color: "#8b5cf6" },
  { name: "Mom (China)", balance: 800, color: "#ec4899" },
];

// Cadence -> monthly multiplier. Biweekly uses ×2 (the conservative
// "2 paychecks a month" view Gino chose) rather than 26÷12 — so the budget
// plans on a normal month and the ~2 extra-check months a year are upside.
export const CADENCE_TO_MONTHLY: Record<Cadence, number> = {
  weekly: 52 / 12,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
  yearly: 1 / 12,
};
