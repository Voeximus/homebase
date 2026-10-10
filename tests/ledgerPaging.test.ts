/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as H from "./helpers/healthHarness";
import { FinanceProvider, useStore } from "../src/store/FinanceStore";
import { HealthProvider, useHealth } from "../src/store/HealthStore";

// FOUND 2026-10-09: the app's ledger load stopped at 1,000 rows. Every store read
// was one bare select, and PostgREST cuts a bare select off at 1,000 rows without
// an error. The ledger held 835 rows that day, growing ~4.2 a day — over 1,000
// around 2026-11-17. And a refetch that failed handed back `null`, which `?? []`
// turned into an EMPTY ledger on screen.
//
// These run the real FinanceProvider and HealthProvider against the hand-driven
// fake server in tests/helpers/healthHarness.ts, which now cuts every select at
// SERVER_MAX_ROWS the way PostgREST does — so a store that reads one bare select
// holds 1,000 rows here too, exactly as it would on the phone.

vi.mock("../src/lib/supabase", async () => ({ supabase: (await import("./helpers/healthHarness")).fakeSupabase }));

// FinanceProvider's foreground backstop listens on `document`; the harness's
// stand-in has no listeners, so give it some.
const docListeners = new Map<string, Set<() => void>>();
const doc = globalThis.document as any;
doc.addEventListener = (t: string, f: () => void) => {
  if (!docListeners.has(t)) docListeners.set(t, new Set());
  docListeners.get(t)!.add(f);
};
doc.removeEventListener = (t: string, f: () => void) => docListeners.get(t)?.delete(f);
doc.visibilityState = "visible";
/** The phone comes back to the foreground: FinanceProvider refetches every table. */
const backToForeground = () => [...(docListeners.get("visibilitychange") ?? [])].forEach((f) => f());

/** Answer every request in the air, round after round — a paged read only asks
 *  for page 2 once page 1 has landed. */
async function answerAll() {
  await H.settle();
  for (let round = 0; round < 60; round++) {
    const waiting = H.open();
    if (!waiting.length) return;
    for (const r of waiting) H.deliver(r);
    await H.settle();
  }
  throw new Error("the store never stopped asking");
}

const txn = (i: number) => ({
  id: `t${String(i).padStart(5, "0")}`,
  date: `2026-${String(3 + Math.floor(i / 400)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
  amount: "12.34",
  type: "expense",
  category_id: "groceries",
  description: "Store",
  status: "posted",
  created_at: "2026-10-09T00:00:00Z",
});
const seedLedger = (n: number) => (H.db.transactions = Array.from({ length: n }, (_, i) => txn(i)));
const selectsOf = (table: string) => H.reqs.filter((r) => r.table === table && r.op === "select");

let unmount: (() => Promise<void>) | null = null;
async function mountFinance() {
  const app = await H.mountStore(FinanceProvider, useStore);
  unmount = app.unmount;
  await answerAll();
  return app;
}
async function mountHealth() {
  const app = await H.mountStore(HealthProvider, useHealth);
  unmount = app.unmount;
  await answerAll();
  return app;
}

beforeEach(() => {
  H.resetWorld();
  docListeners.clear();
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

describe("FinanceStore — the whole ledger, not the newest 1,000 rows", () => {
  it("holds every transaction once the ledger passes 1,000 rows", async () => {
    seedLedger(2500);
    const app = await mountFinance();

    const ids = app.value.data.transactions.map((t) => t.id);
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
    // Every request was a page, in a total order ending on id.
    const asked = selectsOf("transactions");
    expect(asked.length).toBeGreaterThan(1);
    for (const r of asked) {
      expect(r.range).toBeDefined();
      expect(r.order).toEqual([
        ["date", false],
        ["created_at", false],
        ["id", true],
      ]);
    }
  });

  it("a refetch that fails keeps the ledger already on screen, and says so", async () => {
    seedLedger(12);
    const app = await mountFinance();
    expect(app.value.data.transactions).toHaveLength(12);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    backToForeground();
    await H.settle();
    H.fail(H.one(H.on("transactions", "select")));
    await answerAll();

    // It was `(rows ?? []).map(mapTxn)`: one failed refetch emptied the ledger.
    expect(app.value.data.transactions).toHaveLength(12);
    expect(logged.mock.calls.some((c) => String(c[0]).includes("keeping the ledger already on screen"))).toBe(true);
  });

  it("the recovery read after a refused balance write restores the WHOLE ledger", async () => {
    seedLedger(2500);
    H.db.accounts = [{ id: "a1", name: "Checking", owner: "gino", type: "checking", balance: "100.00", sort_order: 0 }];
    const app = await mountFinance();
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The server answers the UPDATE with no row, so setAccountBalance falls back
    // to resyncLedger — the read whose whole job is to restore server truth.
    const before = selectsOf("transactions").length;
    let wrote!: Promise<boolean>;
    await H.settle(() => {
      wrote = app.value.setAccountBalance("a1", 5);
    });
    await answerAll();
    expect(await wrote).toBe(false);

    expect(selectsOf("transactions").length - before).toBeGreaterThan(1); // paged, not one bare select
    expect(app.value.data.transactions).toHaveLength(2500);
  });

  it("paid bills and learned merchant rules past 1,000 rows all arrive", async () => {
    H.db.paid_bills = Array.from({ length: 1200 }, (_, i) => ({
      id: `p${i}`,
      month: `20${String(26 + Math.floor(i / 12)).padStart(2, "0")}-${String(1 + (i % 12)).padStart(2, "0")}`,
      bill_key: `bill-${i}`,
      paid: true,
    }));
    H.db.merchant_rules = Array.from({ length: 1200 }, (_, i) => ({
      id: `m${i}`,
      pattern: `merchant ${i}`,
      kind: "variable",
      category_id: "groceries",
      bill_name: null,
      created_at: "2026-10-09T00:00:00Z",
    }));
    const app = await mountFinance();
    expect(app.value.data.paidBills).toHaveLength(1200);
    expect(app.value.data.merchantRules).toHaveLength(1200);
  });
});

describe("HealthStore — tables that grow with the calendar", () => {
  const day = (i: number) => {
    const d = new Date(Date.UTC(2023, 0, 1 + Math.floor(i / 2)));
    return d.toISOString().slice(0, 10);
  };
  const person = (i: number) => (i % 2 ? "xinyan" : "gino");

  it("meal days, sessions and weigh-ins past 1,000 rows all arrive", async () => {
    H.db.meal_days = Array.from({ length: 1200 }, (_, i) => ({ id: `md${i}`, person: person(i), date: day(i), meals: [] }));
    H.db.workouts = Array.from({ length: 1200 }, (_, i) => ({
      id: `w${i}`,
      person: person(i),
      date: day(i),
      name: "Workout",
      notes: "",
      exercises: [],
      done: true,
    }));
    H.db.body_weights = Array.from({ length: 1200 }, (_, i) => ({ id: `bw${i}`, person: person(i), date: day(i), weight: "180" }));
    const app = await mountHealth();

    expect(Object.keys(app.value.mealDays)).toHaveLength(1200);
    expect(app.value.workouts).toHaveLength(1200);
    expect(app.value.weights).toHaveLength(1200);
    for (const t of ["meal_days", "workouts", "body_weights"]) {
      for (const r of selectsOf(t)) {
        expect(r.range, t).toBeDefined();
        expect(r.order.at(-1), t).toEqual(["id", true]);
      }
    }
  });

  it("a weigh-in reload that fails on page 2 leaves every weigh-in on screen — not page 1 alone", async () => {
    H.db.body_weights = Array.from({ length: 1200 }, (_, i) => ({ id: `bw${i}`, person: person(i), date: day(i), weight: "180" }));
    const app = await mountHealth();
    expect(app.value.weights).toHaveLength(1200);

    // The other phone logs a weight: reloadWeights runs, page 1 lands, page 2 fails.
    H.emit("body_weights");
    await H.settle();
    H.deliver(H.one(H.on("body_weights", "select")));
    await H.settle();
    H.fail(H.one(H.on("body_weights", "select")));
    await H.settle();

    // body_weights REPLACES its clean rows from a fetch, so applying the 500 that
    // did arrive would have deleted the other 700 from the screen.
    expect(app.value.weights).toHaveLength(1200);
  });
});

// ADDED 2026-10-10 with public.cycle_budgets: a budget goal for one pay cycle, set by
// either assistant through the Muse write door. The store has to bring it to both phones
// the same way it brings everything else — paged, and keeping what is on screen when a
// read fails, because an empty list here silently means "back to the standard budget".
describe("FinanceStore — budget goals for one pay cycle", () => {
  const goalRow = (id: string, line: string, amount: string, set_by: string | null = "gino") => ({
    id,
    cycle_start: "2026-10-15",
    line,
    amount,
    set_by,
    at: "2026-10-10T20:00:00Z",
  });

  it("reads every goal row paged, in a total order, and maps it", async () => {
    H.db.cycle_budgets = [goalRow("cb1", "groceries", "175.00"), goalRow("cb2", "dining", "37.25", null)];
    const app = await mountFinance();
    expect(app.value.data.cycleBudgets).toEqual([
      { id: "cb1", cycleStart: "2026-10-15", line: "groceries", amount: 175, setBy: "gino", at: "2026-10-10T20:00:00Z" },
      { id: "cb2", cycleStart: "2026-10-15", line: "dining", amount: 37.25, setBy: undefined, at: "2026-10-10T20:00:00Z" },
    ]);
    const asked = selectsOf("cycle_budgets");
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) {
      expect(r.range).toBeDefined();
      expect(r.order).toEqual([["id", true]]);
    }
  });

  it("a refetch that fails keeps the goals already on screen, and says so", async () => {
    H.db.cycle_budgets = [goalRow("cb1", "groceries", "175.00")];
    const app = await mountFinance();
    expect(app.value.data.cycleBudgets).toHaveLength(1);

    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    backToForeground();
    await H.settle();
    H.fail(H.one(H.on("cycle_budgets", "select")));
    await answerAll();

    expect(app.value.data.cycleBudgets).toHaveLength(1);
    expect(warned.mock.calls.some((c) => String(c[0]).includes("keeping the budget goals already on screen"))).toBe(true);
  });

  it("a database without the table keeps the standard budget — no goals — and the rest of the app loads", async () => {
    H.db.paid_bills = [{ id: "p1", month: "2026-10", bill_key: "Rent@1", paid: true }];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = await H.mountStore(FinanceProvider, useStore);
    unmount = app.unmount;
    await H.settle();
    // The goal table's first page fails the way a missing table does; everything else lands.
    H.fail(H.one(H.on("cycle_budgets", "select")));
    await answerAll();
    expect(app.value.data.cycleBudgets).toEqual([]);
    expect(app.value.data.paidBills).toHaveLength(1);
  });

  it("a goal set on the other phone arrives without a reload", async () => {
    const app = await mountFinance();
    expect(app.value.data.cycleBudgets).toEqual([]);
    H.db.cycle_budgets = [goalRow("cb1", "groceries", "175.00")];
    H.emit("cycle_budgets");
    // The realtime refetch is debounced (REFETCH_DEBOUNCE_MS); let it fire, then answer.
    await H.settle(() => new Promise((r) => setTimeout(r, 300)));
    await answerAll();
    expect(app.value.data.cycleBudgets).toHaveLength(1);
    expect(app.value.data.cycleBudgets![0]).toMatchObject({ line: "groceries", amount: 175 });
  });
});
