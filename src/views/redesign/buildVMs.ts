// Compute the four tab view-models from the live store — the bridge between the
// presentational bento tabs and the real data. Mirrors OnePager's derivation math
// exactly (planMath / payoffSchedule / spentByCategory / lens filtering) so the
// reskin shows the same numbers, just in the new shell.

import type { AppData, Transaction } from "../../types";
import {
  planMath,
  orderedDebts,
  payoffSchedule,
  PAY_DAYS,
  SAVINGS_SPLIT,
  sumTargets,
  LEAN_VARIABLE,
  lineSpent,
  spentByCategory,
  variableSpentThisMonth,
  commitmentProgress,
  billExpected,
} from "../../lib/plan";
import { totalBalance, cashAccounts, totalPendingHold } from "../../lib/recurring";
import { monthlySchedule, type ScheduleEntry } from "../../lib/schedule";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { merchantKey } from "../../lib/categorize";
import { OWNER_NAME, OWNER_COLOR, type Owner } from "../../lib/owner";
import { t } from "../../lib/i18n";
import type { HomeVM, BillsVM } from "./vm";
import type { InsightsVM } from "./InsightsTab";
import type { ActivityVM, ActivityRow, ActivityFate } from "./ActivityTab";
import type { ProfileVM } from "./ProfileTab";

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
  const target = sumTargets(LEAN_VARIABLE);
  const math = planMath(data.recurring, data.debts, target);
  const spent = variableSpentThisMonth(data.transactions, monthKey);
  const byCat = spentByCategory(data.transactions, monthKey);
  // Overspending the lean budget is real cash that can NO LONGER go at the debt
  // this month, so it reduces firepower live as you spend. (Under-spending does
  // NOT inflate firepower — the budget stays reserved, and a mid-month "under" is
  // just the month not being over yet.) This flows into the payoff schedule, the
  // hero number, and the "Next move", so they all reflect real available cash.
  const overspend = Math.max(0, spent - target);
  const firepower = Math.max(0, math.firepower - overspend);
  const ordered = orderedDebts(data.debts);
  const schedule = payoffSchedule(ordered, firepower, now, PAY_DAYS, SAVINGS_SPLIT);
  const next = schedule[0] ?? null;
  const payoffDate = schedule.length ? schedule[schedule.length - 1].date : null;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
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
  const lineRows = LEAN_VARIABLE.map((l) => ({
    catId: l.cats[0],
    label: l.label,
    spent: lineSpent(l, byCat),
    target: l.target,
  }));
  const donut = lineRows.filter((r) => r.spent > 0).map((r) => ({ catId: r.catId, amount: r.spent }));

  const debtFreeBy = payoffDate ? fmtMY(payoffDate) : "—";
  const monthsToGo = payoffDate
    ? Math.max(1, Math.round((payoffDate.getTime() - now.getTime()) / 2.592e9))
    : 0;

  // ── lens-filtered ledger (same predicate as OnePager `recent`/`ledgerTxns`) ──
  const visible = data.transactions
    .filter((tx) => !tx.appliesTo?.settled)
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
  const { entries } = monthlySchedule(data.recurring, monthKey, data.transactions);
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
  const recordedBill = (e: ScheduleEntry) =>
    e.recurringId
      ? data.transactions.find((t) => {
          if (t.type !== "expense" || t.appliesTo?.kind !== "bill") return false;
          if (t.appliesTo.recurringId !== e.recurringId || t.appliesTo.monthKey !== monthKey)
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

  const home: HomeVM = {
    firepower,
    overspent: overspend,
    debtFreeBy,
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
  const monthVisible = visible.filter((tx) => tx.date.slice(0, 7) === monthKey);
  const rows: ActivityRow[] = monthVisible.map((tx) => {
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
  const needsReview = monthVisible.filter((tx) => fateOf(tx).fate === "review").length;
  const activity: ActivityVM = {
    sinceMonday,
    needsReview,
    monthLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    counted: variableSpentThisMonth(visible, monthKey),
    rows,
  };

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

  return { home, insights, activity, profile, bills };
}
