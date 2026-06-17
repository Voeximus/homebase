import { useState } from "react";
import { ChevronDown, PieChart, Target } from "lucide-react";
import { useStore } from "../store/FinanceStore";
import { currentMonthKey, formatDate, formatMoney, monthLabel } from "../lib/format";
import {
  LEAN_VARIABLE,
  lineSpent,
  planMath,
  spentByCategory,
  sumTargets,
  variableSpentThisMonth,
} from "../lib/plan";
import { Card, EmptyState, ProgressBar } from "../components/ui";

export function Budget() {
  const { data } = useStore();
  const target = sumTargets(LEAN_VARIABLE);
  const spent = variableSpentThisMonth(data.transactions, currentMonthKey());
  const byCat = spentByCategory(data.transactions, currentMonthKey());
  const math = planMath(data.recurring, data.debts, target);
  const [open, setOpen] = useState<string | null>(null);
  const monthKey = currentMonthKey();
  const lineTxns = (cats: string[]) =>
    data.transactions
      .filter(
        (t) =>
          t.type === "expense" &&
          t.date.slice(0, 7) === monthKey &&
          !t.appliesTo &&
          cats.includes(t.categoryId),
      )
      .sort((a, b) => b.date.localeCompare(a.date));
  const pct = target > 0 ? (spent / target) * 100 : 0;
  const left = target - spent;
  const over = spent > target;

  if (math.income <= 0) {
    return (
      <div className="px-4 pt-4 lg:px-6">
        <Card>
          <EmptyState icon={<Target size={24} />} title="Set up your household first">
            Once your income and bills are loaded, your monthly budget lives here.
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 pt-4 lg:px-6">
      {/* Hero — the big number, front and center */}
      <div
        className="overflow-hidden rounded-3xl p-6 text-white shadow-lg"
        style={{
          backgroundImage:
            "linear-gradient(135deg, #1f2937 0%, #4c2dd6 90%, #7c5cff 160%)",
        }}
      >
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide opacity-80">
          <PieChart size={14} /> Budget · {monthLabel(currentMonthKey())}
        </div>
        <p className="mt-3 text-sm opacity-80">Spent this month</p>
        <p className="text-5xl font-bold tracking-tight sm:text-6xl">
          {formatMoney(spent)}
        </p>
        <p className="mt-1 text-sm opacity-90">
          of {formatMoney(target)} lean target
        </p>
        <div className="mt-4">
          <div className="h-3 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, Math.max(2, pct))}%`,
                backgroundColor: over ? "#fb7185" : "#34d399",
              }}
            />
          </div>
          <p className="mt-2 text-sm font-medium opacity-95">
            {over
              ? `${formatMoney(spent - target)} over target`
              : `${formatMoney(left)} left to spend`}
          </p>
        </div>
      </div>

      {/* What the lean budget frees for the debt */}
      <Card className="p-5">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-xs text-slate-400">Income</p>
            <p className="font-semibold text-emerald-400">{formatMoney(math.income)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Living + variable</p>
            <p className="font-semibold text-white">
              {formatMoney(math.fixedNonDebt + math.variable)}
            </p>
          </div>
          <div>
            <p className="text-xs text-violet-200">At the debt</p>
            <p className="font-semibold text-white">{formatMoney(math.firepower)}</p>
          </div>
        </div>
        <p className="mt-3 text-center text-[11px] text-slate-500">
          Holding the lean budget is what frees ~{formatMoney(math.firepower)}/mo to attack the debt.
        </p>
      </Card>

      {/* Per-category — spent vs target, with a bar each */}
      <Card className="p-5">
        <p className="text-sm font-semibold text-white">By category</p>
        <p className="text-xs text-slate-400">Spent vs budget · what's left in each</p>
        <div className="mt-4 space-y-3.5">
          {LEAN_VARIABLE.map((l) => {
            const sp = lineSpent(l, byCat);
            const pct = l.target > 0 ? (sp / l.target) * 100 : 0;
            const over = sp > l.target + 0.005;
            const remaining = l.target - sp;
            const isOpen = open === l.key;
            const txns = isOpen ? lineTxns(l.cats) : [];
            return (
              <div key={l.key}>
                <button
                  onClick={() => setOpen(isOpen ? null : l.key)}
                  className="w-full text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-lg">{l.icon}</span>
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                      {l.label}
                    </p>
                    <span className="text-sm font-semibold text-white">
                      {formatMoney(sp)}{" "}
                      <span className="font-medium text-slate-500">/ {formatMoney(l.target)}</span>
                    </span>
                    <ChevronDown
                      size={15}
                      className={`shrink-0 text-slate-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                  </div>
                  <div className="mt-1.5">
                    <ProgressBar value={pct} color={over ? "#fb7185" : "#34d399"} />
                  </div>
                  <p className={`mt-1 text-[11px] ${over ? "text-rose-300" : "text-slate-500"}`}>
                    {over
                      ? `${formatMoney(sp - l.target)} over budget`
                      : `${formatMoney(remaining)} left`}
                  </p>
                </button>
                {isOpen && (
                  <div className="mt-2 space-y-1 rounded-xl bg-black/20 px-3 py-2">
                    {txns.length === 0 ? (
                      <p className="py-1 text-center text-[11px] text-slate-500">
                        Nothing logged here this month yet.
                      </p>
                    ) : (
                      txns.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-2 border-b border-white/[0.04] py-1.5 last:border-0"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-xs text-white">{t.description}</p>
                            <p className="text-[10px] text-slate-500">{formatDate(t.date)}</p>
                          </div>
                          <span className="shrink-0 text-xs font-medium text-white">
                            {formatMoney(t.amount)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
          <span className="text-sm text-slate-300">Total budget / month</span>
          <span className="font-bold text-white">{formatMoney(target)}</span>
        </div>
      </Card>

      <p className="px-2 pb-2 text-center text-[11px] text-slate-500">
        Spending fills in as you log purchases or import a statement.
      </p>
    </div>
  );
}
