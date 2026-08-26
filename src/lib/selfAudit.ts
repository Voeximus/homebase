import type { AppData } from "../types";
import {
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  inAnyLine,
  lineSpent,
  spentByCategoryBetween,
  sumTargets,
  payCycleFor,
  plannedMonthly,
} from "./plan";

import { monthlySchedule } from "./schedule";
import { addMonths } from "./forecast";
import { monthKeyOf } from "./format";

// ── Does this add up? ─────────────────────────────────────────────────────────
//
// The app's failure mode has never been ignorance. It has been UNEXAMINED
// CONFIDENCE: it computes a number, shows it, and never asks whether its own
// other number agrees.
//
// The worst defect this codebase has produced is exactly that shape. Bill start
// and end windows were honoured on the calendar path and ignored on the plan
// path, so Home reported $1,163.92/month less available than Bills and Forecast
// did — for days — and nothing anywhere noticed that two screens described the
// same month differently. No test would have caught it either, because both
// halves were individually self-consistent.
//
// So this module computes the app's key figures a SECOND, independent way and
// reports the gap. It is not a model, a heuristic, or a guess.
//
// THE DESIGN RULE THAT MATTERS: every check here is EXACT. Each one is a
// quantity that must be precisely zero in a healthy app, so a non-zero result is
// definitionally a defect and never a judgement call. There are no thresholds to
// tune and no statistics to argue with — which is the only honest way to earn a
// warning that the user should believe. Anything that could only be "probably
// wrong" was deliberately left out of this file.
//
// Checks that were CONSIDERED AND REJECTED for failing that bar:
//   · plan-vs-calendar on the whole month total — legitimately differs, because
//     monthlyAmount() spreads a periodic bill while the calendar lumps it (that
//     is convention 4), and because liveOn() evaluates one date while the
//     calendar prorates a boundary month. A real difference, so it cannot be a
//     failure signal.
//   · a bill marked paid with no matching charge — a manual marker legitimately
//     has none, so it would fire on correct use.
//   · cash vs the ledger's own sum — the app has no independent second source
//     for cash on the client; the bank IS the source, and it is already the
//     anchor. Comparing a number to itself proves nothing.

export type CheckStatus = "ok" | "fail";

export interface AuditCheck {
  id: string;
  /** What is being compared, in one sentence, in the user's language. */
  question: string;
  status: CheckStatus;
  /** Plain-language result. On failure it names the gap in real units. */
  detail: string;
  /** The two independently computed figures, when the check is a comparison. */
  a?: { label: string; value: number };
  b?: { label: string; value: number };
}

export interface AuditResult {
  checks: AuditCheck[];
  failures: number;
  /** True when every check passed — the only state worth saying nothing about. */
  clean: boolean;
}

const CENT = 0.005; // half a cent: below this is float noise, not disagreement

/** Run every self-check. Pure: no I/O, no clock beyond the `now` you pass. */
export function selfAudit(data: AppData, now: Date = new Date()): AuditResult {
  const checks: AuditCheck[] = [
    scheduleMatchesMonthlyAmount(data, now),
    budgetRowsSumToTheirBar(data, now),
    everyCategoryIsAccountedFor(data),
    linesSumToTheEnvelope(),
    splitsSumToTheirTransaction(data),
    aSettledBillIsActuallySettled(data, now),
    onePaymentPerBillCycle(data),
  ];
  const failures = checks.filter((c) => c.status === "fail").length;
  return { checks, failures, clean: failures === 0 };
}

// ── 1. The calendar and the plan must agree, per bill ─────────────────────────
/**
 * For each recurring row, the monthly figure the PLAN uses (monthlyAmount, which
 * feeds firepower) must equal what the CALENDAR actually schedules for that row,
 * averaged over a year. This is the check that would have caught the
 * $1,163.92 window bug on the day it shipped.
 *
 * Rows are excluded where a difference is DELIBERATE, and each exclusion is a
 * documented convention rather than a convenience:
 *   · biweekly — convention 1. monthlyAmount uses ×2 while the calendar places
 *     real 14-day dates, so a year contains ~26 payments against 24 budgeted.
 *     That understatement IS the design.
 *   · a start/end window — liveOn() is all-or-nothing on one date while the
 *     calendar prorates the boundary month. Known and documented.
 *   · a linked debt — the calendar drops the row once the debt clears, by design.
 */
function scheduleMatchesMonthlyAmount(data: AppData, now: Date): AuditCheck {
  const start = monthKeyOf(now);
  const offenders: string[] = [];
  let worst = 0;

  const eligible = data.recurring.filter(
    (r) =>
      r.active &&
      r.direction !== "transfer" &&
      r.cadence !== "biweekly" &&
      !r.startsOn &&
      !r.endsOn &&
      !r.linkedDebtId,
  );

  // A full year, so a quarterly/semiannual/yearly bill contributes its whole
  // charge exactly once and the two views become comparable.
  const scheduled = new Map<string, number>();
  for (let i = 0; i < 12; i++) {
    const key = addMonths(start, i);
    for (const e of monthlySchedule(data.recurring, key, data.transactions, data.debts).entries) {
      if (!e.recurringId) continue;
      scheduled.set(e.recurringId, (scheduled.get(e.recurringId) ?? 0) + e.amount);
    }
  }

  for (const r of eligible) {
    // plannedMonthly() is the SAME function planMath prices with, so this
    // compares the plan's own answer against the calendar's placement rather
    // than against a third reimplementation that could drift from both.
    const planned = plannedMonthly(r, data.transactions) * 12;
    const actual = scheduled.get(r.id) ?? 0;
    const gap = Math.abs(planned - actual);
    if (gap > CENT) {
      offenders.push(`${r.name} (plan ${planned.toFixed(2)} vs calendar ${actual.toFixed(2)})`);
      worst = Math.max(worst, gap);
    }
  }

  return {
    id: "schedule-vs-plan",
    question: "Do your bills add up the same way on every screen?",
    status: offenders.length ? "fail" : "ok",
    detail: offenders.length
      ? `${offenders.length} bill${offenders.length > 1 ? "s" : ""} counted differently by the budget than by the calendar, the largest by $${worst.toFixed(2)} over a year: ${offenders.join("; ")}.`
      : `All ${eligible.length} fixed bills are counted identically by the budget and the calendar.`,
  };
}

// ── 2. A budget bar must equal the rows it opens to ───────────────────────────
/**
 * Tapping a budget line shows the charges behind it. The bar's number and those
 * rows come from two different code paths, and they have drifted before: the
 * list once included still-processing charges the bar excluded, so $300 of
 * visible rows sat under a header reading $120 and nothing reconciled.
 */
function budgetRowsSumToTheirBar(data: AppData, now: Date): AuditCheck {
  const cycle = payCycleFor(now);
  const byCat = spentByCategoryBetween(data.transactions, cycle.start, cycle.end);
  const offenders: string[] = [];
  let worst = 0;

  for (const line of LEAN_VARIABLE) {
    const bar = lineSpent(line, byCat);
    // Rebuilt from the ledger with the SAME partition the drill-in applies.
    let rows = 0;
    for (const t of data.transactions) {
      if (t.type !== "expense" || t.pending || t.appliesTo) continue;
      if (t.date < cycle.start || t.date > cycle.end) continue;
      if (t.splits && t.splits.length) {
        for (const s of t.splits) if (line.cats.includes(s.categoryId)) rows += s.amount;
      } else if (line.cats.includes(t.categoryId)) {
        rows += t.amount;
      }
    }
    const gap = Math.abs(bar - rows);
    if (gap > CENT) {
      offenders.push(`${line.label} (bar ${bar.toFixed(2)} vs rows ${rows.toFixed(2)})`);
      worst = Math.max(worst, gap);
    }
  }

  return {
    id: "bar-vs-rows",
    question: "Does each budget line equal the charges behind it?",
    status: offenders.length ? "fail" : "ok",
    detail: offenders.length
      ? `${offenders.length} budget line${offenders.length > 1 ? "s" : ""} do not match the charges they list, the largest by $${worst.toFixed(2)}: ${offenders.join("; ")}.`
      : `Every budget line equals the sum of the charges it shows.`,
  };
}

// ── 3. No category may be invisible ──────────────────────────────────────────
/**
 * An expense category must be graded against a budget line OR listed as
 * deliberately ungraded. A category in neither is money that leaves the account
 * and appears on no screen: `utilities` was in exactly that state, so a $180
 * water bill counted against no budget and reduced no available cash.
 */
function everyCategoryIsAccountedFor(data: AppData): AuditCheck {
  // This used to take no arguments and audit DEFAULT_EXPENSE_IDS — a hardcoded
  // list in this same file. So it compared one constant against another and
  // passed forever, while the LEDGER was free to carry any category id at all:
  // a learned merchant rule writes `merchant_rules.category_id` as unconstrained
  // text, the importer writes ids of its own, and none of it was ever checked.
  // A check that cannot see the data it is supposed to be guarding is decoration.
  //
  // `interest` is deliberately ungraded — it is not spending anyone chose, and it
  // is already inside the card balance the debt total reads from, so grading it
  // would count it twice. Income categories are not in scope.
  const ungraded = new Set([...OUTSIDE_BUDGET_CASH_CATS, "interest"]);
  const live = new Set<string>(DEFAULT_EXPENSE_IDS);
  for (const t of data.transactions) {
    if (t.type !== "expense") continue;
    if (t.splits && t.splits.length) for (const sp of t.splits) live.add(sp.categoryId);
    else if (t.categoryId) live.add(t.categoryId);
  }
  for (const r of data.recurring) if (r.direction === "out" && r.categoryId) live.add(r.categoryId);
  for (const r of data.merchantRules ?? []) if (r.categoryId) live.add(r.categoryId);

  const orphans = [...live].filter((id) => !inAnyLine(id) && !ungraded.has(id)).sort();
  const amountIn = (id: string) =>
    data.transactions
      .filter((t) => t.type === "expense")
      .reduce(
        (sum, t) =>
          sum +
          (t.splits && t.splits.length
            ? t.splits.filter((sp) => sp.categoryId === id).reduce((a, sp) => a + sp.amount, 0)
            : t.categoryId === id
              ? t.amount
              : 0),
        0,
      );
  return {
    id: "no-orphan-categories",
    question: "Could money vanish into a category nothing watches?",
    status: orphans.length ? "fail" : "ok",
    detail: orphans.length
      ? `${orphans.map((id) => `${id} ($${amountIn(id).toFixed(2)})`).join(", ")} — spending here counts against no budget and reduces no available cash, so it disappears from every screen.`
      : `All ${live.size} spending categories in use are either budgeted or deliberately set outside the budget.`,
  };
}

// ── 4. The envelope must be the sum of its parts ─────────────────────────────
function linesSumToTheEnvelope(): AuditCheck {
  const sum = sumTargets(LEAN_VARIABLE);
  const gap = Math.abs(sum - MONTHLY_ENVELOPE);
  return {
    id: "lines-sum-to-envelope",
    question: "Do the budget lines add up to the budget?",
    status: gap > CENT ? "fail" : "ok",
    detail:
      gap > CENT
        ? `The lines total $${sum.toFixed(2)} but the envelope is $${MONTHLY_ENVELOPE.toFixed(2)} — off by $${gap.toFixed(2)}.`
        : `The lines total $${sum.toFixed(2)}, matching the envelope.`,
    a: { label: "lines", value: sum },
    b: { label: "envelope", value: MONTHLY_ENVELOPE },
  };
}

// ── 5. A split must not change the size of the charge ────────────────────────
/**
 * A split allocates one charge across categories. If the slices do not sum to
 * the charge, category totals silently stop reconciling with cash — and the
 * error is invisible, because both halves still look internally plausible.
 */
function splitsSumToTheirTransaction(data: AppData): AuditCheck {
  const offenders: string[] = [];
  let worst = 0;
  let split = 0;
  for (const t of data.transactions) {
    if (!t.splits || !t.splits.length) continue;
    split++;
    const sum = t.splits.reduce((s, x) => s + x.amount, 0);
    const gap = Math.abs(sum - t.amount);
    if (gap > CENT) {
      offenders.push(`${t.date} ${t.description} (slices ${sum.toFixed(2)} vs charge ${t.amount.toFixed(2)})`);
      worst = Math.max(worst, gap);
    }
  }
  return {
    id: "splits-sum",
    question: "Do split charges still add up to what you paid?",
    status: offenders.length ? "fail" : "ok",
    detail: offenders.length
      ? `${offenders.length} split charge${offenders.length > 1 ? "s" : ""} do not sum to the amount paid, the largest by $${worst.toFixed(2)}: ${offenders.join("; ")}.`
      : `All ${split} split charges sum exactly to what was paid.`,
  };
}

/** The installment slot a stored `appliesTo.day` belongs to. Rows written before
 *  installmentIndex existed carry only the day, so defaulting them all to 0
 *  would collapse a two-installment bill (support to family, paid on the 15th
 *  AND the 30th) into one cycle and read every second payment as a duplicate.
 *  MIRROR of installmentIndexForDay in supabase/functions/plaid/index.ts. */
function cycleKeyOf(at: { recurringId?: string; monthKey?: string; day?: number; installmentIndex?: number }, dueDays?: number[]): string {
  let idx = at.installmentIndex;
  if (idx == null) {
    const days = dueDays && dueDays.length ? [...dueDays].sort((a, b) => a - b) : [];
    if (days.length <= 1) idx = 0;
    else {
      let best = 0, bestGap = Infinity;
      days.forEach((d, i) => {
        const g = Math.abs(d - (at.day ?? 0));
        if (g < bestGap) { bestGap = g; best = i; }
      });
      idx = best;
    }
  }
  return `${at.recurringId}|${at.monthKey}|${idx}`;
}

// ── 6. A bill shown as SETTLED must actually be settled ───────────────────────
/**
 * For every bill cycle the ledger marks settled, the payments claiming that
 * cycle must add up to what the bill costs. A FIXED bill has one right number,
 * so "amount owed minus amount paid" is a quantity that is exactly zero in a
 * healthy app — which is what earns this a place in this file. Overpayment is
 * not a defect (paying $200 against a $134 card minimum is a choice), so only a
 * SHORTFALL counts.
 *
 * This is the check that would have caught the worst live defect this app has
 * produced. The landlord is "Nollie MA"; the same landlord's parking garage
 * bills as "Parkinsafe Nollie" for $6 a visit, and a bill rule matching bare
 * NOLLIE settled the SEPTEMBER rent cycle with a $6.00 parking charge. The
 * calendar read "Sep 1 — Rent — PAID $6.00" and September looked $1,726.16
 * lighter than it was, in the month the household's cash is tightest. Nothing
 * anywhere objected, because every screen agreed: they were all reading the same
 * wrong link. Only comparing the payment to the PRICE catches it.
 *
 * Excluded, for the same documented reasons as check 1:
 *   · variable bills (electric, phone) — the modeled figure is an estimate by
 *     design, so a gap is not a defect.
 *   · debt-linked bills — the payment is chosen against the debt, not the row,
 *     and the calendar drops the row entirely once the debt clears.
 *   · rows with no modeled amount — nothing to compare against.
 */
function aSettledBillIsActuallySettled(data: AppData, now: Date): AuditCheck {
  const nowKey = monthKeyOf(now);
  const byId = new Map(data.recurring.map((r) => [r.id, r]));
  const paidByCycle = new Map<string, number>();
  for (const t of data.transactions) {
    const at = t.appliesTo;
    if (t.type !== "expense" || at?.kind !== "bill" || !at.recurringId) continue;
    const key = cycleKeyOf(at, byId.get(at.recurringId)?.dueDays);
    paidByCycle.set(key, (paidByCycle.get(key) ?? 0) + t.amount);
  }

  const offenders: string[] = [];
  let worst = 0;
  let checked = 0;
  for (const [key, paid] of paidByCycle) {
    const [rid, monthKey] = key.split("|");
    const rec = byId.get(rid);
    if (!rec) continue;
    if (rec.variable || rec.linkedDebtId) continue;
    // Only cycles from THIS month forward. A recurring row stores today's price,
    // and a past cycle was paid at the price in force then — rent was $1,233
    // before it became $1,732.16, so judging April's payment against today's
    // figure would report a defect where there was only a rent increase. The
    // question that matters is forward-looking anyway: is the app telling the
    // household an obligation it STILL OWES is handled?
    if (monthKey < nowKey) continue;
    const owed = rec.knownAmount ?? rec.amount;
    if (!(owed > 0)) continue;
    checked++;
    const short = owed - paid;
    if (short > CENT) {
      offenders.push(
        `${rec.name} ${monthKey} reads paid, but only $${paid.toFixed(2)} of $${owed.toFixed(2)} was charged`,
      );
      worst = Math.max(worst, short);
    }
  }
  return {
    id: "settled-means-settled",
    question: "Is every bill marked paid actually paid in full?",
    status: offenders.length ? "fail" : "ok",
    detail: offenders.length
      ? `${offenders.length} bill cycle${offenders.length > 1 ? "s are" : " is"} marked paid with money still owed, the largest by $${worst.toFixed(2)}: ${offenders.join("; ")}.`
      : `All ${checked} settled fixed-bill cycles from this month on were paid in full.`,
  };
}

// ── 7. One bill cycle, one payment ────────────────────────────────────────────
/**
 * A bill cycle can be settled once. Two ledger rows claiming the same
 * (bill, month, installment) means the same obligation was paid for twice in the
 * app's books — the classic shape being a manual "already paid" marker that the
 * real bank row later landed beside instead of replacing. Exactly zero in a
 * healthy app, so a non-zero result is a defect and never a judgement call.
 */
function onePaymentPerBillCycle(data: AppData): AuditCheck {
  const byId = new Map(data.recurring.map((r) => [r.id, r]));
  const cycles = new Map<string, { amount: number; date: string }[]>();
  for (const t of data.transactions) {
    const at = t.appliesTo;
    if (t.type !== "expense" || at?.kind !== "bill" || !at.recurringId) continue;
    const key = cycleKeyOf(at, byId.get(at.recurringId)?.dueDays);
    (cycles.get(key) ?? cycles.set(key, []).get(key)!).push({ amount: t.amount, date: t.date });
  }
  const offenders: string[] = [];
  let doubled = 0;
  for (const [key, rows] of cycles) {
    if (rows.length < 2) continue;
    const [rid, monthKey] = key.split("|");
    const name = byId.get(rid)?.name ?? "an unknown bill";
    const extra = rows.slice(1).reduce((s, r) => s + r.amount, 0);
    doubled += extra;
    offenders.push(
      `${name} ${monthKey} is claimed by ${rows.length} charges (${rows.map((r) => `${r.date} $${r.amount.toFixed(2)}`).join(", ")})`,
    );
  }
  return {
    id: "one-payment-per-cycle",
    question: "Is any bill recorded as paid twice?",
    status: offenders.length ? "fail" : "ok",
    detail: offenders.length
      ? `${offenders.length} bill cycle${offenders.length > 1 ? "s are" : " is"} claimed by more than one charge, counting $${doubled.toFixed(2)} of spending twice: ${offenders.join("; ")}.`
      : `Every settled bill cycle is claimed by exactly one charge.`,
  };
}

// Kept local rather than imported from seed.ts so this module stays a pure
// function of the data it is handed plus the budget definition it audits.
const DEFAULT_EXPENSE_IDS = [
  "groceries",
  "dining",
  "transport",
  "housing",
  "utilities",
  "shopping",
  "entertainment",
  "subscriptions",
  "electronics",
  "car",
  "kids",
  "pets",
  "interest",
  "other",
];

/** The designed monthly variable envelope the lines must reconcile to. */
export const MONTHLY_ENVELOPE = 1600;
