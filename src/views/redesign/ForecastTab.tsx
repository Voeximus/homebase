import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Debt, Recurring, Transaction } from "../../types";
import { forecast, summarize, type ForecastMonth } from "../../lib/forecast";
import { recentCycleSpend, typicalCycleSpend, actualMonthlyNet } from "../../lib/plan";
import { monthKeyOf } from "../../lib/format";

// ── Forecast ─────────────────────────────────────────────────────────────────
// The one screen that answers "what does this look like in three months". Every
// number is derived from the same recurring rows the Bills calendar reads, so it
// can't drift from them — the dials are what-ifs layered ON TOP, never saved.

const C = {
  bg: "#0b0f17",
  card: "#141a24",
  line: "#232d3a",
  ink: "#e6edf3",
  dim: "#8b97a6",
  accent: "#34c5e8",
  warm: "#f0a45c",
  good: "#46d18a",
  bad: "#e8746a",
};

const money = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString();

function Dial({
  label, value, min, max, step, onChange, display, tint,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (n: number) => void; display: string; tint: string;
}) {
  return (
    <div className="flex-1" style={{ minWidth: 140 }}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.11em]" style={{ color: C.dim }}>{label}</span>
        <span className="text-[15px] font-semibold tabular-nums" style={{ color: tint }}>{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        aria-label={label}
        className="w-full"
        style={{ accentColor: tint, height: 22 }}
      />
    </div>
  );
}

export function ForecastTab({
  recurring, transactions, debts, openingCash,
}: {
  recurring: Recurring[];
  transactions: Transaction[];
  debts: Debt[];
  /** Cash on hand today. With it, every month reports a running balance and its
   *  low point — the number a monthly surplus structurally cannot tell you. */
  openingCash?: number;
}) {
  // The card we model paying down: the biggest interest-bearing balance with a
  // bill attached. Picked from data so it follows a payoff instead of hardcoding.
  const cardDebt = useMemo(
    () =>
      debts
        .filter((d) => d.balance > 0 && (d.apr ?? 0) > 0)
        .sort((a, b) => b.balance - a.balance)[0],
    [debts],
  );
  const cardRow = useMemo(
    () => recurring.find((r) => r.active && r.linkedDebtId === cardDebt?.id),
    [recurring, cardDebt],
  );

  // Two dials only, and they are the two things he actually decides each cycle:
  // what he spends, and what he throws at the card. Everything else — rent, the
  // car note, insurance — is a real row in the database and shouldn't pretend to
  // be a what-if.
  const [cardPay, setCardPay] = useState(() => Math.round(cardRow?.amount ?? 134));
  const [open, setOpen] = useState<string | null>(null);

  // The user's OWN spending history, so the dial has a reference point instead of
  // being a number in a vacuum.
  const cycles = useMemo(() => recentCycleSpend(transactions), [transactions]);
  const typical = useMemo(() => typicalCycleSpend(cycles), [cycles]);

  // Open on what they ACTUALLY spend, not a round number somebody picked. The old
  // default was a hardcoded 700 — below this household's real median — so the very
  // first surplus the screen ever showed was optimistic, and nothing said why.
  const [cycleSpend, setCycleSpend] = useState(() => (typical > 0 ? Math.round(typical) : 700));

  const startMonth = useMemo(() => {
    const d = new Date();
    return monthKeyOf(d);
  }, []);

  const months = useMemo(
    () =>
      forecast(recurring, transactions, debts, startMonth, 12, {
        cardPay, cycleSpend, cardDebtId: cardDebt?.id, openingCash,
      }),
    [recurring, transactions, debts, startMonth, cardPay, cycleSpend, cardDebt, openingCash],
  );
  const sum = useMemo(() => summarize(months), [months]);
  const next = months[1] ?? months[0];

  // The single worst moment across the whole projection.
  const lowest = useMemo(() => {
    const withLow = months.filter((m) => m.low);
    if (!withLow.length) return null;
    return withLow.reduce((a, b) => (b.low!.balance < a.low!.balance ? b : a));
  }, [months]);

  // What actually happened, to keep the projection honest about its blind spot.
  const actual = useMemo(() => actualMonthlyNet(transactions), [transactions]);
  const actualAvg = actual.length ? actual.reduce((s2, m) => s2 + m.net, 0) / actual.length : 0;
  const projected = sum?.steady ?? 0;

  const minCard = Math.round(cardDebt?.minPayment ?? 25);

  return (
    <div className="px-4 pb-8 pt-3" style={{ background: C.bg, color: C.ink }}>
      {/* ── dials ── */}
      <div className="rounded-2xl p-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
        <div className="flex flex-col gap-4">
          <Dial
            label="Spending, per pay cycle" value={cycleSpend} min={300} max={1400} step={5}
            onChange={setCycleSpend} display={money(cycleSpend) + " · " + money(cycleSpend * 2) + "/mo"}
            tint={C.good}
          />
          <Dial
            label="To the card, per month" value={cardPay} min={minCard} max={1500} step={1}
            onChange={setCardPay}
            display={money(cardPay) + (cardPay <= minCard ? " · minimum" : "")}
            tint={C.warm}
          />
        </div>

        {/* What you have actually spent, beside the dial that guesses it.
            A surplus is two different kinds of number added together: income and
            bills are MEASURED from the bank, spending is ASSUMED. Showing one
            figure hides which half is a fact, and a projection built on $800 a
            cycle is a different claim from one built on $1,050. */}
        {cycles.length > 0 && (
          <div className="mt-3 rounded-xl px-3 py-2.5" style={{ background: C.bg }}>
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.11em]" style={{ color: C.dim }}>
                What you actually spent
              </span>
              <button
                onClick={() => setCycleSpend(Math.round(typical))}
                className="text-[11px] font-semibold active:opacity-60"
                style={{ color: C.accent }}
              >
                use {money(typical)}
              </button>
            </div>
            <div className="mt-1.5 flex items-end gap-1" style={{ height: 34 }}>
              {cycles.map((c) => {
                const peak = Math.max(...cycles.map((x) => x.spent), cycleSpend, 1);
                return (
                  <div key={c.start} className="flex-1" title={`${c.label} · ${money(c.spent)}`}>
                    <div
                      style={{
                        height: Math.max(2, (c.spent / peak) * 34),
                        borderRadius: "3px 3px 0 0",
                        background: c.spent > cycleSpend ? C.warm : C.good,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 text-[11px]" style={{ color: C.dim }}>
              Last {cycles.length} cycles · typically {money(typical)} · you're planning{" "}
              <span style={{ color: cycleSpend < typical ? C.warm : C.good }}>{money(cycleSpend)}</span>
            </div>
          </div>
        )}

        {/* the equation, spelled out — surplus is never just a word, and each
            term says where it came from */}
        {next && (
          <div
            className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-[11px]"
            style={{ background: C.bg, color: C.dim }}
          >
            <Term label="income · measured" value={money(next.income)} />
            <span style={{ color: C.line }}>−</span>
            <Term label="bills · measured" value={money(next.bills)} />
            <span style={{ color: C.line }}>−</span>
            <Term label="spending · your setting" value={money(next.spend)} tint={C.warm} />
            <span style={{ color: C.line }}>=</span>
            <Term
              label={next.surplus < 0 ? "short" : "surplus"}
              value={money(next.surplus)}
              tint={next.surplus < 0 ? C.bad : C.good}
            />
          </div>
        )}
        <p className="mt-2 px-1 text-[10.5px] leading-relaxed" style={{ color: C.dim }}>
          Income and bills come from your bank. Spending is the one number you set —
          so the surplus moves when you move it, and it is only ever as right as that
          guess.
        </p>
      </div>

      {/* ── headline ── */}
      {sum && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {/* THE number, when we have real cash to walk. A surplus cannot see past
              the end of its own month, and rent lands on the 1st funded by the
              paycheck from the 31st before — so a healthy surplus can sit on cash
              that is already promised three days later. The low point can't lie
              about that, because it carries the balance across the boundary. */}
          {lowest ? (
            <Stat
              k={`Lowest you get · ${lowest.label} ${lowest.low!.day}`}
              v={money(lowest.low!.balance)}
              tint={lowest.low!.balance < 0 ? C.bad : lowest.low!.balance < 300 ? C.warm : C.good}
            />
          ) : (
            <Stat k="Typical month" v={money(sum.steady)} tint={sum.steady < 0 ? C.bad : C.good} />
          )}
          <Stat
            k={sum.clearsOn ? "Card paid off" : "Card not cleared"}
            v={sum.clearsOn ?? "in 12 mo"}
            tint={sum.clearsOn ? C.accent : C.warm}
          />
          <Stat k="Typical month" v={money(sum.steady)} tint={sum.steady < 0 ? C.bad : C.good} />
          <Stat k={`Tightest · ${sum.worst.label}`} v={money(sum.worst.surplus)} tint={sum.worst.surplus < 0 ? C.bad : undefined} />
        </div>
      )}

      {/* ── months ── */}
      <p className="mb-2 mt-5 text-[10px] uppercase tracking-[0.12em]" style={{ color: C.dim }}>
        This month's remainder + 11 ahead · tap a month for its bills
      </p>
      <div className="overflow-hidden rounded-2xl" style={{ border: `1px solid ${C.line}` }}>
        {months.map((m, i) => (
          <MonthRow
            key={m.monthKey}
            m={m}
            first={i === 0}
            open={open === m.monthKey}
            onToggle={() => setOpen(open === m.monthKey ? null : m.monthKey)}
          />
        ))}
      </div>

      {/* The projection against the past it came from. A forecast built from
          recurring bills and a spending dial cannot see anything irregular — a car
          down payment, a vet bill, a flight — so it draws a smooth line through a
          lumpy year and always looks better than what actually happened. Saying
          that out loud is the difference between a projection and a promise. */}
      {actual.length > 0 && (
        <div className="mt-4 rounded-2xl p-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
          <div className="text-[10px] uppercase tracking-[0.11em]" style={{ color: C.dim }}>
            Reality check
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Term label="this projects" value={money(projected) + "/mo"} tint={projected < 0 ? C.bad : C.good} />
            <Term
              label={`you actually averaged (${actual.length} mo)`}
              value={money(actualAvg) + "/mo"}
              tint={actualAvg < 0 ? C.bad : C.good}
            />
          </div>
          <div className="mt-2.5 flex flex-col gap-1">
            {actual.map((m) => (
              <div key={m.monthKey} className="flex items-center gap-2 text-[11px]">
                <span className="w-[52px] shrink-0" style={{ color: C.dim }}>{m.monthKey.slice(5)}/{m.monthKey.slice(2, 4)}</span>
                <span className="h-[3px] flex-1 rounded" style={{ background: C.line }}>
                  <span
                    className="block h-full rounded"
                    style={{
                      width: `${Math.min(100, (Math.abs(m.net) / Math.max(...actual.map((x) => Math.abs(x.net)), 1)) * 100)}%`,
                      background: m.net < 0 ? C.bad : C.good,
                    }}
                  />
                </span>
                <span className="tabular-nums" style={{ color: m.net < 0 ? C.bad : C.dim }}>{money(m.net)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[10.5px] leading-relaxed" style={{ color: C.dim }}>
            {actualAvg < projected
              ? "The projection runs ahead of your real months because it only knows recurring bills and the spending dial. It cannot see a car down payment, a vet bill or a flight — and those are the months that decide a year."
              : "Your real months are running at or above the projection."}
          </p>
        </div>
      )}

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: C.dim }}>
        The big number is the LOWEST your account gets that month, not the surplus. They are
        different questions: a surplus is income minus outgoings inside one calendar month, but rent
        lands on the 1st out of the paycheck from the 31st before — so a month can show money left
        over that is already spoken for three days later. The running balance carries across that
        boundary; the surplus cannot. Both dials are what-ifs and nothing here is saved.
      </p>
    </div>
  );
}

function Term({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <span className="flex flex-col">
      <span className="text-[8.5px] uppercase tracking-[0.1em]">{label}</span>
      <span className="text-[15px] font-bold tabular-nums" style={{ color: tint ?? C.ink }}>{value}</span>
    </span>
  );
}

function Stat({ k, v, tint }: { k: string; v: string; tint?: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: C.card, border: `1px solid ${C.line}` }}>
      <div className="text-[9.5px] uppercase tracking-[0.11em]" style={{ color: C.dim }}>{k}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums" style={{ color: tint ?? C.ink }}>{v}</div>
    </div>
  );
}

function MonthRow({
  m, first, open, onToggle,
}: {
  m: ForecastMonth; first: boolean; open: boolean; onToggle: () => void;
}) {
  const bad = m.surplus < 0;
  return (
    <div style={{ borderTop: first ? "none" : `1px solid ${C.line}`, background: C.card }}>
      <button onClick={onToggle} className="flex w-full items-center gap-3 px-3.5 py-3 text-left active:opacity-70">
        {/* The current month is counted from today forward, not whole, so it says
            so — otherwise "Aug 26" beside eleven full months invites comparing a
            fraction of a month against a whole one. */}
        <span className="w-[70px] shrink-0 text-[13px] font-semibold">
          {m.partial ? `rest of ${m.label.split(" ")[0]}` : m.label}
        </span>
        <span className="flex-1 text-[11px]" style={{ color: C.dim }}>
          {m.low
            ? <>surplus {money(m.surplus)} · dips {money(m.low.balance)} on the {m.low.day}</>
            : <>in {money(m.income)} · out {money(m.bills + m.spend)}</>}
          {m.incomeEvents > 4 && <span style={{ color: C.good }}> · extra check</span>}
          {m.cardCleared && <span style={{ color: C.accent }}> · card cleared</span>}
        </span>
        {/* The headline figure is the LOW POINT when we can compute it — what the
            account actually bottoms out at — not the surplus, which counts a
            paycheck without the rent it is already spoken for. */}
        <span className="text-[15px] font-bold tabular-nums"
              style={{ color: m.low ? (m.low.balance < 0 ? C.bad : m.low.balance < 300 ? C.warm : C.good) : (bad ? C.bad : C.good) }}>
          {money(m.low ? m.low.balance : m.surplus)}
        </span>
        <ChevronDown
          size={15}
          style={{ color: C.dim, transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }}
        />
      </button>
      {open && (
        <div className="px-3.5 pb-3" style={{ background: C.bg }}>
          {m.lines.map((l) => (
            <div key={l.name} className="flex justify-between py-1 text-[12px]">
              <span style={{ color: C.dim }}>{l.name}</span>
              <span className="tabular-nums" style={{ color: C.ink }}>{money(l.amount)}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t pt-1.5 text-[12px] font-semibold" style={{ borderColor: C.line }}>
            <span style={{ color: C.dim }}>variable spending</span>
            <span className="tabular-nums">{money(m.spend)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
