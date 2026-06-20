import { useState } from "react";
import { X, Trash2, Check } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { catColor, catIcon } from "../../lib/catColor";
import { merchantKey } from "../../lib/categorize";
import { t } from "../../lib/i18n";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// One-transaction recategorize + teach bench — opened by tapping any single
// transaction (Activity row, category drill-in). Bento, centered.
export function TxnSheet({
  txnId,
  open,
  onClose,
}: {
  txnId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const {
    data,
    setTransactionCategory,
    saveMerchantRule,
    makeRecurringBill,
    excludeFromBudget,
    deleteTransaction,
  } = useStore();
  const [remember, setRemember] = useState(true);
  const txn = txnId ? data.transactions.find((t) => t.id === txnId) : null;
  if (!open || !txn) return null;
  const expenseCats = data.categories.filter((c) => c.type === "expense" || c.type === "both");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,.55)" }}
      onClick={onClose}
    >
      <div
        className="max-h-[86vh] w-full max-w-[420px] overflow-y-auto"
        style={{
          background: "#0f141c",
          border: "1px solid #232d3a",
          borderTop: `2px solid ${catColor(txn.categoryId)}`,
          borderRadius: "22px",
          padding: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="break-words text-[15px] font-bold text-bone">
              {txn.description || txn.categoryId}
            </div>
            <div className="mt-0.5 text-[12px]" style={{ color: "#8b97a6" }}>
              {fmtDate(txn.date)} · {money2(txn.amount)}
            </div>
          </div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        <div className="mb-1.5 flex items-center justify-between">
          <span className="eyebrow" style={{ color: "#8b97a6" }}>
            {t("Category")}
          </span>
          <button
            onClick={() => setRemember((r) => !r)}
            className="rounded-full px-2.5 py-1 text-[11px] font-medium transition"
            style={
              remember
                ? { background: "#0e2230", color: "#34c5e8" }
                : { background: "#1b232e", color: "#7e8a98" }
            }
          >
            {remember ? t("✓ Remember merchant") : t("Just this one")}
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {expenseCats.map((c) => {
            const Icon = catIcon(c.id);
            const col = catColor(c.id);
            const on = c.id === txn.categoryId;
            return (
              <button
                key={c.id}
                onClick={async () => {
                  await setTransactionCategory(txn.id, c.id);
                  if (remember)
                    await saveMerchantRule({
                      pattern: merchantKey(txn.description),
                      kind: "variable",
                      categoryId: c.id,
                    });
                  onClose();
                }}
                className="flex flex-col items-center gap-1.5 rounded-xl py-2.5 transition"
                style={{
                  background: on ? col + "26" : "#141a24",
                  border: `1px solid ${on ? col : "#232d3a"}`,
                }}
              >
                <Icon size={18} style={{ color: col }} />
                <span className="text-[9.5px] leading-tight" style={{ color: "#cdd6e0" }}>
                  {c.name}
                </span>
              </button>
            );
          })}
        </div>
        {!remember && (
          <p className="mt-1.5 text-[11px]" style={{ color: "#6b7686" }}>
            {t("Sets only this charge — other charges from this merchant stay as they are.")}
          </p>
        )}

        <div className="mt-3.5 rounded-xl p-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
          <p className="text-[12px] font-semibold text-bone">{t("Repeats every month or year?")}</p>
          <p className="mb-2 text-[11px]" style={{ color: "#8b97a6" }}>
            {t("Make it a bill — it joins your calendar and leaves variable spend.")}
          </p>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                await makeRecurringBill(txn.id, "monthly");
                onClose();
              }}
              className="flex-1 rounded-lg py-2 text-[12.5px] font-semibold"
              style={{ background: "#0e2230", color: "#34c5e8" }}
            >
              {t("Monthly")}
            </button>
            <button
              onClick={async () => {
                await makeRecurringBill(txn.id, "yearly");
                onClose();
              }}
              className="flex-1 rounded-lg py-2 text-[12.5px] font-semibold"
              style={{ background: "#0e2230", color: "#34c5e8" }}
            >
              {t("Yearly")}
            </button>
          </div>
        </div>

        <button
          onClick={async () => {
            await excludeFromBudget(txn.id);
            if (remember) await saveMerchantRule({ pattern: merchantKey(txn.description), kind: "skip" });
            onClose();
          }}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-medium"
          style={{ background: "#161c26", color: "#8b97a6" }}
        >
          <Check size={15} /> {t("Not living spend — skip & exclude")}
        </button>
        <button
          onClick={async () => {
            await deleteTransaction(txn.id);
            onClose();
          }}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-semibold"
          style={{ background: "#2a1518", color: "#f0556e" }}
        >
          <Trash2 size={16} /> {t("Delete transaction")}
        </button>
      </div>
    </div>
  );
}
