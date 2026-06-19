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
  amount: number; // signed, − = spend  (= −plaid.amount)
  pending: boolean;
  plaidCategory?: string;
}

export function normalize(t: PlaidTxn): NormalRow {
  return {
    providerTxnId: t.transaction_id,
    accountId: t.account_id,
    date: t.date,
    description: t.merchant_name || t.name,
    amount: -t.amount, // flip Plaid's sign to ours
    pending: !!t.pending,
    plaidCategory: t.personal_finance_category?.primary ?? undefined,
  };
}

export interface LedgerOps {
  upsertPosted: NormalRow[];
  reverse: string[];
  pendingUpsert: NormalRow[];
  pendingRemove: string[];
}

export function reconcile(
  sync: SyncResponse,
  contentKey: (r: NormalRow) => string,
  existingContentKeys: Set<string> = new Set(),
): LedgerOps {
  const ops: LedgerOps = { upsertPosted: [], reverse: [], pendingUpsert: [], pendingRemove: [] };

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
      if (!existingContentKeys.has(contentKey(row))) ops.upsertPosted.push(row);
    }
  }

  return ops;
}
