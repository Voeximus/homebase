// Parse a Bank of America CSV export and turn it into a reviewable import plan.
// BofA's CSV has a small summary block, a blank line, then the real table:
//   Date,Description,Amount,Running Bal.
//   03/02/2026,"SAFEWAY #1717 ...","-19.57","1,900.96"

import type { Recurring, Transaction } from "../types";
import {
  classify,
  merchantKey,
  matchRecurringName,
  stripStatementNoise,
  type LearnedRules,
} from "./categorize";
import { billCycleFor } from "./schedule";

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
  // A multi-department merchant with no pump token — the app genuinely cannot
  // know fuel vs store, and the answer is per-CHARGE, not per-merchant. Kept off
  // the clarify cards (which save a permanent merchant rule that is structurally
  // incapable of being right here) and answered with the row's own category
  // dropdown instead. See classify()'s ambiguous branch.
  ambiguous?: boolean;
  // Same date and same amount as something already in the ledger, but a different
  // merchant stem. Not proof either way, so it is shown UNCHECKED with the reason
  // spelled out rather than silently added or silently dropped.
  possibleDuplicate?: boolean;
  // A real payment that landed on a bill installment another row already claimed.
  // Cannot be a second settled bill marker (only one is ever consumed, the rest go
  // invisible), so it is offered as an ordinary visible row.
  extraBillPayment?: boolean;
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

export interface DuplicateItem {
  date: string;
  amount: number; // positive magnitude
  description: string;
}

export interface ImportPlan {
  variable: VariableItem[];
  bills: BillItem[];
  skipped: SkippedItem[];
  duplicates: DuplicateItem[]; // already in the ledger — shown, not added
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

// Dedup identity for a charge: its DATE, its exact AMOUNT, and a merchant stem
// that survives every wording the same charge can arrive in.
//
// The old key was `date|amount|merchantKey(description)`, and it could not see a
// bank-feed row AT ALL. The feed stores Plaid's clean merchant name ("Safeway",
// "Chipotle Mexican Grill"); a CSV/PDF row carries the raw BofA descriptor
// ("SAFEWAY #1717 05/28 PURCHASE MESA AZ"). Different string, different key — so
// re-importing a period the feed already covered presented every charge as new
// and inserted a second copy of each. Replayed over the 36 real feed-vs-import
// collisions in the June backup, that key recognized 18 of 36.
//
// stripStatementNoise() removes exactly what makes the two wordings differ (the
// CHECKCARD/PURCHASE prefix, the MMDD token, the masked card digits) before the
// merchant key is taken: 28/36. Allowing one stem to be a PREFIX of the other
// absorbs the remaining drift — the feed's "SAFEWAY" against the statement's
// "SAFEWAY MESA AZ", "CIRCLE K" against "CIRCLE K #", "PANDA EXPRESS" against the
// 28-char-truncated "PANDA EXPRESS TBIT LAX LOS A" — which reaches 32/36.
//
// The last 4 are a truncated descriptor against a spelled-out name ("CHIPOTLE
// MEX G" vs "CHIPOTLE MEXICAN GRILL"): no normalization can bridge those, so they
// fall out as a same-date-same-amount near-miss and are surfaced for the user to
// confirm instead of being silently added.
const amountKey = (date: string, amount: number) => `${date}|${amount.toFixed(2)}`;
const merchantStem = (desc: string) => merchantKey(stripStatementNoise(desc));

// A stem short enough to be a coincidence ("QT", "AMZ") has to match in full. A
// 6-character stem, on top of an identical date AND an identical amount, is the
// same charge — verified: no two same-source rows in the real ledger collapse.
const MIN_STEM_PREFIX = 6;
const sameMerchant = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_STEM_PREFIX && long.startsWith(short);
};

/** Classify every row, resolve bills to recurring ids, and drop anything that's
 *  already in the ledger. */
export function buildImportPlan(
  rows: RawRow[],
  recurring: Recurring[],
  existing: Transaction[],
  learned?: LearnedRules,
): ImportPlan {
  // What's already in the ledger, indexed date+amount → the merchant stems filed
  // under it. BOTH wordings of a feed row are indexed: `description` is Plaid's
  // clean name and `rawDescription` is the descriptor the bank wrote, and a
  // statement row can collide with either one.
  const seen = new Map<string, string[]>();
  for (const t of existing) {
    const k = amountKey(t.date, t.type === "income" ? t.amount : -t.amount);
    const stems = seen.get(k) ?? [];
    for (const d of [t.description, t.rawDescription]) {
      const stem = d ? merchantStem(d) : "";
      if (stem && !stems.includes(stem)) stems.push(stem);
    }
    seen.set(k, stems); // recorded even when empty — the date+amount alone is still a signal
  }

  /** "same" — this charge is already logged, drop it. "maybe" — something with
   *  this exact date and amount is logged under a different merchant; that is a
   *  near-miss, not proof, so show it and let the user decide. "new" — nothing
   *  at that date and amount. */
  const matchExisting = (r: RawRow): "same" | "maybe" | "new" => {
    const stems = seen.get(amountKey(r.date, r.amount));
    if (!stems) return "new";
    const stem = merchantStem(r.description);
    return stems.some((s) => sameMerchant(s, stem)) ? "same" : "maybe";
  };

  // Which bill installments are already recorded paid, and for how much. The
  // AMOUNT is what separates "the same payment reaching us twice" from "a second,
  // real payment on the same bill cycle" — the date can't, because the "Pay now"
  // marker carries the DUE date while the statement carries the posting date.
  const paidBill = new Map<string, number[]>();
  for (const t of existing) {
    if (t.appliesTo?.kind !== "bill") continue;
    const k = `${t.appliesTo.recurringId}|${t.appliesTo.monthKey}|${t.appliesTo.day}`;
    const amounts = paidBill.get(k);
    if (amounts) amounts.push(t.amount);
    else paidBill.set(k, [t.amount]);
  }
  // Installments claimed by an earlier row in THIS run. Tracked apart from the
  // ledger set on purpose: two rows on one statement are two distinct bank lines
  // by construction, so a second one is a second payment even at an identical
  // amount, whereas an identical amount already in the LEDGER is the same payment.
  const claimedThisRun = new Set<string>();

  const variable: VariableItem[] = [];
  const bills: BillItem[] = [];
  const skipped: SkippedItem[] = [];
  const duplicates: DuplicateItem[] = [];
  const asDup = (r: RawRow): DuplicateItem => ({
    date: r.date,
    amount: Math.abs(r.amount),
    description: r.description,
  });

  for (const r of rows) {
    // Pass the descriptor as its own RAW. For a CSV/PDF row `description` IS the
    // untouched bank line — the richest form there is — and resolveDepartment()
    // bails on a missing raw, so omitting it threw away the pump token the whole
    // fuel-vs-store fix depends on: "SAMSCLUB #4956 GAS 07/16" scored `other` and
    // was graded against Misc instead of the gas line.
    const c = classify(r.description, r.amount, learned, r.description);
    const match = matchExisting(r);

    if (c.kind === "skip") {
      skipped.push({ date: r.date, amount: r.amount, description: r.description, reason: c.reason });
      continue;
    }

    // A near-miss on date+amount is offered UNCHECKED with the reason stated, so a
    // real charge is never silently dropped and a re-import is never silently
    // doubled. (The category still rides along as a pre-fill if it is checked.)
    const asVariable = (appCategory: string, reason: string, lowConfidence: boolean): VariableItem => ({
      date: r.date,
      amount: Math.abs(r.amount),
      description: r.description,
      appCategory,
      reason: match === "maybe" ? `${reason} · possible duplicate — same day + amount already here` : reason,
      include: match !== "maybe",
      merchant: merchantKey(r.description),
      lowConfidence: match === "maybe" ? false : lowConfidence,
      ambiguous: c.ambiguous,
      possibleDuplicate: match === "maybe",
    });

    if (c.kind === "bill" && c.billName) {
      const rec = matchRecurringName(c.billName, recurring);
      if (!rec) {
        // Bill rule matched but no such recurring row — treat as variable other.
        if (match === "same") duplicates.push(asDup(r));
        else variable.push(asVariable("other", `${c.reason} (no matching bill row)`, true));
        continue;
      }
      // Attribute to the bill CYCLE this payment settles — early payments roll to
      // the next cycle so they line up with the calendar-marked installment and
      // re-imports dedup (shared with the live feed via billCycleFor).
      const { monthKey, day } = billCycleFor(rec.dueDays, r.date);
      const slot = `${rec.id}|${monthKey}|${day}`;
      const amount = Math.abs(r.amount);
      const ledgerPaid = paidBill.get(slot);
      if (claimedThisRun.has(slot) || ledgerPaid) {
        // The installment is already spoken for. Only the SAME payment arriving
        // twice is a duplicate — a ledger row for this slot at the same amount, or
        // a charge we already recognize. Anything else is a second, real payment
        // (two card payments in one July: $250 on the 3rd, $400 on the 20th), and
        // it cannot be a second settled bill marker: monthCalendar consumes exactly
        // one per installment, so the other would be a `settled` row that shows in
        // no ledger, no activity list and no budget while still dragging
        // billExpected's rolling average down. Offer it as an ordinary visible row.
        // A TOLERANCE, not an exact match. `markBillPaid` records the modeled or
        // rolling-average amount — for a variable bill the sheet literally
        // prefills "Estimated ~$X — enter the real amount" — so the marker and
        // the bank's own figure routinely differ by cents or a few dollars for
        // the SAME payment. Requiring equality announced a second payment that
        // never happened (marker $86.00 vs SRP's actual $86.66), and ticking that
        // row would book a bill payment as variable spend on the bill's category
        // — for a card payment, debt paydown landing on the Misc line.
        //
        // The window is deliberately wide enough to absorb an estimate and far
        // too narrow to swallow a genuine second payment: the case this whole
        // branch exists for is $250 on the 3rd and $400 on the 20th.
        const NEAR_ABS = 25;
        const NEAR_FRAC = 0.15;
        const isNear = (a: number) =>
          Math.abs(a - amount) <= Math.min(NEAR_ABS, Math.max(a, amount) * NEAR_FRAC);
        const samePaymentTwice =
          match === "same" || (!claimedThisRun.has(slot) && !!ledgerPaid?.some(isNear));
        if (samePaymentTwice) duplicates.push(asDup(r));
        else
          variable.push({
            ...asVariable(rec.categoryId ?? "other", `second payment on ${rec.name} this cycle — the bill is already marked paid`, false),
            include: false, // real, but it is not spend on that budget line — the user says where it goes
            extraBillPayment: true,
          });
        continue;
      }
      bills.push({ date: r.date, monthKey, day, amount, description: r.description, billName: rec.name, recurringId: rec.id, include: true });
      // Reserve the installment as it is consumed, the way the live feed does. The
      // old code read this set and never wrote to it, so two payments in one cycle
      // both committed as settled markers for the SAME installment.
      claimedThisRun.add(slot);
      continue;
    }

    // variable
    if (match === "same") {
      duplicates.push(asDup(r));
      continue;
    }
    variable.push(asVariable(c.appCategory ?? "other", c.reason, c.confidence === "low"));
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
    // An ambiguous merchant is deliberately NOT asked here. Answering a clarify
    // card saves a permanent merchant rule, and this question is per-CHARGE, not
    // per-merchant — "Sam's Club → transport" is right at the pump and wrong in
    // the aisles. classify() re-flags ambiguous even when a learned rule fired, so
    // the rule could never silence the card either: the same question would come
    // back on every future import. These rows carry the "fuel or store? confirm"
    // reason and are answered one at a time with the row's own category dropdown.
    if (v.ambiguous) continue;
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
