// Domain model for Homebase. These shapes map 1:1 to future Supabase tables,
// so moving from local storage to the cloud is a swap, not a rewrite.

import type { Food } from "./lib/nutrition";

export type TxnType = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  icon: string; // emoji — zero-config and renders everywhere
  color: string; // hex, used for accents/dots
  type: TxnType | "both";
}

// What a ledger entry satisfies — the link that lets one money event fan out.
export type AppliesToKind =
  | "bill" // a scheduled recurring bill, for a given month
  | "debt" // an extra payment toward a debt
  | "income" // a paycheck/check landing
  | "goal" // a savings-goal contribution
  | "transfer" // an internal account-to-account move
  | "reconcile"; // a bank-anchor adjusting entry

export interface AppliesTo {
  kind: AppliesToKind;
  recurringId?: string;
  debtId?: string;
  goalId?: string;
  monthKey?: string; // "YYYY-MM", for bills
  day?: number; // which installment (day-of-month) — distinguishes Mom's 15th vs 30th
  appliedAmount?: number; // what actually came off the linked debt (≤ amount when it cleared) — so deleting reverses exactly
  settled?: boolean; // a "already paid, already in my anchored balance" marker — moves no cash, touches no debt
}

export interface Transaction {
  id: string;
  date: string; // ISO date "YYYY-MM-DD"
  amount: number; // always positive; the sign comes from `type`
  type: TxnType;
  categoryId: string;
  description: string;
  account?: string;
  accountId?: string; // which account this hit
  appliesTo?: AppliesTo; // what this entry satisfies (bill / debt / goal / …)
  createdAt: string; // ISO timestamp
}

export interface Debt {
  id: string;
  name: string;
  balance: number; // current amount owed
  originalBalance: number; // starting amount, for payoff progress
  apr?: number; // annual interest rate, %
  minPayment?: number;
  color: string; // hex
  providerAccountId?: string; // linked Plaid credit account — its balance drives this debt
  createdAt: string;
}

export interface SavingsGoal {
  id: string;
  name: string;
  saved: number; // current amount set aside
  target: number; // goal amount
  icon: string; // emoji
  color: string; // hex
  createdAt: string;
}

export type AccountOwner = "Gino" | "Xinyan" | "Joint";

export interface Account {
  id: string;
  name: string; // "Geo", "Xinyan", "Joint"
  owner: AccountOwner;
  last4?: string;
  type: string; // "checking"
  balance: number; // spendable (available) balance for checking; amount owed for cards
  sortOrder: number;
  providerAccountId?: string; // Plaid account_id, when bank-connected
  pendingHold?: number; // ~$ still processing (current − available); display-only
  createdAt: string;
}

export type RecurringDirection = "in" | "out" | "transfer";
export type Cadence =
  | "weekly"
  | "biweekly"
  | "semimonthly"
  | "monthly"
  | "yearly";

export interface Recurring {
  id: string;
  name: string;
  amount: number; // always positive
  direction: RecurringDirection;
  cadence: Cadence;
  categoryId?: string;
  accountId?: string; // source account
  toAccountId?: string; // destination (transfers only)
  owner?: string; // "Gino" | "Xinyan" | "Shared"
  active: boolean;
  variable?: boolean; // amount varies month-to-month → project via rolling avg of actuals
  note?: string;
  dueDays?: number[]; // day(s) of month this posts — the calendar reads this, not a constant
  linkedDebtId?: string; // if this bill is a payment on a debt, the debt it pays down
  createdAt: string;
}

// A "paid" override for one bill in one month. A row exists only when the
// state differs from the auto-by-date default. bill_key = "<label>@<day>".
export interface PaidBill {
  id: string;
  month: string; // "YYYY-MM"
  billKey: string;
  paid: boolean;
}

// A categorizer rule the app LEARNED from Gino (via a one-tap clarify card).
// Checked before the built-in dictionary, so answers stick.
export interface MerchantRule {
  id: string;
  pattern: string; // normalized merchant key
  kind: "variable" | "skip" | "bill";
  categoryId?: string; // for kind "variable"
  billName?: string; // for kind "bill"
  createdAt: string;
}

export interface AppData {
  transactions: Transaction[];
  debts: Debt[];
  goals: SavingsGoal[];
  categories: Category[];
  accounts: Account[];
  recurring: Recurring[];
  paidBills: PaidBill[];
  merchantRules: MerchantRule[];
  foods: Food[]; // shared custom food library (meal builder)
}

export type Tab = "plan" | "budget" | "money";
