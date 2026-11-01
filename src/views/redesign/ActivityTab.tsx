import { useState } from "react";
import { RefreshCw, Check, Plus, ArrowDownLeft, HelpCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { BRAND_GRADIENT, catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import { ReviewCard } from "./ReviewSheet";

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
  // Does the month's "$X counted" figure add this row up? The In budget filter lists
  // exactly these. Optional so a mock without it still compiles (falls back to fate).
  counted?: boolean;
  // Money IN (sign and colour), whatever the pill says — a transfer's incoming leg
  // reads "Transfer · not in budget" but is still a credit.
  credit?: boolean;
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
  // The household's Sun–Sat week, graded as finance.week grades it (Mine: the lens's rows).
  spentThisWeek: number;
  processing: number; // $ the bank is holding (current − available), already out of the balance
  // How many pending charges are listed, and whether they add up to the hold exactly
  // (then the card can say they are all in the list). Optional for mocks.
  processingCount?: number;
  processingItemized?: boolean;
  months: ActivityMonth[]; // newest first; [0] is this pay cycle, [1] the last one
}

interface ActivityTaps {
  onRow?: (id: string) => void;
  onRefresh?: () => void | Promise<void>;
  onAdd?: () => void;
  /** Open "Worth a look" — the review sheet. */
  onReview?: () => void;
  /** Open the searchable All-activity ledger. */
  onLedger?: () => void;
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
    // The label used to BE the category colour. Those hexes are mark colours —
    // chosen to read as a donut slice or a bar against the dark canvas — and
    // three of the seventeen fall under 4.5:1 as 10.5px text: transport 4.12,
    // interest 3.72, other 3.84. Lightening them for text would break the chart
    // contrast they were picked for, so the label takes ink and a dot carries
    // the colour. That fixes every category at once, including any added later,
    // and the pill keeps the tint it always had.
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
        style={{ background: c + "26", color: "#dbe4ec" }}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} />
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
        style={{ background: "#16241b", color: "#46d18a" }}
      >
        {row.badgeLabel}
      </span>
    );
  }
  // skip + income share the grey pill
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
      style={{ background: "#1b2129", color: "var(--color-taupe)" }}
    >
      {row.badgeLabel}
    </span>
  );
}

export function ActivityTab({
  vm,
  taps = {},
  reviewCount = 0,
}: {
  vm: ActivityVM;
  taps?: ActivityTaps;
  /**
   * How many things the review engine noticed about the bills and charges. This
   * tab is where the CHARGES are, which is what every suggestion is about, and it
   * is a tab you open on purpose — so the card lives here rather than on Home,
   * where it would be a fourth amber thing competing for the same glance.
   * Zero renders nothing at all.
   */
  reviewCount?: number;
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

  // The filter chips actually filter now: "In budget" = exactly the rows the
  // "$X counted" figure adds up (so the list sums to it), "Needs review" =
  // uncategorized, "All" = everything.
  const shown = m.rows.filter((r) =>
    filter === "all" ? true : filter === "budget" ? (r.counted ?? r.fate === "envelope") : r.fate === "review",
  );
  // An empty review filter points at the nearest older group that still has questions.
  const olderReviewIdx = filter === "review" ? months.findIndex((g, k) => k > idx && g.needsReview > 0) : -1;

  const chip = (key: FilterKey, label: string, badge?: number) => {
    const active = filter === key;
    return (
      <button
        key={key}
        onClick={() => setFilter(key)}
        className="h-hit flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-[10px] py-1.5 text-[12.5px] font-medium transition active:scale-[0.98]"
        // Raised, not sunken: the selected chip is lighter than its track (it was
        // #0b0f17 on #141a24 and read as a hole). The same active style as the top
        // bar and Profile's segmented controls.
        style={{
          background: active ? "#263142" : "transparent",
          color: active ? "#eef2f7" : "var(--color-taupe)",
          fontWeight: active ? 600 : 500,
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
          <div className="mt-1.5 text-[12px]">
            {t("spent {amount} this week", { amount: money(vm.spentThisWeek) })}
          </div>
        </div>
        <button
          onClick={doRefresh}
          disabled={refreshing}
          className="h-hit flex min-h-[40px] items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition active:scale-[0.97]"
          // DARKEN the gradient under the white label, as Home's over-budget pill
          // does: a white wash lightened it to 3.3:1, under AA at 12px. The green
          // "Updated" state is carried by the border alone.
          style={{
            background: "rgba(0,0,0,.18)",
            border: justRefreshed ? "1px solid rgba(70,209,138,.6)" : "1px solid rgba(255,255,255,.3)",
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

      <div className="flex flex-col gap-4 p-4 pb-24">
        {/* ── Worth a look — the review layer's one entry point ── */}
        {taps.onReview && <ReviewCard count={reviewCount} onOpen={taps.onReview} />}

        {/* ── Filter segmented bar ── */}
        <div
          className="flex gap-1 rounded-[13px] p-1"
          style={{ background: "#141a24", border: "1px solid #232d3a" }}
        >
          {chip("all", t("All"))}
          {chip("budget", t("In budget"))}
          {chip("review", t("Needs review"), m.needsReview)}
        </div>

        {/* ── still-processing notice. The bank sync now writes every pending charge
              as its own row, so when those rows add up to the hold the card says
              they are in the list (and already out of the balance). When they do
              not — the bank holding a lump it has not itemized yet — it keeps the
              "~" wording that says so. ── */}
        {vm.processing > 0 && (
          <div className="flex items-start gap-2.5 rounded-[13px] p-3" style={{ background: "#241f12", border: "1px solid #4a3f1c" }}>
            <span className="bump mt-0.5 text-[15px] leading-none" style={{ color: "#e3b341" }}>◌</span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold" style={{ color: "#e3b341" }}>
                {vm.processingItemized
                  ? vm.processingCount === 1
                    ? t("1 charge still processing · {amount}", { amount: money2(vm.processing) })
                    : t("{n} charges still processing · {amount}", {
                        n: vm.processingCount ?? 0,
                        amount: money2(vm.processing),
                      })
                  : t("~{amount} processing", { amount: money(vm.processing) })}
              </div>
              <div className="mt-0.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
                {vm.processingItemized
                  ? t("Each one is in the list as ◌ Processing and is already taken out of your balance. Amounts can still change until they post, usually 1–3 days.")
                  : t("Your bank holds these charges and itemizes each one when it posts (usually 1–3 days). They are already taken out of your balance.")}
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
                aria-label={t("Older")}
                className="h-hit rounded-md p-1 disabled:opacity-30"
                style={{ color: "var(--color-taupe)" }}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="min-w-[104px] text-center text-[13.5px] font-semibold text-bone">{m.monthLabel}</span>
              <button
                onClick={() => setMIdx((i) => Math.max(i - 1, 0))}
                disabled={idx <= 0}
                aria-label={t("Newer")}
                className="h-hit rounded-md p-1 disabled:opacity-30"
                style={{ color: "var(--color-taupe)" }}
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
              <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--color-faint)" }}>
                {filter === "review" ? t("Nothing to review here") : t("Nothing here yet.")}
                {olderReviewIdx > 0 && (
                  <button
                    onClick={() => setMIdx(olderReviewIdx)}
                    className="mt-2 block w-full text-center text-[12.5px] font-medium"
                    style={{ color: "#e3b341" }}
                  >
                    {t("{n} in {month}", {
                      n: months[olderReviewIdx].needsReview,
                      month: months[olderReviewIdx].monthLabel,
                    })}
                  </button>
                )}
              </div>
            )}
            {shown.map((r, i) => {
              const income = r.fate === "income" || !!r.credit;
              const review = r.fate === "review";
              const c = income ? "#34c5e8" : catColor(r.catId);
              const Icon = income ? ArrowDownLeft : review ? HelpCircle : catIcon(r.catId);
              const chipBg = income ? "#0e2230" : review ? "#e3b34126" : c + "26";
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
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
                    style={{ background: chipBg, color: chipColor }}
                  >
                    <Icon size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-bone">
                      {r.merchant}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <FateBadge row={r} />
                      {r.sub && (
                        <span className="text-[11px]" style={{ color: "var(--color-faint)" }}>
                          {r.sub}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className="shrink-0 text-[13.5px] font-semibold"
                    style={{ color: income ? "#46d18a" : "var(--color-bone)" }}
                  >
                    {income ? "+" : "−"}
                    {money2(r.amount)}
                  </span>
                </button>
              );
            })}
          </div>
          {/* The searchable, all-time ledger — reachable from here, not only from Home. */}
          {taps.onLedger && (
            <button
              onClick={taps.onLedger}
              className="h-hit mx-auto mt-2 block px-2 py-1 text-[12px] font-medium"
              style={{ color: "var(--color-taupe)" }}
            >
              {t("All activity · Search")}
            </button>
          )}
        </div>
      </div>

      {/* ── FAB — pinned to the viewport bottom (above the tab bar) so it never
            floats over the cards in the middle of the list ── */}
      <button
        onClick={taps.onAdd}
        aria-label={t("Add transaction")}
        className="fixed right-[18px] z-40 flex h-[52px] w-[52px] items-center justify-center rounded-full text-white shadow-lg transition active:scale-[0.94]"
        // The tab bar is 8px + 48px + max(12px, safe area) tall, so a fixed 74px sat
        // the bottom of this button over the bar on an installed iPhone (safe area
        // ~34px). Tied to the same safe-area term, it clears the bar by ~10px everywhere.
        style={{ background: BRAND_GRADIENT, bottom: "calc(max(12px, env(safe-area-inset-bottom)) + 66px)" }}
      >
        <Plus size={24} />
      </button>
    </div>
  );
}
