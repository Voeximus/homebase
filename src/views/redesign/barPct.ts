// How full a budget bar is drawn, as a CSS width percentage (0 to 100).
//
// Added 2026-10-10, with the per-cycle budget goal. Three bars draw "spent of target":
// each line's row on Insights, the envelope bar on Home, and the bar in the category
// drill-in. Before that day a target could never be 0 (the smallest standard line,
// halved for a pay cycle, is still well above zero), so two of the three divided by it
// without a guard. A cycle's goal CAN set a line to 0, and that is a real choice ("we
// are not spending on this line this time"), not a typo. With nothing spent, 0 / 0 is
// NaN; the width becomes "NaN%", the browser throws the style away, and the bar falls
// back to its full default width, reading as a line fully used on both phones the very
// first time such a goal is written.
//
// So ONE rule, used by all three bars so they can never disagree about the same line:
//   · a target above 0: the share spent, capped at a full bar;
//   · a target of 0 with something spent: a full bar (every dollar is over, and the
//     caller already colours it as over because spent > target);
//   · a target of 0 with nothing spent: an empty bar (on the goal, nothing used).
// The answer is always a finite number, so no bar's width can be NaN or Infinity.
export function barPct(spent: number, target: number): number {
  if (target > 0) return Math.min(100, (spent / target) * 100);
  return spent > 0 ? 100 : 0;
}

// The budget card's one-word verdict, shared by Home's "This cycle" card and the
// Insights gauge so the two can never disagree about the same cycle.
//   · "over"  — more spent than the whole cycle allows;
//   · "ahead" — still under the total, but past an even pace for the day the cycle
//               is on (target × day ÷ days), so the rest of the cycle is tighter;
//   · "ok"    — at or under that pace.
// Both cards already print "day n of total" as the pace check; this makes the word
// beside the number read it too, instead of saying "on track" with half the cycle's
// money gone on day 1.
export type BudgetVerdict = "over" | "ahead" | "ok";
export function budgetVerdict(spent: number, target: number, day: number, days: number): BudgetVerdict {
  if (spent > target) return "over";
  const pace = days > 0 ? (target * Math.min(Math.max(day, 0), days)) / days : target;
  return spent > pace + 0.005 ? "ahead" : "ok";
}
