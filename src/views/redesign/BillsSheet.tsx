import { useState } from "react";
import { CalendarDays, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";
import type { MonthCalendar, MonthCalBill } from "../../lib/schedule";
import { BillCalendar } from "./BillCalendar";
import { billsBeforeNextPayday } from "../../lib/headline";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── The Bills screen ─────────────────────────────────────────────────────────
//
// RESKINNED 2026-10-04, not rewritten: every number on this screen still comes
// from the single `billsBeforeNextPayday(getMonth, base)` call it always did, and
// `month` is the very calendar that total was computed from, so the list and the
// figure above it can never come from two different builds of it.
//
// What changed is the surface. It was an orange-topped overlay of collapsible
// containers, each bill a hairline row with its own tinted icon; it is now an
// inset grouped list on one tile — Apple's own pattern, which is what he asked
// for. Three consequences worth stating because they are deliberate:
//
//   · NOTHING IS COLLAPSED any more. The groups existed so the sheet stayed "a
//     glance, not a wall", and that was right when this was one of fourteen
//     sheets. It is now one of three screens, and a list you have to open to
//     read is a worse glance than a list that is simply short.
//   · COLOUR CARRIES MEANING, not identity. Every bill used to wear its
//     category's hue. Now green means settled and nothing else is coloured, so
//     the one bill that is paid reads instantly against the ones that are not.
//   · EVERY COLOUR IS A TOKEN, so the whole screen follows light and dark
//     without a second code path.

/** One row in the grouped list. Tappable only when there is something to do. */
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
    <div className="flex w-full items-center gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className={`truncate text-[16px] ${b.paid ? "text-taupe" : "text-bone"}`}>{b.name}</span>
        <span className="text-[13px]">
          {b.paid ? (
            <span className="text-mint">{t("Paid {date}", { date: b.paidDate ?? "" })}</span>
          ) : (
            <span className="text-taupe">{t("due {date}", { date: b.dateLabel })}</span>
          )}
        </span>
      </span>
      <span
        className={`text-[16px] tabular-nums ${b.paid ? "text-faint" : "text-bone"}`}
      >
        {b.variable && !b.paid ? "~" : ""}
        {money2(b.amount)}
      </span>
      {!b.paid && onPay && <ChevronRight size={17} className="shrink-0 text-faint" />}
    </div>
  );
  // The separator is inset from the left the way Apple insets it — it starts
  // under the text, not at the edge of the tile, so the group reads as one object.
  const sep = last ? undefined : { boxShadow: "inset 0 -1px 0 var(--color-edge)" };
  return !b.paid && onPay ? (
    <button onClick={() => onPay(b)} className="block w-full text-left" style={sep}>
      {inner}
    </button>
  ) : (
    <div style={sep}>{inner}</div>
  );
}

/** A titled group of rows on one tile, or nothing at all when it is empty. */
function BillGroup({
  title,
  bills,
  onPay,
}: {
  title: string;
  bills: MonthCalBill[];
  onPay?: (b: MonthCalBill) => void;
}) {
  if (bills.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 pl-5 text-[13px] font-semibold text-taupe">{title}</h2>
      <div className="overflow-hidden rounded-2xl bg-tile">
        {bills.map((b, i) => (
          <BillRow key={b.id} b={b} onPay={onPay} last={i === bills.length - 1} />
        ))}
      </div>
    </section>
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
  // assembled right here, and three of the four fail quietly (a window opening at
  // today instead of the cycle start silently drops the overdue rows; a window
  // that crosses a month end under-reports unless both months are handed over).
  // The Muse read door answers this same question, so the assembly lives in
  // src/lib/headline.ts and both callers run it.
  const { month: mc, cycle, daysLeft, ...beforePayday } = billsBeforeNextPayday(getMonth, base);
  const unpaid = mc.bills.filter((b) => !b.paid);
  const paid = mc.bills.filter((b) => b.paid);

  if (showCal) {
    return (
      <div className="pb-2">
        <BillCalendar getMonth={getMonth} baseDate={base} onBack={() => setShowCal(false)} />
      </div>
    );
  }

  return (
    <div className="pb-2">
      {/* Large title, Apple's pattern: the context line sits above it, small and
          secondary, and the title itself carries no decoration. */}
      <header className="px-5 pt-1">
        <p className="text-[15px] text-taupe">
          {cycle.label} ·{" "}
          {daysLeft === 0 ? t("last day") : t("{n} days left", { n: daysLeft })}
        </p>
        <h1 className="mt-0.5 text-[34px] font-bold leading-tight tracking-[-0.022em] text-bone">
          {t("Bills")}
        </h1>
      </header>

      {/* The one figure the screen exists to show. Light weight at a large size is
          the Apple move: it reads as a readout rather than a headline. */}
      <div className="mt-5 px-5">
        <p className="text-[15px] text-taupe">
          {beforePayday.total > 0 ? t("Still to come") : t("Nothing else due before payday")}
        </p>
        {beforePayday.total > 0 && (
          <p className="mt-0.5 text-[52px] font-light leading-[1.06] tracking-[-0.04em] tabular-nums text-bone">
            {money2(beforePayday.total)}
          </p>
        )}
        {beforePayday.overdueTotal > 0 && (
          // A different KIND of fact from the total, not a worse one: already past
          // its date and still unpaid. Red, because that is what red is for here.
          <p className="mt-1 text-[14px] text-ember">
            {t("{amount} already overdue", { amount: money2(beforePayday.overdueTotal) })}
          </p>
        )}
      </div>

      <BillGroup title={t("Coming up")} bills={unpaid} onPay={onPay} />
      <BillGroup title={t("Paid")} bills={paid} />

      <div className="mt-6 px-4">
        <button
          onClick={() => setShowCal(true)}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-tile text-[16px] text-accent"
        >
          <CalendarDays size={17} /> {t("Open the money calendar")}
        </button>
      </div>
    </div>
  );
}
