// The daily money check-in: two read tools, one for the start of a day and one for the
// end of it.
//
// WHY THESE EXIST — 2026-10-10
//
// The household asked Muse to run a daily money routine: at the start of each person's
// day, "what can we spend today", and at the end of it, "the goal against what we spent,
// what to keep doing, what to cut back". Before these, the only way to answer was for
// the assistant to take finance.budget_status's cycle figures and divide them by the
// days left itself — which is arithmetic in a chat, the one thing both doors exist to
// forbid. A figure worked out by the assistant has no screen beside it to disagree, and
// every hand-made copy of the app's maths in this repo has drifted (cron-notify once told
// the phones one figure for the electric bill while every screen said another).
//
// So every number here is worked out in src/lib/dailyAllowance.ts — generated into
// ./lib, checked byte for byte by the build — on top of the app's own pay cycle, the
// cycle's own targets (the goal when one is set, the standard budget's share when not)
// and the app's own spending partition (pending charges count, money moved between their
// own accounts does not, anything tied to a bill or a planned item is not everyday
// spending). These tools report fields; they divide, subtract and add nothing.
//
// ONE HOUSEHOLD. The allowance is the household's — both people spend from one pool and
// both keys get the same figures. Account names never appear here; where one person's
// review needs to say whose charge it was, that is what finance.transaction is for.
//
// FACTS AND COUNTS ONLY. finance.day_review counts gas stops and dining charges, days
// over and the current streak; it never says "cut back on dining". The coaching words
// are the conversation's job, and keeping them out of the door keeps the door checkable:
// every field is a number or a date somebody can compare against the ledger.
//
// RULE 2: no clock. The date defaults to `now`'s Arizona date — the `now` the handler
// built once for the request — never the runtime's, and never a Date built here.

import {
  dayAllowance,
  dayReview,
  dueOnDate,
  PATTERN_DAYS,
  STREAK_MAX,
  weekAhead,
  type AllowanceLine,
  type DueThing,
  type Pace,
} from "./lib/dailyAllowance.ts";
import { addDaysISO, isoDate } from "./lib/format.ts";
import type { Transaction } from "./lib/types.ts";
import { daysBetweenISO } from "./az.ts";
import { BadArgs, optDateArg, type Json, type Tool } from "./args.ts";
import { LINE_TARGET_IS, TARGETS_ARE } from "./cycleWords.ts";
import { maskDigits } from "./toolsFinance.ts";
import { money, scrubName, scrubOr, NAME_MAX } from "./scrub.ts";

/** How far back either tool answers, in days. A year is more than any routine asks for,
 *  and every older day is still one call to finance.search_transactions away. */
export const DAILY_DAYS_BACK_MAX = 366;
/** How far ahead finance.daily_allowance answers. A week: "what can we spend on
 *  Saturday" is a fair question; a month out, every day between now and then has spent
 *  nothing yet, and the figure would read as a promise. */
export const ALLOWANCE_DAYS_AHEAD_MAX = 7;
/** The most charges, and the most other money-out rows, one review lists. A day holds
 *  a handful; the cap is here so a reply size cannot be surprised by a ledger import. */
export const REVIEW_CHARGES_MAX = 50;

/** The one word `date` may carry instead of a calendar date. */
export const YESTERDAY = "yesterday";

/** The date asked about — default today in Arizona — refused when it is out of range.
 *  `aheadMax` is 0 for the review: a day that has not happened has nothing to review.
 *
 *  WHY "yesterday" IS ACCEPTED — 2026-10-10
 *
 *  Gino's review runs at about 8:30 AM and covers the calendar date that ended at
 *  midnight, eight hours earlier, in the middle of his shift. Without this word the
 *  assistant has to work out that date itself — date arithmetic in a chat, at the one
 *  hour of his day when "yesterday" is genuinely ambiguous to a person (his day runs
 *  4 PM to 9 AM, so to him the shift that just ended is "today"). The door already
 *  owns the one Arizona `now` for the request (API.md rule 6: "the door works out now
 *  itself"), so it is the door that turns "yesterday" into a date: the Arizona date
 *  before `today`, with the same calendar-day step the rest of the app uses. The
 *  reply's own `date` then says which day was answered, so the assistant reads the
 *  date out rather than assuming it. */
function dateIn(args: Record<string, unknown>, today: string, aheadMax: number): string {
  const date = args.date === YESTERDAY ? addDaysISO(today, -1) : optDateArg(args, "date", today);
  const ahead = daysBetweenISO(today, date);
  if (ahead > aheadMax) {
    throw new BadArgs(
      aheadMax === 0
        ? `${date} has not happened yet, so there is nothing to review. Ask about ${today} or earlier.`
        : `${date} is more than ${aheadMax} days ahead. Ask about ${today} or up to ${aheadMax} days after it.`,
    );
  }
  if (-ahead > DAILY_DAYS_BACK_MAX) {
    throw new BadArgs(`${date} is more than ${DAILY_DAYS_BACK_MAX} days back. Ask finance.search_transactions about a day that old.`);
  }
  return date;
}

const sayPace = (p: Pace): { [k: string]: Json } => ({
  is: p.verdict,
  spent: money(p.spent),
  an_even_pace_would_have_spent: money(p.evenPaceSpent),
  days_counted: p.daysCounted,
});

/** A charge's cleaned merchant name, with long digit runs masked — see maskDigits. */
const merchantOf = (t: Transaction): string => maskDigits(scrubOr(t.description, "(a name I cannot say safely)"));

/** What the ledger shows about an unpaid bill, spelled exactly as finance.next_bills and
 *  finance.bill_calendar spell it, so one vocabulary covers all three replies. */
function sayEvidence(d: DueThing): { paying_now: Json; maybe_already_paid: Json } {
  const ev = d.evidence;
  return {
    paying_now: ev?.payingNow
      ? { amount: money(ev.payingNow.amount), on: ev.payingNow.date, why: ev.payingNow.why }
      : null,
    maybe_already_paid: ev?.maybeAlreadyPaid
      ? {
          charge: ev.maybeAlreadyPaid.id,
          amount: money(ev.maybeAlreadyPaid.amount),
          on: ev.maybeAlreadyPaid.date,
          why: "a charge on this bill's own account, for this amount, in this cycle, that nothing has tied to the bill",
        }
      : null,
  };
}

// ── finance.daily_allowance ───────────────────────────────────────────────────

const ALLOWANCE_NOTE =
  "ONE HOUSEHOLD BUDGET for both of you. The allowance for a date is the pay cycle's target, less what the household " +
  "already spent on the budget lines this cycle BEFORE that date, split evenly over the days left in the cycle — that " +
  "date included. So spending over a day's allowance makes every later day's smaller, and spending under it makes them " +
  "bigger. It never goes below zero: zero means the cycle's target is already used up. total.allowance is worked out " +
  "from the whole envelope, so a line already over its target pulls it down — it can be less than the lines added up. " +
  "left_on_date is the allowance less what the date has spent so far; negative means over by that much. Charges still " +
  "processing count; money moved between your own accounts does not. planned_items and bills_due are NOT everyday " +
  "spending and are not in any figure above them — say them separately, never as part of what can be spent. A planned " +
  "item's charge stays off its budget line only once it is tied to its row (finance.link_charge_to_bill). targets_are " +
  "says whether the targets are this cycle's goal or the standard budget; say which. Every figure is worked out already: " +
  "do not add, subtract or divide anything yourself.";

const sayAllowanceLine = (l: AllowanceLine): { [k: string]: Json } => ({
  key: l.key,
  label: scrubOr(l.label, l.key),
  target: money(l.target),
  target_is: LINE_TARGET_IS[l.from],
  spent_before: money(l.spentBefore),
  allowance: money(l.allowance),
  spent_on_date: money(l.spentOn),
  left_on_date: money(l.left),
});

const financeDailyAllowance: Tool = {
  name: "finance.daily_allowance",
  summary:
    "What the household can spend on one day — the pay cycle's target less what it already spent, over the days left — per line and in total, with the week's pace and that day's bills and planned items listed apart.",
  args: [
    {
      name: "date",
      type: "string",
      required: false,
      description: `Which day, YYYY-MM-DD, or the word "${YESTERDAY}". Default today in Arizona. Up to ${ALLOWANCE_DAYS_AHEAD_MAX} days ahead or ${DAILY_DAYS_BACK_MAX} back.`,
    },
  ],
  async run({ load, now, args }) {
    const today = isoDate(now);
    const date = dateIn(args, today, ALLOWANCE_DAYS_AHEAD_MAX);
    const [data, goals] = await Promise.all([load.appData(), load.cycleBudgets()]);
    const day = dayAllowance(data.transactions, date, goals.rows);
    const week = weekAhead(data.transactions, day, goals.rows);
    const due = dueOnDate(data, date, now);
    return {
      date,
      is_today: date === today,
      // A day ahead has spent nothing yet by definition, and neither have the days
      // between now and then — so its allowance assumes nothing more is spent before it.
      date_is_ahead: date > today,
      cycle: {
        start: day.cycle.start,
        end: day.cycle.end,
        label: scrubOr(day.cycle.label, `${day.cycle.start} to ${day.cycle.end}`),
        day: day.cycle.dayIndex,
        days: day.cycle.days,
        days_left_including_date: day.daysLeft,
      },
      targets_are: TARGETS_ARE[day.targetsFrom],
      goal_table_set_up: goals.known,
      total: {
        target: money(day.total.target),
        spent_before: money(day.total.spentBefore),
        allowance: money(day.total.allowance),
        spent_on_date: money(day.total.spentOn),
        left_on_date: money(day.total.left),
        even_daily_share: money(day.total.evenDailyShare),
      },
      lines: day.lines.map(sayAllowanceLine),
      // Computed in dailyAllowance.ts: the days before the date against an even pace.
      pace: sayPace(day.pace),
      this_week: {
        from: week.from,
        to: week.to,
        spent_before_date: money(week.spentBefore),
        days_left_including_date: week.daysLeft,
        rest_of_week_can_take: money(week.canTake),
        crosses_into_next_cycle: week.crossesIntoNextCycle,
        parts: week.parts.map((p) => ({
          from: p.from,
          to: p.to,
          days: p.days,
          cycle_start: p.cycleStart,
          daily_allowance: money(p.dailyAllowance),
          can_take: money(p.canTake),
          pace_is:
            p.paceIs === "this cycle"
              ? "this date's allowance"
              : "the next cycle's opening allowance — a new paycheck starts a new pace",
        })),
      },
      planned_items: due.planned.map((d) => ({
        bill: d.recurringId,
        name: scrubOr(d.name, "a planned item"),
        amount: money(d.amount),
        // Which budget line its charge would land on if it is not tied to its row.
        budget_line: d.line,
        estimate: d.estimate,
        ...sayEvidence(d),
      })),
      bills_due: due.bills.map((d) => ({
        bill: d.recurringId,
        name: scrubOr(d.name, "a bill"),
        amount: money(d.amount),
        paid: d.paid,
        estimate: d.estimate,
        ...sayEvidence(d),
      })),
      note: ALLOWANCE_NOTE,
    };
  },
};

// ── finance.day_review ────────────────────────────────────────────────────────

const REVIEW_NOTE =
  "ONE HOUSEHOLD BUDGET for both of you. allowance is what the date could take as it stood at the START of that day, " +
  "by the same rule finance.daily_allowance uses; spent is what the date spent on the budget lines, charges still " +
  "processing included; left negative means over by that much. charges are that spending, largest first, and add up to " +
  "each line's spent. other_money_out is money that left on the date but is not everyday spending — a bill, a debt " +
  "payment, a planned item tied to its row, a move between your own accounts, or a category no budget line grades — and " +
  "is in no figure above it. cycle_to_date.projected_cycle_total is the spending so far carried forward at the same " +
  "daily rate to the cycle's last day: a straight line, not a forecast. patterns are plain counts over the days from " +
  "patterns.from to patterns.to; the streak counts days in a row, ending on the date, that spent no more than their own " +
  "allowance. If is_today is true the day is not over yet. These are facts and counts: what to keep doing and what to " +
  "cut back is for you to say, from them — never a figure you work out yourself.";

const financeDayReview: Tool = {
  name: "finance.day_review",
  summary:
    "How one day went against its allowance — per line, the charges behind it, the cycle so far with its projected total, and plain counts of the week's patterns.",
  args: [
    {
      name: "date",
      type: "string",
      required: false,
      description: `Which day, YYYY-MM-DD, or the word "${YESTERDAY}" — the Arizona date before today, which is what a morning review of the day before sends. Default today in Arizona. Up to ${DAILY_DAYS_BACK_MAX} days back.`,
    },
  ],
  async run({ load, now, args }) {
    const today = isoDate(now);
    const date = dateIn(args, today, 0);
    const [data, goals] = await Promise.all([load.appData(), load.cycleBudgets()]);
    const r = dayReview(data.transactions, date, goals.rows);
    const { day, cycleToDate, patterns } = r;
    const lineLabel = new Map(day.lines.map((l) => [l.key, scrubOr(l.label, l.key)]));
    return {
      date,
      is_today: date === today,
      cycle: {
        start: day.cycle.start,
        end: day.cycle.end,
        label: scrubOr(day.cycle.label, `${day.cycle.start} to ${day.cycle.end}`),
        day: day.cycle.dayIndex,
        days: day.cycle.days,
        days_left_including_date: day.daysLeft,
      },
      targets_are: TARGETS_ARE[day.targetsFrom],
      goal_table_set_up: goals.known,
      total: {
        allowance: money(day.total.allowance),
        spent: money(day.total.spentOn),
        left: money(day.total.left),
        over: day.total.left < 0,
      },
      lines: day.lines.map((l) => ({
        key: l.key,
        label: lineLabel.get(l.key) ?? l.key,
        allowance: money(l.allowance),
        spent: money(l.spentOn),
        left: money(l.left),
        over: l.left < 0,
      })),
      charges_found: r.charges.length,
      charges: r.charges.slice(0, REVIEW_CHARGES_MAX).map((c) => ({
        id: c.tx.id,
        date: c.tx.date,
        merchant: merchantOf(c.tx),
        line: c.line,
        amount: money(c.amount),
        still_processing: !!c.tx.pending,
        part_of_a_split: c.split,
      })),
      other_money_out_found: r.otherOut.length,
      other_money_out: r.otherOut.slice(0, REVIEW_CHARGES_MAX).map((o) => ({
        id: o.tx.id,
        date: o.tx.date,
        merchant: merchantOf(o.tx),
        category_id: scrubName(o.tx.categoryId, NAME_MAX) || "(no category id I can say)",
        amount: money(o.amount),
        still_processing: !!o.tx.pending,
        why: o.why,
      })),
      cycle_to_date: {
        through: cycleToDate.through,
        spent: money(cycleToDate.spent),
        target: money(cycleToDate.target),
        pace: sayPace(cycleToDate.pace),
        projected_cycle_total: money(cycleToDate.projected),
      },
      patterns: {
        from: patterns.from,
        to: patterns.to,
        days: PATTERN_DAYS,
        gas_and_convenience_stops: patterns.gasStops,
        dining_out_charges: patterns.diningCharges,
        days_over_allowance_this_cycle: patterns.daysOverThisCycle,
        days_counted_this_cycle: patterns.daysCountedThisCycle,
        streak_at_or_under_allowance: patterns.streak,
        // True when the streak hit the most days it walks back, so "at least" is the
        // honest word.
        streak_reached_limit: patterns.streakAtLimit,
        streak_limit_days: STREAK_MAX,
        line_most_over_pace: patterns.lineMostOver
          ? {
              key: patterns.lineMostOver.key,
              label: lineLabel.get(patterns.lineMostOver.key) ?? patterns.lineMostOver.key,
              spent: money(patterns.lineMostOver.spent),
              target: money(patterns.lineMostOver.target),
              an_even_pace_would_have_spent: money(patterns.lineMostOver.evenPaceSpent),
              over_pace_by: money(patterns.lineMostOver.overPaceBy),
              over_whole_target_by: money(patterns.lineMostOver.overWholeTargetBy),
            }
          : null,
      },
      // For a chart: each day's allowance at its start, and what it spent.
      series: r.series.map((s) => ({ date: s.date, allowance: money(s.allowance), spent: money(s.spent) })),
      note: REVIEW_NOTE,
    };
  },
};

export const DAILY_TOOLS: readonly Tool[] = [financeDailyAllowance, financeDayReview];
