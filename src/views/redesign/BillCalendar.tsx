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
          style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }}
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
              style={{ color: "var(--color-taupe)" }}
            >
              {t("This month")}
            </button>
          )}
        </div>
        <button
          onClick={() => flip(1)}
          className="rounded-lg p-1.5"
          style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }}
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
            <div key={i} className="text-center text-[10px]" style={{ color: "var(--color-faint)" }}>
              {d}
            </div>
          ))}
      </div>

      {/* day grid */}
      <div className="grid grid-cols-7 gap-px text-[12.5px]" style={{ color: "var(--color-bone)" }}>
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
              style={{ background: isSel ? "var(--color-raised)" : "transparent" }}
            >
              {isToday ? (
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full font-bold"
                  style={{ background: "var(--color-accent)", color: "#fff" }}
                >
                  {d}
                </span>
              ) : (
                <span>{d}</span>
              )}
              {ev && !isToday && (
                <span className="mt-0.5 flex gap-0.5">
                  {ev.out && <span className="h-[5px] w-[5px] rounded-full" style={{ background: "var(--color-gold)" }} />}
                  {ev.paid && <span className="h-[5px] w-[5px] rounded-full" style={{ background: "var(--color-faint)" }} />}
                  {ev.pay && <span className="h-[5px] w-[5px] rounded-full" style={{ background: "var(--color-mint)" }} />}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* selected-day agenda */}
      {selectedDay && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--color-edge)" }}>
          <div className="mb-2 text-[12px] font-semibold text-bone">{t("{mon} {day}", { mon, day: selectedDay })}</div>
          {dayBills.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--color-taupe)" }}>
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
                  <span className="flex flex-1 flex-col">
                    <span
                      className="text-[13px]"
                      style={{
                        color: b.paid ? "var(--color-taupe)" : "var(--color-bone)",
                        textDecoration: b.paid ? "line-through" : "none",
                      }}
                    >
                      {b.name}
                    </span>
                    <span className="text-[11px]" style={{ color: b.paid ? "var(--color-mint)" : "var(--color-taupe)" }}>
                      {b.paid ? t("paid {date}", { date: b.paidDate ?? "" }) : t("due {date}", { date: b.dateLabel })}
                    </span>
                  </span>
                  <span className="text-[13px] font-semibold" style={{ color: b.paid ? "var(--color-taupe)" : "var(--color-bone)" }}>
                    {b.variable && !b.paid ? "~" : ""}
                    {money2(b.amount)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* legend */}
      <div className="mt-3 flex gap-3.5 border-t pt-3" style={{ borderColor: "var(--color-edge)" }}>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--color-mint)" }} /> {t("Payday")}
        </span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--color-gold)" }} /> {t("Bill due")}
        </span>
        <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--color-taupe)" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: "var(--color-faint)" }} /> {t("Paid")}
        </span>
      </div>

      {onBack && (
        <button
          onClick={onBack}
          className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold"
          style={{ background: "var(--color-tile)", color: "var(--color-taupe)" }}
        >
          <ArrowLeft size={16} /> {t("Back to the list")}
        </button>
      )}
    </>
  );
}
