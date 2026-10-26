import type { MerchantRule, Recurring, Transaction } from "../types";
import {
  billLiveOnPaymentDate,
  classify,
  matchBillForCharge,
  sharedAccountIds,
  type LearnedRules,
  type PayableBill,
} from "./categorize";
import { billCycleFor } from "./schedule";

// ── Which bill would the bank sync attach this charge to? ─────────────────────
//
// FOUND 2026-10-24. Four hand-made "(already paid)" notes were in the ledger and three
// of them sat beside the real bank charge for the same bill. The app had no way to SAY
// that, because the only thing that knows "this bank charge is that bill" is the bank
// sync (supabase/functions/plaid/index.ts), and the sync only asks the question once, on
// the day a charge arrives. A note written AFTER the charge (because the charge had not
// linked — it came out of another account), or a charge that arrived while a note
// already held its bill's month: either way the charge was filed as spending, the note
// paid the bill as well, and nothing ever looked at the pair again.
//
// So the sync's question is asked here too, in the app, over rows already in the
// ledger — for the self-check that notices a hand note and a bank charge paying the same
// bill twice (selfAudit.ts), and for the suggestions that offer to fix it
// (ledgerReview.ts).
//
// THE SAME RULES, NOT A LIKENESS OF THEM. Every piece below is the sync's own, out of
// categorize.ts — the file the sync shares byte for byte:
//   · classify() names the bill, from the cleaned name and the raw bank line, with the
//     household's learned merchant rules first;
//   · billLiveOnPaymentDate() keeps only the bills live on the payment date, with the
//     sync's week of slack;
//   · matchBillForCharge() resolves the name to one bill row, own account first, the
//     household's other accounts only on name AND amount (see its note);
//   · billCycleFor() places the payment in a month, the mirror of the sync's
//     billAppliesTo.
// ONE THING IS LEFT OUT ON PURPOSE: the sync's last-resort day-and-amount guess, for a
// charge the categorizer calls a bill but cannot name. That guess is only safe inside
// the sync, straight after the categorizer has decided (ledgerReview.ts W7 records the
// hundred false pairs it made on ordinary spending). Leaving it out can only make the
// answer here "no bill" where the sync said one — never the other way round.
//
// PURE. No I/O, no clock.

/** A bill row seen through the sync's columns, carrying the row it came from. */
type Payable = PayableBill & { starts_on: string | null; ends_on: string | null; rec: Recurring };

/** What the sync's matching reads besides the charge itself, built once per ledger. */
export interface LinkContext {
  learned: LearnedRules;
  shared: Set<string>;
  bills: Payable[];
}

/**
 * The three parts of the ledger the sync's matching reads. AppData has all three; the
 * write door builds just these for the one charge and the one bill it is asked about
 * (finance.link_charge_to_bill, 2026-10-25), so it asks the sync's question too rather
 * than a likeness of it.
 */
export interface LinkSources {
  merchantRules?: readonly Pick<MerchantRule, "pattern" | "kind" | "categoryId" | "billName">[];
  accounts?: readonly { id: string; owner?: string | null }[];
  recurring?: readonly Recurring[];
}

/** The charge, in the columns the sync's matching reads. */
export type LinkCharge = Pick<Transaction, "type" | "date" | "amount" | "description" | "rawDescription" | "accountId">;

/** The learned rules, keyed the way the sync and the statement import key them. */
export function learnedRulesOf(data: Pick<LinkSources, "merchantRules">): LearnedRules {
  const out: LearnedRules = {};
  for (const r of data.merchantRules ?? []) {
    out[r.pattern] = { kind: r.kind, categoryId: r.categoryId, billName: r.billName };
  }
  return out;
}

export function linkContextOf(data: LinkSources): LinkContext {
  return {
    learned: learnedRulesOf(data),
    shared: sharedAccountIds(data.accounts ?? []),
    // The sync reads `active = true` and keeps direction "out" — the same two gates.
    bills: (data.recurring ?? [])
      .filter((r) => r && r.active && r.direction === "out")
      .map((r) => ({
        name: r.name,
        account_id: r.accountId ?? null,
        amount: r.amount,
        known_amount: r.knownAmount ?? null,
        variable: r.variable ?? false,
        due_days: r.dueDays ?? null,
        cadence: r.cadence,
        starts_on: r.startsOn ?? null,
        ends_on: r.endsOn ?? null,
        rec: r,
      })),
  };
}

export interface BankLink {
  bill: Recurring;
  /** The bill month the payment settles, "YYYY-MM". */
  monthKey: string;
  /** The due day it settles, clamped to the month. */
  day: number;
  /** True when the bill is set on a different account than the one the money left —
   *  a link the sync makes only through the household fallback. */
  fromAnotherAccount: boolean;
}

/**
 * The bill and month the bank sync would attach this charge to, if it arrived today
 * with that month free — or null.
 *
 * Only a charge going OUT, with a real amount. Whether the charge is a bank row, is
 * already linked, or is still pending is the CALLER's business: the self-check and the
 * suggestions each say which charges they ask about.
 */
export function bankWouldLink(tx: LinkCharge, ctx: LinkContext): BankLink | null {
  if (!tx || tx.type !== "expense" || !tx.date) return null;
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  // Signed the way the sync hands it over: money out is negative.
  const c = classify(tx.description ?? "", -amount, ctx.learned, tx.rawDescription);
  if (c.kind !== "bill" || !c.billName) return null;
  const live = ctx.bills.filter((b) => billLiveOnPaymentDate(b, tx.date));
  // The sync's amount gate for a shape-named bill (2026-10-26) comes with the name.
  const hit = matchBillForCharge(c.billName, live, tx.accountId ?? null, amount, ctx.shared, c.billAmountGate === true);
  if (!hit) return null;
  // The sync places the payment off the row's own due days (billAppliesTo), so this
  // does too — never the legacy name map the calendar falls back to.
  const cycle = billCycleFor(hit.bill.rec.dueDays, tx.date);
  return { bill: hit.bill.rec, monthKey: cycle.monthKey, day: cycle.day, fromAnotherAccount: hit.fromAnotherAccount };
}

/**
 * A hand-made "already paid" note: what markBillPaid (FinanceStore.tsx), the statement
 * import's bill rows (ImportSheet.tsx) and the write door's finance.mark_bill_paid all
 * write. A settled bill link on a row that came from no bank and moved no cash — no
 * provider and no account — which is what "already paid, already in my anchored balance"
 * (types.ts) looks like in a row.
 */
export function isHandNote(tx: Transaction): boolean {
  const at = tx?.appliesTo;
  return (
    !!tx &&
    tx.type === "expense" &&
    !tx.pending &&
    !tx.provider &&
    !tx.accountId &&
    at?.kind === "bill" &&
    at.settled === true &&
    !!at.recurringId
  );
}
