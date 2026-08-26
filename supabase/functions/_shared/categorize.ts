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
  // The merchant runs multiple departments and the descriptor doesn't say which,
  // so `appCategory` here is a PRE-FILL, not a finding. The importer must not use
  // it to overwrite a category an existing row already carries — see classify().
  ambiguous?: boolean;
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
  // Strip literal double-quotes the bank now wraps around Zelle memos (e.g.
  // `Zelle payment to Gio for "Rent"`) — the quote eats a slot and shifts the
  // 28-char truncation, breaking the dict lookup. Apostrophes are KEPT so
  // "Trader Joe's" / "Sam's Club" dict keys still resolve.
  let s = desc.replace(/[“”"]/g, "");
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
  // Last resort: a rule names the biller ("Car insurance") while the modelled row
  // qualifies it ("Car insurance — finishing this term"). Resolve a prefix ONLY
  // when exactly one row matches — two candidates means the app cannot tell which
  // bill the money paid, and guessing settles the wrong cycle. Callers narrow the
  // list to rows live on the payment date before calling, which is what keeps this
  // unambiguous across a term change.
  if (bk.length >= 5) {
    const byPrefix = recurring.filter((r) => billKey(r.name).startsWith(bk));
    if (byPrefix.length === 1) return byPrefix[0];
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

/** Resolve a learned rule across BOTH descriptor namespaces — see the long note
 *  at the call site. Exact clean-name hit first (unchanged precedence), then the
 *  raw bank line with its statement noise stripped. Never a bare merchantKey(raw):
 *  that returns "CHECKCARD" for every Bank of America card line, so a single rule
 *  would capture every card charge in the ledger. */
export function learnedFor(
  key: string,
  learned: LearnedRules | undefined,
  raw?: string,
): LearnedRule | undefined {
  if (!learned) return undefined;
  const direct = learned[key];
  if (direct) return direct;
  if (!raw) return undefined;
  const cleaned = stripStatementNoise(raw);
  if (!cleaned) return undefined;
  const rawKey = merchantKey(cleaned);
  // A one- or two-character key is noise, not a merchant.
  if (rawKey.length < 2 || rawKey === key) return undefined;
  return learned[rawKey];
}

/** For an INCOMING credit (positive amount): is it real income — to surface and to
 *  match reimbursement paybacks against — or just an internal transfer between the
 *  household's OWN accounts (same dollars moving, not new money → stays hidden)?
 *  Paychecks, refunds, cashback, and money people send you all read as income;
 *  only "Internal:" history labels (account-to-account, spouse shuffle) are transfers. */
export function classifyCredit(desc: string): "income" | "transfer" {
  // Card-payment credits ("PAYMENT FROM CHK …" landing ON a credit card) and ATM
  // cash deposits are the household's OWN money moving — the paired checking
  // outflow is already recorded — so they must NOT book as new income (that both
  // inflates gross income and double-counts the transfer). They carry no
  // "Internal:" history label, so detect them explicitly.
  if (/\bPAYMENT FROM (CHK|SAV)\b|BKOFAMERICA ATM|\bATM (CASH )?DEPOSIT\b/i.test(desc)) return "transfer";
  const his = hisLookup(merchantKey(desc));
  if (his && (his.startsWith("Internal:") || his === "Cash deposit")) return "transfer";
  return "income";
}

// Merchants that operate a FUEL STATION and a STORE under the same brand, so a
// single merchant->category rule can never be right for both. Matched against the
// clean merchant name; the fuel/store call is then made from the RAW descriptor.
//
// Deliberately a closed list rather than "any descriptor containing GAS" — in
// Arizona the gas UTILITY bill reads "SW GAS"/"SOUTHWEST GAS", and a blanket token
// match would file the heating bill as vehicle fuel.
const MULTI_DEPARTMENT = /SAM'?S ?CLUB|COSTCO|WAL-?MART|WM SUPERCENTER|SAFEWAY|FRYS|FRY'S|KROGER|ALBERTSONS|CIRCLE ?K|QUIKTRIP|\bQT\b/i;

// The bank's own fuel markers, as they appear inside the raw descriptor:
// "SAMSCLUB 4956 GAS 07/16", "COSTCO GAS #123", "FRYS FUEL". Word-anchored so
// GASOLINE-adjacent noise (VEGAS, GASTON) can't trip it.
const FUEL_TOKEN = /\bGAS\b|\bGASOLINE\b|\bFUEL\b|\bPUMP\b/i;

export type Department = "fuel" | "ambiguous" | null;

/** For a merchant that sells both fuel and groceries, decide which department a
 *  charge came from using the RAW bank descriptor.
 *
 *  - "fuel"      — the bank tagged the pump. Trust it.
 *  - "ambiguous" — a multi-department merchant with no tag. The app genuinely
 *                  cannot know, so the caller flags it for a one-tap answer
 *                  instead of guessing and being silently wrong half the time.
 *  - null        — an ordinary single-department merchant; nothing special.
 *
 *  Without a raw descriptor (manual entry, CSV import) nothing can be resolved,
 *  so it reports null and the normal path runs unchanged. */
export function resolveDepartment(desc: string, raw?: string): Department {
  if (!MULTI_DEPARTMENT.test(desc) && !(raw && MULTI_DEPARTMENT.test(raw))) return null;
  if (!raw) return null;
  if (FUEL_TOKEN.test(raw)) return "fuel";
  // An ONLINE order at the same brand has no pump to be confused with, so it isn't
  // ambiguous at all — "SAMS CLUB.COM" is the membership or a shipped order.
  if (/\.COM|\bONLINE\b/i.test(raw)) return null;
  return "ambiguous";
}

/** A WORK paycheck (vs. other income like Zelle, refunds, cashback). Drives the
 *  strategy gate, which only opens once both of the cycle's paychecks have landed.
 *  Both earners' ACH payroll lines carry "PAYROLL". */
export function isPaycheck(desc: string): boolean {
  return /\bPAYROLL\b/.test(desc.toUpperCase());
}

// A line that matches one of these IS a modeled recurring bill — mark it paid,
// don't count it as variable spend. Names must match SEED_RECURRING exactly.
//
// `not` is a VETO, checked before `re`. It exists because a bill rule that fires
// on a merchant which merely SHARES A WORD with the biller does not just
// mislabel one row — it settles a whole bill cycle, and the importer then
// silently discards every later payment that lands in that same cycle. So a
// one-word collision can hide a month of a real bill AND eat the charges that
// collided with it. Match the BILLER, never a word it shares with a neighbour.
const BILL_RULES: { re: RegExp; not?: RegExp; bill: string }[] = [
  // The landlord is "Nollie MA" (raw: "Nollie MA DES:Rent"). The SAME landlord's
  // parking garage bills as "Parkinsafe Nollie" for $6 a visit. With a bare
  // /NOLLIE/i, a $6 parking charge on 2026-08-17 settled the SEPTEMBER rent
  // cycle: the calendar showed "Sep 1 — Rent — PAID $6.00" and September read
  // $1,732.16 lighter than it is, at the household's tightest moment of the
  // year. The two later parking charges then vanished entirely, because the
  // importer drops a second payment into an already-settled cycle.
  { re: /\bNOLLIE\b/i, not: /PARKIN\s?SAFE|\bPARKING\b/i, bill: "Rent" },
  { re: /\bSRP\b|ECHXPWR/i, bill: "Electric (SRP)" },
  { re: /VZ WIRELESS|VERIZON/i, bill: "Verizon" },
  { re: /TMOBILE|T-MOBILE/i, bill: "T-Mobile" },
  { re: /SPOTIFY/i, bill: "Spotify" },
  { re: /SPOT ?PET/i, bill: "Spot Pet insurance" }, // "SPOT PET SPOTPET.COM" or Plaid's clean "Spotpet"
  { re: /LEMONADE/i, bill: "LEMONADE INSURANCE" },
  // Car insurance had NO rule at all, so every GEICO instalment classified as a
  // brand-new merchant and landed in `other` — the $125/mo Misc line — while the
  // bill it paid stayed unpaid on the calendar. $1,021.98 of Sept-Nov instalments
  // was on course to be graded as discretionary spending.
  //
  // "Car insurance" is a PREFIX of both modelled rows ("Car insurance — finishing
  // this term" runs to 30 Nov 2026; "Car insurance (both cars)" starts 1 Feb 2027),
  // and matchRecurringName resolves a prefix only when it is unambiguous. The
  // importer narrows to rows live on the payment date first, so exactly one
  // survives on any given date and the rule keeps working across the term change.
  { re: /GEICO/i, bill: "Car insurance" },
  // Cherry is BOTH a modeled monthly bill and a feed-tracked debt. Naming it
  // here is what lets the importer link a payment to both at once — without a
  // name the tracked-debt branch could only ever settle the debt.
  { re: /CHERRY TECHNOL/i, bill: "Cherry (dental)" },
  // McGraw-Hill bills ALEKS as "MHE*ALEKS ALEKS.COM" — and merchantKey() cuts at
  // the "*", so the merchant key is the bare "MHE". A learned rule on a 3-letter
  // key is too blunt to carry a bill link, so name the biller here instead: the
  // real charge then settles the modeled ALEKS row and the hand-entered "already
  // paid" placeholder stops being needed (it was double-counting $21.57/mo).
  { re: /MHE\*?ALEKS|ALEKS\.COM/i, bill: "ALEKS calculus" },
  // BoA writes a card payment differently depending on the channel it came
  // through, and only one of the three said "CRD":
  //   "Online Banking payment to CRD 4728 Confirmation# …"   (web)
  //   "Mobile Banking payment to CRD 6813 Confirmation# …"   (app)
  //   "PAYMENT TO ACCT #6813 ON 08/25 VIA WEB"               (also web, newer)
  // The third form matched nothing, so a card payment was filed as a brand-new
  // merchant in `other` — i.e. graded against the $125/mo Misc line as if
  // paying down a credit card were discretionary spending.
  { re: /(?:CRD|ACCT)\s*#?\s*4728\b/i, bill: "Card payment (…4728)" },
  { re: /(?:CRD|ACCT)\s*#?\s*6813\b/i, bill: "Card payment (…6813)" },
  // Affirm is a feed-TRACKED debt now (debts.track_pattern "AFFIRM"), not a bill.
  // "Zelle payment to mom" is handled earlier (amount-gated) — not a blanket rule.
];

// Drift-tolerant second pass: DISTINCTIVE aliases per bill, matched against the
// descriptor NORMALIZED by billKey (lowercased, alphanumerics only). Runs only
// when the regex rules above didn't match, so it can't regress them — it just
// catches spacing/punctuation/case drift (Plaid's clean "Spotpet" vs the raw
// "SPOT PET SPOTPET.COM", "T Mobile" vs "T-Mobile", "Vz Wireless" vs "VZWIRELESS").
// Every alias must be UNIQUE to that biller so it can't grab an unrelated merchant.
//
// `not` here too: billKey() strips punctuation, so "PARKINSAFE NOLLIE" normalizes
// to "parkinsafenollie" — which CONTAINS "nollie". The alias pass would re-open
// the exact collision the BILL_RULES veto just closed.
const BILL_ALIASES: { bill: string; not?: RegExp; aliases: string[] }[] = [
  { bill: "Rent", not: /PARKIN\s?SAFE|\bPARKING\b/i, aliases: ["nollie"] },
  { bill: "Electric (SRP)", aliases: ["echxpwr"] },
  { bill: "Verizon", aliases: ["verizon", "vzwireless"] },
  { bill: "T-Mobile", aliases: ["tmobile"] },
  { bill: "Spotify", aliases: ["spotify"] },
  { bill: "Spot Pet insurance", aliases: ["spotpet"] },
  { bill: "LEMONADE INSURANCE", aliases: ["lemonade"] },
  { bill: "Car insurance", aliases: ["geico"] },
  { bill: "Cherry (dental)", aliases: ["cherrytechnol"] },
  { bill: "ALEKS calculus", aliases: ["mhealeks", "alekscom"] },
  { bill: "Card payment (…4728)", aliases: ["crd4728", "acct4728"] },
  { bill: "Card payment (…6813)", aliases: ["crd6813", "acct6813"] },
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
  // "76" is the fuel brand and needs a word boundary on BOTH sides. With only the
  // trailing \b it also matched the TAIL of any store number ending in 76, and this
  // rule runs first — so "TARGET T-3176", "SPROUTS FARMERS MKT 176" and "PANERA
  // BREAD #3876" were all filed as gas, inflating the fuel line while the line they
  // belonged to read under. Phillips 66 is the same brand's parent name.
  { re: /CHEVRON|SHELL|CIRCLE K|\bQT\b|QUIKTRIP|FRYS FUEL|ARCO|\bMOBIL\b|EXXON|SUNOCO|KWIK|CONOCO|PHILLIPS ?66|\b76\b/i, appCategory: "transport" },
  // Parking is transport, not "other". PARKINSAFE is the garage at their own
  // building and recurs several times a month at $6 — it was landing in Misc,
  // and (before the Rent veto above) settling the rent cycle.
  { re: /PARKIN\s?SAFE|\bPARKING\b|PARKMOBILE|SPOTHERO|PASSPORT ?PARKING|\bTOLL\b/i, appCategory: "transport" },
  { re: /SAFEWAY|WAL-?MART|WM SUPERCENTER|TRADER JOE|WHOLE ?FDS|WHOLE FOODS|FRYS FOOD|KROGER|COSTCO|SAM'?S? CLUB|99 RANCH|H MART|MEKONG|ALDI|SPROUTS|GROCER|MARKET|SUPERMARKET/i, appCategory: "groceries" },
  { re: /CHIPOTLE|STARBUCKS|DUTCH BROS|\bPANDA\b|MCDONALD|TACO|PIZZA|\bCAFE\b|COFFEE|\bTEA\b|RESTAURANT|GRILL|SUSHI|RAMEN|\bBBQ\b|CANES|JACK IN THE BOX|HOT ?POT|DOORDASH|UBER EATS|GRUBHUB|DINER|KITCHEN|NOODLE|BURGER/i, appCategory: "dining" },
  { re: /AMAZON|TARGET|IKEA|\bROSS\b|NORDSTROM|ULTA|NIKE|VANS|BEST BUY|HOME DEPOT|BASS PRO|MACY|KOHL/i, appCategory: "shopping" },
  // Beauty/cosmetics sits with Health/Personal, which folds into `shopping`.
  // HOURGLAS (no trailing S) so the same rule catches Plaid's truncated clean
  // name "Hourglas" and the raw "SP HOURGLASSCOSME".
  { re: /CVS|WALGREENS|PHARMACY|CLINIC|DENTAL|MEDICAL|HAIR|SALON|BARBER|HOURGLAS|SEPHORA|\bULTA\b|SALLY BEAUTY/i, appCategory: "shopping" },
  { re: /SUBSCRIPTION|\.COM\/BILL|GOOGLE|NETFLIX|HULU|AUDIBLE|KINDLE|OPENAI|\bXAI\b|REPLIT|DISNEY|YOUTUBE|PATREON/i, appCategory: "subscriptions" },
];

/** Classify one statement line. Bills win first, then Gino's merchant labels,
 *  then keyword fallback. `raw` is the untouched bank descriptor when we have one
 *  — it resolves same-brand departments (a warehouse club's pump vs its store)
 *  that the clean merchant name flattens together.
 *
 *  When the merchant sells fuel AND groceries but the descriptor doesn't say which,
 *  the honest answer is "I don't know": the result is forced to low confidence so
 *  the importer files it needs_review and asks once, instead of guessing and being
 *  quietly wrong on half of them. */
export function classify(
  desc: string,
  amount: number,
  learned?: LearnedRules,
  raw?: string,
): Classification {
  const out = classifyCore(desc, amount, learned, raw);
  // Flag rather than guess at a multi-department merchant — INCLUDING when a
  // learned rule fired. A learned rule is keyed by MERCHANT, and this whole branch
  // exists because one merchant runs two departments, so such a rule is
  // structurally incapable of being the answer here: "Sam's Club → transport" is
  // the correct answer at the pump and the wrong one in the aisles, and it fires
  // identically for both. Exempting it (as this did) meant a single "Remember" tap
  // on one fill-up silently re-filed every grocery run as fuel from then on —
  // which is the exact failure the raw descriptor was added to end.
  //
  // The category still rides along as a PRE-FILL for a brand-new row, but it is
  // marked `ambiguous` so the importer never uses it to OVERWRITE a category an
  // existing row already carries. That distinction is load-bearing: a bulk re-sync
  // once re-decided 12 of these at once and moved $702 — mostly into fuel — on what
  // is, by construction, a coin flip.
  //
  // And it really is a coin flip. Measured against Gino's own hand-labels: the bank
  // writes the GAS token on only SOME pump charges (the descriptor is truncated at
  // ~28 chars, so "SAMS CLUB #495" may have lost it), and he confirmed four
  // token-less charges as fuel and three as store. Absence of the token carries no
  // information in either direction — which is exactly why this asks instead.
  if (out.kind === "variable" && resolveDepartment(desc, raw) === "ambiguous") {
    return {
      ...out,
      confidence: "low",
      ambiguous: true,
      reason: out.reason + " — fuel or store? confirm",
    };
  }
  return out;
}

function classifyCore(
  desc: string,
  amount: number,
  learned?: LearnedRules,
  raw?: string,
): Classification {
  if (!Number.isFinite(amount) || amount >= 0) {
    return { kind: "skip", reason: "credit / deposit", confidence: "high" };
  }

  const key = merchantKey(desc);

  // Everything that decides WHICH BILL a charge pays reads the clean merchant
  // name AND the raw bank line together, because Plaid's clean name is lossy in
  // exactly the place that matters. It reports the whole of
  // "CHECKCARD 0815 MHE*ALEKS ALEKS.COM NY" as the bare publisher code "MHE" —
  // so matching on the clean name alone, the ALEKS bill could never be
  // recognised, and the real charge was filed as ordinary subscription spend
  // while a hand-typed placeholder settled the bill instead. Every month.
  //
  // Widening to the raw line is safe here precisely because a bill rule names a
  // DISTINCTIVE biller token, and any rule whose token is shared with a
  // neighbouring merchant carries an explicit `not` veto — tested against this
  // same text. Vetoing does not return: it falls through to the ordinary
  // merchant path, which is where the vetoed merchant belongs.
  const billHay = raw ? `${desc} ${raw}` : desc;

  // A charge at a merchant that runs SEPARATE DEPARTMENTS under one brand — a
  // warehouse club with its own fuel station, a supermarket with pumps out front.
  // The clean merchant name is identical for both, so a merchant->category rule is
  // structurally incapable of telling them apart; only the RAW bank descriptor
  // carries the "GAS" / "FUEL" token that distinguishes them.
  //
  // What this cost before the fix: $143 of Sam's Club grocery runs sat in the gas
  // line for July, making fuel read $402 against a real ~$259 — and the wrong number
  // drove a budget re-cut. The fuel token was being thrown away in normalize()
  // before the categorizer ever ran.
  const dept = resolveDepartment(desc, raw);
  if (dept === "fuel") {
    return { kind: "variable", appCategory: "transport", reason: "bank tagged this pump, not the store", confidence: "high" };
  }

  // Descriptors whose correct answer depends on the AMOUNT, not just the merchant:
  // Anthropic bills an identical line for a $21.62 Pro seat and a $108.10 Max seat,
  // and a Zelle to mom is either the support installment or an ad-hoc loan. A learned
  // rule is keyed by merchant ALONE, so it physically cannot express that split — one
  // "Remember" tap on either flattens both cases forever. So these keep their
  // amount-gated branches below and opt OUT of learned-rule precedence.
  //
  // Live damage this caught: a learned `ANTHROPIC -> variable/subscriptions` rule was
  // shadowing the price band, so the $108.10 Max charge landed as variable spend every
  // month instead of settling the "Claude Max" bill — inflating the budget by $108 and
  // leaving the bill showing unpaid.
  //
  // ALEKS opts out for a different reason. McGraw-Hill bills it "MHE*ALEKS
  // ALEKS.COM", and merchantKey() cuts at the "*" — so the learned key is the
  // bare "MHE", three letters naming a PUBLISHER, not a product. A rule that
  // blunt cannot carry a bill link, and while it stood the real $21.57 charge
  // was filed as ordinary subscription spend and a hand-typed "already paid"
  // placeholder settled the bill instead. Two rows, one charge, every month.
  const amountGated =
    /\bANTHROPIC\b|CLAUDE\.AI|\bCLAUDE (PRO|MAX|SUB)\b|ZELLE PAYMENT TO MON\b|MHE\*?ALEKS|\bALEKS\.COM\b/i.test(billHay);

  // 1) A rule you taught the app wins over everything — and is always confident.
  //
  // A rule is stored under the merchant key of whatever descriptor was on screen
  // when it was taught, and there are TWO descriptor namespaces: Plaid's clean
  // merchant name ("Sam's Club", "Parkinsafe Nollie") and the bank's raw
  // statement line ("CHECKCARD 0616 SAMS CLUB.COM"). A rule taught in one
  // namespace was invisible in the other, because merchantKey() on a raw BoA card
  // line stops at the transaction-type prefix and returns the useless
  // "CHECKCARD". Seven live rules were unreachable that way — lessons already
  // taught that the app could not apply. One of them was
  // PARKINSAFE NOLLIE → transport, which, had it been reachable, would have
  // out-ranked the rent rule and prevented a $6.00 parking charge from marking
  // September's $1,732.16 rent paid.
  //
  // So look in both namespaces: the clean name first (unchanged, still wins
  // outright), then the raw line with the statement noise stripped off. The
  // stripping is not optional — a bare merchantKey(raw) collapses every card line
  // to "CHECKCARD" and one rule would then swallow the entire ledger.
  const lr = amountGated ? undefined : learnedFor(key, learned, raw);
  if (lr) {
    if (lr.kind === "bill")
      return { kind: "bill", billName: lr.billName, reason: "you taught it", confidence: "high" };
    if (lr.kind === "skip")
      return { kind: "skip", reason: "you taught it", confidence: "high" };
    return { kind: "variable", appCategory: lr.categoryId, reason: "you taught it", confidence: "high" };
  }

  // Overseas remittances (Pandaremit, Remitly/RMTLY) are money sent abroad — not
  // living spend, so they must never fall through to a dining/other guess. A
  // Remitly outflow that pays down the Mom-China debt is caught earlier in the
  // importer (tracked-debt match) before classify() ever runs, so this only
  // catches the non-debt remittance rails.
  if (/PANDAREMIT|\bREMITLY\b|\bRMTLY\b/i.test(desc)) {
    return { kind: "skip", reason: "overseas remittance", confidence: "high" };
  }

  // Zelle to mom: the monthly assistance is a support-sized payment ($300 going
  // forward, $400 before that). A SMALLER Zelle to mom is an ad-hoc transfer —
  // e.g. a $200 you front and get back a few days later — NOT an assistance
  // installment. Amount-gate it (like the Anthropic price-band below) so a repaid
  // loan never lands on the Mom bill. Below the gate → a personal transfer, kept
  // out of the lean budget; mark it reimbursable if it's owed back.
  if (/ZELLE PAYMENT TO MON\b/i.test(desc)) {
    return Math.abs(amount) >= 250
      ? { kind: "bill", billName: "Mom", reason: "matched bill: Mom (assistance)", confidence: "high" }
      : { kind: "skip", reason: "Zelle to mom below assistance amount — personal transfer", confidence: "low" };
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

  // The cost of carrying a balance — card interest and late/penalty fees. NOT a
  // bill (no recurring row) and NOT living spend: it's already baked into the card
  // balance that the linked debt reads from, so it must never route to a debt or
  // land on a budget line, or it double-counts. Its own category so the price of
  // the debt is visible rather than buried in "other".
  if (/INTEREST CHARGED|FINANCE CHARGE|\bLATE FEE\b|PENALTY FEE/i.test(desc)) {
    return { kind: "variable", appCategory: "interest", reason: "cost of debt (interest / fee)", confidence: "high" };
  }

  for (const r of BILL_RULES) {
    if (r.re.test(billHay) && !(r.not && r.not.test(billHay))) {
      return { kind: "bill", billName: r.bill, reason: `matched bill: ${r.bill}`, confidence: "high" };
    }
  }

  // drift-tolerant alias pass — normalize the descriptor and look for a bill's
  // distinctive alias, so a re-spaced/rebranded descriptor still resolves.
  const normDesc = billKey(billHay);
  for (const b of BILL_ALIASES) {
    if (b.aliases.some((a) => normDesc.includes(a)) && !(b.not && b.not.test(billHay))) {
      return { kind: "bill", billName: b.bill, reason: `matched bill (alias): ${b.bill}`, confidence: "high" };
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
