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
  | "setaside" // real money out, kept OUT of the variable budget but VISIBLE (excluded | reimbursable)
  | "reconcile"; // a bank-anchor adjusting entry

export interface AppliesTo {
  kind: AppliesToKind;
  recurringId?: string;
  debtId?: string;
  goalId?: string;
  monthKey?: string; // "YYYY-MM", for bills
  day?: number; // which installment (day-of-month) — distinguishes Mom's 15th vs 30th
  appliedAmount?: number; // what actually came off the linked debt (≤ amount when it cleared) — so deleting reverses exactly
  // For bill/debt: "already paid, already in my anchored balance" (moves no cash).
  // For a setaside+reimbursable row: "the money was paid back to me".
  settled?: boolean;
  // --- set-aside (kind:"setaside") only ---
  reason?: "excluded" | "reimbursable"; // excluded = not my budget; reimbursable = owed back to me
  settledByTxnId?: string; // the credit row that paid a reimbursable back (and the back-link on that credit)
  settledAt?: string; // ISO timestamp the reimbursement settled
  note?: string; // free-text "who / why"
}

// A slice of one transaction allocated to a category — for mixed purchases (a
// grocery run that's part food, part household, part pet). One cash event, many
// budget buckets. The sum of split amounts always equals the transaction amount.
export interface TxnSplit {
  categoryId: string;
  amount: number; // positive dollars
}

export interface Transaction {
  id: string;
  date: string; // ISO date "YYYY-MM-DD"
  amount: number; // always positive; the sign comes from `type`
  type: TxnType;
  categoryId: string; // the primary/dominant category (used for the row's color + icon)
  description: string;
  // What the bank actually wrote, when the feed gave it to us. `description` is
  // Plaid's clean merchant name (good for display, lossy for meaning); this is the
  // untouched descriptor, and it is the only place a same-brand fuel station is
  // distinguishable from the store. Absent on manual rows.
  rawDescription?: string;
  account?: string;
  accountId?: string; // which account this hit
  appliesTo?: AppliesTo; // what this entry satisfies (bill / debt / goal / …)
  // When present, the amount is allocated across these categories instead of the
  // single categoryId. Category totals/budgets read these; cash + the row stay one.
  splits?: TxnSplit[];
  // The user dismissed the "unusual purchase" flag for this charge — it won't be
  // surfaced as an anomaly again.
  anomalyAck?: boolean;
  // A still-processing bank charge (Plaid status='pending'). Shown immediately
  // with a "processing" badge; EXCLUDED from budget/firepower/anomaly math until
  // it posts (then the pending row is swapped for the posted one — no double-count).
  pending?: boolean;
  // Which feed produced this row ("plaid"), absent on manual/imported rows. It is
  // carried into the model because DELETING a row must know whether that row ever
  // moved cash: a feed row never does (the balance comes from the bank's own
  // number), so restoring cash for one credits money that never left.
  provider?: string;
  // This row RECORDS money that moved outside the app — a statement import, of
  // history already inside the anchored balance. Its accountId is for display and
  // per-person activity only. Same reason as `provider`: deleting it must not
  // restore cash. See supabase/schema_v28_record_only.sql.
  recordOnly?: boolean;
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
  // Feed auto-tracking for NON-bank debts (Affirm, Mom-China): a payment in the
  // bank feed whose description contains `trackPattern` reduces this debt, computed
  // as balance = trackedBaseline − sum(matched payments since trackedSince). A SET-
  // from-baseline recompute (like the card trigger) → idempotent, no double-count.
  trackPattern?: string; // e.g. "AFFIRM", "REMITLY" (case-insensitive substring)
  trackedBaseline?: number; // the balance when auto-tracking began
  trackedSince?: string; // ISO date; only payments on/after this count
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
  | "quarterly"
  | "semiannual"
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
  // A date this bill is KNOWN to have fired. Only meaningful for cadences longer
  // than a month (quarterly / semiannual / yearly), which repeat on an anniversary
  // the due-day alone can't express: due_days says the 16th, the anchor says WHICH
  // month. Without it a yearly membership renders in all twelve.
  anchorDate?: string; // "YYYY-MM-DD"
  // A bill's LIFETIME. Either side may be absent, meaning unbounded. A future
  // startsOn is a bill that is scheduled but dormant — it turns itself on, so a
  // support payment paused until November needs nobody to remember to restore
  // it. An endsOn is a finite plan (a dental loan's last payment) or a
  // subscription with a known cancel date.
  startsOn?: string; // "YYYY-MM-DD" — first date it may fire
  endsOn?: string; // "YYYY-MM-DD" — last date it may fire
  // For a VARIABLE bill: the amount you know it actually is, which beats the
  // rolling average of past charges. Clear it to hand the estimate back.
  knownAmount?: number;
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
