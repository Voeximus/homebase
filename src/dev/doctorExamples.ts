// Hand-written suggestions for ?doctorlab, with the AppData they refer to.
//
// WHY THESE EXIST. Against real data most suggestion kinds fire zero — that is the
// point of the thresholds. So a snapshot is the wrong way to check that the SCREEN
// is right: it shows four cards of one kind and nothing else. This battery covers
// every kind, every fix, the blocked case, the no-fix case, and both refusal paths
// in applyFix, so every state the sheet can be in is one tap away.
//
// EVERY MERCHANT, AMOUNT AND ID BELOW IS INVENTED. Nothing here comes from the
// household's ledger, and nothing real is ever committed — a real snapshot is
// dropped into the lab at runtime and stays in that tab.
//
// The text is plain English rather than t() on purpose: it stands in for what the
// engine will produce, and the strings that actually ship are the sheet's own
// chrome, which is translated.

import { DEFAULT_CATEGORIES } from "../lib/seed";
import type { AppData, Recurring, Transaction } from "../types";
import type { Suggestion } from "../lib/reviewTypes";

const iso = (d: string) => d;

const bill = (
  id: string,
  name: string,
  amount: number,
  dueDay: number,
  extra: Partial<Recurring> = {},
): Recurring => ({
  id,
  name,
  amount,
  direction: "out",
  cadence: "monthly",
  categoryId: "subscriptions",
  active: true,
  dueDays: [dueDay],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const charge = (
  id: string,
  date: string,
  amount: number,
  description: string,
  extra: Partial<Transaction> = {},
): Transaction => ({
  id,
  date: iso(date),
  amount,
  type: "expense",
  categoryId: "subscriptions",
  description,
  accountId: "acct-checking",
  createdAt: `${date}T12:00:00.000Z`,
  ...extra,
});

const REC: Recurring[] = [
  bill("rec-stream", "Streamly", 14.04, 10),
  bill("rec-power", "City Power", 85, 18, { variable: true, categoryId: "utilities", knownAmount: 85 }),
  bill("rec-gym", "Fitness Club", 200, 5),
  bill("rec-rent", "Rent Co", 1726.88, 1, { categoryId: "housing" }),
  bill("rec-drive", "Cloud Drive", 16.2, 23),
  bill("rec-loan", "Furniture Loan", 151.72, 24, { linkedDebtId: "debt-furniture" }),
  bill("rec-claimed", "Water Co", 42, 12, { categoryId: "utilities" }),
  {
    id: "rec-side",
    name: "Insurance check",
    amount: 1100,
    direction: "in",
    cadence: "monthly",
    active: true,
    dueDays: [25],
    createdAt: "2026-05-01T00:00:00.000Z",
  },
];

const TXN: Transaction[] = [
  // W1 — drift, fixed row
  charge("txn-stream", "2026-09-10", 27, "Streamly", {
    appliesTo: { kind: "bill", recurringId: "rec-stream", monthKey: "2026-09", day: 10 },
  }),
  // W1 — drift, variable row (writes known_amount, not amount)
  charge("txn-power", "2026-09-18", 132.77, "City Power", {
    categoryId: "utilities",
    appliesTo: { kind: "bill", recurringId: "rec-power", monthKey: "2026-09", day: 18 },
  }),
  // W7 — an unlinked charge that matches a bill
  charge("txn-drive", "2026-09-23", 16.2, "Cloud Drive"),
  // W7 — the same shape, but the cycle is ALREADY claimed → applyFix refuses
  charge("txn-water-unlinked", "2026-09-12", 42, "Water Co", { categoryId: "utilities" }),
  charge("txn-water-linked", "2026-09-12", 42, "Water Co", {
    categoryId: "utilities",
    provider: "plaid",
    appliesTo: { kind: "bill", recurringId: "rec-claimed", monthKey: "2026-09", day: 12 },
  }),
  // W5a — one hand-entered row beside one bank row, same day, same amount
  charge("txn-dup-manual", "2026-09-24", 151.72, "Furniture Loan"),
  charge("txn-dup-bank", "2026-09-24", 151.72, "FURNITURE FIN PMT", {
    provider: "plaid",
    appliesTo: { kind: "debt", debtId: "debt-furniture" },
  }),
  // W5 — two BANK rows: no fix is ever offered, the sheet shows "Open both"
  charge("txn-atm-a", "2026-09-15", 60, "ATM withdrawal", { provider: "plaid", categoryId: "other" }),
  charge("txn-atm-b", "2026-09-15", 60, "ATM withdrawal", { provider: "plaid", categoryId: "other" }),
  // the row a "remove the hand-entered one" fix must REFUSE to touch
  charge("txn-bank-only", "2026-09-19", 88.5, "BANK ROW", { provider: "plaid", categoryId: "other" }),
  // W3 — the same charge three months running, not modelled
  charge("txn-note-1", "2026-07-06", 1.99, "Notes App"),
  charge("txn-note-2", "2026-08-06", 1.99, "Notes App"),
  charge("txn-note-3", "2026-09-06", 1.99, "Notes App"),
  // W6 — a one-off deposit against a monthly income row
  {
    id: "txn-check",
    date: "2026-09-25",
    amount: 1137.2,
    type: "income",
    categoryId: "income",
    description: "Insurance settlement",
    accountId: "acct-checking",
    provider: "plaid",
    createdAt: "2026-09-25T12:00:00.000Z",
  },
];

/** The invented ledger the example fixes are applied against. */
export const EXAMPLE_DATA: AppData = {
  transactions: TXN,
  recurring: REC,
  debts: [
    {
      id: "debt-furniture",
      name: "Furniture Loan",
      balance: 1213.76,
      originalBalance: 1820.64,
      color: "#8b7cf6",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  goals: [],
  categories: DEFAULT_CATEGORIES,
  accounts: [
    {
      id: "acct-checking",
      name: "Checking",
      owner: "Joint",
      type: "checking",
      balance: 1193.77,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  paidBills: [],
  merchantRules: [],
  foods: [],
};

/** One card per state the sheet can be in. */
export const EXAMPLE_SUGGESTIONS: Suggestion[] = [
  {
    key: "drift:rec-stream:2700",
    kind: "drift",
    title: "Streamly now charges more than the app expects",
    detail: "The app plans $14.04 a month. The last charge, on 10 Sep, was $27.00 — $12.96 more.",
    amount: 27,
    recurringId: "rec-stream",
    txnIds: ["txn-stream"],
    fix: {
      label: "Use $27.00 from now on",
      done: "Done — Streamly is $27.00 from now on.",
      write: "set-bill-amount",
      recurringId: "rec-stream",
      amount: 27,
      variable: false,
    },
  },
  {
    key: "drift:rec-power:13277",
    kind: "drift",
    title: "City Power is running higher than the app expects",
    detail: "The app expects about $85.00. The last bill, on 18 Sep, was $132.77 — $47.77 more.",
    amount: 132.77,
    recurringId: "rec-power",
    txnIds: ["txn-power"],
    fix: {
      label: "Use $132.77 from now on",
      done: "Done — City Power is $132.77 from now on.",
      write: "set-bill-amount",
      recurringId: "rec-power",
      amount: 132.77,
      variable: true,
    },
  },
  {
    key: "phantom:rec-gym:2026-08",
    kind: "phantom",
    title: "Fitness Club may be finished",
    detail:
      "The app still plans $200.00 a month for Fitness Club, but nothing has been charged for it since June. That is $600.00 of planned money that is not leaving.",
    amount: 600,
    recurringId: "rec-gym",
    fix: {
      label: "Turn this bill off",
      done: "Done — Fitness Club is off. Your history keeps every payment you made.",
      write: "turn-bill-off",
      recurringId: "rec-gym",
    },
  },
  {
    key: "unmodelled:NOTES APP:199",
    kind: "unmodelled",
    title: "Notes App looks like a monthly subscription",
    detail:
      "$1.99 charged in July, August and September, always the same amount. It is not in your bills, so nothing plans for it.",
    amount: 1.99,
    txnIds: ["txn-note-3", "txn-note-2", "txn-note-1"],
    fix: {
      label: "Add it as a monthly bill",
      done: "Done — Notes App is a $1.99 bill on the 6th.",
      write: "add-bill",
      bill: { name: "Notes App", amount: 1.99, dueDay: 6, categoryId: "subscriptions", cadence: "monthly" },
    },
  },
  {
    key: "unmodelled:CORNER SHOP:2500",
    kind: "unmodelled",
    title: "Corner Shop looks like a monthly subscription",
    detail:
      "$25.00 charged in July, August and September, always the same amount. It is not in your bills, so nothing plans for it.",
    amount: 25,
    fix: {
      label: "Add it as a monthly bill",
      blocked: "Give it a category first.",
      write: "add-bill",
      bill: { name: "Corner Shop", amount: 25, dueDay: 14, categoryId: "other", cadence: "monthly" },
    },
  },
  {
    key: "missing:rec-rent:2026-09:0",
    kind: "missing",
    title: "Rent has not been charged this month",
    detail:
      "Rent Co is $1,726.88, due on the 1st. It was charged in July and August, and this month nothing matches it. Either it has not gone out yet or the charge is not in the app.",
    amount: 1726.88,
    recurringId: "rec-rent",
    fix: null,
  },
  {
    key: "duplicate:txn-dup-bank:txn-dup-manual",
    kind: "duplicate",
    title: "This charge may be in twice",
    detail:
      "Two charges of $151.72 on 24 Sep in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra.",
    amount: 151.72,
    txnIds: ["txn-dup-manual", "txn-dup-bank"],
    fix: {
      label: "Remove the hand-entered one",
      done: "Done — the hand-entered charge is gone. Your cash did not move.",
      write: "remove-manual-charge",
      txnId: "txn-dup-manual",
    },
  },
  {
    key: "duplicate:txn-atm-a:txn-atm-b",
    kind: "duplicate",
    title: "Two identical charges on the same day",
    detail:
      "Two charges of $60.00 on 15 Sep in the same account. Both came from the bank, so nothing here can be removed — have a look and decide.",
    amount: 60,
    txnIds: ["txn-atm-a", "txn-atm-b"],
    fix: null,
  },
  {
    key: "duplicate:txn-bank-only:txn-dup-bank",
    kind: "duplicate",
    title: "A fix that must refuse (guard check)",
    detail:
      "This card proposes removing a row that came from the bank. Tapping it must refuse, not delete: Plaid re-delivers bank rows and that history cannot be rebuilt.",
    amount: 88.5,
    txnIds: ["txn-bank-only"],
    fix: {
      label: "Remove the hand-entered one",
      write: "remove-manual-charge",
      txnId: "txn-bank-only",
    },
  },
  {
    key: "income-landed:rec-side:txn-check",
    kind: "income-landed",
    title: "The insurance check looks like it already came in",
    detail:
      "The app expects $1,100.00 a month. One deposit of $1,137.20 arrived on 25 Sep and nothing like it before. If that was a one-off, the app is counting it every month from here.",
    amount: 1137.2,
    recurringId: "rec-side",
    txnIds: ["txn-check"],
    fix: {
      label: "It was one-off — stop expecting it",
      done: "Done — the app stops expecting it after September. Past months are unchanged.",
      write: "end-income",
      recurringId: "rec-side",
      endsOn: "2026-09-30",
    },
  },
  {
    key: "unlinked:rec-drive:2026-09:txn-drive",
    kind: "unlinked",
    title: "This charge looks like your Cloud Drive bill",
    detail:
      "$16.20 at Cloud Drive on 23 Sep. Your Cloud Drive bill is $16.20, due on the 23rd, and the app has it as unpaid. Right now this is counted as ordinary spending as well as a bill still to come.",
    amount: 16.2,
    recurringId: "rec-drive",
    txnIds: ["txn-drive"],
    fix: {
      label: "Yes, that is the bill",
      done: "Done — that charge pays your Cloud Drive bill for September.",
      write: "link-charge-to-bill",
      txnId: "txn-drive",
      recurringId: "rec-drive",
    },
  },
  {
    key: "unlinked:rec-claimed:2026-09:txn-water-unlinked",
    kind: "unlinked",
    title: "A link that must refuse (guard check)",
    detail:
      "This card proposes attaching a charge to a bill cycle that another charge already pays. Tapping it must refuse rather than settle the cycle twice.",
    amount: 42,
    recurringId: "rec-claimed",
    txnIds: ["txn-water-unlinked"],
    fix: {
      label: "Yes, that is the bill",
      write: "link-charge-to-bill",
      txnId: "txn-water-unlinked",
      recurringId: "rec-claimed",
    },
  },
];
