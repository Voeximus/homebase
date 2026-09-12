import { X } from "lucide-react";
import { catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface EnvelopeVM {
  key: string; // the BudgetLine key — how FinanceTabs looks one up
  label: string;
  catId: string;
  spent: number;
  /** How much of `spent` the bank is still holding rather than settled. Shown so
   *  a bar driven by a big pending charge reads as provisional, not final — a
   *  restaurant tip adjustment can still move it by a few dollars. */
  pending: number;
  target: number;
  txns: { id: string; name: string; dateLabel: string; amount: number }[];
}

// The bento category drill-in: tap a budget category → its transactions, with
// the spend bar and vibrant chips (replaces the old graphite EnvelopeSheet).
export function CategorySheet({
  vm,
  open,
  onClose,
  onTxn,
}: {
  vm: EnvelopeVM | null;
  open: boolean;
  onClose: () => void;
  onTxn?: (id: string) => void;
}) {
  if (!open || !vm) return null;
  const c = catColor(vm.catId);
  const Icon = catIcon(vm.catId);
  const pct = vm.target > 0 ? Math.min(100, (vm.spent / vm.target) * 100) : 0;
  const over = vm.spent > vm.target;
  const near = !over && pct > 80;
  const barColor = over ? "#f0645c" : near ? "#e9b23c" : c;
  const left = vm.target - vm.spent;

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
          borderTop: `2px solid ${c}`,
          borderRadius: "22px",
          padding: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >

        <div className="mb-3.5 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: c + "26", color: c }}
          >
            <Icon size={19} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">{vm.label}</div>
          <button onClick={onClose} style={{ color: "#8b96a5" }}>
            <X size={20} />
          </button>
        </div>

        <div
          className="mb-3.5 rounded-2xl p-3.5"
          style={{ background: "#141a23", border: "1px solid #222b38" }}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px]" style={{ color: "#8b96a5" }}>
              {t("Spent this month")}
            </span>
            <span className="text-[15px] font-bold text-bone">
              {money2(vm.spent)} <span style={{ color: "#8b96a5", fontWeight: 400 }}>/ {money2(vm.target)}</span>
            </span>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full" style={{ background: "#2e3947" }}>
            <div className="h-full" style={{ width: `${pct}%`, background: barColor }} />
          </div>
          <div className="mt-1.5 text-[11.5px] font-medium" style={{ color: barColor }}>
            {t("{pct}% used", { pct: Math.round(pct) })} · {over ? t("{amount} over", { amount: money2(-left) }) : t("{amount} left", { amount: money2(left) })}
          </div>
          {/* Pending charges COUNT toward the bar — the bank has already taken that
              money out of the balance shown on the Home tab, so leaving them out
              made the budget read low by exactly what had not cleared yet. But a
              held amount can still move (a restaurant tip adjustment), so say how
              much of this bar is still settling rather than presenting it as
              final. Without this line a bar at 346% just looks broken. */}
          {vm.pending > 0 && (
            <div className="mt-1 text-[11px]" style={{ color: "#8b96a5" }}>
              {t("{amount} of this is still processing at the bank", { amount: money2(vm.pending) })}
            </div>
          )}
        </div>

        {vm.txns.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: "#8b96a5" }}>
            {t("Nothing in this category yet.")}
          </p>
        ) : (
          <div className="flex flex-col">
            {vm.txns.map((tx) => (
              <button
                key={tx.id}
                onClick={() => onTxn?.(tx.id)}
                className="flex w-full items-center gap-3 py-2.5 text-left"
                style={{ borderBottom: "1px solid #222b38" }}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: c + "26", color: c }}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-bone">{tx.name}</div>
                  <div className="text-[11px]" style={{ color: "#8b96a5" }}>
                    {tx.dateLabel} · {t("tap to recategorize")}
                  </div>
                </div>
                <span className="text-[13.5px] font-semibold text-bone">{money2(tx.amount)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
