// A seed-only answer files a NEW row, and leaves a row the ledger already has alone.
//
// WHY THIS FILE EXISTS, 2026-10-25. The categorizer gained rules that day (a taught
// rule reached through a near spelling; refunds and paybacks among money coming in)
// and the household's standing rule is that new behaviour applies to new rows: "a
// guess may SEED a row, never RE-DECIDE one" (schema_v26, written after a re-sync
// re-decided twelve rows at once and moved $702 into the wrong line). A re-sync — the
// bank re-sending a row it changed, or a deliberate cursor reset re-sending all of
// them — asks the categorizer about every row again, so a new rule would otherwise
// reach straight back into history.
//
// apply_bank_sync gives half of the protection already: `keep_category` keeps an
// existing row's category. It does NOT keep needs_review — that always comes from what
// the sync sends, because an ambiguous row SHOULD start asking again. For a seed-only
// answer that is wrong in both directions: a confident answer would clear an old row's
// review flag under a category the rule never set, and the old, unsure answer would
// flag a row the rule already filed. So the sync reads the flag the row already has and
// sends it back unchanged. This is the decision, lifted out of plaid/index.ts so a test
// can hold it; the sync only does the reading and the writing.
//
// Pure: no database, no clock.

/** The parts of a Classification (categorize.ts) this decision reads. */
export interface SeedAnswer {
  confidence: "high" | "low";
  ambiguous?: boolean;
  seedOnly?: boolean;
}

/** The two flags a posted spending row carries to apply_bank_sync. `stored` is the
 *  needs_review the ledger's own row already has, or undefined when there is no such
 *  row yet (or the answer is not seed-only, which never needs it). */
export function seedFlags(c: SeedAnswer, stored: boolean | undefined): { needs_review: boolean; keep_category: boolean } {
  return {
    needs_review: c.seedOnly === true && stored !== undefined ? stored : c.confidence === "low",
    // An ambiguous pre-fill (v26) and a seed-only answer both may seed, never overwrite.
    keep_category: c.ambiguous === true || c.seedOnly === true,
  };
}

/**
 * The same two flags for a posted CREDIT (creditCategory in categorize.ts).
 *
 * A credit never asks for review, as before. Its category is kept on a re-sync unless
 * it is a paycheck — and that includes `other-income`, not just a refund, because the
 * refund answer depends on the spend history: if the history read failed, or the
 * purchase has since been deleted, the same credit comes back `other-income`, and
 * without this a seeded refund would quietly turn back into earnings. A paycheck reads
 * nothing but its own words, so it is re-asked exactly as before.
 */
export function creditFlags(categoryId: string): { needs_review: boolean; keep_category: boolean } {
  return { needs_review: false, keep_category: categoryId !== "salary" };
}

/**
 * The money-out descriptions a sync builds creditCategory's spend history from: every
 * expense the ledger already holds (`stored`), PLUS this sync's own money out — each
 * row of the delta that the sync is about to write as spending (`writtenAsSpend`, the
 * sync's own decision, passed in so this cannot drift from it).
 *
 * WHY THE DELTA, FOUND 2026-10-25 in review. The history was read from the database
 * before this sync's rows were written, so a purchase and its refund arriving in the
 * SAME delta — a newly linked or re-linked account's first pull, or a catch-up after
 * a run of missed syncs — met no history: the refund was filed other-income, and
 * because a credit's category is kept on every later re-sync (creditFlags), it stayed
 * other-income for good. A seed is decided once, so it has to see everything there is
 * to see when it is decided.
 *
 * Only money OUT counts: a credit in the delta is never history for another credit.
 */
export function spendHistoryDescriptions<R extends { amount: number; description: string }>(
  stored: Iterable<string | null | undefined>,
  delta: Iterable<R>,
  writtenAsSpend: (row: R) => boolean,
): (string | null | undefined)[] {
  const out = [...stored];
  for (const r of delta) if (r.amount < 0 && writtenAsSpend(r)) out.push(r.description);
  return out;
}
