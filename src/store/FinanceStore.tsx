/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Account,
  AppData,
  AppliesTo,
  Debt,
  MerchantRule,
  PaidBill,
  Recurring,
  SavingsGoal,
  Transaction,
  TxnSplit,
} from "../types";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { todayISO } from "../lib/format";
import { DEFAULT_CATEGORIES } from "../lib/seed";
import { merchantKey } from "../lib/categorize";
import { SEED_ACCOUNTS, SEED_DEBTS, SEED_RECURRING } from "../lib/household";
import {
  type Food,
  loadCustomFoods,
  saveCustomFoods,
  clearCustomFoods,
} from "../lib/nutrition";

// --- DB row -> app model mappers --------------------------------------------
// Postgres numeric columns come back as strings, so amounts are Number()'d.
function mapTxn(r: any): Transaction {
  return {
    id: r.id,
    date: r.date,
    amount: Number(r.amount),
    type: r.type,
    categoryId: r.category_id,
    description: r.description ?? "",
    rawDescription: r.raw_description ?? undefined,
    account: r.account ?? undefined,
    accountId: r.account_id ?? undefined,
    appliesTo: r.applies_to ?? undefined,
    splits: Array.isArray(r.splits) && r.splits.length ? r.splits : undefined,
    anomalyAck: !!r.anomaly_ack,
    pending: r.status === "pending",
    createdAt: r.created_at,
  };
}
function mapDebt(r: any): Debt {
  return {
    id: r.id,
    name: r.name,
    balance: Number(r.balance),
    originalBalance: Number(r.original_balance),
    apr: r.apr != null ? Number(r.apr) : undefined,
    minPayment: r.min_payment != null ? Number(r.min_payment) : undefined,
    color: r.color,
    providerAccountId: r.provider_account_id ?? undefined,
    trackPattern: r.track_pattern ?? undefined,
    trackedBaseline: r.tracked_baseline != null ? Number(r.tracked_baseline) : undefined,
    trackedSince: r.tracked_since ?? undefined,
    createdAt: r.created_at,
  };
}
function mapGoal(r: any): SavingsGoal {
  return {
    id: r.id,
    name: r.name,
    saved: Number(r.saved),
    target: Number(r.target),
    icon: r.icon,
    color: r.color,
    createdAt: r.created_at,
  };
}
function mapAccount(r: any): Account {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    last4: r.last4 ?? undefined,
    type: r.type,
    balance: Number(r.balance),
    sortOrder: r.sort_order ?? 0,
    providerAccountId: r.provider_account_id ?? undefined,
    pendingHold: Number(r.pending_hold ?? 0),
    createdAt: r.created_at,
  };
}
function mapRecurring(r: any): Recurring {
  return {
    id: r.id,
    name: r.name,
    amount: Number(r.amount),
    direction: r.direction,
    cadence: r.cadence,
    categoryId: r.category_id ?? undefined,
    accountId: r.account_id ?? undefined,
    toAccountId: r.to_account_id ?? undefined,
    owner: r.owner ?? undefined,
    active: r.active,
    variable: r.variable ?? false,
    note: r.note ?? undefined,
    dueDays: r.due_days ?? undefined,
    anchorDate: r.anchor_date ?? undefined,
    startsOn: r.starts_on ?? undefined,
    endsOn: r.ends_on ?? undefined,
    knownAmount: r.known_amount != null ? Number(r.known_amount) : undefined,
    linkedDebtId: r.linked_debt_id ?? undefined,
    createdAt: r.created_at,
  };
}

function mapPaidBill(r: any): PaidBill {
  return {
    id: r.id,
    month: r.month,
    billKey: r.bill_key,
    paid: r.paid,
  };
}

function mapMerchantRule(r: any): MerchantRule {
  return {
    id: r.id,
    pattern: r.pattern,
    kind: r.kind,
    categoryId: r.category_id ?? undefined,
    billName: r.bill_name ?? undefined,
    createdAt: r.created_at,
  };
}

function mapFood(r: any): Food {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    kcal: Number(r.kcal),
    p: Number(r.p),
    c: Number(r.c),
    f: Number(r.f),
    serving: r.serving != null ? Number(r.serving) : undefined,
    note: r.note ?? undefined,
    barcode: r.barcode ?? undefined,
    custom: true,
  };
}
function foodToRow(f: Omit<Food, "id" | "custom">) {
  return {
    name: f.name,
    role: f.role,
    kcal: f.kcal,
    p: f.p,
    c: f.c,
    f: f.f,
    serving: f.serving ?? null,
    note: f.note ?? null,
    barcode: f.barcode ?? null,
  };
}

const IMPOSSIBLE_ID = "00000000-0000-0000-0000-000000000000";

// ── refetch sequencing ───────────────────────────────────────────────────────
// Realtime fires one event per changed ROW, so a 20-row Plaid sync used to
// issue 20 overlapping full-table SELECTs. HTTP responses do NOT come back in
// issue order on a phone, and every loader replaces the whole array, so a
// snapshot captured BEFORE the last inserts could resolve LAST and overwrite
// newer state. Nothing re-fires afterwards, so the wrong totals stuck for the
// rest of the session. The old `active` flag only guarded unmount, never
// staleness.
//
// Each table carries a monotonic ticket. A reader claims one before its SELECT
// and applies the result only while that ticket is still the newest claim. An
// optimistic WRITER claims one too — that is what stops a SELECT issued before
// a local edit from resolving after it and restoring the pre-edit value.
type SyncTable =
  | "transactions"
  | "debts"
  | "savings_goals"
  | "accounts"
  | "recurring"
  | "paid_bills"
  | "merchant_rules"
  | "foods";
type TicketMap = Partial<Record<SyncTable, number>>;

/** Take the newest ticket for a table; every older in-flight read is now stale. */
function claimTicket(m: TicketMap, table: SyncTable): number {
  const next = (m[table] ?? 0) + 1;
  m[table] = next;
  return next;
}
/** True while `ticket` is still the newest claim — i.e. this read may be applied. */
function isNewest(m: TicketMap, table: SyncTable, ticket: number): boolean {
  return m[table] === ticket;
}
/** A local (optimistic) write outranks every read already in flight. */
function invalidate(m: TicketMap, ...tables: SyncTable[]): void {
  for (const table of tables) claimTicket(m, table);
}

/** Trailing-edge window that folds a burst of realtime events into one refetch. */
const REFETCH_DEBOUNCE_MS = 250;

export interface FinanceStore {
  data: AppData;
  loading: boolean;
  addTransaction: (t: Omit<Transaction, "id" | "createdAt">) => Promise<void>;
  deleteTransaction: (id: string) => Promise<void>;
  setTransactionCategory: (id: string, categoryId: string) => Promise<void>;
  // Split one transaction across categories (or pass null to clear the split).
  setTransactionSplits: (id: string, splits: TxnSplit[] | null) => Promise<void>;
  // Dismiss the "unusual purchase" flag for a transaction (it won't reappear).
  acknowledgeAnomaly: (id: string) => Promise<void>;
  excludeFromBudget: (id: string) => Promise<void>;
  // Set a real purchase aside: visible in totals/history but out of the variable
  // budget. "reimbursable" is tracked as owed-back-to-you until a credit settles it.
  setAsideTransaction: (id: string, reason: "excluded" | "reimbursable", note?: string) => Promise<void>;
  // Mark a reimbursable as paid back — clears the "owed to you" marker. Pass the
  // payback credit's id to link the two (auto-suggest); omit for a manual "got it back".
  settleReimbursable: (reimbursableId: string, creditTxnId?: string) => Promise<void>;
  // Undo a settle — re-open the reimbursable as owed and free its payback credit.
  unsettleReimbursable: (reimbursableId: string) => Promise<void>;
  makeRecurringBill: (txnId: string, cadence: "monthly" | "yearly") => Promise<void>;
  setRecurringVariable: (id: string, variable: boolean) => Promise<void>;
  // Reconcile an account to the real bank figure. Resolves TRUE only when the
  // DB confirms the row changed — false means the value is still local-only, and
  // the caller must keep its editor open rather than pretend the save landed.
  setAccountBalance: (accountId: string, balance: number) => Promise<boolean>;
  addDebt: (d: {
    name: string;
    balance: number;
    apr?: number;
    minPayment?: number;
    color: string;
  }) => Promise<void>;
  // Connect a credit-card account to a debt so its balance auto-syncs from the bank.
  linkDebtToCard: (debtId: string, accountId: string) => Promise<void>;
  unlinkDebtCard: (debtId: string) => Promise<void>;
  createDebtFromCard: (accountId: string) => Promise<void>;
  seedHousehold: () => Promise<{ ok: boolean; message: string }>;
  resetAll: () => Promise<void>;
  setPaidBill: (month: string, billKey: string, paid: boolean) => Promise<void>;
  // Pipelined money events — one action moves cash + ledger + (debt/goal).
  payBill: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
    fromAccountId?: string,
  ) => Promise<void>;
  // A reconciliation marker: record a bill as already paid (already reflected in
  // the bank-anchored balance). Moves no cash and touches no debt.
  markBillPaid: (
    recurringId: string,
    monthKey: string,
    amount: number,
    day?: number,
  ) => Promise<void>;
  // Batch-insert classified statement rows. Like markBillPaid, these are history
  // already in the anchored balance — they never move cash or a debt.
  commitImport: (
    items: {
      date: string;
      amount: number;
      categoryId: string;
      description: string;
      appliesTo?: AppliesTo;
    }[],
    accountId?: string,
  ) => Promise<{ ok: boolean; count: number }>;
  // Teach the categorizer: upsert a learned rule for a merchant pattern.
  saveMerchantRule: (rule: {
    pattern: string;
    kind: "variable" | "skip" | "bill";
    categoryId?: string;
    billName?: string;
  }) => Promise<void>;
  // Shared food library for the meal builder (Supabase when set up, else local).
  addFood: (food: Omit<Food, "id" | "custom">) => Promise<void>;
  deleteFood: (id: string) => Promise<void>;
}

const Ctx = createContext<FinanceStore | null>(null);

export function FinanceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>({
    transactions: [],
    debts: [],
    goals: [],
    categories: DEFAULT_CATEGORIES,
    accounts: [],
    recurring: [],
    paidBills: [],
    merchantRules: [],
    foods: [],
  });
  const [loading, setLoading] = useState(true);

  // Latest data for actions that read-modify-write.
  const dataRef = useRef(data);
  dataRef.current = data;
  // True once the `foods` table is reachable; false → fall back to localStorage.
  const foodsSynced = useRef(false);
  const migrationDone = useRef(false);
  // Resolves when the initial foods load finishes, so add/delete never run
  // against an undetermined sync mode.
  const foodsReady = useRef<Promise<void> | null>(null);
  // Per-table refetch tickets (see claimTicket). Deliberately lives on the
  // provider, not inside the effect, so the effect's loaders, resyncLedger and
  // every optimistic writer are ordered against EACH OTHER — resyncLedger fires
  // its own four SELECTs outside the effect and would otherwise be a third,
  // unsequenced racer.
  const seq = useRef<TicketMap>({});

  // Initial load + live sync. Any change (from either device) refetches the
  // affected table so both screens stay in step.
  useEffect(() => {
    let active = true;

    // Every loader claims a ticket BEFORE its SELECT and applies the rows only
    // if that ticket is still the newest (see claimTicket). `active` alone only
    // guarded unmount, never staleness.
    async function loadTransactions() {
      const ticket = claimTicket(seq.current, "transactions");
      const { data: rows } = await supabase
        .from("transactions")
        .select("*")
        .order("date", { ascending: false })
        .order("created_at", { ascending: false });
      if (active && isNewest(seq.current, "transactions", ticket)) {
        setData((p) => ({ ...p, transactions: (rows ?? []).map(mapTxn) }));
      }
    }
    async function loadDebts() {
      const ticket = claimTicket(seq.current, "debts");
      const { data: rows } = await supabase
        .from("debts")
        .select("*")
        .order("created_at", { ascending: true });
      if (active && isNewest(seq.current, "debts", ticket))
        setData((p) => ({ ...p, debts: (rows ?? []).map(mapDebt) }));
    }
    async function loadGoals() {
      const ticket = claimTicket(seq.current, "savings_goals");
      const { data: rows } = await supabase
        .from("savings_goals")
        .select("*")
        .order("created_at", { ascending: true });
      if (active && isNewest(seq.current, "savings_goals", ticket))
        setData((p) => ({ ...p, goals: (rows ?? []).map(mapGoal) }));
    }
    async function loadAccounts() {
      const ticket = claimTicket(seq.current, "accounts");
      const { data: rows } = await supabase
        .from("accounts")
        .select("*")
        .order("sort_order", { ascending: true });
      if (active && isNewest(seq.current, "accounts", ticket))
        setData((p) => ({ ...p, accounts: (rows ?? []).map(mapAccount) }));
    }
    async function loadRecurring() {
      const ticket = claimTicket(seq.current, "recurring");
      const { data: rows } = await supabase
        .from("recurring")
        .select("*")
        .order("created_at", { ascending: true });
      if (active && isNewest(seq.current, "recurring", ticket))
        setData((p) => ({ ...p, recurring: (rows ?? []).map(mapRecurring) }));
    }
    async function loadPaidBills() {
      const ticket = claimTicket(seq.current, "paid_bills");
      const { data: rows } = await supabase.from("paid_bills").select("*");
      if (active && isNewest(seq.current, "paid_bills", ticket))
        setData((p) => ({ ...p, paidBills: (rows ?? []).map(mapPaidBill) }));
    }
    async function loadMerchantRules() {
      const ticket = claimTicket(seq.current, "merchant_rules");
      const { data: rows } = await supabase.from("merchant_rules").select("*");
      if (active && isNewest(seq.current, "merchant_rules", ticket))
        setData((p) => ({ ...p, merchantRules: (rows ?? []).map(mapMerchantRule) }));
    }
    async function loadFoods() {
      let ticket = claimTicket(seq.current, "foods");
      const { data: rows, error } = await supabase
        .from("foods")
        .select("*")
        .order("created_at", { ascending: true });
      if (!active || !isNewest(seq.current, "foods", ticket)) return;
      if (error) {
        // `foods` table not created yet → fall back to this device's localStorage.
        foodsSynced.current = false;
        setData((p) => ({ ...p, foods: loadCustomFoods() }));
        return;
      }
      foodsSynced.current = true;
      const dbFoods = (rows ?? []).map(mapFood);

      // One-time migration: lift any local foods not already in the cloud up to
      // Supabase, then drop the local copy. Runs once per session, and clears
      // localStorage ONLY after the insert is confirmed — a failed insert must
      // never erase the user's foods.
      if (!migrationDone.current) {
        const local = loadCustomFoods();
        const missing = local.filter(
          (l) =>
            !dbFoods.some((d) =>
              l.barcode
                ? d.barcode === l.barcode
                : d.name.toLowerCase() === l.name.toLowerCase(),
            ),
        );
        if (missing.length) {
          const { error: insErr } = await supabase
            .from("foods")
            .insert(missing.map(foodToRow));
          if (insErr) {
            // Keep localStorage intact; show local + cloud merged, retry next load.
            console.error("Food library migration failed:", insErr);
            if (active && isNewest(seq.current, "foods", ticket))
              setData((p) => ({ ...p, foods: [...dbFoods, ...loadCustomFoods()] }));
            return;
          }
          clearCustomFoods();
          migrationDone.current = true;
          // Fresh read after the migration insert → fresh ticket, so a load that
          // started later still wins over this one.
          ticket = claimTicket(seq.current, "foods");
          const { data: rows2 } = await supabase
            .from("foods")
            .select("*")
            .order("created_at", { ascending: true });
          if (active && isNewest(seq.current, "foods", ticket))
            setData((p) => ({ ...p, foods: (rows2 ?? []).map(mapFood) }));
          return;
        }
        migrationDone.current = true;
      }
      setData((p) => ({ ...p, foods: dbFoods }));
    }

    const foodsPromise = loadFoods();
    foodsReady.current = foodsPromise;
    Promise.all([
      loadTransactions(),
      loadDebts(),
      loadGoals(),
      loadAccounts(),
      loadRecurring(),
      loadPaidBills(),
      loadMerchantRules(),
      foodsPromise,
    ]).finally(() => {
      if (active) setLoading(false);
    });

    // Realtime delivers one event per changed ROW: a Plaid sync that inserts 20
    // transactions used to mean 20 full-table refetches racing each other.
    // Coalesce a burst into a single trailing refetch per table.
    const bursts = new Map<SyncTable, ReturnType<typeof setTimeout>>();
    const refetch = (table: SyncTable, load: () => void) => {
      const pending = bursts.get(table);
      if (pending) clearTimeout(pending);
      bursts.set(
        table,
        setTimeout(() => {
          bursts.delete(table);
          if (active) load();
        }, REFETCH_DEBOUNCE_MS),
      );
    };

    // Re-anchor every table from the server. Safe to call at any time — the
    // tickets make a redundant round of reads harmless.
    const refetchAll = () => {
      loadTransactions();
      loadDebts();
      loadGoals();
      loadAccounts();
      loadRecurring();
      loadPaidBills();
      loadMerchantRules();
      loadFoods();
    };

    const channel = supabase
      .channel("homebase-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "transactions" },
        () => refetch("transactions", loadTransactions),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "debts" },
        () => refetch("debts", loadDebts),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "savings_goals" },
        () => refetch("savings_goals", loadGoals),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "accounts" },
        () => refetch("accounts", loadAccounts),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "recurring" },
        () => refetch("recurring", loadRecurring),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "paid_bills" },
        () => refetch("paid_bills", loadPaidBills),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "merchant_rules" },
        () => refetch("merchant_rules", loadMerchantRules),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "foods" },
        () => refetch("foods", loadFoods),
      )
      .subscribe((status) => {
        // The SELECTs above are issued BEFORE the websocket JOIN completes, so
        // anything the other phone wrote inside that window was in neither the
        // snapshot nor the event stream — it never arrived, for the whole
        // session. Re-anchoring on every SUBSCRIBED closes that window, and
        // because realtime-js reconnects on its own after a background or
        // network flap, the same callback heals a dropped channel too.
        //
        // Deliberately NOT resubscribing by hand on CHANNEL_ERROR/TIMED_OUT:
        // the client already retries with backoff and re-auths on reconnect, so
        // a hand-rolled retry would only race it into duplicate channels. Log
        // it, and let the rejoin's SUBSCRIBED do the recovery.
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) refetchAll();
        else
          console.warn(
            `homebase-sync realtime ${status} — live updates paused until it rejoins`,
          );
      });

    // Backstop for the installed PWA: phones freeze a backgrounded tab and can
    // drop the socket without any status callback firing, so pull fresh state
    // whenever the app comes back to the foreground. (UpdatePrompt has its own
    // visibilitychange listener, but it only checks the service worker.)
    const onVisible = () => {
      if (document.visibilityState === "visible") refetchAll();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      for (const timer of bursts.values()) clearTimeout(timer);
      bursts.clear();
      supabase.removeChannel(channel);
    };
  }, []);

  type Actions = Omit<FinanceStore, "data" | "loading">;
  const store = useMemo<Actions>(() => {
    // Fail-closed recovery: if a money write partially fails, pull the ledger
    // tables back from the server so the UI can never keep an optimistic value
    // that did not actually persist (the deleteFood refetch-on-error pattern).
    const resyncLedger = async () => {
      // These four SELECTs live outside the sync effect, so they must claim the
      // SAME per-table tickets the loaders use — otherwise resync is a third
      // unsequenced racer and can either clobber, or be clobbered by, a realtime
      // refetch issued at the same moment.
      const tTx = claimTicket(seq.current, "transactions");
      const tAc = claimTicket(seq.current, "accounts");
      const tDe = claimTicket(seq.current, "debts");
      const tGo = claimTicket(seq.current, "savings_goals");
      const [tx, ac, de, go] = await Promise.all([
        supabase.from("transactions").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
        supabase.from("accounts").select("*").order("sort_order", { ascending: true }),
        supabase.from("debts").select("*").order("created_at", { ascending: true }),
        supabase.from("savings_goals").select("*").order("created_at", { ascending: true }),
      ]);
      setData((p) => ({
        ...p,
        transactions:
          tx.data && isNewest(seq.current, "transactions", tTx) ? tx.data.map(mapTxn) : p.transactions,
        accounts:
          ac.data && isNewest(seq.current, "accounts", tAc) ? ac.data.map(mapAccount) : p.accounts,
        debts: de.data && isNewest(seq.current, "debts", tDe) ? de.data.map(mapDebt) : p.debts,
        goals: go.data && isNewest(seq.current, "savings_goals", tGo) ? go.data.map(mapGoal) : p.goals,
      }));
    };

    // The engine: every money event runs through here. It ALWAYS inserts a
    // ledger row and moves the account's cash, then fans out to a debt (an
    // explicit debt payment, or a bill whose recurring row is linkedDebtId) or
    // a goal. This is the single pipeline that keeps every number in step.
    const applyMoneyEvent = async (ev: {
      accountId?: string;
      amount: number;
      type: "income" | "expense";
      categoryId: string;
      description: string;
      appliesTo?: AppliesTo;
      // Manual entry can be back-dated; everything else stamps today.
      date?: string;
    }) => {
      // todayISO() is the LOCAL calendar date. This was
      // `new Date().toISOString().slice(0, 10)` — UTC — so every event logged
      // after 5pm Arizona time was filed under tomorrow, landing in the wrong
      // month's budget and the wrong pay cycle.
      const date = ev.date ?? todayISO();

      // Resolve the debt this event pays (explicit, or a bill's linked card) and
      // the EXACT amount that will come off it — BEFORE writing the row. We store
      // that applied delta on the ledger entry so deleting the event reverses
      // precisely what it did (a payment that clears a debt comes off by less
      // than its full amount; the reverse must add back that same lesser amount).
      const at = ev.appliesTo;
      let debtId = at?.debtId;
      if (!debtId && at?.kind === "bill" && at.recurringId) {
        debtId = dataRef.current.recurring.find((r) => r.id === at.recurringId)?.linkedDebtId;
      }
      const debt = debtId
        ? dataRef.current.debts.find((d) => d.id === debtId)
        : undefined;

      // AUTO-TRACKED debts (a bank-linked card, or a feed-tracked debt like
      // Affirm / Mom-China) update themselves from the bank feed — the card
      // trigger SETs the balance, the feed recompute SETs the tracked ones, and
      // the cash side comes from bank truth. Writing them optimistically here
      // would double-count (debt decremented twice + cash double-debited), so
      // this money event is a NO-OP: just let the feed do it.
      if (debt && (debt.providerAccountId || debt.trackPattern)) {
        return;
      }

      const debtApplied = debt ? Math.min(ev.amount, debt.balance) : 0;

      // Stamp the RESOLVED debtId (a bill's `at` carries only recurringId; the
      // debt is resolved from the recurring's linkedDebtId above). Without it the
      // reverse RPC's `applies_to ? 'debtId'` check never fires for a bill payment,
      // so deleting it would restore the debt in the UI but never in the DB.
      const appliesTo: AppliesTo | undefined =
        at && debt ? { ...at, debtId, appliedAmount: debtApplied } : at;

      const { data: row, error } = await supabase.rpc("apply_money_event", {
        p_date: date,
        p_amount: ev.amount,
        p_type: ev.type,
        p_category_id: ev.categoryId,
        p_description: ev.description,
        p_account_id: ev.accountId ?? null,
        p_debt_id: debtId ?? null,
        p_goal_id: at?.kind === "goal" ? at.goalId ?? null : null,
        p_applies_to: appliesTo ?? null,
      });
      if (error || !row) {
        console.error("apply_money_event failed — resyncing to server truth", error);
        await resyncLedger();
        return;
      }
      // The RPC inserted the ledger row AND moved cash/debt/goal in ONE
      // transaction; mirror it locally for instant UI (realtime reconciles).
      // Outrank any SELECT already in flight, or one issued before this write
      // could resolve after it and drop the new row back out of view.
      invalidate(seq.current, "transactions", "accounts", "debts", "savings_goals");
      setData((p) => ({
        ...p,
        transactions: [mapTxn(row), ...p.transactions],
        accounts: ev.accountId
          ? p.accounts.map((a) =>
              a.id === ev.accountId
                ? { ...a, balance: a.balance + (ev.type === "income" ? ev.amount : -ev.amount) }
                : a,
            )
          : p.accounts,
        debts:
          debt && debtId
            ? p.debts.map((d) =>
                d.id === debtId ? { ...d, balance: Math.max(0, d.balance - debtApplied) } : d,
              )
            : p.debts,
        goals:
          at?.kind === "goal" && at.goalId
            ? p.goals.map((g) =>
                g.id === at.goalId ? { ...g, saved: g.saved + ev.amount } : g,
              )
            : p.goals,
      }));
    };

    return {
      async payBill(recurringId, monthKey, amount, day, fromAccountId) {
        const rec = dataRef.current.recurring.find((r) => r.id === recurringId);
        if (!rec) return;
        await applyMoneyEvent({
          accountId: fromAccountId ?? rec.accountId,
          amount,
          type: "expense",
          categoryId: rec.categoryId ?? "other",
          description: rec.name,
          appliesTo: { kind: "bill", recurringId, monthKey, day },
        });
      },
      async markBillPaid(recurringId, monthKey, amount, day) {
        const rec = dataRef.current.recurring.find((r) => r.id === recurringId);
        if (!rec) return;
        // A settled marker only records paid-state. No cash moves (account null),
        // no debt fan-out — the payment is already in your anchored balance.
        // LOCAL date, not UTC: marking a bill paid at 8pm on the 31st used to
        // stamp the 1st and file the marker into the following month.
        const date = todayISO();
        const { data: row, error } = await supabase
          .from("transactions")
          .insert({
            date,
            amount,
            type: "expense",
            category_id: rec.categoryId ?? "other",
            description: rec.name + " (already paid)",
            account_id: null,
            applies_to: { kind: "bill", recurringId, monthKey, day, settled: true },
          })
          .select()
          .single();
        if (error || !row) return console.error(error);
        invalidate(seq.current, "transactions");
        setData((p) => ({ ...p, transactions: [mapTxn(row), ...p.transactions] }));
      },
      async commitImport(items, accountId) {
        if (!items.length) return { ok: true, count: 0 };
        const rows = items.map((it) => ({
          date: it.date,
          amount: it.amount,
          type: "expense" as const,
          category_id: it.categoryId,
          description: it.description,
          // Tag which account the statement was for — display + per-person
          // activity. Settled bill-markers stay account-less (they move no
          // cash). Imported rows are records only; no balance moves.
          account_id: it.appliesTo?.settled ? null : accountId ?? null,
          applies_to: it.appliesTo ?? null,
        }));
        const { data: inserted, error } = await supabase
          .from("transactions")
          .insert(rows)
          .select();
        if (error) {
          console.error(error);
          return { ok: false, count: 0 };
        }
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: [...(inserted ?? []).map(mapTxn), ...p.transactions],
        }));
        return { ok: true, count: inserted?.length ?? 0 };
      },
      async saveMerchantRule(rule) {
        // BACKSTOP: never learn a "this is ordinary spending" or "skip this"
        // rule for a merchant that is one of our BILLS. A learned rule outranks
        // every built-in rule (categorize.ts), so such a rule permanently
        // re-teaches the feed: `variable` starts counting a fixed bill against
        // the variable envelope, and `skip` is worse still — the feed drops the
        // charge entirely and a real payment never enters the ledger at all.
        //
        // Each sheet that writes a rule is supposed to gate on the row being
        // unlinked, and three call sites need that guard. Two of them didn't
        // have it. So the invariant lives HERE too, where it cannot be forgotten
        // by the next screen that learns a rule — including the import
        // clarify-card path, which has no transaction in hand to check.
        if (rule.kind !== "bill") {
          const isBillMerchant = dataRef.current.recurring.some(
            (r) => r.active && r.direction === "out" && merchantKey(r.name) === rule.pattern,
          );
          if (isBillMerchant) {
            console.warn(
              `saveMerchantRule: refusing to learn kind="${rule.kind}" for "${rule.pattern}" — it matches the recurring bill of the same name.`,
            );
            return;
          }
        }
        const row = {
          pattern: rule.pattern,
          kind: rule.kind,
          category_id: rule.categoryId ?? null,
          bill_name: rule.billName ?? null,
        };
        // Optimistic: replace any existing rule for this merchant.
        invalidate(seq.current, "merchant_rules");
        setData((p) => ({
          ...p,
          merchantRules: [
            ...p.merchantRules.filter((r) => r.pattern !== rule.pattern),
            { id: `tmp-${rule.pattern}`, createdAt: "", ...rule },
          ],
        }));
        const { data: saved, error } = await supabase
          .from("merchant_rules")
          .upsert(row, { onConflict: "pattern" })
          .select()
          .single();
        if (error) return console.error(error);
        if (saved) {
          invalidate(seq.current, "merchant_rules");
          setData((p) => ({
            ...p,
            merchantRules: [
              ...p.merchantRules.filter((r) => r.pattern !== rule.pattern),
              mapMerchantRule(saved),
            ],
          }));
        }
      },
      async addFood(food) {
        await foodsReady.current;
        if (!foodsSynced.current) {
          const f: Food = { ...food, id: `c-${Date.now()}`, custom: true };
          saveCustomFoods([...loadCustomFoods(), f]);
          invalidate(seq.current, "foods");
          setData((p) => ({ ...p, foods: [...p.foods, f] }));
          return;
        }
        const { data: row, error } = await supabase
          .from("foods")
          .insert(foodToRow(food))
          .select()
          .single();
        if (error || !row) return console.error(error);
        invalidate(seq.current, "foods");
        setData((p) => ({ ...p, foods: [...p.foods, mapFood(row)] }));
      },
      async deleteFood(id) {
        await foodsReady.current;
        invalidate(seq.current, "foods");
        setData((p) => ({ ...p, foods: p.foods.filter((x) => x.id !== id) }));
        if (!foodsSynced.current) {
          saveCustomFoods(loadCustomFoods().filter((x) => x.id !== id));
          return;
        }
        const { error } = await supabase.from("foods").delete().eq("id", id);
        if (error) {
          // Delete failed → restore truth from the cloud so the UI doesn't lie.
          console.error(error);
          const ticket = claimTicket(seq.current, "foods");
          const { data: rows } = await supabase
            .from("foods")
            .select("*")
            .order("created_at", { ascending: true });
          if (isNewest(seq.current, "foods", ticket))
            setData((p) => ({ ...p, foods: (rows ?? []).map(mapFood) }));
        }
      },
      async addTransaction(t) {
        // Manual entry is a money event like any other, so it goes down the SAME
        // atomic pipeline as payBill/markSent: one server-side transaction that
        // inserts the ledger row and moves cash with a RELATIVE delta
        // (balance = balance + x).
        //
        // It used to insert the row, then read the account balance out of client
        // state and write back an ABSOLUTE number. Two phones adding a charge in
        // the same second each read the same pre-write balance and each wrote
        // their own snapshot minus their own amount — so one of the two charges
        // vanished from cash permanently. Nothing self-corrected, because the
        // written value was absolute: the next refetch simply re-read the wrong
        // number. A Plaid sync SETting the balance from bank truth between the
        // read and the write lost money the same way on a single device.
        //
        // The legacy free-text `account` column is dropped on this path — the
        // RPC does not carry it, no caller sets it, and nothing in the app reads
        // Transaction.account (account_id is what every screen uses).
        await applyMoneyEvent({
          date: t.date, // manual entry may be back-dated; don't stamp today
          accountId: t.accountId,
          amount: t.amount,
          type: t.type,
          categoryId: t.categoryId,
          description: t.description,
        });
      },
      async deleteTransaction(id) {
        const txn = dataRef.current.transactions.find((x) => x.id === id);
        // optimistic remove
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.filter((x) => x.id !== id),
        }));
        const { error } = await supabase.rpc("reverse_money_event", { p_txn_id: id });
        if (error) {
          console.error("reverse_money_event failed — resyncing to server truth", error);
          await resyncLedger();
          return;
        }
        // The RPC deleted the row AND undid its fan-out in ONE transaction;
        // mirror the reversal locally (settled / imported rows moved nothing).
        if (txn) {
          const at = txn.appliesTo;
          let debtId = at?.debtId;
          if (!debtId && at?.kind === "bill" && at.recurringId) {
            debtId = dataRef.current.recurring.find((r) => r.id === at.recurringId)?.linkedDebtId;
          }
          // Auto-tracked debts (bank-linked card or feed pattern) reconcile from the
          // feed; reverse_money_event skips them, so the optimistic restore must too.
          const rdebt = debtId ? dataRef.current.debts.find((d) => d.id === debtId) : undefined;
          const debtAutoTracked = !!rdebt && (!!rdebt.providerAccountId || !!rdebt.trackPattern);
          const back = at?.appliedAmount ?? txn.amount;
          invalidate(seq.current, "accounts", "debts", "savings_goals");
          setData((p) => ({
            ...p,
            // A settled row moved no cash (reverse_money_event short-circuits on
            // settled), so deleting it must NOT touch the balance — mirror that
            // here exactly like the debt/goal branches below, or the in-app cash
            // drifts from server truth until the next sync re-anchors it.
            accounts: txn.accountId && !at?.settled
              ? p.accounts.map((a) =>
                  a.id === txn.accountId
                    ? {
                        ...a,
                        balance: a.balance + (txn.type === "income" ? -txn.amount : txn.amount),
                      }
                    : a,
                )
              : p.accounts,
            debts:
              !at?.settled && debtId && !debtAutoTracked
                ? p.debts.map((d) =>
                    d.id === debtId ? { ...d, balance: d.balance + back } : d,
                  )
                : p.debts,
            goals:
              !at?.settled && at?.kind === "goal" && at.goalId
                ? p.goals.map((g) =>
                    g.id === at.goalId ? { ...g, saved: Math.max(0, g.saved - txn.amount) } : g,
                  )
                : p.goals,
          }));
        }
      },
      async setTransactionCategory(id, categoryId) {
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === id ? { ...t, categoryId } : t,
          ),
        }));
        // user_categorized marks this as a HUMAN decision, so a later re-sync
        // refreshes auto-guesses around it but never overwrites this one.
        const { error } = await supabase
          .from("transactions")
          .update({ category_id: categoryId, user_categorized: true })
          .eq("id", id);
        if (error) console.error(error);
      },
      async setTransactionSplits(id, splits) {
        // Allocate this charge across categories. The cash + amount don't change —
        // only how budgets bucket it. Clearing (null) drops back to one category.
        // The primary categoryId follows the largest slice so the row's color/icon
        // stays sensible. A 1-slice split is just a normal single-category txn.
        const clean = splits?.filter((s) => s.categoryId && s.amount > 0) ?? null;
        const useSplits = clean && clean.length > 1 ? clean : null;
        const primary = useSplits
          ? [...useSplits].sort((a, b) => b.amount - a.amount)[0].categoryId
          : clean && clean.length === 1
            ? clean[0].categoryId
            : undefined;
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === id
              ? { ...t, splits: useSplits ?? undefined, categoryId: primary ?? t.categoryId }
              : t,
          ),
        }));
        // Splitting is a human call on where this money belongs — protect it from
        // being re-guessed on the next sync.
        const update: Record<string, unknown> = { splits: useSplits, user_categorized: true };
        if (primary) update.category_id = primary;
        const { error } = await supabase.from("transactions").update(update).eq("id", id);
        if (error) console.error(error);
      },
      async acknowledgeAnomaly(id) {
        // dismiss the unusual-purchase flag; optimistic + persisted so it never
        // re-flags this charge (on this or the other phone).
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) => (t.id === id ? { ...t, anomalyAck: true } : t)),
        }));
        const { error } = await supabase.from("transactions").update({ anomaly_ack: true }).eq("id", id);
        if (error) console.error(error);
      },
      async excludeFromBudget(id) {
        // Mark a one-off (a travel/remittance anomaly) as a transfer so it drops
        // out of the variable-budget gate (type expense && !appliesTo) — without
        // deleting the record or touching any balance.
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === id ? { ...t, appliesTo: { kind: "transfer" } } : t,
          ),
        }));
        const { error } = await supabase
          .from("transactions")
          .update({ applies_to: { kind: "transfer" } })
          .eq("id", id);
        if (error) console.error(error);
      },
      async setAsideTransaction(id, reason, note) {
        // A real purchase set aside: out of the variable budget but VISIBLE in
        // totals/history. A marker only — moves no cash (the expense already
        // posted). "reimbursable" stays in the "owed to you" ledger until settled.
        const at: AppliesTo = { kind: "setaside", reason, settled: false, ...(note ? { note } : {}) };
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) => (t.id === id ? { ...t, appliesTo: at } : t)),
        }));
        const { error } = await supabase.from("transactions").update({ applies_to: at }).eq("id", id);
        if (error) console.error(error);
      },
      async settleReimbursable(reimbursableId, creditTxnId) {
        // Mark a reimbursable paid back: clears the "owed to you" marker. If a
        // payback credit is given (auto-suggest), link the two and tag the credit
        // so it drops out of budget noise + the match is idempotent. Moves no cash —
        // both the spend and any deposit posted independently; this records the pair.
        const now = new Date().toISOString();
        const reimb = dataRef.current.transactions.find((t) => t.id === reimbursableId);
        // Only link a credit that's STILL a free, unlinked deposit — guards a stale
        // suggestion (the credit was already claimed by another reimbursable, or
        // isn't income anymore). Otherwise settle WITHOUT a link (manual "got it back").
        const credit = creditTxnId ? dataRef.current.transactions.find((t) => t.id === creditTxnId) : undefined;
        const link = credit && credit.type === "income" && !credit.appliesTo ? creditTxnId : undefined;
        const reimbAt: AppliesTo = {
          ...(reimb?.appliesTo ?? { kind: "setaside", reason: "reimbursable" }),
          kind: "setaside",
          reason: "reimbursable",
          settled: true,
          settledAt: now,
          ...(link ? { settledByTxnId: link } : {}),
        };
        const creditAt: AppliesTo = {
          kind: "setaside",
          reason: "reimbursable",
          settled: true,
          settledByTxnId: reimbursableId,
          settledAt: now,
        };
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === reimbursableId ? { ...t, appliesTo: reimbAt } : link && t.id === link ? { ...t, appliesTo: creditAt } : t,
          ),
        }));
        const e1 = await supabase.from("transactions").update({ applies_to: reimbAt }).eq("id", reimbursableId);
        if (e1.error) console.error(e1.error);
        if (link) {
          const e2 = await supabase.from("transactions").update({ applies_to: creditAt }).eq("id", link);
          if (e2.error) console.error(e2.error);
        }
      },
      async unsettleReimbursable(reimbursableId) {
        // Undo: re-open the reimbursable as owed and free its linked payback credit
        // (back to a plain income deposit). Moves no cash — both rows posted on their
        // own; this only unlinks the pair.
        const reimb = dataRef.current.transactions.find((t) => t.id === reimbursableId);
        const creditId = reimb?.appliesTo?.settledByTxnId;
        const reopened: AppliesTo = {
          kind: "setaside",
          reason: "reimbursable",
          settled: false,
          ...(reimb?.appliesTo?.note ? { note: reimb.appliesTo.note } : {}),
        };
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === reimbursableId
              ? { ...t, appliesTo: reopened }
              : creditId && t.id === creditId
                ? { ...t, appliesTo: undefined }
                : t,
          ),
        }));
        const e1 = await supabase.from("transactions").update({ applies_to: reopened }).eq("id", reimbursableId);
        if (e1.error) console.error(e1.error);
        if (creditId) {
          const e2 = await supabase.from("transactions").update({ applies_to: null }).eq("id", creditId);
          if (e2.error) console.error(e2.error);
        }
      },
      async makeRecurringBill(txnId, cadence) {
        // Promote a charge to a bill: mark THIS transaction as its payment (so it
        // leaves variable spend) and teach the categorizer. DEDUPES — if a bill
        // already exists for this merchant, reuse it instead of spawning a copy.
        const txn = dataRef.current.transactions.find((x) => x.id === txnId);
        if (!txn) return;
        const key = merchantKey(txn.description);
        const day = parseInt(txn.date.slice(8, 10), 10) || 1;
        const monthKey = txn.date.slice(0, 7);
        // A clean display name (the real merchant), not the normalized key.
        const cleanName = (txn.description || "Subscription").trim().slice(0, 40);

        // Reuse an existing active bill whose merchant matches (kills duplicates).
        const existing = dataRef.current.recurring.find(
          (r) => r.active && r.direction === "out" && merchantKey(r.name) === key,
        );
        let recId = existing?.id;
        let billName = existing?.name ?? cleanName;
        if (!recId) {
          const { data: rec, error: rErr } = await supabase
            .from("recurring")
            .insert({
              name: cleanName,
              amount: txn.amount,
              direction: "out",
              cadence,
              category_id: "subscriptions",
              active: true,
              due_days: [day],
            })
            .select("*")
            .single();
          if (rErr || !rec) return console.error(rErr);
          recId = rec.id;
          billName = rec.name;
          invalidate(seq.current, "recurring");
          setData((p) => ({ ...p, recurring: [...p.recurring, mapRecurring(rec)] }));
        }
        const appliesTo: AppliesTo = { kind: "bill", recurringId: recId, monthKey, day };
        invalidate(seq.current, "transactions");
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === txnId ? { ...t, appliesTo, categoryId: "subscriptions" } : t,
          ),
        }));
        await supabase
          .from("transactions")
          .update({ applies_to: appliesTo, category_id: "subscriptions" })
          .eq("id", txnId);
        await supabase
          .from("merchant_rules")
          .upsert({ pattern: key, kind: "bill", category_id: null, bill_name: billName }, { onConflict: "pattern" });
      },
      async setRecurringVariable(id, variable) {
        // Flag a bill as variable-amount — display/projection only, moves no money.
        invalidate(seq.current, "recurring");
        setData((p) => ({
          ...p,
          recurring: p.recurring.map((r) => (r.id === id ? { ...r, variable } : r)),
        }));
        const { error } = await supabase.from("recurring").update({ variable }).eq("id", id);
        if (error) console.error(error);
      },
      async setAccountBalance(accountId, balance) {
        invalidate(seq.current, "accounts");
        setData((p) => ({
          ...p,
          accounts: p.accounts.map((a) =>
            a.id === accountId ? { ...a, balance } : a,
          ),
        }));
        // .select() is load-bearing, not decoration. An UPDATE whose row is
        // filtered out by RLS (or run with an expired JWT) matches ZERO rows and
        // comes back `{ error: null }` — so testing `error` alone reported a
        // write that changed nothing as a success. Asking for the changed row
        // back turns "nothing matched" into a failure we can actually see.
        //
        // This is the bank-truth anchor every other number is derived from —
        // safe-to-spend, the per-cycle variable budget, the bills runway. A
        // value that only ever existed on this phone used to survive the whole
        // session (no DB change → no realtime event → no refetch), and reverted
        // silently on the next app open. So on failure: drop back to server
        // truth and tell the caller, which keeps the editor open.
        const { data: rows, error } = await supabase
          .from("accounts")
          .update({ balance })
          .eq("id", accountId)
          .select();
        if (error || !rows?.length) {
          console.error(
            "setAccountBalance did not persist — resyncing to server truth",
            error ?? `UPDATE matched no row for account ${accountId}`,
          );
          await resyncLedger();
          return false;
        }
        return true;
      },
      async addDebt(input) {
        const { data: row, error } = await supabase
          .from("debts")
          .insert({
            name: input.name,
            balance: input.balance,
            original_balance: input.balance,
            apr: input.apr ?? null,
            min_payment: input.minPayment ?? null,
            color: input.color,
          })
          .select()
          .single();
        if (error || !row) return console.error(error);
        invalidate(seq.current, "debts");
        setData((p) => ({ ...p, debts: [...p.debts, mapDebt(row)] }));
      },
      // Point an existing debt at a connected credit card. Snap its balance to
      // the card's current balance now; the DB trigger keeps it in sync after.
      async linkDebtToCard(debtId, accountId) {
        const acct = dataRef.current.accounts.find((a) => a.id === accountId);
        if (!acct?.providerAccountId) return;
        const bal = Math.max(0, acct.balance);
        invalidate(seq.current, "debts");
        setData((p) => ({
          ...p,
          debts: p.debts.map((d) =>
            d.id === debtId
              ? { ...d, providerAccountId: acct.providerAccountId, balance: bal }
              : d,
          ),
        }));
        const { error } = await supabase
          .from("debts")
          .update({ provider_account_id: acct.providerAccountId, balance: bal })
          .eq("id", debtId);
        if (error) console.error(error);
      },
      async unlinkDebtCard(debtId) {
        invalidate(seq.current, "debts");
        setData((p) => ({
          ...p,
          debts: p.debts.map((d) =>
            d.id === debtId ? { ...d, providerAccountId: undefined } : d,
          ),
        }));
        const { error } = await supabase
          .from("debts")
          .update({ provider_account_id: null })
          .eq("id", debtId);
        if (error) console.error(error);
      },
      // Spin up a fresh debt from a card that isn't tracked yet (e.g. Li's card).
      // APR is unknown on the lean feed — left blank for you to fill in.
      async createDebtFromCard(accountId) {
        const acct = dataRef.current.accounts.find((a) => a.id === accountId);
        if (!acct?.providerAccountId) return;
        const bal = Math.max(0, acct.balance);
        const name = acct.last4 ? `${acct.name} ····${acct.last4}` : acct.name;
        const { data: row, error } = await supabase
          .from("debts")
          .insert({
            name,
            balance: bal,
            original_balance: bal,
            color: "#e26d5c",
            provider_account_id: acct.providerAccountId,
          })
          .select()
          .single();
        if (error || !row) return console.error(error);
        invalidate(seq.current, "debts");
        setData((p) => ({ ...p, debts: [...p.debts, mapDebt(row)] }));
      },
      async seedHousehold() {
        const { data: existing } = await supabase
          .from("accounts")
          .select("id")
          .limit(1);
        if (existing && existing.length) {
          return {
            ok: false,
            message: "Already set up — accounts exist. Use 'Clear all data' first to re-seed.",
          };
        }
        const { data: accts, error: aErr } = await supabase
          .from("accounts")
          .insert(
            SEED_ACCOUNTS.map((a) => ({
              name: a.name,
              owner: a.owner,
              last4: a.last4,
              type: a.type,
              balance: a.balance,
              sort_order: a.sortOrder,
            })),
          )
          .select();
        if (aErr || !accts) {
          return { ok: false, message: "Accounts failed: " + (aErr?.message ?? "?") };
        }
        const idByName: Record<string, string> = {};
        for (const a of accts) idByName[a.name] = a.id;

        // Debts BEFORE recurring, so a card-payment row can resolve the debt it
        // pays down. Map each debt's …last4 (the 4 digits in its name) -> its id.
        const { data: dRows, error: dErr } = await supabase
          .from("debts")
          .insert(
            SEED_DEBTS.map((d) => ({
              name: d.name,
              balance: d.balance,
              original_balance: d.balance,
              apr: d.apr ?? null,
              min_payment: d.minPayment ?? null,
              color: d.color,
            })),
          )
          .select();
        if (dErr || !dRows) {
          return { ok: false, message: "Debts failed: " + (dErr?.message ?? "?") };
        }
        const debtIdByLast4: Record<string, string> = {};
        for (const d of dRows) {
          const m = /(\d{4})/.exec(d.name);
          if (m) debtIdByLast4[m[1]] = d.id;
        }

        const recRows = SEED_RECURRING.map((r) => ({
          name: r.name,
          amount: r.amount,
          direction: r.direction,
          cadence: r.cadence,
          category_id: r.categoryId ?? null,
          account_id: idByName[r.account] ?? null,
          to_account_id: r.toAccount ? (idByName[r.toAccount] ?? null) : null,
          owner: r.owner ?? null,
          note: r.note ?? null,
          active: true,
          due_days: r.dueDays ?? null,
          linked_debt_id: r.linksDebtLast4
            ? (debtIdByLast4[r.linksDebtLast4] ?? null)
            : null,
        }));
        const { error: rErr } = await supabase.from("recurring").insert(recRows);
        if (rErr) return { ok: false, message: "Recurring failed: " + rErr.message };

        return {
          ok: true,
          message: `Seeded 3 accounts, ${dRows.length} debts, ${recRows.length} recurring items.`,
        };
      },
      async resetAll() {
        await Promise.all([
          supabase.from("transactions").delete().neq("id", IMPOSSIBLE_ID),
          supabase.from("debts").delete().neq("id", IMPOSSIBLE_ID),
          supabase.from("savings_goals").delete().neq("id", IMPOSSIBLE_ID),
          supabase.from("recurring").delete().neq("id", IMPOSSIBLE_ID),
          supabase.from("accounts").delete().neq("id", IMPOSSIBLE_ID),
          supabase.from("paid_bills").delete().neq("id", IMPOSSIBLE_ID),
        ]);
        invalidate(
          seq.current,
          "transactions",
          "debts",
          "savings_goals",
          "recurring",
          "accounts",
          "paid_bills",
        );
        setData((p) => ({
          ...p,
          transactions: [],
          debts: [],
          goals: [],
          recurring: [],
          accounts: [],
          paidBills: [],
        }));
      },
      async setPaidBill(month, key, paid) {
        invalidate(seq.current, "paid_bills");
        setData((p) => {
          const others = p.paidBills.filter(
            (b) => !(b.month === month && b.billKey === key),
          );
          return {
            ...p,
            paidBills: [
              ...others,
              { id: `tmp-${month}-${key}`, month, billKey: key, paid },
            ],
          };
        });
        const { error } = await supabase
          .from("paid_bills")
          .upsert({ month, bill_key: key, paid }, { onConflict: "month,bill_key" });
        if (error) console.error(error);
      },
    };
  }, []);

  const value: FinanceStore = { ...store, data, loading };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore(): FinanceStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used within FinanceProvider");
  return s;
}
