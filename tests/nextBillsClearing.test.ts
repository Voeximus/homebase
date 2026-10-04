// The joint account is not as short as it looks — and once read the other way round.
//
// WHAT HAPPENED, twice, two days apart. `finance.next_bills` reports a `due` total per
// account beside that account's `balance`, so a reader can see money sitting in the
// wrong place. On 2026-10-02 it put the joint account $1,856.61 short with rent already
// clearing; on 2026-10-04, $269.33 short when the real gap was $169.40.
//
// Neither figure was a sum done wrong. `due` counts a bill at full amount until its
// charge POSTS — right, and deliberate, because a pending charge can reverse. But
// `balance` is the bank's available figure and the bank has ALREADY taken that same
// pending charge out of it. Subtracting one from the other counts the payment twice.
//
// So the fix adds the two figures that make the comparison honest rather than changing
// `due`: `clearing` (what is in flight) and `still_to_come` (`due` − `clearing`), which
// is the one that belongs beside `balance`.
import { describe, expect, it } from "vitest";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler";
import type { AuditRow } from "../supabase/functions/_shared/muse/audit";
import type { Db, DbRow } from "../supabase/functions/_shared/muse/paging";

const SECRET = "mr_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// Mid-afternoon in Arizona on 2026-10-04, the day it was observed.
const AT = new Date("2026-10-04T18:30:00Z");

/** The live shape: two bills on the joint account, one of them already clearing. */
const TABLES = (): Record<string, DbRow[]> => ({
  accounts: [
    {
      id: "joint", name: "Adv SafeBalance Banking", owner: "Joint", last4: "1111",
      type: "checking",
      // The bank's AVAILABLE figure — the $168.99 in flight is already out of it.
      balance: "63.27", pending_hold: "168.99",
      sort_order: 1, created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "gino", name: "Adv Plus Banking", owner: "Gino", last4: "4728",
      type: "checking", balance: "1066.06", pending_hold: "0",
      sort_order: 2, created_at: "2026-01-01T00:00:00Z",
    },
  ],
  recurring: [
    { id: "pet", name: "Spot Pet insurance", amount: "99.93", direction: "out", cadence: "monthly",
      active: true, due_days: [4], account_id: "joint", category_id: "bills", created_at: "2026-01-01T00:00:00Z" },
    { id: "car", name: "Car payment (Civic)", amount: "232.67", direction: "out", cadence: "monthly",
      active: true, due_days: [6], account_id: "joint", category_id: "bills", created_at: "2026-01-01T00:00:00Z" },
    { id: "spot", name: "Spotify", amount: "27.00", direction: "out", cadence: "monthly",
      active: true, due_days: [10], account_id: "gino", category_id: "subscriptions", created_at: "2026-01-01T00:00:00Z" },
    { id: "pay", name: "Paycheck", amount: "1400.00", direction: "in", cadence: "semimonthly",
      active: true, due_days: [15, 31], account_id: "gino", created_at: "2026-01-01T00:00:00Z" },
  ],
  transactions: [
    // Spot Pet's own payment, still in flight: same account, exact amount, same day.
    { id: "p1", date: "2026-10-04", amount: "99.93", type: "expense", status: "pending",
      category_id: "bills", description: "Spot Pet Insurance", account_id: "joint",
      provider: "plaid", created_at: "2026-10-04T12:00:00Z" },
  ],
  debts: [], savings_goals: [], paid_bills: [], merchant_rules: [],
  body_weights: [], meal_days: [], workouts: [], reminders: [], muse_memories: [],
  categories: [], budgets: [], pending_preview: [], plaid_items: [],
});

function fakeDb(tables: Record<string, DbRow[]>): Db {
  return {
    select({ table, orderBy, eq }) {
      const rows = () =>
        (tables[table] ?? [])
          .filter((r) => Object.entries(eq ?? {}).every(([k, v]) => String(r[k]) === v))
          .slice()
          .sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      return { count: async () => rows().length, page: async (from, to) => rows().slice(from, to + 1) };
    },
  };
}

const ask = (tool: string) =>
  handleMuseRead(
    new Request(`https://example.test/functions/v1/muse-read/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: "{}",
    }),
    {
      db: fakeDb(TABLES()),
      secrets: { gino: SECRET, xinyan: null },
      at: AT,
      baseUrl: "https://example.test/functions/v1/muse-read",
      audit: { record: async (_row: AuditRow) => {} },
      limit: { bump: async () => 1 },
    } as never,
  );

describe("next_bills: what is clearing is not still to come", () => {
  const joint = async () => {
    const body = await (await ask("finance.next_bills")).json();
    const rows = body.by_account as Record<string, number | string>[];
    return { body, row: rows.find((r) => r.account === "joint")! };
  };

  it("splits the joint account's claim into what is in flight and what is not", async () => {
    const { row } = await joint();
    expect(row.balance).toBe(63.27);
    // Unchanged on purpose: the bill is not settled until its charge posts.
    expect(row.due).toBe(332.6);
    expect(row.clearing).toBe(99.93);
    expect(row.still_to_come).toBe(232.67);
    expect(row.count).toBe(2);
  });

  it("is the figure that gives the real shortfall — $169.40, not $269.33", async () => {
    const { row } = await joint();
    // THE WHOLE POINT. Both subtractions are arithmetically correct; only one of them
    // is about a real question. The live reply said $269.33 because it used `due`,
    // which still counts a $99.93 payment the bank had already taken out of the
    // balance — so that $99.93 was subtracted twice.
    expect(Number(row.due) - Number(row.balance)).toBeCloseTo(269.33, 2);
    expect(Number(row.still_to_come) - Number(row.balance)).toBeCloseTo(169.4, 2);
  });

  it("leaves an account with nothing in flight exactly as it was", async () => {
    const body = await (await ask("finance.next_bills")).json();
    const rows = body.by_account as Record<string, number | string>[];
    const gino = rows.find((r) => r.account === "gino")!;
    expect(gino.clearing).toBe(0);
    // No cover means the two figures agree, so nothing about the old reading changes
    // for the accounts this bug never touched.
    expect(gino.still_to_come).toBe(gino.due);
  });

  it("names the bill as clearing rather than owed, and says which figure to compare", async () => {
    const body = await (await ask("finance.next_bills")).json();
    const bills = body.bills as Record<string, unknown>[];
    const pet = bills.find((b) => b.bill === "pet")!;
    expect(pet.paying_now).toBeTruthy();
    expect(pet.overdue).toBe(false);
    // The note has to carry the rule, because the door cannot stop a reader doing the
    // wrong subtraction — it can only say which one is wrong.
    expect(String(body.note)).toMatch(/compare `balance` against `still_to_come`, NEVER against `due`/);
  });

  it("the two new figures always add back up to the old one", async () => {
    const body = await (await ask("finance.next_bills")).json();
    for (const r of body.by_account as Record<string, number>[]) {
      expect(Number(r.clearing) + Number(r.still_to_come)).toBeCloseTo(Number(r.due), 2);
    }
  });
});
