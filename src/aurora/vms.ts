// One build for every Aurora screen, from the store's data and the view-models the
// app already computes (buildFinanceVMs). Screens render what this returns and do
// no arithmetic of their own — the same contract the older tabs kept.

import type { AppData, Transaction } from "../types";
import type { FinanceVMs } from "../views/redesign/buildVMs";
import type { ActivityFate } from "../views/redesign/ActivityTab";
import { LEAN_VARIABLE, isOpenDebt, orderedDebts } from "../lib/plan";
import { t } from "../lib/i18n";
import { auroraInputs, CATEGORY_PALETTE, debtPaymentsBetween, FORECAST_DAYS, greeting, LINE_SHORT, sendDate, thisWeek } from "./adapt";
import { buildForecast, localISO, monthInsights, statusPill } from "./logic";
import type { HomeScreenVM } from "./HomeScreen";
import type { ActivityItem, ActivityScreenVM } from "./ActivityScreen";
import type { GoalsScreenVM } from "./GoalsScreen";
import type { InsightsScreenVM } from "./InsightsScreen";

export interface AuroraVMs {
  home: HomeScreenVM;
  activity: ActivityScreenVM;
  goals: GoalsScreenVM;
  insights: InsightsScreenVM;
}

/** "Oct 15 – Oct 30" → "Oct 15 – 30": the screen title is 30px beside a back
 *  button and "Day 12 of 16", and the repeated month is what does not fit. */
export function compactRange(label: string): string {
  const m = label.match(/^(\w+) (\d+) – (\w+) (\d+)$/);
  return m && m[1] === m[3] ? `${m[1]} ${m[2]} – ${m[4]}` : label;
}

/** "Credit card (…4728)" → "Card …4728"; "Cherry (dental)" → "Cherry". For chips. */
export function shortDebtName(name: string): string {
  const last4 = name.match(/…(\d{4})/)?.[1];
  if (/^credit card/i.test(name) && last4) return t("Card …{n}", { n: last4 });
  return name.replace(/\s*\(.*\)\s*$/, "").trim() || name;
}

export function buildAuroraVMs(
  data: AppData,
  vms: FinanceVMs,
  visible: Transaction[],
  now: Date,
  extra: { reviewCount: number; notices: HomeScreenVM["notices"] },
): AuroraVMs {
  const today = localISO(now);
  const inputs = auroraInputs(data, now);
  const forecast = buildForecast({
    today,
    balance: inputs.balance,
    days: FORECAST_DAYS,
    recurring: [],
    scheduled: inputs.scheduled,
    discretionaryPerDay: inputs.discretionaryPerDay,
  });
  const week = thisWeek(data, today);

  const home: HomeScreenVM = {
    greeting: greeting(now),
    balance: inputs.balance,
    pill: statusPill(forecast, inputs.cushion),
    forecast,
    today,
    payday: inputs.payday,
    week: { plan: week.plan, left: week.left, over: week.over, daysLeft: week.daysLeft },
    comingUp: inputs.upcomingBills.slice(0, 2).map((b) => ({
      id: b.id,
      name: b.name,
      date: b.date,
      amount: b.amount,
      catId: b.catId,
      overdue: b.overdue,
      onCard: b.onCard,
      recurringId: b.recurringId,
      day: b.day,
      monthKey: b.monthKey,
      variable: b.variable,
    })),
    notices: extra.notices,
  };

  // Each row's budget verdict ("→ Groceries", "Bill · not in budget", "Needs review"),
  // read from the Activity view-model rather than worked out again.
  const fateOf = new Map<string, { fate: ActivityFate; badge: string }>();
  for (const month of vms.activity.months)
    for (const r of month.rows) if (!fateOf.has(r.id)) fateOf.set(r.id, { fate: r.fate, badge: r.badgeLabel });
  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? id;
  const items: ActivityItem[] = visible.map((tx) => {
    const f = fateOf.get(tx.id);
    const name = tx.type === "income" ? t("Income") : t(catName(tx.categoryId));
    return {
      id: tx.id,
      date: tx.date,
      merchant: tx.description || name,
      catId: tx.categoryId,
      // The badge already went through t(); "→ Groceries" reads as plain "Groceries".
      // "→ {label}" keeps its English line label in Chinese; translate the label itself.
      sub: f ? (f.fate === "envelope" ? t(f.badge.replace(/^→\s*/, "")) : f.badge) : name,
      review: f?.fate === "review",
      amount: tx.type === "income" ? tx.amount : -tx.amount,
      pending: !!tx.pending,
    };
  });
  const activity: ActivityScreenVM = {
    today,
    week: { spent: week.spent, changeLabel: week.changeLabel, lessThanLast: week.lessThanLast, byDay: week.byDay, todayIndex: week.todayIndex },
    items,
    reviewCount: extra.reviewCount,
  };

  // Goals = the open debts, in the plan's attack order, coloured in palette order.
  const open = orderedDebts(data.debts).filter(isOpenDebt);
  const clears = new Map<string, string>();
  for (const ev of vms.deploy.schedule)
    for (const p of ev.payments) if (p.clears && !clears.has(p.debtId)) clears.set(p.debtId, sendDate(ev.date));
  const colourOf = new Map(open.map((d, i) => [d.id, CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]]));
  const nextEv = vms.deploy.schedule.find((ev) => sendDate(ev.date) >= today && ev.total > 0) ?? null;
  const goals: GoalsScreenVM = {
    today,
    debtLeft: open.reduce((s, d) => s + d.balance, 0),
    // Money that went at the debts over the calendar month the line names.
    paidThisMonth: debtPaymentsBetween(data, `${today.slice(0, 7)}-01`, today),
    debts: open.map((d) => ({
      id: d.id,
      name: d.name,
      balance: d.balance,
      original: Math.max(d.originalBalance, d.balance),
      colour: colourOf.get(d.id)!,
      clearsOn: clears.get(d.id) ?? null,
    })),
    next: nextEv
      ? {
          date: sendDate(nextEv.date),
          total: nextEv.total,
          chips: [
            ...nextEv.payments.map((p) => {
              // Short names drop the "(…4728)" part; two debts that would then read the
              // same keep their full names, so no two chips are indistinguishable.
              const short = shortDebtName(p.name);
              const clash = nextEv.payments.some((q) => q.debtId !== p.debtId && shortDebtName(q.name) === short);
              return { key: p.debtId, label: clash ? p.name : short, amount: p.amount, colour: colourOf.get(p.debtId) ?? CATEGORY_PALETTE[5] };
            }),
            ...(nextEv.toSavings > 0 ? [{ key: "savings", label: t("Savings"), amount: nextEv.toSavings, colour: "#3BE0CF" }] : []),
          ],
        }
      : null,
  };

  // Insights = the pay cycle's six budget lines, read from the budget's own
  // view-model and never recomputed: the lines carry their cents (rounding is the
  // screen's, for display), and the ring's total and "left" are the budget's own
  // totals, so the ring cannot disagree with the bars by a rounding dollar.
  const ins = vms.insights;
  const cats = LEAN_VARIABLE.map((l, i) => {
    const row = ins.categories.find((c) => c.catId === l.cats[0]);
    return {
      key: l.key,
      name: LINE_SHORT[l.key] ?? l.label,
      spent: row?.spent ?? 0,
      plan: row?.target ?? 0,
      colour: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
    };
  });
  const m = monthInsights(
    { categories: cats.map((c) => ({ id: c.key, name: c.name, plan: c.plan, spent: c.spent })) },
    today,
    { day: ins.budgetCycleDay, days: ins.budgetCycleDays },
  );
  const insights: InsightsScreenVM = {
    title: compactRange(ins.budgetCycleLabel),
    day: ins.budgetCycleDay,
    days: ins.budgetCycleDays,
    cats,
    totalPlan: ins.budgetTarget,
    totalSpent: ins.budgetSpent,
    insight: m.insight,
    insightKey: m.insight ? (cats.find((c) => c.name === m.insight!.category)?.key ?? null) : null,
  };

  return { home, activity, goals, insights };
}
