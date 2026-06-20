import { useEffect, useState } from "react";
import { X, Trash2, Check, SplitSquareHorizontal, Plus, ChevronLeft } from "lucide-react";
import { useStore } from "../../store/FinanceStore";
import { catColor, catIcon } from "../../lib/catColor";
import { merchantKey } from "../../lib/categorize";
import { t } from "../../lib/i18n";
import type { Transaction, TxnSplit } from "../../types";

const money2 = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const round2 = (n: number) => Math.round(n * 100) / 100;

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
    setTransactionSplits,
    saveMerchantRule,
    makeRecurringBill,
    excludeFromBudget,
    deleteTransaction,
  } = useStore();
  const [remember, setRemember] = useState(true);
  const [splitting, setSplitting] = useState(false);
  // reset the split editor whenever a different transaction (or none) is opened
  useEffect(() => {
    setSplitting(false);
  }, [txnId, open]);

  const txn = txnId ? data.transactions.find((t) => t.id === txnId) : null;
  if (!open || !txn) return null;
  const expenseCats = data.categories.filter((c) => c.type === "expense" || c.type === "both");
  const canSplit = txn.type === "expense" && !txn.appliesTo;
  const hasSplits = !!txn.splits && txn.splits.length > 1;
  const catName = (id: string) => data.categories.find((c) => c.id === id)?.name ?? id;

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
          {splitting && (
            <button onClick={() => setSplitting(false)} style={{ color: "#6b7686" }} aria-label="Back">
              <ChevronLeft size={20} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="break-words text-[15px] font-bold text-bone">
              {splitting ? t("Split transaction") : txn.description || txn.categoryId}
            </div>
            <div className="mt-0.5 text-[12px]" style={{ color: "#8b97a6" }}>
              {fmtDate(txn.date)} · {money2(txn.amount)}
            </div>
          </div>
          <button onClick={onClose} style={{ color: "#6b7686" }}>
            <X size={20} />
          </button>
        </div>

        {splitting ? (
          <SplitEditor
            txn={txn}
            cats={expenseCats}
            onSave={async (splits) => {
              await setTransactionSplits(txn.id, splits);
              onClose();
            }}
          />
        ) : (
          <>
            {/* current split summary (when this txn is already split) */}
            {hasSplits && (
              <div className="mb-3 rounded-xl p-3" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="eyebrow flex items-center gap-1.5" style={{ color: "#8b97a6" }}>
                    <SplitSquareHorizontal size={13} /> {t("Split across {n} categories", { n: txn.splits!.length })}
                  </span>
                  <button
                    onClick={() => setTransactionSplits(txn.id, null)}
                    className="text-[11px] font-medium"
                    style={{ color: "#f0556e" }}
                  >
                    {t("Remove split")}
                  </button>
                </div>
                {txn.splits!.map((s, i) => {
                  const col = catColor(s.categoryId);
                  const Icon = catIcon(s.categoryId);
                  return (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <Icon size={14} style={{ color: col }} />
                      <span className="flex-1 text-[12.5px] text-bone">{catName(s.categoryId)}</span>
                      <span className="num text-[12.5px] font-semibold text-bone">{money2(s.amount)}</span>
                    </div>
                  );
                })}
                <button
                  onClick={() => setSplitting(true)}
                  className="mt-2 w-full rounded-lg py-2 text-[12.5px] font-semibold"
                  style={{ background: "#0e2230", color: "#34c5e8" }}
                >
                  {t("Edit split")}
                </button>
              </div>
            )}

            {!hasSplits && (
              <>
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
              </>
            )}

            {/* split entry point — a mixed purchase across categories */}
            {canSplit && !hasSplits && (
              <button
                onClick={() => setSplitting(true)}
                className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[13px] font-semibold"
                style={{ background: "#141a24", border: "1px solid #232d3a", color: "#34c5e8" }}
              >
                <SplitSquareHorizontal size={15} /> {t("Split across categories")}
              </button>
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
          </>
        )}
      </div>
    </div>
  );
}

// ── Split editor ───────────────────────────────────────────────────────────────
// Allocate a transaction's total across categories. Each row is a category + a
// dollar amount; the running sum must land exactly on the total before it saves.
type SplitRow = { categoryId: string; amount: string };

function SplitEditor({
  txn,
  cats,
  onSave,
}: {
  txn: Transaction;
  cats: { id: string; name: string }[];
  onSave: (splits: TxnSplit[]) => void;
}) {
  const total = txn.amount;
  const firstUnused = (used: string[]) => cats.find((c) => !used.includes(c.id))?.id ?? cats[0].id;
  const [rows, setRows] = useState<SplitRow[]>(() =>
    txn.splits && txn.splits.length > 1
      ? txn.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount.toFixed(2) }))
      : [
          { categoryId: txn.categoryId, amount: total.toFixed(2) },
          { categoryId: firstUnused([txn.categoryId]), amount: "" },
        ],
  );

  const amt = (r: SplitRow) => parseFloat(r.amount) || 0;
  const sum = round2(rows.reduce((a, r) => a + amt(r), 0));
  const diff = round2(total - sum);
  const positive = rows.filter((r) => amt(r) > 0);
  const valid = Math.abs(diff) < 0.005 && positive.length >= 2;

  const setRow = (i: number, patch: Partial<SplitRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((rs) => [...rs, { categoryId: firstUnused(rs.map((r) => r.categoryId)), amount: "" }]);
  const removeRow = (i: number) => setRows((rs) => (rs.length > 2 ? rs.filter((_, j) => j !== i) : rs));
  // drop the remaining balance onto the row the user is filling
  const fillRemainder = (i: number) => setRow(i, { amount: round2(amt(rows[i]) + diff).toFixed(2) });

  const save = () => {
    if (!valid) return;
    // merge same-category rows, drop empties
    const merged = new Map<string, number>();
    for (const r of rows) {
      const a = amt(r);
      if (a > 0) merged.set(r.categoryId, round2((merged.get(r.categoryId) ?? 0) + a));
    }
    onSave([...merged.entries()].map(([categoryId, amount]) => ({ categoryId, amount })));
  };

  return (
    <div>
      <p className="mb-2.5 text-[12px]" style={{ color: "#8b97a6" }}>
        {t("Allocate {total} across categories — for a mixed purchase.", { total: money2(total) })}
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((r, i) => {
          const col = catColor(r.categoryId);
          return (
            <div key={i} className="flex items-center gap-2 rounded-xl p-2" style={{ background: "#141a24", border: "1px solid #232d3a" }}>
              <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: col }} />
              <div className="relative min-w-0 flex-1">
                <select
                  value={r.categoryId}
                  onChange={(e) => setRow(i, { categoryId: e.target.value })}
                  className="w-full appearance-none rounded-lg bg-transparent py-1.5 pl-1 pr-5 text-[13px] font-medium text-bone outline-none"
                >
                  {cats.map((c) => (
                    <option key={c.id} value={c.id} style={{ background: "#0f141c" }}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-0.5 rounded-lg px-2 py-1.5" style={{ background: "#0f141c", border: "1px solid #232d3a" }}>
                <span className="text-[12px]" style={{ color: "#5f6a78" }}>$</span>
                <input
                  value={r.amount}
                  inputMode="decimal"
                  onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^0-9.]/g, "") })}
                  placeholder="0.00"
                  className="num w-[62px] bg-transparent text-right text-[14px] font-semibold text-bone outline-none placeholder:text-[#5f6a78]"
                />
              </div>
              {rows.length > 2 && (
                <button onClick={() => removeRow(i)} style={{ color: "#6b7686" }} aria-label="Remove split row">
                  <X size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={addRow}
        disabled={rows.length >= cats.length}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] font-semibold transition"
        style={{ background: "#141a24", border: "1px solid #232d3a", color: "#34c5e8", opacity: rows.length >= cats.length ? 0.4 : 1 }}
      >
        <Plus size={14} /> {t("Add category")}
      </button>

      {/* running total — green when it balances, amber/red while off */}
      <button
        onClick={() => {
          if (Math.abs(diff) >= 0.005) {
            const target = rows.findIndex((r) => amt(r) === 0);
            fillRemainder(target === -1 ? rows.length - 1 : target);
          }
        }}
        className="mt-3 flex w-full items-center justify-between rounded-xl px-3 py-2.5"
        style={{
          background: valid ? "#102a1d" : "#241a12",
          border: `1px solid ${valid ? "#1f6f47" : "#5a4420"}`,
        }}
      >
        <span className="text-[12px] font-medium" style={{ color: valid ? "#46d18a" : "#e0a64e" }}>
          {valid
            ? t("Balanced")
            : diff > 0
              ? t("{amt} left to assign — tap to fill", { amt: money2(diff) })
              : t("{amt} over the total", { amt: money2(-diff) })}
        </span>
        <span className="num text-[13px] font-semibold" style={{ color: valid ? "#46d18a" : "#e0a64e" }}>
          {money2(sum)} / {money2(total)}
        </span>
      </button>

      <button
        onClick={save}
        disabled={!valid}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl py-3 text-[14px] font-semibold text-white transition active:scale-[0.98]"
        style={{ background: "linear-gradient(150deg,#10b981,#06b6d4)", opacity: valid ? 1 : 0.4 }}
      >
        <Check size={16} /> {t("Save split")}
      </button>
    </div>
  );
}
