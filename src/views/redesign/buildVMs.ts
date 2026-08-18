// Compute the four tab view-models from the live store — the bridge between the
// presentational bento tabs and the real data. Mirrors OnePager's derivation math
// exactly (planMath / payoffSchedule / spentByCategory / lens filtering) so the
// reskin shows the same numbers, just in the new shell.

import type { AppData, Transaction, Debt } from "../../types";
import {
  planMath,
  orderedDebts,
  payoffSchedule,
  PAY_DAYS,
  SAVINGS_SPLIT,
  sumTargets,
  LEAN_VARIABLE,
  OUTSIDE_BUDGET_CASH_CATS,
  lineSpent,
  spentByCategory,
  spentByCategoryBetween,
  variableSpentBetween,
  payCycleFor,
  perCycle,
  variableSpentThisMonth,
  avgVariableSpend,
  commitmentProgress,
  billExpected,
  previousPayday,
  type PayoffEvent,
} from "../../lib/plan";
import { totalBalance, cashAccounts, totalPendingHold } from "../../lib/recurring";
import { monthlySchedule, type ScheduleEntry } from "../../lib/schedule";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { merchantKey } from "../../lib/categorize";
import { OWNER_NAME, OWNER_COLOR, type Owner } from "../../lib/owner";
import { t } from "../../lib/i18n";
import type { HomeVM, BillsVM } from "./vm";
import type { InsightsVM } from "./InsightsTab";
import type { ActivityVM, ActivityMonth, ActivityRow, ActivityFate } from "./ActivityTab";
import type { ProfileVM } from "./ProfileTab";
import type { EnvelopeVM } from "./CategorySheet";

const pad = (n: number) => String(n).padStart(2, "0");
const monthKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dateKeyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtMY = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

const OWNER_DOT: Record<string, string> = {
  Gino: "#5b82b3",
  Xinyan: "#46d18a",
  Joint: "#687180",
};

const shortDebt = (n: string) => {
  const m = n.match(/…(\d{4})/);
  return m ? t("Card …{last4}", { last4: m[1] }) : n;
};

export interface VMExtras {
  email: string;
  lang: "en" | "zh";
}

export interface FinanceVMs {
  home: HomeVM;
  insights: InsightsVM;
  activity: ActivityVM;
  profile: ProfileVM;
  bills: BillsVM;
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

export function buildFinanceVMs(
  data: AppData,
  owner: Owner,
  lens: Lens,
  extra: VMExtras,
): FinanceVMs {
  const now = new Date();
  const monthKey = monthKeyOf(now);
  const todayKey = dateKeyOf(now);
  const personal = lens === "me";
  const otherLabel = owner === "gino" ? "Xinyan" : "Gino";
  const otherAccountIds = new Set(
    data.accounts.filter((a) => a.owner === otherLabel).map((a) => a.id),
  );
  const myAccounts = personal ? ownAccounts(data.accounts, owner) : data.accounts;

  // ── core plan math ──
  // TWO horizons, deliberately. The debt/firepower math is MONTHLY because income
  // and bills are monthly. The BUDGET is graded per PAY CYCLE, because that's the
  // unit money actually arrives in — a calendar month splits one paycheck's
  // spending across two reports and hides where you stand until it's too late.
  const monthlyTarget = sumTargets(LEAN_VARIABLE);
  // transactions are passed so a VARIABLE bill is priced the way the calendar
  // prices it (known_amount, else the rolling average) rather than by its stale
  // stored amount — without them the plan and the calendar disagree.
  const math = planMath(data.recurring, data.debts, monthlyTarget, undefined, data.transactions);
  const spentMonth = variableSpentThisMonth(data.transactions, monthKey);

  const cycle = payCycleFor(now);
  const target = perCycle(monthlyTarget); // the allowance for THIS cycle
  const spent = variableSpentBetween(data.transactions, cycle.start, cycle.end);
  const byCat = spentByCategoryBetween(data.transactions, cycle.start, cycle.end);
  // Overspending the lean budget is real cash that can NO LONGER go at the debt,
  // so it reduces firepower live as you spend. (Under-spending does NOT inflate
  // firepower — the budget stays reserved, and a mid-period "under" is just the
  // period not being over yet.) Measured MONTHLY here on purpose: firepower is a
  // monthly figure (monthly income less monthly bills), so mixing a per-cycle
  // overspend into it would compare half a period against a whole one.
  const overspendMonth = Math.max(0, spentMonth - monthlyTarget);
  // The same idea on the cycle horizon — what the budget bar shows.
  const overspend = Math.max(0, spent - target);
  // Cash that left but is NOT graded against the envelope (electronics). It never
  // shows as "overspend" — there's no line to blow — but it's still money that
  // can't go at the debt, so it comes off firepower directly. Monthly, to match.
  const byCatMonth = spentByCategory(data.transactions, monthKey);
  const outsideBudgetCash = OUTSIDE_BUDGET_CASH_CATS.reduce((s, c) => s + (byCatMonth[c] ?? 0), 0);
  const firepower = Math.max(0, math.firepower - overspendMonth - outsideBudgetCash); // "available THIS month" (the hero tile)
  const ordered = orderedDebts(data.debts);
  // Project the payoff from the SUSTAINABLE pace — a trailing average of ACTUAL
  // variable spend — so the debt-free date tracks real behavior: a one-off
  // over-budget month barely moves it, a sustained trend does. This month's spend
  // above that pace dents the next payday once (that cash is already gone).
  const projVariable = avgVariableSpend(data.transactions, now, 3, monthlyTarget);
  const projFirepower = Math.max(0, math.income - math.fixedNonDebt - projVariable);
  // The deploy plan (lump-now + flow-after) is built below — after the bills
  // section — because it needs the bills-before-next-payday hold-back.
  const totalOriginal = data.debts.reduce((s, d) => s + d.originalBalance, 0);
  const cleared = totalOriginal - math.totalDebt;
  const clearedPct = totalOriginal > 0 ? (cleared / totalOriginal) * 100 : 0;
  const commit = commitmentProgress(now);

  // ── cash (lens-aware) ──
  const totalCash = totalBalance(data.accounts);
  const jointCash = personal ? totalBalance(jointAccounts(data.accounts)) : 0;
  const cash = personal ? totalBalance(myAccounts) + jointCash : totalCash;
  const cashAcctCount = cashAccounts(personal ? myAccounts : data.accounts).length;
  // "still processing" hold — mirror the cash lens (own + joint when personal)
  const processing = personal
    ? totalPendingHold(myAccounts) + totalPendingHold(jointAccounts(data.accounts))
    : totalPendingHold(data.accounts);

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
    for (const t of data.transactions) {
      // `!t.pending` is part of the partition, not an afterthought:
      // spentByCategoryBetween — the source of the bar — excludes still-processing
      // charges. This list used to keep them, so a $180 pending Costco charge put
      // $300 of visible rows under a header that read $120, and the total jumped
      // $180 with no new row appearing the day it posted. Same predicate, or the
      // rows stop being an explanation of the bar.
      if (
        t.type !== "expense" ||
        t.pending ||
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
      raw.push({ id: t.id, name: t.description || t.categoryId, date: t.date, amount: amt });
    }
    raw.sort((a, b) => b.date.localeCompare(a.date));
    return {
      key: l.key,
      label: l.label,
      catId: l.cats[0],
      spent: lineSpent(l, byCat),
      target: perCycle(l.target),
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

  // debtFreeBy / monthsToGo are derived from the deploy plan (built after bills).

  // ── lens-filtered ledger (same predicate as OnePager `recent`/`ledgerTxns`) ──
  const visible = data.transactions
    .filter((tx) => !tx.appliesTo?.settled)
    // "Set aside · excluded" drops out of the active ledger (like a transfer);
    // "set aside · reimbursable" stays VISIBLE until settled (it's owed to you).
    .filter((tx) => !(tx.appliesTo?.kind === "setaside" && tx.appliesTo.reason === "excluded"))
    .filter((tx) => !personal || !tx.accountId || !otherAccountIds.has(tx.accountId))
    .sort((a, b) =>
      a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
    );

  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? id;
  const ruleSet = new Set(data.merchantRules.map((r) => r.pattern));
  const hasRule = (desc: string) => ruleSet.has(merchantKey(desc));
  const envLabel = (catId: string) =>
    LEAN_VARIABLE.find((l) => l.cats.includes(catId))?.label ?? catName(catId);

  const relDay = (date: string) => {
    if (date === todayKey) return t("today");
    const d = new Date(date + "T00:00:00");
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dateKeyOf(d) === dateKeyOf(y)) return t("yesterday");
    return fmtDay(d);
  };

  // ── Home recent (3) ──
  const recent = visible.slice(0, 3).map((tx) => ({
    id: tx.id,
    merchant: tx.description || catName(tx.categoryId),
    catId: tx.categoryId,
    sub: `${catName(tx.categoryId)} · ${relDay(tx.date)}`,
    amount: tx.amount,
    income: tx.type === "income",
    pending: !!tx.pending,
  }));

  // ── "spent since Monday" — lens-filtered (matches the lists, not the household) ──
  const dow = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((dow + 6) % 7));
  const mondayKey = dateKeyOf(monday);
  const sinceMonday = visible
    .filter((t) => t.type === "expense" && t.date >= mondayKey && !t.pending)
    .reduce((s, t) => s + t.amount, 0);

  // ── simple anomaly count: a free-form charge > 2.5× its category's monthly mean.
  //    From `visible` (lens-filtered) so the count matches what the list can show —
  //    otherwise a spouse's anomaly counts here but opens to an empty lens-filtered list.
  const monthFree = visible.filter(
    (t) => t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo && !t.pending,
  );
  const byCatAmts: Record<string, number[]> = {};
  monthFree.forEach((t) => (byCatAmts[t.categoryId] ??= []).push(t.amount));
  const anomalies = monthFree
    .filter((t) => {
      if (t.anomalyAck) return false; // user dismissed this flag → never resurface
      const arr = byCatAmts[t.categoryId];
      if (arr.length < 3 || t.amount <= 25) return false;
      const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
      return t.amount > 2.5 * mean;
    })
    .map((t) => {
      const arr = byCatAmts[t.categoryId];
      const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
      return {
        id: t.id,
        merchant: t.description || catName(t.categoryId),
        catId: t.categoryId,
        catLabel: catName(t.categoryId),
        amount: t.amount,
        ratio: mean > 0 ? t.amount / mean : 0,
      };
    });
  const anomalyIds = anomalies.map((a) => a.id);
  const anomalyCount = anomalies.length;

  // ── bills + money calendar ──
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const todayNum = now.getDate();
  const { entries } = monthlySchedule(data.recurring, monthKey, data.transactions, data.debts);
  const outEntries = entries.filter((e) => e.direction === "out");
  // The scheduled installment days for each recurring this month — used to snap a
  // recorded payment to the right installment even if the feed logged the raw bank
  // post-day (a row with no baked due_days records postDay, which can sit a day or
  // two off the scheduled day). Without this, a real payment fails the exact
  // day-equality check and the bill wrongly shows unpaid.
  const recDaysByRec: Record<string, number[]> = {};
  outEntries.forEach((e) => {
    if (e.recurringId) (recDaysByRec[e.recurringId] ??= []).push(e.day);
  });
  const recordedBill = (e: ScheduleEntry, mk: string = monthKey) =>
    e.recurringId
      ? data.transactions.find((t) => {
          if (t.type !== "expense" || t.appliesTo?.kind !== "bill") return false;
          if (t.appliesTo.recurringId !== e.recurringId || t.appliesTo.monthKey !== mk)
            return false;
          // snap the recorded day to this recurring's nearest scheduled day, then
          // require it to land on THIS entry — so single-installment bills flip on
          // any near day, while multi-installment bills (e.g. Mom 15/30) still map
          // each payment to the correct installment.
          const days = recDaysByRec[e.recurringId!] ?? [e.day];
          const rd = t.appliesTo.day;
          if (rd == null) return days.length === 1; // no day to snap → only the unambiguous single-installment
          const nearest = days.reduce((b, d) => (Math.abs(d - rd) < Math.abs(b - rd) ? d : b), days[0]);
          return nearest === e.day;
        })
      : undefined;
  const isBillPaid = (e: ScheduleEntry) =>
    e.recurringId ? !!recordedBill(e) : Math.min(e.day, daysInMonth) <= todayNum;
  const recCatOf = (recId?: string) =>
    data.recurring.find((r) => r.id === recId)?.categoryId ?? "other";
  const relLabelOf = (day: number) => {
    if (day === todayNum) return t("today");
    if (day === todayNum + 1) return t("tomorrow");
    if (day < todayNum) return t("overdue");
    return t("in {n} days", { n: day - todayNum });
  };
  const dayDate = (day: number) =>
    new Date(now.getFullYear(), now.getMonth(), Math.min(day, daysInMonth));
  const unpaidBills = outEntries.filter((e) => !isBillPaid(e)).sort((a, b) => a.day - b.day);
  const paidBills = outEntries.filter(isBillPaid);
  const leftThisMonth = unpaidBills.reduce((s, e) => s + e.amount, 0);
  const calMap: Record<number, { in: boolean; out: boolean }> = {};
  entries.forEach((e) => {
    const d = Math.min(e.day, daysInMonth);
    calMap[d] ??= { in: false, out: false };
    if (e.direction === "in") calMap[d].in = true;
    else calMap[d].out = true;
  });
  const nextBill = unpaidBills.find((e) => e.day >= todayNum) ?? unpaidBills[0];
  const bills: BillsVM = {
    leftThisMonth,
    upcoming: unpaidBills.map((e) => ({
      id: `${e.recurringId ?? e.label}@${e.day}`,
      recurringId: e.recurringId,
      name: e.label,
      catId: recCatOf(e.recurringId),
      amount: e.amount,
      day: e.day,
      dateLabel: fmtDay(dayDate(e.day)),
      relLabel: relLabelOf(e.day),
      variable: !!e.variable,
    })),
    paidCount: paidBills.length,
    paidTotal: paidBills.reduce((s, e) => s + e.amount, 0),
    monthLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    todayNum,
    daysInMonth,
    firstWeekday,
    calendar: Object.entries(calMap).map(([d, v]) => ({ day: +d, in: v.in, out: v.out })),
    monthBills: outEntries.map((e) => ({
      id: `${e.recurringId ?? e.label}@${e.day}`,
      recurringId: e.recurringId,
      name: e.label,
      catId: recCatOf(e.recurringId),
      amount: e.amount,
      day: e.day,
      dateLabel: fmtDay(dayDate(e.day)),
      relLabel: relLabelOf(e.day),
      variable: !!e.variable,
      paid: isBillPaid(e),
    })),
  };

  // ── Debt payoff projection (for the attack-ladder view + the debt-free date) ──
  // Month-to-date against the MONTHLY pace, deliberately: `projVariable` is a
  // 30-day average, so the overspend debited against it has to be a 30-day figure
  // too. This used to read the per-CYCLE `spent`, comparing half a period against
  // a whole one — a ~15-day total almost never clears a 30-day pace, so the dent
  // came out 0 for essentially every input and a blown month never moved the
  // debt-free date at all. NOT the same number as the hero tile's `overspendMonth`
  // (line 117): that grades the month against the budget TARGET, this grades it
  // against the SUSTAINABLE pace. Two different questions about one month — they
  // are meant to differ.
  const monthDent = Math.max(0, spentMonth - projVariable);
  const schedule = payoffSchedule(ordered, projFirepower, now, PAY_DAYS, SAVINGS_SPLIT, monthDent);
  const next = schedule[0] ?? null;
  const debtFreeBy = schedule.length ? fmtMY(schedule[schedule.length - 1].date) : "—";
  const monthsToGo = schedule.length
    ? Math.max(1, Math.round((schedule[schedule.length - 1].date.getTime() - now.getTime()) / 2.592e9))
    : 0;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  const deploy = { ordered, schedule, totalDebt: math.totalDebt };

  // ── Tracking: what was actually sent at debt this cycle (live from tagged txns).
  // Cycle starts at the previous payday (− a few days of early-post grace).
  const cycleAnchor = previousPayday(now);
  cycleAnchor.setDate(cycleAnchor.getDate() - 4);
  const cycleStartKey = dateKeyOf(cycleAnchor);
  const debtPatterns = data.debts
    .map((d) => d.trackPattern)
    .filter((p): p is string => !!p)
    .map((p) => p.toUpperCase());
  const deployedThisCycle = data.transactions
    .filter(
      (t) =>
        t.date >= cycleStartKey &&
        (t.appliesTo?.kind === "debt" ||
          (t.amount < 0 && debtPatterns.some((p) => (t.description ?? "").toUpperCase().includes(p)))),
    )
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  // ── "Owed to you" — reimbursable set-asides (real cash out until repaid) ──
  const isReimbursable = (tx: Transaction) =>
    tx.type === "expense" && tx.appliesTo?.kind === "setaside" && tx.appliesTo.reason === "reimbursable";
  const inLens = (tx: Transaction) => !personal || !tx.accountId || !otherAccountIds.has(tx.accountId);
  const owed = data.transactions
    .filter((tx) => isReimbursable(tx) && !tx.appliesTo!.settled && inLens(tx))
    .sort((a, b) => b.date.localeCompare(a.date));
  const owedToYou = owed.reduce((s, tx) => s + tx.amount, 0);

  // Candidate paybacks: real income not yet linked, within the current lens. Match
  // a single deposit (exact amount, on/within 60 days after the spend), then keep
  // the suggestion ONLY if that deposit isn't claimed by another equal-amount row —
  // a deposit two reimbursables both match is ambiguous → fall back to manual.
  const DAY = 864e5;
  const creditPool = data.transactions.filter((tx) => tx.type === "income" && !tx.appliesTo && inLens(tx));
  const rawMatch = new Map<string, string>(); // reimbursableId -> creditId
  const claims = new Map<string, number>(); // creditId -> # reimbursables claiming it
  for (const tx of owed) {
    const spent = new Date(tx.date + "T00:00:00").getTime();
    const cands = creditPool.filter((c) => {
      if (Math.abs(c.amount - tx.amount) > 0.01) return false;
      const got = new Date(c.date + "T00:00:00").getTime();
      return got >= spent && got - spent <= 60 * DAY;
    });
    if (cands.length === 1) {
      rawMatch.set(tx.id, cands[0].id);
      claims.set(cands[0].id, (claims.get(cands[0].id) ?? 0) + 1);
    }
  }
  const owedList = owed.map((tx) => {
    const cid = rawMatch.get(tx.id);
    const c = cid && claims.get(cid) === 1 ? data.transactions.find((t) => t.id === cid) : undefined;
    return {
      id: tx.id,
      merchant: tx.description || catName(tx.categoryId),
      amount: tx.amount,
      dateLabel: relDay(tx.date),
      note: tx.appliesTo?.note,
      ...(c ? { suggested: { id: c.id, label: `${c.description || catName(c.categoryId)} · ${relDay(c.date)}` } } : {}),
    };
  });
  // Recently-settled reimbursables, newest first — the undo path for a mis-confirm.
  const owedSettled = data.transactions
    .filter((tx) => isReimbursable(tx) && !!tx.appliesTo!.settled && inLens(tx))
    .sort((a, b) => (b.appliesTo?.settledAt ?? b.date).localeCompare(a.appliesTo?.settledAt ?? a.date))
    .slice(0, 8)
    .map((tx) => ({ id: tx.id, merchant: tx.description || catName(tx.categoryId), amount: tx.amount, dateLabel: relDay(tx.date) }));

  const home: HomeVM = {
    firepower,
    overspent: overspend,
    owedToYou,
    owedList,
    owedSettled,
    debtFreeBy,
    deployedThisCycle,
    // the "Send X at the debt" tile is the DEBT portion only — in the final
    // payoff phase `total` also includes the savings skim (surfaced separately in
    // the slip), so using toDebt keeps the label honest.
    nextAmount: next ? next.toDebt : 0,
    nextDate: next ? fmtDay(next.date) : "—",
    cash,
    cashAccounts: cashAcctCount,
    processing,
    debtLeft: math.totalDebt,
    debtProgressPct: clearedPct,
    budgetSpent: spent,
    budgetCycleLabel: cycle.label,
    budgetCycleDay: cycle.dayIndex,
    budgetCycleDays: cycle.days,
    budgetTarget: target,
    donut,
    anomalyCount,
    anomalyIds,
    anomalies,
    streakDay: commit.day,
    streakTotal: commit.total,
    recent,
    sinceMonday,
    bills: {
      left: leftThisMonth,
      nextName: nextBill ? nextBill.label : "—",
      nextDate: nextBill ? fmtDay(dayDate(nextBill.day)) : "",
    },
  };

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

  // ── Activity (this-month + recent rows, fate-badged) ──
  const fateOf = (tx: Transaction): { fate: ActivityFate; badge: string } => {
    if (tx.type === "income") return { fate: "income", badge: t("Income · not in budget") };
    if (tx.appliesTo?.kind === "setaside") {
      return tx.appliesTo.reason === "reimbursable"
        ? { fate: "setaside", badge: t("Set aside · owed back to you") }
        : { fate: "setaside", badge: t("Set aside") };
    }
    if (tx.appliesTo) {
      const k = tx.appliesTo.kind;
      return {
        fate: "skip",
        badge: t("{Kind} · not in budget", { Kind: `${k[0].toUpperCase()}${k.slice(1)}` }),
      };
    }
    if (tx.splits && tx.splits.length > 1)
      return { fate: "envelope", badge: t("Split · {n} ways", { n: tx.splits.length }) };
    if (tx.categoryId === "other" || !hasRule(tx.description))
      return { fate: "review", badge: t("Needs review") };
    return { fate: "envelope", badge: t("→ {label}", { label: envLabel(tx.categoryId) }) };
  };
  // The Activity tab is THIS month (matches the "June 2026" header) and is NOT
  // capped — so the "Needs review" badge count equals what the filter shows, and
  // every reviewable charge is reachable (the all-time triage bench is LedgerSheet).
  // Group activity by month so the tab can flip back through prior months. Every
  // month present in the visible ledger (plus the current one) gets a group,
  // newest first; [0] is the current month.
  const toRows = (txns: typeof visible): ActivityRow[] =>
    txns.map((tx) => {
      const f = fateOf(tx);
      return {
        id: tx.id,
        merchant: tx.description || catName(tx.categoryId),
        catId: tx.categoryId,
        sub: relDay(tx.date),
        amount: tx.amount,
        fate: f.fate,
        badgeLabel: tx.pending ? t("Processing") : f.badge,
        pending: !!tx.pending,
      };
    });

  const activityMonthKeys = Array.from(new Set([monthKey, ...visible.map((tx) => tx.date.slice(0, 7))]))
    .sort()
    .reverse();
  const monthGroups: ActivityMonth[] = activityMonthKeys.map((mk) => {
    const mrows = toRows(visible.filter((tx) => tx.date.slice(0, 7) === mk));
    const [yy, mm] = mk.split("-").map(Number);
    return {
      monthKey: mk,
      monthLabel: new Date(yy, mm - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      rows: mrows,
      counted: variableSpentThisMonth(visible, mk),
      needsReview: mrows.filter((r) => r.fate === "review").length,
    };
  });

  // The budget grades a PAY CYCLE; the ledger grouped by calendar month. At every
  // month boundary those disagree — a charge on the 31st counts toward this
  // cycle's spend but files under last month, so the budget number can't be
  // reconciled against anything you can see. This puts the cycle first, so the
  // list you scroll IS the list the envelope is adding up.
  const cycleRows = toRows(
    visible.filter((tx) => tx.date >= cycle.start && tx.date <= cycle.end),
  );
  const cycleGroup: ActivityMonth = {
    monthKey: `cycle:${cycle.start}`,
    monthLabel: `${t("This cycle")} · ${cycle.label}`,
    rows: cycleRows,
    counted: variableSpentBetween(visible, cycle.start, cycle.end),
    needsReview: cycleRows.filter((r) => r.fate === "review").length,
  };
  const months: ActivityMonth[] = [cycleGroup, ...monthGroups];
  const activity: ActivityVM = { sinceMonday, processing, months };

  // ── Profile ──
  // Same lens rule as the Cash sheet/total: own + joint in "me", all in "all".
  const profileAccounts = personal
    ? [...myAccounts, ...jointAccounts(data.accounts)]
    : data.accounts;
  const connected = data.accounts.filter((a) => a.providerAccountId).length;
  const linkedCards = data.debts
    .filter((d) => d.providerAccountId)
    .map((d) => (d.name.match(/…(\d{4})/) ? `…${d.name.match(/…(\d{4})/)![1]}` : d.name));
  const profile: ProfileVM = {
    ownerName: OWNER_NAME[owner],
    ownerColor: OWNER_COLOR[owner],
    email: extra.email,
    bankName: connected ? "Bank of America" : t("Connect a bank"),
    bankSub: connected
      ? t("Connected · {n} accounts", { n: connected })
      : t("Tap to connect"),
    cardsSub: linkedCards.length
      ? t("{cards} linked · auto-syncs", { cards: linkedCards.join(" + ") })
      : t("Track a card as debt"),
    accounts: cashAccounts(profileAccounts).map((a) => ({
      name: `${a.name} …${a.last4 ?? ""}`,
      owner: a.owner,
      balance: a.balance,
      dot: OWNER_DOT[a.owner] ?? "#687180",
    })),
    lang: extra.lang,
    lens,
    variableBills: data.recurring
      .filter((r) => r.variable && r.active)
      .map((r) => ({
        id: r.id,
        name: r.name,
        icon: /electric|srp/i.test(r.name) ? ("electric" as const) : ("phone" as const),
        est: t("~${x} · est. from last 3", { x: billExpected(r, data.transactions).toFixed(2) }),
        on: true,
      })),
  };

  return { home, insights, activity, profile, bills, envelopes, deploy };
}
