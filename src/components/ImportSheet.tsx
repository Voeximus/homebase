import { useMemo, useRef, useState } from "react";
import { FileUp, Check } from "lucide-react";
import { useStore } from "../store/FinanceStore";
import { formatMoney } from "../lib/format";
import { getCategory } from "../lib/seed";
import {
  buildImportPlan,
  clarifyQuestions,
  parseBofaCsv,
  planTotals,
  type ClarifyQuestion,
  type ImportPlan,
} from "../lib/importStatement";
import type { LearnedRules } from "../lib/categorize";
// pdf.js is heavy — load it only when a PDF is actually chosen (code-split).
import { Button, labelClass, Sheet } from "./ui";

export function ImportSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data, commitImport, saveMerchantRule } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [questions, setQuestions] = useState<ClarifyQuestion[]>([]);
  const [clarifyIdx, setClarifyIdx] = useState(0);
  const [clarified, setClarified] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const expenseCats = useMemo(
    () => data.categories.filter((c) => c.type === "expense" || c.type === "both"),
    [data.categories],
  );

  // Rules the app has already learned, keyed by merchant — checked first.
  const learned = useMemo<LearnedRules>(() => {
    const m: LearnedRules = {};
    for (const r of data.merchantRules)
      m[r.pattern] = { kind: r.kind, categoryId: r.categoryId, billName: r.billName };
    return m;
  }, [data.merchantRules]);

  function reset() {
    setPlan(null);
    setQuestions([]);
    setClarifyIdx(0);
    setClarified(true);
    setFileName(null);
    setError(null);
    setResult(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setFileName(file.name);
    setParsing(true);
    try {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      const rows = isPdf
        ? await (await import("../lib/importPdf")).parseBofaPdf(file)
        : parseBofaCsv(await file.text());
      if (!rows.length) {
        setPlan(null);
        setError(
          isPdf
            ? "Couldn't read transactions from that PDF. Use a Bank of America “Print Transaction Details” PDF, or the CSV export."
            : "That doesn't look like a Bank of America CSV export. Download from BofA → Statements & Documents → Download (CSV).",
        );
        return;
      }
      const p = buildImportPlan(rows, data.recurring, data.transactions, learned);
      const qs = clarifyQuestions(p);
      setPlan(p);
      setQuestions(qs);
      setClarifyIdx(0);
      setClarified(qs.length === 0); // no questions → straight to the preview
    } catch (err) {
      console.error(err);
      setError("Couldn't read that file. Try the BofA CSV export instead.");
    } finally {
      setParsing(false);
    }
  }

  function setVariable(idx: number, patch: Partial<ImportPlan["variable"][number]>) {
    setPlan((p) =>
      p ? { ...p, variable: p.variable.map((v, i) => (i === idx ? { ...v, ...patch } : v)) } : p,
    );
  }
  function setBill(idx: number, patch: Partial<ImportPlan["bills"][number]>) {
    setPlan((p) =>
      p ? { ...p, bills: p.bills.map((b, i) => (i === idx ? { ...b, ...patch } : b)) } : p,
    );
  }

  // Answer one clarify card: file every transaction from this merchant, save a
  // permanent rule, and advance. choice is a category id, or "skip".
  async function answerClarify(q: ClarifyQuestion, choice: string) {
    setPlan((p) =>
      p
        ? {
            ...p,
            variable: p.variable.map((v) =>
              v.merchant === q.merchant
                ? choice === "skip"
                  ? { ...v, include: false, lowConfidence: false }
                  : { ...v, appCategory: choice, lowConfidence: false }
                : v,
            ),
          }
        : p,
    );
    await saveMerchantRule(
      choice === "skip"
        ? { pattern: q.merchant, kind: "skip" }
        : { pattern: q.merchant, kind: "variable", categoryId: choice },
    );
    if (clarifyIdx >= questions.length - 1) setClarified(true);
    else setClarifyIdx((i) => i + 1);
  }

  // The categories offered on a clarify card (the common living-spend buckets).
  const CLARIFY_CATS = ["groceries", "dining", "transport", "shopping", "health", "subscriptions", "other"];

  async function commit() {
    if (!plan) return;
    setBusy(true);
    const items: {
      date: string;
      amount: number;
      categoryId: string;
      description: string;
      appliesTo?: import("../types").AppliesTo;
    }[] = [];
    for (const v of plan.variable) {
      if (!v.include) continue;
      items.push({ date: v.date, amount: v.amount, categoryId: v.appCategory, description: v.description });
    }
    for (const b of plan.bills) {
      if (!b.include) continue;
      const rec = data.recurring.find((r) => r.id === b.recurringId);
      items.push({
        date: b.date,
        amount: b.amount,
        categoryId: rec?.categoryId ?? "other",
        description: b.billName + " (already paid)",
        appliesTo: { kind: "bill", recurringId: b.recurringId, monthKey: b.monthKey, day: b.day, settled: true },
      });
    }
    const r = await commitImport(items);
    setBusy(false);
    if (r.ok) {
      setResult(`Imported ${r.count} entries — your spend and paid bills are updated.`);
      setPlan(null);
    } else {
      setError("Import failed — check the console. Nothing was changed.");
    }
  }

  const totals = plan ? planTotals(plan) : null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import bank statement"
    >
      <div className="space-y-4">
        {!plan && !result && (
          <>
            <p className="text-sm text-slate-400">
              Drop in a Bank of America statement — a CSV export or a “Print
              Transaction Details” PDF. Every line is auto-sorted using your own
              history: spending feeds the budget, bills get marked paid, income and
              transfers are skipped. You review before anything saves.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.pdf,text/csv,application/pdf"
              onChange={onFile}
              className="hidden"
            />
            <Button
              className="w-full"
              disabled={parsing}
              onClick={() => fileRef.current?.click()}
            >
              <FileUp size={18} /> {parsing ? "Reading…" : "Choose CSV or PDF"}
            </Button>
            {fileName && parsing && (
              <p className="text-xs text-slate-500">Reading {fileName}…</p>
            )}
          </>
        )}

        {error && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>
        )}

        {result && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              <Check size={16} /> {result}
            </p>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Done
            </Button>
          </div>
        )}

        {/* Clarify step — one tap per unknown merchant, right after import */}
        {plan && !clarified && questions[clarifyIdx] && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white">Quick questions</p>
              <span className="text-xs text-slate-400">
                {clarifyIdx + 1} of {questions.length}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-violet-500 transition-all duration-300"
                style={{ width: `${(clarifyIdx / questions.length) * 100}%` }}
              />
            </div>
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
              <p className="text-xs text-slate-400">New to me — what is this?</p>
              <p className="mt-1 truncate text-base font-semibold text-white">
                {questions[clarifyIdx].sampleDesc}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {questions[clarifyIdx].count} transaction
                {questions[clarifyIdx].count > 1 ? "s" : ""} ·{" "}
                {formatMoney(questions[clarifyIdx].total)} total
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {CLARIFY_CATS.map((cid) => {
                  const c = getCategory(data.categories, cid);
                  return (
                    <button
                      key={cid}
                      onClick={() => answerClarify(questions[clarifyIdx], cid)}
                      className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-sm text-white transition hover:border-violet-500 hover:bg-violet-500/10"
                    >
                      <span className="text-lg">{c.icon}</span> {c.name}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => answerClarify(questions[clarifyIdx], "skip")}
                className="mt-2 w-full rounded-xl bg-white/5 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10"
              >
                Skip — don't track this
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              I'll remember your answer and never ask about this one again.
            </p>
          </div>
        )}

        {plan && clarified && totals && (
          <>
            {/* Summary */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-white/5 py-3">
                <p className="text-xs text-slate-400">Spending</p>
                <p className="text-sm font-bold text-white">{formatMoney(totals.variableTotal)}</p>
                <p className="text-[10px] text-slate-500">{totals.variableCount} items</p>
              </div>
              <div className="rounded-xl bg-violet-600/15 py-3">
                <p className="text-xs text-violet-200">Bills paid</p>
                <p className="text-sm font-bold text-white">{totals.billCount}</p>
                <p className="text-[10px] text-slate-500">marked</p>
              </div>
              <div className="rounded-xl bg-white/5 py-3">
                <p className="text-xs text-slate-400">Skipped</p>
                <p className="text-sm font-bold text-white">{plan.skipped.length}</p>
                <p className="text-[10px] text-slate-500">{plan.duplicates} dupes</p>
              </div>
            </div>

            {/* Category breakdown */}
            {Object.keys(totals.byCat).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(totals.byCat)
                  .sort((a, b) => b[1] - a[1])
                  .map(([cat, amt]) => {
                    const c = getCategory(data.categories, cat);
                    return (
                      <span
                        key={cat}
                        className="flex items-center gap-1 rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-slate-300"
                      >
                        <span>{c.icon}</span> {c.name} · {formatMoney(amt)}
                      </span>
                    );
                  })}
              </div>
            )}

            {/* Bills to mark paid */}
            {plan.bills.length > 0 && (
              <div>
                <p className={labelClass}>Bills to mark paid</p>
                <div className="space-y-1 rounded-xl border border-white/[0.06] p-2">
                  {plan.bills.map((b, i) => (
                    <label
                      key={i}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        checked={b.include}
                        onChange={(e) => setBill(i, { include: e.target.checked })}
                        className="accent-violet-500"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-white">
                        {b.billName}
                      </span>
                      <span className="text-[11px] text-slate-500">{b.date.slice(5)}</span>
                      <span className="text-sm font-medium text-rose-300">
                        {formatMoney(b.amount)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Variable spend — editable */}
            {plan.variable.length > 0 && (
              <div>
                <p className={labelClass}>Spending ({plan.variable.length}) · tap a category to fix it</p>
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-white/[0.06] p-2">
                  {plan.variable.map((v, i) => (
                    <div
                      key={i}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                        v.include ? "" : "opacity-40"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={v.include}
                        onChange={(e) => setVariable(i, { include: e.target.checked })}
                        className="accent-violet-500"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-white">{v.description}</p>
                        <p className="text-[10px] text-slate-500">{v.date.slice(5)} · {v.reason}</p>
                      </div>
                      <select
                        value={v.appCategory}
                        onChange={(e) => setVariable(i, { appCategory: e.target.value })}
                        className="rounded-lg border border-white/10 bg-white/5 px-1.5 py-1 text-[11px] text-slate-200 outline-none"
                      >
                        {expenseCats.map((c) => (
                          <option key={c.id} value={c.id} className="bg-slate-800">
                            {c.icon} {c.name}
                          </option>
                        ))}
                      </select>
                      <span className="w-14 shrink-0 text-right text-xs font-medium text-white">
                        {formatMoney(v.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.variable.length === 0 && plan.bills.length === 0 && (
              <p className="rounded-lg bg-white/5 px-3 py-2 text-sm text-slate-400">
                Nothing new to import — everything in this file is already in your
                ledger ({plan.duplicates} duplicates skipped).
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={reset} disabled={busy}>
                Choose another
              </Button>
              <Button
                className="flex-1"
                onClick={commit}
                disabled={busy || (totals.variableCount === 0 && totals.billCount === 0)}
              >
                {busy ? "Importing…" : "Import"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
