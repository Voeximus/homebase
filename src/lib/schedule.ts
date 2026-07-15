import type { Cadence, Recurring, Transaction } from "../types";
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

// How many months apart a bill repeats, for the cadences that DON'T fire every
// month. Monthly and sub-monthly cadences are absent: their due_days already
// carry the whole schedule, so they fire in every month.
const PERIOD_MONTHS: Partial<Record<Cadence, number>> = {
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

/** Does a longer-than-monthly bill fire in this month? Its anchorDate names one
 *  month it's known to hit; it repeats every `period` months from there, forwards
 *  and backwards (so past months render correctly too). A periodic bill with no
 *  anchor can't be placed — we let it through rather than hide a real bill, and
 *  it behaves as it did before. Monthly cadences always fire. */
export function firesInMonth(r: Recurring, monthKey: string): boolean {
  const period = PERIOD_MONTHS[r.cadence];
  if (!period) return true;
  if (!r.anchorDate) return true;
  const [ay, am] = r.anchorDate.split("-").map(Number);
  const [y, m] = monthKey.split("-").map(Number);
  const delta = (y - ay) * 12 + (m - am);
  return ((delta % period) + period) % period === 0;
}

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
    // A longer-than-monthly bill (yearly membership, semiannual insurance) belongs
    // ONLY to its anniversary month, at the FULL charge — never amortized into every
    // month. monthlyAmount() would spread a $16.22 yearly fee into $1.35 × 12, which
    // is right for a budget average but wrong for a calendar of real due dates.
    const period = PERIOD_MONTHS[r.cadence];
    if (period) {
      if (!monthKey || !firesInMonth(r, monthKey)) continue;
    }
    // Read the row's own due day(s); fall back to the legacy map so it still
    // works before a re-seed bakes due_days onto the rows.
    const days = r.dueDays ?? DUE_DAYS[r.name];
    if (days && days.length) {
      // Known step-downs through June 2026 (the calendar shows the real older
      // amount; the budget already runs on the going-forward figure):
      //  · Mom's support is $400/check through June, then $300/check from July.
      //  · Rent is the discounted $1,232.44 through June (move-in concession),
      //    then the full $1,715 from July.
      let perPayment = period ? r.amount : monthly / days.length;
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

  entries.sort((a, b) => a.day - b.day);
  return { entries, unscheduled };
}

/** Which bill CYCLE a payment settles. A payment is "for" the earliest due date
 *  it lands on or before — or at most GRACE days after. So an early payment (Jun
 *  30 toward a Jul-17 bill) rolls forward to the NEXT cycle instead of counting as
 *  a very-late payment on the current one; an on-time or slightly-late payment
 *  stays on the current cycle. Returns the chosen installment's month + due day.
 *  MIRRORED in supabase/functions/plaid/index.ts (billAppliesTo) — keep in step. */
export function billCycleFor(
  dueDays: number[] | undefined,
  isoDate: string,
): { monthKey: string; day: number } {
  const [py, pm, pd] = isoDate.split("-").map(Number);
  const days = dueDays && dueDays.length ? dueDays : [pd];
  const GRACE_MS = 7 * 86400000; // pay up to a week late for a cycle; beyond that it's prepaying the next
  const pay = Date.UTC(py, pm - 1, pd);
  const cands: { y: number; m: number; day: number; due: number }[] = [];
  for (const off of [0, 1]) {
    // this payment-month and the next, at each due day (clamped to month length)
    const y = pm - 1 + off >= 12 ? py + 1 : py;
    const m0 = (pm - 1 + off) % 12;
    const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    for (const dd of days) {
      const day = Math.min(dd, dim);
      cands.push({ y, m: m0, day, due: Date.UTC(y, m0, day) });
    }
  }
  cands.sort((a, b) => a.due - b.due);
  const c = cands.find((k) => pay <= k.due + GRACE_MS) ?? cands[cands.length - 1];
  return { monthKey: `${c.y}-${String(c.m + 1).padStart(2, "0")}`, day: c.day };
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
  day: number; // the DUE day — the bill is always anchored here, paid or not
  amount: number; // paid → the actual amount paid; unpaid → the expected amount
  dateLabel: string; // the DUE date, e.g. "Jul 17"
  paid: boolean;
  paidDate?: string; // when it actually got paid, e.g. "Jun 30" (may be a prior month for an early payment)
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
 *  step-downs (Mom 400→300, Rent concession→full) and longer-than-monthly bills
 *  (a yearly membership, a semiannual premium) render the correct amount in the
 *  correct month.
 *
 *  DUE vs PAID: a bill is always anchored to its DUE day. When a recorded payment
 *  matches it, the entry is marked paid and carries the ACTUAL paid date + amount
 *  as detail (shown on tap) — the bill does NOT move off its due day. This keeps
 *  an early payment visible on the right cycle: paying the Jul-17 bill on Jun 30
 *  still shows on Jul 17, "paid Jun 30" — the paid date can even be a prior month.
 *  It also makes the Plaid post-lag harmless: the bill sits on its due day as
 *  "expected" until the real payment lands. Paid-status is month-scoped (a payment
 *  whose appliesTo.monthKey is THIS month), never the "day ≤ today" heuristic — so
 *  flipping across months never mislabels a bill. */
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
  // Format a payment's OWN ISO date (its real month/day), which may be a prior
  // month than the one being rendered — so an early cross-month payment reads
  // "Jun 30" on the July calendar rather than being coerced into July.
  const fmtISO = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

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
      const dueDay = clampDay(e.day); // anchor: the bill lives on its due day, paid or not
      return {
        id: `${rid ?? e.label}@${e.day}`,
        name: e.label,
        catId: recurring.find((r) => r.id === rid)?.categoryId ?? "other",
        day: dueDay,
        amount: paid ? Math.abs(paidTx!.amount) : e.amount,
        dateLabel: fmtDay(dueDay),
        paid,
        paidDate: paidTx ? fmtISO(paidTx.date) : undefined,
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
