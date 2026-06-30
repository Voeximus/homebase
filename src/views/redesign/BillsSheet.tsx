import { useState } from "react";
import { Receipt, X, CircleCheck, CalendarDays } from "lucide-react";
import { t } from "../../lib/i18n";
import type { BillsVM, BillRow } from "./vm";
import type { MonthCalendar } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// The Bills surface: Option A (the upcoming list) with a flippable month calendar
// one tap away. Self-contained bento overlay so it never touches the old chrome.
export function BillsSheet({
  vm,
  open,
  onClose,
  onPay,
  getMonth,
  baseDate,
}: {
  vm: BillsVM;
  open: boolean;
  onClose: () => void;
  onPay?: (b: BillRow) => void;
  getMonth: (year: number, month: number) => MonthCalendar;
  baseDate?: Date;
}) {
  const [showCal, setShowCal] = useState(false);
  if (!open) return null;
  const mon = vm.monthLabel.slice(0, 3);

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
              {t("{amount} left", { amount: money0(vm.leftThisMonth) })}
            </span>
          )}
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        {showCal ? (
          <BillCalendar
            getMonth={getMonth}
            baseDate={baseDate ?? new Date()}
            onBack={() => setShowCal(false)}
          />
        ) : (
          <>
            {vm.upcoming.length === 0 ? (
              <p className="py-6 text-center text-[13px]" style={{ color: "#7e8a98" }}>
                {t("All bills paid this month.")}
              </p>
            ) : (
              <div className="flex flex-col">
                {vm.upcoming.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => onPay?.(b)}
                    className="flex w-full items-center gap-3 py-2.5 text-left"
                    style={{ borderBottom: "1px solid #1b232e" }}
                  >
                    <span className="w-[46px] shrink-0 text-center">
                      <span
                        className="block text-[11px] font-bold uppercase"
                        style={{ color: b.day >= vm.todayNum ? "#34c5e8" : "#6b7686" }}
                      >
                        {mon}
                      </span>
                      <span className="block text-[17px] font-bold leading-none text-bone">{b.day}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-bone">{b.name}</div>
                      <div className="text-[11px]" style={{ color: "#7e8a98" }}>
                        {b.relLabel}
                        {b.variable ? t(" · ~est") : ""}
                      </div>
                    </div>
                    <span className="text-[13.5px] font-semibold text-bone">
                      {b.variable ? "~" : ""}
                      {money2(b.amount)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {vm.paidCount > 0 && (
              <div
                className="mt-2.5 flex items-center gap-2 rounded-xl px-3.5 py-2.5"
                style={{ background: "#13211a", border: "1px solid #1f3a2c" }}
              >
                <CircleCheck size={17} style={{ color: "#46d18a" }} />
                <span className="flex-1 text-[12.5px]" style={{ color: "#9fe3c0" }}>
                  {t("{n} paid this month", { n: vm.paidCount })}
                </span>
                <span className="text-[12.5px] font-semibold" style={{ color: "#46d18a" }}>
                  {money0(vm.paidTotal)}
                </span>
              </div>
            )}

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
