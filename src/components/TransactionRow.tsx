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
        <p className="truncate font-medium text-bone">
          {txn.description || cat.name}
        </p>
        <p className="truncate text-xs text-taupe">{cat.name}</p>
      </div>
      <p
        className={`num shrink-0 font-semibold tabular-nums ${
          income ? "text-mint" : "text-bone"
        }`}
      >
        {income ? "+" : "−"}
        {formatMoney(txn.amount).replace("−", "")}
      </p>
    </button>
  );
}
