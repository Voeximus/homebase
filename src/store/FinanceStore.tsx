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
} from "../types";
import { supabase } from "../lib/supabase";
import { DEFAULT_CATEGORIES } from "../lib/seed";
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
    account: r.account ?? undefined,
    accountId: r.account_id ?? undefined,
    appliesTo: r.applies_to ?? undefined,
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
    note: r.note ?? undefined,
    dueDays: r.due_days ?? undefined,
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

export interface FinanceStore {
  data: AppData;
  loading: boolean;
  addTransaction: (t: Omit<Transaction, "id" | "createdAt">) => Promise<void>;
  deleteTransaction: (id: string) => Promise<void>;
  setTransactionCategory: (id: string, categoryId: string) => Promise<void>;
  setAccountBalance: (accountId: string, balance: number) => Promise<void>;
  addDebt: (d: {
    name: string;
    balance: number;
    apr?: number;
    minPayment?: number;
    color: string;
  }) => Promise<void>;
  payDebt: (id: string, amount: number) => Promise<void>;
  addGoal: (g: {
    name: string;
    target: number;
    saved?: number;
    icon: string;
    color: string;
  }) => Promise<void>;
  contributeGoal: (id: string, amount: number) => Promise<void>;
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
  payDebtExtra: (
    debtId: string,
    amount: number,
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

  // Latest data for actions that read-modify-write (payDebt, contributeGoal).
  const dataRef = useRef(data);
  dataRef.current = data;
  // True once the `foods` table is reachable; false → fall back to localStorage.
  const foodsSynced = useRef(false);
  const migrationDone = useRef(false);
  // Resolves when the initial foods load finishes, so add/delete never run
  // against an undetermined sync mode.
  const foodsReady = useRef<Promise<void> | null>(null);

  // Initial load + live sync. Any change (from either device) refetches the
  // affected table so both screens stay in step.
  useEffect(() => {
    let active = true;

    async function loadTransactions() {
      const { data: rows } = await supabase
        .from("transactions")
        .select("*")
        .order("date", { ascending: false })
        .order("created_at", { ascending: false });
      if (active) {
        setData((p) => ({ ...p, transactions: (rows ?? []).map(mapTxn) }));
      }
    }
    async function loadDebts() {
      const { data: rows } = await supabase
        .from("debts")
        .select("*")
        .order("created_at", { ascending: true });
      if (active) setData((p) => ({ ...p, debts: (rows ?? []).map(mapDebt) }));
    }
    async function loadGoals() {
      const { data: rows } = await supabase
        .from("savings_goals")
        .select("*")
        .order("created_at", { ascending: true });
      if (active) setData((p) => ({ ...p, goals: (rows ?? []).map(mapGoal) }));
    }
    async function loadAccounts() {
      const { data: rows } = await supabase
        .from("accounts")
        .select("*")
        .order("sort_order", { ascending: true });
      if (active)
        setData((p) => ({ ...p, accounts: (rows ?? []).map(mapAccount) }));
    }
    async function loadRecurring() {
      const { data: rows } = await supabase
        .from("recurring")
        .select("*")
        .order("created_at", { ascending: true });
      if (active)
        setData((p) => ({ ...p, recurring: (rows ?? []).map(mapRecurring) }));
    }
    async function loadPaidBills() {
      const { data: rows } = await supabase.from("paid_bills").select("*");
      if (active)
        setData((p) => ({ ...p, paidBills: (rows ?? []).map(mapPaidBill) }));
    }
    async function loadMerchantRules() {
      const { data: rows } = await supabase.from("merchant_rules").select("*");
      if (active)
        setData((p) => ({ ...p, merchantRules: (rows ?? []).map(mapMerchantRule) }));
    }
    async function loadFoods() {
      const { data: rows, error } = await supabase
        .from("foods")
        .select("*")
        .order("created_at", { ascending: true });
      if (!active) return;
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
            if (active)
              setData((p) => ({ ...p, foods: [...dbFoods, ...loadCustomFoods()] }));
            return;
          }
          clearCustomFoods();
          migrationDone.current = true;
          const { data: rows2 } = await supabase
            .from("foods")
            .select("*")
            .order("created_at", { ascending: true });
          if (active) setData((p) => ({ ...p, foods: (rows2 ?? []).map(mapFood) }));
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

    const channel = supabase
      .channel("homebase-sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "transactions" },
        () => loadTransactions(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "debts" },
        () => loadDebts(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "savings_goals" },
        () => loadGoals(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "accounts" },
        () => loadAccounts(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "recurring" },
        () => loadRecurring(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "paid_bills" },
        () => loadPaidBills(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "merchant_rules" },
        () => loadMerchantRules(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "foods" },
        () => loadFoods(),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  type Actions = Omit<FinanceStore, "data" | "loading">;
  const store = useMemo<Actions>(() => {
    // Fail-closed recovery: if a money write partially fails, pull the ledger
    // tables back from the server so the UI can never keep an optimistic value
    // that did not actually persist (the deleteFood refetch-on-error pattern).
    const resyncLedger = async () => {
      const [tx, ac, de, go] = await Promise.all([
        supabase.from("transactions").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
        supabase.from("accounts").select("*").order("sort_order", { ascending: true }),
        supabase.from("debts").select("*").order("created_at", { ascending: true }),
        supabase.from("savings_goals").select("*").order("created_at", { ascending: true }),
      ]);
      setData((p) => ({
        ...p,
        transactions: tx.data ? tx.data.map(mapTxn) : p.transactions,
        accounts: ac.data ? ac.data.map(mapAccount) : p.accounts,
        debts: de.data ? de.data.map(mapDebt) : p.debts,
        goals: go.data ? go.data.map(mapGoal) : p.goals,
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
    }) => {
      const date = new Date().toISOString().slice(0, 10);

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
      const debtApplied = debt ? Math.min(ev.amount, debt.balance) : 0;

      const appliesTo: AppliesTo | undefined =
        at && debt ? { ...at, appliedAmount: debtApplied } : at;

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
      async payDebtExtra(debtId, amount, fromAccountId) {
        await applyMoneyEvent({
          accountId: fromAccountId,
          amount,
          type: "expense",
          categoryId: "other",
          description: "Debt payment",
          appliesTo: { kind: "debt", debtId },
        });
      },
      async markBillPaid(recurringId, monthKey, amount, day) {
        const rec = dataRef.current.recurring.find((r) => r.id === recurringId);
        if (!rec) return;
        // A settled marker only records paid-state. No cash moves (account null),
        // no debt fan-out — the payment is already in your anchored balance.
        const date = new Date().toISOString().slice(0, 10);
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
        setData((p) => ({ ...p, transactions: [mapTxn(row), ...p.transactions] }));
      },
      async commitImport(items) {
        if (!items.length) return { ok: true, count: 0 };
        const rows = items.map((it) => ({
          date: it.date,
          amount: it.amount,
          type: "expense" as const,
          category_id: it.categoryId,
          description: it.description,
          account_id: null,
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
        setData((p) => ({
          ...p,
          transactions: [...(inserted ?? []).map(mapTxn), ...p.transactions],
        }));
        return { ok: true, count: inserted?.length ?? 0 };
      },
      async saveMerchantRule(rule) {
        const row = {
          pattern: rule.pattern,
          kind: rule.kind,
          category_id: rule.categoryId ?? null,
          bill_name: rule.billName ?? null,
        };
        // Optimistic: replace any existing rule for this merchant.
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
        if (saved)
          setData((p) => ({
            ...p,
            merchantRules: [
              ...p.merchantRules.filter((r) => r.pattern !== rule.pattern),
              mapMerchantRule(saved),
            ],
          }));
      },
      async addFood(food) {
        await foodsReady.current;
        if (!foodsSynced.current) {
          const f: Food = { ...food, id: `c-${Date.now()}`, custom: true };
          saveCustomFoods([...loadCustomFoods(), f]);
          setData((p) => ({ ...p, foods: [...p.foods, f] }));
          return;
        }
        const { data: row, error } = await supabase
          .from("foods")
          .insert(foodToRow(food))
          .select()
          .single();
        if (error || !row) return console.error(error);
        setData((p) => ({ ...p, foods: [...p.foods, mapFood(row)] }));
      },
      async deleteFood(id) {
        await foodsReady.current;
        setData((p) => ({ ...p, foods: p.foods.filter((x) => x.id !== id) }));
        if (!foodsSynced.current) {
          saveCustomFoods(loadCustomFoods().filter((x) => x.id !== id));
          return;
        }
        const { error } = await supabase.from("foods").delete().eq("id", id);
        if (error) {
          // Delete failed → restore truth from the cloud so the UI doesn't lie.
          console.error(error);
          const { data: rows } = await supabase
            .from("foods")
            .select("*")
            .order("created_at", { ascending: true });
          setData((p) => ({ ...p, foods: (rows ?? []).map(mapFood) }));
        }
      },
      async addTransaction(t) {
        const { data: row, error } = await supabase
          .from("transactions")
          .insert({
            date: t.date,
            amount: t.amount,
            type: t.type,
            category_id: t.categoryId,
            description: t.description,
            account: t.account ?? null,
            account_id: t.accountId ?? null,
          })
          .select()
          .single();
        if (error || !row) return console.error(error);
        setData((p) => ({ ...p, transactions: [mapTxn(row), ...p.transactions] }));
        // Cash is a living number: move the chosen account's balance.
        if (t.accountId) {
          const acct = dataRef.current.accounts.find((a) => a.id === t.accountId);
          if (acct) {
            const nb = acct.balance + (t.type === "income" ? t.amount : -t.amount);
            setData((p) => ({
              ...p,
              accounts: p.accounts.map((a) =>
                a.id === t.accountId ? { ...a, balance: nb } : a,
              ),
            }));
            await supabase.from("accounts").update({ balance: nb }).eq("id", t.accountId);
          }
        }
      },
      async deleteTransaction(id) {
        const txn = dataRef.current.transactions.find((x) => x.id === id);
        // optimistic remove
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
          const back = at?.appliedAmount ?? txn.amount;
          setData((p) => ({
            ...p,
            accounts: txn.accountId
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
              !at?.settled && debtId
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
        setData((p) => ({
          ...p,
          transactions: p.transactions.map((t) =>
            t.id === id ? { ...t, categoryId } : t,
          ),
        }));
        const { error } = await supabase
          .from("transactions")
          .update({ category_id: categoryId })
          .eq("id", id);
        if (error) console.error(error);
      },
      async setAccountBalance(accountId, balance) {
        setData((p) => ({
          ...p,
          accounts: p.accounts.map((a) =>
            a.id === accountId ? { ...a, balance } : a,
          ),
        }));
        const { error } = await supabase
          .from("accounts")
          .update({ balance })
          .eq("id", accountId);
        if (error) console.error(error);
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
        setData((p) => ({ ...p, debts: [...p.debts, mapDebt(row)] }));
      },
      async payDebt(id, amount) {
        const debt = dataRef.current.debts.find((d) => d.id === id);
        if (!debt) return;
        const newBalance = Math.max(0, debt.balance - amount);
        setData((p) => ({
          ...p,
          debts: p.debts.map((d) =>
            d.id === id ? { ...d, balance: newBalance } : d,
          ),
        }));
        const { error } = await supabase
          .from("debts")
          .update({ balance: newBalance })
          .eq("id", id);
        if (error) console.error(error);
      },
      async addGoal(input) {
        const { data: row, error } = await supabase
          .from("savings_goals")
          .insert({
            name: input.name,
            target: input.target,
            saved: input.saved ?? 0,
            icon: input.icon,
            color: input.color,
          })
          .select()
          .single();
        if (error || !row) return console.error(error);
        setData((p) => ({ ...p, goals: [...p.goals, mapGoal(row)] }));
      },
      async contributeGoal(id, amount) {
        const goal = dataRef.current.goals.find((g) => g.id === id);
        if (!goal) return;
        const newSaved = Math.max(0, goal.saved + amount);
        setData((p) => ({
          ...p,
          goals: p.goals.map((g) =>
            g.id === id ? { ...g, saved: newSaved } : g,
          ),
        }));
        const { error } = await supabase
          .from("savings_goals")
          .update({ saved: newSaved })
          .eq("id", id);
        if (error) console.error(error);
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
