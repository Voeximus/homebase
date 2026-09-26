// ── The seam between the surface and the review engine ────────────────────────
//
// The screen (spec piece 4) and the engine (spec piece 2) were built in parallel,
// in separate worktrees. `src/lib/ledgerReview.ts` belongs to the engine and does
// not exist here yet — and a missing module is a hard build error, not an
// optional one, so the surface cannot simply ask for it and cope.
//
// So the surface asks THIS file, and this file is the one place that has to change
// when the engine lands. Two lines:
//
//     import { reviewLedger } from "./ledgerReview";
//     export const ENGINE_WIRED = true;
//
// and the body of reviewSuggestions() becomes
//
//     return reviewLedger(data, now, dismissedKeys);
//
// `ENGINE_WIRED` exists so this cannot ship silently dead: the dev harness
// (?doctorlab) prints a banner while it is false, and the harness is the first
// thing anyone opens.
//
// The suggestion CARD is hidden whenever the list is empty (spec §C — no green
// "all clear" card, because a guesser that says "nothing to report" is just
// taking up space), so an unwired engine shows the user nothing at all rather
// than an empty shell.

import type { AppData } from "../types";
import type { Suggestion } from "./reviewTypes";

/** False until src/lib/ledgerReview.ts is connected above. */
export const ENGINE_WIRED = false;

/**
 * Everything the app noticed about the bills and the charges, biggest money
 * first, with anything already dismissed on this phone left out.
 *
 * Pure. Performs no writes and reads no clock beyond `now`.
 */
export function reviewSuggestions(
  data: AppData,
  now: Date,
  dismissedKeys: ReadonlySet<string>,
): Suggestion[] {
  // The engine consumes all three; see the note above. Referenced so the
  // signature this file publishes is the signature the engine must satisfy.
  void data;
  void now;
  void dismissedKeys;
  return [];
}

/** Biggest money first, the order spec §C renders the sheet in. */
export function sortSuggestions(list: readonly Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => b.amount - a.amount);
}
