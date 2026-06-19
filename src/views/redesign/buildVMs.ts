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
import { totalBalance, cashAccounts } from "../../lib/recurring";
import { monthlySchedule, type ScheduleEntry } from "../../lib/schedule";
import { ownAccounts, jointAccounts, type Lens } from "../../lib/lens";
import { merchantKey } from "../../lib/categorize";
import { OWNER_NAME, OWNER_COLOR, type Owner } from "../../lib/owner";
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
  return m ? `Card …${m[1]}` : n;
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

  // ── core plan math (identical to OnePager) ──
  const target = sumTargets(LEAN_VARIABLE);
  const math = planMath(data.recurring, data.debts, target);
  const ordered = orderedDebts(data.debts);
  const schedule = payoffSchedule(ordered, math.firepower, now, PAY_DAYS, SAVINGS_SPLIT);
  const next = schedule[0] ?? null;
  const payoffDate = schedule.length ? schedule[schedule.length - 1].date : null;
  const totalInterest = schedule.reduce((s, e) => s + e.interest, 0);
  const totalOriginal = data.debts.reduce((s, d) => s + d.originalBalance, 0);
  const cleared = totalOriginal - math.totalDebt;
  const clearedPct = totalOriginal > 0 ? (cleared / totalOriginal) * 100 : 0;
  const commit = commitmentProgress(now);
  const spent = variableSpentThisMonth(data.transactions, monthKey);
  const byCat = spentByCategory(data.transactions, monthKey);

  // ── cash (lens-aware) ──
  const totalCash = totalBalance(data.accounts);
  const jointCash = personal ? totalBalance(jointAccounts(data.accounts)) : 0;
  const cash = personal ? totalBalance(myAccounts) + jointCash : totalCash;
  const cashAcctCount = cashAccounts(personal ? myAccounts : data.accounts).length;

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
    if (date === todayKey) return "today";
    const d = new Date(date + "T00:00:00");
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dateKeyOf(d) === dateKeyOf(y)) return "yesterday";
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
  }));

  // ── "spent since Monday" ──
  const dow = now.getDay();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((dow + 6) % 7));
  const mondayKey = dateKeyOf(monday);
  const sinceMonday = data.transactions
    .filter((t) => t.type === "expense" && !t.appliesTo?.settled && t.date >= mondayKey)
    .reduce((s, t) => s + t.amount, 0);

  // ── simple anomaly count: a free-form charge > 2.5× its category's monthly mean ──
  const monthFree = data.transactions.filter(
    (t) => t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo,
  );
  const byCatAmts: Record<string, number[]> = {};
  monthFree.forEach((t) => (byCatAmts[t.categoryId] ??= []).push(t.amount));
  const anomalyCount = monthFree.filter((t) => {
    const arr = byCatAmts[t.categoryId];
    if (arr.length < 3 || t.amount <= 25) return false;
    const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
    return t.amount > 2.5 * mean;
  }).length;

  // ── bills + money calendar ──
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
  const todayNum = now.getDate();
  const { entries } = monthlySchedule(data.recurring, monthKey, data.transactions);
  const outEntries = entries.filter((e) => e.direction === "out");
  const recordedBill = (e: ScheduleEntry) =>
    e.recurringId
      ? data.transactions.find(
          (t) =>
            t.type === "expense" &&
            t.appliesTo?.kind === "bill" &&
            t.appliesTo.recurringId === e.recurringId &&
            t.appliesTo.monthKey === monthKey &&
            t.appliesTo.day === e.day,
        )
      : undefined;
  const isBillPaid = (e: ScheduleEntry) =>
    e.recurringId ? !!recordedBill(e) : Math.min(e.day, daysInMonth) <= todayNum;
  const recCatOf = (recId?: string) =>
    data.recurring.find((r) => r.id === recId)?.categoryId ?? "other";
  const relLabelOf = (day: number) => {
    if (day === todayNum) return "today";
    if (day === todayNum + 1) return "tomorrow";
    if (day < todayNum) return "overdue";
    return `in ${day - todayNum} days`;
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
  };

  const home: HomeVM = {
    firepower: math.firepower,
    debtFreeBy,
    nextAmount: next ? next.total : 0,
    nextDate: next ? fmtDay(next.date) : "—",
    cash,
    cashAccounts: cashAcctCount,
    debtLeft: math.totalDebt,
    debtProgressPct: clearedPct,
    budgetSpent: spent,
    budgetTarget: target,
    donut,
    anomalyCount,
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
    atDebt: math.firepower,
    debtFreeBy,
    monthsToGo,
    interest: totalInterest,
    ladder,
  };

  // ── Activity (this-month + recent rows, fate-badged) ──
  const fateOf = (tx: Transaction): { fate: ActivityFate; badge: string } => {
    if (tx.type === "income") return { fate: "income", badge: "Income · not in budget" };
    if (tx.appliesTo) {
      const k = tx.appliesTo.kind;
      return { fate: "skip", badge: `${k[0].toUpperCase()}${k.slice(1)} · not in budget` };
    }
    if (tx.categoryId === "other" || !hasRule(tx.description))
      return { fate: "review", badge: "Needs review" };
    return { fate: "envelope", badge: `→ ${envLabel(tx.categoryId)}` };
  };
  const rows: ActivityRow[] = visible.slice(0, 30).map((tx) => {
    const f = fateOf(tx);
    return {
      id: tx.id,
      merchant: tx.description || catName(tx.categoryId),
      catId: tx.categoryId,
      sub: relDay(tx.date),
      amount: tx.amount,
      fate: f.fate,
      badgeLabel: f.badge,
    };
  });
  const needsReview = visible.filter((tx) => fateOf(tx).fate === "review").length;
  const activity: ActivityVM = {
    sinceMonday,
    needsReview,
    monthLabel: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    counted: variableSpentThisMonth(visible, monthKey),
    rows,
  };

  // ── Profile ──
  const connected = data.accounts.filter((a) => a.providerAccountId).length;
  const linkedCards = data.debts
    .filter((d) => d.providerAccountId)
    .map((d) => (d.name.match(/…(\d{4})/) ? `…${d.name.match(/…(\d{4})/)![1]}` : d.name));
  const profile: ProfileVM = {
    ownerName: OWNER_NAME[owner],
    ownerColor: OWNER_COLOR[owner],
    email: extra.email,
    bankName: connected ? "Bank of America" : "Connect a bank",
    bankSub: connected ? `Connected · ${connected} accounts` : "Tap to connect",
    cardsSub: linkedCards.length
      ? `${linkedCards.join(" + ")} linked · auto-syncs`
      : "Track a card as debt",
    accounts: cashAccounts(data.accounts).map((a) => ({
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
        name: r.name,
        icon: /electric|srp/i.test(r.name) ? ("electric" as const) : ("phone" as const),
        est: `~$${billExpected(r, data.transactions).toFixed(2)} · est. from last 3`,
        on: true,
      })),
  };

  return { home, insights, activity, profile, bills };
}
