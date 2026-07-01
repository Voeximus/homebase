import type { Recurring, Transaction } from "../types";
import { monthlyAmount } from "./recurring";
import { billExpected, PAY_DAYS } from "./plan";

// Day-of-month each recurring item posts, detected from Mar–Jun 2026 bank
// history (keyed by the recurring row's NAME). Mom posts on each payday (two
// days). Affirm is intentionally absent — multiple installment dates, winding
// down — so it falls into "unscheduled".
export const DUE_DAYS: Record<string, number[]> = {
  Rent: [1],
  "Spot Pet insurance": [4],
  Spotify: [10],
  "Electric (SRP)": [17],
  "Card payment (…4728)": [15],
  Mom: [15, 30],
  Verizon: [17],
  "Claude Pro": [20],
  "Claude Max": [22],
  "LEMONADE INSURANCE": [18],
  "T-Mobile": [29],
  "Card payment (…6813)": [8],
  "Xinyan's 40% share": [1],
};

// Annual memberships / fees — billed once a year on a fixed month+day (month is
// 1-indexed). Shown only in that month at full amount, never amortized monthly.
export const ANNUAL: {
  name: string;
  month: number;
  day: number;
  amount: number;
  owner?: string;
}[] = [
  // Sam's Club — $15 membership + AZ tax = $16.22, paid on Xinyan's debit
  // 2026-06-16, renews each June 16. Pays for itself on bulk groceries + gas.
  { name: "Sam's Club", month: 6, day: 16, amount: 16.22, owner: "Xinyan" },
];

export type FlowDir = "in" | "out" | "transfer";

export interface ScheduleEntry {
  day: number;
  label: string;
  amount: number;
  direction: FlowDir;
  owner?: string;
  recurringId?: string; // the row this came from (absent for annual fees)
  variable?: boolean; // amount is a rolling-average estimate, not a fixed figure
}

export interface MonthlySchedule {
  entries: ScheduleEntry[];
  unscheduled: { label: string; amount: number; direction: FlowDir }[];
}

/** Build a day-ordered list of the month's money movements from recurring rows. */
export function monthlySchedule(
  recurring: Recurring[],
  monthKey?: string,
  transactions?: Transaction[],
): MonthlySchedule {
  const entries: ScheduleEntry[] = [];
  const unscheduled: { label: string; amount: number; direction: FlowDir }[] = [];

  for (const r of recurring) {
    if (!r.active) continue;
    // Variable bills project from the rolling average of recent actuals; fixed
    // bills (and all income/transfers) keep the contracted amount.
    const monthly =
      r.direction !== "in" && r.variable && transactions
        ? billExpected(r, transactions)
        : monthlyAmount(r);

    if (r.direction === "in") {
      const inDays = r.dueDays ?? PAY_DAYS;
      for (const d of inDays) {
        entries.push({
          day: d,
          label: r.name,
          amount: monthly / inDays.length,
          direction: "in",
          owner: r.owner,
          recurringId: r.id,
        });
      }
      continue;
    }

    const dir: FlowDir = r.direction === "transfer" ? "transfer" : "out";
    // Read the row's own due day(s); fall back to the legacy map so it still
    // works before a re-seed bakes due_days onto the rows.
    const days = r.dueDays ?? DUE_DAYS[r.name];
    if (days && days.length) {
      // Known step-downs through June 2026 (the calendar shows the real older
      // amount; the budget already runs on the going-forward figure):
      //  · Mom's support is $400/check through June, then $300/check from July.
      //  · Rent is the discounted $1,232.44 through June (move-in concession),
      //    then the full $1,715 from July.
      let perPayment = monthly / days.length;
      if (monthKey && monthKey <= "2026-06") {
        if (r.name === "Mom") perPayment = 400;
        else if (r.name === "Rent") perPayment = 1232.44;
      }
      for (const d of days) {
        entries.push({
          day: d,
          label: r.name,
          amount: perPayment,
          direction: dir,
          owner: r.owner,
          recurringId: r.id,
          variable: r.variable,
        });
      }
    } else {
      unscheduled.push({ label: r.name, amount: monthly, direction: dir });
    }
  }

  // Annual items appear only in their anniversary month, at full amount.
  if (monthKey) {
    const mNum = parseInt(monthKey.split("-")[1] ?? "0", 10);
    for (const a of ANNUAL) {
      if (a.month === mNum) {
        entries.push({
          day: a.day,
          label: a.name,
          amount: a.amount,
          direction: "out",
          owner: a.owner,
        });
      }
    }
  }

  entries.sort((a, b) => a.day - b.day);
  return { entries, unscheduled };
}

// --- Month-flippable calendar -------------------------------------------------
export interface MonthCalDay {
  day: number;
  in: boolean; // income lands
  out: boolean; // an UNPAID bill is due this day (expected slot)
  pay: boolean; // a paycheck lands (payday marker)
  paid: boolean; // a bill was actually PAID this day (due-marker moved here)
}
export interface MonthCalBill {
  id: string; // recurringId@day (stable key)
  name: string;
  catId: string; // category id → icon + color
  day: number;
  amount: number;
  dateLabel: string; // "Jul 1"
  paid: boolean;
  variable: boolean; // amount is a rolling-average estimate
  recurringId?: string;
}
export interface MonthCalendar {
  year: number;
  month: number; // 0-indexed
  monthKey: string;
  monthLabel: string; // "July 2026"
  daysInMonth: number;
  firstWeekday: number; // weekday (0=Sun) of day 1
  isCurrentMonth: boolean;
  todayNum: number; // day-of-month if current month, else -1 (no "today" shading off-month)
  days: MonthCalDay[]; // only days that carry a dot
  bills: MonthCalBill[]; // every out-bill this month, day-ordered
}

/** Build one month's calendar for ANY month, reusing the schedule engine so
 *  step-downs (Mom 400→300, Rent concession→full) and ANNUAL items render the
 *  correct amount per month.
 *
 *  DUE vs PAID: an unpaid bill shows at its EXPECTED due day with its expected
 *  amount. The moment a recorded payment matches it, the entry SNAPS to the
 *  actual paid date + actual amount and the due-marker for that slot clears — so
 *  each bill appears exactly once a month: "expected" or "paid", never both. This
 *  also makes the Plaid post-lag harmless: the bill sits quietly in "expected"
 *  until the real payment lands, instead of looking overdue. Paid-status is
 *  month-scoped (a recorded payment in THIS month), never the "day ≤ today"
 *  heuristic — so flipping across months never mislabels a bill. */
export function monthCalendar(
  recurring: Recurring[],
  transactions: Transaction[],
  now: Date,
  year: number,
  month: number,
): MonthCalendar {
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const isCurrentMonth = now.getFullYear() === year && now.getMonth() === month;
  const todayNum = isCurrentMonth ? now.getDate() : -1;
  const { entries } = monthlySchedule(recurring, monthKey, transactions);

  const clampDay = (d: number) => Math.min(Math.max(d, 1), daysInMonth);
  const fmtDay = (day: number) =>
    new Date(year, month, clampDay(day)).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // This month's recorded bill payments, grouped by recurring row. A payment
  // carries the ACTUAL date it hit (tx.date) and, in appliesTo.day, which
  // installment it settles (snapped at capture) — match on the installment,
  // DISPLAY on the actual date.
  const paymentsByRec: Record<string, Transaction[]> = {};
  for (const tx of transactions) {
    if (tx.type !== "expense" || tx.appliesTo?.kind !== "bill") continue;
    if (tx.appliesTo.monthKey !== monthKey) continue;
    const rid = tx.appliesTo.recurringId;
    if (rid) (paymentsByRec[rid] ??= []).push(tx);
  }
  const txDay = (tx: Transaction) => parseInt(tx.date.slice(8, 10), 10);
  const claimDay = (tx: Transaction) => tx.appliesTo?.day ?? txDay(tx);

  // Resolve each scheduled OUT installment to its matching payment (→ actual date
  // + amount, paid) or its expected slot. A claimed payment is consumed so two
  // installments (Mom 15/30) never share one; if two payments target one
  // installment the nearest wins and the stray is left for the seed-placeholder
  // cleanup (which removes manual "already paid" rows once the real feed covers
  // the same bill+month).
  const consumed: Record<string, Set<string>> = {};
  const bills: MonthCalBill[] = entries
    .filter((e) => e.direction === "out")
    .map((e) => {
      const rid = e.recurringId;
      let paidTx: Transaction | undefined;
      if (rid) {
        const pool = (paymentsByRec[rid] ?? []).filter((tx) => !consumed[rid]?.has(tx.id));
        if (pool.length) {
          paidTx = pool.reduce(
            (best, tx) => (Math.abs(claimDay(tx) - e.day) < Math.abs(claimDay(best) - e.day) ? tx : best),
            pool[0],
          );
          (consumed[rid] ??= new Set()).add(paidTx.id);
        }
      }
      const paid = !!paidTx;
      const day = clampDay(paid ? txDay(paidTx!) : e.day);
      return {
        id: `${rid ?? e.label}@${e.day}`,
        name: e.label,
        catId: recurring.find((r) => r.id === rid)?.categoryId ?? "other",
        day,
        amount: paid ? Math.abs(paidTx!.amount) : e.amount,
        dateLabel: fmtDay(day),
        paid,
        variable: !!e.variable,
        recurringId: rid,
      };
    })
    .sort((a, b) => a.day - b.day);

  // Calendar dots: income/payday at their days; a bill contributes a "due" dot at
  // its expected day when unpaid, or a "paid" dot at its actual day when paid.
  const calMap: Record<number, { in: boolean; out: boolean; pay: boolean; paid: boolean }> = {};
  const touch = (d: number) => (calMap[d] ??= { in: false, out: false, pay: false, paid: false });
  entries.forEach((e) => {
    if (e.direction === "in") {
      const c = touch(clampDay(e.day));
      c.in = true;
      c.pay = true;
    }
  });
  bills.forEach((b) => {
    const c = touch(b.day);
    if (b.paid) c.paid = true;
    else c.out = true;
  });

  return {
    year,
    month,
    monthKey,
    monthLabel: new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    daysInMonth,
    firstWeekday,
    isCurrentMonth,
    todayNum,
    days: Object.entries(calMap).map(([d, v]) => ({ day: +d, in: v.in, out: v.out, pay: v.pay, paid: v.paid })),
    bills,
  };
}
