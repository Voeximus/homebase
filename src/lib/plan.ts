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
  { key: "household", label: "Household + hygiene", icon: "🧴", target: 90, cats: ["shopping"], note: "supplies · hygiene" },
  { key: "health", label: "Health + grooming", icon: "💊", target: 110, cats: ["health"], note: "supplements · haircut" },
  { key: "other", label: "Dog · car · subs · misc", icon: "📦", target: 150, cats: ["other", "subscriptions", "entertainment", "kids", "housing", "utilities"], note: "the catch-all" },
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
  "Affirm — Anthropic",
  "Affirm — Amazon",
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

function nextPayday(after: Date, payDays: number[]): Date {
  const day = after.getDate();
  const y = after.getFullYear();
  const m = after.getMonth();
  for (const pd of payDays) if (pd > day) return new Date(y, m, pd);
  return new Date(y, m + 1, payDays[0]);
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
  payDays: number[] = [15, 29],
  split?: SavingsSplit,
): PayoffEvent[] {
  if (monthlyFirepower <= 0) return [];
  const perPay = monthlyFirepower / 2;
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
    const debtFire = perPay - toSavings;

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
        // Free-form living spend only — anything with an appliesTo (a bill, a
        // debt payment, a goal contribution, …) is firepower/fixed, not variable.
        !t.appliesTo,
    )
    .reduce((s, t) => s + t.amount, 0);
}

/** This month's free-form spend grouped by category id (for the budget bars). */
export function spentByCategory(
  transactions: Transaction[],
  monthKey: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of transactions) {
    if (t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo) {
      out[t.categoryId] = (out[t.categoryId] ?? 0) + t.amount;
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

// --- Next ~30 days of income -------------------------------------------------
// The real projected checks, including the one light one (trip hangover).
// Update as checks land / the picture changes.
export interface UpcomingPay {
  label: string;
  amount: number;
  when: string;
  note?: string;
}
export const UPCOMING_INCOME: UpcomingPay[] = [
  { label: "Gino — light check", amount: 1400, when: "~Jun 29", note: "trip hangover · one-time" },
  { label: "Gino — normal check", amount: 1966, when: "~Jul 13", note: "back to normal" },
  { label: "Xinyan — 2 checks", amount: 2374.84, when: "bi-weekly" },
];
