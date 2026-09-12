import { useState } from "react";
import { Receipt, X, CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import { catColor, catIcon } from "../../lib/catColor";
import { dueBeforeNextPayday, type MonthCalendar, type MonthCalBill } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";
import { payCycleFor } from "../../lib/plan";
import { isoDate } from "../../lib/format";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

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
          style={{ color: b.paid ? "#8b96a5" : "#f0f4f8", textDecoration: b.paid ? "line-through" : "none" }}
        >
          {b.name}
        </span>
        <span className="text-[11px]" style={{ color: b.paid ? "#4f9b87" : "#8b96a5" }}>
          {b.paid ? t("paid {date}", { date: b.paidDate ?? "" }) : t("due {date}", { date: b.dateLabel })}
        </span>
      </span>
      <span className="text-[13px] font-semibold" style={{ color: b.paid ? "#8b96a5" : "#f0f4f8" }}>
        {b.variable && !b.paid ? "~" : ""}
        {money2(b.amount)}
      </span>
    </div>
  );
  return !b.paid && onPay ? (
    <button onClick={() => onPay(b)} className="w-full text-left" style={{ borderTop: "1px solid #141a23" }}>
      {inner}
    </button>
  ) : (
    <div style={{ borderTop: "1px solid #141a23" }}>{inner}</div>
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
  bills: MonthCalBill[];
  open: boolean;
  onToggle: () => void;
  onPay?: (b: MonthCalBill) => void;
}) {
  const total = bills.reduce((s, b) => s + b.amount, 0);
  return (
    <div className="mb-2 overflow-hidden rounded-xl" style={{ border: "1px solid #222b38" }}>
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-3" style={{ background: "#141a23" }}>
        {open ? (
          <ChevronDown size={16} style={{ color: "#8b96a5" }} />
        ) : (
          <ChevronRight size={16} style={{ color: "#8b96a5" }} />
        )}
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="flex-1 text-left text-[13.5px] font-semibold text-bone">{title}</span>
        <span
          className="rounded-full px-1.5 text-[11px] font-semibold"
          style={{ background: "#222b38", color: "#a8b4c2" }}
        >
          {bills.length}
        </span>
        <span className="text-[13px] font-semibold text-bone">{money0(total)}</span>
      </button>
      {open &&
        (bills.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px]" style={{ color: "#8b96a5" }}>
            {t("Nothing here this month.")}
          </p>
        ) : (
          <div>
            {bills.map((b) => (
              <BillLine key={b.id} b={b} onPay={onPay} />
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
  onPay?: (b: MonthCalBill) => void;
  getMonth: (year: number, month: number) => MonthCalendar;
  baseDate?: Date;
}) {
  const [showCal, setShowCal] = useState(false);
  const [openUnpaid, setOpenUnpaid] = useState(false);
  const [openPaid, setOpenPaid] = useState(false);
  if (!open) return null;
  const base = baseDate ?? new Date();
  const mc = getMonth(base.getFullYear(), base.getMonth());
  const unpaid = mc.bills.filter((b) => !b.paid);
  const paid = mc.bills.filter((b) => b.paid);

  // The list below stays CALENDAR-MONTHLY on purpose — rent really is due on the
  // 1st, and that decision is why bills didn't move to pay cycles with the budget.
  // What the cycle answers here is a different question: of the check that's
  // already landed, how much is still spoken for before the next one arrives.
  const cycle = payCycleFor(base);
  const daysLeft = Math.max(0, cycle.days - cycle.dayIndex);
  // Shared spelling, not a local copy — this window is compared against ledger
  // dates, so the two conversions have to be the same function.
  const todayISO = isoDate(base);
  // The window can cross a month boundary, so hand over every month it touches.
  const [endY, endM] = cycle.end.split("-").map(Number);
  const windowMonths =
    endY === mc.year && endM - 1 === mc.month ? [mc] : [mc, getMonth(endY, endM - 1)];
  // cycle.start, not today — an unpaid bill whose due day has already passed
  // inside this cycle still comes out of the paycheck already in the account.
  const beforePayday = dueBeforeNextPayday(windowMonths, todayISO, cycle.end, cycle.start);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto"
        style={{
          background: "#0b0e13",
          border: "1px solid #222b38",
          borderTop: "2px solid #c07a1e",
          borderRadius: "22px",
          padding: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3.5 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#271c10", color: "#c07a1e" }}
          >
            <Receipt size={18} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">{t("Bills")}</div>
          {!showCal && (
            <span className="text-[12px]" style={{ color: "#8b96a5" }}>
              {mc.monthLabel}
            </span>
          )}
          <button onClick={onClose} style={{ color: "#8b96a5" }}>
            <X size={20} />
          </button>
        </div>

        {!showCal && (
          <div
            className="mb-3 rounded-[14px] px-3 py-2.5"
            style={{ background: "#141a23", border: "1px solid #222b38" }}
          >
            <div className="text-[11.5px]" style={{ color: "#8b96a5" }}>
              {cycle.label} ·{" "}
              {daysLeft === 0 ? t("last day") : t("{n} days left", { n: daysLeft })}
            </div>
            <div className="mt-0.5 text-[13.5px] font-semibold" style={{ color: "#c07a1e" }}>
              {beforePayday.total > 0
                ? t("{amount} still due before payday", {
                    amount: money2(beforePayday.total),
                  })
                : t("Nothing else due before payday")}
              {/* Named separately because it is a different kind of fact: not
                  "coming up" but "already past its date and still unpaid". */}
              {beforePayday.overdueTotal > 0 && (
                <span style={{ color: "#f0645c" }}>
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
              accent="#c07a1e"
              bills={unpaid}
              open={openUnpaid}
              onToggle={() => setOpenUnpaid((v) => !v)}
              onPay={onPay}
            />
            <BillContainer
              title={t("Paid")}
              accent="#3fd08a"
              bills={paid}
              open={openPaid}
              onToggle={() => setOpenPaid((v) => !v)}
            />
            <button
              onClick={() => setShowCal(true)}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold"
              style={{ background: "#10323f", border: "1px solid #22566a", color: "#38c6e8" }}
            >
              <CalendarDays size={16} /> {t("Open the money calendar")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
