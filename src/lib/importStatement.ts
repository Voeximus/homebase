// Parse a Bank of America CSV export and turn it into a reviewable import plan.
// BofA's CSV has a small summary block, a blank line, then the real table:
//   Date,Description,Amount,Running Bal.
//   03/02/2026,"SAFEWAY #1717 ...","-19.57","1,900.96"

import type { Recurring, Transaction } from "../types";
import { classify, merchantKey, type LearnedRules } from "./categorize";

export interface RawRow {
  date: string; // ISO YYYY-MM-DD
  description: string;
  amount: number; // signed: negative = debit/spend
}

export interface VariableItem {
  date: string;
  amount: number; // positive magnitude
  description: string;
  appCategory: string;
  reason: string;
  include: boolean; // user can toggle off in the preview
  merchant: string; // normalized merchant key (groups the clarify questions)
  lowConfidence: boolean; // → surfaced as a one-tap clarify card
}

export interface BillItem {
  date: string;
  monthKey: string;
  day: number;
  amount: number; // positive magnitude
  description: string;
  billName: string;
  recurringId: string;
  include: boolean;
}

export interface SkippedItem {
  date: string;
  amount: number; // signed
  description: string;
  reason: string;
}

export interface ImportPlan {
  variable: VariableItem[];
  bills: BillItem[];
  skipped: SkippedItem[];
  duplicates: number; // rows already in the ledger, dropped silently
}

// --- CSV ---------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0,
    field = "",
    row: string[] = [],
    inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (field !== "" || row.length) {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        }
      } else field += c;
    }
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toIso(mdy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(mdy.trim());
  if (!m) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function toNumber(s: string): number {
  const n = parseFloat(s.replace(/[",$\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

/** Pull the real transaction rows out of a BofA CSV. Returns [] if it doesn't
 *  look like one. */
export function parseBofaCsv(text: string): RawRow[] {
  const rows = parseCsv(text);
  // Find the table header row.
  const headerIdx = rows.findIndex(
    (r) => r[0]?.trim() === "Date" && /description/i.test(r[1] ?? ""),
  );
  if (headerIdx === -1) return [];

  const out: RawRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const iso = toIso(r[0] ?? "");
    if (!iso) continue; // summary / balance lines
    const desc = (r[1] ?? "").trim();
    if (/^(Beginning|Ending) balance|^Total (credits|debits)/i.test(desc)) continue;
    const amountStr = r[2] ?? "";
    if (amountStr.trim() === "") continue; // balance-only rows
    out.push({ date: iso, description: desc, amount: toNumber(amountStr) });
  }
  return out;
}

// --- Plan --------------------------------------------------------------------

const dupeKey = (date: string, amount: number, desc: string) =>
  `${date}|${amount.toFixed(2)}|${desc.slice(0, 40)}`;

/** Classify every row, resolve bills to recurring ids, and drop anything that's
 *  already in the ledger. */
export function buildImportPlan(
  rows: RawRow[],
  recurring: Recurring[],
  existing: Transaction[],
  learned?: LearnedRules,
): ImportPlan {
  // What's already imported, by date+amount+description (variable spend) …
  const seen = new Set(
    existing.map((t) => dupeKey(t.date, t.type === "income" ? t.amount : -t.amount, t.description)),
  );
  // … and which bill installments are already recorded paid.
  const paidBill = new Set(
    existing
      .filter((t) => t.appliesTo?.kind === "bill")
      .map((t) => `${t.appliesTo!.recurringId}|${t.appliesTo!.monthKey}|${t.appliesTo!.day}`),
  );

  const variable: VariableItem[] = [];
  const bills: BillItem[] = [];
  const skipped: SkippedItem[] = [];
  let duplicates = 0;

  for (const r of rows) {
    const c = classify(r.description, r.amount, learned);

    if (c.kind === "skip") {
      skipped.push({ date: r.date, amount: r.amount, description: r.description, reason: c.reason });
      continue;
    }

    if (c.kind === "bill" && c.billName) {
      const rec = recurring.find((x) => x.name === c.billName);
      if (!rec) {
        // Bill rule matched but no such recurring row — treat as variable other.
        if (!seen.has(dupeKey(r.date, r.amount, r.description))) {
          variable.push({ date: r.date, amount: Math.abs(r.amount), description: r.description, appCategory: "other", reason: `${c.reason} (no matching bill row)`, include: true, merchant: merchantKey(r.description), lowConfidence: true });
        } else duplicates++;
        continue;
      }
      const monthKey = r.date.slice(0, 7);
      const day = parseInt(r.date.slice(8, 10), 10);
      if (paidBill.has(`${rec.id}|${monthKey}|${day}`)) {
        duplicates++;
        continue;
      }
      bills.push({ date: r.date, monthKey, day, amount: Math.abs(r.amount), description: r.description, billName: rec.name, recurringId: rec.id, include: true });
      continue;
    }

    // variable
    if (seen.has(dupeKey(r.date, r.amount, r.description))) {
      duplicates++;
      continue;
    }
    variable.push({ date: r.date, amount: Math.abs(r.amount), description: r.description, appCategory: c.appCategory ?? "other", reason: c.reason, include: true, merchant: merchantKey(r.description), lowConfidence: c.confidence === "low" });
  }

  return { variable, bills, skipped, duplicates };
}

export interface ClarifyQuestion {
  merchant: string;
  sampleDesc: string;
  count: number;
  total: number;
  currentCategory: string;
}

/** One question per distinct low-confidence merchant (ask once, file all). */
export function clarifyQuestions(plan: ImportPlan): ClarifyQuestion[] {
  const byMerchant: Record<string, ClarifyQuestion> = {};
  for (const v of plan.variable) {
    if (!v.lowConfidence) continue;
    const q =
      byMerchant[v.merchant] ||
      (byMerchant[v.merchant] = {
        merchant: v.merchant,
        sampleDesc: v.description,
        count: 0,
        total: 0,
        currentCategory: v.appCategory,
      });
    q.count++;
    q.total += v.amount;
  }
  return Object.values(byMerchant).sort((a, b) => b.total - a.total);
}

export function planTotals(plan: ImportPlan) {
  const variableTotal = plan.variable.filter((v) => v.include).reduce((s, v) => s + v.amount, 0);
  const byCat: Record<string, number> = {};
  for (const v of plan.variable) if (v.include) byCat[v.appCategory] = (byCat[v.appCategory] ?? 0) + v.amount;
  const billCount = plan.bills.filter((b) => b.include).length;
  return { variableTotal, byCat, billCount, variableCount: plan.variable.filter((v) => v.include).length };
}
