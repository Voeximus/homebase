// The auto-categorizer. Turns a raw bank-statement line into an app decision:
//   - "bill"     → it's one of the modeled recurring bills (mark it paid)
//   - "variable" → real living spend (counts toward the lean budget)
//   - "skip"     → income, internal transfers, remittances (not imported)
//
// It's trained on Gino's own hand-labeled history (categorizeData.ts, 131
// merchants), with keyword fallbacks for merchants he hasn't seen before.

import { MERCHANT_CATEGORY } from "./categorizeData.ts";

export type TxnKind = "bill" | "variable" | "skip";

export interface Classification {
  kind: TxnKind;
  appCategory?: string; // app category id, when kind === "variable"
  billName?: string; // matching recurring row name, when kind === "bill"
  hisCategory?: string; // the raw label we matched (for display / debugging)
  reason: string;
  confidence: "high" | "low"; // "low" → worth a one-tap clarify question
}

// A learned rule, keyed by merchant key. Checked before everything else, so a
// one-tap answer is permanent.
export interface LearnedRule {
  kind: TxnKind;
  categoryId?: string;
  billName?: string;
}
export type LearnedRules = Record<string, LearnedRule>;

/** Normalize a description to a merchant key. MUST stay identical to the
 *  generator in Desktop/Finances/_gendict.cjs, or dictionary lookups miss. */
export function merchantKey(desc: string): string {
  let s = desc;
  s = s.replace(/\s+(DES:|Conf#|ID:|Confirmation#).*/i, "");
  s = s.replace(/\s+\d{2}\/\d{2}\b.*/, "");
  s = s.replace(/\s+#?\d{3,}.*/, "");
  s = s.replace(/\*.*/, "");
  s = s.replace(/\s{2,}/g, " ").trim().toUpperCase();
  return s.slice(0, 28);
}

/** Normalize a bill / recurring-row NAME for fuzzy matching: case-fold and drop
 *  every non-alphanumeric char (spaces, punctuation, the "…" ellipsis) while
 *  KEEPING digits, so the two "Card payment (…4728 / …6813)" rows stay distinct.
 *  "Electric (SRP)" → "electricsrp", "T-Mobile" → "tmobile". */
export function billKey(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Resolve a categorizer billName to one of the recurring rows, tolerant of
 *  punctuation / case / whitespace / ellipsis drift. Exact match first (fast,
 *  unchanged behavior), then a normalized billKey match, then a merchantKey
 *  match (shares the learned-rule key space). Returns the matched row, or null.
 *  This is the fix for bills that didn't auto-flip to paid because the bank's
 *  descriptor name didn't string-equal the modeled bill name. */
export function matchRecurringName<T extends { name: string }>(
  billName: string | undefined | null,
  recurring: readonly T[],
): T | null {
  if (!billName) return null;
  const exact = recurring.find((r) => r.name === billName);
  if (exact) return exact;
  const bk = billKey(billName);
  if (bk) {
    const norm = recurring.find((r) => billKey(r.name) === bk);
    if (norm) return norm;
  }
  const mk = merchantKey(billName);
  if (mk) {
    const byMerchant = recurring.find((r) => merchantKey(r.name) === mk);
    if (byMerchant) return byMerchant;
  }
  return null;
}

/** Strip the noise the bank wraps a raw statement line in — the transaction-type
 *  prefix, the MMDD date, masked card digits, store #, "RECURRING" — so a known
 *  merchant hidden inside a raw line ("PURCHASE 0321 YAMI.COM YAMIBUY.COM/ECA
 *  XXXXX…7296") can still be recognized. Used only as a last resort in classify(),
 *  so it can never change a line the normal path already classified. */
export function stripStatementNoise(desc: string): string {
  let s = " " + desc.toUpperCase() + " ";
  s = s.replace(/\b(MOBILE PURCHASE|CHECKCARD PURCHASE|CHECKCARD|POS PURCHASE|POS DEBIT|DEBIT CARD PURCHASE|RECURRING PAYMENT|MOBILE PAYMENT|PURCHASE)\b/g, " ");
  s = s.replace(/\b\d{2}\/\d{2}\b/g, " "); // MM/DD
  s = s.replace(/\s\d{4}(?=\s)/g, " "); // MMDD date token(s) — keep the trailing space so adjacent tokens both clear
  s = s.replace(/\bX{3,}[0-9X.…]*/g, " "); // masked card number (incl. a dotted tail)
  s = s.replace(/\bRECURRING\b/g, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

/** Resolve a merchant key to Gino's history label, tolerant of trailing domain /
 *  location tokens the bank appends: exact hit first, else the longest history
 *  key (≥5 chars) the cleaned key starts with ("YAMI.COM YAMIBUY.COM/ECA" still
 *  resolves to the "YAMI.COM" rule). */
function hisLookup(key: string): string | undefined {
  const exact = MERCHANT_CATEGORY[key];
  if (exact) return exact;
  let best: string | undefined;
  let bestLen = 0;
  for (const k in MERCHANT_CATEGORY) {
    if (k.length >= 5 && k.length > bestLen && key.startsWith(k + " ")) {
      best = MERCHANT_CATEGORY[k];
      bestLen = k.length;
    }
  }
  return best;
}

// A line that matches one of these IS a modeled recurring bill — mark it paid,
// don't count it as variable spend. Names must match SEED_RECURRING exactly.
const BILL_RULES: { re: RegExp; bill: string }[] = [
  { re: /NOLLIE/i, bill: "Rent" },
  { re: /\bSRP\b|ECHXPWR/i, bill: "Electric (SRP)" },
  { re: /VZ WIRELESS|VERIZON/i, bill: "Verizon" },
  { re: /TMOBILE|T-MOBILE/i, bill: "T-Mobile" },
  { re: /SPOTIFY/i, bill: "Spotify" },
  { re: /SPOT PET/i, bill: "Spot Pet insurance" },
  { re: /LEMONADE/i, bill: "LEMONADE INSURANCE" },
  { re: /CRD\s*4728/i, bill: "Card payment (…4728)" },
  { re: /CRD\s*6813/i, bill: "Card payment (…6813)" },
  // Affirm is a feed-TRACKED debt now (debts.track_pattern "AFFIRM"), not a bill.
  { re: /ZELLE PAYMENT TO MON\b/i, bill: "Mom" },
];

// Gino's own category labels → the app's category + whether it's living spend.
const HISCAT_TO_APP: Record<string, { kind: TxnKind; appCategory?: string }> = {
  Groceries: { kind: "variable", appCategory: "groceries" },
  "Gas/Auto/Convenience": { kind: "variable", appCategory: "transport" },
  "Dining/Takeout": { kind: "variable", appCategory: "dining" },
  "Rideshare/Delivery": { kind: "variable", appCategory: "transport" },
  Shopping: { kind: "variable", appCategory: "shopping" },
  // Health/Personal (grooming, pharmacy, personal care) folds into the merged
  // Household + Hygiene category (`shopping`).
  "Health/Personal": { kind: "variable", appCategory: "shopping" },
  Pets: { kind: "variable", appCategory: "other" },
  "Subscriptions/Digital": { kind: "variable", appCategory: "subscriptions" },
  "Travel/Other": { kind: "variable", appCategory: "other" },
  Other: { kind: "variable", appCategory: "other" },
  // Everything below is real, but not lean-variable living spend → skip on import.
  "Income: Paycheck": { kind: "skip" },
  "Income: Tax refund": { kind: "skip" },
  "Internal: spouse": { kind: "skip" },
  "Internal: account transfer": { kind: "skip" },
  "Zelle: friends/family": { kind: "skip" },
  "Family support": { kind: "skip" }, // caught earlier as the "Mom" bill anyway
  "Remittance (abroad)": { kind: "skip" },
  Cashback: { kind: "skip" },
  "Cash deposit": { kind: "skip" },
  Rent: { kind: "skip" },
  "Utilities: Electric": { kind: "skip" },
  "Utilities: Phone": { kind: "skip" },
  "Debt: Affirm": { kind: "skip" },
  "Debt: Credit card": { kind: "skip" },
};

// For merchants not in Gino's history, fall back to keyword rules so new
// merchants still land in the right bucket (lower confidence — he can fix it).
const KEYWORD_FALLBACK: { re: RegExp; appCategory: string }[] = [
  { re: /CHEVRON|SHELL|CIRCLE K|\bQT\b|QUIKTRIP|FRYS FUEL|ARCO|\bMOBIL\b|EXXON|SUNOCO|KWIK|CONOCO|76\b/i, appCategory: "transport" },
  { re: /SAFEWAY|WAL-?MART|WM SUPERCENTER|TRADER JOE|WHOLE ?FDS|WHOLE FOODS|FRYS FOOD|KROGER|COSTCO|SAM'?S? CLUB|99 RANCH|H MART|MEKONG|ALDI|SPROUTS|GROCER|MARKET|SUPERMARKET/i, appCategory: "groceries" },
  { re: /CHIPOTLE|STARBUCKS|DUTCH BROS|PANDA|MCDONALD|TACO|PIZZA|\bCAFE\b|COFFEE|\bTEA\b|RESTAURANT|GRILL|SUSHI|RAMEN|\bBBQ\b|CANES|JACK IN THE BOX|HOT ?POT|DOORDASH|UBER EATS|GRUBHUB|DINER|KITCHEN|NOODLE|BURGER/i, appCategory: "dining" },
  { re: /AMAZON|TARGET|IKEA|\bROSS\b|NORDSTROM|ULTA|NIKE|VANS|BEST BUY|HOME DEPOT|BASS PRO|MACY|KOHL/i, appCategory: "shopping" },
  { re: /CVS|WALGREENS|PHARMACY|CLINIC|DENTAL|MEDICAL|HAIR|SALON|BARBER/i, appCategory: "shopping" },
  { re: /SUBSCRIPTION|\.COM\/BILL|GOOGLE|NETFLIX|HULU|AUDIBLE|KINDLE|OPENAI|\bXAI\b|REPLIT|DISNEY|YOUTUBE|PATREON/i, appCategory: "subscriptions" },
];

/** Classify one statement line. Bills win first, then Gino's merchant labels,
 *  then keyword fallback. Positive amounts (deposits, refunds, transfers-in)
 *  are skipped — they aren't living spend. */
export function classify(
  desc: string,
  amount: number,
  learned?: LearnedRules,
): Classification {
  if (!Number.isFinite(amount) || amount >= 0) {
    return { kind: "skip", reason: "credit / deposit", confidence: "high" };
  }

  const key = merchantKey(desc);

  // 1) A rule you taught the app wins over everything — and is always confident.
  const lr = learned?.[key];
  if (lr) {
    if (lr.kind === "bill")
      return { kind: "bill", billName: lr.billName, reason: "you taught it", confidence: "high" };
    if (lr.kind === "skip")
      return { kind: "skip", reason: "you taught it", confidence: "high" };
    return { kind: "variable", appCategory: lr.categoryId, reason: "you taught it", confidence: "high" };
  }

  // Anthropic/Claude: the bank descriptor is identical ("Anthropic", "Claude.ai",
  // "Claude Sub Anthropic…") for BOTH a Pro seat (~$21.62) and a Max seat (~$108),
  // so the text alone can't name the bill — route by PRICE BAND. Names resolve to
  // the modeled "Claude Pro" / "Claude Max" rows via matchRecurringName (both the
  // live feed and CSV import). A charge OUTSIDE both seat bands (API/console
  // pay-as-you-go, a proration, a refund) is NOT a seat → keep it as variable
  // subscription spend, flagged low-confidence for a one-tap check. The pattern is
  // anchored so "Saint Claude Bistro" / "Claude Monet" can't trip it.
  if (/\bANTHROPIC\b|CLAUDE\.AI|\bCLAUDE (PRO|MAX|SUB)\b/i.test(desc)) {
    const mag = Math.abs(amount);
    if (mag >= 15 && mag <= 35)
      return { kind: "bill", billName: "Claude Pro", appCategory: "subscriptions", reason: "matched bill: Claude Pro", confidence: "high" };
    if (mag >= 70 && mag <= 140)
      return { kind: "bill", billName: "Claude Max", appCategory: "subscriptions", reason: "matched bill: Claude Max", confidence: "high" };
    return { kind: "variable", appCategory: "subscriptions", reason: "Anthropic (non-seat amount) — confirm", confidence: "low" };
  }

  for (const r of BILL_RULES) {
    if (r.re.test(desc)) {
      return { kind: "bill", billName: r.bill, reason: `matched bill: ${r.bill}`, confidence: "high" };
    }
  }

  // Uber is split in the history: the membership is a sub, trips are rideshare.
  if (key === "UBER") {
    return /ONE MEMBERSHIP/i.test(desc)
      ? { kind: "variable", appCategory: "subscriptions", hisCategory: "Subscriptions/Digital", reason: "Uber One membership", confidence: "high" }
      : { kind: "variable", appCategory: "transport", hisCategory: "Rideshare/Delivery", reason: "Uber trip", confidence: "high" };
  }

  const his = MERCHANT_CATEGORY[key];
  if (his) {
    const map = HISCAT_TO_APP[his];
    if (map) {
      if (map.kind !== "variable")
        return { kind: "skip", hisCategory: his, reason: `your label: ${his}`, confidence: "high" };
      // Known merchant, but "Other" is vague — worth a one-tap confirm.
      return {
        kind: "variable",
        appCategory: map.appCategory,
        hisCategory: his,
        reason: `your label: ${his}`,
        confidence: map.appCategory === "other" ? "low" : "high",
      };
    }
  }

  for (const f of KEYWORD_FALLBACK) {
    if (f.re.test(desc)) {
      return { kind: "variable", appCategory: f.appCategory, reason: `guessed → ${f.appCategory}`, confidence: "low" };
    }
  }

  // Last resort: a raw, un-normalized statement line (old CSV imports, or a feed
  // that sends the full bank descriptor) can hide a known merchant behind a prefix
  // + date + card mask. Strip that noise and retry the history + keyword lookups.
  // Additive — only reached when nothing above matched, so it can't regress.
  const cleaned = stripStatementNoise(desc);
  if (cleaned && cleaned !== desc.toUpperCase().trim()) {
    const his2 = hisLookup(merchantKey(cleaned));
    if (his2) {
      const map = HISCAT_TO_APP[his2];
      if (map) {
        if (map.kind !== "variable")
          return { kind: "skip", hisCategory: his2, reason: `your label: ${his2}`, confidence: "high" };
        return {
          kind: "variable",
          appCategory: map.appCategory,
          hisCategory: his2,
          reason: `your label: ${his2}`,
          confidence: map.appCategory === "other" ? "low" : "high",
        };
      }
    }
    for (const f of KEYWORD_FALLBACK) {
      if (f.re.test(cleaned)) {
        return { kind: "variable", appCategory: f.appCategory, reason: `guessed → ${f.appCategory}`, confidence: "low" };
      }
    }
  }

  // Unknown merchant, a real debit → variable "other", lowest confidence.
  return { kind: "variable", appCategory: "other", reason: "new merchant", confidence: "low" };
}
