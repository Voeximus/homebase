// Plaid /transactions/sync → ledger operations.
//
// Pure and runtime-agnostic: no app imports, no Plaid SDK, no DB. The SAME
// function runs in a unit test and inside the Supabase Edge Function (Deno) —
// so the reconciliation logic that guards against double-counting is written
// and proven ONCE. (Lives under supabase/functions/_shared so the deploy bundle
// includes it.)
//
// The hard problem this solves: a card charge shows up first as `pending`, then
// later as `posted`. Done naively that's two ledger rows for one purchase — the
// exact balance drift that plagues manual imports. Plaid hands us the delta as
// three arrays (added / modified / removed) keyed on a stable transaction_id;
// this folds that delta into a clean set of ledger ops where a pending charge
// NEVER becomes a second row when it posts.

export interface PlaidTxn {
  transaction_id: string;
  pending: boolean;
  pending_transaction_id?: string | null;
  account_id: string;
  date: string; // "YYYY-MM-DD"
  name: string;
  merchant_name?: string | null;
  amount: number; // Plaid sign: + = money OUT of the account, − = money IN
  personal_finance_category?: { primary?: string; detailed?: string } | null;
}

export interface SyncResponse {
  added: PlaidTxn[];
  modified: PlaidTxn[];
  removed: { transaction_id: string }[];
}

// Normalized row. `amount` uses Homebase's convention (− = spend).
export interface NormalRow {
  providerTxnId: string;
  accountId: string;
  date: string;
  description: string;
  // The FULL bank descriptor, kept alongside the clean merchant name. Plaid's
  // `merchant_name` is tidy but lossy: it reports both "SAMSCLUB 4956 GAS 07/16"
  // and "SAMS CLUB #4956" as plain "Sam's Club", throwing away the one token that
  // says whether the charge was fuel or a grocery run. Classification reads this;
  // the UI still shows `description`. See resolveDepartment in categorize.ts.
  raw: string;
  amount: number; // signed, − = spend  (= −plaid.amount)
  pending: boolean;
  // For a POSTED row: the id of the pending row it replaces, when the bank linked
  // the two (Plaid's pending_transaction_id). reconcile already used this to queue
  // the pending row for deletion, and then threw the link away — so by the time the
  // posted row was written nothing could say which pending row it came from, and
  // anything a person had said about that pending row went with it. Kept now so the
  // sync can carry that answer across (see carryCorrection below).
  pendingTxnId: string | null;
}

export function normalize(t: PlaidTxn): NormalRow {
  return {
    providerTxnId: t.transaction_id,
    accountId: t.account_id,
    date: t.date,
    description: t.merchant_name || t.name,
    raw: t.name,
    amount: -t.amount, // flip Plaid's sign to ours
    pending: !!t.pending,
    pendingTxnId: t.pending_transaction_id || null,
  };
}

export interface LedgerOps {
  upsertPosted: NormalRow[];
  reverse: string[];
  pendingUpsert: NormalRow[];
  pendingRemove: string[];
  // Rows we did NOT post because the same purchase is already in the ledger
  // under different provenance (see the content-key guard below). Returned so a
  // dedup is never invisible — dropping money rows silently is how a ledger
  // starts lying quietly instead of loudly.
  absorbed: NormalRow[];
}

// `existingContentKeys` is the second line of defence, for the duplicate a
// transaction_id CANNOT see: the same purchase already in the ledger under a
// different identity — hand-entered, CSV/PDF-imported, or fed by an OLDER Plaid
// item after a re-link (a re-link mints brand-new ids, so the DB's unique index
// on (provider, provider_txn_id) never fires and the whole history lands twice).
// The parameter existed from the start but no caller ever passed it, so the
// guard on the last line of this function was dead code protecting nothing.
//
// Two rules keep it from eating rows it must not:
//   • `knownProviderIds` — an id we already store is THIS row coming back, not a
//     duplicate of a different row. A deliberate cursor reset (the operational
//     tool used for the v25 raw_description and v26 keep_category backfills)
//     re-sends the entire history in `added`; without this skip every row would
//     match its OWN ledger row and the healing upsert would never run.
//   • keys are CONSUMED on first match, so one existing row absorbs at most one
//     incoming row. Two genuinely identical charges (two $5 coffees, same shop,
//     same day) still land the second one. The residual error leans toward an
//     extra VISIBLE row rather than silently deleting real spend — a duplicate
//     on screen gets fixed in one tap; hidden spend is never noticed.
export function reconcile(
  sync: SyncResponse,
  contentKey: (r: NormalRow) => string,
  existingContentKeys: Set<string> = new Set(),
  knownProviderIds: Set<string> = new Set(),
): LedgerOps {
  const ops: LedgerOps = { upsertPosted: [], reverse: [], pendingUpsert: [], pendingRemove: [], absorbed: [] };
  // Consume from a copy: the caller's set is theirs, and it may be reused.
  const unclaimed = new Set(existingContentKeys);

  for (const r of sync.removed) {
    ops.reverse.push(r.transaction_id);
    ops.pendingRemove.push(r.transaction_id);
  }

  for (const t of [...sync.added, ...sync.modified]) {
    const row = normalize(t);
    if (t.pending_transaction_id) ops.pendingRemove.push(t.pending_transaction_id);

    if (row.pending) {
      ops.pendingUpsert.push(row);
    } else {
      ops.pendingRemove.push(row.providerTxnId);
      const key = contentKey(row);
      if (!knownProviderIds.has(row.providerTxnId) && unclaimed.has(key)) {
        unclaimed.delete(key); // spent: the next row with this key posts normally
        ops.absorbed.push(row);
      } else {
        ops.upsertPosted.push(row);
      }
    }
  }

  return ops;
}

// ── a person's answer outlives the pending row it was given on ────────────────
//
// FOUND 2026-10-09. A car repair was filed as `car` by hand on
// 10-05 while it was still pending. On 10-06 it posted: the sync deleted the
// pending row (Plaid linked the two through pending_transaction_id) and inserted
// the posted row fresh, and the fresh row came back as `other` — the $125/mo Misc
// line. The answer had been given to a row that no longer existed, and nothing
// moved it to the row that replaced it. The same thing happens to a pending row the
// bank re-sends under the same id, because the sync replaces those by delete and
// insert too.
//
// A pending charge is the moment a person is most likely to look at a charge — it
// is the one the phone just buzzed about — so this is not a corner case. It is the
// normal path for any correction made the same day.

/** One slice of a split charge, as the app stores it (src/types.ts TxnSplit). */
export interface CarriedSlice {
  categoryId: string;
  amount: number; // positive dollars
}

/** What a person said about a pending row, read just before the sync replaces it. */
export interface PendingCorrection {
  categoryId: string | null;
  userCategorized: boolean;
  flowOverride: string | null;
  // The pending row's split, exactly as stored (null when it has none). Read as
  // `unknown` from the database, so carryCorrection checks its shape itself.
  splits: unknown;
}

/** The columns a carried answer writes onto the row that replaces the pending one. */
export interface CarriedCorrection {
  category_id?: string;
  user_categorized?: true;
  needs_review?: boolean;
  flow_override?: string;
  splits?: CarriedSlice[];
}

/**
 * The slices of a split, when every one of them is a real slice and together they
 * add up to `amount` to the cent. Null otherwise — no split, a malformed one, or one
 * that no longer fits this charge.
 *
 * Compared in whole cents, the same as the write door's split_charge: a sum of
 * two-decimal numbers is not exactly a two-decimal number.
 */
function slicesThatFit(splits: unknown, amount: number): CarriedSlice[] | null {
  if (!Array.isArray(splits) || splits.length === 0 || !Number.isFinite(amount)) return null;
  const slices: CarriedSlice[] = [];
  for (const s of splits) {
    const categoryId = (s as { categoryId?: unknown })?.categoryId;
    const sliceAmount = (s as { amount?: unknown })?.amount;
    if (typeof categoryId !== "string" || !categoryId) return null;
    if (typeof sliceAmount !== "number" || !Number.isFinite(sliceAmount) || sliceAmount <= 0) return null;
    slices.push({ categoryId, amount: sliceAmount });
  }
  const cents = (n: number) => Math.round(n * 100);
  const sum = slices.reduce((a, s) => a + cents(s.amount), 0);
  return sum === cents(Math.abs(amount)) ? slices : null;
}

/**
 * What the replacing row should inherit from the pending row it replaces. Null when
 * there is nothing to carry.
 *
 * ONLY WHAT A PERSON SAID. A category the classifier picked for the pending row is
 * not carried: it was a guess about a hold, and the posted row has just been
 * classified afresh from the settled descriptor, which is the better guess. The
 * test is `user_categorized`, the same flag the importer's upsert already treats as
 * sacred (apply_bank_sync), so "carried" and "never overwritten" mean the same
 * thing. needs_review is cleared with it because the question has been answered —
 * the same three columns the app writes together (FinanceStore.setTransactionCategory).
 *
 * NEVER applies_to. A bill or debt link belongs to the SETTLED charge by design: a
 * hold can still be reversed, and a cycle marked paid off a hold that vanished is
 * the one mistake here that costs real money. So the link is not read from the
 * pending row at all, and is left for the posted row's own matching.
 *
 * AND WHEN THE SYNC MATCHED THE POSTED ROW TO A BILL OR DEBT ITSELF, THAT MATCH WINS
 * over a carried category. The match settles a cycle or credits a debt and brings
 * the bill's own category with it (`bills`, `housing`, …); laying a pending-time
 * category over it would leave a row that pays the rent filed as dining, and with
 * user_categorized set it could never be re-decided. A person who disagrees with the
 * match can still unlink it (unlinkFromBill in the app, finance.unlink_charge on the
 * write door), which is the tool for that.
 *
 * flow_override carries regardless of a match. It is a different answer — not where
 * the money went but whether it was spent at all — and flow.ts already ranks a hand
 * override above any link (flowOf, rule 0). Carrying it keeps that ranking true
 * across the pending → posted hand-off instead of quietly undoing it.
 *
 * A SPLIT CARRIES WHOLE OR NOT AT ALL. FOUND 2026-10-09 in review of the first
 * version of this function, which read no splits: a pending charge split by hand
 * (a $180 warehouse-club run, $120 groceries and $60 household) reached the posted
 * row as its primary category alone — 100% groceries — with user_categorized set
 * and needs_review cleared. The $60 slice was graded against the wrong envelope,
 * and because the row was now marked answered, neither apply_bank_sync nor the
 * relabel sweep would ever look at it again and nothing asked. Before the carry
 * existed, the same posted row at least came back unanswered and asked.
 *
 * So the slices are carried with the category when they still add up to the
 * replacing charge to the cent — the app's own `splits-sum` self-check fails
 * otherwise. They usually do: most charges post at the amount they were held for.
 * When they do not (a tip added, a fuel pre-authorisation settled lower, a slice
 * that does not parse), the person's split answers a charge that no longer exists,
 * and neither half of it may stand in for an answer: not the slices, which would
 * break the self-check, and not the primary category alone, which is the lock-in
 * above. The replacing row keeps the classifier's own category and is marked
 * needs_review, so it ASKS AGAIN. Keeping the classifier's category is also what
 * keeps the question asked: the relabel sweep that runs later in the same sync
 * clears needs_review only on a row whose category it would change, and it would
 * not change its own answer. A split is always a person's answer whatever
 * user_categorized says — the sync never writes one — so this does not wait on the
 * flag. A bill or debt match still wins over all of it, as above.
 */
export function carryCorrection(
  replacement: { applies_to?: unknown; amount: number },
  was: PendingCorrection | undefined,
): CarriedCorrection | null {
  if (!was) return null;
  const out: CarriedCorrection = {};
  const matchedBySync = replacement.applies_to != null;
  const hasSplit = Array.isArray(was.splits) && was.splits.length > 0;
  if (!matchedBySync && hasSplit) {
    const slices = slicesThatFit(was.splits, replacement.amount);
    if (slices) {
      // The primary category follows the largest slice, as the app and the door set
      // it; the pending row's own category_id already is that, unless it was lost.
      out.category_id = was.categoryId ?? [...slices].sort((a, b) => b.amount - a.amount)[0].categoryId;
      out.user_categorized = true;
      out.needs_review = false;
      out.splits = slices;
    } else {
      out.needs_review = true;
    }
  } else if (was.userCategorized && was.categoryId && !matchedBySync) {
    out.category_id = was.categoryId;
    out.user_categorized = true;
    out.needs_review = false;
  }
  if (was.flowOverride) out.flow_override = was.flowOverride;
  return Object.keys(out).length ? out : null;
}
