// Compute the four tab view-models from the live store — the bridge between the
// presentational bento tabs and the real data. Mirrors OnePager's derivation math
// exactly (planMath / payoffSchedule / spentByCategory / lens filtering) so the
// reskin shows the same numbers, just in the new shell.

import type { AppData, Debt } from "../../types";
import {
  orderedDebts,
  payoffSchedule,
  payoffClears,
  PAY_DAYS,
  SAVINGS_SPLIT,
  LEAN_VARIABLE,
  avgVariableSpend,
  previousPayday,
  type PayoffEvent,
} from "../../lib/plan";
import { firepowerStatus } from "../../lib/headline";
import {} from "../../lib/recurring";
import { t } from "../../lib/i18n";
import type { InsightsVM } from "./InsightsTab";
import type { EnvelopeVM } from "./CategorySheet";

const fmtMY = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");


const shortDebt = (n: string) => {
  const m = n.match(/…(\d{4})/);
  return m ? t("Card …{last4}", { last4: m[1] }) : n;
};

export interface VMExtras {
  email: string;
  lang: "en" | "zh";
}

export interface FinanceVMs {
  insights: InsightsVM;
  // The budget envelopes — each bar AND the transactions behind it, from one
  // calculation. FinanceTabs looks one up by key; it must never recompute.
  envelopes: EnvelopeVM[];
  // The single shared deploy plan — Home, the attack ladder, and the deploy slip
  // all read THIS, so their send-amounts and debt-free date never diverge.
  deploy: {
    ordered: Debt[];
    schedule: PayoffEvent[]; // the payoff projection (drives the ladder + debt-free date)
    totalDebt: number;
  };
}

export function buildFinanceVMs(data: AppData): FinanceVMs {
  const now = new Date();

  // ── core plan math ──
  // TWO horizons, deliberately. The debt/firepower math is MONTHLY because income
  // and bills are monthly. The BUDGET is graded per PAY CYCLE, because that's the
  // unit money actually arrives in — a calendar month splits one paycheck's
  // spending across two reports and hides where you stand until it's too late.
  //
  // ONE call, not a dozen. BOTH sequences this module used to spell out itself now
  // live in src/lib/headline.ts:
  //   · the envelope — monthly target, the cycle, its allowance, its graded spend,
  //     the per-category partition;
  //   · the hero tile's firepower — planMath, then the two subtractions planMath
  //     cannot see (month-to-date overspend, and cash out in categories no line
  //     grades) and the clamp at zero.
  // They live there because the Muse read door answers both questions, and a door
  // that re-applied those steps would be honestly computed and still disagree with
  // this screen — in a chat, with no screen beside the number to notice. A copy of a
  // sequence drifts exactly the way a copy of a formula does, with the arithmetic
  // hidden in the ORDER of the calls. Same functions, same order, same numbers on
  // this screen as before.
  const head = firepowerStatus(data, now);
  const { math, envelope, monthlyTarget, firepower } = head;
  const spentMonth = head.spentThisMonth;
  const cycle = envelope.cycle;
  const target = envelope.target; // the allowance for THIS cycle
  const spent = envelope.spent;
  const lineFor = new Map(envelope.lines.map((l) => [l.key, l]));
  const ordered = orderedDebts(data.debts);
  // Project the payoff from the SUSTAINABLE pace — a trailing average of ACTUAL
  // variable spend — so the debt-free date tracks real behavior: a one-off
  // over-budget month barely moves it, a sustained trend does. This month's spend
  // above that pace dents the next payday once (that cash is already gone).
  const projVariable = avgVariableSpend(data.transactions, now, 3, monthlyTarget);
  const projFirepower = Math.max(0, math.income - math.fixedNonDebt - projVariable);


  // ── per-line budget (the 6 lean envelopes) ──
  //
  // The bar AND the transactions behind it are built together, from the same
  // `cycle` window and the same `perCycle` target. They used to be computed in
  // two places — the bar here, the drill-in list in FinanceTabs — and the two
  // drifted apart when the budget moved to pay cycles: the bar read $79.58 for
  // the cycle while the list it opened read $44.13 for the calendar month, of a
  // monthly $250 target. A number and the rows that justify it have to come from
  // one calculation, or the next horizon change silently splits them again.
  const envelopes: EnvelopeVM[] = LEAN_VARIABLE.map((l) => {
    const inLine = (catId: string) => l.cats.includes(catId);
    const raw: { id: string; name: string; date: string; amount: number }[] = [];
    let pendingAmt = 0;
    for (const t of data.transactions) {
      // Pending charges are INCLUDED, and must be — spentByCategoryBetween, the
      // source of the bar, includes them. The two have to share a predicate or the
      // rows stop explaining the bar; they were once made to agree by hiding
      // pending from both, which agreed on a number $1,005 short of the truth.
      if (
        t.type !== "expense" ||
        t.date < cycle.start ||
        t.date > cycle.end ||
        t.appliesTo
      )
        continue;
      // Split-aware: a split txn contributes only the slices this line claims, at
      // their slice amount — the same partition spentByCategoryBetween uses, so
      // the rows always sum to the bar.
      const amt =
        t.splits && t.splits.length
          ? t.splits.filter((s) => inLine(s.categoryId)).reduce((s, x) => s + x.amount, 0)
          : inLine(t.categoryId)
            ? t.amount
            : 0;
      if (amt <= 0) continue;
      if (t.pending) pendingAmt += amt;
      raw.push({ id: t.id, name: t.description || t.categoryId, date: t.date, amount: amt });
    }
    raw.sort((a, b) => b.date.localeCompare(a.date));
    return {
      key: l.key,
      label: l.label,
      catId: l.cats[0],
      // Both figures come from the one shared assembly above, so the bar, the rows
      // behind it and the door all read the same two numbers.
      spent: lineFor.get(l.key)!.spent,
      pending: pendingAmt,
      target: lineFor.get(l.key)!.target,
      txns: raw.map((r) => ({
        id: r.id,
        name: r.name,
        amount: r.amount,
        dateLabel: new Date(r.date + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      })),
    };
  });
  const lineRows = envelopes.map((e) => ({
    catId: e.catId,
    label: e.label,
    spent: e.spent,
    target: e.target,
  }));
  const donut = lineRows.filter((r) => r.spent > 0).map((r) => ({ catId: r.catId, amount: r.spent }));


  // ── Debt payoff projection (for the attack-ladder view + the debt-free date) ──
  // Month-to-date against the MONTHLY pace, deliberately: `projVariable` is a
  // 30-day average, so the overspend debited against it has to be a 30-day figure
  // too. This used to read the per-CYCLE `spent`, comparing half a period against
  // a whole one — a ~15-day total almost never clears a 30-day pace, so the dent
  // came out 0 for essentially every input and a blown month never moved the
  // debt-free date at all. NOT the same number as the hero tile's
  // `overspendThisMonth` (src/lib/headline.ts): that grades the month against the
  // budget TARGET, this grades it against the SUSTAINABLE pace. Two different
  // questions about one month — they are meant to differ.
  const monthDent = Math.max(0, spentMonth - projVariable);
  const schedule = payoffSchedule(ordered, projFirepower, now, PAY_DAYS, SAVINGS_SPLIT, monthDent);
  // A schedule that ran out its 240-payday guard without clearing the debt is
  // the same SHAPE as one that finished — a non-empty array — so `schedule.length`
  // was reading "it gave up in Aug '36" as "you are debt-free in Aug '36".
  // payoffClears() asks the only question that separates them.
  const clears = payoffClears(schedule);
  const debtFreeBy = clears ? fmtMY(schedule[schedule.length - 1].date) : "—";
  const monthsToGo = clears
    ? Math.max(1, Math.round((schedule[schedule.length - 1].date.getTime() - now.getTime()) / 2.592e9))
    : 0;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  const deploy = { ordered, schedule, totalDebt: math.totalDebt };

  // ── Tracking: what was actually sent at debt this cycle (live from tagged txns).
  // Cycle starts at the previous payday (− a few days of early-post grace).
  const cycleAnchor = previousPayday(now);
  cycleAnchor.setDate(cycleAnchor.getDate() - 4);
  // ── Insights ──
  const ladder = ordered.map((d, i) => {
    const done = d.balance <= 0.005;
    const isTarget = !done && ordered.slice(0, i).every((x) => x.balance <= 0.005);
    return {
      rank: i + 1,
      name: shortDebt(d.name),
      amount: d.balance,
      live: !!d.providerAccountId,
      apr: d.apr,
      target: isTarget,
    };
  });
  const insights: InsightsVM = {
    budgetSpent: spent,
    budgetCycleLabel: cycle.label,
    budgetCycleDay: cycle.dayIndex,
    budgetCycleDays: cycle.days,
    budgetTarget: target,
    donut,
    categories: lineRows,
    income: math.income,
    living: math.fixedNonDebt,
    variable: math.variable,
    atDebt: firepower,
    debtFreeBy,
    monthsToGo,
    interest: totalInterest,
    ladder,
  };


  // Two VMs and the projection they rest on. It returned seven; the other five
  // described screens that no longer exist.
  return { insights, envelopes, deploy };
}
