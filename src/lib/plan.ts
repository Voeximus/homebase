// "The 3-Month Plan" — Gino + Xinyan's lean, all-in, single-goal debt sprint.
// Variable spend is rebuilt from a lean perspective to maximize debt firepower;
// the four other life-goals (China / studio / emergency) are parked for now.
//
// These are the DESIGNED targets (locked with Gino 2026-06-16). Debts are read
// LIVE from the store, so the countdown and progress update as he pays them down.

import type { Debt, Recurring, Transaction } from "../types";
import { householdMonthly, monthlyAmount } from "./recurring";

export interface BudgetLine {
  key: string;
  label: string;
  icon: string;
  target: number;
  cats: string[]; // app transaction categories this line tracks (a clean partition)
  note?: string;
}

// Lean monthly variable budget — same $1,250 envelope, regrouped so each line
// maps cleanly to how transactions categorize (so spent-vs-target is exact).
export const LEAN_VARIABLE: BudgetLine[] = [
  { key: "groceries", label: "Groceries", icon: "🛒", target: 500, cats: ["groceries"], note: "measured food" },
  { key: "gas", label: "Gas + convenience", icon: "⛽", target: 250, cats: ["transport"], note: "commute · rideshare" },
  { key: "dining", label: "Dining out", icon: "🍽️", target: 150, cats: ["dining"], note: "a few times, to enjoy life" },
  // Household + Hygiene = the merged line (was separate "Household" + "Health/grooming").
  // cats keeps the legacy "health" id so any un-migrated row still counts here.
  { key: "household", label: "Household + Hygiene", icon: "🧴", target: 200, cats: ["shopping", "health"], note: "supplies · hygiene · grooming" },
  { key: "pets", label: "Dog / pets", icon: "🐾", target: 100, cats: ["pets"], note: "food · vet · toys" },
  { key: "subscriptions", label: "Subscriptions", icon: "🔁", target: 50, cats: ["subscriptions", "entertainment"], note: "streaming · apps" },
];

export interface OneTime {
  label: string;
  amount: number;
  icon: string;
  note?: string;
}

// Lumpy costs that land during the sprint — paid from the cash cushion, not the
// monthly firepower, so they don't slow the payoff.
export const ONE_TIMES: OneTime[] = [
  { label: "Dental deep-clean", amount: 482, icon: "🦷", note: "time it inside the sprint" },
  { label: "Car registration", amount: 200, icon: "🚗", note: "notice expected · estimate" },
];

// Renters insurance — a fixed cost found during the audit, not yet in the live
// recurring table, so it's folded into the plan's fixed total here.
export const RENTERS_INSURANCE = 10.59;

// Debt attack order (Gino's snowball — smallest first; clears the Affirms,
// Xinyan's card and the family debt fast, then crushes the 19.99% card).
export const ATTACK_ORDER = [
  "Affirm",
  "Xinyan card (…6813)",
  "Mom (China)",
  "Credit card (…4728)",
];

/** Live debts sorted into the attack order (unknown names fall to the back, by balance). */
export function orderedDebts(debts: Debt[]): Debt[] {
  const rank = (d: Debt) => {
    const i = ATTACK_ORDER.findIndex((n) => d.name === n);
    return i === -1 ? 999 : i;
  };
  return [...debts].sort((a, b) => rank(a) - rank(b) || a.balance - b.balance);
}

export interface PlanMath {
  income: number;
  fixed: number;
  fixedNonDebt: number;
  debtPaymentsInFixed: number;
  variable: number;
  firepower: number; // monthly $ aimed at the debt
  totalDebt: number;
}

// The recurring rows that are really debt payments — those dollars are firepower,
// not living costs, so they're added back when computing what's aimed at the debt.
const DEBT_PAYMENT_RX = /card payment|affirm/i;

export function planMath(
  recurring: Recurring[],
  debts: Debt[],
  variable: number,
): PlanMath {
  const hh = householdMonthly(recurring);
  const income = hh.income;
  const fixed = hh.bills + RENTERS_INSURANCE;
  const debtPaymentsInFixed = recurring
    .filter((r) => r.active && r.direction === "out" && DEBT_PAYMENT_RX.test(r.name))
    .reduce((s, r) => s + monthlyAmount(r), 0);
  const fixedNonDebt = fixed - debtPaymentsInFixed;
  const firepower = income - fixedNonDebt - variable;
  const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
  return { income, fixed, fixedNonDebt, debtPaymentsInFixed, variable, firepower, totalDebt };
}

export function sumTargets(lines: BudgetLine[]): number {
  return lines.reduce((s, l) => s + l.target, 0);
}

/** What's been spent against a single budget line (sums its mapped categories). */
export function lineSpent(line: BudgetLine, byCat: Record<string, number>): number {
  return line.cats.reduce((s, c) => s + (byCat[c] ?? 0), 0);
}

/** The amount to PROJECT for a recurring bill this cycle.
 *   - Fixed bills (!variable): the modeled amount — it doesn't move.
 *   - Variable bills (Electric/SRP, a card payment): the rolling average of the
 *     last 3 ACTUAL payments recorded for this bill, so the forecast tracks
 *     reality. Falls back to the modeled amount until a real payment is seen.
 *  An "actual" = a ledger row whose appliesTo links this bill — exactly the rows
 *  the bank feed and the import path write. One source of truth (the ledger). */
export function billExpected(bill: Recurring, transactions: Transaction[]): number {
  if (!bill.variable) return bill.amount;
  const actuals = transactions
    .filter(
      (t) => t.appliesTo?.kind === "bill" && t.appliesTo.recurringId === bill.id && t.type === "expense",
    )
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // most recent first
      const am = a.appliesTo?.monthKey ?? "",
        bm = b.appliesTo?.monthKey ?? "";
      if (am !== bm) return am < bm ? 1 : -1;
      return (b.appliesTo?.day ?? 0) - (a.appliesTo?.day ?? 0);
    })
    .slice(0, 3)
    .map((t) => t.amount);
  if (actuals.length < 1) return bill.amount;
  return actuals.reduce((s, a) => s + a, 0) / actuals.length;
}

// --- The dollar-by-dollar payoff schedule ------------------------------------
// Pay days land ~15th and ~29th. Each payday we throw half the monthly firepower
// at the debts in attack order, accruing interest along the way, until $0.
export interface PayoffPayment {
  debtId: string;
  name: string;
  amount: number;
  clears: boolean; // this payment zeroes the debt
}
export interface PayoffEvent {
  date: Date;
  payments: PayoffPayment[];
  total: number; // total sent this payday (debt + savings)
  toDebt: number; // portion to debts
  toSavings: number; // portion skimmed for savings (0 before the split)
  savingsKind: "emergency" | "investing" | null;
  emergencyBalance: number; // running emergency-fund balance
  interest: number; // interest that accrued before this payday
  remaining: number; // total debt left after this payday
}

// The plan change (Gino + Xinyan, 2026-06-17): ONCE every debt except the …4728
// card is cleared, skim $500/check into savings — emergency fund first to $1,500,
// then it rolls into investing/goals — and the rest keeps hitting the card. Until
// the card is the last one standing, every check stays all-at-debt (snowball).
export interface SavingsSplit {
  perCheck: number; // $ skimmed off each check for savings
  emergencyTarget: number; // fill emergency to here, then redirect to investing
}
export const SAVINGS_SPLIT: SavingsSplit = { perCheck: 500, emergencyTarget: 1500 };

// Pay-day model: Gino is paid semi-monthly — the 15th and month-end. A payDay of
// 31 is the "month-end" sentinel: it resolves to the real last day (30/31, or
// 28/29 in Feb). Actual deposits can drift ±2-3 days around it (weekends /
// holidays); the bank feed reconciles to the true date when a check posts.
export const PAY_DAYS = [15, 31];

export function paydayDate(year: number, month: number, payDay: number): Date {
  return payDay >= 31 ? new Date(year, month + 1, 0) : new Date(year, month, payDay);
}

function nextPayday(after: Date, payDays: number[]): Date {
  const y = after.getFullYear();
  const m = after.getMonth();
  const cands = payDays
    .map((pd) => paydayDate(y, m, pd))
    .sort((a, b) => a.getTime() - b.getTime());
  for (const c of cands) if (c.getTime() > after.getTime()) return c;
  return paydayDate(y, m + 1, payDays[0]); // none left this month → next month's first
}

/**
 * Payday-by-payday snowball schedule. Returns one event per payday: the date,
 * which debts got hit and by how much, the interest that accrued, and the total
 * left. This is the concrete "here's exactly what to send, and when" plan.
 */
export function payoffSchedule(
  debtsOrdered: Debt[],
  monthlyFirepower: number,
  from: Date,
  payDays: number[] = PAY_DAYS,
  split?: SavingsSplit,
  // This month's budget overspend, applied as a ONE-TIME debit on the earliest
  // paydays only (then full firepower resumes). Pass the SUSTAINABLE monthly
  // firepower as `monthlyFirepower` so a single over-budget month dents the
  // payoff now without projecting forward as if every future month is over.
  oneTimeReduction = 0,
): PayoffEvent[] {
  if (monthlyFirepower <= 0) return [];
  const perPay = monthlyFirepower / 2;
  let reduction = Math.max(0, oneTimeReduction);
  const bal = debtsOrdered.map((d) => ({
    id: d.id,
    name: d.name,
    balance: d.balance,
    rate: (d.apr ?? 0) / 100 / 24, // per-payday (~24 paydays/yr)
  }));
  const events: PayoffEvent[] = [];
  let emergency = 0;
  let date = nextPayday(from, payDays);
  let guard = 0;

  while (bal.some((b) => b.balance > 0.005) && guard++ < 240) {
    // The split only starts once the card is the ONLY debt left (everything
    // smaller is snowballed away first). Then skim the savings slice off the top.
    const cardOnly = bal.filter((b) => b.balance > 0.005).length === 1;
    let toSavings = 0;
    let savingsKind: "emergency" | "investing" | null = null;
    if (split && cardOnly) {
      toSavings = Math.min(split.perCheck, perPay);
      const emShare = Math.min(toSavings, Math.max(0, split.emergencyTarget - emergency));
      emergency += emShare;
      savingsKind = emShare > 0.005 ? "emergency" : "investing";
    }
    // Debit this month's overspend off the earliest paydays, then it's gone —
    // a one-off over-budget month never compounds into the long-term timeline.
    const reduce = Math.min(reduction, perPay - toSavings);
    reduction -= reduce;
    const debtFire = perPay - toSavings - reduce;

    let interest = 0;
    for (const b of bal)
      if (b.balance > 0) {
        const i = b.balance * b.rate;
        b.balance += i;
        interest += i;
      }
    let fire = debtFire;
    const payments: PayoffPayment[] = [];
    for (const b of bal) {
      if (fire <= 0.005) break;
      if (b.balance <= 0.005) continue;
      const pay = Math.min(fire, b.balance);
      b.balance -= pay;
      fire -= pay;
      payments.push({ debtId: b.id, name: b.name, amount: pay, clears: b.balance <= 0.005 });
    }
    const toDebt = debtFire - fire;
    const remaining = bal.reduce((s, b) => s + Math.max(0, b.balance), 0);
    events.push({
      date: new Date(date),
      payments,
      total: toDebt + toSavings,
      toDebt,
      toSavings,
      savingsKind,
      emergencyBalance: emergency,
      interest,
      remaining,
    });
    date = nextPayday(date, payDays);
  }
  return events;
}

/**
 * What's actually been spent on *variable* living this month — the free-form
 * purchases (groceries, gas, dining, …) logged to the ledger. Excludes bill and
 * debt payments (those have an appliesTo), so it measures the lean budget only.
 * This is the live "actual" the budget targets are graded against.
 */
export function variableSpentThisMonth(
  transactions: Transaction[],
  monthKey: string,
): number {
  return transactions
    .filter(
      (t) =>
        t.type === "expense" &&
        t.date.slice(0, 7) === monthKey &&
        !t.pending && // still-processing charges don't count until they post
        // Free-form living spend only — anything with an appliesTo (a bill, a
        // debt payment, a goal contribution, …) is firepower/fixed, not variable.
        !t.appliesTo,
    )
    .reduce((s, t) => s + t.amount, 0);
}

/** This month's free-form spend grouped by category id (for the budget bars).
 *  A split transaction fans its amount across its split categories; an unsplit
 *  one lands wholly on its single category. The total is identical either way. */
export function spentByCategory(
  transactions: Transaction[],
  monthKey: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of transactions) {
    if (t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo && !t.pending) {
      if (t.splits && t.splits.length) {
        for (const s of t.splits) out[s.categoryId] = (out[s.categoryId] ?? 0) + s.amount;
      } else {
        out[t.categoryId] = (out[t.categoryId] ?? 0) + t.amount;
      }
    }
  }
  return out;
}

// --- The 90-day commitment ---------------------------------------------------
// The real point isn't a debt deadline — it's 90 days of dedicated good habits.
// Debt-free is the scoreboard; the timeline can flex.
export const PLAN_START = "2026-06-16"; // the day Gino + Xinyan committed
export const PLAN_DAYS = 90;

export const HABITS: { icon: string; label: string }[] = [
  { icon: "🍽️", label: "Measured food" },
  { icon: "💪", label: "Gym + training" },
  { icon: "💸", label: "Lean spending" },
  { icon: "🚫", label: "No impulse buys" },
];

export interface Commitment {
  day: number;
  total: number;
  pct: number;
  endDate: Date;
}

export function commitmentProgress(now: Date): Commitment {
  const start = new Date(PLAN_START + "T00:00:00");
  const elapsed = Math.floor((now.getTime() - start.getTime()) / 864e5);
  const day = Math.min(PLAN_DAYS, Math.max(1, elapsed + 1));
  const endDate = new Date(start.getTime() + PLAN_DAYS * 864e5);
  return { day, total: PLAN_DAYS, pct: (day / PLAN_DAYS) * 100, endDate };
}

// --- Upcoming income ----------------------------------------------------------
// Derived from the live income rows (one source of truth) so it always matches
// the calendar — no hand-kept list to go stale. Each is a SOFT target: the
// scheduled payday can slide ±2-3 days, and the bank feed confirms the real date
// once the check posts.
export interface UpcomingPay {
  label: string;
  amount: number; // this single check (the monthly amount split across its paydays)
  date: Date;
}
export function upcomingIncome(
  recurring: Recurring[],
  from: Date,
  count = 4,
): UpcomingPay[] {
  const startOfDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const out: UpcomingPay[] = [];
  for (let m = 0; m < 5; m++) {
    const y = from.getFullYear();
    const mo = from.getMonth() + m;
    for (const r of recurring) {
      if (!r.active || r.direction !== "in") continue;
      const days = r.dueDays ?? PAY_DAYS;
      const perCheck = monthlyAmount(r) / days.length;
      for (const d of days) {
        const date = paydayDate(y, mo, d);
        if (date.getTime() >= startOfDay.getTime()) {
          out.push({ label: r.name, amount: perCheck, date });
        }
      }
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, count);
}
