// ── The seam between the surface and the review engine ────────────────────────
//
// The screen (spec piece 4) and the engine (spec piece 2) were built in parallel,
// in separate worktrees, against a spec section (§B.1) that names `SuggestionFix`
// but never defines it. So each side defined the half it needed, and they turned
// out to be genuinely different things:
//
//   · the ENGINE's descriptor says WHAT CHANGED — action, field, `from`, `to`.
//     That is what its tests assert and what its evidence line reads.
//   · the SURFACE's descriptor says WHICH WRITE TO PERFORM — and carries two
//     things the engine has no way to know: whether a variable row's price lives
//     in `amount` or in `known_amount`, and the words for the green line after.
//
// This file is the one translation between them, and `toSurfaceFix` is a single
// exhaustive switch on purpose: add a case to either union and the compiler stops
// HERE. That is the whole difference between this and the five cycle-key
// implementations that drifted apart in silence — nothing connected those.
//
// The SURFACE union stays the narrower of the two, because narrow is the point:
// spec §D.7's forbidden writes are unrepresentable there, so a mapping that tried
// to express one would not compile.
//
// This file also ADDS one finding the engine does not produce — see
// `danglingSuggestions` below.

import { reviewLedger, type Suggestion as EngineSuggestion } from "./ledgerReview";
import { danglingLinks } from "./selfAudit";
import { formatDate, formatMoney } from "./format";
import { t } from "./i18n";
import type { AppData } from "../types";
import type { Suggestion, SuggestionFix } from "./reviewTypes";

/** True once `ledgerReview` is connected below — the dev harness (?doctorlab)
 *  prints a banner while this is false, so the feature cannot ship silently dead. */
export const ENGINE_WIRED = true;

type EngineFix = NonNullable<EngineSuggestion["fix"]>;

/**
 * One engine descriptor → one surface write.
 *
 * Returns null when the engine proposes something the surface deliberately cannot
 * do. Today that is only the unreachable `setRecurringActive` → true: W2 turns a
 * phantom bill OFF and never back on, and there is no "turn a bill on" write
 * because nothing should offer one as a one-tap fix. A null here means the card
 * shows its evidence with no button, which is the honest outcome.
 */
export function toSurfaceFix(fix: EngineFix): SuggestionFix | null {
  const common = { label: fix.label, ...(fix.blockedReason ? { blocked: fix.blockedReason } : {}) };

  switch (fix.action) {
    // §D.2 — the row's amount is out of date. The engine says which FIELD; the
    // surface needs the same fact as "is this row variable", because that is what
    // decides between `amount` and `known_amount`.
    case "setRecurringAmount":
      return {
        ...common,
        done: t("Saved. The app will expect that amount from now on."),
        write: "set-bill-amount",
        recurringId: fix.recurringId,
        amount: fix.to,
        variable: fix.field === "knownAmount",
      };

    // §D.3 — a bill that looks finished. Never a delete.
    case "setRecurringActive":
      if (fix.to !== false) return null;
      return {
        ...common,
        done: t("Turned off. It is still in your bills if you want it back."),
        write: "turn-bill-off",
        recurringId: fix.recurringId,
      };

    // §D.3 — income that was a one-off. An end date, not a delete, so the months
    // that really had the money still show it.
    case "setRecurringWindow":
      return {
        ...common,
        done: t("Ended. The months before this still show the money you got."),
        write: "end-income",
        recurringId: fix.recurringId,
        endsOn: fix.to,
      };

    // §D.4 — model a repeat that is not in the bills.
    case "addRecurring":
      return {
        ...common,
        done: t("Added to your bills."),
        write: "add-bill",
        bill: {
          name: fix.name,
          amount: fix.amount,
          dueDay: fix.dueDay,
          categoryId: fix.categoryId,
          cadence: fix.cadence,
        },
      };

    // §D.5 — the hand-entered half of a double entry. `applyFix` re-checks at tap
    // time that the row really is hand-entered; this is not the only guard.
    case "deleteTransaction":
      return {
        ...common,
        done: t("Removed. The bank's own record of it is still here."),
        write: "remove-manual-charge",
        txnId: fix.txnId,
      };

    // §D.6 — the one write that settles a bill cycle.
    case "linkTransactionToBill":
      return {
        ...common,
        done: t("Attached. That bill is marked paid for the month."),
        write: "link-charge-to-bill",
        txnId: fix.txnId,
        recurringId: fix.recurringId,
      };
  }
}

/**
 * The charges pointing at a row that was deleted — spec §D.1.
 *
 * WHY THIS IS HERE AND NOT IN THE ENGINE. It is the one finding in this feature
 * that is CERTAIN, and `ledgerReview.ts` opens by promising the opposite about
 * everything inside it ("every rule here CAN be wrong"). It is also not a
 * judgement call the engine could make: `selfAudit.ts` check 8 already finds these
 * exactly, and it stands on whole-table set membership.
 *
 * But the self-check panel has no buttons, on purpose — it states facts and
 * promises they are exact. So check 8 finds the hole, its detail sentence points
 * the user at Worth a look, and this is the code that keeps that promise. Spec
 * §D.1 calls it "the only crossing between the layers".
 *
 * It stands on `danglingLinks()` rather than resolving the ids a second time. Two
 * implementations of "which links are broken" would be the five-cycle-key mistake
 * again, this time with a button on the end of it.
 *
 * ONLY transaction rows. A dangling `recurring.linkedDebtId` has no one-tap fix
 * the surface can express — the write would clear a column on a bill row, which
 * §D.7 does not allow — so check 8 reports it and nothing offers to touch it.
 */
export function danglingSuggestions(data: AppData): Suggestion[] {
  // `danglingLinks` reads five whole tables, and is exact only on a COMPLETE load
  // — its own header says so. The store always supplies all five, but the dev
  // harness maps a snapshot by hand (`goals: []`) and a mid-sync load can be
  // partial, so the arrays are filled in rather than trusted.
  const safe: AppData = {
    ...data,
    transactions: arr(data?.transactions),
    recurring: arr(data?.recurring),
    debts: arr(data?.debts),
    goals: arr(data?.goals),
    accounts: arr(data?.accounts),
  };

  // AND THE GUARD THAT MATTERS: filling an array in stops a crash but not a lie.
  // An `accounts` table that has not loaded still makes every charge in the ledger
  // look like it points at a deleted account, which would put a card and a button
  // on hundreds of perfectly good rows. So a broken link is only worth OFFERING A
  // FIX for when the table it points into has something in it. An empty table is
  // not evidence that a row was deleted; it is evidence of nothing.
  //
  // This is deliberately on this side of the line, not inside `danglingLinks`.
  // Check 8 is right to fail on an empty table with live links — that really is a
  // defect — and its exactness is not something to soften for the sake of a
  // button. Here the question is different: is this solid enough to act on?
  const populated: Record<string, boolean> = {
    bill: safe.recurring.length > 0,
    debt: safe.debts.length > 0,
    goal: safe.goals.length > 0,
    charge: safe.transactions.length > 0,
    account: safe.accounts.length > 0,
  };

  const out: Suggestion[] = [];
  for (const row of danglingLinks(safe).broken) {
    if (!row.txnId || !row.date) continue;
    const targets = row.targets.filter((w) => populated[w]);
    if (!targets.length) continue;
    const name = row.description.trim();
    out.push({
      // The broken targets are inside the key, so re-linking the charge to a real
      // bill retires this card on its own and no expiry logic is needed.
      key: `dangling:${row.txnId}:${targets.join("+")}`,
      kind: "dangling",
      // The headline stays SHORT and the row's own words go in the evidence line.
      // These are bank rows, and a bank row's description is "Mobile Banking
      // payment to CRD 6813 Confirmation# 1hrcz18pd" — as a headline it wraps to
      // three lines on a phone and squeezes the amount off the end of the first.
      title: targets.includes("bill")
        ? t("A charge is attached to a bill that was deleted")
        : t("A charge is attached to something that was deleted"),
      detail: name
        ? t("{amount} on {date} — {name}. Right now it counts against no budget and pays no bill.", {
            amount: formatMoney(row.amount),
            date: formatDate(row.date),
            name,
          })
        : t(
            "The {amount} charge on {date} points at something that is no longer here. Right now it counts against no budget and pays no bill.",
            { amount: formatMoney(row.amount), date: formatDate(row.date) },
          ),
      amount: row.amount,
      fix: {
        label: t("Free this charge"),
        done: t("Freed. It counts as ordinary spending again."),
        write: "unlink-charge",
        txnId: row.txnId,
      },
      txnIds: [row.txnId],
    });
  }
  return out;
}

function arr<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v.filter(Boolean) : [];
}

/**
 * Everything the app noticed about the bills and the charges, biggest money
 * first, with anything already dismissed left out.
 *
 * Pure. Performs no writes and reads no clock beyond `now`.
 */
export function reviewSuggestions(
  data: AppData,
  now: Date,
  dismissedKeys: ReadonlySet<string>,
): Suggestion[] {
  // The spread keeps `rule` and `evidence` on the engine's objects at runtime —
  // the surface ignores what it has no field for, and a debugging session has
  // them. The dangling half carries neither, because neither is a guess about it.
  const engine: Suggestion[] = reviewLedger(data, now, dismissedKeys).map((s) => ({
    ...s,
    fix: s.fix ? toSurfaceFix(s.fix) : null,
  }));
  // The engine applies `dismissedKeys` itself; this half has to be filtered here.
  const dangling = danglingSuggestions(data).filter((s) => !dismissedKeys.has(s.key));
  return sortSuggestions([...engine, ...dangling]);
}

/** Biggest money first, the order spec §C renders the sheet in. */
export function sortSuggestions(list: readonly Suggestion[]): Suggestion[] {
  // Ties break on the key so the list is stable across renders — two $16.20
  // Amazon Prime cycles must not swap places when the data is untouched.
  return [...list].sort(
    (a, b) => b.amount - a.amount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
