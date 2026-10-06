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

/**
 * The bank's confirmation code for a transfer, if the descriptor carries one.
 *
 * "Zelle Transfer CONF# YOMIM8KBL; GIO" and "Zelle Transfer Conf# YOMIM8KBL; XINYAN LI"
 * are the TWO HALVES OF ONE TRANSFER, and the code is the only thing in either row that
 * says so. The literal word "conf" is required rather than matching any long token: an
 * account number or an order reference would otherwise pair rows that have nothing to do
 * with each other, and a wrong `moved` erases real spending from the month.
 *
 * Case is thrown away because Bank of America writes it both ways on the same day, on
 * the two sides of the same transfer.
 */
export const transferRef = (description: string | undefined): string | null => {
  const m = (description ?? "").match(/conf\s*#?\s*([a-z0-9]{6,})/i);
  return m ? m[1].toLowerCase() : null;
};

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
  // ── 0. what a person said, which beats everything below ─────────────────────
  // The rules after this are inference from a bank's prose. This is somebody who
  // looked at the answer and said no. It is stored (transactions.flow_override) and
  // the derivation is not, deliberately: a stored derivation is a cache and caches
  // drift, so only the corrections live in the database and everything else is
  // worked out fresh every read.
  if (txn.flowOverride) {
    return { flow: txn.flowOverride, why: "set by hand — this overrules what the app would work out" };
  }

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
  const rows = txns.map((txn) => ({ txn, verdict: flowOf(txn, own) }));
  return pairTransfers(rows, accounts);
}

/**
 * The second half of a transfer is the evidence for the first.
 *
 * WHY A SEPARATE PASS AND NOT A RULE IN flowOf. Every rule up there reads ONE row. This
 * one cannot: a Zelle between their own two checking accounts looks exactly like real
 * spending from the row alone — "Zelle Transfer CONF# YOMIM8KBL; GIO" is money leaving,
 * full stop. What makes it a transfer is that the OTHER row exists.
 *
 * WHAT WENT WRONG WITHOUT IT, found on 2026-10-04. Two Zelles from Xinyan to Gino, $250
 * and $50, each appearing twice because both accounts are synced. October was carrying
 * $300 of invented spending AND $300 of invented income, and the $300 of "spending" was
 * filed under Household + Hygiene, so that budget line was wrong as well. This is rule
 * 3's credit-card case — a payment counted on both sides — in the one place rule 3
 * cannot see it, because neither account is a card.
 *
 * AND WHY IT IS SAFE, which is the whole argument. A Zelle to somebody OUTSIDE the
 * household appears in this ledger once; only an internal one appears twice with the
 * same confirmation code. So the pairing is not a guess about intent, it is the
 * household's own data saying the money never left. A $40 Zelle to a third party on the
 * same day, with its own code and no sibling, stays spending and should.
 *
 * FIVE CONDITIONS, ALL REQUIRED, and ambiguity is left alone rather than resolved — the
 * discipline pendingCover.ts already uses, for the same reason: a wrong "this never
 * happened" is worse than no answer.
 */
function pairTransfers(
  rows: { txn: Transaction; verdict: FlowVerdict }[],
  accounts: readonly Account[],
): { txn: Transaction; verdict: FlowVerdict }[] {
  const ownIds = new Set(accounts.map((a) => a.id));
  const pairs = transferPairs(
    rows.map((r) => r.txn),
    (accountId) => ownIds.has(accountId),
  );
  return rows.map((r) => {
    const ref = pairs.get(r.txn.id);
    if (ref === undefined) return r;
    const why = `one half of a transfer between their own accounts — the other half carries the same confirmation ${ref}`;
    return { txn: r.txn, verdict: { flow: "moved" as const, why } };
  });
}

/**
 * Every row that is one half of a transfer between the household's own accounts,
 * mapped to the confirmation code that pairs it.
 *
 * THE ONE PAIR-FINDER. classify() uses it to mark rows "moved"; the budget uses it,
 * through transferIds(), to leave them out. It was written inside pairTransfers on
 * 2026-10-04 and reached only the net-worth figures, so for a day the run rate knew
 * Xinyan's $250 Zelle to Gino was not spending while the budget counted it as
 * $250 of household spending. Two places deciding "is this a transfer" is how that
 * happens, so there is now one.
 *
 * `isOwn` is the account test. classify() passes the real account list. The budget
 * has no account list, and does not need one: both halves of a pair have to be in
 * THIS ledger, and a Zelle to anyone outside the household only ever appears once.
 * The pairing is the evidence. So the default just requires an account at all.
 *
 * FIVE CONDITIONS, ALL REQUIRED, and ambiguity is left alone rather than resolved:
 * the same code on exactly two rows, opposite directions, two different accounts,
 * the same amount to the cent, and no hand correction on either.
 */
export function transferPairs(
  txns: readonly Transaction[],
  isOwn: (accountId: string) => boolean = (accountId) => accountId !== "",
): Map<string, string> {
  const byRef = new Map<string, Transaction[]>();
  for (const t of txns) {
    // A correction somebody made by hand is never overruled by an inference, so a row
    // carrying one is not even a candidate for pairing.
    if (t.flowOverride) continue;
    if (!isOwn(t.accountId ?? "")) continue;
    const ref = transferRef(t.description);
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref)!.push(t);
  }

  const out = new Map<string, string>();
  for (const [ref, rows] of byRef) {
    // EXACTLY TWO. Three rows sharing a code is something this does not understand, and
    // guessing which two are the pair would be the inference this file exists to avoid.
    // Left as it was, and visible, for a person to settle with finance.set_flow.
    if (rows.length !== 2) continue;
    const [first, second] = rows;
    const sent = first.type === "expense" ? first : second;
    const got = first.type === "expense" ? second : first;
    if (sent.type !== "expense" || got.type !== "income") continue; // not opposite
    if (sent.accountId === got.accountId) continue; // an account cannot pay itself
    // To the cent. A fee taken out in the middle would make this not a clean pair, and
    // a near-match is exactly the "close enough" that produced three wrong net figures.
    if (Math.abs(sent.amount - got.amount) > 0.005) continue;
    out.set(sent.id, ref);
    out.set(got.id, ref);
  }
  return out;
}

const transferCache = new WeakMap<readonly Transaction[], ReadonlySet<string>>();

/**
 * The ids the BUDGET leaves out because no money left the household: both halves of
 * every paired transfer, and any row a person has set to "moved" by hand.
 *
 * Cached per ledger array. spentByCategoryBetween is called once per month inside
 * loops (the average-pace calculation walks six of them), always with the same
 * ledger, and the pairing reads all of it — so it is done once per ledger, not once
 * per call. Pairing always reads the WHOLE ledger and the window is applied after,
 * because the two halves of a transfer can post on different days and a window
 * that cut between them would turn half a transfer back into spending.
 */
export function transferIds(txns: readonly Transaction[]): ReadonlySet<string> {
  const hit = transferCache.get(txns);
  if (hit) return hit;
  const ids = new Set(transferPairs(txns).keys());
  for (const t of txns) if (t.flowOverride === "moved") ids.add(t.id);
  transferCache.set(txns, ids);
  return ids;
}
