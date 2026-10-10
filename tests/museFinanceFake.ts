// The write door's finance half, driven against an in-memory ledger.
//
// WHY A FAKE AND NOT A MOCK. The three things most worth proving about this phase are
// unreachable from a test runner any other way:
//
//   · the COMPARE-AND-SET. "the phone wrote in the gap, so the door changed nothing"
//     needs two writers against one row, in one process.
//   · the UNDO. "put it back and the row is byte for byte what it was" needs the whole
//     row before and after, which is what a table in memory is.
//   · the FENCE. A column the undo allowlist does not carry must not reach the
//     database, and the only way to see that is to be the database.
//
// It implements FinanceDb exactly, including the two things that are easy to fake
// wrongly and matter most: `setColumns` and `deleteRow` really do compare every
// expected value before writing, and the fence really does refuse a column outside the
// allowlist. A fake that skipped either would make every test in this phase pass for
// the wrong reason.

import type {
  AccountRow,
  BillNameRow,
  BillPaymentRow,
  BillRow,
  ChangeInsert,
  ChargeRow,
  DebtRow,
  DismissalRow,
  FinanceDb,
  LabelRow,
  MoneyEvent,
  PaidOverrideRow,
  RuleRow,
} from "../supabase/functions/muse-write/dbFinance";
import { StatementRefused } from "../supabase/functions/muse-write/dbFinance";
import type { Person } from "../supabase/functions/muse-write/db";
import {
  checkSteps,
  UNDO_COLUMNS,
  UNDO_TABLES,
  type UndoRecord,
  type UndoState,
  type UndoTable,
  type UndoValue,
} from "../supabase/functions/_shared/muse/undo";

export type Row = Record<string, unknown>;

/** Deep equality over the JSON shapes a column can hold. `applies_to` is compared as
 *  a document, which is what a jsonb `=` does in Postgres — key order does not count. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  const ao = a as Row;
  const bo = b as Row;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.join(",") !== bk.join(",")) return false;
  return ak.every((k) => sameJson(ao[k], bo[k]));
}

const INSERT_COLUMNS: Record<UndoTable, readonly string[]> = {
  transactions: ["date", "amount", "type", "category_id", "description", "account_id", "applies_to", "person"],
  recurring: ["name", "amount", "direction", "cadence", "category_id", "active", "due_days"],
  accounts: [],
  debts: ["name", "balance", "original_balance", "apr", "min_payment", "color"],
  paid_bills: ["month", "bill_key", "paid"],
  merchant_rules: ["pattern", "kind", "category_id", "bill_name"],
  review_dismissals: ["key", "person"],
};

/** PostgREST 12's own words for a table that is not there, so the tools' "not set up
 *  yet" branch is tested against the sentence the real database sends — a prettier
 *  fake message would let that branch pass on something Postgres never says. */
export const NO_DISMISSAL_TABLE =
  "Could not find the table 'public.review_dismissals' in the schema cache";

export class FinanceFake implements FinanceDb {
  /** The ledger, keyed the way Postgres keys it. Tests read and seed these directly. */
  tables: Record<UndoTable, Row[]> = {
    transactions: [],
    recurring: [],
    accounts: [],
    debts: [],
    paid_bills: [],
    merchant_rules: [],
    review_dismissals: [],
  };
  /** Set to be a database where schema_v43_review_dismissals.sql has not been run:
   *  every read and insert of review_dismissals fails the way PostgREST fails. */
  noDismissalTable = false;
  /** How many times confirm_charges' list read ran, so a test can see one read was
   *  made for the whole batch rather than one per charge. */
  chargeBatchReads = 0;
  changes: Row[] = [];
  /** Every call the door made to one of the three shaped writes, so a test can assert
   *  the door did ONE write rather than three. */
  writes: { op: string; table: string; id?: string }[] = [];
  /** Fires right after the door reads a charge, so a test can be the phone writing in
   *  the gap between the read and the compare-and-set. */
  onReadCharge: ((id: string) => void) | null = null;
  /** Tokens handed out, in order, so a test can undo the first change by name. */
  tokens: string[] = [];
  /** Ledger statements that changed a row, counted the way dbFinanceSupabase.ts counts
   *  them — so commit()'s "did anything land before this failed" has something real to
   *  read here too. */
  landed = 0;

  /**
   * The bank connections, for the refresh tool. NOT in `tables` above, because that
   * map is keyed by UndoTable — the six tables the undo fence allows — and
   * bank_connections is deliberately not one of them: a refresh request is not a
   * change anybody can want back.
   */
  connections: { id: string; lastSyncAt: string | null; refreshRequestedAt: string | null }[] = [];
  /** Set to make bankSyncTimes throw the way PostgREST does on a database where
   *  schema_v39 has not been run, so the tool's "not set up yet" path is real. */
  noRefreshColumn = false;

  private seq = 0;
  newId(prefix = "aaaaaaaa"): string {
    this.seq += 1;
    const tail = String(this.seq).padStart(12, "0");
    return `${prefix}-1111-2222-3333-${tail}`;
  }

  private fence(table: string, columns: string[], insert: boolean): UndoTable {
    if (!(UNDO_TABLES as readonly string[]).includes(table)) {
      throw new Error(`fake: ${table} is not a table this door writes`);
    }
    const t = table as UndoTable;
    const allowed = insert ? INSERT_COLUMNS[t] : UNDO_COLUMNS[t];
    for (const col of columns) {
      if (!allowed.includes(col)) throw new Error(`fake: ${table}.${col} is fenced off`);
    }
    return t;
  }

  private find(table: UndoTable, id: string): Row | undefined {
    return this.tables[table].find((r) => r.id === id);
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  readCharge(id: string): Promise<ChargeRow | null> {
    const r = this.find("transactions", id);
    if (!r) {
      this.onReadCharge?.(id);
      return Promise.resolve(null);
    }
    // SNAPSHOT FIRST, hook SECOND. The hook exists so a test can be the phone writing in
    // the gap between the read and the compare-and-set, and that only works if the door
    // is handed the row as it was BEFORE the hook ran — a live reference would hand it
    // the new values and the guard would look like it did not fire.
    const row: ChargeRow = {
      id: String(r.id),
      date: String(r.date),
      amount: Number(r.amount),
      type: r.type === "income" ? "income" : "expense",
      categoryId: String(r.category_id ?? ""),
      description: String(r.description ?? ""),
      accountId: (r.account_id as string | null) ?? null,
      appliesTo: (r.applies_to ?? null) as UndoValue,
      flowOverride: (r.flow_override ?? null) as string | null,
      splits: (r.splits ?? null) as UndoValue,
      anomalyAck: !!r.anomaly_ack,
      needsReview: !!r.needs_review,
      userCategorized: !!r.user_categorized,
      recordOnly: !!r.record_only,
      provider: (r.provider as string | null) ?? null,
      pending: r.status === "pending",
      createdAt: String(r.created_at ?? ""),
      person: (r.person as string | null) ?? null,
    };
    this.onReadCharge?.(id);
    return Promise.resolve(row);
  }

  readBill(id: string): Promise<BillRow | null> {
    const r = this.find("recurring", id);
    if (!r) return Promise.resolve(null);
    const row: BillRow = {
      id: String(r.id),
      name: String(r.name ?? ""),
      amount: Number(r.amount ?? 0),
      direction: (r.direction ?? "out") as BillRow["direction"],
      categoryId: (r.category_id as string | null) ?? null,
      active: !!r.active,
      variable: r.variable === true,
      knownAmount: r.known_amount == null ? null : Number(r.known_amount),
      dueDays: Array.isArray(r.due_days) ? (r.due_days as number[]) : null,
      startsOn: (r.starts_on as string | null) ?? null,
      endsOn: (r.ends_on as string | null) ?? null,
      linkedDebtId: (r.linked_debt_id as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      cadence: String(r.cadence ?? "monthly"),
      anchorDate: (r.anchor_date as string | null) ?? null,
      owner: (r.owner as string | null) ?? null,
    };
    return Promise.resolve(row);
  }

  readAccount(id: string): Promise<AccountRow | null> {
    const r = this.find("accounts", id);
    if (!r) return Promise.resolve(null);
    const row: AccountRow = {
      id: String(r.id),
      name: String(r.name ?? ""),
      balance: Number(r.balance ?? 0),
      providerAccountId: (r.provider_account_id as string | null) ?? null,
      last4: (r.last4 as string | null) ?? null,
    };
    return Promise.resolve(row);
  }

  readDebt(id: string): Promise<DebtRow | null> {
    const r = this.find("debts", id);
    if (!r) return Promise.resolve(null);
    const row: DebtRow = {
      id: String(r.id),
      name: String(r.name ?? ""),
      balance: Number(r.balance ?? 0),
      providerAccountId: (r.provider_account_id as string | null) ?? null,
      trackPattern: (r.track_pattern as string | null) ?? null,
      apr: r.apr == null ? null : Number(r.apr),
      minPayment: r.min_payment == null ? null : Number(r.min_payment),
    };
    return Promise.resolve(row);
  }

  /** Set to make readDebtClosedAt fail the way PostgREST does on a database where
   *  schema_v44_debt_closed.sql has not been run, so the tool's sentence for that is
   *  driven by the real failure shape rather than assumed. */
  noClosedColumn = false;

  readDebtClosedAt(id: string): Promise<string | null> {
    if (this.noClosedColumn) {
      // PostgREST's own wording, because the tool branches on the column NAME in it.
      return Promise.reject(new Error("read when a debt was closed: column debts.closed_at does not exist"));
    }
    const r = this.find("debts", id);
    return Promise.resolve(r ? ((r.closed_at as string | null) ?? null) : null);
  }

  allDebtNames(): Promise<{ id: string; name: string }[]> {
    return Promise.resolve(this.tables.debts.map((r) => ({ id: String(r.id), name: String(r.name ?? "") })));
  }

  billRules(): Promise<RuleRow[]> {
    return Promise.resolve(
      this.tables.merchant_rules
        .filter((r) => r.bill_name != null)
        .map((r) => ({
          id: String(r.id),
          pattern: String(r.pattern),
          kind: String(r.kind ?? ""),
          categoryId: (r.category_id as string | null) ?? null,
          billName: (r.bill_name as string | null) ?? null,
        })),
    );
  }

  paidMarks(): Promise<{ id: string; month: string; billKey: string }[]> {
    return Promise.resolve(
      this.tables.paid_bills.map((r) => ({ id: String(r.id), month: String(r.month), billKey: String(r.bill_key) })),
    );
  }

  readMerchantRule(pattern: string): Promise<RuleRow | null> {
    const r = this.tables.merchant_rules.find((x) => x.pattern === pattern);
    if (!r) return Promise.resolve(null);
    const row: RuleRow = {
      id: String(r.id),
      pattern: String(r.pattern),
      kind: String(r.kind ?? ""),
      categoryId: (r.category_id as string | null) ?? null,
      billName: (r.bill_name as string | null) ?? null,
    };
    return Promise.resolve(row);
  }

  readPaidOverride(month: string, billKey: string): Promise<PaidOverrideRow | null> {
    const r = this.tables.paid_bills.find((x) => x.month === month && x.bill_key === billKey);
    return Promise.resolve(r ? { id: String(r.id), paid: !!r.paid } : null);
  }

  allBillNames(): Promise<BillNameRow[]> {
    return Promise.resolve(
      this.tables.recurring.map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
        direction: String(r.direction ?? ""),
        active: !!r.active,
      })),
    );
  }

  billPayments(recurringId: string): Promise<BillPaymentRow[]> {
    return Promise.resolve(
      this.tables.transactions
        .filter((r) => (r.applies_to as Row | null)?.recurringId === recurringId)
        .map((r) => ({
          id: String(r.id),
          type: r.type === "income" ? ("income" as const) : ("expense" as const),
          appliesTo: (r.applies_to ?? null) as UndoValue,
          flowOverride: (r.flow_override ?? null) as string | null,
      flowOverride: (r.flow_override ?? null) as string | null,
        })),
    );
  }

  countDebtPayments(debtId: string): Promise<number> {
    return Promise.resolve(
      this.tables.transactions.filter((r) => (r.applies_to as Row | null)?.debtId === debtId).length,
    );
  }

  /** Set to make chargeNames fail the way the real paged read does when the ledger
   *  moves under it or a page comes back short — so "a ledger that cannot be read
   *  cleanly saves no rule" is tested against a real throw, not assumed. */
  chargeNamesFail = false;
  /** How many times the whole-ledger read ran, so a test can see it was not skipped. */
  chargeNameReads = 0;

  chargeNames(): Promise<string[]> {
    this.chargeNameReads += 1;
    if (this.chargeNamesFail) {
      return Promise.reject(new Error("read charge names: 836 rows exist and 835 came back"));
    }
    // Money out only, like the real filter — a rule never fires on a deposit.
    return Promise.resolve(
      this.tables.transactions.filter((r) => r.type === "expense").map((r) => String(r.description ?? "")),
    );
  }

  /** One charge as confirm_charges reads it. A snapshot, like readCharge's, so a test
   *  that writes in the gap is changing the table and not the door's copy. */
  private label(r: Row): LabelRow {
    return {
      id: String(r.id),
      date: String(r.date),
      amount: Number(r.amount),
      type: r.type === "income" ? "income" : "expense",
      categoryId: String(r.category_id ?? ""),
      description: String(r.description ?? ""),
      appliesTo: (r.applies_to ?? null) as UndoValue,
      splits: (r.splits ?? null) as UndoValue,
      needsReview: !!r.needs_review,
      userCategorized: !!r.user_categorized,
      pending: r.status === "pending",
    };
  }

  /** Set to make chargeLabels fail the way the real paged read does when the ledger
   *  moves under it — so "a ledger that cannot be read cleanly confirms nothing" is
   *  tested against a real throw. */
  chargeLabelsFail = false;

  readCharges(ids: readonly string[]): Promise<LabelRow[]> {
    this.chargeBatchReads += 1;
    const want = new Set(ids);
    const rows = this.tables.transactions.filter((r) => want.has(String(r.id))).map((r) => this.label(r));
    // Fires after the snapshot, exactly like readCharge's hook, so a test can be the
    // phone writing between the read and the compare-and-set.
    for (const id of ids) this.onReadCharge?.(id);
    return Promise.resolve(rows);
  }

  chargeLabels(): Promise<LabelRow[]> {
    if (this.chargeLabelsFail) {
      return Promise.reject(new Error("read charge labels: the ledger changed while it was read (836 rows, then 837)"));
    }
    const rows = this.tables.transactions.map((r) => this.label(r));
    for (const r of rows) this.onReadCharge?.(r.id);
    return Promise.resolve(rows);
  }

  readDismissal(key: string): Promise<DismissalRow | null> {
    if (this.noDismissalTable) return Promise.reject(new Error(`read review_dismissals: ${NO_DISMISSAL_TABLE}`));
    const r = this.tables.review_dismissals.find((x) => x.key === key);
    return Promise.resolve(r ? { id: String(r.id), key: String(r.key), person: String(r.person) } : null);
  }

  bankSyncTimes(): Promise<{ id: string; lastSyncAt: string | null; refreshRequestedAt: string | null }[]> {
    if (this.noRefreshColumn) {
      // PostgREST's own wording for an unknown column, because the tool branches on
      // the column NAME appearing in the message. A prettier fake message here would
      // make that branch pass on something the real database never says.
      return Promise.reject(
        new Error(`read bank sync times: column bank_connections.refresh_requested_at does not exist`),
      );
    }
    return Promise.resolve(this.connections.map((c) => ({ ...c })));
  }

  requestBankRefresh(atISO: string): Promise<number> {
    this.writes.push({ op: "requestBankRefresh", table: "bank_connections" });
    for (const c of this.connections) c.refreshRequestedAt = atISO;
    if (this.connections.length > 0) this.landed += 1;
    return Promise.resolve(this.connections.length);
  }

  // ── writes ────────────────────────────────────────────────────────────────
  setColumns(
    table: UndoTable,
    id: string,
    patch: Record<string, UndoValue>,
    expect: Record<string, UndoValue>,
  ): Promise<"ok" | "moved"> {
    this.fence(table, Object.keys(patch), false);
    this.fence(table, Object.keys(expect), false);
    this.writes.push({ op: "set", table, id });
    const row = this.find(table, id);
    if (!row) return Promise.resolve("moved");
    // The compare-and-set, for real. A fake that skipped this would make every
    // "something changed it since" test pass without the guard existing.
    for (const [col, want] of Object.entries(expect)) {
      if (!sameJson(row[col] ?? null, want ?? null)) return Promise.resolve("moved");
    }
    Object.assign(row, patch);
    this.landed += 1;
    return Promise.resolve("ok");
  }

  insertRow(table: UndoTable, row: Record<string, UndoValue>): Promise<string> {
    if (table === "review_dismissals" && this.noDismissalTable) {
      return Promise.reject(new Error(`insert review_dismissals: ${NO_DISMISSAL_TABLE}`));
    }
    // The table's own unique index on `key`, answering the way Postgres does — so the
    // race where the other phone dismissed the same thing between the door's read and
    // its insert is tested against the table's answer, not a read made a moment before.
    if (table === "review_dismissals" && this.tables.review_dismissals.some((r) => r.key === row.key)) {
      return Promise.reject(
        new StatementRefused(
          'insert review_dismissals: duplicate key value violates unique constraint "review_dismissals_key_key"',
          "23505",
        ),
      );
    }
    this.fence(table, Object.keys(row), true);
    const id = this.newId();
    this.writes.push({ op: "insert", table, id });
    this.tables[table].push({ id, ...row });
    this.landed += 1;
    return Promise.resolve(id);
  }

  deleteRow(table: UndoTable, id: string, expect: Record<string, UndoValue>): Promise<"ok" | "moved"> {
    this.fence(table, Object.keys(expect), false);
    this.writes.push({ op: "delete", table, id });
    const i = this.tables[table].findIndex((r) => r.id === id);
    if (i < 0) return Promise.resolve("moved");
    const row = this.tables[table][i];
    for (const [col, want] of Object.entries(expect)) {
      if (!sameJson(row[col] ?? null, want ?? null)) return Promise.resolve("moved");
    }
    this.tables[table].splice(i, 1);
    this.landed += 1;
    return Promise.resolve("ok");
  }

  // ── the money engine ──────────────────────────────────────────────────────
  applyMoneyEvent(ev: MoneyEvent): Promise<string> {
    const id = this.newId("bbbbbbbb");
    this.writes.push({ op: "apply_money_event", table: "transactions", id });
    this.tables.transactions.push({
      id,
      date: ev.date,
      amount: ev.amount,
      type: ev.type,
      category_id: ev.categoryId,
      description: ev.description,
      account_id: ev.accountId,
      applies_to: null,
      person: ev.person,
      created_at: "2026-09-26T19:00:00Z",
    });
    if (ev.accountId) {
      const acct = this.find("accounts", ev.accountId);
      if (acct) {
        acct.balance = Number(acct.balance) + (ev.type === "income" ? ev.amount : -ev.amount);
      }
    }
    this.landed += 1;
    return Promise.resolve(id);
  }

  reverseMoneyEvent(id: string): Promise<"ok" | "moved"> {
    const i = this.tables.transactions.findIndex((r) => r.id === id);
    if (i < 0) return Promise.resolve("moved");
    const row = this.tables.transactions[i];
    this.writes.push({ op: "reverse_money_event", table: "transactions", id });
    // The same three gates schema_v28_record_only.sql put on the real function: a
    // settled marker, a bank-feed row and an imported record all moved no cash.
    const settled = !!(row.applies_to as Row | null)?.settled;
    if (row.account_id && !settled && !row.provider && !row.record_only) {
      const acct = this.find("accounts", String(row.account_id));
      if (acct) {
        acct.balance = Number(acct.balance) - (row.type === "income" ? Number(row.amount) : -Number(row.amount));
      }
    }
    this.tables.transactions.splice(i, 1);
    this.landed += 1;
    return Promise.resolve("ok");
  }

  restoreMoneyEvent(row: Record<string, UndoValue>): Promise<"ok" | "moved"> {
    const id = String(row.id);
    if (this.find("transactions", id)) return Promise.resolve("moved");
    this.writes.push({ op: "restore_money_event", table: "transactions", id });
    // The table's OWN defaults for the columns the insert does not name, because the real
    // restore_money_event does not name them either — a charge the door is allowed to
    // delete is never a bank row and never pending, so both come back at their defaults.
    // Spelled here so a restored row is comparable to the row that was deleted; a fake
    // that left them off would make an exact undo look inexact.
    this.tables.transactions.push({ status: "posted", provider: null, ...row });
    const settled = !!(row.applies_to as Row | null)?.settled;
    if (row.account_id && !settled && !row.provider && !row.record_only) {
      const acct = this.find("accounts", String(row.account_id));
      if (acct) {
        acct.balance = Number(acct.balance) + (row.type === "income" ? Number(row.amount) : -Number(row.amount));
      }
    }
    this.landed += 1;
    return Promise.resolve("ok");
  }

  /**
   * The undo of finance.forget_merchant. "taken" exactly when the real insert would
   * hit the table's unique index on `pattern` or its primary key — so the undo's
   * "refuse rather than overwrite" is tested against the table's own answer, not
   * against a read the handler made a moment earlier.
   */
  restoreMerchantRule(rule: RuleRow): Promise<"ok" | "taken"> {
    const clash = this.tables.merchant_rules.some((r) => r.pattern === rule.pattern || r.id === rule.id);
    if (clash) return Promise.resolve("taken");
    this.writes.push({ op: "restore_merchant_rule", table: "merchant_rules", id: rule.id });
    this.tables.merchant_rules.push({
      id: rule.id,
      pattern: rule.pattern,
      kind: rule.kind,
      category_id: rule.categoryId,
      bill_name: rule.billName,
    });
    this.landed += 1;
    return Promise.resolve("ok");
  }

  writesLanded(): number {
    return this.landed;
  }

  // ── the change log ────────────────────────────────────────────────────────
  recordChange(c: ChangeInsert): Promise<void> {
    // Validated on the way in, exactly as the column's own check would be: a step
    // shape this door will not run must not reach the table.
    checkSteps(c.steps);
    this.tokens.push(c.token);
    this.changes.push({
      token: c.token,
      at: `2026-09-26T19:00:0${this.changes.length}Z`,
      person: c.person,
      tool: c.tool,
      summary: c.summary,
      steps: c.steps,
      state: "pending",
      undone_at: null,
      undone_by: null,
    });
    return Promise.resolve();
  }

  setChangeState(token: string, state: UndoState, at: { undoneAt?: string; undoneBy?: string }): Promise<void> {
    const row = this.changes.find((c) => c.token === token);
    if (row) {
      row.state = state;
      if (at.undoneAt) row.undone_at = at.undoneAt;
      if (at.undoneBy) row.undone_by = at.undoneBy;
    }
    return Promise.resolve();
  }

  private toRecord(row: Row | undefined): UndoRecord | null {
    if (!row) return null;
    let steps;
    try {
      steps = checkSteps(row.steps);
    } catch {
      return null;
    }
    return {
      token: String(row.token),
      at: String(row.at),
      person: String(row.person),
      tool: String(row.tool),
      summary: String(row.summary),
      steps,
      state: row.state as UndoState,
      undoneAt: (row.undone_at as string | null) ?? null,
      undoneBy: (row.undone_by as string | null) ?? null,
    };
  }

  findChange(person: Person, token: string): Promise<UndoRecord | null> {
    return Promise.resolve(
      this.toRecord(this.changes.find((c) => c.person === person && c.token === token)),
    );
  }

  latestUndoable(person: Person): Promise<UndoRecord | null> {
    const rows = this.changes
      .filter((c) => c.person === person && c.state === "undoable")
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return Promise.resolve(this.toRecord(rows[0]));
  }
}
