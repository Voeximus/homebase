import type { Category, Transaction } from "../types";
import { getCategory } from "../lib/seed";
import { formatMoney } from "../lib/format";

export function TransactionRow({
  txn,
  categories,
  onClick,
}: {
  txn: Transaction;
  categories: Category[];
  onClick?: () => void;
}) {
  const cat = getCategory(categories, txn.categoryId);
  const income = txn.type === "income";
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition active:bg-white/5"
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
        style={{ backgroundColor: cat.color + "33" }}
      >
        {cat.icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-white">
          {txn.description || cat.name}
        </p>
        <p className="truncate text-xs text-slate-400">{cat.name}</p>
      </div>
      <p
        className={`shrink-0 font-semibold tabular-nums ${
          income ? "text-emerald-400" : "text-slate-200"
        }`}
      >
        {income ? "+" : "−"}
        {formatMoney(txn.amount).replace("−", "")}
      </p>
    </button>
  );
}
