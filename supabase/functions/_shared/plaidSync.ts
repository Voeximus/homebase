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
