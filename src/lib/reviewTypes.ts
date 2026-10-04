// ── Worth a look — the shared vocabulary ──────────────────────────────────────
//
// The second kind of wrong. `selfAudit.ts` owns the first kind: the app
// disagreeing with itself, which is certain, exactly zero in a healthy app, and
// never a judgement call. This file owns the other kind: the app noticing
// something about the money, where every number is self-consistent and the MODEL
// may be out of date. That is a guess with evidence. It can be wrong.
//
// Keeping the two apart is the whole point. `selfAudit.ts` promises the user, in
// its own closing paragraph, that "anything other than a perfect match is a real
// mistake, not a rounding difference, which is why there is no 'maybe' here."
// Nothing in this file may render next to that sentence, and nothing in this file
// is ever called a failure.
//
// Spec: docs/research/ledger-doctor/SPEC.md §B.1.
//
// WHO WRITES WHAT
//   · the ENGINE (src/lib/ledgerReview.ts, spec piece 2) produces Suggestions.
//     It is pure: no I/O, no clock beyond the `now` it is handed, and it performs
//     NO writes — it returns text and a `fix` descriptor and nothing else.
//   · the SURFACE (ReviewSheet + reviewApply, spec pieces 4 and D) renders them
//     and performs one write per tap.
// This file is the contract between the two, so neither has to import the other's
// internals.

import type { AppData } from "../types";

/** The seven things the engine can notice. Spec §B.2–§B.8. */
export type SuggestionKind =
  | "drift" // W1 — the app expects one amount, the last charge was another
  | "phantom" // W2 — planned every month, nothing charged for three cycles
  | "unmodelled" // W3 — the same charge every month, not in the bills
  | "missing" // W4 — every previous cycle was charged, this one was not
  | "duplicate" // W5 — the same money looks like it is in twice
  | "income-landed" // W6 — income told to repeat looks like it arrived once
  | "unlinked" // W7 — a charge that matches a bill you already model
  | "dangling"; // A8 — a charge pointing at a row that was deleted (§D.1)

/** A bill row a fix may create. Spec §D.4. */
export interface NewBillDraft {
  name: string;
  /** The MEDIAN of the matched charges, never the newest. Spec §D.4. */
  amount: number;
  /** The most common day among the matched charges. */
  dueDay: number;
  /** From the charges' own most common category — never hardcoded. Spec §D.4. */
  categoryId: string;
  cadence: "monthly";
}

/**
 * The COMPLETE set of writes a one-tap fix is allowed to perform.
 *
 * This union IS the enforcement of spec §D.7. Anything not listed here cannot be
 * expressed, so it cannot be applied: no deleting a bank row (Plaid re-delivers
 * it and it is history the app cannot rebuild), no deleting a recurring row
 * (that is what left $165 of dangling links), no writing a merchant rule (it is
 * permanent and there is no delete for it anywhere), no `payBill`/`markBillPaid`
 * from a suggestion (they move money), and no fix that touches more than one row.
 *
 * `label` is what the button SAYS — "Use $27.00 from now on", never "Fix" — and
 * comes through t() from the engine, because only the engine knows the numbers.
 */
export type SuggestionFix = {
  /** The button's words. Already through t(). */
  label: string;
  /** The green line shown in the card's place afterwards. Already through t(). */
  done?: string;
  /**
   * Set when the fix is understood but cannot be offered yet — the one case in
   * the spec is a new bill whose charges only agree on `other`, which would put a
   * bill in an ungraded category (§D.4). The button renders disabled with this
   * as its reason. Already through t().
   */
  blocked?: string;
} & (
  | {
      /** §D.2 — the row's amount is out of date. One column, one row, no money. */
      write: "set-bill-amount";
      recurringId: string;
      amount: number;
      /** A variable row writes `known_amount`; a fixed row writes `amount`. */
      variable: boolean;
    }
  | {
      /** §D.3 — a bill that looks finished. NEVER a delete. */
      write: "turn-bill-off";
      recurringId: string;
    }
  | {
      /** §D.3 — income that was a one-off. `endsOn`, not inactive, so the past
       *  months still show the income they really had. */
      write: "end-income";
      recurringId: string;
      /** Last day of the month the deposit landed, "YYYY-MM-DD". */
      endsOn: string;
    }
  | {
      /** §D.4 — model a repeat that is not in the bills. Links no charge and
       *  writes no merchant rule. */
      write: "add-bill";
      bill: NewBillDraft;
    }
  | {
      /** §D.5 — a hand-entered row duplicating a bank row. Safe only because a
       *  row with no accountId/provider moved no cash, so removing it moves none
       *  back. The surface re-verifies that at tap time. */
      write: "remove-manual-charge";
      txnId: string;
    }
  | {
      /** §D.6 — the most dangerous write in the spec: it SETTLES a bill cycle.
       *  One tap, one charge, one cycle, never a batch, and refused if the cycle
       *  was claimed in the meantime. */
      write: "link-charge-to-bill";
      txnId: string;
      recurringId: string;
      /** WHICH cycle, as the engine placed it and the card stated it. Carried
       *  rather than re-derived: billCycleFor()'s seven-day grace can map a charge
       *  paid early into the FOLLOWING month, so a write that re-derived the cycle
       *  could settle a different month than the one the person read. */
      monthKey: string;
      day: number;
      installmentIndex: number;
    }
  | {
      /** §D.1 — release a charge whose bill was deleted. The fix for the exact
       *  check `links-point-somewhere`; the only crossing between the layers. */
      write: "unlink-charge";
      txnId: string;
    }
);

/** One thing the app noticed. Spec §B.1. */
export interface Suggestion {
  /**
   * Stable, and it CHANGES when the evidence changes — which is what makes
   * dismissal need no snooze, expiry or re-ask logic. Spec §B.9:
   *   drift:<recurringId>:<last charge amount in cents>
   *   phantom:<recurringId>:<newest closed cycle monthKey>
   *   unmodelled:<merchantKey>:<median amount in cents>
   *   missing:<recurringId>:<cycle monthKey>:<installment ordinal>
   *   duplicate:<txnId a>:<txnId b>        (ids sorted, so the key is order-free)
   *   income-landed:<recurringId>:<matching txnId>
   *   unlinked:<recurringId>:<cycle monthKey>:<txnId>
   */
  key: string;
  kind: SuggestionKind;
  /** One plain sentence, the headline. Already through t(). */
  title: string;
  /** The evidence, in dollars and dates. Already through t(). */
  detail: string;
  /** Dollars this is about, for sorting. NOT a claim about cash. */
  amount: number;
  /** The one-tap fix, or null when only a person can decide (W4). */
  fix: SuggestionFix | null;
  /** Rows the user can open to look at the evidence. */
  txnIds?: string[];
  /** The bill this is about, when there is one. */
  recurringId?: string;
}

/** The engine's signature. Pure — same data and same `now` give the same list. */
export type ReviewLedger = (
  data: AppData,
  now: Date,
  dismissedKeys: ReadonlySet<string>,
) => Suggestion[];
