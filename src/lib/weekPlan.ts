// The week, Sunday to Saturday: the household's weekly plan against what it spent — and
// the ready picture both assistants show exactly as it is.
//
// WHY THIS FILE EXISTS — 2026-10-25
//
// Gino, on the daily allowance: "annoying, almost inaccurate", it never said why, and it
// was not visual. Each complaint was a real fault, and they were three different ones:
//
//   1. THE FIGURE SWUNG. The daily allowance (dailyAllowance.ts) is the cycle's target
//      less what the cycle spent before the date, over the days left. One big shop early
//      in a cycle cut every later day's figure, and after a cycle that ran over it sat
//      at $0 for days on end — a true number nobody could plan with.
//   2. NO VISIBLE ARITHMETIC. "Today you can spend $23" arrived with nothing beside it
//      to say where $23 came from, so it could not be checked and was not believed.
//   3. THE WRONG UNIT. Groceries and gas are bought weekly, not daily, and a night shift
//      splits "today" at midnight: the 1 AM break lands on tomorrow's figure.
//
// So he approved a WEEKLY view: a plan per week, Sunday to Saturday, set per budget line,
// and a picture that shows the sum. This file is that view's arithmetic, in src/lib where
// a screen could call it too. The read door's finance.week reports what it returns —
// through the generated copy (scripts/gen-muse-shared.mjs), so the door runs this exact
// file and the build fails if the copy drifts by a space — and the write door's
// finance.set_weekly_plan reads its rules for which weeks can be set.
//
// WHAT IT STANDS ON, all of it the app's own:
//
//   · what counts as spending — spentByCategoryBetween and spendingSlicesBetween
//     (plan.ts), graded per line with lineSpent, exactly as the budget bars are: pending
//     charges COUNT, money moved between their own accounts does NOT, and a charge tied
//     to a bill, a debt or a planned item is not everyday spending;
//   · what money coming back is — flow.ts's `returned`, the same verdict the run rate
//     takes off spending — and which of it pays back spending on the lines: its own
//     category, or a charge on the lines from the same merchant (moneyBackOf);
//   · the fallback plan — cycleTargets (cycleBudget.ts) on the app's own pay cycle
//     (payCycleFor), so a week with no weekly plan is planned at the pay cycle's own rate.
//
// THE RULES IT HOLDS, each one a way this goes quietly wrong:
//
//   · A plan row STANDS. The plan for a week is the latest row whose week_start is on or
//     before that week's Sunday — so "set it once" holds every week after until another
//     is set, and nobody has to re-enter the same plan each Sunday. A row filed under a
//     day that is not a Sunday is ignored: it would match no week's start and LOOK set.
//   · With no row at all, the plan is the pay cycle's budget per day × 7 — each day at
//     its own cycle's rate (target ÷ that cycle's days), so a week across a payday is
//     planned at both — and the reply SAYS so ("from the pay-cycle budget"), because a
//     derived plan presented as a decision would invent one nobody made.
//   · MONEY BACK comes off the WEEK'S TOTAL, never off a line, and only the money back
//     that TRACES to the lines counts (moneyBackOf, below — read its WHY). So the picture
//     reconciles in one place: spent = the lines added up − money back counted, and
//     spent is never below $0. Money back that does not trace is still listed, and the
//     Why line says how much was left out.
//   · EXACT CENTS IN THE FIELDS, WHOLE DOLLARS IN THE PICTURE — and the picture never
//     contradicts the fields. Over or under is decided from the cents, for the week and
//     for each line; the whole dollars are then chosen to agree with that verdict, and to
//     add up where they can (weekPicture's own comment has the rules).
//
// NO CLOCK. `todayISO` is always handed in. The only Date built here is a calendar day's
// local midnight, from a "YYYY-MM-DD" the caller supplied — the spelling payCycleFor and
// getDay read, the same dayOf cycleBudget.ts uses.

import type { AppData, CycleBudget, Transaction, WeekPlan } from "../types";
import { LEAN_VARIABLE, lineSpent, payCycleFor, spendingSlicesBetween, spentByCategoryBetween, type BudgetLine } from "./plan";
import { cycleTargets } from "./cycleBudget";
import { addDaysISO, isoDate } from "./format";
import { classify } from "./flow";
import { householdPerson, samePerson, zellePerson } from "./categorize";

/** Dollars to the cent. */
const cents = (n: number): number => Math.round(n * 100) / 100;
/** Dollars as whole cents, for comparisons a float's last digit must not flip. */
const inCents = (n: number): number => Math.round(n * 100);

/** A "YYYY-MM-DD" calendar date as that day's LOCAL midnight — what getDay and
 *  payCycleFor read. Never `new Date("YYYY-MM-DD")`, which is UTC midnight and therefore
 *  the previous evening in Arizona. */
function dayOf(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** b − a in calendar days. Date.UTC on the three numbers, so no timezone gets a vote. */
function daysApart(a: string, b: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(b) - at(a)) / 86_400_000);
}

/** Days in a week. Named so "7" is never typed as a bare number below. */
export const WEEK_DAYS = 7;
/** How many weeks after this one a plan may be set for. Two months: far enough to plan
 *  around a known expensive week, near enough that it is a plan and not a wish. */
export const WEEK_PLAN_WEEKS_AHEAD = 8;
/** The largest dollar figure one line may carry for one week. Far above anything a line
 *  spends in seven days; it is here to catch a typo (an extra zero, a month's figure sent
 *  as a week's) before it becomes the plan both phones grade against. */
export const WEEK_LINE_MAX = 5_000;

/** A week: its Sunday, its Saturday, and how a person says it. */
export interface WeekSpan {
  start: string;
  end: string;
  /** "Sun Oct 25 – Sat Oct 31" */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 5" — no leading zero, no year. Built from the date's own numbers rather than
 *  toLocaleDateString, so it reads the same in every runtime and every locale. */
const monthDay = (iso: string): string => {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};

/** Is this a real "YYYY-MM-DD"? 2026-02-31 is well-shaped and is not a day — the Date
 *  constructor would roll it into March, and the March week would answer for it. */
export function isRealISODate(iso: unknown): iso is string {
  return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(iso) && isoDate(dayOf(iso)) === iso;
}

/** Is this a real date that falls on a Sunday — a day a week can start on? */
export function isSunday(iso: unknown): iso is string {
  return isRealISODate(iso) && dayOf(iso).getDay() === 0;
}

/** The week, Sunday to Saturday, that holds this calendar date. The caller passes a real
 *  date; isRealISODate is the check. */
export function weekOf(isoDate: string): WeekSpan {
  const start = addDaysISO(isoDate, -dayOf(isoDate).getDay());
  const end = addDaysISO(start, WEEK_DAYS - 1);
  return { start, end, label: `Sun ${monthDay(start)} – Sat ${monthDay(end)}` };
}

/** Which week a caller means: a word, or any date inside the week. */
export type WhichWeek = "this" | "last" | "next" | string;

/**
 * The week asked for, and how many weeks it lies from the week holding `todayISO`
 * (negative is past) — or null when `which` is neither one of the three words nor a real
 * date. The words are the door's own, so "last week" is never date arithmetic in a chat.
 */
export function resolveWeek(which: WhichWeek, todayISO: string): { week: WeekSpan; offset: number } | null {
  const current = weekOf(todayISO);
  let week: WeekSpan;
  if (which === "this") week = current;
  else if (which === "last") week = weekOf(addDaysISO(current.start, -WEEK_DAYS));
  else if (which === "next") week = weekOf(addDaysISO(current.start, WEEK_DAYS));
  else if (isRealISODate(which)) week = weekOf(which);
  else return null;
  return { week, offset: daysApart(current.start, week.start) / WEEK_DAYS };
}

/** How a week is named at the top of its picture. */
export function weekTitle(offset: number): string {
  if (offset === 0) return "This week";
  if (offset === -1) return "Last week";
  if (offset === 1) return "Next week";
  return offset < 0 ? "Past week" : "Week ahead";
}

/**
 * Why a plan cannot be set (or cleared) for the week that starts on this Sunday — or null
 * when it can. One sentence, plain, ending with the weeks that CAN be set, so the next
 * call can be right. The write door says it as it stands.
 *
 * Never a finished week: a plan looks forward, and re-planning a week that is over would
 * re-grade spending already done. This week is allowed, mid-week included — "we are
 * holding groceries lower from today" is the conversation this exists for.
 */
export function weekPlanProblem(weekStart: string, todayISO: string): string | null {
  const first = weekOf(todayISO).start;
  const last = addDaysISO(first, WEEK_DAYS * WEEK_PLAN_WEEKS_AHEAD);
  const ok = `A weekly plan can be set for this week (starting ${first}) or a week up to ${WEEK_PLAN_WEEKS_AHEAD} weeks ahead (the last one starts ${last}).`;
  if (weekStart < first) {
    return `The week of ${weekOf(weekStart).label} (starting ${weekStart}) is already over, and a plan only looks forward. ${ok}`;
  }
  if (weekStart > last) return `The week starting ${weekStart} is more than ${WEEK_PLAN_WEEKS_AHEAD} weeks ahead. ${ok}`;
  return null;
}

// ── the plan ──────────────────────────────────────────────────────────────────

/** Where a week's plan came from, in the words both doors say it. */
export type PlanIs = "weekly plan" | "from the pay-cycle budget";
export const PLAN_IS_WEEKLY: PlanIs = "weekly plan";
export const PLAN_IS_CYCLE: PlanIs = "from the pay-cycle budget";

/** One line's figure in a row, or null when the row holds nothing a plan can use there —
 *  missing, not a number, or below zero. The table's own check refuses the last two;
 *  this is the belt under it, because a plan both phones grade against should never be
 *  built out of a value nothing checked. */
export function rowAmount(row: WeekPlan, key: string): number | null {
  const v = row.lines?.[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The row that plans this week: the latest one filed under a real Sunday on or before the
 * week's own Sunday, or null when there is none. Two rows for one Sunday cannot exist (the
 * table is unique on week_start); if they ever did, the later one in the list wins, so the
 * answer is at least the same on every call.
 */
export function standingRow(weekStart: string, rows: readonly WeekPlan[] = []): WeekPlan | null {
  let best: WeekPlan | null = null;
  for (const r of rows) {
    if (!isSunday(r.weekStart) || r.weekStart > weekStart) continue;
    if (!r.lines || typeof r.lines !== "object" || Array.isArray(r.lines)) continue;
    if (!best || r.weekStart >= best.weekStart) best = r;
  }
  return best;
}

/** The first row filed for a week AFTER this one — the row whose week takes over from
 *  this week's plan — or null when this week's plan stands for good. */
export function nextRowAfter(weekStart: string, rows: readonly WeekPlan[] = []): WeekPlan | null {
  let best: WeekPlan | null = null;
  for (const r of rows) {
    if (!isSunday(r.weekStart) || r.weekStart <= weekStart) continue;
    if (!best || r.weekStart < best.weekStart) best = r;
  }
  return best;
}

/** The pay cycles the seven days of a week fall in, by first day, earliest first — one,
 *  or two when the week holds a payday. The write door reads exactly these cycles' goals
 *  before it works out a fallback. */
export function cyclesInWeek(weekStart: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const s = payCycleFor(dayOf(addDaysISO(weekStart, i))).start;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * What the pay-cycle budget gives each line over the seven days of a week, to the cent:
 * each day at its own cycle's rate (that cycle's target ÷ its days — the goal where one is
 * set, the standard budget's share where not), added up. Inside one cycle that is exactly
 * the per-day rate × 7; across a payday it is each half at its own cycle's rate.
 */
export function cycleRateForWeek(
  weekStart: string,
  goals: readonly CycleBudget[] = [],
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): number[] {
  const sums = lines.map(() => 0);
  const byCycle = new Map<string, { targets: number[]; days: number }>();
  for (let i = 0; i < WEEK_DAYS; i++) {
    const c = payCycleFor(dayOf(addDaysISO(weekStart, i)));
    let hit = byCycle.get(c.start);
    if (!hit) {
      const t = cycleTargets(c.start, goals, lines);
      hit = { targets: t.lines.map((l) => l.target), days: c.days };
      byCycle.set(c.start, hit);
    }
    for (let k = 0; k < lines.length; k++) sums[k] += hit.days > 0 ? hit.targets[k] / hit.days : 0;
  }
  return sums.map(cents);
}

/** One line's plan for a week, and where it came from. */
export interface WeekPlanLine {
  key: string;
  label: string;
  /** Dollars for the week. */
  plan: number;
  from: PlanIs;
}

/** A whole week's plan. */
export interface WeekPlanFor {
  weekStart: string;
  /** "weekly plan" whenever a row plans the week — the household's decision — and the
   *  fallback's words only when none does. A hand-written row missing a line still reads
   *  "weekly plan"; that one line is planned from the cycle and says so on its own. */
  planIs: PlanIs;
  /** The Sunday the standing row was set for, or null when the plan is the fallback. */
  setFor: string | null;
  lines: WeekPlanLine[];
  /** The lines added up, to the cent. */
  total: number;
}

/**
 * The plan for the week that starts on `weekStart`: the standing row's figures where it
 * has them, the pay-cycle budget's share of the week everywhere else.
 */
export function planForWeek(
  weekStart: string,
  rows: readonly WeekPlan[] = [],
  data: Pick<AppData, "cycleBudgets"> = {},
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): WeekPlanFor {
  const row = standingRow(weekStart, rows);
  let fallback: number[] | null = null;
  const fromCycle = () => (fallback ??= cycleRateForWeek(weekStart, data.cycleBudgets ?? [], lines));
  const out: WeekPlanLine[] = lines.map((l, i) => {
    const a = row ? rowAmount(row, l.key) : null;
    return a !== null
      ? { key: l.key, label: l.label, plan: cents(a), from: PLAN_IS_WEEKLY }
      : { key: l.key, label: l.label, plan: fromCycle()[i], from: PLAN_IS_CYCLE };
  });
  return {
    weekStart,
    planIs: row ? PLAN_IS_WEEKLY : PLAN_IS_CYCLE,
    setFor: row ? row.weekStart : null,
    lines: out,
    total: cents(out.reduce((s, l) => s + l.plan, 0)),
  };
}

// ── the week ──────────────────────────────────────────────────────────────────

/** One budget line over one week. */
export interface WeekLine {
  key: string;
  label: string;
  plan: number;
  /** The budget's own figure for the line over the week's seven days. */
  spent: number;
  /** plan − spent. Negative means over by that much. */
  left: number;
  /** spent − plan when the line is over its plan, to the cent; null when it is not. */
  overBy: number | null;
  from: PlanIs;
}

/** Money that came back in the week: a refund, or a merchant's credit on a card. */
export interface MoneyBackRow {
  tx: Transaction;
  amount: number;
  /** The part of it that comes off the week's total, to the cent: all of it, part of it,
   *  or nothing. */
  counted: number;
  /** The budget line it traces to (a line key), or null when it traces to none. */
  line: string | null;
  /** Why some or all of it is NOT counted, in plain words; null when all of it is. */
  notCounted: string | null;
}

/** One of the week's biggest pieces of graded spending: a charge, or one slice of a
 *  split charge. */
export interface BigCharge {
  tx: Transaction;
  /** The budget line it is graded on. */
  line: string;
  amount: number;
  /** True when this is one slice of a split charge, so the amount is the slice. */
  split: boolean;
}

/** Where the week lies against today. */
export type WeekWhen = "past" | "this" | "future";

export interface WeekView {
  week: WeekSpan;
  /** Weeks from the week holding today; negative is past. */
  offset: number;
  when: WeekWhen;
  /** "This week", "Last week", "Next week", "Past week" or "Week ahead". */
  title: string;
  planIs: PlanIs;
  planSetFor: string | null;
  planTotal: number;
  /** The lines' spending added up, before money back — the lines' own cent figures
   *  added, so the fields reconcile to the cent. */
  spentOnLines: number;
  /** The money back that COUNTS: it traces to the lines, and never more than they spent. */
  moneyBackTotal: number;
  /** The money back listed that does not count, to the cent. */
  moneyBackNotCounted: number;
  /** spentOnLines − moneyBackTotal: the week's spending. Never below 0. */
  spentTotal: number;
  /** planTotal − spentTotal. Negative means over by that much. */
  leftTotal: number;
  /** −leftTotal when the week is over its plan, to the cent; null when it is not. */
  overBy: number | null;
  /** Today through Saturday, both included — 0 for a week that is over, 7 for one that
   *  has not started. */
  daysLeft: number;
  /** max(0, leftTotal) ÷ daysLeft, to the cent; null when no day is left. */
  perDayLeft: number | null;
  lines: WeekLine[];
  /** Largest first. */
  moneyBack: MoneyBackRow[];
  /** At most BIGGEST_MAX, largest first. */
  biggest: BigCharge[];
}

/** How many of the week's charges the view names. Five is enough to see where a week
 *  went; a full list is finance.search_transactions' job. */
export const BIGGEST_MAX = 5;

/** Largest first, then by id — a total order, so two identical calls list the same rows in
 *  the same order and "the first one" means one thing. */
const byAmountThenId = <T extends { amount: number; tx: Transaction }>(a: T, b: T): number =>
  b.amount - a.amount || a.tx.id.localeCompare(b.tx.id);

// ── money back ────────────────────────────────────────────────────────────────
//
// WHICH MONEY BACK COMES OFF THE WEEK — 2026-10-25, found in review
//
// The first cut took every refund dated in the week off the week's total, with no limit.
// Run against the real ledger, one week came out upside down: its lines had spent well
// over the plan, and two mobile check deposits filed as refunds — more than everything
// the lines spent that week — turned its spending negative. The week most over plan read
// as the most under, and "what can we spend?" would have answered with money nobody had
// to spend. A refund for a laptop, a car repair or a bill is real money back, and none of
// it was ever on these lines.
//
// So money back now has to TRACE to the lines before it counts, and the trace is evidence
// already in the ledger, never a guess about intent:
//
//   1. its own category is on a budget line (a merchant's credit filed under Groceries); or
//   2. a charge on the lines from the SAME merchant — the same description, case and
//      spacing aside — in the MONEY_BACK_LOOKBACK_DAYS up to the refund, still big enough
//      to be what it paid back. A refund repays one purchase, so it is never bigger than
//      that purchase; each charge can be paid back once, oldest refund first, so two
//      refunds cannot both lean on the same $20.
//
// The description must match exactly. A near match ("close enough") is how flow.ts's
// three wrong net figures happened, and merchantKey's truncation folds every "CHECKCARD
// 0101 …" descriptor into one merchant. A miss leaves the refund NOT counted — the safe
// way to be wrong when the question is what can still be spent.
//
// And it never takes the week below $0 spent: money back counts only up to what the lines
// spent in the week, oldest first. Whatever is left out is still listed, with its reason,
// and the picture's Why line says how much — nothing is hidden (runRate's rule 4).
//
//   3. a PAYBACK FROM A PERSON — a Zelle in from someone outside the household whom the
//      household sent a Zelle on the lines in the MONEY_BACK_LOOKBACK_DAYS up to it. It
//      counts against the line of the latest such Zelle out. ADDED 2026-10-25: Gino's
//      whole complaint about the daily figure was that it read wrong, and the commonest
//      money back in this household is a friend paying her share of a meal one of them
//      put on a card — no merchant to trace, but a real back-and-forth with that person
//      on the lines. A Zelle from someone never paid (a gift, pay for work) still does
//      not count, and the week-wide cap below still holds.
//
// Counting every refund (the first cut) or only rows filed under a line's category (rule
// 1 alone) are the other answers; each is a one-place change here.

/** How far back money back looks for the purchase it pays back. Most stores take returns
 *  for 30 to 90 days, and a card's credit posts within days of the return. */
export const MONEY_BACK_LOOKBACK_DAYS = 90;

/** Why money back is not counted, in the words both doors say. */
export const NOT_TRACED = `it does not trace to anything bought on the budget lines in the ${MONEY_BACK_LOOKBACK_DAYS} days before it`;
export const BEYOND_SPENT = "it is more than the budget lines spent this week, and money back never takes the week below $0 spent";

/** Is this row money back at all? Its flow (flow.ts) is `returned`, it records no history
 *  (record_only) and it is attached to nothing. A refund tied to a set-aside has already
 *  been answered for — it settled a reimbursable — and a statement import is history the
 *  balance already holds; neither is a week's money back. */
const isMoneyBack = (txn: Transaction, flow: string): boolean =>
  txn.type === "income" && flow === "returned" && !txn.recordOnly && !txn.appliesTo;

/** A description as a merchant: case and runs of spaces thrown away, nothing else. */
const merchantOf = (description: string | undefined): string => (description ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Every row of money back dated up to `upToISO`, mapped to the budget line it traces to,
 * or to null when it traces to none — the rules in the comment above. Worked out over the
 * whole ledger, oldest refund first, so a week's answer is the same whenever it is asked:
 * a refund only ever leans on a charge dated on or before it.
 */
export function traceMoneyBack(
  data: Pick<AppData, "transactions" | "accounts">,
  upToISO: string,
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): Map<string, string | null> {
  const lineOfCat = (cat: string) => lines.find((l) => l.cats.includes(cat))?.key ?? null;

  // Every charge the lines graded, by merchant: what it put on the lines (in cents, the
  // pool a refund can pay back) and the line it put the most on.
  type Charge = { date: string; id: string; merchant: string; desc: string; line: string; best: number; left: number };
  const charges = new Map<string, Charge>();
  for (const s of spendingSlicesBetween(data.transactions, "0000-01-01", upToISO)) {
    const line = lineOfCat(s.categoryId);
    if (!line) continue;
    const c = inCents(s.amount);
    const hit = charges.get(s.tx.id);
    if (!hit) {
      charges.set(s.tx.id, { date: s.tx.date, id: s.tx.id, merchant: merchantOf(s.tx.description), desc: s.tx.description ?? "", line, best: c, left: c });
    } else {
      hit.left += c;
      if (c > hit.best) {
        hit.best = c;
        hit.line = line;
      }
    }
  }
  const pools = new Map<string, Charge[]>();
  for (const c of charges.values()) {
    if (!c.merchant) continue;
    if (!pools.has(c.merchant)) pools.set(c.merchant, []);
    pools.get(c.merchant)!.push(c);
  }

  const backs = classify(data.transactions, data.accounts)
    .filter(({ txn, verdict }) => isMoneyBack(txn, verdict.flow) && txn.date <= upToISO)
    .map(({ txn }) => txn)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const out = new Map<string, string | null>();
  for (const b of backs) {
    const own = lineOfCat(b.categoryId);
    if (own) {
      out.set(b.id, own);
      continue;
    }
    const from = addDaysISO(b.date, -MONEY_BACK_LOOKBACK_DAYS);
    // Rule 3: a friend paying back. The latest Zelle out to the same person on the lines.
    const person = zellePerson(b.description ?? "", "from");
    if (person && !householdPerson(person)) {
      let paid: Charge | null = null;
      for (const c of charges.values()) {
        if (c.date < from || c.date > b.date) continue;
        const to = zellePerson(c.desc, "to");
        if (!to || !samePerson(to, person)) continue;
        if (!paid || c.date > paid.date || (c.date === paid.date && c.id > paid.id)) paid = c;
      }
      out.set(b.id, paid ? paid.line : null);
      continue;
    }
    const need = inCents(b.amount);
    // The latest purchase in the window that can still cover it — the likeliest one it
    // paid back. Ties go to the larger id, so the choice is the same on every call.
    let pick: Charge | null = null;
    for (const c of pools.get(merchantOf(b.description)) ?? []) {
      if (c.date < from || c.date > b.date || c.left < need) continue;
      if (!pick || c.date > pick.date || (c.date === pick.date && c.id > pick.id)) pick = c;
    }
    if (pick) pick.left -= need;
    out.set(b.id, pick ? pick.line : null);
  }
  return out;
}

/**
 * The money back dated in a week, each row with what of it counts and why the rest does
 * not — largest first. `linesSpent` is what the lines spent that week, in dollars: money
 * back counts only up to it, oldest first, so the week's spending is never below $0.
 */
export function moneyBackOf(
  data: Pick<AppData, "transactions" | "accounts">,
  startISO: string,
  endISO: string,
  linesSpent: number,
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): MoneyBackRow[] {
  const traced = traceMoneyBack(data, endISO, lines);
  const inWeek = classify(data.transactions, data.accounts)
    .filter(({ txn, verdict }) => isMoneyBack(txn, verdict.flow) && txn.date >= startISO && txn.date <= endISO)
    .map(({ txn }) => txn)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let room = Math.max(0, inCents(linesSpent));
  const out: MoneyBackRow[] = [];
  for (const tx of inWeek) {
    const line = traced.get(tx.id) ?? null;
    const amount = inCents(tx.amount);
    const counted = line ? Math.min(amount, room) : 0;
    room -= counted;
    out.push({
      tx,
      amount: tx.amount,
      counted: counted / 100,
      line,
      notCounted: !line ? NOT_TRACED : counted < amount ? BEYOND_SPENT : null,
    });
  }
  return out.sort(byAmountThenId);
}

/**
 * The week asked for: its plan per line against what the budget counts as spent, the
 * money that came back, what is left and over how many days, and its biggest charges.
 *
 * `which` is "this", "last", "next" or any date inside the wanted week; a value that is
 * none of those throws, because the door checks it first and a caller that skipped the
 * check is a bug, not a question.
 */
export function weekView(
  data: AppData,
  weekPlans: readonly WeekPlan[],
  todayISO: string,
  which: WhichWeek = "this",
  lines: readonly BudgetLine[] = LEAN_VARIABLE,
): WeekView {
  const resolved = resolveWeek(which, todayISO);
  if (!resolved) throw new Error(`weekView: "${String(which)}" is not a week`);
  const { week, offset } = resolved;
  const plan = planForWeek(week.start, weekPlans, data, lines);

  // The budget's own partition over the seven days, graded per line exactly as the bars
  // grade a cycle — so a line's figure here and the same charges on the budget agree.
  const byCat = spentByCategoryBetween(data.transactions, week.start, week.end);
  // The week's figures are the LINES' cent figures added up, so spent_on_lines is the sum
  // of the lines to the cent and not a separately rounded total a cent away from it.
  let linesC = 0;
  const out: WeekLine[] = lines.map((l, i) => {
    const spent = cents(lineSpent(l, byCat));
    linesC += inCents(spent);
    const planned = plan.lines[i].plan;
    return {
      key: l.key,
      label: l.label,
      plan: planned,
      spent,
      left: cents(planned - spent),
      overBy: inCents(spent) > inCents(planned) ? cents(spent - planned) : null,
      from: plan.lines[i].from,
    };
  });

  // Money back counts only where it traces to the lines, and never past what they spent
  // (moneyBackOf), so spentTotal cannot go below 0.
  const moneyBack = moneyBackOf(data, week.start, week.end, linesC / 100, lines);
  const backC = moneyBack.reduce((s, m) => s + inCents(m.counted), 0);
  const notCountedC = moneyBack.reduce((s, m) => s + inCents(m.amount) - inCents(m.counted), 0);
  const spentTotal = (linesC - backC) / 100;
  const leftTotal = (inCents(plan.total) - (linesC - backC)) / 100;
  const when: WeekWhen = offset < 0 ? "past" : offset > 0 ? "future" : "this";
  const daysLeft = when === "past" ? 0 : when === "future" ? WEEK_DAYS : daysApart(todayISO, week.end) + 1;

  // The biggest pieces of the week's graded spending, off the same slices its line
  // figures were added up from — so a charge named here is one the lines counted.
  const lineOf = (cat: string) => lines.find((l) => l.cats.includes(cat))?.key ?? null;
  const biggest: BigCharge[] = [];
  for (const s of spendingSlicesBetween(data.transactions, week.start, week.end)) {
    const line = lineOf(s.categoryId);
    if (!line) continue;
    biggest.push({ tx: s.tx, line, amount: s.amount, split: !!(s.tx.splits && s.tx.splits.length) });
  }
  biggest.sort(byAmountThenId);

  return {
    week,
    offset,
    when,
    title: weekTitle(offset),
    planIs: plan.planIs,
    planSetFor: plan.setFor,
    planTotal: plan.total,
    spentOnLines: linesC / 100,
    moneyBackTotal: backC / 100,
    moneyBackNotCounted: notCountedC / 100,
    spentTotal,
    leftTotal,
    overBy: inCents(leftTotal) < 0 ? cents(-leftTotal) : null,
    daysLeft,
    perDayLeft: daysLeft > 0 ? cents(Math.max(0, leftTotal) / daysLeft) : null,
    lines: out,
    moneyBack,
    biggest: biggest.slice(0, BIGGEST_MAX),
  };
}

// ── the picture ───────────────────────────────────────────────────────────────
//
// WHY THE PICTURE IS BUILT HERE AND NOT BY EITHER ASSISTANT. There are two Muses, one per
// phone. Asked to "show the week", each would draw its own bars from the fields, round
// its own way and word its own sum — two pictures of one week that disagree by a dollar
// or a bar, which is exactly the doubt this view exists to end. So the door hands over a
// finished picture, the same characters on both phones, and an assistant's only job is to
// put it in a code block as it stands and say its Why line in words.

/** The widest a picture line may be: a phone's code block, in a portrait screen. */
export const PICTURE_WIDTH = 52;
/** Cells in the week's own bar, and in each line's. */
export const TOTAL_BAR_CELLS = 20;
export const LINE_BAR_CELLS = 10;
const FULL = "█";
const EMPTY = "░";
/** The label column: a short label (at most LABEL_MAX) and the space after it. */
const LABEL_COL = 12;
const LABEL_MAX = LABEL_COL - 1;
/** The header column of the two summary lines ("Spent so far", "Left", "Over by"). */
const HEAD_COL = 14;

/** Columns a line takes. Every character the picture uses is one column wide and one
 *  UTF-16 unit long, but a label is counted by code point so one that is not cannot
 *  quietly push a line past the edge. */
const cols = (s: string): number => [...s].length;
const padTo = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - cols(s)));
const padStartTo = (s: string, n: number): string => " ".repeat(Math.max(0, n - cols(s))) + s;

/** "$1,234", "−$20" — whole dollars with thousands separators and a real minus sign,
 *  built by hand so no runtime's locale gets a vote. */
export function usd(n: number): string {
  const whole = Math.round(n);
  const digits = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole < 0 ? "−" : ""}$${digits}`;
}

const days = (n: number): string => (n === 1 ? "1 day" : `${n} days`);

/** A figure already to the cent, as whole dollars, half up. Never below zero here. */
export const roundDollars = (n: number): number => Math.floor((Math.max(0, inCents(n)) + 50) / 100);

/** Whole dollars for a figure the picture SHOWS: "under $1" when it rounds to $0 and is
 *  not $0, so a real overspend, a real amount left or a real refund never reads as none. */
const shownAs = (dollars: number, exact: number): string => (dollars === 0 && inCents(exact) > 0 ? "under $1" : usd(dollars));
/** A figure at the start of a sentence: "Under $1 …", "$12 …". */
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Whole dollars that ADD UP to `target` (by default the values' own total, rounded) where
 * they can: each value rounded down, then the missing dollars handed to the values that
 * lost the most cents.
 *
 * Rounding each line on its own shows $10.40, $10.30 and $9.80 as $10 + $10 + $10 = $30
 * under a total of $30.50, which rounds to $31 — and a picture whose sum does not add up
 * is a picture nobody believes, which is the fault this view was built to fix.
 *
 * EQUAL CENTS SHOW AS EQUAL DOLLARS — 2026-10-25, found in review. The first cut broke
 * ties by position, so two lines both planned at $20.40 read "$21" and "$20" one above
 * the other. Now equal values are one group, given the dollar together or not at all, and
 * groups are ordered by the cents they lost and then by value — never by where they sit.
 * When a group is too big for the dollars left over, it is skipped and a smaller remainder
 * takes them; when nothing fits, the parts miss the target by those dollars. That is the
 * one case the column does not add up, and every figure is still within $1 of its own.
 * Values below zero do not occur here and are read as zero.
 */
export function wholeDollars(values: readonly number[], target?: number): number[] {
  const c = values.map((v) => Math.max(0, inCents(v)));
  const out = c.map((x) => Math.floor(x / 100));
  const goal = target ?? Math.floor((c.reduce((s, x) => s + x, 0) + 50) / 100);
  let need = goal - out.reduce((s, x) => s + x, 0);
  const groups = new Map<number, number[]>();
  c.forEach((x, i) => {
    if (x % 100 === 0) return;
    if (!groups.has(x)) groups.set(x, []);
    groups.get(x)!.push(i);
  });
  const order = [...groups.entries()].sort(([a], [b]) => (b % 100) - (a % 100) || b - a);
  for (const [, at] of order) {
    if (need <= 0) break;
    if (at.length > need) continue;
    for (const i of at) out[i] += 1;
    need -= at.length;
  }
  return out;
}

/**
 * A bar of `cells`: the share of the plan spent, proportional, capped at full. `full`
 * forces a full bar — an over line is always full whatever the proportion rounds to. A
 * line with no plan is full as soon as anything is spent on it, and empty until then.
 */
export function bar(spent: number, plan: number, cells: number, full = false): string {
  let n: number;
  if (full) n = cells;
  else if (!(plan > 0)) n = spent > 0 ? cells : 0;
  else n = Math.round((cells * Math.max(0, spent)) / plan);
  n = Math.min(cells, Math.max(0, n));
  return FULL.repeat(n) + EMPTY.repeat(cells - n);
}

/** A line's label as the picture shows it: its first word ("Gas + convenience" → "Gas",
 *  "Dining out" → "Dining"), read off the plan's own label rather than typed again, and
 *  never wider than the label column. */
export function shortLabel(label: string): string {
  const first = label.trim().split(/[\s/+]+/)[0] || label.trim();
  return [...first].slice(0, LABEL_MAX).join("");
}

/** Words onto lines no wider than `width`, every line after the first indented. */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (cols(next) <= width || !line) {
      line = next;
      continue;
    }
    out.push(line);
    line = `${indent}${word}`;
  }
  if (line) out.push(line);
  return out;
}

/** A line, or — when it would not fit — its head and its tail on two lines, the tail
 *  indented under the column it continues. */
function fit(head: string, tail: string, gap: string, indent: number): string[] {
  const one = `${head}${gap}${tail}`;
  return cols(one) <= PICTURE_WIDTH ? [one] : [head, `${" ".repeat(indent)}${tail}`];
}

/**
 * The week as a ready picture: monospace, no line wider than PICTURE_WIDTH, joined with
 * newlines. Shaped like this (made-up figures):
 *
 *   This week · Sun Oct 25 – Sat Oct 31       Plan $300
 *
 *   Spent so far  ████████░░░░░░░░░░░░  $120
 *   Left          $180 for 5 days  →  about $36 a day
 *
 *   Groceries   ██████░░░░   $42 of $70
 *   ...
 *   Money back                −$10
 *
 *   Why: $300 plan − $120 spent = $180 left, spread
 *        over the 5 days left. ...
 *
 * HOW THE WHOLE DOLLARS ARE CHOSEN — 2026-10-25, found in review. The first cut built
 * every figure out of apportioned line dollars, so its over-or-under could disagree with
 * the fields: a week $0.01 under its plan drew "Over by $1", and a week $0.05 over drew
 * "Left $0". An assistant told to say the Why line would then tell them they were over
 * when they were not. Now, in this order:
 *
 *   1. OVER OR UNDER IS THE CENTS' VERDICT — the week's from over_by, each line's from its
 *      own over_by. Nothing below can turn it.
 *   2. THE TOTALS ARE EACH ROUNDED ON THEIR OWN (plan, spent, money back), and the gap is
 *      their difference. Rounding keeps order, so an under week never shows more spent
 *      than planned and an over week never less, and "plan − spent = left" holds in the
 *      picture's own dollars. A gap that rounds to $0 but is not $0 reads "under $1".
 *   3. THE LINE COLUMNS ADD UP TO THOSE TOTALS (wholeDollars), equal cents as equal
 *      dollars. Then each line is held to its own verdict: an under line never shows more
 *      spent than planned, an over line never less, and its "over by" is the difference
 *      it shows — or "under $1". Only a tie, or that last check, can leave a column off
 *      its total, by the dollars it could not place; every figure stays within $1 of its
 *      own cents.
 *
 * `say` cleans each label before it is drawn — the read door passes its scrubber, so a
 * label that ever came from data rather than the plan's own constants cannot carry a link
 * or an instruction into the picture. A line with no plan and nothing spent (a line the
 * household has set to $0) is left out; the fields still carry it.
 */
export function weekPicture(v: WeekView, say: (label: string, key: string) => string = (label) => label): string {
  const over = v.overBy !== null;
  const planTotalD = roundDollars(v.planTotal);
  const spentTotalD = roundDollars(v.spentTotal);
  const backD = roundDollars(v.moneyBackTotal);
  const gapD = Math.abs(planTotalD - spentTotalD);
  const linesD = spentTotalD + backD;
  const planD = wholeDollars(v.lines.map((l) => l.plan), planTotalD);
  const spentD = wholeDollars(v.lines.map((l) => l.spent), linesD);
  v.lines.forEach((l, i) => {
    if (l.overBy === null && spentD[i] > planD[i]) spentD[i] = planD[i];
    if (l.overBy !== null && spentD[i] < planD[i]) spentD[i] = planD[i];
  });

  const out: string[] = [];

  // The title, and the plan at the right edge.
  const head = `${v.title} · ${v.week.label}`;
  const planTxt = `Plan ${usd(planTotalD)}`;
  const room = PICTURE_WIDTH - cols(head) - cols(planTxt);
  if (room >= 1) out.push(`${head}${" ".repeat(room)}${planTxt}`);
  else out.push(head, planTxt);
  out.push("");

  // The week in one bar, and what it leaves.
  const spentLabel = v.when === "past" ? "Spent" : "Spent so far";
  out.push(`${padTo(spentLabel, HEAD_COL)}${bar(v.spentTotal, v.planTotal, TOTAL_BAR_CELLS, over)}  ${usd(spentTotalD)}`);
  const gapTxt = shownAs(gapD, over ? (v.overBy ?? 0) : v.leftTotal);
  if (over) {
    const tail = v.daysLeft > 0 ? `${gapTxt} with ${days(v.daysLeft)} left` : gapTxt;
    out.push(`${padTo("Over by", HEAD_COL)}${tail}`);
  } else if (v.daysLeft > 0) {
    const perDay = v.perDayLeft ?? 0;
    const perDayD = roundDollars(perDay);
    const perDayTxt = perDayD === 0 && inCents(perDay) > 0 ? "under $1 a day" : `about ${usd(perDayD)} a day`;
    out.push(...fit(`${padTo("Left", HEAD_COL)}${gapTxt} for ${days(v.daysLeft)}`, `→  ${perDayTxt}`, "  ", HEAD_COL));
  } else {
    out.push(`${padTo("Left", HEAD_COL)}${gapTxt} unspent`);
  }

  // One row per line, the spent figures right-aligned in one column.
  const backTxt = backD > 0 ? usd(-backD) : "under $1";
  const backWords = shownAs(backD, v.moneyBackTotal);
  const showBack = inCents(v.moneyBackTotal) > 0;
  const shown = v.lines.map((l, i) => ({ l, i })).filter(({ l }) => inCents(l.plan) > 0 || inCents(l.spent) > 0);
  const amountW = Math.max(0, ...shown.map(({ i }) => cols(usd(spentD[i]))), showBack ? cols(backTxt) : 0);
  const rows: string[] = [];
  for (const { l, i } of shown) {
    const lineOver = l.overBy !== null;
    const label = padTo(shortLabel(say(l.label, l.key)), LABEL_COL);
    const row = `${label}${bar(l.spent, l.plan, LINE_BAR_CELLS, lineOver)}  ${padStartTo(usd(spentD[i]), amountW)} of ${usd(planD[i])}`;
    const overTxt = `over by ${shownAs(spentD[i] - planD[i], l.overBy ?? 0)}`;
    rows.push(...(lineOver ? fit(row, overTxt, "  ", LABEL_COL + LINE_BAR_CELLS + 2) : [row]));
  }
  // Shown whenever any counts, even under 50 cents, so the row and the fields name the
  // same money (2026-10-25, review).
  if (showBack) {
    rows.push(`${padTo("Money back", LABEL_COL)}${" ".repeat(LINE_BAR_CELLS)}  ${padStartTo(backTxt, amountW)}`);
  }
  if (rows.length) out.push("", ...rows);

  // The sum, in words, so the picture explains itself.
  const minus = `${usd(planTotalD)} plan − ${usd(spentTotalD)} spent`;
  let why: string;
  if (over && gapD === 0) {
    why = `${minus}, and the week is over by under $1${v.daysLeft > 0 ? `, with ${days(v.daysLeft)} left.` : "."}`;
  } else if (over) {
    why = `${minus} = ${usd(gapD)} over${v.daysLeft > 0 ? `, with ${days(v.daysLeft)} left.` : " plan."}`;
  } else if (v.daysLeft > 0) {
    why = `${minus} = ${gapTxt} left, spread over the ${days(v.daysLeft)} left.`;
  } else {
    why = `${minus} = ${gapTxt} left over.`;
  }
  if (showBack) why += ` Spent is ${usd(linesD)} on the lines less ${backWords} money back.`;
  // What was left out, so a refund nobody sees counted is never a refund nobody sees.
  const untraced = v.moneyBack.reduce((s, m) => s + (m.line === null ? inCents(m.amount) : 0), 0) / 100;
  const beyond = v.moneyBack.reduce((s, m) => s + (m.line !== null ? inCents(m.amount) - inCents(m.counted) : 0), 0) / 100;
  if (inCents(untraced) > 0) {
    why += ` ${capital(shownAs(roundDollars(untraced), untraced))} of money back is not counted: it does not trace to anything bought on the lines.`;
  }
  if (inCents(beyond) > 0) {
    why += ` ${capital(shownAs(roundDollars(beyond), beyond))} more came back than the lines spent, so it is not counted.`;
  }
  if (v.planIs === PLAN_IS_CYCLE) {
    why += ` No weekly plan is set, so the plan is the pay-cycle budget's share of these ${WEEK_DAYS} days.`;
  }
  out.push("", ...wrap(`Why: ${why}`, PICTURE_WIDTH, "     "));

  return out.join("\n");
}

/** The Why line alone, joined back into one sentence — what an assistant says aloud. */
export function whyOf(picture: string): string {
  const lines = picture.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Why: "));
  if (at < 0) return "";
  return lines
    .slice(at)
    .map((l) => l.trim())
    .join(" ")
    .replace(/^Why: /, "");
}
