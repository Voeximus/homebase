// FinanceDb, wired to the real database. The other half of dbSupabase.ts, and it
// carries that file's two habits unchanged:
//
//   FAIL CLOSED. Every call checks its error and throws. PostgREST does not throw on
//   its own — it hands back { data: null, error } — so an unchecked call is a write
//   that looks like it worked.
//
//   READ NARROW. Each select names the columns it needs and no others. Phase 2 widened
//   one of them and it is worth saying which: `readCharge` reads `description`, because
//   promote-to-bill names the bill after the merchant and learn-merchant keys on
//   merchantKey(description) — the app's own derivations. It still never reads
//   `raw_description`. No tool on either door looks at that column.
//
// AND ONE HABIT OF ITS OWN, which is the whole reason this phase is safe:
//
//   EVERY WRITE IS A COMPARE-AND-SET, AND EVERY WRITE IS FENCED. setColumns, insertRow
//   and deleteRow take a table and columns, and both are checked against the undo
//   core's allowlist before the statement is built — so a column name cannot reach
//   PostgREST unless the door can also put that column back. The `.eq()` chain on the
//   expected values is what makes "the phone wrote in the gap" a refusal rather than an
//   overwrite, and `.select("id")` is what makes it VISIBLE: an UPDATE that matched
//   zero rows comes back { error: null } with no rows, which is how the app once
//   reported a write that changed nothing as a success.
//
// WHY THE FENCE IS CHECKED HERE TOO, not only where a tool builds a step. This file is
// the last thing between a column name and the database, and it is reached from two
// directions — a forward write from a tool, and an undo reading steps back out of a
// table. Checking in one place and trusting in the other would mean the table's
// contents decide what can be written.

import { expectParts } from "./expectParts.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type {
  AccountRow,
  BillNameRow,
  BillPaymentRow,
  BillRow,
  ChangeInsert,
  ChargeRow,
  DebtRow,
  FinanceDb,
  MoneyEvent,
  PaidOverrideRow,
  RuleRow,
} from "./dbFinance.ts";
import { LIST_CAP } from "./dbFinance.ts";
import type { Person } from "./db.ts";
import {
  checkSteps,
  UNDO_COLUMNS,
  UNDO_TABLES,
  type UndoRecord,
  type UndoState,
  type UndoTable,
  type UndoValue,
} from "../_shared/muse/undo.ts";

interface PgError {
  code?: string;
  message?: string;
}

function must(error: PgError | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message ?? "unknown error"}`);
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const optNum = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * The fence. A table and a set of columns, or an exception.
 *
 * `insert` is true when the columns being written are a whole new row rather than a
 * patch: a new bill carries `name`, `cadence`, `due_days` and more, none of which the
 * door ever UPDATES, so the column allowlist does not apply. The table allowlist still
 * does, and the inverse of an insert is a delete, which needs no per-column permission.
 */
function fence(table: string, columns: string[], insert: boolean): UndoTable {
  if (!(UNDO_TABLES as readonly string[]).includes(table)) {
    throw new Error(`muse-write: ${table} is not a table this door writes`);
  }
  const t = table as UndoTable;
  if (!insert) {
    for (const col of columns) {
      if (!UNDO_COLUMNS[t].includes(col)) {
        throw new Error(`muse-write: ${table}.${col} is not a column this door can put back`);
      }
    }
  }
  if (columns.length === 0) throw new Error(`muse-write: nothing to write to ${table}`);
  return t;
}

/**
 * The columns a row may carry on the way IN. An insert is not fenced by the undo
 * allowlist (its inverse is a delete), so it gets its own list — otherwise "insert a
 * row" would mean "write any column of any allowlisted table", and the door's whole
 * claim is that what it can do is a list you can read.
 */
const INSERT_COLUMNS: Record<UndoTable, readonly string[]> = {
  transactions: [
    "date",
    "amount",
    "type",
    "category_id",
    "description",
    "account_id",
    "applies_to",
    "person",
      // Carried on the way back in, or undoing a DELETE silently drops a
    // correction somebody made by hand — the row returns classified the way the app
    // works it out, which is the answer they had already overruled.
    "flow_override",
  ],
  recurring: ["name", "amount", "direction", "cadence", "category_id", "active", "due_days"],
  // Nothing inserts an account: they come from the bank or from the household seed.
  accounts: [],
  debts: ["name", "balance", "original_balance", "apr", "min_payment", "color"],
  paid_bills: ["month", "bill_key", "paid"],
  merchant_rules: ["pattern", "kind", "category_id", "bill_name"],
};

export function financeDb(admin: SupabaseClient): FinanceDb {

  /** One change out of muse_undo. `where` narrows the select; the two callers differ only
   *  in whether they ask by token or by "the newest undoable one", so the mapping and the
   *  step validation live here once. */
  async function readUndoRow(
    where: (q: ReturnType<ReturnType<typeof admin.from>["select"]>) => PromiseLike<{
      data: unknown;
      error: PgError | null;
    }>,
  ): Promise<UndoRecord | null> {
    const { data, error } = await where(admin.from("muse_undo").select("*"));
    must(error, "read muse_undo");
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (!row) return null;
    let steps;
    try {
      steps = checkSteps(row.steps);
    } catch {
      // A row whose inverse this door would not run is not a change it can offer to
      // undo. Reported as absent rather than as broken: the caller's next sentence is
      // "I cannot put that back", which is true either way.
      return null;
    }
    return {
      token: str(row.token),
      at: str(row.at),
      person: str(row.person),
      tool: str(row.tool),
      summary: str(row.summary),
      steps,
      state: str(row.state) as UndoState,
      undoneAt: optStr(row.undone_at),
      undoneBy: optStr(row.undone_by),
    };
  }

  return {
    // ── reads ───────────────────────────────────────────────────────────────
    async readCharge(id) {
      const { data, error } = await admin
        .from("transactions")
        .select(
          "id, date, amount, type, category_id, description, account_id, applies_to, splits, " +
            "anomaly_ack, needs_review, user_categorized, record_only, provider, status, created_at, person, " +
            // SELECTED, not just mapped. It was mapped below and missing here, so
            // readCharge reported flowOverride null for every row in the table —
            // including the four that had one. Two things broke quietly: set_flow's
            // "clear" could never fire, because the guard compared null to null and
            // called it "no correction on it already"; and every undo row recorded
            // `was: null`, so undoing a correction that REPLACED an earlier one wiped
            // it instead of putting it back. tests/dbSelectMapping.test.ts now fails
            // if any mapper in this file reads a column its select does not ask for.
            "flow_override",
        )
        .eq("id", id)
        .maybeSingle();
      must(error, "read transactions");
      if (!data) return null;
      const row: ChargeRow = {
        id: str(data.id),
        date: str(data.date),
        amount: num(data.amount),
        type: data.type === "income" ? "income" : "expense",
        categoryId: str(data.category_id),
        description: str(data.description),
        accountId: optStr(data.account_id),
        appliesTo: (data.applies_to ?? null) as UndoValue,
        flowOverride: optStr(data.flow_override),
        splits: (data.splits ?? null) as UndoValue,
        anomalyAck: !!data.anomaly_ack,
        needsReview: !!data.needs_review,
        userCategorized: !!data.user_categorized,
        recordOnly: !!data.record_only,
        provider: optStr(data.provider),
        pending: data.status === "pending",
        createdAt: str(data.created_at),
        person: optStr(data.person),
      };
      return row;
    },

    async readBill(id) {
      const { data, error } = await admin
        .from("recurring")
        .select("id, name, amount, direction, category_id, active, variable, known_amount, due_days, starts_on, ends_on, linked_debt_id, account_id")
        .eq("id", id)
        .maybeSingle();
      must(error, "read recurring");
      if (!data) return null;
      const row: BillRow = {
        id: str(data.id),
        name: str(data.name),
        amount: num(data.amount),
        direction: data.direction as BillRow["direction"],
        categoryId: optStr(data.category_id),
        active: !!data.active,
        variable: data.variable === true,
        knownAmount: optNum(data.known_amount),
        dueDays: Array.isArray(data.due_days) ? (data.due_days as number[]) : null,
        startsOn: optStr(data.starts_on),
        endsOn: optStr(data.ends_on),
        linkedDebtId: optStr(data.linked_debt_id),
        accountId: optStr(data.account_id),
      };
      return row;
    },

    async readAccount(id) {
      const { data, error } = await admin
        .from("accounts")
        // `owner` is load-bearing, not decoration: TWO accounts here are both called
        // "Adv SafeBalance Banking" — Xinyan's and the joint one — so a sentence
        // naming only the account does not say which. Pinning a bill to the wrong
        // one of those is exactly the mistake that hid a rent shortfall.
        .select("id, name, owner, balance, provider_account_id, last4")
        .eq("id", id)
        .maybeSingle();
      must(error, "read accounts");
      if (!data) return null;
      const row: AccountRow = {
        id: str(data.id),
        name: str(data.name),
        balance: num(data.balance),
        providerAccountId: optStr(data.provider_account_id),
        owner: str(data.owner),
        last4: optStr(data.last4),
      };
      return row;
    },

    async readDebt(id) {
      const { data, error } = await admin
        .from("debts")
        .select("id, name, balance, provider_account_id, track_pattern")
        .eq("id", id)
        .maybeSingle();
      must(error, "read debts");
      if (!data) return null;
      const row: DebtRow = {
        id: str(data.id),
        name: str(data.name),
        balance: num(data.balance),
        providerAccountId: optStr(data.provider_account_id),
        trackPattern: optStr(data.track_pattern),
      };
      return row;
    },

    async readMerchantRule(pattern) {
      const { data, error } = await admin
        .from("merchant_rules")
        .select("id, pattern, kind, category_id, bill_name")
        .eq("pattern", pattern)
        .maybeSingle();
      must(error, "read merchant_rules");
      if (!data) return null;
      const row: RuleRow = {
        id: str(data.id),
        pattern: str(data.pattern),
        kind: str(data.kind),
        categoryId: optStr(data.category_id),
        billName: optStr(data.bill_name),
      };
      return row;
    },

    async readPaidOverride(month, billKey) {
      const { data, error } = await admin
        .from("paid_bills")
        .select("id, paid")
        .eq("month", month)
        .eq("bill_key", billKey)
        .maybeSingle();
      must(error, "read paid_bills");
      if (!data) return null;
      const row: PaidOverrideRow = { id: str(data.id), paid: !!data.paid };
      return row;
    },

    async allBillNames() {
      // Counted as well as read. A list PostgREST truncated at 1,000 rows would make
      // the merchant-rule backstop say "that is not one of your bills" about a bill,
      // which is the exact hole the backstop exists to close.
      const { data, error, count } = await admin
        .from("recurring")
        .select("id, name, direction, active", { count: "exact" })
        .limit(LIST_CAP);
      must(error, "read recurring names");
      const rows = (data ?? []).map(
        (r): BillNameRow => ({
          id: str(r.id),
          name: str(r.name),
          direction: str(r.direction),
          active: !!r.active,
        }),
      );
      if (count !== null && count !== rows.length) {
        throw new Error(`read recurring names: ${count} rows exist and ${rows.length} came back`);
      }
      return rows;
    },

    async billPayments(recurringId) {
      // Filtered in the database on the json path, so a bill with ten payments reads
      // ten rows rather than the whole ledger. Counted on the SAME filter, for the
      // same reason as above: a truncated list would tell the cycle guard that nothing
      // is paying a cycle something is already paying, which is the $1,732 bug.
      const filter = () =>
        admin
          .from("transactions")
          .select("id, type, applies_to, flow_override", { count: "exact" })
          .eq("applies_to->>recurringId", recurringId);
      const { data, error, count } = await filter().limit(LIST_CAP);
      must(error, "read bill payments");
      const rows = (data ?? []).map(
        (r): BillPaymentRow => ({
          id: str(r.id),
          type: r.type === "income" ? "income" : "expense",
          appliesTo: (r.applies_to ?? null) as UndoValue,
          flowOverride: optStr(r.flow_override),
        }),
      );
      if (count !== null && count !== rows.length) {
        throw new Error(`read bill payments: ${count} rows exist and ${rows.length} came back`);
      }
      return rows;
    },

    async countDebtPayments(debtId) {
      const { count, error } = await admin
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("applies_to->>debtId", debtId);
      must(error, "count debt payments");
      if (count === null) throw new Error("count debt payments: no count returned");
      return count;
    },

    async bankSyncTimes() {
      // `select("*")` is not used here on purpose — this table holds the item_id,
      // the vault secret's NAME and the sync cursor, and none of them has any
      // business being read by a door. Two columns and an id.
      //
      // `refresh_requested_at` is asked for by name, so on a database where
      // schema_v39 has not been run PostgREST answers 42703 (undefined column)
      // rather than quietly returning rows without it. That is the RIGHT failure:
      // the tool turns it into "the database has not been set up for this yet"
      // instead of silently accepting a refresh request it cannot store.
      const { data, error } = await admin
        .from("bank_connections")
        .select("id, last_sync_at, refresh_requested_at");
      must(error, "read bank sync times");
      return (data ?? []).map((r) => ({
        id: String(r.id),
        lastSyncAt: typeof r.last_sync_at === "string" ? r.last_sync_at : null,
        refreshRequestedAt: typeof r.refresh_requested_at === "string" ? r.refresh_requested_at : null,
      }));
    },

    async requestBankRefresh(atISO) {
      // EVERY connection, deliberately. The tool takes no arguments: "check the bank"
      // is one instruction, and a per-connection version would need the door to hand
      // out connection ids and then be told which one — a choice nobody asking the
      // question has any way to make.
      //
      // `.not("id", "is", null)` is PostgREST's way of saying "all rows": an update
      // with no filter is refused by the client, which is a good default and the
      // wrong one here.
      const { data, error } = await admin
        .from("bank_connections")
        .update({ refresh_requested_at: atISO })
        .not("id", "is", null)
        .select("id");
      must(error, "request bank refresh");
      return (data ?? []).length;
    },

    // ── writes ──────────────────────────────────────────────────────────────
    async setColumns(table, id, patch, expect) {
      const t = fence(table, Object.keys(patch), false);
      fence(table, Object.keys(expect), false);
      const { nulls, values } = expectParts(expect);
      let q = admin.from(t).update(patch).eq("id", id);
      for (const col of nulls) q = q.is(col, null);
      for (const [col, want] of values) q = q.eq(col, want);
      // `.select("id")` is load-bearing, not decoration. An UPDATE whose WHERE matched
      // nothing comes back { error: null } with no rows, which is how the app once
      // reported a write that changed nothing as a success.
      const { data, error } = await q.select("id");
      must(error, `update ${table}`);
      return (data ?? []).length === 1 ? "ok" : "moved";
    },

    async insertRow(table, row) {
      const t = fence(table, Object.keys(row), true);
      for (const col of Object.keys(row)) {
        if (!INSERT_COLUMNS[t].includes(col)) {
          throw new Error(`muse-write: ${table}.${col} is not a column this door inserts`);
        }
      }
      const { data, error } = await admin.from(t).insert(row).select("id").single();
      must(error, `insert ${table}`);
      return String(data!.id);
    },

    async deleteRow(table, id, expect) {
      // `fence` refuses an empty column list, so a delete here can never be blind: it
      // always carries something it expects to find.
      const t = fence(table, Object.keys(expect), false);
      const { nulls, values } = expectParts(expect);
      let q = admin.from(t).delete().eq("id", id);
      for (const col of nulls) q = q.is(col, null);
      for (const [col, want] of values) q = q.eq(col, want);
      const { data, error } = await q.select("id");
      must(error, `delete ${table}`);
      return (data ?? []).length === 1 ? "ok" : "moved";
    },

    // ── the app's own money engine ───────────────────────────────────────────
    async applyMoneyEvent(ev: MoneyEvent) {
      // Every argument the RPC's fan-out takes is null here on purpose. The door adds
      // a plain cash charge: no debt, no goal, and no applies_to — so the RPC's clamp
      // and its `appliedAmount` stamp have nothing to do, and reverse_money_event's
      // inverse is exactly the cash it moved. Attaching a charge to a bill or a debt is
      // its own tool, with its own guard.
      const { data, error } = await admin.rpc("apply_money_event", {
        p_date: ev.date,
        p_amount: ev.amount,
        p_type: ev.type,
        p_category_id: ev.categoryId,
        p_description: ev.description,
        p_account_id: ev.accountId,
        p_debt_id: null,
        p_goal_id: null,
        p_applies_to: null,
      });
      must(error, "apply_money_event");
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.id) throw new Error("apply_money_event: no row came back");
      // `person` is not an argument the RPC takes, so it is stamped right after. It is
      // the column v36 added for exactly this: which person an assistant was acting for.
      const stamp = await admin.from("transactions").update({ person: ev.person }).eq("id", row.id);
      must(stamp.error, "stamp transactions.person");
      return String(row.id);
    },

    async reverseMoneyEvent(id) {
      // Checked first, because the RPC returns quietly when the row is gone — so
      // without this an undo of an already-deleted charge would report success.
      const { data, error } = await admin.from("transactions").select("id").eq("id", id).maybeSingle();
      must(error, "read transactions before reverse");
      if (!data) return "moved";
      const { error: rpcError } = await admin.rpc("reverse_money_event", { p_txn_id: id });
      must(rpcError, "reverse_money_event");
      return "ok";
    },

    async restoreMoneyEvent(row) {
      // The function returns NULL when a row with that id is already there, and does
      // nothing else — so a double restore cannot move cash twice.
      const { data, error } = await admin.rpc("restore_money_event", { p_row: row });
      must(error, "restore_money_event");
      const back = Array.isArray(data) ? data[0] : data;
      return back?.id ? "ok" : "moved";
    },

    // ── the change log ──────────────────────────────────────────────────────
    async recordChange(c: ChangeInsert) {
      const { error } = await admin.from("muse_undo").insert({
        token: c.token,
        person: c.person,
        tool: c.tool,
        summary: c.summary,
        steps: c.steps,
        state: "pending",
      });
      must(error, "insert muse_undo");
    },

    async setChangeState(token, state, at) {
      const patch: Record<string, unknown> = { state };
      if (at.undoneAt) patch.undone_at = at.undoneAt;
      if (at.undoneBy) patch.undone_by = at.undoneBy;
      const { error } = await admin.from("muse_undo").update(patch).eq("token", token);
      must(error, "update muse_undo");
    },

    findChange(person: Person, token: string) {
      // Fenced on the person as well as the token. Her key cannot reverse his write, which
      // is the same rule every other tool on this door follows.
      return readUndoRow((q) => q.eq("person", person).eq("token", token).maybeSingle());
    },

    latestUndoable(person: Person) {
      // What a bare "undo that" asks for. `state = 'undoable'` is what keeps it off a row
      // the door could not finish and off an undo's own row, which is born `undone`.
      return readUndoRow((q) =>
        q.eq("person", person).eq("state", "undoable").order("at", { ascending: false }).limit(1),
      );
    },
  };
}
