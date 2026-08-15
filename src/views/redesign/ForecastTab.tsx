import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Debt, Recurring, Transaction } from "../../types";
import { forecast, summarize, type ForecastMonth } from "../../lib/forecast";

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
  recurring, transactions, debts,
}: {
  recurring: Recurring[];
  transactions: Transaction[];
  debts: Debt[];
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

  const [cardPay, setCardPay] = useState(() => Math.round(cardRow?.amount ?? 134));
  const [carPay, setCarPay] = useState(0);
  const [cycleSpend, setCycleSpend] = useState(700);
  const [open, setOpen] = useState<string | null>(null);

  const startMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  const months = useMemo(
    () =>
      forecast(recurring, transactions, debts, startMonth, 12, {
        cardPay, carPay, cycleSpend, cardDebtId: cardDebt?.id,
      }),
    [recurring, transactions, debts, startMonth, cardPay, carPay, cycleSpend, cardDebt],
  );
  const sum = useMemo(() => summarize(months), [months]);
  const next = months[1] ?? months[0];

  const minCard = Math.round(cardDebt?.minPayment ?? 25);

  return (
    <div className="px-4 pb-8 pt-3" style={{ background: C.bg, color: C.ink }}>
      {/* ── dials ── */}
      <div className="rounded-2xl p-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
        <div className="flex flex-wrap gap-x-5 gap-y-4">
          <Dial
            label="To the card" value={cardPay} min={minCard} max={1500} step={1}
            onChange={setCardPay} display={money(cardPay)} tint={C.warm}
          />
          <Dial
            label="Car payment" value={carPay} min={0} max={600} step={5}
            onChange={setCarPay} display={carPay ? money(carPay) : "none"} tint={C.accent}
          />
          <Dial
            label="Spending / cycle" value={cycleSpend} min={300} max={1400} step={5}
            onChange={setCycleSpend} display={money(cycleSpend)} tint={C.good}
          />
        </div>

        {/* the equation, spelled out — surplus is never just a word */}
        {next && (
          <div
            className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-[11px]"
            style={{ background: C.bg, color: C.dim }}
          >
            <Term label="income" value={money(next.income)} />
            <span style={{ color: C.line }}>−</span>
            <Term label="bills" value={money(next.bills)} />
            <span style={{ color: C.line }}>−</span>
            <Term label="spending" value={money(next.spend)} />
            <span style={{ color: C.line }}>=</span>
            <Term
              label={next.surplus < 0 ? "short" : "surplus"}
              value={money(next.surplus)}
              tint={next.surplus < 0 ? C.bad : C.good}
            />
          </div>
        )}
      </div>

      {/* ── headline ── */}
      {sum && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Stat k="Typical month" v={money(sum.steady)} tint={sum.steady < 0 ? C.bad : C.good} />
          <Stat
            k={sum.clearsOn ? "Card paid off" : "Card not cleared"}
            v={sum.clearsOn ?? "in 12 mo"}
            tint={sum.clearsOn ? C.accent : C.warm}
          />
          <Stat k={`Best · ${sum.best.label}`} v={money(sum.best.surplus)} />
          <Stat k={`Tightest · ${sum.worst.label}`} v={money(sum.worst.surplus)} tint={sum.worst.surplus < 0 ? C.bad : undefined} />
        </div>
      )}

      {/* ── months ── */}
      <p className="mb-2 mt-5 text-[10px] uppercase tracking-[0.12em]" style={{ color: C.dim }}>
        Next 12 months · tap a month for its bills
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

      <p className="mt-4 text-[11px] leading-relaxed" style={{ color: C.dim }}>
        Surplus is income minus bills minus spending — what isn't already committed, after the
        card payment. The dials are what-ifs; nothing here is saved. Bills come from your recurring
        rows, so a bill that starts or ends on a date shows up in the right months on its own.
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
        <span className="w-[52px] shrink-0 text-[13px] font-semibold">{m.label}</span>
        <span className="flex-1 text-[11px]" style={{ color: C.dim }}>
          in {money(m.income)} · out {money(m.bills + m.spend)}
          {m.incomeEvents > 4 && <span style={{ color: C.good }}> · extra check</span>}
          {m.cardCleared && <span style={{ color: C.accent }}> · card cleared</span>}
        </span>
        <span className="text-[15px] font-bold tabular-nums" style={{ color: bad ? C.bad : C.good }}>
          {money(m.surplus)}
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
              <span style={{ color: l.synthetic ? C.accent : C.dim }}>
                {l.name}
                {l.synthetic && " (what-if)"}
              </span>
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
