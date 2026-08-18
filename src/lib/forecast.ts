import type { Debt, Recurring, Transaction } from "../types";
import { monthCalendar, monthlySchedule } from "./schedule";
import { monthKeyOf } from "./format";

// ── Forward projection ────────────────────────────────────────────────────────
// Everything the Bills screen already knows, run forward N months instead of one.
// The month-by-month shape is what a single month can't show: that Mom's support
// restarts in November, that the dental plan ends in January, that two months a
// year carry a third paycheck, and what any of that leaves over.
//
// Nothing here is hardcoded — bills, income and their windows all come from the
// same recurring rows the calendar reads, so the forecast can't drift from it.

export interface ForecastLine {
  name: string;
  amount: number;
}

export interface ForecastMonth {
  monthKey: string; // "YYYY-MM"
  label: string; // "Nov 26"
  income: number;
  bills: number;
  spend: number;
  surplus: number;
  incomeEvents: number; // how many paychecks land — 3 in the biweekly overflow months
  lines: ForecastLine[];
  cardCleared?: boolean; // the month the card balance hits zero
  /** The CURRENT month, counted from today forward instead of whole. Its figures
   *  are "what's left", not a full month, so it must never be compared against a
   *  whole one — summarize() excludes it from steady/best/worst for that reason. */
  partial?: boolean;
}

export interface ForecastOpts {
  /** Monthly payment at the tracked card. Overrides the row's contracted amount. */
  cardPay?: number;
  /** Variable spending PER PAY CYCLE. Two cycles a month. */
  cycleSpend: number;
  /** The debt the card-payment row services, so payoff can be simulated. */
  cardDebtId?: string;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Shift a month key by n months. */
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MON[m - 1]} ${String(y).slice(2)}`;
}

export function forecast(
  recurring: Recurring[],
  transactions: Transaction[],
  debts: Debt[],
  startMonth: string,
  count: number,
  opts: ForecastOpts,
  now: Date = new Date(),
): ForecastMonth[] {
  const out: ForecastMonth[] = [];
  // The first row is THE CURRENT MONTH, and the user reads it as "the rest of this
  // month". It used to be counted whole, so rent already drafted on the 1st and
  // paychecks already banked were both projected as still to come — the row
  // overstated BOTH sides, and because summarize() folded it in, that one broken
  // month could be reported as the best and the worst month of the year at once.
  //
  // So month 0 is now counted from today forward: bills the calendar already knows
  // are paid drop out, paychecks that have already landed drop out, and variable
  // spend is prorated across the days that are left.
  const partialKey = monthKeyOf(now);
  const todayDay = now.getDate();
  // Which (recurringId, day) installments are already settled this month. Taken
  // from monthCalendar because that is the one place paid-vs-unpaid is resolved
  // properly — it matches a recorded payment to its installment and handles an
  // early payment landing in a previous month. An unpaid bill whose due day has
  // already passed is deliberately still counted: it is still owed.
  const settled = new Set<string>();
  {
    const cal = monthCalendar(recurring, transactions, now, now.getFullYear(), now.getMonth(), debts);
    for (const b of cal.bills) if (b.paid && b.recurringId) settled.add(`${b.recurringId}|${b.day}`);
  }
  const card = opts.cardDebtId ? debts.find((d) => d.id === opts.cardDebtId) : undefined;
  // The card is paid down as the projection walks forward, so the month its
  // balance clears is the month its payment line disappears — and the surplus
  // jumps by exactly that payment. A static bill list can't show that.
  let cardBal = card?.balance ?? 0;
  const apr = card?.apr ?? 0;

  for (let i = 0; i < count; i++) {
    const monthKey = addMonths(startMonth, i);
    // Feed the simulated balance back in so a cleared card stops billing, using
    // the same linkedDebtId gate the live calendar already applies.
    const simDebts = card ? debts.map((d) => (d.id === card.id ? { ...d, balance: cardBal } : d)) : debts;
    const sched = monthlySchedule(recurring, monthKey, transactions, simDebts);
    const partial = monthKey === partialKey;

    let income = 0;
    let incomeEvents = 0;
    const lines: ForecastLine[] = [];
    const byName = new Map<string, number>();

    for (const e of sched.entries) {
      if (e.direction === "in") {
        // A paycheck that has already landed is not still coming.
        if (partial && e.day < todayDay) continue;
        income += e.amount;
        incomeEvents++;
        continue;
      }
      if (e.direction === "transfer") continue; // moves money between our own accounts
      // A bill the calendar already shows paid is not still going out. Note this
      // keys on the installment, not the day — so Mom's 15th and 30th settle
      // independently.
      if (partial && e.recurringId && settled.has(`${e.recurringId}|${e.day}`)) continue;
      let amt = e.amount;
      if (card && opts.cardPay != null && e.recurringId && isCardRow(recurring, e.recurringId, card.id)) {
        amt = Math.min(opts.cardPay, cardBal + cardBal * (apr / 100) / 12);
      }
      byName.set(e.label, (byName.get(e.label) ?? 0) + amt);
    }

    for (const [name, amount] of byName) lines.push({ name, amount });

    const bills = lines.reduce((s, l) => s + l.amount, 0);
    // Variable spend is a whole-month figure, so in a partial month it is prorated
    // across the days that are left. Assumes the current rate continues, which is
    // the same assumption the full months already make.
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = Math.max(0, daysInMonth - todayDay + 1); // today counts
    const spend = partial ? (opts.cycleSpend * 2 * daysLeft) / daysInMonth : opts.cycleSpend * 2;

    // Walk the card forward by whatever actually went at it this month.
    let cardCleared = false;
    if (card && cardBal > 0) {
      const paid = lines.find((l) => isCardName(l.name))?.amount ?? 0;
      cardBal = cardBal + (cardBal * (apr / 100)) / 12 - paid;
      if (cardBal <= 0) {
        cardBal = 0;
        cardCleared = true;
      }
    }

    out.push({
      monthKey,
      label: monthLabel(monthKey),
      income,
      bills,
      spend,
      surplus: income - bills - spend,
      incomeEvents,
      lines: lines.sort((a, b) => b.amount - a.amount),
      cardCleared,
      ...(partial ? { partial: true } : {}),
    });
  }
  return out;
}

function isCardRow(recurring: Recurring[], recurringId: string, debtId: string): boolean {
  return recurring.some((r) => r.id === recurringId && r.linkedDebtId === debtId);
}
function isCardName(name: string): boolean {
  return /^card payment/i.test(name);
}

/** Rolled-up view of a run: the steady-state month and where it changes. */
export interface ForecastSummary {
  steady: number; // the most common surplus — the number to plan on
  best: ForecastMonth;
  worst: ForecastMonth;
  total: number;
  clearsOn?: string; // label of the month the card dies
}

export function summarize(months: ForecastMonth[]): ForecastSummary | null {
  if (!months.length) return null;
  // A PARTIAL month is "the rest of this month" — a fraction of a month's bills
  // and a fraction of its income. Comparing it against whole months is meaningless
  // and actively misleading: before month 0 was excluded here, that one row could
  // be reported as both the best and the worst month of the twelve, because it was
  // the only row in the list measuring a different span of time.
  //
  // The TOTAL still includes it, because those are real dollars over the window
  // the forecast actually covers.
  const whole = months.filter((m) => !m.partial);
  const cmp = whole.length ? whole : months; // never divide by nothing
  const rounded = cmp.map((m) => Math.round(m.surplus));
  const freq = new Map<number, number>();
  for (const v of rounded) freq.set(v, (freq.get(v) ?? 0) + 1);
  const steady = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    steady,
    best: cmp.reduce((a, b) => (b.surplus > a.surplus ? b : a)),
    worst: cmp.reduce((a, b) => (b.surplus < a.surplus ? b : a)),
    total: months.reduce((s, m) => s + m.surplus, 0),
    clearsOn: months.find((m) => m.cardCleared)?.label,
  };
}
