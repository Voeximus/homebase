import type { Debt, Recurring, Transaction } from "../types";
import { monthlySchedule } from "./schedule";

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
  synthetic?: boolean; // a what-if the user dialled in, not a row in the database
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
}

export interface ForecastOpts {
  /** Monthly payment at the tracked card. Overrides the row's contracted amount. */
  cardPay?: number;
  /** A car payment that doesn't exist in the database yet. */
  carPay?: number;
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
): ForecastMonth[] {
  const out: ForecastMonth[] = [];
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

    let income = 0;
    let incomeEvents = 0;
    const lines: ForecastLine[] = [];
    const byName = new Map<string, number>();

    for (const e of sched.entries) {
      if (e.direction === "in") {
        income += e.amount;
        incomeEvents++;
        continue;
      }
      if (e.direction === "transfer") continue; // moves money between our own accounts
      let amt = e.amount;
      if (card && opts.cardPay != null && e.recurringId && isCardRow(recurring, e.recurringId, card.id)) {
        amt = Math.min(opts.cardPay, cardBal + cardBal * (apr / 100) / 12);
      }
      byName.set(e.label, (byName.get(e.label) ?? 0) + amt);
    }

    for (const [name, amount] of byName) lines.push({ name, amount });
    if (opts.carPay) lines.push({ name: "Car payment", amount: opts.carPay, synthetic: true });

    const bills = lines.reduce((s, l) => s + l.amount, 0);
    const spend = opts.cycleSpend * 2;

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
  const rounded = months.map((m) => Math.round(m.surplus));
  const freq = new Map<number, number>();
  for (const v of rounded) freq.set(v, (freq.get(v) ?? 0) + 1);
  const steady = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return {
    steady,
    best: months.reduce((a, b) => (b.surplus > a.surplus ? b : a)),
    worst: months.reduce((a, b) => (b.surplus < a.surplus ? b : a)),
    total: months.reduce((s, m) => s + m.surplus, 0),
    clearsOn: months.find((m) => m.cardCleared)?.label,
  };
}
