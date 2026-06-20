import { ChevronDown, CircleCheck, Flame } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon, conicFromSegments } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export interface InsightsVM {
  budgetSpent: number;
  budgetTarget: number;
  donut: { catId: string; amount: number }[];
  categories: { catId: string; label: string; spent: number; target: number }[];
  income: number;
  living: number;
  variable: number;
  atDebt: number;
  debtFreeBy: string;
  monthsToGo: number;
  interest: number;
  ladder: { rank: number; name: string; amount: number; live?: boolean; apr?: number; target?: boolean }[];
}

interface InsightsTaps {
  onCategory?: (catId: string) => void;
}

export function InsightsTab({ vm, taps = {} }: { vm: InsightsVM; taps?: InsightsTaps }) {
  const donutSegs = vm.donut.map((d) => ({ color: catColor(d.catId), value: d.amount }));
  const onTrack = vm.budgetSpent <= vm.budgetTarget;
  const leftInBudget = vm.budgetTarget - vm.budgetSpent;

  return (
    <div className="flex flex-col gap-0">
      {/* ── Gradient header ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="flex items-end justify-between rounded-b-[24px] px-6 py-4 text-white"
      >
        <div>
          <div className="text-[12px] opacity-90">{t("where the money goes")}</div>
          <div className="text-[26px] font-bold leading-none tracking-tight">{t("Insights")}</div>
        </div>
        <div className="flex items-center gap-1 pb-1 text-[13px] font-medium opacity-90">
          {t("June")} <ChevronDown size={15} />
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {/* ── Spending gauge ── */}
        <div
          className="flex items-center gap-4 rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="relative h-[120px] w-[120px] shrink-0">
            <div
              className="h-[120px] w-[120px] rounded-full"
              style={{ background: conicFromSegments(donutSegs) }}
            />
            <div
              className="absolute inset-[14px] flex flex-col items-center justify-center rounded-full"
              style={{ background: "#141a24" }}
            >
              <span className="text-[20px] font-bold text-bone">{money(vm.budgetSpent)}</span>
              <span className="text-[11px]" style={{ color: "#8b97a6" }}>
                {t("of {amount}", { amount: money(vm.budgetTarget) })}
              </span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="text-[10.5px] font-semibold uppercase"
              style={{ color: "#8b97a6", letterSpacing: "0.08em" }}
            >
              {t("Spent this month")}
            </div>
            <div
              className="mt-1.5 flex items-center gap-1.5 text-[15px] font-semibold"
              style={{ color: onTrack ? "#46d18a" : "#f0556e" }}
            >
              {onTrack && <CircleCheck size={16} />}
              {onTrack ? t("On track") : t("Over")}
            </div>
            <div className="mt-1 text-[12px]" style={{ color: "#8b97a6" }}>
              {t("{amount} left in the lean budget", { amount: money(leftInBudget) })}
            </div>
          </div>
        </div>

        {/* ── Plan vs actual ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div
            className="mb-3 text-[10.5px] font-semibold uppercase"
            style={{ color: "#8b97a6", letterSpacing: "0.08em" }}
          >
            {t("Lean budget · plan vs actual")}
          </div>
          <div className="flex flex-col gap-3.5">
            {vm.categories.map((c) => {
              const Icon = catIcon(c.catId);
              const color = catColor(c.catId);
              const over = c.spent > c.target;
              const pct = Math.min(100, (c.spent / c.target) * 100);
              return (
                <button
                  key={c.catId}
                  onClick={() => taps.onCategory?.(c.catId)}
                  className="w-full text-left transition active:scale-[0.99]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} style={{ color }} className="shrink-0" />
                    <span className="flex-1 text-[13px] font-medium text-bone">{c.label}</span>
                    <span className="text-[12.5px] font-semibold text-bone">
                      {money(c.spent)}{" "}
                      <span style={{ color: "#8b97a6" }}>/ {money(c.target)}</span>
                    </span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full"
                    style={{ background: "#222b38" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: over ? "#f0556e" : color }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Where every dollar goes ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div
            className="mb-3 text-[10.5px] font-semibold uppercase"
            style={{ color: "#8b97a6", letterSpacing: "0.08em" }}
          >
            {t("Where every dollar goes")}
          </div>
          <div className="flex h-[30px] overflow-hidden rounded-[8px]">
            <div
              className="flex items-center justify-center text-[10px] font-medium text-white"
              style={{ width: "45.9%", background: "#5b82b3" }}
            >
              {t("Living")}
            </div>
            <div
              className="flex items-center justify-center text-[10px] font-medium"
              style={{ width: "20.9%", background: "#e3b341", color: "#1a1407" }}
            >
              {t("Variable")}
            </div>
            <div
              className="flex items-center justify-center text-[10px] font-medium"
              style={{ width: "33.2%", background: "#34c5e8", color: "#06222b" }}
            >
              {t("Debt")}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            <Stat label={t("Income")} value={money(vm.income)} color="#46d18a" />
            <Stat label={t("Living")} value={money(vm.living)} color="#e6edf3" />
            <Stat label={t("Variable")} value={money(vm.variable)} color="#e6edf3" />
            <Stat label={t("At debt")} value={money(vm.atDebt)} color="#34c5e8" />
          </div>
        </div>

        {/* ── Debt-free ── */}
        <div
          className="flex items-end justify-between rounded-[18px] p-4 text-white"
          style={{ background: "linear-gradient(135deg,#5b21b6,#1d4ed8)" }}
        >
          <div>
            <div className="text-[11.5px] opacity-90">{t("debt-free")}</div>
            <div className="text-[26px] font-bold leading-none tracking-tight">{vm.debtFreeBy}</div>
            <div className="mt-1 text-[12px] opacity-90">{t("~{n} months to go", { n: vm.monthsToGo })}</div>
          </div>
          <div className="text-right">
            <div className="text-[11.5px] opacity-90">{t("interest you'll pay")}</div>
            <div className="text-[20px] font-bold">~{money(vm.interest)}</div>
          </div>
        </div>

        {/* ── Attack ladder ── */}
        <div
          className="rounded-[18px] border p-4"
          style={{ background: "#141a24", borderColor: "#232d3a" }}
        >
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-bone">
            <Flame size={16} style={{ color: "#fb923c" }} />
            {t("Attack ladder")}
            <span className="text-[12px] font-normal" style={{ color: "#8b97a6" }}>
              {t("· smallest first")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {vm.ladder.map((d) => {
              const hi = !!d.target;
              return (
                <div
                  key={d.rank}
                  className="flex items-center gap-3 rounded-[12px] border p-3"
                  style={{
                    background: hi ? "#0e2230" : "transparent",
                    borderColor: hi ? "#1d5066" : "#232d3a",
                  }}
                >
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                    style={{
                      background: hi ? "#34c5e826" : "#1a212c",
                      color: hi ? "#34c5e8" : "#6b7686",
                    }}
                  >
                    {d.rank}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-bone">{d.name}</span>
                    {d.apr != null && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#f0556e26", color: "#f0556e" }}
                      >
                        {d.apr}%
                      </span>
                    )}
                    {d.live && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ background: "#46d18a26", color: "#46d18a" }}
                      >
                        {t("live")}
                      </span>
                    )}
                  </div>
                  <span className="text-[13px] font-semibold text-bone">{money(d.amount)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="h-2" />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="text-[15px] font-bold" style={{ color }}>
        {value}
      </div>
      <div className="mt-0.5 text-[10.5px]" style={{ color: "#8b97a6" }}>
        {label}
      </div>
    </div>
  );
}

export const MOCK_INSIGHTS: InsightsVM = {
  budgetSpent: 719,
  budgetTarget: 1250,
  donut: [
    { catId: "groceries", amount: 392 },
    { catId: "transport", amount: 83 },
    { catId: "dining", amount: 84 },
    { catId: "shopping", amount: 40 },
    { catId: "health", amount: 30 },
    { catId: "other", amount: 90 },
  ],
  categories: [
    { catId: "groceries", label: "Groceries", spent: 392, target: 500 },
    { catId: "transport", label: "Gas + convenience", spent: 83, target: 250 },
    { catId: "dining", label: "Dining out", spent: 84, target: 150 },
    { catId: "shopping", label: "Household + hygiene", spent: 40, target: 90 },
    { catId: "health", label: "Health + grooming", spent: 30, target: 110 },
    { catId: "other", label: "Dog · car · subs", spent: 90, target: 150 },
  ],
  income: 5975,
  living: 2742,
  variable: 1250,
  atDebt: 1983,
  debtFreeBy: "Oct '26",
  monthsToGo: 4,
  interest: 248,
  ladder: [
    { rank: 1, name: "Affirm — Anthropic", amount: 99, target: true },
    { rank: 3, name: "Xinyan card …6813", amount: 591, live: true },
    { rank: 5, name: "Card …4728", amount: 4157, live: true, apr: 26.49 },
  ],
};
