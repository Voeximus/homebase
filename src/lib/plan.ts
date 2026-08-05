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

// Monthly variable budget — a $1,600 envelope, each line mapping cleanly to how
// transactions categorize (so spent-vs-target is exact).
//
// RE-BASED 2026-07-28 from $1,250. The old number was aspirational: five months of
// actuals never once came in under it (~$1,730 avg), so every month "failed" by
// construction — which made the budget a source of friction rather than a decision
// tool. Each line below is set at or just under REAL July spend, so the envelope is
// a target he can actually hit. The debt payoff gets slower on purpose; Gino's
// company (Knotted Studios) is the priority now, and a budget nobody can hold is
// worth less than a slower plan that holds.
export const LEAN_VARIABLE: BudgetLine[] = [
  { key: "groceries", label: "Groceries", icon: "🛒", target: 600, cats: ["groceries"], note: "measured food" },
  // $250 was set when gas was $4.89–4.99/gal. The Sam's Club card dropped it to
  // ~$3.30 from July, and actual spend runs ~$95/mo — so $50 moves to Misc and this
  // line still carries 2× the real burn.
  { key: "gas", label: "Gas + convenience", icon: "⛽", target: 200, cats: ["transport"], note: "commute · rideshare" },
  { key: "dining", label: "Dining out", icon: "🍽️", target: 250, cats: ["dining"], note: "meals + coffee/boba" },
  // Household + Hygiene = the merged line (was separate "Household" + "Health/grooming").
  // cats keeps the legacy "health" id so any un-migrated row still counts here.
  //
  // It also absorbs the retired "Subscriptions" line ($50): every live subscription
  // (Claude Max / Claude Pro) is modeled as a recurring BILL, so a variable
  // subscriptions line reads $0 by construction — the old one only ever caught
  // cancelled trials (Replit, Grok, Prime, Kindle). Its cats fold in here, along with
  // "housing", so a stray charge in any of them still COUNTS against the envelope
  // instead of escaping it — an uncovered category is invisible to the budget.
  { key: "household", label: "Household + Hygiene", icon: "🧴", target: 350, cats: ["shopping", "health", "subscriptions", "entertainment", "housing"], note: "supplies · hygiene · grooming" },
  // 100 -> 75: five months of actuals run ~$40/mo. Trimmed to fund the lines that
  // were genuinely under-set, not because the dog is getting less.
  { key: "pets", label: "Dog / pets", icon: "🐾", target: 75, cats: ["pets"], note: "food · vet · toys" },
  // The holding pen. "other" is what the categorizer assigns to a merchant it has
  // never seen, so it can't be left off the lines: what's GRADED is what's on a
  // line (see variableSpentThisMonth), and a category on no line would make the
  // breakdown fail to reconcile with the total. The small target is deliberate —
  // this isn't an allowance, it's a prompt: if Misc is over, something needs a
  // real category, not a bigger envelope.
  // 50 -> 125. It stopped being a pure holding pen once Knotted Studios started
  // generating real costs (AZ e-corp filing, GoDaddy, CCA fees = $100 in July) that
  // land here. Still worth watching: if Misc runs high on UNKNOWN merchants rather
  // than company costs, those need real categories, not a bigger envelope.
  { key: "misc", label: "Misc / uncategorized", icon: "📦", target: 125, cats: ["other", "kids"], note: "business costs · unknown merchants" },
];

/** Ungraded, but still real cash out the door — so it can't go at the debt either.
 *  Electronics is Gino's deliberate carve-out ("outside the budget, but it still
 *  takes from what can go at debt"), so it skips the envelope and cuts firepower
 *  directly. `interest` is deliberately NOT here: it never leaves checking — the
 *  bank folds it into the card balance, which the debt total already reads, so
 *  charging it against firepower too would count it twice. */
export const OUTSIDE_BUDGET_CASH_CATS = ["electronics"];

/** Is this category graded against the lean budget? True iff some line claims it.
 *  `electronics` and `interest` deliberately belong to NO line: electronics is
 *  outside-the-budget by design (it's still cash out, so it cuts firepower — see
 *  buildVMs), and interest isn't spending you chose (it's already inside the card
 *  balance the debt total reads from). */
export function inAnyLine(catId: string): boolean {
  return LEAN_VARIABLE.some((l) => l.cats.includes(catId));
}

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

// --- Pay cycles ---------------------------------------------------------------
// The variable budget is graded per PAY CYCLE, not per calendar month. Gino's
// observation, and it's the right unit: money lands on the 15th and the last day,
// and rent hits the 1st — so a calendar month cuts one paycheck's spending in half
// and reports the pieces in two different months. A charge made the evening of the
// 31st, right after the check landed, belongs to the run that check funds.
//
// It also reads better mid-flight: half a cycle is ~7 days, so "51% spent, 8 days
// to go" is actionable, where a month-end verdict arrives too late to change.
// BILLS stay calendar-monthly — rent really is due on the 1st.

export interface PayCycle {
  start: string; // ISO date, inclusive — the payday that opens the cycle
  end: string; // ISO date, inclusive — the day before the next payday
  label: string; // "Jul 31 – Aug 14"
  dayIndex: number; // 1-based position of `now` within the cycle
  days: number; // length of the cycle in days
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The pay cycle containing `now`: from the most recent payday through the day
 *  before the next one. Spans the month boundary by design. */
export function payCycleFor(now: Date, payDays: number[] = PAY_DAYS): PayCycle {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // paydays across the previous, current and next month — enough to bracket `now`
  const cands: Date[] = [];
  for (const off of [-1, 0, 1]) {
    for (const d of payDays) cands.push(paydayDate(now.getFullYear(), now.getMonth() + off, d));
  }
  cands.sort((a, b) => +a - +b);
  let start = cands[0];
  let next = cands[cands.length - 1];
  for (let i = 0; i < cands.length; i++) {
    if (+cands[i] <= +today) {
      start = cands[i];
      next = cands[i + 1] ?? new Date(+cands[i] + 15 * 86400000);
    }
  }
  const end = new Date(+next - 86400000); // inclusive last day
  const DAY = 86400000;
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return {
    start: iso(start),
    end: iso(end),
    label: `${fmt(start)} – ${fmt(end)}`,
    dayIndex: Math.floor((+today - +start) / DAY) + 1,
    days: Math.round((+end - +start) / DAY) + 1,
  };
}

/** How many pay cycles a month holds — the divisor turning a MONTHLY budget line
 *  into a per-cycle allowance. Semimonthly paydays ⇒ 2. */
export const CYCLES_PER_MONTH = PAY_DAYS.length;

/** The per-cycle allowance for the whole envelope (or one line). */
export function perCycle(monthlyAmount: number): number {
  return monthlyAmount / CYCLES_PER_MONTH;
}

export function nextPayday(after: Date, payDays: number[] = PAY_DAYS): Date {
  const y = after.getFullYear();
  const m = after.getMonth();
  const cands = payDays
    .map((pd) => paydayDate(y, m, pd))
    .sort((a, b) => a.getTime() - b.getTime());
  for (const c of cands) if (c.getTime() > after.getTime()) return c;
  return paydayDate(y, m + 1, payDays[0]); // none left this month → next month's first
}

/** The most recent payday on or before `before` — the start of the current pay
 *  cycle (mirror of nextPayday). Used to gate the strategy dial: it opens only
 *  once this cycle's paychecks have landed. */
export function previousPayday(before: Date, payDays: number[] = PAY_DAYS): Date {
  const y = before.getFullYear();
  const m = before.getMonth();
  const cands = payDays
    .map((pd) => paydayDate(y, m, pd))
    .filter((d) => d.getTime() <= before.getTime())
    .sort((a, b) => b.getTime() - a.getTime());
  if (cands.length) return cands[0];
  return paydayDate(y, m - 1, payDays[payDays.length - 1]); // none yet this month → last month's final payday
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
  // Grade exactly what the LINES claim, so the per-line breakdown always sums to
  // this number. Reusing spentByCategory also makes it split-aware: a Sam's run
  // split across pets/groceries/household contributes each slice to its own line,
  // not its whole amount to one. Categories on no line (electronics, interest) are
  // real money but deliberately ungraded — see inAnyLine.
  const byCat = spentByCategory(transactions, monthKey);
  let total = 0;
  for (const [catId, amount] of Object.entries(byCat)) {
    if (inAnyLine(catId)) total += amount;
  }
  return total;
}

/** The SUSTAINABLE variable-spend pace: the average of actual variable spend over
 *  the last `months` COMPLETE calendar months (the current, partial month is
 *  excluded). The payoff timeline projects from this, so the debt-free date drifts
 *  with real behavior — a one-off over-budget month is diluted by the others, a
 *  sustained trend moves the date. Falls back to the budget target until at least
 *  one complete month of spend history exists. */
export function avgVariableSpend(
  transactions: Transaction[],
  now: Date,
  months: number,
  fallback: number,
): number {
  // Only count complete months from the lean-plan start onward — PRE-plan months
  // were normal (higher) spending and would wrongly inflate the "sustainable pace".
  // Until a real post-plan month is banked, fall back to the budget target.
  const floor = PLAN_START.slice(0, 7);
  const totals: number[] = [];
  for (let m = 1; m <= months; m++) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (key < floor) continue; // ignore pre-plan months
    const spent = variableSpentThisMonth(transactions, key);
    if (spent > 0) totals.push(spent); // a month with no data reads 0 → skip it
  }
  if (totals.length === 0) return fallback;
  return totals.reduce((s, t) => s + t, 0) / totals.length;
}

/** This month's free-form spend grouped by category id (for the budget bars).
 *  A split transaction fans its amount across its split categories; an unsplit
 *  one lands wholly on its single category. The total is identical either way. */
export function spentByCategory(
  transactions: Transaction[],
  monthKey: string,
): Record<string, number> {
  return spentByCategoryBetween(transactions, monthKey + "-01", monthKey + "-31");
}

/** Same partition as spentByCategory, over an arbitrary INCLUSIVE date range —
 *  which is what a pay cycle needs, since it straddles the month boundary. */
export function spentByCategoryBetween(
  transactions: Transaction[],
  startISO: string,
  endISO: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of transactions) {
    if (
      t.type === "expense" &&
      t.date >= startISO &&
      t.date <= endISO &&
      !t.appliesTo &&
      !t.pending
    ) {
      if (t.splits && t.splits.length) {
        for (const s of t.splits) out[s.categoryId] = (out[s.categoryId] ?? 0) + s.amount;
      } else {
        out[t.categoryId] = (out[t.categoryId] ?? 0) + t.amount;
      }
    }
  }
  return out;
}

/** Graded variable spend over a date range — the pay-cycle counterpart of
 *  variableSpentThisMonth. Same rule: only categories a budget line claims. */
export function variableSpentBetween(
  transactions: Transaction[],
  startISO: string,
  endISO: string,
): number {
  const byCat = spentByCategoryBetween(transactions, startISO, endISO);
  let total = 0;
  for (const [catId, amount] of Object.entries(byCat)) {
    if (inAnyLine(catId)) total += amount;
  }
  return total;
}

// --- The 90-day commitment ---------------------------------------------------
// The real point isn't a debt deadline — it's 90 days of dedicated good habits.
// Debt-free is the scoreboard; the timeline can flex.
export const PLAN_START = "2026-06-16"; // the day Gino + Xinyan committed
export const PLAN_DAYS = 90;

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

