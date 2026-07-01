import { useState } from "react";
import { RefreshCw, Check, Plus, ArrowDownLeft, HelpCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type ActivityFate = "envelope" | "skip" | "review" | "income" | "setaside";

export interface ActivityRow {
  id: string;
  merchant: string;
  catId: string;
  sub?: string;
  amount: number; // positive; fate 'income' controls sign/color
  fate: ActivityFate;
  badgeLabel: string;
  pending?: boolean; // still-processing bank charge
}

// One month's worth of activity — the tab flips through these (newest first).
export interface ActivityMonth {
  monthKey: string; // "2026-06"
  monthLabel: string; // "June 2026"
  rows: ActivityRow[];
  counted: number; // variable spend counted this month
  needsReview: number; // uncategorized charges in this month
}

export interface ActivityVM {
  sinceMonday: number;
  processing: number; // $ held at the bank but not yet itemized (BoA posts later)
  months: ActivityMonth[]; // newest first; [0] is the current month
}

interface ActivityTaps {
  onRow?: (id: string) => void;
  onRefresh?: () => void | Promise<void>;
  onAdd?: () => void;
}

type FilterKey = "all" | "budget" | "review";

function FateBadge({ row }: { row: ActivityRow }) {
  const c = catColor(row.catId);
  // a still-processing bank charge — a pulsing amber "Processing" pill
  if (row.pending) {
    return (
      <span
        className="bump rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
        style={{ background: "#2a2410", color: "#e3b341" }}
      >
        ◌ {row.badgeLabel}
      </span>
    );
  }
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
  // set aside — soft green (owed back to you reads as money returning)
  if (row.fate === "setaside") {
    return (
      <span
        className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{ background: "#16241b", color: "#7fbf6a" }}
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
  const [refreshing, setRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [mIdx, setMIdx] = useState(0); // 0 = current month; higher = older

  const months = vm.months.length ? vm.months : [{ monthKey: "", monthLabel: "", rows: [], counted: 0, needsReview: 0 }];
  const idx = Math.min(mIdx, months.length - 1);
  const m = months[idx];

  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await taps.onRefresh?.();
    } finally {
      setRefreshing(false);
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 2200);
    }
  };

  // The filter chips actually filter now: "In budget" = counted living spend,
  // "Needs review" = uncategorized, "All" = everything.
  const shown = m.rows.filter((r) =>
    filter === "all" ? true : filter === "budget" ? r.fate === "envelope" : r.fate === "review",
  );

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
          onClick={doRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition active:scale-[0.97]"
          style={{
            background: justRefreshed ? "rgba(70,209,138,.25)" : "rgba(255,255,255,.2)",
            border: justRefreshed ? "1px solid rgba(70,209,138,.5)" : "1px solid rgba(255,255,255,.3)",
          }}
        >
          {justRefreshed ? (
            <>
              <Check size={14} /> {t("Updated")}
            </>
          ) : (
            <>
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />{" "}
              {refreshing ? t("Refreshing…") : t("Refresh")}
            </>
          )}
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
          {chip("review", t("Needs review"), m.needsReview)}
        </div>

        {/* ── still-processing notice — BoA holds pending charges as a lump and
              only itemizes each one when it posts, so explain where they are ── */}
        {vm.processing > 0 && (
          <div className="flex items-start gap-2.5 rounded-[13px] p-3" style={{ background: "#241f12", border: "1px solid #4a3f1c" }}>
            <span className="bump mt-0.5 text-[15px] leading-none" style={{ color: "#e3b341" }}>◌</span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold" style={{ color: "#e3b341" }}>
                {t("~{amount} processing", { amount: money(vm.processing) })}
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: "#9aa6b2" }}>
                {t("Your bank holds these charges and itemizes each one when it posts (usually 1–3 days). They'll appear + notify you the moment they clear.")}
              </div>
            </div>
          </div>
        )}

        {/* ── Month group (flippable: browse prior months) ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setMIdx((i) => Math.min(i + 1, months.length - 1))}
                disabled={idx >= months.length - 1}
                aria-label={t("Previous month")}
                className="rounded-md p-1 disabled:opacity-30"
                style={{ color: "#9aa6b2" }}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="min-w-[104px] text-center text-[13.5px] font-semibold text-bone">{m.monthLabel}</span>
              <button
                onClick={() => setMIdx((i) => Math.max(i - 1, 0))}
                disabled={idx <= 0}
                aria-label={t("Next month")}
                className="rounded-md p-1 disabled:opacity-30"
                style={{ color: "#9aa6b2" }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <span className="text-[12px] text-taupe">{t("{amount} counted", { amount: money(m.counted) })}</span>
          </div>

          <div
            className="flex flex-col rounded-[16px] border"
            style={{ background: "#141a24", borderColor: "#232d3a" }}
          >
            {shown.length === 0 && (
              <p className="px-4 py-8 text-center text-[13px]" style={{ color: "#7e8a98" }}>
                {t("Nothing here yet.")}
              </p>
            )}
            {shown.map((r, i) => {
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
