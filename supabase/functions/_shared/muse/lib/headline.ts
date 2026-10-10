// GENERATED — DO NOT EDIT. Source: src/lib/headline.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/headline.ts
// and re-run the generator.
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
// AND TWO THAT NO SCREEN EVER HAD, added 2026-10-10 for the Muse read door, which is
// becoming the only interface. They live here for the same reason the four do — the
// door may not assemble its own inputs — and no screen calls them yet:
//   · billEvidence — "is an unpaid bill really unpaid?", the one test finance.next_bills
//                    and finance.bill_calendar both use
//   · billsAhead   — each paying account against its own bills over a fixed look-ahead
//                    that runs past the pay cycle, so a shortfall shows up in time
//
// NO CLOCK. `now` is always handed in. The edge runtime is UTC, and from 5 PM
// Arizona onward a fired default answers about tomorrow: a different pay cycle, a
// different set of charges. See supabase/functions/_shared/muse/az.ts.

import type { AppData, Debt, Transaction } from "./types.ts";
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
} from "./plan.ts";
import { addDaysISO, isoDate, monthKeyOf } from "./format.ts";
import { isCreditAccount, totalBalance } from "./recurring.ts";
import {
  dueBeforeNextPayday,
  dueOn,
  monthCalendar,
  monthlySchedule,
  type MonthCalBill,
  type MonthCalendar,
} from "./schedule.ts";
import { forecast, type ForecastMonth, type ForecastOpts } from "./forecast.ts";
import { coverFor, type Cover, type PendingLike } from "./pendingCover.ts";
import { reviewLedger } from "./ledgerReview.ts";

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

// ── is an unpaid bill really unpaid? ──────────────────────────────────────────
//
// "Unpaid" on the calendar means one narrow thing: no charge is LINKED to that bill
// for that month. It does not mean the money is still in the account, and there are
// two common ways for it to have left already:
//
//   · THE PAYMENT IS STILL CLEARING. Rent paid on the 1st is a real `transactions`
//     row carrying `pending: true`, and the app's money maths leaves pending rows out
//     on purpose (a payment in flight can reverse). On 2026-10-02 finance.next_bills
//     reported rent "overdue" hours after it was paid, which is how somebody pays rent
//     twice. coverFor() (pendingCover.ts) answers it.
//   · THE PAYMENT HAS POSTED AND NOBODY LINKED IT. The pending cover vanishes the
//     moment the bank posts, and rent posts two days after it is paid and stays
//     unlinked until somebody links it. W7 in ledgerReview.ts already answers that
//     case, and it is gated hard: the account arm's first version produced five
//     suggestions, all five false, which is why it now demands 1% on the amount and
//     3 days from the due day and DROPS a charge that fits two bills rather than
//     picking. A third spelling of bill-to-charge matching would drift from both of
//     the two that exist.
//
// MOVED HERE 2026-10-10 from the read door's finance.next_bills, word for word in
// what it does. finance.bill_calendar was answering the same question without either
// half — it said `paid: false` about a rent payment next_bills called paid and
// clearing — and two tools giving two answers about one bill is the drift this file
// exists to stop. Now both call this.
//
// NOTHING HERE MARKS A BILL PAID OR MOVES A FIGURE. It only names the evidence, so a
// reply can say "paid, still clearing" beside the unchanged number.

/** A posted charge that looks like a bill's own payment and that nothing tied to it. */
export interface UnlinkedPayment {
  id: string;
  date: string;
  amount: number;
}

/** What the ledger shows about one unpaid bill. Both null is the plain case. */
export interface BillEvidence {
  /** A payment in flight that fits this bill: same account, about the same amount,
   *  near the due date. */
  payingNow: Cover | null;
  /** Money that has already gone out on this bill's own account, for this amount, in
   *  this bill's cycle, that nothing has tied to the bill. Stronger evidence than a
   *  pending charge and still not proof — W7's own "CAN BE WRONG": a genuine second
   *  purchase at the same merchant for the same amount. */
  maybeAlreadyPaid: UnlinkedPayment | null;
}

/** The slice of a bill the test needs: which row, what it costs, and the date it is due. */
export interface BillOnADate {
  recurringId?: string;
  name: string;
  amount: number;
  /** "YYYY-MM-DD" — the resolved due date, never a bare day number. */
  due: string;
}

/**
 * The "is it really unpaid?" test, bound to one ledger and one `now`.
 *
 * Built once per request and handed to every caller, because W7 walks the whole
 * ledger and a second walk is a second chance for the two to disagree.
 */
export function billEvidence(data: AppData, now: Date): (bill: BillOnADate) => BillEvidence {
  const unlinkedHits = new Map<string, UnlinkedPayment>();
  for (const sug of reviewLedger(data, now, new Set<string>())) {
    if (sug.rule !== "W7") continue;
    const rid = sug.evidence.recurringId;
    const mk = sug.evidence.monthKey;
    const txId = sug.evidence.txnIds[0];
    const tx = txId ? data.transactions.find((t) => t.id === txId) : undefined;
    if (rid && mk && tx) unlinkedHits.set(`${rid}|${mk}`, { id: tx.id, date: tx.date, amount: tx.amount });
  }
  // Signed the way pendingCover expects, which is the way a bank reports it: negative
  // is money going out. Transaction.amount is always positive and carries its direction
  // in `type`, so the sign is put back here rather than inside the matcher, where it
  // would be one more thing to get wrong.
  const pendingNow: PendingLike[] = data.transactions
    .filter((t) => t.pending)
    .map((t) => ({
      date: t.date,
      amount: t.type === "expense" ? -t.amount : t.amount,
      description: t.description,
      accountId: t.accountId ?? null,
    }));
  return (b) => {
    const rec = b.recurringId ? data.recurring.find((r) => r.id === b.recurringId) : undefined;
    return {
      payingNow: coverFor(
        { name: b.name, amount: b.amount, due: b.due, accountId: rec?.accountId ?? null },
        pendingNow,
      ),
      maybeAlreadyPaid: b.recurringId ? (unlinkedHits.get(`${b.recurringId}|${b.due.slice(0, 7)}`) ?? null) : null,
    };
  };
}

// ── each paying account against its own bills, looking ahead ──────────────────
//
// FOUND 2026-10-10. The joint account held a few dollars, and rent — paid FROM that
// account, and far bigger than what was in it — was due on Nov 1. The money existed in
// the household; it was in the wrong account, and nothing could say so in time:
//
//   · finance.next_bills had a per-account view, but it stopped at the end of the pay
//     cycle (Oct 14), so rent on the 1st did not appear in it until about Oct 30 —
//     the evening before it drew, when there is nothing left to do but overdraw.
//   · it handed over `balance` and `still_to_come` and left the subtraction to the
//     assistant, which its own instructions forbid.
//   · finance.forecast starts from every account added together, so its low point
//     can look fine while one account goes negative.
//
// So this answers the per-account question over a FIXED look-ahead that ignores the
// pay cycle: from the start of the current cycle (so a bill already past its date and
// still unpaid is in, exactly as next_bills keeps it) through AHEAD_DAYS from today —
// and always through the next rent, wherever that falls, because rent is the bill that
// has emptied this account before. The shortfall is worked out HERE, so nothing
// downstream ever subtracts.
//
// INCOMING MONEY IS NOT ASSUMED TO LAND ANYWHERE. A paycheck row may name the account
// it lands in (recurring.account_id — the same column accountFlow() reads as inflow
// for a direction-'in' row). Only then is its PLANNED amount counted for that account,
// and only on dates after today, because pay that has already landed is in the balance.
// Pay whose row names no account is totalled separately and counted for nobody: a
// figure that silently assumed the paycheck lands in the joint account would turn
// "short" into "fine" on a guess. On 2026-10-10 no paycheck row names an account.
//
// Planned transfers between their own accounts are not counted either, for the same
// reason: no row says which account they come out of and land in.
//
// A BILL ALREADY ON ITS WAY OUT IS NOT COUNTED TWICE. `balance` is the bank's
// AVAILABLE figure, and the bank has already taken a pending payment out of it — the
// exact double count that once overstated the joint account's gap by a whole bill
// (tests/nextBillsClearing.test.ts). A posted charge is out of the balance too. So a
// bill whose payment is clearing, or has posted unlinked (billEvidence above), is
// listed and flagged and left out of `stillToCome`.

/** How far ahead of today the per-account look-ahead runs, in days. Three weeks:
 *  longer than any pay cycle (16 days at most), so a bill just past the next payday
 *  is in view before that payday's money is already spoken for. */
export const AHEAD_DAYS = 21;

/** The category the app files rent under (seed.ts), which is how "the next rent" is
 *  found without naming any row. */
export const RENT_CATEGORY = "housing";

export interface AheadBill extends BillOnADate {
  overdue: boolean;
  /** The amount is a rolling average of real payments, not a contracted figure. */
  variable: boolean;
  evidence: BillEvidence;
  /** True when the evidence says the money has already left — so it is in `alreadyOut`,
   *  not `stillToCome`. */
  alreadyOut: boolean;
}

export interface AccountAhead {
  /** The paying account's id, or null for bills nobody has placed on an account. */
  accountId: string | null;
  /** The account's AVAILABLE balance now. Null for the unplaced bucket and for a card,
   *  whose balance is what is owed rather than what is held. */
  balance: number | null;
  isCard: boolean;
  bills: AheadBill[];
  /** Every unpaid bill in the window, at its full amount. */
  due: number;
  /** The part of `due` whose payment is clearing or has posted unlinked. */
  alreadyOut: number;
  /** `due` less `alreadyOut` — what this account still has to find. */
  stillToCome: number;
  /** Planned pay counted for this account: only rows that name it, only after today. */
  payCounted: number;
  /** How far below zero the account goes at its worst moment in the window, walking
   *  the bills and the counted pay in date order. 0 when it never goes below zero.
   *  Null where it cannot be said (no account, or a card). */
  shortBy: number | null;
  /** The day of that worst moment, or null when it never goes below zero. */
  shortOn: string | null;
}

export interface BillsAhead {
  /** First day of the window: the start of the current pay cycle. */
  from: string;
  /** Last day of the window, inclusive. */
  through: string;
  today: string;
  days: number;
  /** Why the window ends where it does. */
  throughIs: "days" | "rent";
  /** The next rent due on or after today, paid or not, or null when there is none. */
  rentOn: string | null;
  /** Planned pay inside the window (after today) whose row names no account. */
  payNotPlaced: number;
  payNotPlacedCount: number;
  accounts: AccountAhead[];
}

/**
 * Each paying account against its own bills, from the start of this pay cycle through
 * `days` from today — or the next rent, if that is later.
 *
 * `evidenceFor` is billEvidence(data, now), passed in rather than rebuilt so a caller
 * that already holds it (finance.next_bills) does not walk the ledger twice.
 */
export function billsAhead(
  data: AppData,
  now: Date,
  evidenceFor: (bill: BillOnADate) => BillEvidence,
  days: number = AHEAD_DAYS,
): BillsAhead {
  const getMonth = monthGetter(data, now);
  const today = isoDate(now);
  const cycle = payCycleFor(now);
  const from = cycle.start;
  // A calendar date `days` on from today — counted from `now`, never from a clock.
  const plus = addDaysISO(today, days);

  // Every month the window can touch: the one the cycle opened in (a cycle opening on
  // the 31st starts in the month before) through two months past this one, which holds
  // `days` ahead and the next rent with room to spare.
  const [fy, fm] = from.split("-").map(Number);
  const months: MonthCalendar[] = [];
  const lastMonth = now.getFullYear() * 12 + now.getMonth() + 2;
  for (let i = fy * 12 + (fm - 1); i <= lastMonth; i++) months.push(getMonth(Math.floor(i / 12), i % 12));

  // THE NEXT RENT: the BIGGEST bill filed under housing, at its next date on or after
  // today, paid or not. Paid still counts as "the next rent" — it simply contributes
  // nothing below, which is the true answer when it has been paid early.
  //
  // FOUND 2026-10-10, IN REVIEW: this first took the EARLIEST housing bill due on or
  // after today. Housing is a category, not a row, so any smaller row filed there — a
  // renters-insurance premium, a parking or HOA fee — that came due before the rent
  // became "the next rent". The window then stayed at AHEAD_DAYS and the real rent
  // fell outside it: with a few dollars in the joint account, rent on the 1st and a
  // small housing fee on the 20th, the joint account read short by the fee alone, and
  // rent — the one bill this window exists to keep in view — was not in it at all.
  //
  // Why the biggest, and not simply the LATEST housing date (which would also keep
  // every housing row in view): a housing row that comes round less often than monthly
  // — a quarterly fee — can have its next date two months out, and stretching to it
  // would lay two months of bills against today's balance with no unplaced pay counted
  // against them, inflating every short_by. The rent is the biggest housing bill; that
  // is what makes it the one bill worth stretching the window for. Rows are told apart
  // by their recurring id (by name for an entry with none), sized by the biggest amount
  // any of their entries carries in the months scanned, and a tie goes to the later
  // date, so both stay in view.
  const housing = new Map<string, { size: number; next: string | null }>();
  for (const m of months) {
    for (const b of m.bills) {
      if (b.catId !== RENT_CATEGORY) continue;
      const key = b.recurringId ?? `name:${b.name}`;
      const row = housing.get(key) ?? { size: 0, next: null };
      row.size = Math.max(row.size, b.amount);
      const on = dueOn(m, b);
      if (on >= today && (row.next === null || on < row.next)) row.next = on;
      housing.set(key, row);
    }
  }
  let rentOn: string | null = null;
  let rentSize = -1;
  for (const row of housing.values()) {
    if (row.next === null) continue;
    if (row.size > rentSize || (row.size === rentSize && rentOn !== null && row.next > rentOn)) {
      rentSize = row.size;
      rentOn = row.next;
    }
  }
  const through = rentOn && rentOn > plus ? rentOn : plus;

  const found = dueBeforeNextPayday(months, today, through, from);
  const accountOf = (rid?: string): string | null =>
    (rid ? data.recurring.find((r) => r.id === rid)?.accountId : undefined) ?? null;

  type Bucket = { bills: AheadBill[]; pay: { on: string; amount: number }[] };
  const buckets = new Map<string | null, Bucket>();
  const bucket = (id: string | null): Bucket => {
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { bills: [], pay: [] }));
    return b;
  };
  // Every account some live bill is paid from gets a row even with nothing due in the
  // window, so "nothing due here" is said rather than left to be inferred from absence.
  for (const r of data.recurring) {
    if (r.active && r.direction === "out" && r.accountId) bucket(r.accountId);
  }

  for (const b of found.bills) {
    const evidence = evidenceFor({ recurringId: b.recurringId, name: b.name, amount: b.amount, due: b.due });
    bucket(accountOf(b.recurringId)).bills.push({
      recurringId: b.recurringId,
      name: b.name,
      amount: b.amount,
      due: b.due,
      overdue: b.overdue,
      variable: b.variable,
      evidence,
      alreadyOut: !!(evidence.payingNow || evidence.maybeAlreadyPaid),
    });
  }

  // Planned pay, from the same schedule the calendar and the forecast use.
  let payNotPlaced = 0;
  let payNotPlacedCount = 0;
  for (const m of months) {
    for (const e of monthlySchedule(data.recurring, m.monthKey, data.transactions, data.debts).entries) {
      if (e.direction !== "in") continue;
      const on = dueOn(m, { day: Math.min(Math.max(e.day, 1), m.daysInMonth) });
      if (on <= today || on > through) continue;
      const acct = accountOf(e.recurringId);
      if (acct) bucket(acct).pay.push({ on, amount: e.amount });
      else {
        payNotPlaced += e.amount;
        payNotPlacedCount += 1;
      }
    }
  }

  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  const accounts: AccountAhead[] = [...buckets.entries()].map(([id, bk]) => {
    const acct = id ? byId.get(id) : undefined;
    const isCard = !!acct && isCreditAccount(acct);
    const due = bk.bills.reduce((s, b) => s + b.amount, 0);
    const alreadyOut = bk.bills.reduce((s, b) => (b.alreadyOut ? s + b.amount : s), 0);
    const payCounted = bk.pay.reduce((s, p) => s + p.amount, 0);
    let shortBy: number | null = null;
    let shortOn: string | null = null;
    if (acct && !isCard) {
      // THE WALK. A bill already overdue is owed now, so it lands today. On a day with
      // both a bill and a paycheck the bill goes first: whether pay lands before the
      // bill draws on the same day is not something the data says, and assuming it does
      // is the optimistic guess.
      const events = [
        ...bk.bills.filter((b) => !b.alreadyOut).map((b) => ({ on: b.due < today ? today : b.due, amount: -b.amount })),
        ...bk.pay.map((p) => ({ on: p.on, amount: p.amount })),
      ].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.amount - b.amount));
      let run = acct.balance;
      let low = acct.balance;
      let lowOn: string | null = null;
      for (const e of events) {
        run += e.amount;
        if (run < low) {
          low = run;
          lowOn = e.on;
        }
      }
      shortBy = low < 0 ? -low : 0;
      shortOn = low < 0 ? (lowOn ?? today) : null;
    }
    return {
      accountId: id,
      balance: acct && !isCard ? acct.balance : null,
      isCard,
      bills: bk.bills,
      due,
      alreadyOut,
      stillToCome: due - alreadyOut,
      payCounted,
      shortBy,
      shortOn,
    };
  });
  // The app's own account order, with the unplaced bucket last.
  const order = (id: string | null) => (id ? (byId.get(id)?.sortOrder ?? 1e9) : 2e9);
  accounts.sort((a, b) => order(a.accountId) - order(b.accountId) || String(a.accountId).localeCompare(String(b.accountId)));

  return {
    from,
    through,
    today,
    days,
    throughIs: through === plus ? "days" : "rent",
    rentOn,
    payNotPlaced,
    payNotPlacedCount,
    accounts,
  };
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
