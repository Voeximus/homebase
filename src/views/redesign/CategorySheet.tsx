import { X } from "lucide-react";
import { catColor, catIcon } from "../../lib/catColor";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface EnvelopeVM {
  label: string;
  catId: string;
  spent: number;
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
  const barColor = over ? "#f0556e" : near ? "#e3b341" : c;
  const left = vm.target - vm.spent;

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
          borderTop: `2px solid ${c}`,
          borderRadius: "24px 24px 0 0",
          padding: "14px 16px 24px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3.5 h-1 w-10 rounded-full" style={{ background: "#2a3441" }} />

        <div className="mb-3.5 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: c + "26", color: c }}
          >
            <Icon size={19} />
          </span>
          <div className="flex-1 text-[18px] font-bold text-bone">{vm.label}</div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        <div
          className="mb-3.5 rounded-2xl p-3.5"
          style={{ background: "#141a24", border: "1px solid #232d3a" }}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px]" style={{ color: "#8b97a6" }}>
              Spent this month
            </span>
            <span className="text-[15px] font-bold text-bone">
              {money2(vm.spent)} <span style={{ color: "#6b7686", fontWeight: 400 }}>/ {money2(vm.target)}</span>
            </span>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full" style={{ background: "#222b38" }}>
            <div className="h-full" style={{ width: `${pct}%`, background: barColor }} />
          </div>
          <div className="mt-1.5 text-[11.5px] font-medium" style={{ color: barColor }}>
            {Math.round(pct)}% used · {over ? `${money2(-left)} over` : `${money2(left)} left`}
          </div>
        </div>

        {vm.txns.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: "#7e8a98" }}>
            Nothing in this category yet.
          </p>
        ) : (
          <div className="flex flex-col">
            {vm.txns.map((t) => (
              <button
                key={t.id}
                onClick={() => onTxn?.(t.id)}
                className="flex w-full items-center gap-3 py-2.5 text-left"
                style={{ borderBottom: "1px solid #1b232e" }}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: c + "26", color: c }}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-bone">{t.name}</div>
                  <div className="text-[11px]" style={{ color: "#7e8a98" }}>
                    {t.dateLabel} · tap to recategorize
                  </div>
                </div>
                <span className="text-[13.5px] font-semibold text-bone">{money2(t.amount)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
