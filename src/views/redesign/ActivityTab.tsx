import { useState } from "react";
import { RefreshCw, Plus, ArrowDownLeft, HelpCircle } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type ActivityFate = "envelope" | "skip" | "review" | "income";

export interface ActivityRow {
  id: string;
  merchant: string;
  catId: string;
  sub?: string;
  amount: number; // positive; fate 'income' controls sign/color
  fate: ActivityFate;
  badgeLabel: string;
}

export interface ActivityVM {
  sinceMonday: number;
  needsReview: number;
  monthLabel: string;
  counted: number;
  rows: ActivityRow[];
}

interface ActivityTaps {
  onRow?: (id: string) => void;
  onRefresh?: () => void;
  onAdd?: () => void;
}

type FilterKey = "all" | "budget" | "review";

function FateBadge({ row }: { row: ActivityRow }) {
  const c = catColor(row.catId);
  if (row.fate === "envelope") {
    return (
      <span
        className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{ background: c + "26", color: c }}
      >
        {row.badgeLabel}
      </span>
    );
  }
  if (row.fate === "review") {
    return (
      <span
        className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{ background: "#2a2410", color: "#e3b341" }}
      >
        {row.badgeLabel}
      </span>
    );
  }
  // skip + income share the grey pill
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ background: "#1b2129", color: "#8b97a6" }}
    >
      {row.badgeLabel}
    </span>
  );
}

export function ActivityTab({
  vm,
  taps = {},
}: {
  vm: ActivityVM;
  taps?: ActivityTaps;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");

  const chip = (key: FilterKey, label: string, badge?: number) => {
    const active = filter === key;
    return (
      <button
        key={key}
        onClick={() => setFilter(key)}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] py-1.5 text-[12.5px] font-medium transition active:scale-[0.98]"
        style={{
          background: active ? "#0b0f17" : "transparent",
          color: active ? "#e6edf3" : "#8b97a6",
        }}
      >
        {label}
        {badge != null && badge > 0 && (
          <span
            className="rounded-full px-1.5 text-[10px] font-bold"
            style={{ background: "#e3b341", color: "#0b0f17" }}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="relative flex flex-col gap-0">
      {/* ── Gradient header ── */}
      <div
        style={{ background: BRAND_GRADIENT }}
        className="flex items-start justify-between rounded-b-[24px] px-6 py-4 text-white"
      >
        <div>
          <div className="text-[26px] font-bold leading-none tracking-tight">{t("Activity")}</div>
          <div className="mt-1.5 text-[12px] opacity-90">
            {t("spent {amount} since Monday", { amount: money(vm.sinceMonday) })}
          </div>
        </div>
        <button
          onClick={taps.onRefresh}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition active:scale-[0.97]"
          style={{
            background: "rgba(255,255,255,.2)",
            border: "1px solid rgba(255,255,255,.3)",
          }}
        >
          <RefreshCw size={14} /> {t("Refresh")}
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* ── Filter segmented bar ── */}
        <div
          className="flex gap-1 rounded-[13px] p-1"
          style={{ background: "#141a24", border: "1px solid #232d3a" }}
        >
          {chip("all", t("All"))}
          {chip("budget", t("In budget"))}
          {chip("review", t("Needs review"), vm.needsReview)}
        </div>

        {/* ── Month group ── */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[13.5px] font-semibold text-bone">{vm.monthLabel}</span>
            <span className="text-[12px] text-taupe">{t("{amount} counted", { amount: money(vm.counted) })}</span>
          </div>

          <div
            className="flex flex-col rounded-[16px] border"
            style={{ background: "#141a24", borderColor: "#232d3a" }}
          >
            {vm.rows.map((r, i) => {
              const income = r.fate === "income";
              const review = r.fate === "review";
              const c = income ? "#34c5e8" : catColor(r.catId);
              const Icon = income ? ArrowDownLeft : review ? HelpCircle : catIcon(r.catId);
              const chipBg = income ? "#0e2230" : review ? "#2a2410" : c + "26";
              const chipColor = income ? "#34c5e8" : review ? "#e3b341" : c;
              return (
                <button
                  key={r.id}
                  onClick={() => taps.onRow?.(r.id)}
                  className="flex items-center gap-3 p-4 text-left transition active:scale-[0.99]"
                  style={{
                    borderTop: i === 0 ? "none" : "1px solid #1c2530",
                  }}
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
                    style={{ background: chipBg, color: chipColor }}
                  >
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-bone">
                      {r.merchant}
                    </div>
                    <div className="mt-1">
                      <FateBadge row={r} />
                    </div>
                  </div>
                  <span
                    className="shrink-0 text-[13.5px] font-semibold"
                    style={{ color: income ? "#46d18a" : "#e6edf3" }}
                  >
                    {income ? "+" : "-"}
                    {money2(r.amount)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── FAB ── */}
      <button
        onClick={taps.onAdd}
        className="absolute bottom-[74px] right-[18px] flex h-[52px] w-[52px] items-center justify-center rounded-full text-white shadow-lg transition active:scale-[0.94]"
        style={{ background: BRAND_GRADIENT }}
      >
        <Plus size={24} />
      </button>
    </div>
  );
}
