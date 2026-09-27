// Database rows → the shapes the app's maths modules expect.
//
// IS THIS RULE 3? No, and the line matters.
//
// Rule 3 forbids the door ASSEMBLING a function's inputs — computing a number and
// handing it in, the way the hero tile's firepower is `planMath().firepower` minus
// two subtractions made in a view module. A door that did that would return a real
// number from a real shared function and still disagree with the screen.
//
// This file does none of that. It renames snake_case columns to camelCase fields
// and turns Postgres `numeric` (which arrives as a string) into a number. Every
// line is transcription. It mirrors the mappers at the top of
// src/store/FinanceStore.tsx and src/store/HealthStore.tsx, which live inside
// React files a Deno function cannot import.
//
// WHAT STOPS IT DRIFTING. Two things, and neither is vigilance:
//   · the return types are the app's own (`Transaction`, `Account`, …), so a field
//     the domain type requires and a mapper forgot is a compile error;
//   · tests/museRead.test.ts maps a fully-populated row of every table and asserts
//     every optional field survives, which is what a required-field check cannot
//     see.
//
// If a column ever needs more than renaming, it does not belong here — it belongs
// in a shared pure function the app calls too.

import type {
  Account,
  AppData,
  Debt,
  MerchantRule,
  PaidBill,
  Recurring,
  SavingsGoal,
  Transaction,
} from "./lib/types.ts";
import { DEFAULT_CATEGORIES } from "./lib/seed.ts";
import type { BodyWeight } from "./lib/weightLog.ts";
import type { DayLog, SavedMeal } from "./lib/mealLog.ts";
import type { MacroTarget } from "./lib/nutrition.ts";
import type { Routine, Workout } from "./lib/workoutLog.ts";
import type { DbRow } from "./paging.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => Number(v ?? 0);
const opt = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const optNum = (v: unknown): number | undefined => (v == null ? undefined : Number(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function toTransaction(r: DbRow): Transaction {
  return {
    id: str(r.id),
    date: str(r.date),
    amount: num(r.amount),
    type: r.type === "income" ? "income" : "expense",
    categoryId: str(r.category_id),
    description: str(r.description),
    rawDescription: opt(r.raw_description),
    account: opt(r.account),
    accountId: opt(r.account_id),
    appliesTo: (r.applies_to ?? undefined) as Transaction["appliesTo"],
    splits: Array.isArray(r.splits) && r.splits.length ? (r.splits as Transaction["splits"]) : undefined,
    anomalyAck: !!r.anomaly_ack,
    pending: r.status === "pending",
    provider: opt(r.provider),
    recordOnly: !!r.record_only,
    needsReview: !!r.needs_review,
    userCategorized: !!r.user_categorized,
    createdAt: str(r.created_at),
  };
}

export function toDebt(r: DbRow): Debt {
  return {
    id: str(r.id),
    name: str(r.name),
    balance: num(r.balance),
    originalBalance: num(r.original_balance),
    apr: optNum(r.apr),
    minPayment: optNum(r.min_payment),
    color: str(r.color),
    providerAccountId: opt(r.provider_account_id),
    trackPattern: opt(r.track_pattern),
    trackedBaseline: optNum(r.tracked_baseline),
    trackedSince: opt(r.tracked_since),
    createdAt: str(r.created_at),
  };
}

export function toGoal(r: DbRow): SavingsGoal {
  return {
    id: str(r.id),
    name: str(r.name),
    saved: num(r.saved),
    target: num(r.target),
    icon: str(r.icon),
    color: str(r.color),
    createdAt: str(r.created_at),
  };
}

export function toAccount(r: DbRow): Account {
  return {
    id: str(r.id),
    name: str(r.name),
    owner: r.owner as Account["owner"],
    last4: opt(r.last4),
    type: str(r.type) as Account["type"],
    balance: num(r.balance),
    sortOrder: num(r.sort_order),
    providerAccountId: opt(r.provider_account_id),
    pendingHold: num(r.pending_hold),
    createdAt: str(r.created_at),
  };
}

export function toRecurring(r: DbRow): Recurring {
  return {
    id: str(r.id),
    name: str(r.name),
    amount: num(r.amount),
    direction: r.direction as Recurring["direction"],
    cadence: r.cadence as Recurring["cadence"],
    categoryId: opt(r.category_id),
    accountId: opt(r.account_id),
    toAccountId: opt(r.to_account_id),
    owner: r.owner as Recurring["owner"],
    active: !!r.active,
    variable: r.variable === true,
    note: opt(r.note),
    dueDays: Array.isArray(r.due_days) ? (r.due_days as number[]) : undefined,
    anchorDate: opt(r.anchor_date),
    startsOn: opt(r.starts_on),
    endsOn: opt(r.ends_on),
    knownAmount: optNum(r.known_amount),
    linkedDebtId: opt(r.linked_debt_id),
    createdAt: str(r.created_at),
  };
}

export function toPaidBill(r: DbRow): PaidBill {
  return { id: str(r.id), month: str(r.month), billKey: str(r.bill_key), paid: !!r.paid };
}

export function toMerchantRule(r: DbRow): MerchantRule {
  return {
    id: str(r.id),
    pattern: str(r.pattern),
    kind: r.kind as MerchantRule["kind"],
    categoryId: opt(r.category_id),
    billName: opt(r.bill_name),
    createdAt: str(r.created_at),
  };
}

export function toBodyWeight(r: DbRow): BodyWeight {
  return { person: r.person as BodyWeight["person"], date: str(r.date), weight: num(r.weight) };
}

export function toDayLog(r: DbRow): DayLog {
  return {
    date: str(r.date),
    person: r.person as DayLog["person"],
    meals: arr<DayLog["meals"][number]>(r.meals),
    status: (opt(r.status) ?? undefined) as DayLog["status"],
    note: opt(r.note),
  };
}

export function toSavedMeal(r: DbRow): SavedMeal {
  return { id: str(r.id), name: str(r.name), items: arr<SavedMeal["items"][number]>(r.items) };
}

export function toMacroTarget(r: DbRow): MacroTarget {
  return { kcal: num(r.kcal), p: num(r.p), c: num(r.c), f: num(r.f) };
}

export function toWorkout(r: DbRow): Workout {
  return {
    id: str(r.id),
    date: str(r.date),
    person: r.person as Workout["person"],
    name: str(r.name),
    notes: str(r.notes),
    exercises: arr<Workout["exercises"][number]>(r.exercises),
    done: !!r.done,
  };
}

export function toRoutine(r: DbRow): Routine {
  return {
    id: str(r.id),
    person: r.person as Routine["person"],
    name: str(r.name),
    meta: str(r.meta),
    exercises: arr<Routine["exercises"][number]>(r.exercises),
  };
}

/**
 * The finance bundle every finance tool is computed from.
 *
 * TWO FIELDS ARE DELIBERATELY EMPTY, and they are named here rather than left to
 * be discovered:
 *   · `foods` — the shared food library. Nothing on the finance side reads it, and
 *     the meal tools read the per-100g macros snapshotted onto each logged item
 *     rather than the library, so loading it would be a table read per call for
 *     nothing.
 *   · `categories` is NOT empty: it is the app's own DEFAULT_CATEGORIES constant,
 *     which is exactly what src/store/FinanceStore.tsx hands the modules. There is
 *     no categories table.
 *
 * If a future tool needs `foods`, load it — do not read around it.
 */
export function toAppData(tables: {
  transactions: DbRow[];
  debts: DbRow[];
  goals: DbRow[];
  accounts: DbRow[];
  recurring: DbRow[];
  paidBills: DbRow[];
  merchantRules: DbRow[];
}): AppData {
  return {
    transactions: tables.transactions.map(toTransaction),
    debts: tables.debts.map(toDebt),
    goals: tables.goals.map(toGoal),
    categories: DEFAULT_CATEGORIES,
    accounts: tables.accounts.map(toAccount),
    recurring: tables.recurring.map(toRecurring),
    paidBills: tables.paidBills.map(toPaidBill),
    merchantRules: tables.merchantRules.map(toMerchantRule),
    foods: [],
  };
}
