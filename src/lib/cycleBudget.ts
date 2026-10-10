// The budget goal for ONE pay cycle, and the one answer to "what is this cycle aiming at?"
//
// WHY THIS FILE EXISTS — 2026-10-10
//
// Until today every budget target was a constant. LEAN_VARIABLE in plan.ts holds a
// MONTHLY figure per line, and envelopeStatus (headline.ts) halved it for the pay cycle.
// That is a sound default and a useless instrument for the conversation the household
// actually has before a paycheck: "this cycle, with rent and the car coming, we hold
// groceries here and aim lower on dining". There was no way to say that to the app or to
// either assistant. Changing the constant changes every cycle for ever, through a commit,
// in a public repository — and the repo is public, so a household's real figures must
// never be typed into it at all.
//
// So a goal is DATA now: one row per line per cycle in public.cycle_budgets
// (supabase/schema_v45_cycle_budgets.sql), written by the write door's
// finance.set_cycle_budget. And THIS FILE is the one place that turns those rows into
// targets. The app's budget bars (through headline.ts envelopeStatus), the read door's
// finance.budget_status and the write door all call it — the two doors through the
// generated copy (scripts/gen-muse-shared.mjs) — so the figure on both phones and the
// figure in both chats are one function's answer. A second spelling of "what is this
// cycle's target" anywhere would be the drift the doors were built to stop.
//
// THE RULES IT HOLDS, each one a way this goes quietly wrong:
//
//   · A goal belongs to a cycle by the cycle's FIRST DAY, spelled exactly as payCycleFor
//     spells it. Not "the cycle that contains this date": a goal filed under the 16th
//     would match no cycle and silently do nothing, which is the worst way for a goal to
//     fail — it LOOKS set. The write door refuses any date that is not a real cycle
//     start (goalCycleProblem), and cycleTargets ignores rows filed under anything else.
//   · A goal amount is a CYCLE figure. Never halved, never doubled. perCycle() applies to
//     the standard budget's monthly lines and to nothing else.
//   · A line with no goal row keeps the standard budget's share. A goal may name one line
//     or all six, and the rest are untouched — so "aim lower on dining" cannot quietly
//     zero the groceries line.
//   · The MONTHLY plan does not move. Firepower and the payoff projection are monthly
//     figures built from the standard envelope (sumTargets(LEAN_VARIABLE)). A goal for one
//     cycle is not a new plan, and mixing a cycle's goal into a monthly figure would grade
//     half a period against a whole one — the mistake buildVMs.ts records from the day the
//     budget moved to pay cycles.
//   · How far a goal may reach: one cycle back (to correct the one just finished) and two
//     ahead (the next paycheck and the one after). A goal further out is a plan rather
//     than a goal, and one months back would re-grade spending that was already graded.
//
// NO CLOCK. `now` is always handed in, exactly as headline.ts takes it: the edge runtime
// is UTC, and from 5 PM Arizona onward a fired default would answer about tomorrow — and
// on the evening before a payday, about the wrong cycle.

import type { CycleBudget } from "../types";
import { addDaysISO, isoDate } from "./format";
import { LEAN_VARIABLE, payCycleFor, perCycle, sumTargets, type BudgetLine } from "./plan";

/** The six line keys a goal can name — read off the plan, never typed again. */
export const BUDGET_LINE_KEYS: readonly string[] = LEAN_VARIABLE.map((l) => l.key);

/** How many cycles BEFORE the one in progress a goal may be set for. */
export const GOAL_CYCLES_BACK = 1;
/** How many cycles AFTER the one in progress a goal may be set for. */
export const GOAL_CYCLES_AHEAD = 2;
/** The largest dollar figure one line's goal may carry for one cycle. Far above anything
 *  a single line spends in two weeks; it is here to catch a typo (an extra zero, cents
 *  sent as dollars) before it becomes the target both phones grade against. */
export const GOAL_LINE_MAX = 10_000;

/** A pay cycle as a goal needs it: its first day, its last day, and its label. */
export interface CycleSpan {
  start: string;
  end: string;
  label: string;
}

/** Where one line's target came from. */
export type TargetSource = "goal" | "standard";
/** Where a whole cycle's targets came from: all six lines from a goal, none, or some. */
export type TargetsFrom = "goal" | "standard" | "mixed";

/** A "YYYY-MM-DD" calendar date as that day's LOCAL midnight — the spelling payCycleFor
 *  reads (getFullYear / getMonth / getDate). Never `new Date("YYYY-MM-DD")`, which is UTC
 *  midnight and therefore the previous evening in Arizona. */
function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The cycle that contains this calendar day, without the day-of-cycle fields, which
 *  belong to a `now` and would mean nothing here. */
function cycleOn(dayISO: string): CycleSpan {
  const c = payCycleFor(dayOf(dayISO));
  return { start: c.start, end: c.end, label: c.label };
}

/**
 * The pay cycle that OPENS on this day, or null when no cycle opens on it.
 *
 * A date is a cycle's first day exactly when the app's own cycle function, asked about
 * that date, says the cycle starts there. So the paydays are never restated here: if
 * PAY_DAYS changes, what counts as a cycle start changes with it.
 */
export function cycleOpeningOn(startISO: string): CycleSpan | null {
  if (typeof startISO !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(startISO)) return null;
  // 2026-02-31 is not a day. The Date constructor would roll it into March, and the
  // March cycle would then answer for a date nobody meant.
  if (isoDate(dayOf(startISO)) !== startISO) return null;
  const c = cycleOn(startISO);
  return c.start === startISO ? c : null;
}

/**
 * The cycles a goal may be set for, oldest first: GOAL_CYCLES_BACK before the one in
 * progress, the one in progress, and GOAL_CYCLES_AHEAD after it.
 *
 * Walked one cycle at a time from the one `now` is in — the day before a cycle opens is
 * in the previous cycle, the day after one ends is in the next — so the walk crosses a
 * month end, a short February and a 31st the same way the budget itself does.
 */
export function goalCycles(now: Date): CycleSpan[] {
  const c = payCycleFor(now);
  const current: CycleSpan = { start: c.start, end: c.end, label: c.label };
  const out: CycleSpan[] = [current];
  let back = current;
  for (let i = 0; i < GOAL_CYCLES_BACK; i++) {
    back = cycleOn(addDaysISO(back.start, -1));
    out.unshift(back);
  }
  let ahead = current;
  for (let i = 0; i < GOAL_CYCLES_AHEAD; i++) {
    ahead = cycleOn(addDaysISO(ahead.end, 1));
    out.push(ahead);
  }
  return out;
}

/** The cycle `now` is in, as goalCycles spells it — the cycle a goal is for when the
 *  caller does not name one. */
export function cycleInProgress(now: Date): CycleSpan {
  return goalCycles(now)[GOAL_CYCLES_BACK];
}

/**
 * Why a goal cannot be set for the cycle starting on this day — or null when it can.
 *
 * One sentence, plain, and it always ends with the cycles that CAN be set, by their first
 * day, so the next call can be right. The write door says it as it stands.
 */
export function goalCycleProblem(startISO: string, now: Date): string | null {
  const allowed = goalCycles(now);
  if (allowed.some((c) => c.start === startISO)) return null;
  const starts = allowed.map((c) => c.start).join(", ");
  const ok = `A goal can be set for the cycles starting ${starts}.`;
  if (!cycleOpeningOn(startISO)) {
    return `${startISO} is not the first day of a pay cycle — a cycle opens on a payday. ${ok}`;
  }
  return startISO < allowed[0].start
    ? `The cycle starting ${startISO} is more than ${GOAL_CYCLES_BACK} cycle back, and its spending has already been graded. ${ok}`
    : `The cycle starting ${startISO} is more than ${GOAL_CYCLES_AHEAD} cycles ahead. ${ok}`;
}

/** One line's target for one cycle, and where it came from. */
export interface CycleLineTarget {
  key: string;
  label: string;
  /** The categories this line claims — the same partition the bars read. */
  cats: string[];
  /** Dollars for the cycle: the goal's amount, or the standard line's share. */
  target: number;
  from: TargetSource;
}

/** A whole cycle's targets: every line, their total, and where they came from. */
export interface CycleTargets {
  /** The cycle's first day. */
  start: string;
  lines: CycleLineTarget[];
  /** The envelope for the cycle. */
  total: number;
  from: TargetsFrom;
}

/**
 * The goal rows that apply to one cycle, by line.
 *
 * A row is left out — and its line falls back to the standard budget — when it is filed
 * under a different cycle, names a line the plan does not have, or carries an amount that
 * is not a dollar figure of 0 or more. The table's own checks already refuse the last two;
 * this is the belt under them, because a target both phones grade against should never be
 * built out of a value nothing checked. Two rows for one line cannot exist (the table is
 * unique on cycle and line); if they ever did, the later one in the list wins, so the
 * answer is at least the same on every call.
 */
export function goalFor(
  cycleStart: string,
  goals: readonly CycleBudget[] = [],
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): Map<string, CycleBudget> {
  const keys = new Set(lines.map((l) => l.key));
  const out = new Map<string, CycleBudget>();
  for (const g of goals) {
    if (g.cycleStart !== cycleStart || !keys.has(g.line)) continue;
    if (typeof g.amount !== "number" || !Number.isFinite(g.amount) || g.amount < 0) continue;
    out.set(g.line, g);
  }
  return out;
}

/**
 * Every line's target for the cycle that opens on `cycleStart`: the goal where one is
 * set, the standard budget's share everywhere else — and the envelope they add up to.
 *
 * WITH NO GOAL, the total is spelled EXACTLY as it was before 2026-10-10 — the monthly
 * envelope's share, perCycle(sumTargets(lines)) — rather than as a sum of the six shares,
 * so not one figure anywhere moves by a float's rounding on the day this shipped. With a
 * goal, the total is the sum of the lines, taken to the cent: every goal amount is stored
 * to the cent and every standard share is a half-dollar at worst, so the cent is exact.
 */
export function cycleTargets(
  cycleStart: string,
  goals: readonly CycleBudget[] = [],
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): CycleTargets {
  const set = goalFor(cycleStart, goals, lines);
  const out: CycleLineTarget[] = lines.map((l) => {
    const g = set.get(l.key);
    return {
      key: l.key,
      label: l.label,
      cats: l.cats,
      target: g ? g.amount : perCycle(l.target),
      from: g ? "goal" : "standard",
    };
  });
  const fromGoal = out.filter((l) => l.from === "goal").length;
  const total =
    fromGoal === 0
      ? perCycle(sumTargets([...lines]))
      : Math.round(out.reduce((s, l) => s + l.target, 0) * 100) / 100;
  return {
    start: cycleStart,
    lines: out,
    total,
    from: fromGoal === 0 ? "standard" : fromGoal === out.length ? "goal" : "mixed",
  };
}

/** A cycle after the one in progress that already has a goal. */
export interface GoalAhead extends CycleSpan {
  targets: CycleTargets;
}

/**
 * The cycles AFTER the one in progress that already carry a goal, soonest first.
 *
 * It exists because a goal is usually set before its cycle opens — a few days before
 * the paycheck — and until that payday the budget status is about the cycle still
 * running. Without this, the goal both of them just agreed on would be invisible to
 * either assistant until the morning it starts.
 */
export function goalsAhead(
  now: Date,
  goals: readonly CycleBudget[] = [],
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): GoalAhead[] {
  return goalCycles(now)
    .slice(GOAL_CYCLES_BACK + 1)
    .map((c) => ({ ...c, targets: cycleTargets(c.start, goals, lines) }))
    .filter((c) => c.targets.from !== "standard");
}
