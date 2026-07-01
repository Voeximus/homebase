import { useState } from "react";
import { Receipt, X, CalendarDays, ChevronDown, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import { catColor, catIcon } from "../../lib/catColor";
import type { MonthCalendar, MonthCalBill } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";

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
          style={{ color: b.paid ? "#7e8a98" : "#e6edf3", textDecoration: b.paid ? "line-through" : "none" }}
        >
          {b.name}
        </span>
        <span className="text-[11px]" style={{ color: b.paid ? "#6b9e83" : "#7e8a98" }}>
          {b.paid ? t("paid {date}", { date: b.paidDate ?? "" }) : t("due {date}", { date: b.dateLabel })}
        </span>
      </span>
      <span className="text-[13px] font-semibold" style={{ color: b.paid ? "#7e8a98" : "#e6edf3" }}>
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
  bills: MonthCalBill[];
  open: boolean;
  onToggle: () => void;
  onPay?: (b: MonthCalBill) => void;
}) {
  const total = bills.reduce((s, b) => s + b.amount, 0);
  return (
    <div className="mb-2 overflow-hidden rounded-xl" style={{ border: "1px solid #1b232e" }}>
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-3" style={{ background: "#131a23" }}>
        {open ? (
          <ChevronDown size={16} style={{ color: "#8b97a6" }} />
        ) : (
          <ChevronRight size={16} style={{ color: "#8b97a6" }} />
        )}
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="flex-1 text-left text-[13.5px] font-semibold text-bone">{title}</span>
        <span
          className="rounded-full px-1.5 text-[11px] font-semibold"
          style={{ background: "#1b232e", color: "#9aa6b2" }}
        >
          {bills.length}
        </span>
        <span className="text-[13px] font-semibold text-bone">{money0(total)}</span>
      </button>
      {open &&
        (bills.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px]" style={{ color: "#7e8a98" }}>
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#2a2016", color: "#fb923c" }}
          >
            <Receipt size={18} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">{t("Bills")}</div>
          {!showCal && (
            <span className="text-[12px]" style={{ color: "#8b97a6" }}>
              {mc.monthLabel}
            </span>
          )}
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

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
