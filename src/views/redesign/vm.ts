// View-models for the bento reskin. The tab components are PRESENTATIONAL — they
// take a ready-made view-model and render it. The design-lab feeds mock data
// (Gino's real numbers) so the look can be verified without a login; the real
// container will compute the same shapes from the store. One contract, two feeds.

export interface RecentRow {
  id: string;
  merchant: string;
  catId: string;
  sub: string; // "Groceries · today"
  amount: number; // positive; income flag controls sign/color
  income?: boolean;
  pending?: boolean; // still-processing bank charge
}

// The payoff, as Home's Payoff tile and the Insights card both draw it — one object,
// built once (payoffPlan in src/lib/headline.ts) and handed to both screens.
//   · debtFree — nothing open is owed.
//   · noPay    — no live paycheck row, so there is no plan to date.
//   · plan     — the month the plan clears, if on budget. `overBy` is how far the
//                last three months ran over budget a month (0 = within it); it is
//                printed beside the date and never moves it.
//   · short    — the plan does not clear even on budget; `shortBy` is the extra $/mo
//                it needs before it has any date.
export type PayoffVM =
  | { kind: "debtFree" }
  | { kind: "noPay" }
  | {
      kind: "plan";
      date: string; // "Oct '26", or "2026年10月" in Chinese
      monthsToGo: number;
      interest: number;
      nextAmount: number; // the first payday that sends money at the debt (0 = none)
      nextDate: string; // "Jun 30", or "" when there is none
      overBy: number;
    }
  | { kind: "short"; shortBy: number; overBy: number };

export interface HomeVM {
  firepower: number; // $/mo free to fire at debt (already net of budget overspend)
  overspent: number; // $ over the lean budget this PAY CYCLE (0 = on/under budget)
  payoff: PayoffVM;
  deployedThisCycle: number; // $ actually sent at debt this cycle (live from tagged txns) — tracking
  cash: number;
  cashAccounts: number;
  processing: number; // ~$ still settling at the bank (0 = hide)
  debtLeft: number;
  debtProgressPct: number; // 0..100 cleared
  budgetSpent: number;
  // The pay cycle the budget is graded over (e.g. "Jul 31 – Aug 14") + how far in.
  budgetCycleLabel: string;
  budgetCycleDay: number;
  budgetCycleDays: number;
  budgetTarget: number;
  donut: { catId: string; amount: number }[];
  anomalyCount: number; // 0 = hide the alert
  anomalyIds: string[]; // the flagged transactions (for the focused view)
  // the flagged charges with the reason, for the dedicated review/dismiss sheet
  anomalies: { id: string; merchant: string; catId: string; catLabel: string; amount: number; ratio: number }[];
  streakDay: number;
  streakTotal: number;
  recent: RecentRow[];
  // The household's Sun–Sat week (the week the $/week plan runs on), as finance.week
  // counts it: graded line spend with money back taken off. In Mine, the same rule over
  // the lens's rows (money back taken off there too), so it never exceeds All.
  spentThisWeek: number;
  // The Home Bills tile: still due before the next payday (the same window as the
  // Bills sheet's header and finance.next_bills), the next one, and what is overdue.
  bills: { left: number; nextName: string; nextDate: string; overdue?: number };
  // True in the Mine lens: the budget card's figures are the household's, not this
  // person's, so the card says so.
  household?: boolean;
  owedToYou: number; // sum of unsettled reimbursable set-asides (0 = hide the tile)
  // reimbursables still owed back, for the "Owed to you" sheet. `suggested` is set
  // when a single payback deposit matches → an honest "is this it?" confirm (the
  // label shows the deposit's merchant + date so a coincidental match is obvious).
  owedList: { id: string; merchant: string; amount: number; dateLabel: string; note?: string; suggested?: { id: string; label: string } }[];
  // recently-settled reimbursables — the undo path if a match was confirmed wrongly.
  owedSettled: { id: string; merchant: string; amount: number; dateLabel: string }[];
}
