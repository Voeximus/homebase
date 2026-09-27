// GENERATED — DO NOT EDIT. Source: src/lib/headline.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/headline.ts
// and re-run the generator.
// The two headline figures, extracted out of a view module so something other than
// a screen can read them.
//
// WHY THIS FILE EXISTS
//
// The Muse read door's Rule 3 is "no assembling a function's inputs": where the app
// computes a number inside a view module, the door must not compute it too, because
// then there are two spellings of it and the second one drifts. The repo has the
// receipts — cron-notify re-implemented the bill maths by hand and told the phones
// "Electric $85" while every screen in the app said $100.
//
// Two figures were caught by that rule and left out of the door on purpose:
//
//   FIREPOWER, the hero tile. planMath() returns a `firepower`, but the tile does
//   not show it: src/views/redesign/buildVMs.ts subtracted two more things from it
//   before drawing it, and those two subtractions lived in the view. So the number
//   the app shows had no shared function behind it, and a door that computed it
//   would have disagreed with his screen — which in a chat there is no screen
//   beside to notice.
//
//   THE BILLS STILL DUE BEFORE THE NEXT PAYCHECK. dueBeforeNextPayday() is shared,
//   but the window handed to it — which months it spans, which day it opens on —
//   was assembled in src/views/redesign/BillsSheet.tsx.
//
// Both are now one function each, called by the screen AND by the door. So "the
// door agrees with the screen" stops being a promise somebody keeps and becomes a
// property of there being one implementation.
//
// NO CLOCK IN HERE. `now` is always an argument. The door builds an Arizona `now`
// once per request (supabase/functions/_shared/muse/az.ts) and a UTC edge runtime
// is already tomorrow from 5 PM Arizona onward, which for somebody who works nights
// is most of his waking day.

import { isoDate, monthKeyOf } from "./format.ts";
import {
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  payCycleFor,
  planMath,
  spentByCategory,
  sumTargets,
  variableSpentThisMonth,
  type PayCycle,
  type PlanMath,
} from "./plan.ts";
import { dueBeforeNextPayday, type MonthCalBill, type MonthCalendar } from "./schedule.ts";
import type { AppData } from "./types.ts";

export interface Headline {
  /** What the hero tile shows: what is really available to throw at the debt this
   *  month. */
  firepower: number;
  /** The figure before the two subtractions — planMath's own. Reported so a reader
   *  can see where the difference went instead of taking the final number on
   *  faith. */
  plannedFirepower: number;
  /** Spending over the lean monthly envelope. Real cash that can no longer go at
   *  the debt, so it comes off live as he spends. */
  overspend: number;
  /** Cash that left but is graded against NO budget line (electronics, car, …). It
   *  never shows as overspend — there is no line to blow — but it is still money
   *  that cannot go at the debt. */
  outsideBudget: number;
  /** planMath's whole result, so a caller that needs income or fixed costs does not
   *  call it a second time and risk passing a different date. */
  plan: PlanMath;
  /** The monthly lean envelope, the input to both the overspend and the plan. */
  monthlyTarget: number;
  /** What was spent against the envelope this calendar month. */
  spentThisMonth: number;
}

/**
 * The hero tile's figure, and the two subtractions that make it.
 *
 * MONTHLY THROUGHOUT, and that is the decision worth reading twice. Firepower is a
 * monthly quantity — monthly income less monthly bills — so the overspend measured
 * against it has to be monthly too. Mixing the per-cycle overspend into it would
 * compare half a period against a whole one. The per-cycle figure is a different
 * question with its own answer (finance.budget_status).
 *
 * Under-spending does NOT inflate firepower: the budget stays reserved, and a
 * mid-month "under" is just the month not being over yet. Hence Math.max(0, …) on
 * the overspend and not a signed difference.
 */
export function headlineFirepower(data: AppData, now: Date): Headline {
  const monthKey = monthKeyOf(now);
  const monthlyTarget = sumTargets(LEAN_VARIABLE);
  // Transactions are passed so a VARIABLE bill is priced the way the calendar
  // prices it (known_amount, else the rolling average) rather than by its stale
  // stored amount — without them the plan and the calendar disagree.
  const plan = planMath(data.recurring, data.debts, monthlyTarget, isoDate(now), data.transactions);
  const spentThisMonth = variableSpentThisMonth(data.transactions, monthKey);
  const overspend = Math.max(0, spentThisMonth - monthlyTarget);
  const byCatMonth = spentByCategory(data.transactions, monthKey);
  const outsideBudget = OUTSIDE_BUDGET_CASH_CATS.reduce((s, c) => s + (byCatMonth[c] ?? 0), 0);
  return {
    firepower: Math.max(0, plan.firepower - overspend - outsideBudget),
    plannedFirepower: plan.firepower,
    overspend,
    outsideBudget,
    plan,
    monthlyTarget,
    spentThisMonth,
  };
}

export interface NextBills {
  cycle: PayCycle;
  /** The calendar date the window is measured from, in the same spelling the ledger
   *  stores. */
  todayISO: string;
  /** The month keys the window touched, so a caller can say how wide it looked. */
  months: string[];
  bills: (MonthCalBill & { overdue: boolean })[];
  total: number;
  overdueTotal: number;
}

/**
 * What is still owed out of the paycheck that has already landed.
 *
 * `getMonth` is injected rather than built here, because the two callers build a
 * month differently and neither is wrong: the screen already holds a memoised
 * builder, and the door builds one from the ledger it loaded. What must not differ
 * is the WINDOW — which months it spans and which day it opens on — and that is
 * what this function owns.
 *
 * IT OPENS AT THE CYCLE START, NOT AT TODAY. An unpaid bill whose due day has
 * already passed inside this cycle still comes out of the paycheck sitting in the
 * account, so opening at today understated "still due" by exactly the amount most
 * at risk of being forgotten. Each row carries `overdue` so a caller can say so
 * rather than presenting it as merely upcoming.
 */
export function nextBills(now: Date, getMonth: (year: number, month: number) => MonthCalendar): NextBills {
  const mc = getMonth(now.getFullYear(), now.getMonth());
  const cycle = payCycleFor(now);
  // Shared spelling, not a local copy — this window is compared against ledger
  // dates, so the two conversions have to be the same function.
  const todayISO = isoDate(now);
  // The window can cross a month boundary (a cycle opening on the 31st runs into
  // the next month), so hand over every month it touches. A caller that passed only
  // the current month would silently under-report exactly when the answer matters
  // most.
  const [endY, endM] = cycle.end.split("-").map(Number);
  const months = endY === mc.year && endM - 1 === mc.month ? [mc] : [mc, getMonth(endY, endM - 1)];
  const due = dueBeforeNextPayday(months, todayISO, cycle.end, cycle.start);
  return {
    cycle,
    todayISO,
    months: months.map((m) => m.monthKey),
    bills: due.bills,
    total: due.total,
    overdueTotal: due.overdueTotal,
  };
}
