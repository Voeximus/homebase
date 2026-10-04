import { useState } from "react";
import { CalendarDays, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import type { MonthCalendar, MonthCalBill } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";
import { billsBeforeNextPayday } from "../../lib/headline";
import { Bar, Card, Chip, Figure, Hero, LimePill, ROW_SEP, SectionTitle, Wells } from "./kit";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
/** "$259.67" → ["$259", ".67"], so the cents can be set quieter. */
const split = (n: number): [string, string] => {
  const s = money2(n);
  const i = s.lastIndexOf(".");
  return [s.slice(0, i), s.slice(i)];
};

// ── The Bills screen ─────────────────────────────────────────────────────────
//
// Every number still comes from the single `billsBeforeNextPayday(getMonth, base)`
// call it always did, and `month` is the very calendar that total was computed
// from, so the list and the figure above it can never come from two different
// builds of it. Only the surface has changed — twice in one day, and this is the
// one he picked: cream page, black hero card, lime as a fill.

function BillRow({
  b,
  onPay,
  last,
}: {
  b: MonthCalBill;
  onPay?: (b: MonthCalBill) => void;
  last: boolean;
}) {
  const inner = (
    <div className="flex w-full items-center gap-[11px] px-[14px] py-3">
      <Chip name={b.name} />
      <span className="flex min-w-0 flex-1 flex-col text-left">
        <span
          className={`truncate text-[15px] font-medium ${b.paid ? "text-taupe line-through" : "text-bone"}`}
        >
          {b.name}
        </span>
        <span className="mt-px text-[12.5px]">
          {b.paid ? (
            <span className="text-mint">{t("Paid {date}", { date: b.paidDate ?? "" })}</span>
          ) : (
            <span className="text-taupe">{t("due {date}", { date: b.dateLabel })}</span>
          )}
        </span>
      </span>
      <span
        className={`text-[15px] font-semibold tabular-nums ${b.paid ? "text-taupe" : "text-bone"}`}
      >
        &minus;{b.variable && !b.paid ? "~" : ""}
        {money2(b.amount)}
      </span>
      {!b.paid && onPay && <ChevronRight size={16} className="-mr-1 shrink-0 text-taupe" />}
    </div>
  );
  const style = last ? undefined : ROW_SEP;
  return !b.paid && onPay ? (
    <button onClick={() => onPay(b)} className="block w-full text-left" style={style}>
      {inner}
    </button>
  ) : (
    <div style={style}>{inner}</div>
  );
}

export function BillsSheet({
  open,
  onPay,
  getMonth,
  baseDate,
  /** Render in the page rather than over it — see the note on Sheet's `panel`. */
  panel,
}: {
  open?: boolean;
  /** Accepted and unused: this is a tab now, with nothing behind it to close to. */
  onClose?: () => void;
  onPay?: (b: MonthCalBill) => void;
  getMonth: (year: number, month: number) => MonthCalendar;
  baseDate?: Date;
  panel?: boolean;
}) {
  const [showCal, setShowCal] = useState(false);
  if (!panel && open === false) return null;
  const base = baseDate ?? new Date();

  // ONE call. The four arguments dueBeforeNextPayday needs — every month the
  // window touches, today, the cycle's end, the cycle's start — were once
  // assembled here, and three of the four fail quietly. The Muse read door
  // answers this same question, so the assembly lives in src/lib/headline.ts and
  // both callers run it.
  const { month: mc, cycle, daysLeft, ...beforePayday } = billsBeforeNextPayday(getMonth, base);
  const unpaid = mc.bills.filter((b) => !b.paid);
  const paid = mc.bills.filter((b) => b.paid);
  const paidTotal = paid.reduce((s, b) => s + b.amount, 0);
  const [whole, cents] = split(beforePayday.total);

  if (showCal) {
    return (
      <div className="px-2 pb-2">
        <BillCalendar getMonth={getMonth} baseDate={base} onBack={() => setShowCal(false)} />
      </div>
    );
  }

  return (
    <div className="pb-2">
      <header className="flex items-center justify-between px-5 pt-1">
        <div>
          <p className="text-[13px] text-taupe">{cycle.label}</p>
          <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-bone">
            {t("Bills")}
          </h1>
        </div>
        <span className="flex items-center gap-1.5 rounded-full bg-tile px-3 py-[7px]">
          <span
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{ background: daysLeft <= 3 ? "var(--color-ember)" : "var(--color-mint)" }}
          />
          <span className="text-[13px] font-semibold text-bone">
            {daysLeft === 0 ? t("last day") : t("{n} days left", { n: daysLeft })}
          </span>
        </span>
      </header>

      <div className="mt-3.5">
        <Hero>
          <div className="flex items-center justify-between">
            <span className="text-[13px]" style={{ opacity: 0.66 }}>
              {beforePayday.total > 0 ? t("Still to come") : t("Nothing else due")}
            </span>
            <LimePill>{t("before your check")}</LimePill>
          </div>
          <Figure whole={whole} cents={cents} />
          {beforePayday.overdueTotal > 0 && (
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ember)" }}>
              {t("{amount} already overdue", { amount: money2(beforePayday.overdueTotal) })}
            </p>
          )}
          <Wells
            items={[
              { k: t("Paid"), v: money0(paidTotal) },
              { k: t("Left"), v: money0(beforePayday.total) },
              { k: t("Bills"), v: String(mc.bills.length) },
            ]}
          />
        </Hero>
      </div>

      {unpaid.length > 0 && (
        <>
          <SectionTitle aside={mc.monthLabel}>{t("Coming up")}</SectionTitle>
          <Card className="mt-[9px]">
            {unpaid.map((b, i) => (
              <BillRow key={b.id} b={b} onPay={onPay} last={i === unpaid.length - 1} />
            ))}
          </Card>
        </>
      )}

      {paid.length > 0 && (
        <>
          <SectionTitle aside={money0(paidTotal)}>{t("Paid")}</SectionTitle>
          <Card className="mt-[9px]">
            {paid.map((b, i) => (
              <BillRow key={b.id} b={b} last={i === paid.length - 1} />
            ))}
          </Card>
        </>
      )}

      <div className="mt-[18px] px-4">
        <button
          onClick={() => setShowCal(true)}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-[16px] bg-tile text-[15px] font-semibold text-bone"
        >
          <CalendarDays size={17} /> {t("Open the money calendar")}
        </button>
      </div>
    </div>
  );
}

/** Re-exported so the alert card on this screen and the bars elsewhere share one
 *  definition. Kept here rather than inlined so a future screen cannot draw its
 *  own slightly-different bar. */
export { Bar };
