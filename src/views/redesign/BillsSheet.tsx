import { useState } from "react";
import { Receipt, X, CircleCheck, CalendarDays, ArrowLeft } from "lucide-react";
import type { BillsVM, BillRow } from "./vm";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// The Bills surface: Option A (the upcoming list) with the month calendar one
// tap away. Self-contained bento overlay so it never touches the old chrome.
export function BillsSheet({
  vm,
  open,
  onClose,
  onPay,
}: {
  vm: BillsVM;
  open: boolean;
  onClose: () => void;
  onPay?: (b: BillRow) => void;
}) {
  const [showCal, setShowCal] = useState(false);
  if (!open) return null;
  const mon = vm.monthLabel.slice(0, 3);
  const calBy = new Map(vm.calendar.map((c) => [c.day, c]));
  const cells: (number | null)[] = [];
  for (let i = 0; i < vm.firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= vm.daysInMonth; d++) cells.push(d);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-[440px] overflow-y-auto"
        style={{
          background: "#0f141c",
          borderTop: "2px solid #fb923c",
          borderRadius: "24px 24px 0 0",
          padding: "14px 16px 24px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3.5 h-1 w-10 rounded-full" style={{ background: "#2a3441" }} />

        <div className="mb-3.5 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: "#2a2016", color: "#fb923c" }}
          >
            <Receipt size={18} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">Bills</div>
          {!showCal && (
            <span className="text-[12px]" style={{ color: "#8b97a6" }}>
              {money0(vm.leftThisMonth)} left
            </span>
          )}
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        {showCal ? (
          <>
            <div className="mb-2 grid grid-cols-7 gap-px">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <div key={i} className="text-center text-[10px]" style={{ color: "#5f6a78" }}>
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-px text-[12.5px]" style={{ color: "#cdd6e0" }}>
              {cells.map((d, i) => {
                if (d === null) return <div key={i} />;
                const ev = calBy.get(d);
                const isToday = d === vm.todayNum;
                return (
                  <div key={i} className="flex flex-col items-center justify-start py-1">
                    {isToday ? (
                      <span
                        className="flex h-6 w-6 items-center justify-center rounded-full font-bold"
                        style={{ background: "#34c5e8", color: "#06303a" }}
                      >
                        {d}
                      </span>
                    ) : (
                      <span>{d}</span>
                    )}
                    {ev && !isToday && (
                      <span
                        className="mt-0.5 h-[5px] w-[5px] rounded-full"
                        style={{ background: ev.in ? "#46d18a" : "#fb923c" }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex gap-3.5 border-t pt-3" style={{ borderColor: "#1b232e" }}>
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "#9aa6b2" }}>
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: "#46d18a" }} /> Payday
              </span>
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "#9aa6b2" }}>
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: "#fb923c" }} /> Bill due
              </span>
            </div>
            <button
              onClick={() => setShowCal(false)}
              className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold"
              style={{ background: "#161c26", color: "#8b97a6" }}
            >
              <ArrowLeft size={16} /> Back to the list
            </button>
          </>
        ) : (
          <>
            {vm.upcoming.length === 0 ? (
              <p className="py-6 text-center text-[13px]" style={{ color: "#7e8a98" }}>
                All bills paid this month.
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
                        {b.variable ? " · ~est" : ""}
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
                  {vm.paidCount} paid this month
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
              <CalendarDays size={16} /> Open the money calendar
            </button>
          </>
        )}
      </div>
    </div>
  );
}
