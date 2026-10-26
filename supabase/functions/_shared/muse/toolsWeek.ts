// The weekly view: one read tool, finance.week — "what can we spend?", answered for the
// week, Sunday to Saturday, with a ready picture both assistants show as it is.
//
// WHY THIS EXISTS — 2026-10-25
//
// The daily allowance (toolsDaily.ts) was the headline answer to "what can we spend",
// and Gino called it "annoying, almost inaccurate": it swung hard after one big shop, it
// sat at $0 for days after a cycle that ran over, it never showed its sum, and a day was
// the wrong unit for weekly spending in a household where one person works nights. He
// approved a weekly view in its place — a plan per week, set per budget line — and this
// is the read half of it. finance.set_weekly_plan on the write door is the other half.
//
// EVERY FIGURE AND EVERY CHARACTER OF THE PICTURE IS WORKED OUT IN src/lib/weekPlan.ts —
// generated into ./lib, checked byte for byte by the build. This file reports fields; it
// adds, subtracts, divides and draws nothing. The picture matters most here: there are
// two Muses, one per phone, and two assistants each drawing their own bars from the same
// fields would round their own way and word their own sum — two pictures of one week
// that disagree, which is the doubt this view exists to end.
//
// ONE HOUSEHOLD. Both keys get the same week. Account names never appear; a merchant
// does, cleaned (it is on SAYS_DESCRIPTION), because "where did the week go" with no way
// to name the charge is a verdict nobody can act on.
//
// THE PICTURE IS THE ONE MULTI-LINE STRING EITHER DOOR SENDS, and that is declared rather
// than slipped in: see SAYS_PICTURE below. Every other string out of this door is one
// line, because a newline in a memo line is how words from a stranger start to read as a
// turn in the chat. The picture's newlines are the door's own — every line of it is built
// here from figures and the plan's own labels, each label through the scrubber — and the
// Rule 4 tests check it line by line rather than letting it off.
//
// RULE 2: no clock. "This week" is the week holding `now`'s Arizona date — the `now` the
// handler built once for the request — never the runtime's.

import {
  resolveWeek,
  weekPicture,
  weekView,
  whyOf,
  WEEK_PLAN_WEEKS_AHEAD,
  type PlanIs,
} from "./lib/weekPlan.ts";
import { isoDate } from "./lib/format.ts";
import type { Transaction } from "./lib/types.ts";
import { BadArgs, isRealDate, type Json, type Tool } from "./args.ts";
import { maskDigits } from "./toolsFinance.ts";
import { money, scrubOr } from "./scrub.ts";

/** How far back finance.week answers, in weeks. A year and a week: "how did this week go
 *  last year" is a fair question, and anything older is finance.search_transactions'. */
export const WEEKS_BACK_MAX = 53;

/**
 * The tools that may send a MULTI-LINE string, and the one field that carries it.
 *
 * WHICH TOOLS MAY SAY A NEWLINE IS DECLARED, NOT INFERRED — the same discipline as
 * SAYS_DESCRIPTION in toolsFinance.ts. The Rule 4 tests assert that no reply from any
 * tool carries a newline, and for a tool on this list they take the picture out, check
 * every one of its lines for a link, an instruction shape and a descriptor, and then hold
 * the rest of the reply to the same no-newline rule as everything else.
 */
export const SAYS_PICTURE: ReadonlySet<string> = new Set(["finance.week"]);
export const PICTURE_FIELD = "picture";

/** The words `week` takes instead of a date. */
const WORDS = ["this", "last", "next"] as const;

/** The week asked for — default this week — refused when it is not one this door
 *  answers about. Words or a real date; a date may be any day inside the wanted week,
 *  so nobody has to work out which day is its Sunday. */
function weekIn(args: Record<string, unknown>, today: string): string {
  const v = args.week;
  if (v === undefined) return "this";
  if ((WORDS as readonly unknown[]).includes(v)) return v as string;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadArgs(
      `week is "this", "last", "next", or any date inside the week you want, like 2026-10-20. Leave it out for this week.`,
    );
  }
  if (!isRealDate(v)) throw new BadArgs(`${v} is not a real date.`);
  const r = resolveWeek(v, today);
  if (!r) throw new BadArgs(`${v} is not a real date.`);
  if (r.offset > WEEK_PLAN_WEEKS_AHEAD) {
    throw new BadArgs(
      `The week holding ${v} is more than ${WEEK_PLAN_WEEKS_AHEAD} weeks ahead. Ask about this week, or a week up to ${WEEK_PLAN_WEEKS_AHEAD} after it.`,
    );
  }
  if (-r.offset > WEEKS_BACK_MAX) {
    throw new BadArgs(
      `The week holding ${v} is more than ${WEEKS_BACK_MAX} weeks back. Ask finance.search_transactions about charges that old.`,
    );
  }
  return v;
}

/** A charge's cleaned merchant name, with long digit runs masked — see maskDigits. */
const merchantOf = (t: Transaction): string => maskDigits(scrubOr(t.description, "(a name I cannot say safely)"));

/** The note, built from what is true of this reply — never "nobody set a plan" when the
 *  table to hold one is missing. */
function weekNote(planIs: PlanIs, known: boolean): string {
  const parts = [
    "ONE HOUSEHOLD PLAN for both of you, Sunday to Saturday. Show picture to us inside a code block exactly as it is — every bar and figure in it is worked out already — then say its Why line, which is also in why as one sentence, in your own words. Never add, subtract, divide or recompute anything yourself, and never redraw or reformat the picture.",
  ];
  if (!known) {
    parts.push(
      "plan_is says the plan comes from the pay-cycle budget — that cycle's budget per day times seven — because the table that holds a weekly plan has not been set up yet, so no weekly plan can be set or shown until it is.",
    );
  } else if (planIs === "weekly plan") {
    parts.push(
      "plan_is says this is the weekly plan: the latest plan set on or before this week's Sunday (plan_set_for_week_of), which stands for every week after it until another is set.",
    );
  } else {
    parts.push(
      "plan_is says no weekly plan is set yet, so the plan is the pay-cycle budget per day times seven. finance.set_weekly_plan on the write door sets one. Say which it is.",
    );
  }
  parts.push(
    "Spending per line is the budget's own: charges still processing count, money moved between your own accounts does not, and a charge tied to a bill, a debt or a planned item is not in it. money_back lists the refunds dated in the week. Each one's counted part comes off the week's total, never off a line, so spent_total is spent_on_lines less money_back_total, and it is never below zero. Money back counts only when it traces to something bought on the budget lines, and never more than the lines spent that week; not_counted_because says why the rest is left out, and the Why line says how much. Never count it back in yourself. A negative left_total, or an over_by, means over the plan by that much — say over by, never minus. per_day_left is what is left spread over days_left, today included, and is null once the week is over.",
    "This weekly view is the answer to what can we spend. finance.daily_allowance and finance.day_review still answer, but they are no longer the headline.",
  );
  return parts.join(" ");
}

const financeWeek: Tool = {
  name: "finance.week",
  summary:
    "The week, Sunday to Saturday — the answer to what can we spend: the weekly plan against what the household spent, per line and in total, with money back, what is left per day, the biggest charges, and a ready picture to show exactly as it is.",
  args: [
    {
      name: "week",
      type: "string",
      required: false,
      description: `"this" (the default), "last", "next", or any YYYY-MM-DD inside the week you want. Up to ${WEEKS_BACK_MAX} weeks back or ${WEEK_PLAN_WEEKS_AHEAD} ahead.`,
    },
  ],
  async run({ load, now, args }) {
    const today = isoDate(now);
    const which = weekIn(args, today);
    const [data, goals, plans] = await Promise.all([load.appData(), load.cycleBudgets(), load.weekPlans()]);
    // The cycle goals ride along for the fallback only: a week with no weekly plan is
    // planned at the pay cycle's own rate, the goal's where one is set.
    const v = weekView({ ...data, cycleBudgets: goals.rows }, plans.rows, today, which);
    // Every label drawn into the picture goes through the scrubber first (Rule 4).
    const picture = weekPicture(v, (label, key) => scrubOr(label, key));
    return {
      week: {
        start: v.week.start,
        end: v.week.end,
        label: scrubOr(v.week.label, `${v.week.start} to ${v.week.end}`),
      },
      is_this_week: v.when === "this",
      plan_is: v.planIs,
      plan_set_for_week_of: v.planSetFor,
      // False only where schema_v46_week_plans.sql has not been run: then nothing can have
      // set a plan, and the note says so instead of "no weekly plan is set".
      plan_table_set_up: plans.known,
      plan_total: money(v.planTotal),
      spent_on_lines: money(v.spentOnLines),
      // The money back that counts — it traces to the lines, and never past what they spent
      // (moneyBackOf in src/lib/weekPlan.ts, 2026-10-25) — and what is listed and not.
      money_back_total: money(v.moneyBackTotal),
      money_back_not_counted: money(v.moneyBackNotCounted),
      spent_total: money(v.spentTotal),
      left_total: money(v.leftTotal),
      over_by: v.overBy === null ? null : money(v.overBy),
      days_left: v.daysLeft,
      per_day_left: v.perDayLeft === null ? null : money(v.perDayLeft),
      lines: v.lines.map((l) => ({
        key: l.key,
        label: scrubOr(l.label, l.key),
        plan: money(l.plan),
        spent: money(l.spent),
        left: money(l.left),
        over_by: l.overBy === null ? null : money(l.overBy),
        plan_is: l.from,
      })),
      money_back: v.moneyBack.map((m) => ({
        id: m.tx.id,
        date: m.tx.date,
        amount: money(m.amount),
        counted: money(m.counted),
        line: m.line,
        // The library's own sentence (NOT_TRACED / BEYOND_SPENT), never data — scrubbed anyway.
        not_counted_because: m.notCounted === null ? null : scrubOr(m.notCounted, "not counted"),
        merchant: merchantOf(m.tx),
        still_processing: !!m.tx.pending,
      })),
      biggest: v.biggest.map((c) => ({
        id: c.tx.id,
        date: c.tx.date,
        amount: money(c.amount),
        line: c.line,
        merchant: merchantOf(c.tx),
        still_processing: !!c.tx.pending,
        part_of_a_split: c.split,
      })),
      [PICTURE_FIELD]: picture,
      why: whyOf(picture),
      note: weekNote(v.planIs, plans.known),
    } satisfies { [k: string]: Json };
  },
};

export const WEEK_TOOLS: readonly Tool[] = [financeWeek];
