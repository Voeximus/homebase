// GENERATED — DO NOT EDIT. Source: src/lib/flow.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/flow.ts
// and re-run the generator.
// What KIND of movement is this? Not what it was spent on — whether it was spent at all.
//
// WHY THIS EXISTS, and it is a specific failure rather than a tidiness exercise.
// Asked "what do we net per month", three separate wrong answers came out of summing
// `transactions` by type. Each was wrong for a different reason and all three reasons
// are the same mistake: a sum cannot tell what a row MEANS.
//
//   1. A $1,250 car down payment sat inside one month's total and made a normal month
//      look like a $1,225 loss. A one-off and a recurring cost are identical in a sum.
//   2. About $850 a month of card and loan payments counted as spending. Moving cash
//      to a liability does not make the household poorer; it is the same money in a
//      different place.
//   3. Worst: BOTH credit cards are synced, so every card payment appears TWICE — once
//      leaving checking, once arriving at the card. A $2,500 payment inflated income
//      by $2,500 and spending by $2,500 in the same month.
//
// So every row gets a FLOW before any arithmetic touches it, and net is computed from
// the two flows that actually move the household's net worth.
//
// EVERY CLASSIFICATION CARRIES ITS REASON. That is the load-bearing design decision,
// not a debugging nicety. A number that shows its own inputs can be wrong out loud; a
// number that hides them can only be wrong quietly, which is how the three failures
// above survived being read aloud several times. When `finance.run_rate` excludes
// $2,500 it names the charge and the rule that excluded it.
//
// DERIVED, NOT TAGGED. 666 of 794 rows carry no `applies_to` at all, so a design that
// needed every row labelled by hand would be a design that never started. The rules
// below read what the household's own data already knows: which accounts it owns,
// which of them are credit cards, and the last four digits of each.

import type { Account, Transaction } from "./types.ts";

// `description` only, never `rawDescription`. The raw descriptor would be a slightly
// better signal — it is the untouched bank text — and it is the one column the read
// door is forbidden to read at all, so a module the door imports must not depend on
// it. It costs nothing here: the account numbers this needs are in `description`
// already ("PAYMENT TO ACCT #4728 ON 09/30 VIA WEB").

/**
 * The five things a row can be.
 *
 * Only `earned` and `spent` change what the household is worth. `moved` and `repaid`
 * relocate money that is already theirs; `returned` is money coming back for something
 * already counted, so counting it as income would count the same dollar twice.
 */
export type Flow = "earned" | "spent" | "moved" | "repaid" | "returned";

export interface FlowVerdict {
  flow: Flow;
  /** The rule that fired, in plain words, to be read out beside the number. */
  why: string;
}

/** Does this flow change what the household is worth? */
export const COUNTS_TOWARD_NET: Readonly<Record<Flow, boolean>> = {
  earned: true,
  spent: true,
  moved: false,
  repaid: false,
  returned: false,
};

/** Lenders the household pays that are not one of its own synced accounts, so no
 *  last-four can identify them. Matched on the descriptor, lowercased.
 *
 *  A SHORT LIST ON PURPOSE. Every name here is a debt that exists in the app's own
 *  `debts` table, so this is a spelling bridge rather than a second opinion about what
 *  counts as debt. A lender the household stops using should be deleted from here when
 *  its debt is deleted, and `flow.test.ts` fails if this list ever outgrows the table. */
export const KNOWN_LENDERS = ["affirm", "cherry"] as const;

/** The household's own accounts, reduced to what classification needs. */
export interface OwnAccounts {
  /** Every last-four the household owns, across checking and cards. */
  lastFours: readonly string[];
  /** Ids of accounts that are credit cards — a deposit into one of these is the far
   *  side of a payment, never income. */
  cardIds: readonly string[];
}

export function ownAccountsFrom(accounts: readonly Account[]): OwnAccounts {
  return {
    lastFours: accounts.map((a) => (a.last4 ?? "").trim()).filter((s) => /^\d{4}$/.test(s)),
    cardIds: accounts.filter((a) => a.type === "credit card").map((a) => a.id),
  };
}

/** Four consecutive digits anywhere in a descriptor — "PAYMENT TO ACCT #4728 ON
 *  09/30 VIA WEB", "Mobile Banking payment to CRD 6813". */
const digitRuns = (s: string): string[] => s.match(/\d{4}/g) ?? [];

/**
 * Classify one row.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. What the household explicitly recorded wins over
 * anything inferred from a descriptor, because a descriptor is a bank's prose and a
 * link is somebody's decision. Inference only fills the silence.
 */
export function flowOf(txn: Transaction, own: OwnAccounts): FlowVerdict {
  const applies = (txn.appliesTo ?? null) as { kind?: string } | null;
  const kind = applies?.kind;

  // ── 1. what the app was told ────────────────────────────────────────────────
  if (kind === "transfer") return { flow: "moved", why: "recorded in the app as a transfer" };
  if (kind === "debt") return { flow: "repaid", why: "linked to a debt in the app" };

  const desc = (txn.description ?? "").toLowerCase();

  // ── 2. a deposit landing on a credit card ───────────────────────────────────
  // This is the one that inflated BOTH sides of every monthly figure. Money arriving
  // at a card is never income: it is the far half of a payment that already left a
  // checking account, and counting it adds a dollar the household never received.
  if (txn.type === "income" && own.cardIds.includes(txn.accountId ?? "")) {
    return { flow: "moved", why: "a payment arriving at a card — the other half of money leaving an account" };
  }

  // ── 3. a payment naming one of the household's own cards or accounts ────────
  if (txn.type === "expense") {
    const runs = digitRuns(txn.description ?? "");
    const hit = runs.find((r) => own.lastFours.includes(r));
    if (hit) return { flow: "repaid", why: `a payment to the household's own account ending ${hit}` };

    const lender = KNOWN_LENDERS.find((l) => desc.includes(l));
    if (lender) return { flow: "repaid", why: `a payment to ${lender}, which is a debt the app tracks` };
  }

  // ── 4. money coming back for something already counted ──────────────────────
  // A refund is not earnings. Counting it as income would count the same dollar twice:
  // once when it went out as spending, once when it came back.
  if (txn.type === "income" && txn.categoryId === "refund") {
    return { flow: "returned", why: "a refund — money back for something already counted as spent" };
  }

  if (txn.type === "income") return { flow: "earned", why: "money into the household from outside it" };
  return { flow: "spent", why: "ordinary spending" };
}

/**
 * Classify a whole ledger.
 *
 * Returns every row with its verdict attached, in the order given, so a caller can
 * both compute and SHOW. Nothing here sums anything — that is runRate.ts's job, and
 * keeping the two apart is why a wrong total can be traced to a wrong verdict rather
 * than to arithmetic nobody can see.
 */
export function classify(
  txns: readonly Transaction[],
  accounts: readonly Account[],
): { txn: Transaction; verdict: FlowVerdict }[] {
  const own = ownAccountsFrom(accounts);
  return txns.map((txn) => ({ txn, verdict: flowOf(txn, own) }));
}
