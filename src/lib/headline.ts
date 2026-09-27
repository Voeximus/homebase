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
// beyond the subtractions a screen already does — `target - spent` on a line, and
// the two the firepower tile applies on top of planMath — which are the questions
// themselves. Every one of them is named below with the screen it came off.
//
// FOUR ASSEMBLIES LIVE HERE, and each one was a sequence inside a view:
//   · envelopeStatus        — the budget envelope        (buildVMs.ts)
//   · firepowerStatus       — "available this month"     (buildVMs.ts)
//   · billsBeforeNextPayday — "still due before payday"  (BillsSheet.tsx)
//   · forecastPlan/runForecast — the forward projection  (the retired ForecastTab)
//
// NO CLOCK. `now` is always handed in. The edge runtime is UTC, and from 5 PM
// Arizona onward a fired default answers about tomorrow: a different pay cycle, a
// different set of charges. See supabase/functions/_shared/muse/az.ts.

import type { AppData, Debt, Transaction } from "../types";
import {
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  lineSpent,
  payCycleFor,
  perCycle,
  planMath,
  recentCycleSpend,
  spentByCategory,
  spentByCategoryBetween,
  sumTargets,
  typicalCycleSpend,
  variableSpentBetween,
  variableSpentThisMonth,
  type BudgetLine,
  type CycleSpend,
  type PayCycle,
  type PlanMath,
} from "./plan";
import { isoDate, monthKeyOf } from "./format";
import { totalBalance } from "./recurring";
import {
  dueBeforeNextPayday,
  monthCalendar,
  type MonthCalBill,
  type MonthCalendar,
} from "./schedule";
import { forecast, type ForecastMonth, type ForecastOpts } from "./forecast";

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

// ── firepower: "available THIS month" ─────────────────────────────────────────
//
// THE FIGURE THE HERO TILE SHOWS IS NOT planMath's. planMath answers a question
// about the PLAN — monthly income, less monthly bills that are not debt payments,
// less the budgeted variable envelope. The tile answers a question about THIS
// month, and the screen applies two subtractions on top that planMath cannot see:
//
//   · OVERSPEND against the lean budget. Money already spent past the envelope is
//     real cash that can no longer go at the debt. Measured on the MONTHLY horizon
//     deliberately, because firepower is a monthly figure — mixing a per-cycle
//     overspend into it would charge half a period against a whole one.
//     Under-spending never inflates it: the budget stays reserved, and a mid-period
//     "under" is only the period not being over yet.
//   · OUTSIDE-BUDGET CASH. Categories no budget line grades but that still left the
//     account — electronics, the car's one-time costs, utilities, a catch-up bill
//     payment, a booked trip, a tuition fee (plan.ts OUTSIDE_BUDGET_CASH_CATS).
//     There is no line to blow, so it never reads as overspend, and it is still
//     money that cannot go at the debt.
//
// Those two lines are why `finance.firepower` could not exist on the read door: a
// door that called planMath and stopped would have been honestly computed, off by
// both subtractions, and disagreeing with the one number on his home screen.
//
// The clamp at zero is the screen's too. A negative "available to attack the debt"
// is not a debt payment of minus three hundred dollars; it is nothing available,
// and the overspend figure beside it is where that story gets told.

export interface FirepowerStatus {
  /** The month `now` falls in, "YYYY-MM" — the horizon every figure below uses. */
  monthKey: string;
  /** The app's monthly plan maths, untouched, so a caller can show the parts. */
  math: PlanMath;
  /** The cycle figures for the same instant, so one call answers both questions. */
  envelope: EnvelopeStatus;
  /** The whole envelope's MONTHLY target — what the two subtractions are graded on. */
  monthlyTarget: number;
  /** Graded variable spend for the whole month so far. */
  spentThisMonth: number;
  /** Month-to-date spend past the monthly envelope, or zero. */
  overspendThisMonth: number;
  /** Cycle-to-date spend past this cycle's allowance, or zero — the budget bar's
   *  "over by" figure. A DIFFERENT number from the one above, on purpose: one
   *  grades a month, the other grades a pay cycle. */
  overspendThisCycle: number;
  /** Cash out this month in categories no budget line grades. */
  outsideBudgetCash: number;
  /** What the hero tile shows: planMath's firepower less both subtractions,
   *  floored at zero. */
  firepower: number;
}

/**
 * "Available this month", exactly as the home screen's hero tile shows it.
 *
 * `now` is required. planMath's own date argument is passed explicitly rather than
 * left to default: its default is the machine's local calendar date, which in an
 * edge function is UTC and therefore tomorrow from 5 PM Arizona onward — and that
 * date decides which recurring rows count as live (startsOn / endsOn), so a fired
 * default can add or drop a whole bill.
 */
export function firepowerStatus(
  data: AppData,
  now: Date,
  lines: BudgetLine[] = LEAN_VARIABLE,
): FirepowerStatus {
  const envelope = envelopeStatus(data.transactions, now, lines);
  const monthlyTarget = envelope.monthlyTarget;
  const monthKey = monthKeyOf(now);
  // Transactions are passed so a VARIABLE bill is priced the way the calendar
  // prices it (known_amount, else the rolling average of real payments) rather than
  // by its stale stored amount — without them the plan and the calendar disagree,
  // the plan reads LOW, and firepower therefore reads HIGH.
  const math = planMath(data.recurring, data.debts, monthlyTarget, isoDate(now), data.transactions);
  const spentThisMonth = variableSpentThisMonth(data.transactions, monthKey);
  const overspendThisMonth = Math.max(0, spentThisMonth - monthlyTarget);
  const overspendThisCycle = Math.max(0, envelope.spent - envelope.target);
  const byCatMonth = spentByCategory(data.transactions, monthKey);
  const outsideBudgetCash = OUTSIDE_BUDGET_CASH_CATS.reduce((s, c) => s + (byCatMonth[c] ?? 0), 0);
  const firepower = Math.max(0, math.firepower - overspendThisMonth - outsideBudgetCash);
  return {
    monthKey,
    math,
    envelope,
    monthlyTarget,
    spentThisMonth,
    overspendThisMonth,
    overspendThisCycle,
    outsideBudgetCash,
    firepower,
  };
}

// ── bills still due before the next payday ────────────────────────────────────
//
// Bills stay CALENDAR-MONTHLY on purpose — rent really is due on the 1st, and that
// decision is why the bill list did not move to pay cycles when the budget did. The
// question a pay cycle raises is a different one: of the paycheck already in the
// account, how much is still spoken for before the next one arrives.
//
// dueBeforeNextPayday answers it, and answering it takes FOUR arguments a screen
// worked out: which months the window touches, today, the cycle's end and the
// cycle's start. Three of the four are easy to get wrong in ways that fail quietly:
//
//   · the window opens at the CYCLE START, not at today. A bill due on the 16th and
//     still unpaid on the 18th is money that must come out of the check already
//     banked; opening at today dropped exactly the rows most at risk of being
//     forgotten.
//   · the window can CROSS A MONTH BOUNDARY — a cycle opening on the 31st runs into
//     the next month — and a caller that hands over only the current month
//     under-reports precisely when the answer matters most.
//   · every date compared is a LOCAL calendar date. isoDate is the one spelling of
//     that conversion; `toISOString().slice(0,10)` is the silently-UTC lookalike
//     that caused the evening-entry bug.
//
// That is the assembly, and it is why `finance.next_bills` was absent.

export interface BillsBeforePayday {
  /** The calendar for the month `now` is in — the same object a screen renders its
   *  paid/unpaid lists and its month label from, so the list and the total can never
   *  come from two different builds of it. */
  month: MonthCalendar;
  /** The pay cycle `now` falls inside. */
  cycle: PayCycle;
  /** Whole days left in the cycle, floored at zero. Zero means today is the last. */
  daysLeft: number;
  /** The unpaid bills inside the window, each flagged `overdue` when its due date
   *  has already passed, and carrying `due`, the resolved calendar date. */
  bills: (MonthCalBill & { overdue: boolean; due: string })[];
  /** What they add up to. */
  total: number;
  /** The overdue part of that total, named separately because it is a different kind
   *  of fact: not "coming up" but "already past its date and still unpaid". */
  overdueTotal: number;
}

/**
 * A month-calendar builder bound to one AppData and one `now`.
 *
 * It exists so a caller with no screen (the read door) can hand
 * billsBeforeNextPayday the same `getMonth` a screen hands it, rather than a second
 * spelling of the monthCalendar call. `now` is what decides "today" inside the
 * calendar, so it is bound here once instead of being read per month.
 */
export function monthGetter(
  data: AppData,
  now: Date,
): (year: number, month: number) => MonthCalendar {
  return (year, month) =>
    monthCalendar(data.recurring, data.transactions, now, year, month, data.debts);
}

/** "Still due before payday", exactly as the Bills sheet shows it. */
export function billsBeforeNextPayday(
  getMonth: (year: number, month: number) => MonthCalendar,
  now: Date,
): BillsBeforePayday {
  const month = getMonth(now.getFullYear(), now.getMonth());
  const cycle = payCycleFor(now);
  const daysLeft = Math.max(0, cycle.days - cycle.dayIndex);
  const todayISO = isoDate(now);
  // The window can cross a month boundary, so hand over every month it touches.
  const [endY, endM] = cycle.end.split("-").map(Number);
  const months =
    endY === month.year && endM - 1 === month.month ? [month] : [month, getMonth(endY, endM - 1)];
  // cycle.start, not today — see the note above.
  const found = dueBeforeNextPayday(months, todayISO, cycle.end, cycle.start);
  return { month, cycle, daysLeft, ...found };
}

// ── the forward projection ────────────────────────────────────────────────────
//
// forecast() takes an options object the SCREEN built, and the screen is gone: it
// was deleted in "Repaint the whole app from one Renaissance palette". So this is
// the assembly recovered from that commit's ForecastTab.tsx, function for function,
// and it is why `finance.forecast` was absent — the maths existed with nothing on
// screen to check a spoken number against.
//
// Two of the four options were DIALS the user could drag. A door has no dial, so it
// gets the position each one opened at, which is what the screen showed before
// anybody touched it:
//
//   · cycleSpend opened at the household's own MEDIAN cycle spend, not a round
//     number somebody picked. It used to open at a hardcoded 700 — below this
//     household's real median — so the very first surplus the screen ever showed was
//     optimistic and nothing said why. A median rather than a mean, because one
//     heavy cycle (a car down payment, a trip) drags an average somewhere the
//     household never actually lives. The 700 survives only as the no-history
//     fallback, where there is no median to read.
//   · cardPay opened at the card bill's own contracted amount, rounded to the
//     dollar. Where the screen then fell back to a hardcoded 134, this leaves the
//     option OFF instead: with no card row there is no card line for the override to
//     apply to, so 134 was never reachable as a number — and a figure spoken in a
//     chat must not be an invented one even in dead code.
//
// The other two are measured rather than chosen: the card being modelled is the
// biggest interest-bearing balance with a bill attached (picked from the data, so it
// follows a payoff instead of being hardcoded), and the opening cash is the bank's
// own available total.

export interface ForecastPlan {
  /** "YYYY-MM" for the month `now` is in — the projection's first row, and a PARTIAL
   *  month counted from today forward. */
  startMonth: string;
  /** The options, assembled: what the screen's two dials and two measurements were. */
  opts: ForecastOpts;
  /** The card being modelled, if there is one. */
  cardDebt?: Debt;
  /** The last complete pay cycles' actual spend, so a caller can show the dial's
   *  reference points instead of presenting an assumption as a measurement. */
  cycles: CycleSpend[];
  /** The median of those — what `opts.cycleSpend` was set from. Zero when there is
   *  no history, in which case the fallback below was used instead. */
  typicalCycle: number;
}

/** The spending figure the forecast opens at when the ledger holds no complete cycle
 *  to take a median from. The retired screen's own fallback. */
export const FALLBACK_CYCLE_SPEND = 700;

/** How many months that screen ran, and therefore the default a caller with no
 *  opinion of its own gets. */
export const FORECAST_MONTHS = 12;

/** Everything forecast() needs, assembled from the data — the retired screen's own
 *  derivation, with `now` handed in rather than read. */
export function forecastPlan(data: AppData, now: Date): ForecastPlan {
  const cardDebt = data.debts
    .filter((d) => d.balance > 0 && (d.apr ?? 0) > 0)
    .sort((a, b) => b.balance - a.balance)[0];
  const cardRow = data.recurring.find((r) => r.active && r.linkedDebtId === cardDebt?.id);
  const cycles = recentCycleSpend(data.transactions, now);
  const typicalCycle = typicalCycleSpend(cycles);
  return {
    startMonth: monthKeyOf(now),
    ...(cardDebt ? { cardDebt } : {}),
    cycles,
    typicalCycle,
    opts: {
      cycleSpend: typicalCycle > 0 ? Math.round(typicalCycle) : FALLBACK_CYCLE_SPEND,
      ...(cardRow ? { cardPay: Math.round(cardRow.amount) } : {}),
      ...(cardDebt ? { cardDebtId: cardDebt.id } : {}),
      openingCash: totalBalance(data.accounts),
    },
  };
}

/** A single moment in the projection: the month it falls in, the day of that month,
 *  and the balance at that moment. */
export interface LowPoint {
  monthKey: string;
  label: string;
  day: number;
  balance: number;
}

/**
 * The single worst moment across a whole run — the screen's own reduction.
 *
 * It is here rather than in a caller because it is the one figure of the projection
 * a person actually asks for ("what's the lowest it gets?"), and it is a reduction
 * over the months rather than a number any function returns. A caller that picked
 * the minimum itself would be deciding what "worst" means, and two callers would
 * eventually decide differently: least cash, or furthest below the floor, or the
 * earliest of the tied ones.
 *
 * Ties go to the EARLIEST month, because a caller reading the answer out wants the
 * one that arrives first. Null when no month carried a running balance, which is
 * what happens when no opening cash was supplied — a projection with no balance in
 * it has no low point, and that is different from a low point of zero.
 */
export function lowestPoint(months: readonly ForecastMonth[]): LowPoint | null {
  let worst: ForecastMonth | null = null;
  for (const m of months) {
    if (!m.low) continue;
    if (!worst || m.low.balance < worst.low!.balance) worst = m;
  }
  if (!worst) return null;
  return {
    monthKey: worst.monthKey,
    label: worst.label,
    day: worst.low!.day,
    balance: worst.low!.balance,
  };
}

/** The projection itself: `count` months from the month `now` is in. */
export function runForecast(
  data: AppData,
  now: Date,
  count: number,
): { plan: ForecastPlan; months: ForecastMonth[] } {
  const plan = forecastPlan(data, now);
  const months = forecast(
    data.recurring,
    data.transactions,
    data.debts,
    plan.startMonth,
    count,
    plan.opts,
    now,
  );
  return { plan, months };
}
