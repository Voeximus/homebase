import { X, Check, Undo2 } from "lucide-react";
import { t } from "../../lib/i18n";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface OwedItem {
  id: string;
  merchant: string;
  amount: number;
  dateLabel: string;
  note?: string;
  // a single matched payback deposit (its merchant + date), shown so a coincidental
  // same-amount match is obvious before you confirm.
  suggested?: { id: string; label: string };
}
export interface SettledItem {
  id: string;
  merchant: string;
  amount: number;
  dateLabel: string;
}

// "Owed to you" — outstanding reimbursable set-asides (settle each), plus a
// recently-settled list with Undo (so a wrong confirm is recoverable).
export function OwedSheet({
  open,
  onClose,
  owed,
  settled = [],
  onSettle,
  onUnsettle,
}: {
  open: boolean;
  onClose: () => void;
  owed: OwedItem[];
  settled?: SettledItem[];
  onSettle: (reimbursableId: string, creditTxnId?: string) => void;
  onUnsettle?: (reimbursableId: string) => void;
}) {
  if (!open) return null;
  const total = owed.reduce((s, o) => s + o.amount, 0);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] overflow-y-auto rounded-t-[22px] sm:rounded-[22px]"
        style={{ background: "#0f141c", border: "1px solid #232d3a", maxHeight: "86vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div>
            <div className="text-[15px] font-semibold text-bone">{t("Owed to you")}</div>
            <div className="text-[12px]" style={{ color: "#7e8a98" }}>
              {t("{n} set aside · {amount} total", { n: owed.length, amount: money2(total) })}
            </div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5" style={{ background: "#1b2129" }}>
            <X size={16} style={{ color: "#8b97a6" }} />
          </button>
        </div>
        <div className="px-4 pb-6">
          {owed.length === 0 ? (
            <div className="py-8 text-center text-[13px]" style={{ color: "#7e8a98" }}>
              {t("Nothing outstanding.")}
            </div>
          ) : (
            owed.map((o) => (
              <div
                key={o.id}
                className="mb-2 rounded-[14px] border p-3"
                style={{ background: "#121821", borderColor: "#232d3a" }}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-bone">{o.merchant}</div>
                    <div className="text-[11.5px]" style={{ color: "#7e8a98" }}>
                      {o.dateLabel}
                      {o.note ? ` · ${o.note}` : ""}
                    </div>
                  </div>
                  <div className="ml-2 text-[15px] font-bold" style={{ color: "#7fbf6a" }}>
                    {money2(o.amount)}
                  </div>
                </div>
                {o.suggested ? (
                  // A possible match — show WHICH deposit so a coincidence is caught;
                  // neutral styling (not a confident green) since it's amount-based.
                  <button
                    onClick={() => onSettle(o.id, o.suggested!.id)}
                    className="mt-2.5 w-full rounded-lg px-2.5 py-2 text-left text-[12px] font-medium"
                    style={{ background: "#1c2733", color: "#cfe0f0", border: "1px solid #2c3a4a" }}
                  >
                    {t("Possible payback")}:{" "}
                    <span className="font-semibold">{o.suggested.label}</span> — {t("tap to confirm")}
                  </button>
                ) : (
                  <button
                    onClick={() => onSettle(o.id)}
                    className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] font-medium"
                    style={{ background: "#161c26", color: "#8b97a6" }}
                  >
                    <Check size={14} /> {t("Got it back")}
                  </button>
                )}
              </div>
            ))
          )}

          {settled.length > 0 && (
            <>
              <div
                className="mb-1.5 mt-3 px-1 text-[11px] font-medium uppercase tracking-wide"
                style={{ color: "#5e6a78" }}
              >
                {t("Recently settled")}
              </div>
              {settled.map((o) => (
                <div
                  key={o.id}
                  className="mb-1.5 flex items-center justify-between rounded-[12px] px-3 py-2"
                  style={{ background: "#0f141c", border: "1px solid #1b2129" }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px]" style={{ color: "#8b97a6" }}>{o.merchant}</div>
                    <div className="text-[11px]" style={{ color: "#5e6a78" }}>
                      {o.dateLabel} · {money2(o.amount)}
                    </div>
                  </div>
                  {onUnsettle && (
                    <button
                      onClick={() => onUnsettle(o.id)}
                      className="ml-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px]"
                      style={{ background: "#1b2129", color: "#8b97a6" }}
                    >
                      <Undo2 size={13} /> {t("Undo")}
                    </button>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
