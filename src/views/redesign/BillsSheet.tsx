import { useState } from "react";
import { Receipt, X, CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import { catColor, catIcon } from "../../lib/catColor";
import { dueOn, type MonthCalendar, type MonthCalBill } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";
import { billsBeforeNextPayday } from "../../lib/headline";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// A bill on the sheet. `due` is its resolved calendar date ("2026-11-01") when the row
// came from the before-payday window, which can reach into next month — the same
// recurringId@day id repeats across months, so the date is part of its key, and it is
// the month the payment must be filed under.
type SheetBill = MonthCalBill & { due?: string };

// One bill line inside a container. Unpaid rows are tappable → pay; paid rows are
// static and show WHEN they were paid (which can be a prior month for an early
// payment). Amount is the actual paid figure when paid, the expected one when not.
function BillLine({ b, onPay }: { b: MonthCalBill; onPay?: (b: MonthCalBill) => void }) {
  const Icon = catIcon(b.catId);
  const col = catColor(b.catId);
  const inner = (
    <div className="flex w-full items-center gap-2.5 px-2.5 py-2">
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: col + "26", color: col }}
      >
        <Icon size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate text-[13px]"
          style={{ color: b.paid ? "var(--color-faint)" : "var(--color-bone)" }}
        >
          {b.name}
        </span>
        <span className="text-[11px]" style={{ color: b.paid ? "#6b9e83" : "var(--color-faint)" }}>
          {b.paid ? t("paid {date}", { date: b.paidDate ?? "" }) : t("due {date}", { date: b.dateLabel })}
        </span>
      </span>
      <span className="text-[13px] font-semibold" style={{ color: b.paid ? "var(--color-faint)" : "var(--color-bone)" }}>
        {b.variable && !b.paid ? "~" : ""}
        {money2(b.amount)}
      </span>
    </div>
  );
  return !b.paid && onPay ? (
    <button onClick={() => onPay(b)} className="w-full text-left" style={{ borderTop: "1px solid #141b24" }}>
      {inner}
    </button>
  ) : (
    <div style={{ borderTop: "1px solid #141b24" }}>{inner}</div>
  );
}

// A collapsible group. Header shows the count + total upfront; the bills only list
// out once you open it — so the sheet stays a glance, not a wall.
function BillContainer({
  title,
  accent,
  bills,
  open,
  onToggle,
  onPay,
}: {
  title: string;
  accent: string;
  bills: SheetBill[];
  open: boolean;
  onToggle: () => void;
  onPay?: (b: SheetBill) => void;
}) {
  const total = bills.reduce((s, b) => s + b.amount, 0);
  return (
    <div className="mb-2 overflow-hidden rounded-xl" style={{ border: "1px solid #1b232e" }}>
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-3" style={{ background: "#131a23" }}>
        {open ? (
          <ChevronDown size={16} style={{ color: "var(--color-taupe)" }} />
        ) : (
          <ChevronRight size={16} style={{ color: "var(--color-taupe)" }} />
        )}
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="flex-1 text-left text-[13.5px] font-semibold text-bone">{title}</span>
        <span
          className="rounded-full px-1.5 text-[11px] font-semibold"
          style={{ background: "#1b232e", color: "var(--color-taupe)" }}
        >
          {bills.length}
        </span>
        <span className="text-[13px] font-semibold text-bone">{money0(total)}</span>
      </button>
      {open &&
        (bills.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px]" style={{ color: "var(--color-faint)" }}>
            {t("Nothing here this month.")}
          </p>
        ) : (
          <div>
            {bills.map((b) => (
              <BillLine key={`${b.due ?? ""}|${b.id}`} b={b} onPay={onPay} />
            ))}
          </div>
        ))}
    </div>
  );
}

// The Bills surface: two collapsed containers (unpaid/posting + paid) so you get
// the counts + totals at a glance, expanding either to see the bills. A flippable
// month calendar is one tap away. Self-contained bento overlay.
export function BillsSheet({
  open,
  onClose,
  onPay,
  getMonth,
  baseDate,
}: {
  open: boolean;
  onClose: () => void;
  onPay?: (b: SheetBill) => void;
  getMonth: (year: number, month: number) => MonthCalendar;
  baseDate?: Date;
}) {
  const [showCal, setShowCal] = useState(false);
  const [openUnpaid, setOpenUnpaid] = useState(false);
  const [openPaid, setOpenPaid] = useState(false);
  if (!open) return null;
  const base = baseDate ?? new Date();

  // The list below stays CALENDAR-MONTHLY on purpose — rent really is due on the
  // 1st, and that decision is why bills didn't move to pay cycles with the budget.
  // What the cycle answers here is a different question: of the check that's
  // already landed, how much is still spoken for before the next one arrives.
  //
  // ONE call. The four arguments dueBeforeNextPayday needs — every month the window
  // touches, today, the cycle's end, the cycle's start — were assembled right here,
  // and three of the four are the kind of thing that fails quietly (a window opening
  // at today instead of the cycle start silently drops the overdue rows; a window
  // that crosses a month end under-reports unless both months are handed over). The
  // Muse read door answers this same question, so the assembly moved to
  // src/lib/headline.ts and both callers run it. Same numbers on this sheet as
  // before — and `month` below is the very calendar the total was computed from, so
  // the list and the figure above it can never come from two different builds of it.
  const { month: mc, cycle, daysLeft, ...beforePayday } = billsBeforeNextPayday(getMonth, base);
  // "Unpaid · posting" lists the bills the figure above it adds up — the window's,
  // which crosses into next month at a month end (rent on the 1st) — plus any of this
  // month's unpaid bills outside it, so nothing unpaid this month disappears. It used
  // to list this calendar month alone: at every month end, a real "still due" figure
  // over an empty "Unpaid · 0".
  const seen = new Set(beforePayday.bills.map((b) => `${b.due}|${b.id}`));
  const unpaid: SheetBill[] = [
    ...beforePayday.bills,
    ...mc.bills
      .filter((b) => !b.paid)
      .map((b) => ({ ...b, due: dueOn(mc, b) }))
      .filter((b) => !seen.has(`${b.due}|${b.id}`)),
  ].sort((a, b) => a.due.localeCompare(b.due));
  const paid = mc.bills.filter((b) => b.paid);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto"
        style={{
          background: "#0f141c",
          border: "1px solid #232d3a",
          borderTop: "2px solid #fb923c",
          borderRadius: "22px",
          padding: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3.5 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
            style={{ background: "#fb923c26", color: "#fb923c" }}
          >
            <Receipt size={18} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">{t("Bills")}</div>
          {!showCal && (
            <span className="text-[12px]" style={{ color: "var(--color-taupe)" }}>
              {mc.monthLabel}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label={t("Close")}
            className="h-hit -mr-1.5 rounded-full p-1.5 transition active:bg-white/5"
            style={{ color: "var(--color-faint)" }}
          >
            <X size={20} />
          </button>
        </div>

        {!showCal && (
          <div
            className="mb-3 rounded-[14px] px-3 py-2.5"
            style={{ background: "#141a24", border: "1px solid #232d3a" }}
          >
            <div className="text-[11.5px]" style={{ color: "var(--color-taupe)" }}>
              {cycle.label} ·{" "}
              {daysLeft === 0
                ? t("last day")
                : daysLeft === 1
                  ? t("1 day left")
                  : t("{n} days left", { n: daysLeft })}
            </div>
            <div className="mt-0.5 text-[13.5px] font-semibold" style={{ color: "#fb923c" }}>
              {beforePayday.total > 0
                ? t("{amount} still due before payday", {
                    amount: money2(beforePayday.total),
                  })
                : t("Nothing else due before payday")}
              {/* Named separately because it is a different kind of fact: not
                  "coming up" but "already past its date and still unpaid". */}
              {beforePayday.overdueTotal > 0 && (
                <span style={{ color: "#f0556e" }}>
                  {" · "}
                  {t("{amount} already overdue", { amount: money2(beforePayday.overdueTotal) })}
                </span>
              )}
            </div>
          </div>
        )}

        {showCal ? (
          <BillCalendar getMonth={getMonth} baseDate={base} onBack={() => setShowCal(false)} />
        ) : (
          <>
            <BillContainer
              title={t("Unpaid · posting")}
              accent="#fb923c"
              bills={unpaid}
              open={openUnpaid}
              onToggle={() => setOpenUnpaid((v) => !v)}
              onPay={onPay}
            />
            <BillContainer
              title={t("Paid")}
              accent="#46d18a"
              bills={paid}
              open={openPaid}
              onToggle={() => setOpenPaid((v) => !v)}
            />
            <button
              onClick={() => setShowCal(true)}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold"
              style={{ background: "#0e2230", border: "1px solid #1d5066", color: "#34c5e8" }}
            >
              <CalendarDays size={16} /> {t("Open the money calendar")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
