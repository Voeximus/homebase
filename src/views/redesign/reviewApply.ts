// ── One tap, one write ────────────────────────────────────────────────────────
//
// Spec §D. Everything a suggestion can do to the data passes through this file,
// so there is exactly one place to read to know what a tap can cost.
//
// THE RULE OVER ALL OF IT: nothing writes to Supabase without a tap. The engine
// is pure and returns a `fix` descriptor; this turns one descriptor into one store
// call, in response to one tap, from a sheet where the person is looking at both
// numbers.
//
// TWO LAYERS OF PROTECTION AGAINST THE THINGS §D.7 FORBIDS
//   1. The `SuggestionFix` union cannot express them (reviewTypes.ts). There is no
//      "delete a bank row", no "delete a recurring row", no "write a merchant
//      rule", no "mark a bill paid". Not offered means not representable.
//   2. Everything below re-reads the CURRENT data at tap time and refuses if the
//      world moved — the bank feed may have linked the cycle since the card was
//      drawn, or the row may be gone. Rendering proves nothing about now.
//
// A refusal is never silent. It returns a plain sentence the sheet shows.

import { DUE_DAYS, billCycleFor } from "../../lib/schedule";
import { t } from "../../lib/i18n";
import type { AppData } from "../../types";
import type { NewBillDraft, SuggestionFix } from "../../lib/reviewTypes";

/**
 * The store actions a fix may call.
 *
 * `unlinkFromBill` and `deleteTransaction` exist in FinanceStore today. The other
 * five are spec piece 3 and are OPTIONAL here on purpose: a fix whose action is
 * missing is not offered at all (the card falls back to its "open the evidence"
 * button), so the surface degrades to information instead of to a dead button,
 * and lights up on its own as each action lands. No edit to this file.
 */
export interface ReviewWrites {
  unlinkFromBill: (txnId: string) => Promise<void>;
  deleteTransaction: (txnId: string) => Promise<void>;
  setRecurringAmount?: (
    id: string,
    patch: { amount?: number; knownAmount?: number | null },
  ) => Promise<void>;
  setRecurringActive?: (id: string, active: boolean) => Promise<void>;
  setRecurringWindow?: (id: string, patch: { endsOn?: string | null }) => Promise<void>;
  addRecurringFromCharges?: (bill: NewBillDraft) => Promise<void>;
  linkTransactionToBill?: (txnId: string, recurringId: string) => Promise<void>;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/**
 * Does the store action this fix needs exist at all?
 *
 * This is deliberately NOT "can this be tapped". A fix can also be unavailable
 * because the engine BLOCKED it (§D.4 — a new bill whose charges only agree on
 * `other`), and the two mean opposite things to the person reading the card. A
 * blocked fix is a real offer the app is holding back for a stated reason, so it
 * keeps its own button, greyed, with the reason above it. A fix whose action has
 * not shipped is not an offer at all, so the card shows the evidence instead and
 * says nothing about plumbing.
 */
export function hasWrite(fix: SuggestionFix, writes: ReviewWrites): boolean {
  switch (fix.write) {
    case "unlink-charge":
      return typeof writes.unlinkFromBill === "function";
    case "remove-manual-charge":
      return typeof writes.deleteTransaction === "function";
    case "set-bill-amount":
      return typeof writes.setRecurringAmount === "function";
    case "turn-bill-off":
      return typeof writes.setRecurringActive === "function";
    case "end-income":
      return typeof writes.setRecurringWindow === "function";
    case "add-bill":
      return typeof writes.addRecurringFromCharges === "function";
    case "link-charge-to-bill":
      return typeof writes.linkTransactionToBill === "function";
  }
}

/**
 * Apply one fix. `data` must be the CURRENT store data, read at tap time — every
 * guard below depends on that.
 */
export async function applyFix(
  fix: SuggestionFix,
  data: AppData,
  writes: ReviewWrites,
): Promise<ApplyResult> {
  if (fix.blocked) return { ok: false, reason: fix.blocked };

  switch (fix.write) {
    // ── §D.1 — release a charge whose bill was deleted ───────────────────────
    case "unlink-charge": {
      const txn = data.transactions.find((x) => x.id === fix.txnId);
      if (!txn) return { ok: false, reason: t("That charge is no longer here.") };
      if (!txn.appliesTo) return { ok: false, reason: t("That charge is already free of any bill.") };
      await writes.unlinkFromBill(fix.txnId);
      return { ok: true };
    }

    // ── §D.2 — the row's amount is out of date ───────────────────────────────
    case "set-bill-amount": {
      const rec = data.recurring.find((r) => r.id === fix.recurringId);
      if (!rec) return { ok: false, reason: t("That bill is no longer here.") };
      if (!writes.setRecurringAmount) return { ok: false, reason: notConnected() };
      if (!(fix.amount > 0)) return { ok: false, reason: t("That amount does not look right.") };
      // A variable row's estimate lives in known_amount; a fixed row's price is
      // `amount`. Writing the wrong one would leave the old figure in force and
      // read as a fix that did nothing.
      await writes.setRecurringAmount(
        fix.recurringId,
        fix.variable ? { knownAmount: fix.amount } : { amount: fix.amount },
      );
      return { ok: true };
    }

    // ── §D.3 — a bill that looks finished. Never a delete ────────────────────
    case "turn-bill-off": {
      const rec = data.recurring.find((r) => r.id === fix.recurringId);
      if (!rec) return { ok: false, reason: t("That bill is no longer here.") };
      if (!rec.active) return { ok: false, reason: t("That bill is already off.") };
      if (!writes.setRecurringActive) return { ok: false, reason: notConnected() };
      await writes.setRecurringActive(fix.recurringId, false);
      return { ok: true };
    }

    // ── §D.3 — income that was a one-off ────────────────────────────────────
    case "end-income": {
      const rec = data.recurring.find((r) => r.id === fix.recurringId);
      if (!rec) return { ok: false, reason: t("That income is no longer here.") };
      if (!writes.setRecurringWindow) return { ok: false, reason: notConnected() };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fix.endsOn)) {
        return { ok: false, reason: t("That date does not look right.") };
      }
      await writes.setRecurringWindow(fix.recurringId, { endsOn: fix.endsOn });
      return { ok: true };
    }

    // ── §D.4 — model a repeat that is not in the bills ───────────────────────
    case "add-bill": {
      if (!writes.addRecurringFromCharges) return { ok: false, reason: notConnected() };
      const b = fix.bill;
      if (!b.name.trim()) return { ok: false, reason: t("That bill needs a name.") };
      if (!(b.amount > 0)) return { ok: false, reason: t("That amount does not look right.") };
      if (!(b.dueDay >= 1 && b.dueDay <= 31)) {
        return { ok: false, reason: t("That due day does not look right.") };
      }
      // A bill row landing in an ungraded category is the exact defect the
      // orphan-category check exists to catch, so it is refused here as well as
      // disabled in the card. Two places, because this one is the dangerous half.
      if (!b.categoryId || b.categoryId === "other") {
        return { ok: false, reason: t("Give it a category first.") };
      }
      // A bill that is already modelled must not be modelled twice.
      const already = data.recurring.some(
        (r) => r.active && r.direction === "out" && r.name.trim().toLowerCase() === b.name.trim().toLowerCase(),
      );
      if (already) return { ok: false, reason: t("You already have a bill with that name.") };
      await writes.addRecurringFromCharges(b);
      return { ok: true };
    }

    // ── §D.5 — a hand-entered row duplicating a bank row ────────────────────
    case "remove-manual-charge": {
      const txn = data.transactions.find((x) => x.id === fix.txnId);
      if (!txn) return { ok: false, reason: t("That charge is no longer here.") };
      // The hard rule: never the bank's row. Plaid re-delivers it on the next
      // page, and real bank history is the one thing in this whole feature the app
      // cannot rebuild. This is re-checked here even though the engine only ever
      // proposes the hand-entered side, because the engine ran before the tap.
      if (txn.provider) {
        return { ok: false, reason: t("This one came from the bank, so it stays.") };
      }
      if (txn.recordOnly) {
        return { ok: false, reason: t("This one records money that moved outside the app, so it stays.") };
      }
      await writes.deleteTransaction(fix.txnId);
      return { ok: true };
    }

    // ── §D.6 — the most dangerous write here: it settles a bill cycle ────────
    case "link-charge-to-bill": {
      if (!writes.linkTransactionToBill) return { ok: false, reason: notConnected() };
      const txn = data.transactions.find((x) => x.id === fix.txnId);
      const rec = data.recurring.find((r) => r.id === fix.recurringId);
      if (!txn) return { ok: false, reason: t("That charge is no longer here.") };
      if (!rec) return { ok: false, reason: t("That bill is no longer here.") };
      if (txn.appliesTo) {
        return { ok: false, reason: t("That charge is already attached to something.") };
      }
      if (txn.pending) {
        return { ok: false, reason: t("That charge is still processing. It can be attached once it posts.") };
      }
      // Guard 3 from §D.6: the feed may have linked this cycle since the card was
      // drawn. Re-derive the cycle from the CURRENT data and refuse if it is taken.
      //
      // "Same cycle" is (month, due day) and deliberately NOT a sixth copy of the
      // installment-ordinal logic — there are already five cycle-key
      // implementations in this codebase and that is the reason the Cherry
      // duplicate was invisible. The due day is what distinguishes one
      // installment from another (support to family, paid on the 15th AND the
      // 30th), every stored row carries it, and comparing it needs no table.
      //
      // The days themselves come from the SAME place the engine keyed the cycle
      // on: the row's own, falling back to the legacy name map the calendar also
      // falls back to. Handing `rec.dueDays` straight over looked right and was
      // not — for a row whose days live only in that map, billCycleFor() falls
      // back to the CHARGE's own day, so this guard would be reading a different
      // cycle than the card offered and could let two charges settle one (which
      // the exact check `one-payment-per-cycle` would then report as a defect).
      const dueDays = rec.dueDays?.length ? rec.dueDays : DUE_DAYS[rec.name];
      const cycle = billCycleFor(dueDays, txn.date);
      const taken = data.transactions.some((x) => {
        const at = x.appliesTo;
        if (x.id === txn.id) return false;
        if (x.type !== "expense" || at?.kind !== "bill" || at.recurringId !== rec.id) return false;
        return at.monthKey === cycle.monthKey && (at.day ?? cycle.day) === cycle.day;
      });
      if (taken) {
        return { ok: false, reason: t("Something else is already paying that bill for this month.") };
      }
      await writes.linkTransactionToBill(fix.txnId, fix.recurringId);
      return { ok: true };
    }
  }
}

/** Shown when the store action a fix needs has not landed yet. */
function notConnected(): string {
  return t("That fix is not ready yet. You can still change it yourself.");
}
