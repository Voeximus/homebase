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
}

export interface HomeVM {
  firepower: number; // $/mo free to fire at debt
  debtFreeBy: string; // "Oct '26"
  nextAmount: number; // next payday send
  nextDate: string; // "Jun 30"
  cash: number;
  cashAccounts: number;
  debtLeft: number;
  debtProgressPct: number; // 0..100 cleared
  budgetSpent: number;
  budgetTarget: number;
  donut: { catId: string; amount: number }[];
  anomalyCount: number; // 0 = hide the alert
  streakDay: number;
  streakTotal: number;
  recent: RecentRow[];
  sinceMonday: number; // "spent $X since Monday"
}
