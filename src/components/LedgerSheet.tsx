// The full ledger — every transaction, with each row's budget fate made visible
// (→ which envelope it feeds, or why it's excluded), the categorizer's
// low-confidence guesses flagged, and one-tap re-categorize / skip that TEACHES
// the categorizer for every future import. Gino's triage + training bench.
import { useMemo, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import type { Transaction } from "../types";
import { useStore } from "../store/FinanceStore";
import { getCategory } from "../lib/seed";
import { merchantKey } from "../lib/categorize";
import { LEAN_VARIABLE, variableSpentThisMonth } from "../lib/plan";
import { formatMoney, formatDate, monthLabel } from "../lib/format";
import { t } from "../lib/i18n";
import { Button, Sheet, labelClass } from "./ui";

// Which envelope a counted expense lands in (mirrors lineSpent's cats partition).
function envelopeOf(catId: string) {
  return LEAN_VARIABLE.find((l) => l.cats.includes(catId)) ?? null;
}
type Quick = "all" | "counted" | "review";

export function LedgerSheet({
  open,
  onClose,
  txns,
  hasRule,
}: {
  open: boolean;
  onClose: () => void;
  txns: Transaction[]; // already lens-filtered by the caller
  hasRule: (desc: string) => boolean; // a merchant_rule exists for this merchant
}) {
  const {
    data,
    setTransactionCategory,
    saveMerchantRule,
    excludeFromBudget,
    makeRecurringBill,
    deleteTransaction,
  } = useStore();
  const [q, setQ] = useState("");
  const [quick, setQuick] = useState<Quick>("all");
  const [edit, setEdit] = useState<Transaction | null>(null);
  const [remember, setRemember] = useState(true);
  const expenseCats = data.categories.filter((c) => c.type === "expense" || c.type === "both");

  const counts = (tx: Transaction) => tx.type === "expense" && !tx.appliesTo;
  const needsReview = (tx: Transaction) =>
    counts(tx) && (tx.categoryId === "other" || !hasRule(tx.description));

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return txns
      .filter((tx) => (quick === "counted" ? counts(tx) : quick === "review" ? needsReview(tx) : true))
      .filter((tx) => !ql || (tx.description || "").toLowerCase().includes(ql))
      .sort((a, b) =>
        a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txns, q, quick]);

  const groups = useMemo(() => {
    const m = new Map<string, Transaction[]>();
    for (const tx of rows) {
      const k = tx.date.slice(0, 7);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(tx);
    }
    return [...m.entries()];
  }, [rows]);

  const QUICKS: [Quick, string][] = [
    ["all", t("All")],
    ["counted", t("In budget")],
    ["review", t("Needs review")],
  ];

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t("All activity")}>
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-2 rounded-xl border border-edge bg-raised px-3">
            <Search size={15} className="text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("Search activity")}
              className="w-full bg-transparent py-2.5 text-sm text-bone outline-none placeholder:text-faint"
            />
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-raised p-1">
            {QUICKS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setQuick(k)}
                className={`rounded-lg px-2 py-1.5 text-[12px] font-semibold transition ${
                  quick === k ? "bg-bg text-bone shadow-sm" : "text-taupe"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {groups.length === 0 && (
          <p className="py-8 text-center text-sm text-faint">{t("Nothing here.")}</p>
        )}

        {groups.map(([mk, list]) => {
          const counted = variableSpentThisMonth(list, mk);
          return (
            <div key={mk} className="mb-4">
              <div className="sticky top-0 z-10 flex items-center justify-between bg-tile/95 py-1.5 backdrop-blur">
                <p className="eyebrow text-faint">{monthLabel(mk)}</p>
                <p className="num text-[11px] text-taupe">
                  {formatMoney(counted)} {t("counted")}
                </p>
              </div>
              <div className="divide-y divide-edge rounded-xl border border-edge bg-tile">
                {list.map((tx) => {
                  const cat = getCategory(data.categories, tx.categoryId);
                  const acct = data.accounts.find((a) => a.id === tx.accountId);
                  const env = counts(tx) ? envelopeOf(tx.categoryId) : null;
                  const kind = tx.appliesTo?.kind;
                  const review = needsReview(tx);
                  return (
                    <button
                      key={tx.id}
                      onClick={() => {
                        setRemember(true);
                        setEdit(tx);
                      }}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition active:bg-white/5"
                    >
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                        style={{ backgroundColor: cat.color + "33" }}
                      >
                        {cat.icon}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-bone">
                          {tx.description || t(cat.name)}
                        </p>
                        <p className="num truncate text-[11px] text-taupe">
                          {[formatDate(tx.date), acct?.name, t(cat.name)].filter(Boolean).join(" · ")}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {env && (
                            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                              → {t(env.label)}
                            </span>
                          )}
                          {kind && (
                            <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-faint">
                              {t(kind[0].toUpperCase() + kind.slice(1))} · {t("not in budget")}
                            </span>
                          )}
                          {review && (
                            <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] font-medium text-gold">
                              {t("Needs review")}
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className={`num shrink-0 text-[13px] font-semibold tabular-nums ${
                          tx.type === "income" ? "text-mint" : "text-bone"
                        }`}
                      >
                        {tx.type === "income" ? "+" : "−"}
                        {formatMoney(tx.amount).replace("−", "")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </Sheet>

      {/* recategorize + teach — fixing once trains every future import */}
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={t("Categorize")}>
        {edit && (
          <div className="space-y-4">
            <div>
              <p className="break-words text-sm font-medium text-bone">{edit.description}</p>
              <p className="mt-0.5 text-xs text-taupe">
                {formatDate(edit.date)} · {formatMoney(edit.amount)}
              </p>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className={labelClass}>{t("Category")}</label>
                <button
                  onClick={() => setRemember((r) => !r)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                    remember ? "bg-accent/15 text-accent" : "bg-raised text-faint"
                  }`}
                >
                  {remember ? t("✓ Remember merchant") : t("Just this one")}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {expenseCats.map((c) => (
                  <button
                    key={c.id}
                    onClick={async () => {
                      await setTransactionCategory(edit.id, c.id);
                      if (remember)
                        await saveMerchantRule({
                          pattern: merchantKey(edit.description),
                          kind: "variable",
                          categoryId: c.id,
                        });
                      setEdit(null);
                    }}
                    className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 transition ${
                      c.id === edit.categoryId ? "border-accent bg-accent/15" : "border-edge bg-raised"
                    }`}
                  >
                    <span className="text-xl">{c.icon}</span>
                    <span className="text-[10px] leading-tight text-taupe">{t(c.name)}</span>
                  </button>
                ))}
              </div>
              {!remember && (
                <p className="mt-1.5 text-[11px] text-faint">
                  {t(
                    "Sets only this charge — other charges from this merchant stay as they are. (Gas stations, warehouse stores, etc.)",
                  )}
                </p>
              )}
            </div>

            <div className="rounded-xl border border-edge bg-raised p-3">
              <p className="text-[12px] font-semibold text-bone">{t("Repeats every month or year?")}</p>
              <p className="mb-2 text-[11px] text-taupe">
                {t("Make it a bill — it joins your calendar and leaves variable spend.")}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="soft"
                  className="flex-1"
                  onClick={async () => {
                    await makeRecurringBill(edit.id, "monthly");
                    setEdit(null);
                  }}
                >
                  {t("Monthly")}
                </Button>
                <Button
                  variant="soft"
                  className="flex-1"
                  onClick={async () => {
                    await makeRecurringBill(edit.id, "yearly");
                    setEdit(null);
                  }}
                >
                  {t("Yearly")}
                </Button>
              </div>
            </div>

            <button
              onClick={async () => {
                await excludeFromBudget(edit.id);
                if (remember)
                  await saveMerchantRule({ pattern: merchantKey(edit.description), kind: "skip" });
                setEdit(null);
              }}
              className="w-full rounded-xl bg-raised py-2.5 text-sm font-medium text-taupe transition"
            >
              {t("Not living spend — skip & exclude")}
            </button>
            <Button
              variant="danger"
              className="w-full"
              onClick={async () => {
                await deleteTransaction(edit.id);
                setEdit(null);
              }}
            >
              <Trash2 size={18} /> {t("Delete transaction")}
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}
