// View-models for the bento reskin. The tab components are PRESENTATIONAL — they
// take a ready-made view-model and render it. The design-lab feeds mock data
// (Gino's real numbers) so the look can be verified without a login; the real
// container will compute the same shapes from the store. One contract, two feeds.

import type { CushionPreset } from "../../lib/plan";

export interface RecentRow {
  id: string;
  merchant: string;
  catId: string;
  sub: string; // "Groceries · today"
  amount: number; // positive; income flag controls sign/color
  income?: boolean;
  pending?: boolean; // still-processing bank charge
}

export interface HomeVM {
  firepower: number; // $/mo free to fire at debt (already net of budget overspend)
  overspent: number; // $ over the lean budget this month (0 = on/under budget) — reduces firepower
  debtFreeBy: string; // "Oct '26"
  // ── deploy-now model (cash-aware) ──
  deployNow: number; // selected preset's deployable-now lump = cash − billsHoldback − cushion
  billsHoldback: number; // bills due before the next paycheck (auto-reserved)
  cushion: CushionPreset; // the selected strategy
  cushionAmount: number; // the $ cushion held for the selected preset
  shortfall: number; // how far cash is UNDER the cushion (0 once the pad is funded)
  deployedDebts: { name: string; paid: number; clears: boolean }[]; // what the lump clears
  presets: { key: CushionPreset; cushion: number; deployNow: number; debtFreeBy: string }[];
  deployClearsZeroApr: boolean; // the selected lump clears a 0%-APR debt (drives the trade-off nudge)
  strategyReady: boolean; // both of the cycle's paychecks have landed → show the dial
  paychecksIn: number; // paychecks detected this cycle
  paychecksExpected: number; // paychecks expected this cycle (active income sources)
  deployedThisCycle: number; // $ actually sent at debt this cycle (live from tagged txns)
  nextAmount: number; // next payday send
  nextDate: string; // "Jun 30"
  cash: number;
  cashAccounts: number;
  processing: number; // ~$ still settling at the bank (0 = hide)
  debtLeft: number;
  debtProgressPct: number; // 0..100 cleared
  budgetSpent: number;
  budgetTarget: number;
  donut: { catId: string; amount: number }[];
  anomalyCount: number; // 0 = hide the alert
  anomalyIds: string[]; // the flagged transactions (for the focused view)
  // the flagged charges with the reason, for the dedicated review/dismiss sheet
  anomalies: { id: string; merchant: string; catId: string; catLabel: string; amount: number; ratio: number }[];
  streakDay: number;
  streakTotal: number;
  recent: RecentRow[];
  sinceMonday: number; // "spent $X since Monday"
  bills: { left: number; nextName: string; nextDate: string }; // the Home Bills tile
  owedToYou: number; // sum of unsettled reimbursable set-asides (0 = hide the tile)
  // reimbursables still owed back, for the "Owed to you" sheet. `suggested` is set
  // when a single payback deposit matches → an honest "is this it?" confirm (the
  // label shows the deposit's merchant + date so a coincidental match is obvious).
  owedList: { id: string; merchant: string; amount: number; dateLabel: string; note?: string; suggested?: { id: string; label: string } }[];
  // recently-settled reimbursables — the undo path if a match was confirmed wrongly.
  owedSettled: { id: string; merchant: string; amount: number; dateLabel: string }[];
}

// ── Bills surface (Option A list + calendar on tap) ──
export interface BillRow {
  id: string; // recurringId@day
  recurringId?: string;
  name: string;
  catId: string; // icon + color
  amount: number;
  day: number; // due day-of-month
  dateLabel: string; // "Jun 20"
  relLabel: string; // "tomorrow" / "in 10 days" / "overdue"
  variable: boolean; // amount is a rolling-avg estimate
}

export interface CalDay {
  day: number;
  in: boolean; // an income lands this day
  out: boolean; // a bill is due this day
}

export interface BillsVM {
  leftThisMonth: number;
  upcoming: BillRow[]; // unpaid, soonest first
  paidCount: number;
  paidTotal: number;
  monthLabel: string; // "June 2026"
  todayNum: number;
  daysInMonth: number;
  firstWeekday: number; // 0=Sun … the weekday of day 1
  calendar: CalDay[]; // days that carry a dot
  monthBills: (BillRow & { paid: boolean })[]; // every bill this month (for day tap)
}
