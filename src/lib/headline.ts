// The numbers a screen shows at the top, assembled in ONE place.
//
// WHY THIS FILE EXISTS
//
// Some of the app's figures are not a function call — they are a short SEQUENCE of
// calls, and the sequence lived inside a view module. `buildVMs.ts` worked out the
// budget envelope by calling five functions in a particular order with a particular
// window; the Muse read door needed the same figure and copied those five lines;
// and tests/museSnapshot.test.ts wrote them a third time to check the door. Three
// copies of a sequence is the same drift as three copies of a formula, with the
// arithmetic hidden in the ORDER rather than in the numbers.
//
// The repo already knows what that costs. `cron-notify` re-implemented the app's
// bill maths by hand and told both phones "Electric $85" while every screen in the
// app said $100. A door that assembles its own inputs would do the same thing more
// quietly: every function it called would be the app's real function, every number
// would be honestly computed, and the answer would still disagree with his screen —
// in a chat, where there is nothing beside it to notice.
//
// So the rule this file serves (PLAN.md Rule 3): input assembly lives in a shared
// pure function that the app also calls. Nothing here does arithmetic of its own
// beyond the one subtraction a screen does — `target - spent` — which is the
// question itself.
//
// NO CLOCK. `now` is always handed in. The edge runtime is UTC, and from 5 PM
// Arizona onward a fired default answers about tomorrow: a different pay cycle, a
// different set of charges. See supabase/functions/_shared/muse/az.ts.

import type { Transaction } from "../types";
import {
  LEAN_VARIABLE,
  lineSpent,
  payCycleFor,
  perCycle,
  spentByCategoryBetween,
  sumTargets,
  variableSpentBetween,
  type BudgetLine,
  type PayCycle,
} from "./plan";

/** One budget line, priced for THIS cycle. */
export interface EnvelopeLine {
  /** The line's stable key, as the app spells it. */
  key: string;
  label: string;
  /** The categories this line claims, so a caller can group charges the same way. */
  cats: string[];
  /** This cycle's share of the line's monthly target. */
  target: number;
  /** Spent against those categories inside the cycle window. */
  spent: number;
}

export interface EnvelopeStatus {
  /** The whole envelope's MONTHLY target — what the debt maths is measured against. */
  monthlyTarget: number;
  /** The pay cycle `now` falls inside. The budget is graded per cycle, not per
   *  month, because that is the unit money arrives in. */
  cycle: PayCycle;
  /** This cycle's allowance: the monthly envelope divided by the cycles in a month. */
  target: number;
  /** Graded variable spend inside the cycle window. */
  spent: number;
  /** Every category's spend inside the window — the partition the lines read, and
   *  the same one the drill-in rows have to use or a bar stops explaining itself. */
  byCat: Record<string, number>;
  lines: EnvelopeLine[];
}

/**
 * The budget envelope as a screen shows it, for the pay cycle containing `now`.
 *
 * This is the sequence, and the order is the point: the monthly envelope, the cycle
 * `now` sits in, that cycle's allowance, that cycle's graded spend, and the
 * per-category partition the lines are read from.
 */
export function envelopeStatus(
  transactions: Transaction[],
  now: Date,
  lines: BudgetLine[] = LEAN_VARIABLE,
): EnvelopeStatus {
  const monthlyTarget = sumTargets(lines);
  const cycle = payCycleFor(now);
  const target = perCycle(monthlyTarget);
  const spent = variableSpentBetween(transactions, cycle.start, cycle.end);
  const byCat = spentByCategoryBetween(transactions, cycle.start, cycle.end);
  return {
    monthlyTarget,
    cycle,
    target,
    spent,
    byCat,
    lines: lines.map((l) => ({
      key: l.key,
      label: l.label,
      cats: l.cats,
      target: perCycle(l.target),
      spent: lineSpent(l, byCat),
    })),
  };
}
