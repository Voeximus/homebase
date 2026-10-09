// What a PENDING bank row becomes in the ledger — or whether it is written at all.
//
// Lifted out of plaid/index.ts on 2026-10-09 so it can be tested. The sync is a
// Deno edge function that no test can import, and this decision had already been
// wrong twice in ways only a test would have caught (pending deposits that could
// never be written, pending bills filed as Misc). Same reason plaidSync.ts lives
// here: the logic that decides what money the ledger shows is written and proven
// ONCE, and the edge function only does the I/O around it.
//
// Pure: no DB, no Plaid, no clock. It reuses the categorizer's own tests rather
// than carrying any of its own.

import { classify, classifyCredit, isPaycheck, type LearnedRules } from "./categorize.ts";
import type { NormalRow } from "./plaidSync.ts";

/**
 * The words Bank of America will use for this Zelle once it POSTS, when this is the
 * pending wording of one. Null for anything else.
 *
 * ONE ZELLE, TWO SPELLINGS. While a Zelle is processing the bank writes it as
 *     "Zelle Transfer Conf# TESTPAIR1; GIO"
 * and once it settles, as
 *     "Zelle payment to GIO Conf# testpair1"   (money out)
 *     "Zelle payment from XINYAN LI Conf# …"   (money in)
 * The confirmation code lines the two up: in the live ledger, three real codes each
 * appear in both wordings, a day apart. (Codes here are made up — this repo is public.)
 *
 * Every rule this household has about who a Zelle went to is written against the
 * POSTED wording — "ZELLE PAYMENT TO GIO" and "ZELLE PAYMENT FROM XINYAN LI" are
 * history labels saying "Internal: spouse". The pending wording carries the same
 * name after the semicolon, but its merchant key is the bare "ZELLE TRANSFER", which
 * names nobody. So the pending row could not be recognised by any of them.
 *
 * The direction is not in the pending text at all; it is the sign of the amount.
 */
export function postedZelleWording(desc: string | undefined, amount: number): string | null {
  const m = (desc ?? "").match(/^\s*Zelle Transfer\s+Conf\s*#\s*([A-Za-z0-9]+)\s*;\s*(.*\S)\s*$/i);
  if (!m || !Number.isFinite(amount) || amount === 0) return null;
  const [, conf, name] = m;
  return `Zelle payment ${amount < 0 ? "to" : "from"} ${name} Conf# ${conf}`;
}

/** The ledger columns a pending row's classification decides. */
export interface PendingFields {
  type: "income" | "expense";
  amount: number;
  category_id: string;
  needs_review: boolean;
}

/**
 * Classify one pending row. Null means it is not written: the posted path would
 * drop the same charge, so showing it while it processes would only invent money
 * for a day and then take it away again.
 *
 * DISPLAY-ONLY rows, but no longer budget-invisible ones — the app counts pending
 * spend now, so what this files is what the budget reads until the charge settles.
 */
export function pendingFields(row: NormalRow, learned: LearnedRules): PendingFields | null {
  // INTERNAL TRANSFERS ARE DROPPED HERE EXACTLY AS THE POSTED PATH DROPS THEM, by
  // the posted path's own tests run on the posted path's own wording.
  //
  // FOUND 2026-10-04: a $250 and a $50 Zelle from Xinyan to Gino sat in the ledger
  // for a day as $300 of spending AND $300 of income. Both accounts are synced, so
  // each Zelle arrived twice while pending — the sending half as an expense (the
  // learned rule 'ZELLE TRANSFER' -> shopping fired, because that key is all the
  // pending wording has) and the receiving half as other-income. The posted twins
  // were dropped the moment they arrived, by classify() and classifyCredit()
  // reading the "Internal: spouse" history labels. The pending path ran the same
  // two functions; it just handed them words they had no label for.
  //
  // So the fix is not a second test of what counts as internal. It is the same
  // test, asked in the words the test was written for. A Zelle to someone outside
  // the household translates to a name with no internal label and is filed below
  // exactly as before. One consequence, deliberately kept: a pending Zelle to a
  // name the history labels "Zelle: friends/family" is now dropped too, because the
  // posted path drops that one as well, and the pending row is supposed to be a
  // preview of the posted one — not a row that exists for a day and then vanishes.
  //
  // The clean name first, then the raw line: Plaid sends no merchant_name for a
  // Zelle today, so the two are the same text, but if it ever starts sending one
  // ("Zelle"), the bank's own wording survives only in the raw line.
  const asPosted = postedZelleWording(row.description, row.amount) ??
    postedZelleWording(row.raw, row.amount);

  // Money coming IN while still pending. This used to `continue` — "outflows
  // only" — which made the ledger structurally incapable of showing a deposit
  // before it settled: zero pending income rows existed in the whole database.
  //
  // That is not a display nicety. A reimbursement is the case that needs it
  // most: Xinyan covered a group meal and was Zelled $92.08 and $21.65 back,
  // and searching the ledger for that money found nothing, because nothing
  // could have been there. The app said she was still owed it.
  //
  // Internal transfers between the household's own accounts are still dropped
  // (classifyCredit), same as on the posted path — those are the same dollars
  // moving, not new money.
  if (row.amount > 0) {
    if (classifyCredit(row.description) === "transfer") return null;
    if (asPosted && classifyCredit(asPosted) === "transfer") return null;
    return {
      type: "income",
      amount: row.amount,
      category_id: isPaycheck(row.description) ? "salary" : "other-income",
      needs_review: false,
    };
  }

  // The posted path's test for an outgoing row is classify(...).kind === "skip"
  // (plaid/index.ts). Asked here with the posted wording as both the clean name and
  // the raw line, which is what a posted Zelle carries — so the learned
  // 'ZELLE TRANSFER' rule, keyed on the pending wording, cannot answer first.
  if (asPosted && classify(asPosted, row.amount, learned, asPosted).kind === "skip") return null;

  const c = classify(row.description, row.amount, learned, row.raw);
  if (c.kind === "skip") return null;
  // A pending BILL payment is not discretionary spending and must not be
  // graded as any. This wrote c.appCategory ?? "other", and classify() returns
  // no appCategory for a bill — so every pending bill landed in "other", which
  // IS the $125/mo Misc line. That stayed invisible while pending charges were
  // excluded from the budget; the moment they started counting, a $99.93
  // pet-insurance bill turned up under "Misc / uncategorized".
  //
  // It cannot carry an applies_to yet: the bill link belongs to the settled
  // charge, and writing one here would mark the cycle paid off a hold the bank
  // can still reverse. So it takes the "bills" category — real cash, visible,
  // outside the envelope — and the posted twin gets the proper link a day or
  // two later.
  //
  // This ignores appCategory even where there is one: the Anthropic price band
  // sets "subscriptions", which IS graded, so a pending Claude Pro bill was
  // being charged against Household + Hygiene.
  return {
    type: "expense",
    amount: Math.abs(row.amount),
    category_id: c.kind === "bill" ? "bills" : (c.appCategory ?? "other"),
    needs_review: c.confidence === "low",
  };
}
