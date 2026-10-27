// Activity — reference-html/06-activity.html.
//
// The summary is the household's WEEK (Sunday–Saturday, src/lib/weekPlan.ts), the
// same week "Left this week" on Home and both Muses read, so the three never
// disagree. The list is every transaction, household-wide like every other figure
// on the Aurora screens, grouped by day.

import { useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { AuroraBackground, IconButton, ListRow, MiniBars, useKeptScroll } from "./components";
import { Icon } from "./icons";
import { iconFor } from "./adapt";
import { sayChange } from "./say";
import { addDays, longDate, money2 } from "./logic";

export interface ActivityItem {
  id: string;
  date: string;
  merchant: string;
  catId: string;
  /** The row's second line: its budget verdict ("Groceries", "Bill · not in budget"),
   *  already translated. */
  sub: string;
  /** A charge the app has no category for yet — its sub-line is shown in amber. */
  review: boolean;
  /** Signed: money in positive, money out negative. */
  amount: number;
  pending: boolean;
}

export interface ActivityScreenVM {
  today: string;
  week: { spent: number; changeLabel: string | null; lessThanLast: boolean; byDay: number[]; todayIndex: number };
  items: ActivityItem[];
  reviewCount: number;
}

type Filter = "all" | "in" | "out";
const PAGE_DAYS = 30;
const signed = (n: number) => (n > 0 ? `+${money2(n)}` : money2(n));

// The list's filter and how far back it reaches survive leaving the tab, so the
// scroll position the tab restores still points into the same list.
const STATE_KEY = "au-activity-state";
interface ListState {
  filter: Filter;
  pages: number;
  reviewOnly: boolean;
}
function loadState(): ListState {
  try {
    const s = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}");
    return {
      filter: s.filter === "in" || s.filter === "out" ? s.filter : "all",
      pages: Number.isInteger(s.pages) && s.pages > 0 ? s.pages : 1,
      reviewOnly: s.reviewOnly === true,
    };
  } catch {
    return { filter: "all", pages: 1, reviewOnly: false };
  }
}
function saveState(s: ListState) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function ActivityScreen({
  vm,
  taps,
}: {
  vm: ActivityScreenVM;
  taps: {
    onWeek: () => void;
    onRow: (id: string) => void;
    onReview: () => void;
    onAdd: () => void;
    /** Ask the bank for anything new (the old Activity's Refresh). */
    onRefresh: () => Promise<void>;
  };
}) {
  const scroll = useKeptScroll("activity");
  const [initial] = useState(loadState);
  const [filter, setFilterState] = useState<Filter>(initial.filter);
  const [pages, setPagesState] = useState(initial.pages);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  // The old Activity's "Needs review" filter: only the charges with no category yet,
  // from any date (an old one would otherwise sit behind "Show earlier" unseen).
  const [reviewOnly, setReviewOnlyState] = useState(initial.reviewOnly);
  const setReviewOnly = (on: boolean) => {
    setReviewOnlyState(on);
    saveState({ filter, pages, reviewOnly: on });
  };
  const needCategory = useMemo(() => vm.items.filter((r) => r.review).length, [vm.items]);
  const setFilter = (f: Filter) => {
    setFilterState(f);
    saveState({ filter: f, pages, reviewOnly });
  };
  const morePages = () => {
    setPagesState(pages + 1);
    saveState({ filter, pages: pages + 1, reviewOnly });
  };
  const refresh = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await taps.onRefresh();
    } finally {
      setSyncing(false);
    }
  };

  const since = addDays(vm.today, -PAGE_DAYS * pages);
  const { groups, hasOlder } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const inFilter = vm.items.filter((r) =>
      reviewOnly ? r.review : !(filter === "in" && r.amount <= 0) && !(filter === "out" && r.amount >= 0),
    );
    const rows = inFilter.filter((r) => {
      if (needle) {
        const shown = r.pending ? t("Pending") : r.sub;
        const hay = `${r.merchant} ${shown} ${r.sub} ${Math.abs(r.amount).toFixed(2)}`.toLowerCase();
        return hay.includes(needle);
      }
      return reviewOnly || r.date >= since;
    });
    const byDate = new Map<string, ActivityItem[]>();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r);
    }
    return {
      groups: [...byDate.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, list]) => ({ date, list, net: list.reduce((s, r) => s + r.amount, 0) })),
      // Over the FILTERED rows: "Show earlier" only appears when it would show more.
      hasOlder: !needle && !reviewOnly && inFilter.some((r) => r.date < since),
    };
  }, [vm.items, filter, q, since, reviewOnly]);

  const thisYear = Number(vm.today.slice(0, 4));
  const yesterday = addDays(vm.today, -1);
  const dayLabel = (d: string) => (d === vm.today ? t("Today") : d === yesterday ? t("Yesterday") : longDate(d, thisYear));

  return (
    <>
      <AuroraBackground preset="activity" />
      <div className="au-scroll" ref={scroll}>
        <main className="au-main">
          <header className="au-header">
            {searching ? (
              <>
                <input
                  className="au-search"
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t("Search transactions")}
                  aria-label={t("Search transactions")}
                />
                <button
                  className="au-link"
                  style={{ fontSize: 15, color: "var(--au-color-text)", margin: 0, minWidth: 44, justifyContent: "center" }}
                  onClick={() => {
                    setSearching(false);
                    setQ("");
                  }}
                >
                  {t("Cancel")}
                </button>
              </>
            ) : (
              <>
                <h1 className="au-title" tabIndex={-1} data-au-focus="">
                  {t("Activity")}
                </h1>
                <span style={{ display: "flex", gap: 8 }}>
                  <button
                    className="au-iconbtn"
                    aria-label={syncing ? t("Refreshing…") : t("Refresh")}
                    aria-busy={syncing}
                    onClick={() => void refresh()}
                  >
                    <span className={syncing ? "au-spin" : undefined} style={{ display: "flex" }}>
                      <Icon name="refresh" size={18} />
                    </span>
                  </button>
                  <IconButton icon="plus" label={t("Add a transaction")} onClick={taps.onAdd} />
                  <IconButton icon="search" label={t("Search transactions")} onClick={() => setSearching(true)} />
                </span>
              </>
            )}
          </header>

          <button
            className="au-glass au-summary"
            onClick={taps.onWeek}
            aria-label={`${t("Spent this week")}, ${money2(vm.week.spent)}. ${sayChange(vm.week.changeLabel) ?? ""}`}
          >
            <span className="au-summary-col">
              <span className="au-stat-label">{t("Spent this week")}</span>
              <span className="au-stat-lg">{money2(vm.week.spent)}</span>
              <span
                style={{
                  fontSize: 13,
                  color: vm.week.changeLabel
                    ? vm.week.lessThanLast
                      ? "var(--au-color-teal-text)"
                      : "var(--au-color-rose-text)"
                    : "var(--au-color-text-3)",
                }}
              >
                {vm.week.spent === 0 ? t("Nothing spent yet this week") : (sayChange(vm.week.changeLabel) ?? t("First week on the plan"))}
              </span>
            </span>
            <MiniBars byDay={vm.week.byDay} todayIndex={vm.week.todayIndex} />
          </button>

          {vm.reviewCount > 0 && (
            <button className="au-glass au-tip" style={{ marginTop: 12, width: "100%" }} onClick={taps.onReview}>
              <span className="au-tip-disc" aria-hidden="true" style={{ background: "rgba(255,122,182,0.14)", color: "#FF9CC8" }}>
                <Icon name="sparkle" size={18} />
              </span>
              <span className="au-tip-body">
                <span className="au-tip-title">{t("Worth a look")}</span>
                <span className="au-tip-text">
                  {vm.reviewCount === 1 ? t("1 thing the app noticed") : t("{n} things the app noticed", { n: vm.reviewCount })}
                </span>
              </span>
              <Icon name="chevron-right" size={18} />
            </button>
          )}

          {(needCategory > 0 || reviewOnly) && (
            <button
              className="au-glass au-tip"
              style={{ marginTop: 12, width: "100%" }}
              onClick={() => setReviewOnly(!reviewOnly)}
              aria-pressed={reviewOnly}
            >
              <span className="au-tip-disc" aria-hidden="true" style={{ background: "rgba(255,196,107,0.14)", color: "#FFC46B" }}>
                <Icon name={reviewOnly ? "close" : "sparkle"} size={18} />
              </span>
              <span className="au-tip-body">
                <span className="au-tip-title">{t("Needs a category")}</span>
                <span className="au-tip-text">
                  {reviewOnly
                    ? t("Show everything")
                    : needCategory === 1
                      ? t("1 needs a category")
                      : t("{n} need a category", { n: needCategory })}
                </span>
              </span>
              {!reviewOnly && <Icon name="chevron-right" size={18} />}
            </button>
          )}

          <div className="au-seg" role="group" aria-label={t("Filter")} style={{ marginTop: 14 }}>
            {(
              [
                ["all", "All"],
                ["in", "Money in"],
                ["out", "Money out"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {t(label)}
              </button>
            ))}
          </div>

          {vm.items.length === 0 ? (
            <p className="au-empty">{t("Transactions show up here once your account syncs")}</p>
          ) : groups.length === 0 ? (
            <p className="au-empty">
              {q
                ? t("Nothing matches that search")
                : reviewOnly
                  ? t("Nothing needs a category")
                  : t("Nothing here in the last {n} days", { n: PAGE_DAYS * pages })}
            </p>
          ) : (
            groups.map((g, gi) => (
              <section key={g.date} className="au-group" style={{ marginTop: gi === 0 ? 18 : 14 }} aria-label={dayLabel(g.date)}>
                <div className="au-group-head">
                  <h2 className="au-group-day">{dayLabel(g.date)}</h2>
                  <span className="au-group-net">{signed(g.net)}</span>
                </div>
                <ul className="au-glass au-list au-list--rows">
                  {g.list.map((r) => {
                    const income = r.amount > 0;
                    const sub = r.pending ? t("Pending") : r.sub;
                    return (
                      <ListRow
                        key={r.id}
                        tall
                        disc={iconFor(r.catId, r.merchant, income)}
                        title={r.merchant}
                        sub={sub}
                        subTone={r.pending || r.review ? "amber" : undefined}
                        amount={signed(r.amount)}
                        amountTone={income ? "teal" : undefined}
                        dim={r.pending}
                        onClick={() => taps.onRow(r.id)}
                        label={`${r.merchant}, ${sub}, ${signed(r.amount)}`}
                      />
                    );
                  })}
                </ul>
              </section>
            ))
          )}

          {hasOlder && (
            <button className="au-btn au-btn--ghost" style={{ marginTop: 18, alignSelf: "center" }} onClick={morePages}>
              {t("Show earlier")}
            </button>
          )}
        </main>
      </div>
    </>
  );
}
