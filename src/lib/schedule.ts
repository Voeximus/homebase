import type { Recurring, Transaction } from "../types";
import { monthlyAmount } from "./recurring";

// Day-of-month each recurring item posts, detected from Mar–Jun 2026 bank
// history (keyed by the recurring row's NAME). Mom posts on each payday (two
// days). Affirm is intentionally absent — multiple installment dates, winding
// down — so it falls into "unscheduled".
export const DUE_DAYS: Record<string, number[]> = {
  Rent: [1],
  Apple: [1],
  "Spot Pet insurance": [4],
  Spotify: [10],
  "Electric (SRP)": [13],
  "Card payment (…4728)": [15],
  Mom: [15, 30],
  Verizon: [17],
  "Claude Pro": [20],
  "T-Mobile": [29],
  "Card payment (…6813)": [8],
  "Xinyan's 40% share": [1],
};

// Bi-weekly checks drift, but land ~here. Used to place paydays on the timeline.
export const PAY_DAYS = [15, 29];

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

/** Stable key for a scheduled event's paid-state ("<label>@<day-of-month>"). */
export function billKey(e: { label: string; day: number }): string {
  return `${e.label}@${e.day}`;
}

export interface ScheduleEntry {
  day: number;
  label: string;
  amount: number;
  direction: FlowDir;
  owner?: string;
  recurringId?: string; // the row this came from (absent for annual fees)
}

/** Ledger-derived: has this bill installment been recorded paid this month? */
export function isBillPaid(
  transactions: Transaction[],
  recurringId: string,
  monthKey: string,
  day?: number,
): boolean {
  return transactions.some(
    (t) =>
      t.type === "expense" &&
      t.appliesTo?.kind === "bill" &&
      t.appliesTo.recurringId === recurringId &&
      t.appliesTo.monthKey === monthKey &&
      (day == null || t.appliesTo.day === day),
  );
}

export interface MonthlySchedule {
  entries: ScheduleEntry[];
  unscheduled: { label: string; amount: number; direction: FlowDir }[];
}

/** Build a day-ordered list of the month's money movements from recurring rows. */
export function monthlySchedule(
  recurring: Recurring[],
  monthKey?: string,
): MonthlySchedule {
  const entries: ScheduleEntry[] = [];
  const unscheduled: { label: string; amount: number; direction: FlowDir }[] = [];

  for (const r of recurring) {
    if (!r.active) continue;
    const monthly = monthlyAmount(r);

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
