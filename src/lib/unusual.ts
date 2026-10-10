// ── Unusual purchases — one rule, for the screen and for Muse ─────────────────
//
// MOVED HERE ON 2026-10-10, out of src/views/redesign/buildVMs.ts, unchanged.
//
// WHY IT MOVED. The rule lived inside the screen that drew it (the Activity tab's
// "unusual purchases" count), and that screen is being retired: Muse is the interface
// now. The write door already had finance.dismiss_unusual, and a scan of the door's real
// calls on 2026-10-10 found it had never been called — because nothing on either
// door could SEE the list it dismisses from. A dismiss with nothing to point at is a
// dead end, and the screen that could point is the one going away.
//
// A copy for the door would be the drift this repo keeps paying for: cron-notify once
// told the phones "Electric $85" while every screen said $100, because it re-implemented
// the app's maths by hand. So the rule is HERE, once. The screen calls it, and the read
// door calls the generated copy of this same file (scripts/gen-muse-shared.mjs, checked
// byte for byte by `npm run build`), so the two cannot disagree about which charge is
// unusual.
//
// THE RULE, exactly as the screen has always applied it:
//   · only this month's charges that are money OUT, attached to nothing (no bill, debt,
//     goal, transfer or set-aside) and already POSTED — a pending charge is display-only
//     and excluded from every budget figure until it posts;
//   · grouped by category, and the category's figure is the plain MEAN of those
//     charges, the unusual one included;
//   · a charge is unusual when its category has at least 3 such charges, it is over $25,
//     and it is more than 2.5 times that mean;
//   · and nobody has dismissed it (`anomalyAck`, which finance.dismiss_unusual and the
//     app's own button both set). A dismissed charge still counts towards its
//     category's mean — dismissing says "this one is fine", not "pretend it did not
//     happen".
//
// Pure: no clock (the month is handed in), no I/O, and the input order is the output
// order, which is what the screen's list has always shown.

import type { Transaction } from "../types";

/** Below this, a charge is never called unusual however small its category is. */
export const UNUSUAL_MIN_AMOUNT = 25;
/** How many times its category's mean a charge has to be. */
export const UNUSUAL_RATIO = 2.5;
/** A category with fewer charges than this has no "usual" to compare against. */
export const UNUSUAL_MIN_IN_CATEGORY = 3;

export interface UnusualCharge {
  tx: Transaction;
  /** The plain mean of the month's unattached, posted charges in this category,
   *  this one included. */
  mean: number;
  /** `tx.amount / mean`, or 0 when the mean is not positive. */
  ratio: number;
  /** How many charges that mean was taken over. */
  inCategory: number;
  /** True when somebody already said this one is fine. Only ever true when the
   *  caller asked for dismissed charges too — the screen never does. */
  dismissed: boolean;
}

/**
 * The month's unusual charges, in the order `txns` lists them.
 *
 * `monthKey` is "YYYY-MM". `txns` is whatever the caller is showing: the screen hands
 * it the lens-filtered ledger, so a spouse's charge does not count on one person's
 * screen; the door hands it the whole household's. Rows outside the rule (wrong month,
 * attached, pending, income) can be in it — they are filtered here.
 *
 * `includeDismissed` is for a caller that wants to say how many were already waved
 * away. Left off, the result is exactly what the screen has always listed.
 */
export function unusualCharges(
  txns: readonly Transaction[],
  monthKey: string,
  opts: { includeDismissed?: boolean } = {},
): UnusualCharge[] {
  const monthFree = txns.filter(
    (t) => t.type === "expense" && t.date.slice(0, 7) === monthKey && !t.appliesTo && !t.pending,
  );
  const byCatAmts: Record<string, number[]> = {};
  monthFree.forEach((t) => (byCatAmts[t.categoryId] ??= []).push(t.amount));
  const out: UnusualCharge[] = [];
  for (const t of monthFree) {
    if (t.anomalyAck && !opts.includeDismissed) continue; // dismissed → never resurface
    const arr = byCatAmts[t.categoryId];
    if (arr.length < UNUSUAL_MIN_IN_CATEGORY || t.amount <= UNUSUAL_MIN_AMOUNT) continue;
    const mean = arr.reduce((s, a) => s + a, 0) / arr.length;
    if (!(t.amount > UNUSUAL_RATIO * mean)) continue;
    out.push({
      tx: t,
      mean,
      ratio: mean > 0 ? t.amount / mean : 0,
      inCategory: arr.length,
      dismissed: !!t.anomalyAck,
    });
  }
  return out;
}
