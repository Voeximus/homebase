// The words a reply uses to say where a pay cycle's budget targets came from.
//
// WHY THIS IS ITS OWN FILE — 2026-10-10
//
// These two tables were written for finance.budget_status, inside tools.ts. The same
// day the daily money check-in (toolsDaily.ts: finance.daily_allowance and
// finance.day_review) needed to say the same thing about the same targets — whether the
// day's allowance is built on "this cycle's goal" or on "the standard budget" — and the
// two ways to get the words there were both wrong: import them out of tools.ts, which
// imports toolsDaily.ts as a value (an import cycle, whose failure mode is an
// uninitialised binding at load time rather than a compile error), or type them a second
// time, which is how one tool comes to call a goal "your target" while another calls it
// "this cycle's goal" and an assistant reads two different things.
//
// So they live here, once, and both tool files import them. Changing what an assistant
// hears is still finding a line in one table rather than reading code.

import type { TargetSource, TargetsFrom } from "./lib/cycleBudget.ts";

/** What a cycle's targets are, in the words the reply says them. */
export const TARGETS_ARE: Record<TargetsFrom, string> = {
  goal: "this cycle's goal",
  standard: "the standard budget",
  mixed: "this cycle's goal for some lines, the standard budget for the rest",
};

/** What one line's target is, in the same words. */
export const LINE_TARGET_IS: Record<TargetSource, string> = {
  goal: "this cycle's goal",
  standard: "the standard budget",
};
