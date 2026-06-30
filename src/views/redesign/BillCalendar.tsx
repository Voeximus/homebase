import { useState } from "react";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";
import type { MonthCalendar } from "../../lib/schedule";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Flippable month calendar (read-only glance). `getMonth` returns one month's
// grid + bills for any year/month — paying happens back in the list view, so this
// surface stays a pure overview that's safe to flip across past/future months.
export function BillCalendar({
  getMonth,
  baseDate,
  onBack,
}: {
  getMonth: (year: number, month: number) => MonthCalendar;
  baseDate: Date;
  onBack?: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const target = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1);
  const mc = getMonth(target.getFullYear(), target.getMonth());
  const mon = mc.monthLabel.slice(0, 3);
  const calBy = new Map(mc.days.map((c) => [c.day, c]));
  const cells: (number | null)[] = [];
  for (let i = 0; i < mc.firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= mc.daysInMonth; d++) cells.push(d);
  const dayBills = selectedDay ? mc.bills.filter((b) => b.day === selectedDay) : [];
  const flip = (delta: number) => {
    setOffset((o) => o + delta);
    setSelectedDay(null);
  };

  return (
    <>
      {/* month nav */}
      <div className="mb-3 flex items-center justify-between">
        <button
          onClick={() => flip(-1)}
          className="rounded-lg p-1.5"
          style={{ background: "#161c26", color: "#9aa6b2" }}
          aria-label={t("Previous month")}
        >
          <ChevronLeft size={18} />
        </button>
        <div className="text-center">
          <div className="text-[14px] font-semibold text-bone">{mc.monthLabel}</div>
          {offset !== 0 && (
            <button
              onClick={() => {
                setOffset(0);
                setSelectedDay(null);
              }}
              className="text-[11px] underline"
              style={{ color: "#8b97a6" }}
            >
              {t("This month")}
            </button>
          )}
        </div>
        <button
          onClick={() => flip(1)}
          className="rounded-lg p-1.5"
          style={{ background: "#161c26", color: "#9aa6b2" }}
          aria-label={t("Next month")}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* weekday header — one key for the whole row (position-specific 中文) */}
      <div className="mb-2 grid grid-cols-7 gap-px">
        {t("S M T W T F S")
          .split(" ")
          .map((d, i) => (
            <div key={i} className="text-center text-[10px]" style={{ color: "#5f6a78" }}>
              {d}
            </div>
          ))}
      </div>

      {/* day grid */}
      <div className="grid grid-cols-7 gap-px text-[12.5px]" style={{ color: "#cdd6e0" }}>
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const ev = calBy.get(d);
          const isToday = d === mc.todayNum;
          const isSel = d === selectedDay;
          return (
            <button
              key={i}
              onClick={() => setSelectedDay(isSel ? null : d)}
              className="flex flex-col items-center justify-start rounded-lg py-1 transition"
              style={{ background: isSel ? "#1b2735" : "transparent" }}
            >
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
                <span className="mt-0.5 flex gap-0.5">
                  {ev.out && <span className="h-[5px] w-[5px] rounded-full" style={{ background: "#fb923c" }} />}
                  {ev.pay && <span className="h-[5px] w-[5px] rounded-full" style={{ background: "#46d18a" }} />}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* selected-day agenda */}
      {selectedDay && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "#1b232e" }}>
          <div className="mb-2 text-[12px] font-semibold text-bone">{t("{mon} {day}", { mon, day: selectedDay })}</div>
          {dayBills.length === 0 ? (
            <p className="text-[12px]" style={{ color: "#7e8a98" }}>
              {t("Nothing due this day.")}
            </p>
          ) : (
            dayBills.map((b) => {
              const Icon = catIcon(b.catId);
              const col = catColor(b.catId);
              return (
                <div key={b.id} className="flex w-full items-center gap-2.5 py-1.5">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{ background: col + "26", color: col }}
                  >
                    <Icon size={14} />
                  </span>
                  <span
                    className="flex-1 text-[13px]"
                    style={{
                      color: b.paid ? "#7e8a98" : "#e6edf3",
                      textDecoration: b.paid ? "line-through" : "none",
                    }}
                  >
                    {b.name}
                  </span>
                  <span className="text-[13px] font-semibold" style={{ color: b.paid ? "#7e8a98" : "#e6edf3" }}>
                    {b.variable ? "~" : ""}
                    {money2(b.amount)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* legend */}
      <div className="mt-3 flex gap-3.5 border-t pt-3" style={{ borderColor: "#1b232e" }}>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "#9aa6b2" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: "#46d18a" }} /> {t("Payday")}
        </span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "#9aa6b2" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: "#fb923c" }} /> {t("Bill due")}
        </span>
      </div>

      {onBack && (
        <button
          onClick={onBack}
          className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold"
          style={{ background: "#161c26", color: "#8b97a6" }}
        >
          <ArrowLeft size={16} /> {t("Back to the list")}
        </button>
      )}
    </>
  );
}
