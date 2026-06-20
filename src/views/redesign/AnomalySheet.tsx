import { AlertTriangle, Check, X } from "lucide-react";
import { catColor, catIcon } from "../../lib/catColor";
import { t } from "../../lib/i18n";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface AnomalyRow {
  id: string;
  merchant: string;
  catId: string;
  catLabel: string;
  amount: number;
  ratio: number;
}

// A dedicated, actionable review of the "unusual purchase" flags — each charge
// can be recategorized OR dismissed (acknowledged) right here. A dismissed charge
// never re-flags, so the notification is a real action, not a redirect.
export function AnomalySheet({
  open,
  onClose,
  anomalies,
  onDismiss,
  onTxn,
}: {
  open: boolean;
  onClose: () => void;
  anomalies: AnomalyRow[];
  onDismiss: (id: string) => void;
  onTxn: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto"
        style={{ background: "#0f141c", border: "1px solid #232d3a", borderTop: "2px solid #e3b341", borderRadius: "22px", padding: "16px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "#2a2416", color: "#e3b341" }}>
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-bone">{t("Unusual purchases")}</div>
            <div className="text-[12px]" style={{ color: "#8b97a6" }}>
              {t("Bigger than your usual for the category. Review, then dismiss.")}
            </div>
          </div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        {anomalies.length === 0 ? (
          <div className="py-8 text-center">
            <Check size={26} style={{ color: "#46d18a" }} className="mx-auto" />
            <p className="mt-2 text-[13.5px] text-bone">{t("All clear — nothing unusual.")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {anomalies.map((a) => {
              const col = catColor(a.catId);
              const Icon = catIcon(a.catId);
              return (
                <div key={a.id} className="rounded-xl p-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
                  <button onClick={() => onTxn(a.id)} className="flex w-full items-center gap-3 text-left">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]" style={{ background: col + "26", color: col }}>
                      <Icon size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-bone">{a.merchant}</div>
                      <div className="text-[11.5px]" style={{ color: "#e3b341" }}>
                        {t("{x}× your usual {cat}", { x: a.ratio.toFixed(1), cat: a.catLabel })}
                      </div>
                    </div>
                    <span className="num text-[14px] font-bold text-bone">{money2(a.amount)}</span>
                  </button>
                  <div className="mt-2 flex gap-2">
                    <button onClick={() => onTxn(a.id)} className="flex-1 rounded-lg py-2 text-[12.5px] font-semibold" style={{ background: "#0e2230", color: "#34c5e8" }}>
                      {t("Recategorize")}
                    </button>
                    <button onClick={() => onDismiss(a.id)} className="flex-1 rounded-lg py-2 text-[12.5px] font-semibold" style={{ background: "#13211a", color: "#46d18a" }}>
                      {t("Looks fine — dismiss")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
