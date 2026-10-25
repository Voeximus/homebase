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
  // The answer came from a rule added on 2026-10-25 (a taught rule reached through a
  // near spelling — see looseLearnedFor). It may SEED a new row. A row already in the
  // ledger must not be moved by it: "a guess may seed a row, never re-decide one"
  // (schema_v26), and a re-sync re-asks about every row it re-delivers. So `before`
  // carries what the categorizer said before that rule existed, for any caller that is
  // asking about a row that is already there (see forExistingRow).
  seedOnly?: boolean;
  before?: Classification;
}

/** What to apply to a row that is ALREADY in the ledger: the answer as it was before
 *  any seed-only rule, so re-asking about an old row changes nothing it would not have
 *  changed anyway. A new row takes `c` itself. */
export function forExistingRow(c: Classification): Classification {
  return c.seedOnly && c.before ? c.before : c;
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
  s = s
    .replace(/\s{2,}/g, " ")
    .trim()
    .toUpperCase();
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
/**
 * The bills a charge is ALLOWED to settle, given the account it came out of.
 *
 * WHY THIS EXISTS, found 2026-10-05. Both of them had Claude Pro in September. There
 * is one Claude Pro bill, and it is Xinyan's, paid from her account. Gino's own
 * $21.62 "Anthropic" charge on the 8th was matched to that bill BY NAME — the name
 * matcher never asked whose account the money left — so her September bill read
 * "paid on the 8th from Gino's account", and her real payment on the 21st landed as
 * ordinary utilities spending, linked to nothing. Every integrity check passed,
 * because nothing was paid twice and every link pointed somewhere real.
 *
 * So a charge may only settle a bill that is paid FROM ITS OWN ACCOUNT. Two cases
 * stay open on purpose, because closing them would break real payments:
 *
 *   · a bill with no paying account set — nobody has said where it comes from, so
 *     there is nothing to disagree with;
 *   · a charge whose account the app cannot resolve — a feed row from an account it
 *     does not know yet is not evidence of anything.
 *
 * WHAT HAPPENS TO THE CHARGE THAT NO LONGER MATCHES. It is not dropped. The caller
 * already routes "the categorizer named a bill but no bill resolved" to needs_review,
 * and that is exactly right here: a charge naming a bill on the wrong account is
 * either a second person's subscription that has no bill of its own, or a bill whose
 * paying account is out of date. Both want a person, and both are visible — which is
 * the trade against the old behaviour, where the wrong answer was silent.
 */
export function billsPayableFrom<T extends { account_id?: string | null }>(
  bills: readonly T[],
  chargeAccountId: string | null | undefined,
): T[] {
  if (!chargeAccountId) return [...bills];
  return bills.filter((b) => !b.account_id || b.account_id === chargeAccountId);
}

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

// ── Which bill a charge pays, when the household pays from any account ────────
//
// FOUND 2026-10-24. The household is one unit and pays a bill from whichever account
// has the money that week, and billsPayableFrom (above) only ever let a charge settle a
// bill set to pay from the charge's OWN account. So the car insurance came out of two
// different accounts and not one instalment linked, and an electric bill paid from the
// joint account never linked while the bill named another account. Each of those
// charges was filed as spending AND left the bill reading unpaid — and that unpaid bill
// is what got a hand-made "(already paid)" note written on top of the real charge.
//
// The fix is a fallback, never a replacement, and these are the pieces it stands on.
// Everything below is shared byte-for-byte with the bank sync (this file has an edge
// copy), so the sync, the app's audit and its suggestions ask ONE question.

/**
 * How far a charge may be from a bill's figure and still be that bill. The band the
 * bank sync's day-and-amount matcher has always used (matchBillByDayAmount in
 * plaid/index.ts) and Worth a look borrows (ledgerReview.ts band()): a fixed bill is
 * nearly exact — a $21 subscription cannot absorb a $10 one — while a variable bill's
 * figure is an estimate by design and keeps generous slack.
 */
export function billAmountBand(modelled: number, variable: boolean | null | undefined): number {
  return variable ? Math.max(15, 0.15 * modelled) : Math.max(2, 0.03 * modelled);
}

/**
 * Is a bill live on the date a payment posted? A week of slack on each edge, so paying
 * a few days either side of a window boundary still resolves to the right bill — the
 * same seven days billCycleFor's grace uses. Moved here from plaid/index.ts on
 * 2026-10-24 (it was `liveOnDate` there) so the app's audit narrows bills exactly the
 * way the sync does, rather than by a second spelling of the window.
 */
export function billLiveOnPaymentDate(
  r: { starts_on?: string | null; ends_on?: string | null },
  iso: string,
): boolean {
  const shift = (d: string, days: number) => {
    const t = Date.parse(d + "T00:00:00Z");
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
  };
  if (r.starts_on && iso < shift(r.starts_on, -7)) return false;
  if (r.ends_on && iso > shift(r.ends_on, 7)) return false;
  return true;
}

/** A bill row, in the columns the household fallback reads — snake_case, the way the
 *  bank sync selects them. The app maps its Recurring rows onto this shape. */
export interface PayableBill {
  name: string;
  account_id?: string | null;
  amount?: number | string | null;
  known_amount?: number | string | null;
  variable?: boolean | null;
  due_days?: number[] | null;
  cadence?: string | null;
}

/**
 * What ONE charge toward this bill is expected to be. The figure a person read off the
 * bill (known_amount) beats the contracted one, as everywhere else. A bill paid in
 * instalments — two due days in a month — expects a share per charge, the way the
 * calendar places it (schedule.ts divides by the due-day count); a biweekly bill charges
 * its whole amount each time. NaN when the row carries no figure, which matches nothing.
 */
export function billPerCharge(b: PayableBill): number {
  const known = b.known_amount == null ? NaN : Number(b.known_amount);
  const figure = Number.isFinite(known) && known > 0 ? known : Number(b.amount);
  if (!(figure > 0)) return NaN;
  const days = Array.isArray(b.due_days) ? b.due_days.length : 0;
  return b.cadence !== "biweekly" && days > 1 ? figure / days : figure;
}

/** The accounts the HOUSEHOLD holds together — owned "Joint". See matchBillForCharge
 *  for why the fallback needs to know which ones they are. */
export function sharedAccountIds(accounts: readonly { id: string; owner?: string | null }[]): Set<string> {
  return new Set(accounts.filter((a) => a.owner === "Joint").map((a) => a.id));
}

/**
 * The bill this charge pays, or null.
 *
 * FIRST, EXACTLY AS BEFORE: the name match over the bills paid from the charge's own
 * account and the bills with no account (billsPayableFrom). Unchanged on purpose — that
 * path carries no amount gate today and gains none, so nothing that links today stops
 * linking. An own-account match always wins over one on another account.
 *
 * THEN, ONLY IF THAT FOUND NOTHING: the bills set on the household's other accounts —
 * and only on two conditions at once, both stricter than the first pass:
 *
 *   · the NAME match, never anything weaker. matchRecurringName resolves the name the
 *     categorizer gave (a bill rule or one of the bill's aliases); the day-and-amount
 *     guess the sync keeps for unnamed bill payments never crosses accounts.
 *   · the AMOUNT, inside billAmountBand of what one charge toward that bill should be.
 *     The own-account pass has no such gate, and a cross-account match on the name
 *     alone is how a small charge would settle a large bill — the $6 parking charge
 *     that once settled a whole month's rent, arriving by a new door.
 *
 * AND ONE ACCOUNT ON EITHER SIDE MUST BE SHARED. This is the guard that keeps the reason
 * billsPayableFrom was written. Both of them have their own Claude Pro seat and there is
 * one Claude Pro bill, Xinyan's: Gino's own charge from his own account names the same
 * bill at the same price, so name and amount both pass. What tells the two shapes apart
 * is whose accounts are involved. A household bill paid from the joint account, or a
 * bill set on the joint account paid from either person's, is the household paying from
 * wherever the money is. One person's charge against a bill set on the OTHER person's
 * own account is exactly the shape where each of them can hold the same subscription —
 * so that one still falls through to needs_review, as it does today.
 *
 * THE GUARD HAS TWO EDGES, and both are known, said here so nobody finds them the hard
 * way (found in review, 2026-10-25):
 *   · it lets through one person's own subscription paid FROM the joint account against
 *     the other person's same-named bill — a Claude Pro charge from the joint account
 *     settles the Claude Pro bill set on one person's account, whichever seat it was.
 *     The joint account is the household's money, so that is read as the household
 *     paying; when it is the wrong seat, the self-check below names the payment and a
 *     person unlinks it.
 *   · it never links a payment between the two PERSONAL accounts: a bill set on one
 *     person's account and paid from the other person's stays unlinked (needs_review),
 *     exactly as before 2026-10-24. If the household really pays a bill that way, the
 *     fix is to move the bill to the account it is paid from (or to the joint one).
 *
 * A linked payment from another account is still a payment from the wrong account, and
 * the self-check "paid-from-its-own-account" still says so — so a person can move the
 * bill to where it is really paid from. It just no longer stops the link.
 */
export function matchBillForCharge<T extends PayableBill>(
  billName: string | undefined | null,
  bills: readonly T[],
  chargeAccountId: string | null | undefined,
  chargeAmount: number,
  shared: ReadonlySet<string>,
): { bill: T; fromAnotherAccount: boolean } | null {
  const own = matchRecurringName(billName, billsPayableFrom(bills, chargeAccountId));
  if (own) return { bill: own, fromAnotherAccount: false };
  // An unknown account already searched every bill above.
  if (!billName || !chargeAccountId) return null;
  const chargeShared = shared.has(chargeAccountId);
  const elsewhere = bills.filter(
    (b) => !!b.account_id && b.account_id !== chargeAccountId && (chargeShared || shared.has(b.account_id)),
  );
  const named = matchRecurringName(billName, elsewhere);
  if (!named) return null;
  const expected = billPerCharge(named);
  const paid = Math.abs(Number(chargeAmount));
  if (!(expected > 0) || !Number.isFinite(paid)) return null;
  if (Math.abs(paid - expected) > billAmountBand(expected, named.variable)) return null;
  return { bill: named, fromAnotherAccount: true };
}

/** Strip the noise the bank wraps a raw statement line in — the transaction-type
 *  prefix, the MMDD date, masked card digits, store #, "RECURRING" — so a known
 *  merchant hidden inside a raw line ("PURCHASE 0321 YAMI.COM YAMIBUY.COM/ECA
 *  XXXXX…7296") can still be recognized. Used only as a last resort in classify(),
 *  so it can never change a line the normal path already classified. */
export function stripStatementNoise(desc: string): string {
  let s = " " + desc.toUpperCase() + " ";
  s = s.replace(
    /\b(MOBILE PURCHASE|CHECKCARD PURCHASE|CHECKCARD|POS PURCHASE|POS DEBIT|DEBIT CARD PURCHASE|RECURRING PAYMENT|MOBILE PAYMENT|PURCHASE)\b/g,
    " ",
  );
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

/** The merchant keys learnedFor() looks a rule up under, in its order: the clean
 *  name's own key, then the raw line's with the statement noise stripped. */
function ruleLookupKeys(key: string, raw?: string): string[] {
  const out = key ? [key] : [];
  const cleaned = raw ? stripStatementNoise(raw) : "";
  const rawKey = cleaned ? merchantKey(cleaned) : "";
  if (rawKey.length >= 2 && rawKey !== key) out.push(rawKey);
  return out;
}

// The payment rails and the bank's own account-to-account wording, as they read once
// stripStatementNoise() has taken the card-line prefixes off. Each one names HOW money
// moved, never WHO it went to — so a key that is nothing more than one of these is the
// bank's sentence, not a merchant.
const BARE_RAILS =
  /^(?:POS|DEBIT|DEBIT CARD|CHECK|DEPOSIT|WITHDRAWAL|WITHDRWL|ACH(?: (?:DEBIT|CREDIT|PAYMENT|TRANSFER|WITHDRAWAL|DEPOSIT))?|ZELLE(?: (?:TRANSFER|PAYMENT)(?: (?:TO|FROM))?)?)$/;

// "Online Banking payment to CRD 4728 Confirmation# …" and "Mobile Banking payment to
// CRD 6813 …" both key to "… PAYMENT TO CR": merchantKey() cuts the card number off at
// the digits, and its 28-character slice then cuts "CRD" in half. The account number
// was the only thing that told the two cards apart, and it is gone from the key. So
// these shapes are noise too, whether the account word survived whole, cut short, or
// not at all — but ONLY when what is left is an account word. "PAYMENT TO JOHN" names
// somebody and stays a merchant.
const ACCOUNT_MOVE = /^(?:(?:ONLINE|MOBILE) BANKING )?(?:PAYMENT|TRANSFER)(?: (?:TO|FROM)(?: ([A-Z]+))?)?$/;
const ACCOUNT_WORDS = ["CRD", "CHK", "SAV", "ACCT", "ACCOUNT", "CARD"];

// The cash machine and the bank's own deposit channel. FOUND 2026-10-09 in review of
// this very predicate, which let them through. Every Bank of America ATM line —
// "BKOFAMERICA ATM 08/31 #000004567 WITHDRWL PHOENIX AZ", and the bare "Bkofamerica
// Atm" the feed sends when it has nothing better — keys to "BKOFAMERICA ATM":
// merchantKey() cuts the line at the date, so the WITHDRWL or DEPOSIT word that says
// which way the cash went never reaches the key. Another bank's machine reads
// "EFT 10/03 #XXXXX1234 WITHDRWL EFT" and keys to the bare "EFT" (the withdrawal and
// its fee both), and a phone cheque deposit, "BKOFAMERICA MOBILE 09/25 … DEPOSIT",
// keys to "BKOFAMERICA MOBILE". All three were live keys in the ledger that day, with
// ten rows between them. Each one names the MACHINE or the CHANNEL, never
// what the cash went on or who paid it in — which is exactly why classify() sends a
// withdrawal to a person as "cash withdrawal — say what it went on" at low
// confidence. A rule on one of these keys is looked up BEFORE that block (learnedFor
// is step one), so one "Remember merchant" tap on a withdrawal spent on dinner would
// file every later withdrawal as dining, at high confidence, and the question would
// never be asked again. The CHECKCARD failure, through the cash machine.
//
// Narrow on purpose. Only the bank's own name, or nothing, may stand in front, and
// only cash words after. "ATM FEE" is not here: every ATM fee IS a fee, so a rule on
// it is right. An operator that names itself ("COINME ATM") is a merchant, not this.
const CASH_MACHINE =
  /^(?:(?:BKOFAMERICA|BANK OF AMERICA) )?(?:ATM|EFT)(?: (?:CASH|WITHDRAWAL|WITHDRWL|DEPOSIT))*$|^(?:BKOFAMERICA|BANK OF AMERICA) MOBILE(?: DEPOSIT)?$/;

/**
 * Is this merchant key the bank's own wording rather than a merchant?
 *
 * FOUND 2026-10-09. A saved rule "CHECKCARD -> dining", made on 2026-09-24 from one tap
 * in the app, files every Bank of America card line that has no clean name as dining.
 * learnedFor() above already says why in its own comment: merchantKey() on a raw card
 * line returns the literal word "CHECKCARD" for every one of them, so a rule on that
 * word is a rule on all of them — nine charges in the ledger carried that key that day.
 * A "ZELLE TRANSFER" rule had been saved the same way.
 *
 * WHERE THE LIST COMES FROM. Not typed fresh: it is the prefixes stripStatementNoise()
 * already strips (a key with nothing left after stripping is ALL prefix), plus the bare
 * rails and the account-to-account shapes this file and flow.ts already recognise —
 * the "TRANSFER TO ACCT", "PAYMENT FROM CHK" and "… payment to CRD nnnn" lines that
 * classifyCredit, classifyCore and the card-payment bill rules read — and the cash
 * machine keys ("BKOFAMERICA ATM", "EFT") that classify()'s ATM block reads.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR. Every path that SAVES a merchant rule asks
 * this first and refuses the key — the write door's finance.learn_merchant and
 * promote_to_bill, and the app's saveMerchantRule and makeRecurringBill. It does NOT
 * change how a saved rule matches: learnedFor() is untouched, and the rules already in
 * the table keep firing exactly as before. Deleting or editing those is Gino's call,
 * not this function's.
 *
 * Deliberately exact rather than a prefix test. "INTEREST CHARGED ON PURCHASE" ends in
 * a prefix word and is a real kind of charge with a real rule; "ZELLE PAYMENT TO MON"
 * starts with a rail and is the Mom bill. Only a key with NOTHING distinctive left in
 * it is noise.
 */
export function isStatementNoiseKey(key: string): boolean {
  const k = (key ?? "").trim().toUpperCase();
  // The same floor learnedFor() uses. Two characters can be a real merchant — "QT" is
  // QuikTrip — so the floor is one, not two.
  if (k.length < 2) return true;
  const left = stripStatementNoise(k);
  if (!left) return true;
  if (BARE_RAILS.test(left)) return true;
  if (CASH_MACHINE.test(left)) return true;
  const move = ACCOUNT_MOVE.exec(left);
  if (move) {
    const word = move[1];
    return !word || ACCOUNT_WORDS.some((w) => w.startsWith(word));
  }
  return false;
}

// ── one merchant, spelled two ways ─────────────────────────────────────────────
//
// FOUND 2026-10-25, looking back over the charges the app had flagged for review
// while nobody was watching. A rule you taught matched only the WHOLE merchant key,
// character for character, so the same shop spelled a second way was a stranger. A
// rule taught on "H MART MESA LLC" never reached the charges Plaid names plain
// "H Mart"; a rule on "E.T. TEA" never reached "E T Tea & Popcorn Chicken". Shops
// already answered were asked about again, and the saved rules show the same thing
// from the other side: one shop taught two and three times, once per spelling.
//
// So a name is reduced to its CORE before two names are compared: case, punctuation
// and apostrophes go, a store number goes (#1234, STORE 123, T-1429, AZ1501), and so
// do the words a bank tacks on the end — a corporate suffix (LLC, INC, CO, CORP, LTD),
// a state code, a town the household shops in. Two names whose cores are equal are
// one merchant.
//
// A TOWN OR STATE COMES OFF ONLY WHEN A NAME IS LEFT IN FRONT OF IT. FOUND 2026-10-25
// in review, before any of this shipped: the place came off whatever was left, so
// "CITY OF PHOENIX", "CITY OF MESA" and "CITY OF TEMPE" all came down to "CITY
// OF", "UNIVERSITY OF ARIZONA" to the same core as "UNIVERSITY OF PHOENIX", "TOWN OF
// GILBERT" to the same as "TOWN OF QUEEN CREEK" — and equal cores need no floor to
// match. A rule taught on one city's parking fee would then have filed every other
// city's charges, a water bill no bill rule catches among them, at high confidence and
// without asking; and after any spend at one city, money in from another would have
// read as a refund. The ledger already had a key of that shape. In those names the
// place IS the name — what tells one city from the next — so it stays on whenever the
// words in front fail the same floor as below (two real words, five letters) or end
// in a filler word ("FAMILY DENTAL OF" before a town). The cost, taken on purpose: a
// ONE-word name keeps its town too, so "FJORDIA TEMPE" no longer meets a plain
// "FJORDIA". One word is too little to tell a brand from a word like "CITY" or
// "DOWNTOWN" that many places share.
//
// And one core may run on past the other — "E T TEA" is the start of "E T TEA POPCORN
// CHICKEN", "H MART" the start of "H MART MESA" — but only when the SHORTER one is a
// name on its own: two words or more that are not "the"/"of"/"and", five letters at
// least between them. That floor is what stops a short key swallowing a longer,
// different merchant. It is whole words, never letters, so "SAM" cannot reach
// "SAMS CLUB"; and a one-word name only ever matches itself, so "UBER" cannot reach
// "UBER EATS" and "AMAZON" cannot reach "AMAZON KINDLE", which this household files
// differently on purpose.
//
// What it refuses outright: the bank's own wording (isStatementNoiseKey — a loose
// "CHECKCARD" would be the whole ledger), and any name that starts with a payment
// rail. "ZELLE PAYMENT TO" is the bank's sentence and the PERSON is everything after
// it, so a loose match there would hand one person's rule to everyone who shares a
// first name with them.

const CORPORATE_SUFFIXES = new Set(["LLC", "INC", "CO", "CORP", "CORPORATION", "INCORPORATED", "LTD", "LLP", "PLLC", "COMPANY"]);

// A state code only comes off when a name is left in front of it (placeCanGo):
// "NOLLIE MA" is a name, and "IKEA TEMPE AZ" is a name and a place.
const US_STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "),
);

// Towns the bank appends to a merchant here, read off the household's own charges. A
// place, not a word that could be part of a name, so "SURPRISE" is not on it. The bank
// also cuts names short ("CHUBBY SKEWERS PHOENI", "HAIDILAO HOT POT ARIZON"), so a last
// word of six letters or more that BEGINS one of these is a place too.
const LOCATION_WORDS: readonly string[][] = [
  "ARIZONA", "PHOENIX", "TEMPE", "MESA", "CHANDLER", "GILBERT", "SCOTTSDALE", "GLENDALE",
  "PEORIA", "TUCSON", "FLAGSTAFF", "SEDONA", "PAYSON", "KINGMAN", "AVONDALE", "GOODYEAR",
  "QUEEN CREEK", "APACHE JUNCTION", "LAS VEGAS", "NORTH LAS VEGAS", "HENDERSON",
].map((w) => w.split(" "));

const NOT_A_NAME_WORD = new Set(["THE", "A", "AN", "OF", "AND", "AT", "BY", "FOR", "IN", "ON", "TO"]);

// The rails, as the first word or two of a key. See the note above.
const RAIL_LED = /^(?:ZELLE|VENMO|PAYPAL|CASH APP|APPLE CASH|ONLINE BANKING|MOBILE BANKING|PAYMENT|TRANSFER|CHECKCARD|PURCHASE|DEPOSIT|WITHDRAWAL|ATM)\b/;

/** A merchant key with its core worked out once, or null when the key may not be
 *  matched loosely at all (the bank's own wording, a payment rail, nothing left). */
export interface CoredKey {
  key: string;
  core: string[];
}
function coredKey(key: string): CoredKey | null {
  if (!key || isStatementNoiseKey(key)) return null;
  const core = merchantCore(key);
  if (!core.length || RAIL_LED.test(core.join(" "))) return null;
  return { key, core };
}

/** The words of a merchant name once the spelling noise is gone — see the note above.
 *  Empty when nothing is left. */
export function merchantCore(name: string): string[] {
  let s = (name ?? "").toUpperCase();
  s = s.replace(/&APOS;?|&#39;?/g, "'").replace(/&AMP;?/g, " ");
  s = s.replace(/['’`]/g, "");
  // Store numbers, before the punctuation goes: "#1234", "STORE 123", "T-1429".
  s = s.replace(/#\s*[A-Z]*\d[A-Z0-9-]*/g, " ");
  s = s.replace(/\b(?:STORE|STR|STE|UNIT|NO)\.?\s*#?\s*\d+\b/g, " ");
  s = s.replace(/\b([A-Z]{1,3})-(\d{2,})\b/g, "$1$2");
  let words = s.split(/[^A-Z0-9]+/).filter(Boolean);
  // A lone S after a word is what is left of an apostrophe: "JOE S" is "JOES".
  words = words.reduce<string[]>((out, w) => {
    if (w === "S" && out.length) out[out.length - 1] += "S";
    else out.push(w);
    return out;
  }, []);
  // A word carrying a digit is a store or terminal code — except as the FIRST word,
  // where it is the name ("7 ELEVEN", "99 RANCH MARKET", "365 RETAIL MARKETS").
  words = words.filter((w, i) => i === 0 || !/\d/.test(w));
  // Then the trailing words a bank adds: a corporate suffix as long as something is
  // left in front, a state or a town only when a NAME is left in front (placeCanGo).
  for (;;) {
    const last = words[words.length - 1];
    if (words.length > 1 && CORPORATE_SUFFIXES.has(last)) { words.pop(); continue; }
    if (US_STATE_CODES.has(last) && placeCanGo(words.slice(0, -1))) { words.pop(); continue; }
    const place = LOCATION_WORDS.find(
      (p) => words.length > p.length && p.every((w, i) => {
        const at = words[words.length - p.length + i];
        // The bank's cut can only fall on the last word.
        return at === w || (i === p.length - 1 && at.length >= 6 && w.startsWith(at));
      }),
    );
    if (place && placeCanGo(words.slice(0, words.length - place.length))) {
      words.splice(words.length - place.length);
      continue;
    }
    break;
  }
  return words;
}

/** May a trailing town or state come off, leaving `rest`? Only when `rest` is a name
 *  on its own — the isWholeName floor — and does not end in a filler word. "CITY OF"
 *  and "UNIVERSITY OF" are not names; the place after them is. See the note above. */
function placeCanGo(rest: readonly string[]): boolean {
  return isWholeName(rest) && !NOT_A_NAME_WORD.has(rest[rest.length - 1]);
}

/** Is the shorter core a name on its own, strong enough to be the start of a longer
 *  one? Two words that are not filler, five letters between them. */
function isWholeName(core: readonly string[]): boolean {
  const named = core.filter((w) => !NOT_A_NAME_WORD.has(w));
  return named.length >= 2 && named.join("").replace(/[^A-Z]/g, "").length >= 5;
}

/**
 * Are these two merchant keys the same merchant, spelled differently? Exact keys are
 * the caller's job — this is the second look. See the note above for what counts.
 */
export function looseMerchantMatch(a: string, b: string): boolean {
  const ca = coredKey(a);
  const cb = coredKey(b);
  return !!ca && !!cb && coresMatch(ca.core, cb.core);
}

function coresMatch(ca: readonly string[], cb: readonly string[]): boolean {
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (!short.every((w, i) => w === long[i])) return false;
  return short.length === long.length || isWholeName(short);
}

// Built once per rule set, not once per charge: the feed classifies every row of a
// sync against the same rules.
const looseRuleCache = new WeakMap<LearnedRules, { size: number; rules: { cored: CoredKey; rule: LearnedRule }[] }>();

/**
 * A learned rule reached through a near spelling of its merchant — the second look,
 * after the exact one in learnedFor() has missed. `keys` are the charge's merchant
 * keys, both namespaces, exactly the ones learnedFor() tried.
 *
 * Only ORDINARY-SPENDING rules with a real category take part. A bill rule settles a
 * bill cycle, and settling one on a near match is how a $6 parking charge once paid a
 * month's rent; a skip rule writes the charge nowhere. Both stay exact-only.
 *
 * When two rules reach the same charge and disagree, neither wins: the app does not
 * know which shop this is, so it says nothing and the charge is asked about, as it
 * would have been before.
 */
export function looseLearnedFor(
  keys: readonly string[],
  learned: LearnedRules | undefined,
): { rule: LearnedRule; pattern: string } | undefined {
  if (!learned) return undefined;
  const entries = Object.entries(learned);
  let cached = looseRuleCache.get(learned);
  // A rule set that grew or shrank since it was cached is read again.
  if (!cached || cached.size !== entries.length) {
    const built: { cored: CoredKey; rule: LearnedRule }[] = [];
    for (const [pattern, rule] of entries) {
      if (rule.kind !== "variable" || !rule.categoryId || rule.categoryId === "other") continue;
      const cored = coredKey(pattern);
      if (cored) built.push({ cored, rule });
    }
    cached = { size: entries.length, rules: built };
    looseRuleCache.set(learned, cached);
  }
  const rules = cached.rules;
  const charge = keys.map(coredKey).filter((k): k is CoredKey => !!k);
  if (!charge.length) return undefined;
  const hits = rules.filter((r) => charge.some((k) => coresMatch(r.cored.core, k.core)));
  if (!hits.length) return undefined;
  if (hits.some((h) => h.rule.categoryId !== hits[0].rule.categoryId)) return undefined;
  return { rule: hits[0].rule, pattern: hits[0].cored.key };
}

/** For an INCOMING credit (positive amount): is it real income — to surface and to
 *  match reimbursement paybacks against — or just an internal transfer between the
 *  household's OWN accounts (same dollars moving, not new money → stays hidden)?
 *  Paychecks, refunds, cashback, and money people send you all read as income;
 *  only "Internal:" history labels (account-to-account, spouse shuffle) are transfers. */
export function classifyCredit(desc: string): "income" | "transfer" {
  // Card-payment credits ("PAYMENT FROM CHK …" landing ON a credit card) are the
  // household's OWN money moving — the paired checking outflow is already recorded —
  // so they must NOT book as new income (that both inflates gross income and
  // double-counts the transfer). They carry no "Internal:" history label, so detect
  // them explicitly.
  //
  // CHANGED 2026-10-25: an ATM cash deposit is no longer one of these. It was, on the
  // reasoning that the cash was already the household's — but the withdrawal it came
  // out of IS recorded, as spending ("cash withdrawal — say what it went on"), so the
  // ledger saw the cash leave and never saw any of it come back: $100 out, $40 of it
  // put back unspent, and the only record was the $100 leaving. It is written now, as
  // cash coming back (category `refund` — see CASH_PUT_BACK and creditCategory), which
  // flow.ts reads as `returned`. What that fixes: the deposit is in the ledger, it is
  // not counted as earnings, and the checking account's cash change for the month is
  // right. What it does NOT fix, said here so nobody reads more into it: spending. The
  // run rate leaves a returned row out of net and the budget reads only expenses, so
  // the withdrawal still counts as spent in full, and spending is still overstated by
  // the cash put back. Bringing spending down means netting cash put back against cash
  // taken out — a separate piece, and Gino's call. A phone cheque deposit never was
  // dropped here, and still is not.
  if (
    // "TRANSFER FROM ACCT #1211 ON 09/10 VIA WEB" is how Bank of America words a
    // PENDING internal transfer. The POSTED twin reads "Online Banking transfer
    // from CHK 1211", which the "Internal:" history label below already catches —
    // so only the settled form was known, and a $39 shuffle between his own two
    // checking accounts booked as other-income for as long as it was processing.
    /\bPAYMENT FROM (CHK|SAV)\b/i.test(desc) ||
    /\bTRANSFER (FROM|TO) (ACCT|ACCOUNT|CHK|SAV)\b/i.test(desc)
  )
    return "transfer";
  const his = hisLookup(merchantKey(desc));
  if (his && his.startsWith("Internal:"))
    return "transfer";
  return "income";
}

// ── what money coming in IS ───────────────────────────────────────────────────
//
// FOUND 2026-10-25. Every credit that was not a paycheck or a transfer was filed
// `other-income`, and other-income counts as EARNED (src/lib/flow.ts) — so a refund
// for an online order, a friend paying back their half of dinner, and cash put back in
// the bank all read as the household making money. Money back for something already
// spent is not earnings; counting it is counting the same dollar twice, once out and
// once in. flow.ts already reads the `refund` category as exactly that ("returned").
// Nothing was putting rows in it except a person by hand.
//
// So a credit is a `refund` when the household's own ledger says it is money back:
//   · a credit from a merchant the household has SPENT AT — the same merchant, by
//     the same near-spelling rule a taught rule uses (looseMerchantMatch);
//   · a Zelle IN from a person the household has sent a Zelle TO — the friend who
//     covered dinner and was paid back, or the other way round;
//   · cash put back into the bank at an ATM (CASH_PUT_BACK), which needs no history.
//
// What does NOT change, said out loud because each one was decided:
//   · a paycheck is `salary`, first, exactly as before;
//   · a transfer between the household's own accounts, the spouse's Zelles and the
//     card-payment credits are still dropped by classifyCredit before this is asked;
//   · Zelles to and from Gino's mom: support she is sent is a bill, not a tab, so a
//     person the Mom rule pays never counts as someone money comes BACK from;
//   · tax refunds, payroll and payout platforms, remittance rails, interest and
//     cashback stay `other-income` even when the household has paid that name before
//     — a tax refund from an agency the household once paid is still income.
//   · SEED ONLY. A credit already in the ledger keeps its category on a re-sync; the
//     importer sends these with keep_category (schema_v26).
//
// What the payback rule CANNOT see, and files wrong — FOUND 2026-10-25 in review, left
// open on purpose:
//   · WHY THE MONEY CAME. It reads the person, never the memo. A Zelle in from
//     someone the household once paid is a payback whatever it says it is for — pay
//     for a job or for taking part in a study, money for something sold, a gift (a
//     wedding gift from a friend they have Zelled before). Each of those is earnings
//     or a gift, not money back, and lands in `refund` all the same, out of income.
//     The ledger already holds one such row, filed other-income before this rule; the
//     next one like it would be a refund. Whether a Zelle in that carries a memo keeps
//     this seed or stays other-income is Gino's call, not a guess for this file to
//     make; until he makes it, a person refiles that one row by hand.
//   · A CHEQUE AT THE CASH MACHINE. See CASH_PUT_BACK.
// And what it leaves out on purpose: a person the household's own history labels as
// one of them ("Internal:", the spouse) is never someone money comes back FROM — a
// Zelle between the two of them is money moving, not a tab being settled.

/** Cash put back into the bank at a cash machine.
 *
 *  It cannot tell cash from a cheque. A cheque deposited at a Bank of America machine
 *  is worded the same way ("BKOFAMERICA ATM … DEPOSIT"), so it is filed here too —
 *  `refund`, "cash put back into the bank" — though a cheque is pay, a gift or a tax
 *  refund. Nothing in the line says which. Before 2026-10-25 every such credit was
 *  dropped (classifyCredit called it a transfer), so the earned figures are no worse
 *  than they were; the LABEL is wrong for a cheque, and a test pins that, so a later
 *  reader knows the rule's limit rather than finding it. A phone cheque deposit
 *  ("BKOFAMERICA MOBILE … DEPOSIT") is a different line and is not matched here. */
const CASH_PUT_BACK = /BKOFAMERICA ATM|\bATM\b[^]*\bDEPOSIT\b|\bCASH DEPOSIT\b/i;

/** Names whose money in is income even when the household has paid that name before. */
const NOT_A_PAYBACK =
  /\bIRS\b|INTERNAL REVENUE|\bTREAS(?:URY)?\b|DEPT OF REV|DEPARTMENT OF REVENUE|\bTAX REF|\bPAYROLL\b|DIRECT DEP|\bPAYOUT\b|\bPAYPAL\b|\bVENMO\b|CASH APP|\bSTRIPE\b|\bUPWORK\b|\bFIVERR\b|PANDAREMIT|\bREMITLY\b|\bRMTLY\b|\bINTEREST\b|CASH ?BACK|\bREWARDS?\b|\bDIVIDEND/i;

// The Mom bill's own test, as classifyCore applies it to money out.
const MOM_ZELLE = /ZELLE PAYMENT TO MON\b/i;

/**
 * The person on the other end of a Zelle, as words, or null when this is not a Zelle
 * in that direction. The posted wording names the direction ("Zelle payment to X",
 * "Zelle payment from X"); the pending wording ("Zelle Transfer Conf# …; X") does not,
 * so the caller vouches for it from the sign of the amount. The memo and the
 * confirmation code are not part of the name.
 */
function zellePerson(desc: string, dir: "to" | "from"): string[] | null {
  const words = (s: string) => s.toUpperCase().replace(/[^A-Z]+/g, " ").trim().split(" ").filter(Boolean);
  const posted = desc.match(/^\s*ZELLE PAYMENT (TO|FROM)\s+(.+?)(?:\s+FOR\b|\s*;|\s+CONF\s*#|$)/i);
  if (posted) return posted[1].toLowerCase() === dir ? words(posted[2]) : null;
  const pending = desc.match(/^\s*ZELLE TRANSFER\s+CONF\s*#\s*[A-Z0-9]+\s*;\s*(.*\S)\s*$/i);
  return pending ? words(pending[1]) : null;
}

/** One person, written two ways: the shorter name is the start of the longer, whole
 *  words, and its first word is a real name of three letters or more — "RIVA TOLL" is
 *  "RIVA TOLL JR", "DAN" is not "DANIELA".
 *
 *  A ONE-word name matches only itself, word for word. FOUND 2026-10-25 in review: the
 *  start-of rule let a bare first name match any longer name beginning with it, so a
 *  Zelle in from "DAN BRIGHT" counted as the same person as a "DAN" once paid, and the
 *  other way round. That is the first-name collision RAIL_LED refuses on the merchant
 *  side, and the household's own history has a one-word, three-letter name in it —
 *  one of the household. Two people who share a first name are two people. */
function samePerson(a: readonly string[], b: readonly string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.length || short[0].length < 3) return false;
  if (short.length === 1) return long.length === 1 && short[0] === long[0];
  return short.every((w, i) => w === long[i]);
}

/** Is this person one of the household, by Gino's own history labels? A Zelle to or
 *  from them labelled "Internal:" (the spouse) is money moving between their own
 *  pockets, so they are never someone money comes back from. */
function householdPerson(person: readonly string[]): boolean {
  const said = person.join(" ");
  return [`Zelle payment to ${said}`, `Zelle payment from ${said}`].some(
    (d) => hisLookup(merchantKey(d))?.startsWith("Internal:") === true,
  );
}

/** What the household's own ledger says about where its money has gone — read from
 *  the descriptions of money OUT, and asked by creditCategory. */
export interface CreditHistory {
  spentAt: readonly CoredKey[];
  spentKeys: ReadonlySet<string>;
  zelledTo: readonly string[][];
}

/** Build the history from the descriptions of the ledger's money-out rows. */
export function creditHistoryFrom(spentDescriptions: Iterable<string | null | undefined>): CreditHistory {
  const spentKeys = new Set<string>();
  const spentAt: CoredKey[] = [];
  const zelledTo: string[][] = [];
  const people = new Set<string>();
  for (const d of spentDescriptions) {
    if (!d) continue;
    const person = zellePerson(d, "to");
    if (person) {
      // A Zelle is a person, never a merchant. The person the Mom bill pays is left out,
      // and so is one of the household (householdPerson, 2026-10-25 in review: a Zelle
      // between the two of them put one of them on this list, so a Zelle in from them
      // that no history label caught — the pending wording carries none — could be
      // filed as a payback).
      const said = person.join(" ");
      if (!MOM_ZELLE.test(`Zelle payment to ${said}`) && !householdPerson(person) && !people.has(said)) {
        people.add(said);
        zelledTo.push(person);
      }
      continue;
    }
    for (const k of [merchantKey(d), merchantKey(stripStatementNoise(d))]) {
      if (spentKeys.has(k)) continue;
      const cored = coredKey(k);
      if (!cored) continue;
      spentKeys.add(k);
      spentAt.push(cored);
    }
  }
  return { spentAt, spentKeys, zelledTo };
}

export interface CreditCategory {
  categoryId: "salary" | "refund" | "other-income";
  reason: string;
  /** Decided by a rule added 2026-10-25: may seed a new row, never re-decide one. */
  seedOnly?: boolean;
}

/**
 * The category of a credit classifyCredit has already called income. `raw` is the
 * bank's own line, `history` the household's money out (creditHistoryFrom). Without
 * history only the paycheck and cash-machine rules can answer, and everything else is
 * `other-income` as before.
 */
export function creditCategory(desc: string, raw?: string, history?: CreditHistory): CreditCategory {
  if (isPaycheck(desc)) return { categoryId: "salary", reason: "a paycheck" };
  const sources = raw && raw !== desc ? [desc, raw] : [desc];
  const hay = sources.join(" ");
  if (CASH_PUT_BACK.test(hay)) {
    return { categoryId: "refund", reason: "cash put back into the bank", seedOnly: true };
  }
  const income: CreditCategory = { categoryId: "other-income", reason: "money in" };
  if (!history || NOT_A_PAYBACK.test(hay)) return income;
  const his = hisLookup(merchantKey(desc));
  if (his && (his.startsWith("Income:") || his === "Cashback")) return income;

  const person = sources.map((s) => zellePerson(s, "from")).find((p) => p !== null);
  if (person) {
    // A Zelle in is a person, and only ever matched as one — and one of the household
    // is never paying anything back (householdPerson).
    return !householdPerson(person) && history.zelledTo.some((p) => samePerson(p, person))
      ? { categoryId: "refund", reason: "money back from someone you have sent money to", seedOnly: true }
      : income;
  }

  const keys = sources.flatMap((s) => [merchantKey(s), merchantKey(stripStatementNoise(s))]);
  for (const k of keys) {
    const cored = coredKey(k);
    if (!cored) continue;
    if (history.spentKeys.has(k) || history.spentAt.some((s) => coresMatch(s.core, cored.core))) {
      return { categoryId: "refund", reason: "money back from a merchant you have spent at", seedOnly: true };
    }
  }
  return income;
}

// Merchants that operate a FUEL STATION and a STORE under the same brand, so a
// single merchant->category rule can never be right for both. Matched against the
// clean merchant name; the fuel/store call is then made from the RAW descriptor.
//
// Deliberately a closed list rather than "any descriptor containing GAS" — in
// Arizona the gas UTILITY bill reads "SW GAS"/"SOUTHWEST GAS", and a blanket token
// match would file the heating bill as vehicle fuel.
const MULTI_DEPARTMENT =
  /SAM'?S ?CLUB|COSTCO|WAL-?MART|WM SUPERCENTER|SAFEWAY|FRYS|FRY'S|KROGER|ALBERTSONS|CIRCLE ?K|QUIKTRIP|\bQT\b/i;

// The bank's own fuel markers, as they appear inside the raw descriptor:
// "SAMSCLUB 4956 GAS 07/16", "COSTCO GAS #123", "FRYS FUEL". Word-anchored so
// GASOLINE-adjacent noise (VEGAS, GASTON) can't trip it.
const FUEL_TOKEN =
  /\bGAS\b|\bGASOLINE\b|\bFUEL\b|\bPUMP\b|(?:\bQT\b|QUIKTRIP)[^]*\bOUTSIDE\b/i;

// QuikTrip is the one multi-department merchant here that labels EVERY charge:
// "QT 465 OUTSIDE" is the pump, "QT 465 INSIDE" is the shop. Across the whole
// ledger that is 16 outside and 4 inside, 20 for 20 — the bank was saying which
// all along and the categorizer was discarding it, so the same station's charges
// sat split between dining and transport at random and every one of them was
// flagged for a review nobody was ever shown. Scoped to QT so a stray "OUTSIDE"
// in another merchant's descriptor cannot mean fuel.
const STORE_TOKEN = /(?:\bQT\b|QUIKTRIP)[^]*\bINSIDE\b/i;

// The only bank-CONFIRMED fuel charges in this household's entire history are
// four Sam's Club pump sales between $32.83 and $45.28 — one tank for one car.
// So a warehouse-club charge far outside that range is not a fill-up: above the
// ceiling it is a grocery run, below the floor it is a snack. Deliberately an
// OUTER gate with a wide dead zone, not a tightened band: the confirmed fuel
// amounts and the hand-labelled store amounts genuinely OVERLAP in the middle
// ($34.93 store sits between $32.83 and $45.28 fuel), so narrowing there would
// be guessing with extra steps. This decides only the cases that cannot be fuel
// — 8 rows, $921.42, including a $130.64 charge sitting on the gas line, which
// is 39 gallons and about three tanks for a 2012 Civic.
const FUEL_CEILING = 70;
const FUEL_FLOOR = 8;

// A HOUSEHOLD RULE, not a measurement. Gino, 2026-10-24: at Sam's Club a charge of $35
// to $50 that the bank did not tag as the pump is gas; any other untagged Sam's Club
// charge is the store. His own hand-labels agree: every Sam's Club charge he has filed
// by hand between $35 and $50 is transport, and most outside it are the store.
//
// What it decides is only the PRE-FILL of a charge the bank left untagged — the
// category a new row starts in while it waits for a one-tap answer. It does not
// change the rest of the department rule, each on purpose:
//   · a charge the bank tagged as the pump stays fuel (resolveDepartment);
//   · the row is still `ambiguous`, so the importer seeds a NEW row with it and never
//     uses it to overwrite one already in the ledger (schema_v26 keep_category) — the
//     re-sync that moved $702 on a coin flip is exactly what this must not repeat;
//   · it is still asked about. Gino's band beats a coin flip; it is not the bank
//     saying so.
// Written as data for one merchant. Costco, Walmart and the rest have no rule of
// their own, and get none by being near this one.
const HOUSEHOLD_DEPARTMENT_RULES: readonly {
  merchant: RegExp;
  fuelFrom: number;
  fuelTo: number;
  fuel: string;
  store: string;
  said: string;
}[] = [
  { merchant: /SAM'?S ?CLUB/i, fuelFrom: 35, fuelTo: 50, fuel: "transport", store: "groceries", said: "Gino, 2026-10-24" },
];

/** The household's own pre-fill for an untagged charge at a merchant it has a rule
 *  for, or null. Only asked about a charge resolveDepartment() calls ambiguous. */
function householdDepartment(
  desc: string,
  raw: string | undefined,
  amount: number,
): { categoryId: string; reason: string } | null {
  const rule = HOUSEHOLD_DEPARTMENT_RULES.find((r) => r.merchant.test(desc) || (!!raw && r.merchant.test(raw)));
  if (!rule) return null;
  const mag = Math.abs(amount);
  const fuel = mag >= rule.fuelFrom && mag <= rule.fuelTo;
  return {
    categoryId: fuel ? rule.fuel : rule.store,
    reason: `household rule (${rule.said}): $${rule.fuelFrom}–$${rule.fuelTo} with no pump tag is ${fuel ? "gas" : "outside that band, so the store"} — confirm`,
  };
}

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
/** Does this charge sit at a merchant that runs a fuel station AND a store under
 *  one brand? Exported so the UI can withhold the "Remember this merchant" offer:
 *  a merchant-keyed rule is structurally incapable of answering for two
 *  departments, so offering to save one invites an answer the app cannot honour.
 *  Gino taught SAM'S CLUB -> transport on 2026-09-04 because the app asked. */
export function isMultiDepartment(desc: string, raw?: string): boolean {
  return MULTI_DEPARTMENT.test(desc) || (!!raw && MULTI_DEPARTMENT.test(raw));
}

export function resolveDepartment(
  desc: string,
  raw?: string,
  amount?: number,
): Department {
  if (!MULTI_DEPARTMENT.test(desc) && !(raw && MULTI_DEPARTMENT.test(raw)))
    return null;
  if (!raw) return null;
  if (FUEL_TOKEN.test(raw)) return "fuel";
  // The bank named the shop. Nothing to ask.
  if (STORE_TOKEN.test(raw)) return null;
  // Provably not one tank of fuel — see FUEL_CEILING. Falls through to the
  // ordinary merchant path instead of being asked about forever.
  if (
    amount != null &&
    (Math.abs(amount) > FUEL_CEILING || Math.abs(amount) < FUEL_FLOOR)
  )
    return null;
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
  { re: /\bGEICO\b/i, bill: "Car insurance" },
  // The Civic's first payment posts 30 Sep 2026 and nothing named a lender, so
  // $232.67 was going to classify as a brand-new merchant, land in `other` — the
  // $125/mo Misc line — and blow that line by 86% while the Bills tab showed the
  // car payment unpaid. $2,792.04 in the first year, $11,168.16 over the term.
  //
  // ⚠️ The lender is a GUESS. The note was still held by Courtesy at purchase and
  // had not been assigned, so these are the likely assignee names, not observed
  // ones. Confirm against the real descriptor on 1 Oct and tighten. Deliberately
  // NOT matching "COURTESY CDJR": that is the dealership, and a future service
  // visit would then settle a car-payment cycle — the same shape as the parking
  // garage settling the rent.
  { re: /\bAHFC\b|AMERICAN HONDA|HONDA FINANCIAL/i, bill: "Car payment (Civic)" },
  // Cherry is BOTH a modeled monthly bill and a feed-tracked debt. Naming it
  // here is what lets the importer link a payment to both at once — without a
  // name the tracked-debt branch could only ever settle the debt.
  { re: /CHERRY TECHNOL/i, bill: "Cherry (dental)" },
  // McGraw-Hill bills ALEKS as "MHE*ALEKS ALEKS.COM" — and merchantKey() cuts at
  // the "*", so the merchant key is the bare "MHE". A learned rule on a 3-letter
  // key is too blunt to carry a bill link, so name the biller here instead: the
  // real charge then settles the modeled ALEKS row and the hand-entered "already
  // paid" placeholder stops being needed (it was double-counting $21.57/mo).
  { re: /MHE\*?ALEKS|\bALEKS\.COM\b/i, bill: "ALEKS calculus" },
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
  // "tmobile" is deliberately NOT an alias. Separating the two descriptor
  // namespaces above closes the join splice, but "tmobile" is still only unique
  // as a WORD, not as a substring of a space-stripped statement line — any raw
  // line pairing a trailing "t" with "MOBILE" recreates it. The BILL_RULE
  // /TMOBILE|T-MOBILE/i already matches all three real forms the bank sends
  // ("T-Mobile", "T-MOBILE*PREPAID", "TMOBILE*PREPAID"), so the alias bought
  // nothing and risked the phone bill being settled by a restaurant.
  { bill: "T-Mobile", aliases: [] },
  { bill: "Spotify", aliases: ["spotify"] },
  { bill: "Spot Pet insurance", aliases: ["spotpet"] },
  { bill: "LEMONADE INSURANCE", aliases: ["lemonade"] },
  { bill: "Car insurance", aliases: ["geico"] },
  { bill: "Cherry (dental)", aliases: ["cherrytechnol"] },
  { bill: "ALEKS calculus", aliases: ["mhealeks", "alekscom"] },
  { bill: "Card payment (…4728)", aliases: ["crd4728", "acct4728"] },
  { bill: "Card payment (…6813)", aliases: ["crd6813", "acct6813"] },
];

/**
 * Every bill NAME the built-in rules in this file hand back: BILL_RULES, BILL_ALIASES,
 * and the three named inside classify() itself (the Zelle branch and the two Anthropic
 * seat bands). The importer resolves each one to a recurring row with
 * matchRecurringName, by name — so a bill renamed away from one of these is a bill the
 * rule that pays it can no longer find, and its payments drop into needs_review.
 *
 * Exported 2026-10-10 for the write door's finance.edit_bill, which refuses exactly that
 * rename. The three classify() names are spelled again here rather than lifted out of
 * the function, so the categorizer's own logic is untouched; tests/museFinance.test.ts
 * reads this file and fails if any bill name in it is missing from this list.
 */
export const BUILT_IN_BILL_NAMES: readonly string[] = [
  ...new Set([...BILL_RULES.map((r) => r.bill), ...BILL_ALIASES.map((b) => b.bill), "Mom", "Claude Pro", "Claude Max"]),
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
  // This said `other` — so his own "Pets" hand-label routed into the $125 Misc
  // line, and the $75 Pets budget line could only ever be fed by a merchant rule
  // he had typed himself. Nothing in the categorizer could put money there.
  Pets: { kind: "variable", appCategory: "pets" },
  "Subscriptions/Digital": { kind: "variable", appCategory: "subscriptions" },
  // This said `other`, which made the app's `travel` category UNREACHABLE from
  // the categorizer: every merchant he had hand-labelled "Travel/Other" — both
  // American Airlines lines, Southwest, the passport office, PassportVisaExpress
  // — routed into the $125 Misc line instead. Same shape as the `Pets` bug above:
  // a category exists on screen that nothing in the labeller can put money into.
  // (FedEx Office carries this label too and is really shipping, not travel — the
  // one miscall this remap creates, and it is worth it.)
  "Travel/Other": { kind: "variable", appCategory: "travel" },
  Other: { kind: "variable", appCategory: "other" },
  // Money SENT to a friend or relative is spending, so it is recorded — filed in
  // `other` (the same place an unknown merchant lands) and, because `other` is the
  // vague answer, at low confidence, which flags it for a one-tap review. A learned
  // rule on that person's merchant key still wins, exactly as it does for any
  // merchant, because learned rules are checked before this table is read.
  //
  // WHY, FOUND 2026-10-10 by reconciling the bank statements line by line against the
  // ledger. This label said `skip`, and `skip` does not mean "not budget spend" — it
  // means the importer writes the row NOWHERE (see the Zelle-to-mom note in
  // classifyCore: "being unsure what a charge was is not a reason to pretend it did
  // not happen"). So a real Zelle that left the household for someone outside it was
  // simply absent from the ledger, and every figure built on the ledger — spending,
  // the run rate, what the month netted — was short by exactly that amount. The
  // statement had it; the app did not.
  //
  // What did NOT change, on purpose:
  //   · Money COMING IN from a friend or relative. classify() never sees a credit (it
  //     returns skip for any amount ≥ 0 before this table is read); a credit goes
  //     through classifyCredit(), which only calls a row a transfer for an
  //     "Internal:" label or an own-account line (a cash deposit too, until
  //     2026-10-25) — so a friends/family Zelle in was already income, and still is.
  //     (Since 2026-10-25 its category is creditCategory's: `refund` when it comes
  //     from someone the household has sent a Zelle to.)
  //   · Money moving between the household's OWN accounts. "Internal: spouse" and
  //     "Internal: account transfer" stay `skip` just below: the same dollars moving
  //     from one of their pockets to another is not spending, and recording one leg
  //     would show money spent that the household still has.
  //   · The pending path (supabase/functions/_shared/pendingRow.ts) asks this same
  //     function in the posted wording, so a pending friends/family Zelle is now
  //     written too — a preview of the posted row, not a row that is missing for a
  //     day and then appears.
  "Zelle: friends/family": { kind: "variable", appCategory: "other" },
  // Everything below is real, but not lean-variable living spend → skip on import.
  "Income: Paycheck": { kind: "skip" },
  "Income: Tax refund": { kind: "skip" },
  "Internal: spouse": { kind: "skip" },
  "Internal: account transfer": { kind: "skip" },
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
  {
    re: /CHEVRON|SHELL|CIRCLE K|\bQT\b|QUIKTRIP|FRYS FUEL|ARCO|\bMOBIL\b|EXXON|SUNOCO|KWIK|CONOCO|PHILLIPS ?66|\b76\b/i,
    appCategory: "transport",
  },
  {
    re: /PETSMART|PETCO|\bCHEWY\b|BANFIELD|VCA ANIMAL|VETERINAR|PET HOSPITAL|DOCUPET|PET SUPPL|\bPET STORE\b/i,
    appCategory: "pets",
  },
  // Registration, title, emissions — the cost of keeping the car legal. These
  // arrive as raw statement lines whose merchant key collapses to the literal
  // word "CHECKCARD", so they landed in Misc, and no rule could be taught on
  // them that would not then capture every other unrecognised charge.
  {
    re: /\bMVD\b|MOTOR VEHICLE DIV|\bDMV\b|VEHICLE EMISSIONS|EMISSIONS TEST|\bSMOG\b/i,
    appCategory: "transport",
  },
  // Parking is transport, not "other". PARKINSAFE is the garage at their own
  // building and recurs several times a month at $6 — it was landing in Misc,
  // and (before the Rent veto above) settling the rent cycle.
  {
    re: /PARKIN\s?SAFE|\bPARKING\b|PARKMOBILE|SPOTHERO|PASSPORT ?PARKING|\bTOLL\b|AIMSPARKING|\bAMP PARK\b/i,
    appCategory: "transport",
  },
  // Tuition, fees and course materials. `education` is one of two categories the
  // app displays but the labeller could never reach (see "Travel/Other" above),
  // so every ASU charge landed in Misc — including the $25 Universal Pathways
  // enrollment fee, which is the start of a bill that will recur all year.
  // Runs AFTER parking so "ASU AMP PARK" stays transport, and matches the .edu
  // domain rather than the bare word "ASU", which appears inside descriptors that
  // have nothing to do with tuition.
  {
    re: /ASU\.EDU|UNIVERSAL PATHWAYS|ARIZONA STATE UNIV|\bTUITION\b|CAMPUS BOOKSTOR|\bREGISTRAR\b|EARNED ADMISSION/i,
    appCategory: "education",
  },
  // Hotels, airlines and interstate travel plazas. The other unreachable
  // category. A road trip currently reads as a pile of Misc: the Las Vegas hotel,
  // the refund against it, Morton's Travel Plaza and USA Travel Center were five
  // separate charges no line of the budget could explain.
  //
  // Deliberately NOT a bare /TRAVEL/ — his own credit card is named "Travel
  // Rewards", and matching that would file card activity as a holiday.
  {
    re: /BOOKING\.COM|\bEXPEDIA\b|HOTELS?\.COM|AIRBNB|\bVRBO\b|MARRIOTT|HILTON|\bHYATT\b|BEST WESTERN|\bMOTEL\b|\bHOTEL\b|\bINN\b|TRAVEL CENTER|TRAVEL PLAZA|TRAVEL STOP|TRAVEL P\b|AMERICAN AIR|SOUTHWEST AIR|DELTA AIR|UNITED AIR|SPIRIT AIR|FRONTIER AIR|ALLEGIANT|\bAMTRAK\b/i,
    appCategory: "travel",
  },
  {
    re: /SAFEWAY|WAL-?MART|WM SUPERCENTER|TRADER JOE|WHOLE ?FDS|WHOLE FOODS|FRYS FOOD|KROGER|COSTCO|SAM'?S? CLUB|99 RANCH|H MART|MEKONG|ALDI|SPROUTS|GROCER|MARKET|SUPERMARKET|SMITH'?S? ?#|\bSMITHS\b|ALBERTSONS|\bWINCO\b|FOOD CITY|BASHAS/i,
    appCategory: "groceries",
  },
  {
    re: /CHIPOTLE|STARBUCKS|DUTCH BROS|\bPANDA\b|MCDONALD|TACO|PIZZA|\bCAFE\b|COFFEE|\bTEA\b|RESTAURANT|GRILL|SUSHI|RAMEN|\bBBQ\b|CANES|JACK IN THE BOX|HOT ?POT|DOORDASH|UBER EATS|GRUBHUB|DINER|KITCHEN|NOODLE|BURGER|SANDWICH|\bDELI\b|BAKERY|PATISSERIE|\bCREPE\b|DONUT|DOUGHNUT|YOGURT|\bBOBA\b|DUMPLING|CHICKEN|\bWINGS\b|SMOOTHIE|CREAMERY|GELATO|\bSUBWAY\b/i,
    appCategory: "dining",
  },
  {
    re: /AMAZON|TARGET|IKEA|\bROSS\b|NORDSTROM|ULTA|NIKE|VANS|BEST BUY|HOME DEPOT|BASS PRO|MACY|KOHL|\bHM\.COM\b|\bH&M\b|UNIQLO|\bZARA\b|OLD NAVY|TJ ?MAXX|MARSHALLS|\bSHEIN\b|\bTEMU\b|CSC SERVICEWORKS|\bLAUNDR/i,
    appCategory: "shopping",
  },
  // Beauty/cosmetics sits with Health/Personal, which folds into `shopping`.
  // HOURGLAS (no trailing S) so the same rule catches Plaid's truncated clean
  // name "Hourglas" and the raw "SP HOURGLASSCOSME".
  {
    re: /CVS|WALGREENS|PHARMACY|CLINIC|DENTAL|MEDICAL|HAIR|SALON|BARBER|HOURGLAS|SEPHORA|\bULTA\b|SALLY BEAUTY|YSLBEAUTY|\bYSL\b|CLINIQUE|LANCOME|ESTEE ?LAUDER|\bBEAUTY\b|COSMETIC/i,
    appCategory: "shopping",
  },
  {
    re: /SUBSCRIPTION|\.COM\/BILL|GOOGLE|NETFLIX|HULU|AUDIBLE|KINDLE|OPENAI|\bXAI\b|REPLIT|DISNEY|YOUTUBE|PATREON|GODADDY|NAMECHEAP|\bCOLAB\b|\bADOBE\b|MICROSOFT|DROPBOX|\bNOTION\b|GITHUB|\bVERCEL\b/i,
    appCategory: "subscriptions",
  },
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
  const out = classifyCore(desc, amount, learned, raw, true);
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
  //
  // Where the household has said how it reads this merchant (HOUSEHOLD_DEPARTMENT_RULES,
  // 2026-10-24), its rule is the pre-fill instead of whatever the merchant path
  // happened to land on. Still asked, still `ambiguous`, so still seed-only.
  if (
    out.kind === "variable" &&
    resolveDepartment(desc, raw, amount) === "ambiguous"
  ) {
    const house = householdDepartment(desc, raw, amount);
    return {
      ...out,
      appCategory: house?.categoryId ?? out.appCategory,
      confidence: "low",
      ambiguous: true,
      reason: house ? house.reason : out.reason + " — fuel or store? confirm",
    };
  }
  // A seed-only answer carries the answer from before its rule, for a caller asking
  // about a row the ledger already has — see Classification.seedOnly.
  if (out.seedOnly) return { ...out, before: classifyCore(desc, amount, learned, raw, false) };
  return out;
}

/** His own history label for a merchant hidden under the statement noise of one line
 *  — the label the last-resort lookup at the end of classifyCore answers with — or
 *  undefined. Only a label the app knows how to file counts, exactly as there. One
 *  helper for both places that ask, so the near-spelling step's "would his label
 *  answer?" can never drift from what the label lookup actually does. */
function noiseHiddenLabel(source: string): string | undefined {
  const cleaned = stripStatementNoise(source);
  if (!cleaned || cleaned === source.toUpperCase().trim()) return undefined;
  const his = hisLookup(merchantKey(cleaned));
  return his && HISCAT_TO_APP[his] ? his : undefined;
}

// `seeding` turns on the rules added 2026-10-25 that may only seed a new row. Off, this
// is the categorizer exactly as it answered before them — which is what `before` is.
function classifyCore(
  desc: string,
  amount: number,
  learned: LearnedRules | undefined,
  raw: string | undefined,
  seeding: boolean,
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
  const dept = resolveDepartment(desc, raw, amount);
  if (dept === "fuel") {
    return {
      kind: "variable",
      appCategory: "transport",
      reason: "bank tagged this pump, not the store",
      confidence: "high",
    };
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
    /\bANTHROPIC\b|CLAUDE\.AI|\bCLAUDE (PRO|MAX|SUB)\b|ZELLE PAYMENT TO MON\b|MHE\*?ALEKS|\bALEKS\.COM\b/i.test(
      billHay,
    );

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
  //
  // One more thing can disqualify a learned rule: it can be provably wrong about
  // THIS charge. At a merchant that sells fuel AND groceries, a rule saying
  // "transport" can only have been taught on a fill-up — so it cannot apply to a
  // charge the amount already rules out as fuel. A $130.64 Sam's Club run is 39
  // gallons, three tanks for a 2012 Civic; a $4.05 one is a snack. Neither is a
  // fill-up, and both were being filed as fuel at HIGH confidence, which also
  // means a re-sync would overwrite the right answer with the wrong one.
  const fuelRuledOut = isMultiDepartment(desc, raw) && !FUEL_TOKEN.test(raw ?? "") &&
    Number.isFinite(amount) &&
    (Math.abs(amount) > FUEL_CEILING || Math.abs(amount) < FUEL_FLOOR);
  const rawLr = amountGated ? undefined : learnedFor(key, learned, raw);
  const lr = fuelRuledOut && rawLr?.categoryId === "transport" ? undefined : rawLr;
  if (lr) {
    if (lr.kind === "bill")
      return {
        kind: "bill",
        billName: lr.billName,
        reason: "you taught it",
        confidence: "high",
      };
    if (lr.kind === "skip")
      return { kind: "skip", reason: "you taught it", confidence: "high" };
    return {
      kind: "variable",
      appCategory: lr.categoryId,
      reason: "you taught it",
      confidence: "high",
    };
  }

  // Overseas remittances (Pandaremit, Remitly/RMTLY) are money sent abroad — not
  // living spend, so they must never fall through to a dining/other guess. A
  // Remitly outflow that pays down the Mom-China debt is caught earlier in the
  // importer (tracked-debt match) before classify() ever runs, so this only
  // catches the non-debt remittance rails.
  if (/PANDAREMIT|\bREMITLY\b|\bRMTLY\b/i.test(desc)) {
    return { kind: "skip", reason: "overseas remittance", confidence: "high" };
  }

  // Moving money between the household's OWN accounts is not spending, and the
  // bank writes it several ways. `classifyCredit` already knew the incoming
  // shapes; the OUTGOING side only knew "Online Banking transfer to CHK nnnn".
  // Bank of America has started writing "TRANSFER TO ACCT #0366 ON 09/06 VIA WEB"
  // instead, which matched nothing — so $147.00 moving from the joint account to
  // Xinyan's was recorded as $147.00 of Misc spending, against a $125/mo line.
  // Both legs must drop together or the household appears to have spent money it
  // still has.
  if (
    /\b(?:ONLINE|MOBILE) BANKING TRANSFER (?:TO|FROM) (?:CHK|SAV)\b/i.test(billHay) ||
    /\bTRANSFER (?:TO|FROM) ACCT\s*#?\s*\d{4}\b/i.test(billHay)
  ) {
    return { kind: "skip", reason: "moving money between your own accounts", confidence: "high" };
  }

  // An ATM line is cash crossing the counter, and the direction is the whole
  // meaning. The merchant key "BKOFAMERICA ATM" carries the history label
  // "Cash deposit", which maps to skip — correct for a deposit, and silently
  // wrong for a WITHDRAWAL, which is money leaving with no merchant attached.
  // A $20.00 withdrawal on 2026-08-31 was dropped this way. Only reached on a
  // debit; the deposit side is creditCategory's, which since 2026-10-25 records it as
  // cash coming back instead of dropping it.
  if (/\bWITHDRWL\b|\bWITHDRAWAL\b|\bATM\b.*\bCASH\b|\bCASH WITHDRAW/i.test(billHay)) {
    return {
      kind: "variable",
      appCategory: "other",
      reason: "cash withdrawal — say what it went on",
      confidence: "low",
    };
  }

  // Zelle to mom: the monthly assistance is a support-sized payment. A SMALLER
  // Zelle to mom is an ad-hoc transfer — e.g. a $200 fronted and repaid a few days
  // later — NOT an assistance installment. Amount-gate it (like the Anthropic
  // price band below) so a repaid loan never lands on the Mom bill.
  //
  // The gate is 120, not 250. From 2026-11-01 the modelled Mom row resumes at
  // $300/month paid as TWO $150 installments (due_days [15, 30]) — so a 250 gate
  // would have rejected every real installment from the day it restarts. $3,600 a
  // year classified as "not the Mom bill".
  //
  // And below the gate it returns `variable`, never `skip`. `skip` means the
  // importer writes the row NOWHERE, and money that left the account must always
  // be recorded: a $50 Zelle on 2026-08-19 and a $15 one on 08-17 are both absent
  // from the ledger for exactly this reason. Being unsure what a charge was is not
  // a reason to pretend it did not happen.
  if (/ZELLE PAYMENT TO MON\b/i.test(desc)) {
    return Math.abs(amount) >= 120
      ? {
          kind: "bill",
          billName: "Mom",
          reason: "matched bill: Mom (assistance)",
          confidence: "high",
        }
      : {
          kind: "variable",
          appCategory: "other",
          reason: "Zelle to mom below the assistance amount — confirm",
          confidence: "low",
        };
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
      return {
        kind: "bill",
        billName: "Claude Pro",
        appCategory: "subscriptions",
        reason: "matched bill: Claude Pro",
        confidence: "high",
      };
    if (mag >= 70 && mag <= 140)
      return {
        kind: "bill",
        billName: "Claude Max",
        appCategory: "subscriptions",
        reason: "matched bill: Claude Max",
        confidence: "high",
      };
    return {
      kind: "variable",
      appCategory: "subscriptions",
      reason: "Anthropic (non-seat amount) — confirm",
      confidence: "low",
    };
  }

  // The cost of carrying a balance — card interest and late/penalty fees. NOT a
  // bill (no recurring row) and NOT living spend: it's already baked into the card
  // balance that the linked debt reads from, so it must never route to a debt or
  // land on a budget line, or it double-counts. Its own category so the price of
  // the debt is visible rather than buried in "other".
  //
  // Tested against billHay, like BILL_RULES below. It used to test `desc` alone
  // while BILL_RULES read the raw line, and that ordering was a trap: a fee whose
  // "LATE FEE" token lives only in the raw descriptor lost the race to the bill
  // rule ten lines down, which applies NO amount tolerance. So an $86 late fee on
  // a raw "GREYSTAR NOLLIE LATE FEE" settled a $1,732.16 rent cycle — the exact
  // failure the parking-garage veto was just added to stop, re-entering by a
  // different door. Reproduced before the fix; pinned in tests/categorize.test.ts.
  if (/INTEREST CHARGED|FINANCE CHARGE|\bLATE FEE\b|PENALTY FEE/i.test(billHay)) {
    return {
      kind: "variable",
      appCategory: "interest",
      reason: "cost of debt (interest / fee)",
      confidence: "high",
    };
  }

  for (const r of BILL_RULES) {
    if (r.re.test(billHay) && !(r.not && r.not.test(billHay))) {
      return {
        kind: "bill",
        billName: r.bill,
        reason: `matched bill: ${r.bill}`,
        confidence: "high",
      };
    }
  }

  // drift-tolerant alias pass — normalize the descriptor and look for a bill's
  // distinctive alias, so a re-spaced/rebranded descriptor still resolves.
  //
  // The clean name and the raw line are normalized SEPARATELY and searched
  // separately. Searching billKey(desc + " " + raw) instead created aliases out of
  // thin air at the join, because billKey strips the space that separated them:
  // "Busan Mart" + "MOBILE PURCHASE 0326 …" collapses to
  // "busanmar·tmobile·purchase0326…", and a $27.48 meal settled the $27.48 T-Mobile
  // bill at high confidence. "MOBILE PURCHASE" is Bank of America's standard card
  // prefix, so every restaurant whose name happens to end in "t" was one descriptor
  // away from paying the phone bill. Reproduced on two live merchants.
  const normParts = raw && raw !== desc ? [billKey(desc), billKey(raw)] : [billKey(desc)];
  for (const b of BILL_ALIASES) {
    if (
      b.aliases.some((a) => normParts.some((n) => n.includes(a))) &&
      !(b.not && b.not.test(billHay))
    ) {
      return {
        kind: "bill",
        billName: b.bill,
        reason: `matched bill (alias): ${b.bill}`,
        confidence: "high",
      };
    }
  }

  // Uber is split in the history: the membership is a sub, trips are rideshare.
  // Plaid's clean name for the membership charge is just "Uber" — the words
  // "ONE MEMBERSHIP" appear only in the raw line, so testing `desc` alone filed
  // $9.99 a month as a rideshare trip against the gas budget.
  if (key === "UBER") {
    return /ONE MEMBERSHIP/i.test(billHay)
      ? {
          kind: "variable",
          appCategory: "subscriptions",
          hisCategory: "Subscriptions/Digital",
          reason: "Uber One membership",
          confidence: "high",
        }
      : {
          kind: "variable",
          appCategory: "transport",
          hisCategory: "Rideshare/Delivery",
          reason: "Uber trip",
          confidence: "high",
        };
  }

  const his = MERCHANT_CATEGORY[key];
  if (his) {
    const map = HISCAT_TO_APP[his];
    if (map) {
      if (map.kind !== "variable")
        return {
          kind: "skip",
          hisCategory: his,
          reason: `your label: ${his}`,
          confidence: "high",
        };
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

  // A rule you taught, reached through another spelling of the same merchant — "H MART
  // MESA LLC" answering for "H Mart". See looseLearnedFor for what counts as the same.
  //
  // WHY HERE, AND NOT BESIDE THE EXACT LOOKUP AT THE TOP. A near spelling is weaker
  // evidence than an exact one, so it gets no rank the exact rule did not already
  // leave open: every bill rule, every rail and amount-gated branch above, and his
  // own history label for this exact merchant key all answer first. What it takes
  // over is only what comes next — a keyword guess, the last-resort keyword lookup, or
  // "new merchant" — and each of those is a low-confidence guess that asks him again.
  //
  // NOT his label under the statement noise. FOUND 2026-10-25 in review: this step
  // sits before the last-resort lookup that strips the bank's noise off the line and
  // asks his history labels again (noiseHiddenLabel), and that lookup is not a guess —
  // it can answer "your label" at high confidence, or SKIP, a row kept out of the
  // ledger. So a near rule could have beaten his own label for the merchant on the raw
  // line, or written a row his label keeps out as spending. Whenever that lookup would
  // answer, this step stands aside and the answer is exactly what it was before.
  //
  // Never at a fuel-and-store merchant: a merchant-keyed rule cannot answer there at
  // all (see classify), and a loose one would only reach further. Seed-only: a row the
  // ledger already has is not moved by it (forExistingRow).
  if (
    seeding &&
    !amountGated &&
    !isMultiDepartment(desc, raw) &&
    !(raw && raw !== desc ? [desc, raw] : [desc]).some((s) => noiseHiddenLabel(s) !== undefined)
  ) {
    const near = looseLearnedFor(ruleLookupKeys(key, raw), learned);
    if (near) {
      return {
        kind: "variable",
        appCategory: near.rule.categoryId,
        reason: `you taught it, as "${near.pattern}"`,
        confidence: "high",
        seedOnly: true,
      };
    }
  }

  // Keyword pass reads BOTH namespaces. Plaid's clean name is lossy by design —
  // it reported "MOBILE PURCHASE 0905 USA TRAVEL CENTER KINGMAN AZ" as the bare
  // "Usa Travel Center" and "SQ *NANA'S SANDWICH SHO" as "Nana's Sandwich Sho",
  // and a keyword written against the full bank line matched neither. Same fix as
  // billHay above: test the pair, not whichever one happened to be passed first.
  const kwHay = raw && raw !== desc ? `${desc} ${raw}` : desc;
  for (const f of KEYWORD_FALLBACK) {
    if (f.re.test(kwHay)) {
      return {
        kind: "variable",
        appCategory: f.appCategory,
        reason: `guessed → ${f.appCategory}`,
        confidence: "low",
      };
    }
  }

  // Last resort: a raw, un-normalized statement line (old CSV imports, or a feed
  // that sends the full bank descriptor) can hide a known merchant behind a prefix
  // + date + card mask. Strip that noise and retry the history + keyword lookups.
  // Additive — only reached when nothing above matched, so it can't regress.
  // Try the clean name stripped, then the RAW line stripped. The second one is
  // what rescues a charge whose clean merchant name carries no information at
  // all: Bank of America sends vehicle-registration fees as "CHECKCARD 0628
  // AZ MVD FEE NOW PHOENIX AZ", whose merchant key is the literal word
  // "CHECKCARD" — so it landed in Misc, and no rule could be taught on it that
  // would not then capture every other unrecognised charge in the ledger.
  for (const source of raw && raw !== desc ? [desc, raw] : [desc]) {
    const cleaned = stripStatementNoise(source);
    if (cleaned && cleaned !== source.toUpperCase().trim()) {
      const his2 = noiseHiddenLabel(source);
      if (his2) {
        const map = HISCAT_TO_APP[his2];
        if (map.kind !== "variable")
          return {
            kind: "skip",
            hisCategory: his2,
            reason: `your label: ${his2}`,
            confidence: "high",
          };
        return {
          kind: "variable",
          appCategory: map.appCategory,
          hisCategory: his2,
          reason: `your label: ${his2}`,
          confidence: map.appCategory === "other" ? "low" : "high",
        };
      }
      for (const f of KEYWORD_FALLBACK) {
        if (f.re.test(cleaned)) {
          return {
            kind: "variable",
            appCategory: f.appCategory,
            reason: `guessed → ${f.appCategory}`,
            confidence: "low",
          };
        }
      }
    }
  }

  // Unknown merchant, a real debit → variable "other", lowest confidence.
  return {
    kind: "variable",
    appCategory: "other",
    reason: "new merchant",
    confidence: "low",
  };
}
