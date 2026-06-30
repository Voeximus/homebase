import type { Recurring, Transaction } from "../types";
import { monthlyAmount } from "./recurring";
import { billExpected, PAY_DAYS, nextPayday } from "./plan";

// Day-of-month each recurring item posts, detected from Mar–Jun 2026 bank
// history (keyed by the recurring row's NAME). Mom posts on each payday (two
// days). Affirm is intentionally absent — multiple installment dates, winding
// down — so it falls into "unscheduled".
export const DUE_DAYS: Record<string, number[]> = {
  Rent: [1],
  "Spot Pet insurance": [4],
  Spotify: [10],
  "Electric (SRP)": [13],
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

/** Map the recurring entries onto a specific month's days, clamping any day
 *  past month-end (e.g. the "30th" lands on Feb 28). Keyed by day number. */
export function eventsForMonth(
  entries: ScheduleEntry[],
  daysInMonth: number,
): Map<number, ScheduleEntry[]> {
  const map = new Map<number, ScheduleEntry[]>();
  for (const e of entries) {
    const d = Math.min(e.day, daysInMonth);
    const arr = map.get(d) ?? [];
    arr.push(e);
    map.set(d, arr);
  }
  return map;
}

/** The AUTO half of the deploy hold-back: the OUT bills landing between today and
 *  your next paycheck (inclusive), spanning the month boundary when the next
 *  payday is in the following month (e.g. today the 30th → next check the 15th).
 *  Already-paid bills are dropped via the injected predicate. */
export function billsBeforeNextPayday(
  recurring: Recurring[],
  transactions: Transaction[],
  now: Date,
  isBillPaid: (entry: ScheduleEntry, monthKey: string) => boolean = () => false,
): number {
  const next = nextPayday(now);
  const startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endMs = new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime();

  let total = 0;
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-indexed
  const ey = next.getFullYear();
  const em = next.getMonth();
  // Walk every month the [today, next payday] window touches (at most two).
  while (y < ey || (y === ey && m <= em)) {
    const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const { entries } = monthlySchedule(recurring, monthKey, transactions);
    for (const e of entries) {
      if (e.direction !== "out") continue;
      const day = Math.min(e.day, daysInMonth);
      const dMs = new Date(y, m, day).getTime();
      if (dMs >= startMs && dMs <= endMs && !isBillPaid(e, monthKey)) total += e.amount;
    }
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return total;
}

// --- Month-flippable calendar -------------------------------------------------
export interface MonthCalDay {
  day: number;
  in: boolean; // income lands
  out: boolean; // a bill is due
  pay: boolean; // a paycheck lands (payday marker)
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
 *  correct amount per month. Paid-status is month-scoped (a recorded payment in
 *  THIS month), never the current-month "day ≤ today" heuristic — so flipping to a
 *  past/future month never mislabels a bill as paid. */
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

  // Day-snapping table so a recorded payment maps to the right installment
  // (multi-installment bills like Mom 15/30).
  const recDays: Record<string, number[]> = {};
  entries.forEach((e) => {
    if (e.direction === "out" && e.recurringId) (recDays[e.recurringId] ??= []).push(e.day);
  });
  const paidEntry = (e: ScheduleEntry): boolean => {
    if (!e.recurringId) return false; // annual/non-recurring: no recorded link to match
    return !!transactions.find((tx) => {
      if (tx.type !== "expense" || tx.appliesTo?.kind !== "bill") return false;
      if (tx.appliesTo.recurringId !== e.recurringId || tx.appliesTo.monthKey !== monthKey) return false;
      const days = recDays[e.recurringId!] ?? [e.day];
      const rd = tx.appliesTo.day;
      if (rd == null) return days.length === 1;
      const nearest = days.reduce((b, d) => (Math.abs(d - rd) < Math.abs(b - rd) ? d : b), days[0]);
      return nearest === e.day;
    });
  };

  const calMap: Record<number, { in: boolean; out: boolean; pay: boolean }> = {};
  entries.forEach((e) => {
    const d = Math.min(e.day, daysInMonth);
    calMap[d] ??= { in: false, out: false, pay: false };
    if (e.direction === "in") {
      calMap[d].in = true;
      calMap[d].pay = true;
    } else if (e.direction === "out") {
      calMap[d].out = true;
    }
  });

  const fmtDay = (day: number) =>
    new Date(year, month, Math.min(day, daysInMonth)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

  const bills: MonthCalBill[] = entries
    .filter((e) => e.direction === "out")
    .sort((a, b) => a.day - b.day)
    .map((e) => ({
      id: `${e.recurringId ?? e.label}@${e.day}`,
      name: e.label,
      catId: recurring.find((r) => r.id === e.recurringId)?.categoryId ?? "other",
      day: e.day,
      amount: e.amount,
      dateLabel: fmtDay(e.day),
      paid: paidEntry(e),
      variable: !!e.variable,
      recurringId: e.recurringId,
    }));

  return {
    year,
    month,
    monthKey,
    monthLabel: new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    daysInMonth,
    firstWeekday,
    isCurrentMonth,
    todayNum,
    days: Object.entries(calMap).map(([d, v]) => ({ day: +d, in: v.in, out: v.out, pay: v.pay })),
    bills,
  };
}
