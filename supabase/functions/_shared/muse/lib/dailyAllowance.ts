// GENERATED — DO NOT EDIT. Source: src/lib/dailyAllowance.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/dailyAllowance.ts
// and re-run the generator.
// The daily money check-in's arithmetic: what the household can spend on one day, and
// how a finished day went against it.
//
// WHY THIS FILE EXISTS — 2026-10-10
//
// The household asked Muse for a daily money routine: at the start of each person's day,
// "what can we spend today", and at the end of it, "the goal against what we spent, what
// to keep doing, what to cut back". Every figure in that conversation is a division or a
// subtraction on top of the budget — what is left of the cycle, split over the days left;
// what a day took against what it was allowed; how many days ran over. And the one rule
// both doors are built on is that the assistant never does arithmetic: a number worked
// out in a chat has no screen beside it to disagree, and this repo has the receipts for
// what hand-made copies of the app's maths do (a push that named one figure for the
// electric bill while every screen named another). So the arithmetic lives HERE, in
// src/lib, where the screens could call it too, and the read door's
// finance.daily_allowance and finance.day_review only report the fields it returns — through the generated copy (scripts/gen-muse-shared.mjs), so the
// door runs this exact file and the build fails if the copy drifts by a space.
//
// WHAT IT STANDS ON, all of it the app's own:
//
//   · the pay cycle — payCycleFor (plan.ts), the same window the budget bars use;
//   · the cycle's targets — cycleTargets (cycleBudget.ts): this cycle's goal where one
//     is set, the standard budget's cycle share where not. Never re-derived here;
//   · what counts as spending — spentByCategoryBetween (plan.ts) and the slices it adds
//     up: pending charges COUNT, money moved between their own accounts does NOT, and a
//     charge tied to a bill, a debt or a planned item is not everyday spending. Graded
//     per line with lineSpent, exactly as the bars are;
//   · what is due on a date — monthCalendar (schedule.ts), the calendar's own answer,
//     and billEvidence (headline.ts) for "is that bill really unpaid?".
//
// THE ONE RULE THAT IS NEW, said once so it can be checked:
//
//   allowance for a date = max(0, (target − spent in the cycle BEFORE that date)
//                                 ÷ days left in the cycle, that date included)
//
// So money spent over one day's allowance shrinks every later day's, and money left
// over grows them — the allowance is the even pace for what is left, re-worked each
// morning. It floors at zero: a negative allowance is not a figure anyone can spend, and
// "zero, the cycle's target is used up" is the true sentence. It is worked out per line
// AND for the whole envelope, and the envelope's is NOT the lines added up: a line
// already over its target is floored at zero on its own, but on the envelope its
// overspend still pulls everything else down. That is deliberate — the household spends
// from one pool.
//
// Money is rounded to the cent where a figure is FINISHED (the allowance, and what is
// left of it), so the reply's own numbers subtract cleanly; nothing rounded is fed back
// into a later step except the allowance itself, which is what a person is told.
//
// NO CLOCK. Every date arrives as an argument. The only Date built in this file is a
// calendar day's local midnight, from a "YYYY-MM-DD" the caller supplied, because that
// is the spelling payCycleFor and getDay read (the same dayOf cycleBudget.ts uses).
// `now` is taken only where an existing function needs one (the bill calendar and the
// unpaid-bill evidence), and it is always the one the caller was handed.

import type { AppData, CycleBudget, Recurring, Transaction } from "./types.ts";
import {
  LEAN_VARIABLE,
  lineSpent,
  payCycleFor,
  spendingSlicesBetween,
  spentByCategoryBetween,
  type BudgetLine,
  type PayCycle,
} from "./plan.ts";
import { cycleTargets, type TargetSource, type TargetsFrom } from "./cycleBudget.ts";
import { addDaysISO } from "./format.ts";
import { billEvidence, type BillEvidence } from "./headline.ts";
import { dueOn, monthCalendar, monthlySchedule } from "./schedule.ts";

/** Dollars to the cent. The one rounding this file does, on finished figures only. */
const cents = (n: number): number => Math.round(n * 100) / 100;

/** A "YYYY-MM-DD" calendar date as that day's LOCAL midnight — what payCycleFor and
 *  getDay read. Never `new Date("YYYY-MM-DD")`, which is UTC midnight and therefore the
 *  previous evening in Arizona. */
function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The pay cycle that contains this calendar date, with `dayIndex` being that date's
 *  place in it (1 = the payday that opened it). */
export function cycleOnDate(dateISO: string): PayCycle {
  return payCycleFor(dayOf(dateISO));
}

/** The line keys the two pattern counts read. Read off the plan rather than assumed to
 *  exist: if a line is ever renamed, its count reads zero rather than crashing. */
export const GAS_LINE = "gas";
export const DINING_LINE = "dining";

/** How many days back the at-or-under streak may walk. Two months: long enough that a
 *  real streak is never cut short in practice, short enough that a day before the ledger
 *  began — which spends nothing and so always "passes" — cannot make a streak endless. */
export const STREAK_MAX = 60;

/** How many days the pattern window and the chart series cover, the date included. */
export const PATTERN_DAYS = 7;

/** max(0, (target − spentBefore) ÷ daysLeft), to the cent. The rule, in one place. */
export function allowanceFor(target: number, spentBefore: number, daysLeft: number): number {
  if (!(daysLeft > 0)) return 0;
  return cents(Math.max(0, (target - spentBefore) / daysLeft));
}

/** Whether spending so far is within an even pace. Over pace means more was spent in
 *  the days counted than the target spread evenly over the cycle would have allowed in
 *  those days. Compared to the cent, so a float's last digit cannot flip the verdict. */
export type PaceVerdict = "on pace" | "over pace";

export interface Pace {
  verdict: PaceVerdict;
  /** What was spent in the days counted. */
  spent: number;
  /** What an even pace — the target spread evenly over the cycle — would have spent in
   *  those same days. */
  evenPaceSpent: number;
  /** How many of the cycle's days were counted. */
  daysCounted: number;
}

function paceOf(target: number, spent: number, cycleDays: number, daysCounted: number): Pace {
  const evenPaceSpent = cycleDays > 0 ? (target * daysCounted) / cycleDays : 0;
  return {
    verdict: cents(spent) > cents(evenPaceSpent) ? "over pace" : "on pace",
    spent: cents(spent),
    evenPaceSpent: cents(evenPaceSpent),
    daysCounted,
  };
}

/** One budget line on one date. */
export interface AllowanceLine {
  key: string;
  label: string;
  /** The cycle's target for this line: the goal, or the standard budget's share. */
  target: number;
  from: TargetSource;
  /** Spent on this line in the cycle, from its first day through the day before the
   *  date. Zero on the cycle's first day. */
  spentBefore: number;
  /** What the line can take on the date, as it stood at the START of the date. */
  allowance: number;
  /** Spent on this line ON the date, as far as the ledger shows it. */
  spentOn: number;
  /** allowance − spentOn. Negative means over by that much. */
  left: number;
}

/** The whole envelope on one date — the same fields as a line, plus the even share. */
export interface AllowanceTotal {
  target: number;
  spentBefore: number;
  allowance: number;
  spentOn: number;
  left: number;
  /** The target spread evenly over every day of the cycle — what a day would get if
   *  nothing had been spent ahead of or behind the pace. Context for "is today's
   *  allowance big or small", never a substitute for it. */
  evenDailyShare: number;
}

export interface DayAllowance {
  date: string;
  cycle: PayCycle;
  /** The date and every day after it in the cycle. */
  daysLeft: number;
  targetsFrom: TargetsFrom;
  total: AllowanceTotal;
  lines: AllowanceLine[];
  /** Over or on pace at the START of the date: what the days before it spent, against
   *  what an even pace would have spent in them. Over pace is exactly "today's allowance
   *  is below the even daily share". */
  pace: Pace;
}

/**
 * What the household can spend on one date, per line and in total, as it stood at the
 * start of that date — and what the date has spent so far.
 *
 * "Spent before" is the cycle's first day through the day before the date, read off
 * spentByCategoryBetween; "spent on" is the date alone, read the same way. On the
 * cycle's first day the "before" window is empty (it starts after it ends) and reads
 * zero, which is right: the cycle has spent nothing yet.
 */
export function dayAllowance(
  transactions: Transaction[],
  dateISO: string,
  goals: readonly CycleBudget[] = [],
  lines: BudgetLine[] = LEAN_VARIABLE,
): DayAllowance {
  const cycle = cycleOnDate(dateISO);
  const daysLeft = cycle.days - cycle.dayIndex + 1;
  const targets = cycleTargets(cycle.start, goals, lines);
  const before = spentByCategoryBetween(transactions, cycle.start, addDaysISO(dateISO, -1));
  const on = spentByCategoryBetween(transactions, dateISO, dateISO);

  let totalBefore = 0;
  let totalOn = 0;
  // Index for index: cycleTargets returns one entry per line, in the order given.
  const out: AllowanceLine[] = lines.map((l, i) => {
    const target = targets.lines[i].target;
    const spentBefore = lineSpent(l, before);
    const spentOn = lineSpent(l, on);
    totalBefore += spentBefore;
    totalOn += spentOn;
    const allowance = allowanceFor(target, spentBefore, daysLeft);
    return {
      key: l.key,
      label: l.label,
      target,
      from: targets.lines[i].from,
      spentBefore: cents(spentBefore),
      allowance,
      spentOn: cents(spentOn),
      left: cents(allowance - spentOn),
    };
  });

  const allowance = allowanceFor(targets.total, totalBefore, daysLeft);
  return {
    date: dateISO,
    cycle,
    daysLeft,
    targetsFrom: targets.from,
    total: {
      target: targets.total,
      spentBefore: cents(totalBefore),
      allowance,
      spentOn: cents(totalOn),
      left: cents(allowance - totalOn),
      evenDailyShare: cents(cycle.days > 0 ? targets.total / cycle.days : 0),
    },
    lines: out,
    pace: paceOf(targets.total, totalBefore, cycle.days, cycle.dayIndex - 1),
  };
}

// ── the week ──────────────────────────────────────────────────────────────────

/** One stretch of the rest of the week that sits inside one pay cycle. */
export interface WeekPart {
  from: string;
  to: string;
  days: number;
  /** The cycle this stretch belongs to, by its first day. */
  cycleStart: string;
  /** The daily allowance this stretch is counted at. */
  dailyAllowance: number;
  canTake: number;
  /** "this cycle" — the date's own allowance, carried to the end of the week or of the
   *  cycle. "next cycle" — days after the cycle ends, counted at the allowance the next
   *  cycle OPENS with (its target over its days, nothing spent yet), because a new
   *  paycheck starts a new pace and today's shortfall or surplus does not carry into it. */
  paceIs: "this cycle" | "next cycle";
}

export interface WeekAhead {
  /** The Sunday that opens the week holding the date. */
  from: string;
  /** The Saturday that closes it. */
  to: string;
  /** Graded spending from that Sunday through the day before the date — across a cycle
   *  boundary when the week straddles one, because it is still this week's spending. */
  spentBefore: number;
  /** The date through Saturday. */
  daysLeft: number;
  /** What the rest of the week can take at the allowance pace: the parts, added. */
  canTake: number;
  crossesIntoNextCycle: boolean;
  parts: WeekPart[];
}

/**
 * The week (Sunday to Saturday) holding the date: what it has already spent before the
 * date, and what the rest of it can take at the allowance pace.
 *
 * Days inside the date's cycle are counted at the date's own allowance. Days after that
 * cycle ends are counted at the next cycle's opening allowance — dayAllowance on the
 * next cycle's first day, which is that cycle's target over its length with nothing
 * spent, from that cycle's own goal if it has one. A week can touch two cycles at most
 * (the shortest cycle is 13 days); the loop does not assume it.
 */
export function weekAhead(
  transactions: Transaction[],
  day: DayAllowance,
  goals: readonly CycleBudget[] = [],
  lines: BudgetLine[] = LEAN_VARIABLE,
): WeekAhead {
  const from = addDaysISO(day.date, -dayOf(day.date).getDay());
  const to = addDaysISO(from, 6);
  const byCat = spentByCategoryBetween(transactions, from, addDaysISO(day.date, -1));
  const spentBefore = lines.reduce((s, l) => s + lineSpent(l, byCat), 0);

  const parts: WeekPart[] = [];
  let cursor = day.date;
  let current: DayAllowance = day;
  let paceIs: WeekPart["paceIs"] = "this cycle";
  while (cursor <= to) {
    const end = current.cycle.end < to ? current.cycle.end : to;
    const days = daysFrom(cursor, end);
    parts.push({
      from: cursor,
      to: end,
      days,
      cycleStart: current.cycle.start,
      dailyAllowance: current.total.allowance,
      canTake: cents(current.total.allowance * days),
      paceIs,
    });
    cursor = addDaysISO(end, 1);
    if (cursor > to) break;
    current = dayAllowance(transactions, cursor, goals, lines);
    paceIs = "next cycle";
  }
  return {
    from,
    to,
    spentBefore: cents(spentBefore),
    daysLeft: daysFrom(day.date, to),
    canTake: cents(parts.reduce((s, p) => s + p.canTake, 0)),
    crossesIntoNextCycle: parts.length > 1,
    parts,
  };
}

/** Days from a to b, both included. Walked by calendar date so no timezone gets a vote;
 *  the spans here are a week at most. */
function daysFrom(a: string, b: string): number {
  let n = 0;
  for (let d = a; d <= b; d = addDaysISO(d, 1)) n++;
  return n;
}

// ── what is due on the date ───────────────────────────────────────────────────

/** A bill or planned item due on the date, as the calendar has it. */
export interface DueThing {
  recurringId: string | null;
  name: string;
  /** What the calendar expects (or, when paid, what was paid). */
  amount: number;
  due: string;
  categoryId: string;
  /** The budget line whose categories include this row's — or null when no line grades
   *  it. A planned item ON a line is graded there as everyday spending if its charge is
   *  not tied to its row, which is the thing worth saying out loud about it. */
  line: string | null;
  paid: boolean;
  /** The amount is a rolling average of real payments, not a contracted figure. */
  estimate: boolean;
  /** For an unpaid one: a payment clearing, or a posted charge nothing tied to it. Null
   *  when paid. */
  evidence: BillEvidence | null;
}

/** The longest lifetime, in calendar months, that the one-off test walks. A row whose
 *  window is longer than this is a bill, whatever it does inside it. */
export const ONE_OFF_MONTHS_MAX = 24;

/** "YYYY-MM" plus one month. */
function nextMonthKey(mk: string): string {
  const [y, m] = mk.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Does this row fire exactly once in its whole lifetime — a planned one-day item, like a
 * dinner booked for one evening, rather than a bill?
 *
 * Decided by the calendar itself, not by a rule invented here: the row needs a start AND
 * an end (an open-ended row is a bill by definition), and across every month its window
 * touches, monthlySchedule — the calendar's engine — has to place exactly one payment.
 * "Starts and ends on the same day" is the commonest case and not the only one: a row
 * whose window holds only one of its due days fires once too.
 */
export function firesOnce(r: Recurring): boolean {
  if (!r.active || !r.startsOn || !r.endsOn || r.endsOn < r.startsOn) return false;
  const last = r.endsOn.slice(0, 7);
  let mk = r.startsOn.slice(0, 7);
  let count = 0;
  for (let i = 0; i < ONE_OFF_MONTHS_MAX && mk <= last; i++) {
    count += monthlySchedule([r], mk).entries.filter((e) => e.direction === "out").length;
    if (count > 1) return false;
    mk = nextMonthKey(mk);
  }
  return mk > last && count === 1;
}

/**
 * The bills and planned items the calendar puts on this date.
 *
 * Two lists, kept apart on purpose: neither is everyday spending, and the allowance does
 * not include either. `planned` holds the rows that fire once (firesOnce) and are not
 * yet paid — a paid one-off is done and needs no mention. `bills` holds every other row
 * due that day, paid or not, because "is rent paid?" is the question on rent day. Every
 * unpaid row carries billEvidence's answer to "is it really unpaid?", the same test
 * finance.next_bills and finance.bill_calendar use.
 */
export function dueOnDate(
  data: AppData,
  dateISO: string,
  now: Date,
  lines: BudgetLine[] = LEAN_VARIABLE,
): { planned: DueThing[]; bills: DueThing[] } {
  const [y, m] = dateISO.split("-").map(Number);
  const cal = monthCalendar(data.recurring, data.transactions, now, y, m - 1, data.debts);
  const today = cal.bills.filter((b) => dueOn(cal, b) === dateISO);
  if (today.length === 0) return { planned: [], bills: [] };
  const evidenceFor = billEvidence(data, now);
  const planned: DueThing[] = [];
  const bills: DueThing[] = [];
  for (const b of today) {
    const row = b.recurringId ? data.recurring.find((r) => r.id === b.recurringId) : undefined;
    const oneOff = !!row && firesOnce(row);
    if (oneOff && b.paid) continue;
    const thing: DueThing = {
      recurringId: b.recurringId ?? null,
      name: b.name,
      amount: b.amount,
      due: dateISO,
      categoryId: b.catId,
      line: lines.find((l) => l.cats.includes(b.catId))?.key ?? null,
      paid: b.paid,
      estimate: b.variable,
      evidence: b.paid
        ? null
        : evidenceFor({ recurringId: b.recurringId, name: b.name, amount: b.amount, due: dateISO }),
    };
    (oneOff ? planned : bills).push(thing);
  }
  return { planned, bills };
}

// ── the review of a day ───────────────────────────────────────────────────────

/** One piece of the date's graded spending: a charge, or one slice of a split charge. */
export interface ReviewCharge {
  tx: Transaction;
  /** The budget line it is graded on. */
  line: string;
  amount: number;
  /** True when this is one slice of a split charge, so the amount is the slice. */
  split: boolean;
}

/** Why money that left on the date is not in the day's spending. */
export type NotGradedWhy = "pays a bill, a debt or a set-aside" | "between their own accounts" | "outside the budget";

/** Money that left on the date and is not everyday spending. */
export interface OtherOut {
  tx: Transaction;
  amount: number;
  why: NotGradedWhy;
}

export interface SeriesDay {
  date: string;
  allowance: number;
  spent: number;
}

export interface LineMostOver {
  key: string;
  label: string;
  /** Spent on the line this cycle, through the date. */
  spent: number;
  /** The line's whole cycle target. */
  target: number;
  /** What an even pace on this line would have spent through the date. */
  evenPaceSpent: number;
  /** spent − evenPaceSpent: how far ahead of its even pace the line is. */
  overPaceBy: number;
  /** How far past its WHOLE cycle target it already is, or 0. */
  overWholeTargetBy: number;
}

export interface DayPatterns {
  from: string;
  to: string;
  /** Charges graded on the gas + convenience line in the window. */
  gasStops: number;
  /** Charges graded on the dining-out line in the window. */
  diningCharges: number;
  /** Days this cycle, from its first through the date, that spent more than their own
   *  allowance. */
  daysOverThisCycle: number;
  daysCountedThisCycle: number;
  /** Days in a row, ending on the date, that spent no more than their allowance — each
   *  day against its own cycle's allowance, so a streak can cross a payday. */
  streak: number;
  /** True when the streak reached STREAK_MAX and stopped counting. */
  streakAtLimit: boolean;
  /** The line furthest ahead of its even pace this cycle, or null when none is. */
  lineMostOver: LineMostOver | null;
}

export interface CycleToDate {
  through: string;
  spent: number;
  target: number;
  pace: Pace;
  /** The spending so far carried forward at the same daily rate to the cycle's last day:
   *  spent ÷ days counted × days in the cycle. A straight line, not a forecast. */
  projected: number;
}

export interface DayReview {
  /** The date's allowance as it stood at the start of the day, and what it spent. */
  day: DayAllowance;
  /** The date's graded spending, largest first. Sums to day.lines[].spentOn per line. */
  charges: ReviewCharge[];
  /** Money out on the date that is not everyday spending, largest first. */
  otherOut: OtherOut[];
  cycleToDate: CycleToDate;
  patterns: DayPatterns;
  /** The PATTERN_DAYS days ending on the date, oldest first. */
  series: SeriesDay[];
}

/** Largest first, then by id — a total order, so two identical calls list the same
 *  charges in the same order and "the first one" means one thing. */
const byAmountThenId = <T extends { amount: number; tx: Transaction }>(a: T, b: T): number =>
  b.amount - a.amount || a.tx.id.localeCompare(b.tx.id);

/**
 * How one date went: its allowance at the start of the day against what it spent, line
 * by line; the charges behind it; the cycle so far; and plain counts over the week
 * ending on it. Facts and counts only — what to make of them is the conversation's job.
 *
 * Every day's allowance here comes from dayAllowance, the function
 * finance.daily_allowance reports — so the review of a date and the morning figure for
 * that date are one calculation, not two that could disagree.
 */
export function dayReview(
  transactions: Transaction[],
  dateISO: string,
  goals: readonly CycleBudget[] = [],
  lines: BudgetLine[] = LEAN_VARIABLE,
): DayReview {
  const memo = new Map<string, DayAllowance>();
  const on = (d: string): DayAllowance => {
    let hit = memo.get(d);
    if (!hit) {
      hit = dayAllowance(transactions, d, goals, lines);
      memo.set(d, hit);
    }
    return hit;
  };
  const day = on(dateISO);
  const { cycle } = day;
  const overDay = (a: DayAllowance) => a.total.spentOn > a.total.allowance;

  // The date's charges, off the same slices its spending was added up from.
  const lineOf = (cat: string) => lines.find((l) => l.cats.includes(cat))?.key ?? null;
  const slices = spendingSlicesBetween(transactions, dateISO, dateISO);
  const charges: ReviewCharge[] = [];
  const otherOut: OtherOut[] = [];
  const sliced = new Set<string>();
  for (const s of slices) {
    sliced.add(s.tx.id);
    const line = lineOf(s.categoryId);
    const split = !!(s.tx.splits && s.tx.splits.length);
    if (line) charges.push({ tx: s.tx, line, amount: s.amount, split });
    else otherOut.push({ tx: s.tx, amount: s.amount, why: "outside the budget" });
  }
  // The rest of the date's money out is, by the partition's own rule, either tied to
  // something (a bill, a debt, a set-aside, a planned item) or moved between their own
  // accounts — the two things spendingSlicesBetween leaves out.
  for (const t of transactions) {
    if (t.type !== "expense" || t.date !== dateISO || sliced.has(t.id)) continue;
    otherOut.push({
      tx: t,
      amount: t.amount,
      why: t.appliesTo ? "pays a bill, a debt or a set-aside" : "between their own accounts",
    });
  }
  charges.sort(byAmountThenId);
  otherOut.sort(byAmountThenId);

  // The cycle so far, through the end of the date.
  const spentThrough = day.total.spentBefore + day.total.spentOn;
  const cycleToDate: CycleToDate = {
    through: dateISO,
    spent: cents(spentThrough),
    target: day.total.target,
    pace: paceOf(day.total.target, spentThrough, cycle.days, cycle.dayIndex),
    projected: cents((spentThrough / cycle.dayIndex) * cycle.days),
  };

  // Pattern counts over the week ending on the date.
  const from = addDaysISO(dateISO, -(PATTERN_DAYS - 1));
  const chargesOn = (key: string): number => {
    const line = lines.find((l) => l.key === key);
    if (!line) return 0;
    const ids = new Set<string>();
    for (const s of spendingSlicesBetween(transactions, from, dateISO)) {
      if (line.cats.includes(s.categoryId)) ids.add(s.tx.id);
    }
    return ids.size;
  };

  let daysOver = 0;
  for (let d = cycle.start; d <= dateISO; d = addDaysISO(d, 1)) if (overDay(on(d))) daysOver++;

  let streak = 0;
  for (let d = dateISO; streak < STREAK_MAX && !overDay(on(d)); d = addDaysISO(d, -1)) streak++;

  let lineMostOver: LineMostOver | null = null;
  for (const l of day.lines) {
    const spent = l.spentBefore + l.spentOn;
    const evenPaceSpent = (l.target * cycle.dayIndex) / cycle.days;
    const overPaceBy = cents(spent - evenPaceSpent);
    if (overPaceBy <= 0) continue;
    if (lineMostOver && overPaceBy <= lineMostOver.overPaceBy) continue;
    lineMostOver = {
      key: l.key,
      label: l.label,
      spent: cents(spent),
      target: l.target,
      evenPaceSpent: cents(evenPaceSpent),
      overPaceBy,
      overWholeTargetBy: cents(Math.max(0, spent - l.target)),
    };
  }

  const series: SeriesDay[] = [];
  for (let i = PATTERN_DAYS - 1; i >= 0; i--) {
    const a = on(addDaysISO(dateISO, -i));
    series.push({ date: a.date, allowance: a.total.allowance, spent: a.total.spentOn });
  }

  return {
    day,
    charges,
    otherOut,
    cycleToDate,
    patterns: {
      from,
      to: dateISO,
      gasStops: chargesOn(GAS_LINE),
      diningCharges: chargesOn(DINING_LINE),
      daysOverThisCycle: daysOver,
      daysCountedThisCycle: cycle.dayIndex,
      streak,
      streakAtLimit: streak >= STREAK_MAX,
      lineMostOver,
    },
    series,
  };
}
