// Seeing an account run short in time, and saying what the pay floor really is.
//
// WHAT HAPPENED, 2026-10-10. The joint account held a few dollars. Rent — paid FROM
// the joint account, and far bigger than what was in it — drew on Nov 1. The household
// had the money, in the wrong account, and the read door could not say so in time:
//
//   · finance.next_bills had the only per-account view, and it stopped at the end of
//     the pay cycle (Oct 14), so rent on the 1st was invisible until about Oct 30.
//   · it left the shortfall for the assistant to subtract, which its own instructions
//     forbid.
//   · finance.bills and finance.bill_calendar did not say which account a bill comes
//     out of, and bill_calendar said `paid: false` about payments next_bills knew had
//     already left.
//
// And the same day, both doors were found describing Gino's pay floor as a cash reserve
// the door "does not know" — when it is the planned paycheck the income figures are
// built from — while the forecast called planned income "measured from the bank".
//
// Every amount, name and id below is made up. The shape is the live one.
import { describe, expect, it } from "vitest";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler";
import type { Db, DbRow } from "../supabase/functions/_shared/muse/paging";
import { isPayFloorRow, payFloorOf } from "../supabase/functions/_shared/muse/payFloor";
import { addDaysISO } from "../src/lib/format";

const SECRET = "mr_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// Mid-afternoon in Arizona on 2026-10-10, the day it was found. The pay cycle runs
// Sep 30 – Oct 14; 21 days from today is Oct 31; the next rent is Nov 1.
const AT = new Date("2026-10-10T20:00:00Z");

const acct = (id: string, owner: string, balance: string, sort: number): DbRow => ({
  id, name: `${owner} checking`, owner, last4: "0000", type: "checking",
  balance, pending_hold: "0", sort_order: sort, created_at: "2026-01-01T00:00:00Z",
});
const bill = (id: string, name: string, amount: string, day: number, account: string | null, category = "other"): DbRow => ({
  id, name, amount, direction: "out", cadence: "monthly", active: true,
  due_days: [day], account_id: account, category_id: category, created_at: "2026-01-01T00:00:00Z",
});
const paycheck = (over: Partial<DbRow> = {}): DbRow => ({
  id: "pay", name: "Main paycheck", amount: "900.00", direction: "in", cadence: "semimonthly",
  active: true, due_days: [15, 31], account_id: null, owner: "Gino", category_id: "salary",
  created_at: "2026-01-01T00:00:00Z", ...over,
});
/** A charge already linked to its bill for October, so the calendar reads that bill paid. */
const paidFor = (id: string, recurringId: string, day: number, amount: string, account: string): DbRow => ({
  id, date: `2026-10-${String(day).padStart(2, "0")}`, amount, type: "expense", status: "posted",
  category_id: "other", description: "a payment", account_id: account, provider: "plaid",
  applies_to: { kind: "bill", recurringId, monthKey: "2026-10", day }, created_at: "2026-10-01T12:00:00Z",
});

/** A typical shape: one account pays the big bills and another pays the rest. */
const TABLES = (): Record<string, DbRow[]> => ({
  accounts: [acct("joint", "Joint", "12.50", 1), acct("gino", "Gino", "500.00", 2)],
  recurring: [
    bill("rent", "Rent", "1500.00", 1, "joint", "housing"),
    bill("pet", "Pet insurance", "80.00", 4, "joint"),
    bill("car", "Car payment", "200.00", 6, "joint"),
    bill("phone", "Phone", "60.00", 20, "gino", "utilities"),
    paycheck(),
  ],
  transactions: [
    // October's rent, pet and car are paid and linked, so the only joint bill ahead is
    // November's rent.
    paidFor("p-rent", "rent", 1, "1500.00", "joint"),
    paidFor("p-pet", "pet", 4, "80.00", "joint"),
    paidFor("p-car", "car", 6, "200.00", "joint"),
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

const ask = async (tool: string, tables = TABLES(), body: Record<string, unknown> = {}, at = AT) => {
  const res = await handleMuseRead(
    new Request(`https://example.test/functions/v1/muse-read/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      db: fakeDb(tables),
      secrets: { gino: SECRET, xinyan: null },
      at,
      baseUrl: "https://example.test/functions/v1/muse-read",
      audit: { record: () => Promise.resolve() },
      limit: { bump: async () => 1 },
    } as never,
  );
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

type AheadRow = {
  account: string | null;
  owner: string;
  balance: number | null;
  due: number;
  already_out: number;
  still_to_come: number;
  pay_counted: number;
  short_by: number | null;
  short_on: string | null;
  bills: { bill: string | null; due: string; already_out: string | null }[];
};
const lookAhead = (body: Record<string, unknown>) =>
  body.look_ahead as {
    from: string;
    through: string;
    ends_at: string;
    next_rent_on: string | null;
    pay_not_placed: number;
    pay_not_placed_count: number;
    by_account: AheadRow[];
  };
const rowFor = (body: Record<string, unknown>, id: string) => lookAhead(body).by_account.find((r) => r.account === id)!;

describe("next_bills looks past the pay cycle, per account, with the subtraction done", () => {
  it("runs from the cycle start through the next rent when rent is past 21 days", async () => {
    const la = lookAhead(await ask("finance.next_bills"));
    expect(la.from).toBe("2026-09-30");
    expect(addDaysISO("2026-10-10", 21)).toBe("2026-10-31");
    // Stretched one day past the 21, because rent is on the 1st.
    expect(la.through).toBe("2026-11-01");
    expect(la.next_rent_on).toBe("2026-11-01");
    expect(la.ends_at).toBe("the next rent");
  });

  it("puts the joint account short for rent — the thing the cycle view could not show", async () => {
    const body = await ask("finance.next_bills");
    // The cycle view ends on Oct 14, so rent is not in it at all: this is the gap.
    const cycleJoint = (body.by_account as { account: string | null; due: number }[]).find((r) => r.account === "joint");
    expect(cycleJoint?.due ?? 0).toBe(0);

    const joint = rowFor(body, "joint");
    expect(joint.balance).toBe(12.5);
    expect(joint.bills.map((b) => b.bill)).toEqual(["rent"]);
    expect(joint.still_to_come).toBe(1500);
    // Worked out in the door, so nobody reading it subtracts: 1500 − 12.50.
    expect(joint.short_by).toBe(1487.5);
    expect(joint.short_on).toBe("2026-11-01");
    expect(joint.pay_counted).toBe(0);
  });

  it("finds the rent as the biggest housing bill, so a smaller one due sooner cannot hide it", async () => {
    // FOUND 2026-10-10, IN REVIEW: "the next rent" was the EARLIEST housing bill due on
    // or after today. A small housing-category fee on the 20th then became "the next
    // rent", the window stayed at 21 days (through Oct 31), and rent on Nov 1 fell
    // outside it — the joint account read short by the fee alone.
    const tables = TABLES();
    tables.recurring.push(bill("fee", "Parking fee", "15.00", 20, "joint", "housing"));
    const body = await ask("finance.next_bills", tables);
    const la = lookAhead(body);
    expect(la.next_rent_on).toBe("2026-11-01");
    expect(la.through).toBe("2026-11-01");
    expect(la.ends_at).toBe("the next rent");
    const joint = rowFor(body, "joint");
    expect(joint.bills.map((b) => `${b.bill}@${b.due}`)).toEqual(["fee@2026-10-20", "rent@2026-11-01"]);
    // 12.50 − 15 (Oct 20) − 1500 (Nov 1): both bills, not the fee alone.
    expect(joint.short_by).toBe(1502.5);
    expect(joint.short_on).toBe("2026-11-01");
  });

  it("does not stretch to a housing row that is not the rent, even when it falls later", async () => {
    // A quarterly housing fee whose next date is in December. Stretching to it would
    // lay two months of bills against today's balance; the window stops at the rent.
    const tables = TABLES();
    tables.recurring.push({ ...bill("hoa", "Quarterly fee", "90.00", 15, "joint", "housing"), cadence: "quarterly", due_days: [15], anchor_date: "2026-12-15" });
    const la = lookAhead(await ask("finance.next_bills", tables));
    expect(la.next_rent_on).toBe("2026-11-01");
    expect(la.through).toBe("2026-11-01");
  });

  it("ends 21 days out when the next rent is already inside that", async () => {
    // Oct 20 in Arizona: the cycle opened on the 15th, and 21 days on is Nov 10 — past
    // rent on the 1st, so the window is the 21 days and rent is simply in it.
    const body = await ask("finance.next_bills", TABLES(), {}, new Date("2026-10-20T20:00:00Z"));
    const la = lookAhead(body);
    expect(la.from).toBe("2026-10-15");
    expect(la.through).toBe("2026-11-10");
    expect(la.ends_at).toBe("21 days from today");
    expect(la.next_rent_on).toBe("2026-11-01");
    const joint = la.by_account.find((r) => r.account === "joint")!;
    expect(joint.bills.map((b) => `${b.bill}@${b.due}`)).toEqual(["rent@2026-11-01", "pet@2026-11-04", "car@2026-11-06"]);
    expect(joint.short_by).toBe(1767.5);
  });

  it("keeps a bill already past its date and still unpaid, owed today", async () => {
    // October's pet payment never happened: due Oct 4, nothing linked, nothing clearing,
    // nothing posted. It is still owed, so it is in — the window opens at the cycle start,
    // exactly as the cycle view keeps it.
    const tables = TABLES();
    tables.transactions = tables.transactions.filter((t) => t.id !== "p-pet");
    const joint = rowFor(await ask("finance.next_bills", tables), "joint");
    expect(joint.bills.map((b) => b.bill)).toEqual(["pet", "rent"]);
    // 12.50 − 80 is already below zero today, and rent takes it to its worst on Nov 1.
    expect(joint.short_by).toBe(1567.5);
    expect(joint.short_on).toBe("2026-11-01");
  });

  it("says an account that can cover its bills is short by 0, not by nothing", async () => {
    const gino = rowFor(await ask("finance.next_bills"), "gino");
    expect(gino.still_to_come).toBe(60);
    expect(gino.short_by).toBe(0);
    expect(gino.short_on).toBeNull();
  });

  it("counts NO pay for an account unless a paycheck row says it lands there", async () => {
    const body = await ask("finance.next_bills");
    const la = lookAhead(body);
    // Oct 15 and Oct 31, both after today and inside the window, placed nowhere.
    expect(la.pay_not_placed).toBe(1800);
    expect(la.pay_not_placed_count).toBe(2);
    for (const r of la.by_account) expect(r.pay_counted).toBe(0);
    expect(String(body.note)).toMatch(/INCOMING PAY IS NOT ASSUMED TO LAND IN ANY ACCOUNT/);
    expect(String(body.note)).toMatch(/look_ahead\.by_account\[\]\.short_by/);
  });

  it("counts the pay when the row names the account, and the shortfall goes away", async () => {
    const tables = TABLES();
    tables.recurring[4] = paycheck({ account_id: "joint" });
    const la = lookAhead(await ask("finance.next_bills", tables));
    const joint = la.by_account.find((r) => r.account === "joint")!;
    expect(joint.pay_counted).toBe(1800);
    // 12.50 + 900 (Oct 15) + 900 (Oct 31) − 1500 (Nov 1) never goes below zero.
    expect(joint.short_by).toBe(0);
    expect(la.pay_not_placed).toBe(0);
  });

  it("walks in date order, so pay that lands AFTER a bill cannot hide it", async () => {
    const tables = TABLES();
    // A big bill on Oct 20 from Gino's account, and one paycheck landing there on the
    // 31st — bigger than the bill, and eleven days too late for it.
    tables.recurring[3] = bill("phone", "Phone", "800.00", 20, "gino", "utilities");
    tables.recurring[4] = paycheck({ account_id: "gino", cadence: "monthly", due_days: [31] });
    const gino = rowFor(await ask("finance.next_bills", tables), "gino");
    // More pay than bills across the window — and still 300 short on the 20th:
    // 500 − 800 on Oct 20, before the 900 lands on Oct 31.
    expect(gino.pay_counted).toBe(900);
    expect(gino.short_by).toBe(300);
    expect(gino.short_on).toBe("2026-10-20");
  });

  it("does not count a bill twice when its payment is already clearing", async () => {
    const tables = TABLES();
    // The phone bill is due on the 9th — overdue — and its payment is pending on Gino's
    // account, so the bank's available balance has already had it taken out.
    tables.recurring[3] = bill("phone", "Phone", "60.00", 9, "gino", "utilities");
    tables.transactions.push({
      id: "pend", date: "2026-10-09", amount: "60.00", type: "expense", status: "pending",
      category_id: "utilities", description: "a payment", account_id: "gino", provider: "plaid",
      created_at: "2026-10-09T12:00:00Z",
    });
    const gino = rowFor(await ask("finance.next_bills", tables), "gino");
    expect(gino.due).toBe(60);
    expect(gino.already_out).toBe(60);
    expect(gino.still_to_come).toBe(0);
    expect(gino.bills[0].already_out).toBe("clearing");
    expect(gino.short_by).toBe(0);
  });
});

describe("finance.bills and finance.bill_calendar say which account pays a bill", () => {
  it("finance.bills carries the account's owner and name, and null where nobody has said", async () => {
    const rows = (await ask("finance.bills")).bills as { id: string; account: Record<string, unknown> | null }[];
    expect(rows.find((r) => r.id === "rent")!.account).toEqual({ id: "joint", owner: "Joint", name: "Joint checking" });
    expect(rows.find((r) => r.id === "phone")!.account).toEqual({ id: "gino", owner: "Gino", name: "Gino checking" });
    expect(rows.find((r) => r.id === "pay")!.account).toBeNull();
  });

  it("finance.bill_calendar carries the same account per bill", async () => {
    const rows = (await ask("finance.bill_calendar", TABLES(), { month: "2026-11" })).bills as {
      bill_id: string;
      account: Record<string, unknown> | null;
    }[];
    expect(rows.find((r) => r.bill_id === "rent")!.account).toEqual({ id: "joint", owner: "Joint", name: "Joint checking" });
  });
});

describe("bill_calendar asks next_bills' question — is an unpaid bill really unpaid?", () => {
  // A payment that has POSTED on the bill's own account, for its exact amount, on its
  // due day, that nothing linked. next_bills calls it maybe_already_paid; bill_calendar
  // used to say only `paid: false` about it.
  const withUnlinked = () => {
    const tables = TABLES();
    tables.recurring[3] = bill("phone", "Phone", "60.00", 8, "gino", "utilities");
    tables.transactions.push({
      id: "posted-phone", date: "2026-10-08", amount: "60.00", type: "expense", status: "posted",
      category_id: "utilities", description: "a payment", account_id: "gino", provider: "plaid",
      created_at: "2026-10-08T12:00:00Z",
    });
    return tables;
  };

  it("names the same posted charge in both tools", async () => {
    const tables = withUnlinked();
    const next = (await ask("finance.next_bills", tables)).bills as { bill: string; maybe_already_paid: { charge: string } | null }[];
    const cal = (await ask("finance.bill_calendar", tables, { month: "2026-10" })).bills as {
      bill_id: string;
      paid: boolean;
      maybe_already_paid: { charge: string } | null;
      paying_now: unknown;
    }[];
    const n = next.find((b) => b.bill === "phone")!;
    const c = cal.find((b) => b.bill_id === "phone")!;
    expect(n.maybe_already_paid?.charge).toBe("posted-phone");
    // The calendar still says paid: false — no charge is LINKED — and now says why that
    // is not the whole story, with the same charge id.
    expect(c.paid).toBe(false);
    expect(c.maybe_already_paid?.charge).toBe("posted-phone");
    expect(c.paying_now).toBeNull();
  });

  it("names a payment still clearing in both tools", async () => {
    const tables = TABLES();
    tables.recurring[3] = bill("phone", "Phone", "60.00", 9, "gino", "utilities");
    tables.transactions.push({
      id: "pend", date: "2026-10-09", amount: "60.00", type: "expense", status: "pending",
      category_id: "utilities", description: "a payment", account_id: "gino", provider: "plaid",
      created_at: "2026-10-09T12:00:00Z",
    });
    const next = (await ask("finance.next_bills", tables)).bills as { bill: string; paying_now: { on: string } | null }[];
    const cal = (await ask("finance.bill_calendar", tables, { month: "2026-10" })).bills as {
      bill_id: string;
      paying_now: { on: string } | null;
    }[];
    expect(next.find((b) => b.bill === "phone")!.paying_now?.on).toBe("2026-10-09");
    expect(cal.find((b) => b.bill_id === "phone")!.paying_now?.on).toBe("2026-10-09");
  });

  it("says nothing extra about a bill that is paid", async () => {
    const cal = (await ask("finance.bill_calendar", TABLES(), { month: "2026-10" })).bills as {
      bill_id: string;
      paid: boolean;
      paying_now: unknown;
      maybe_already_paid: unknown;
    }[];
    const pet = cal.find((b) => b.bill_id === "pet")!;
    expect(pet.paid).toBe(true);
    expect(pet.paying_now).toBeNull();
    expect(pet.maybe_already_paid).toBeNull();
  });

  it("tells the reader paid: false is not the money staying put", async () => {
    const body = await ask("finance.bill_calendar", TABLES(), { month: "2026-10" });
    expect(String(body.note)).toMatch(/PAID: FALSE MEANS NO CHARGE IS LINKED/);
  });
});

describe("the pay floor is described as what it is", () => {
  it("recognises the floor row by what it is, not by its name", () => {
    expect(isPayFloorRow({ direction: "in", owner: "Gino", categoryId: "salary" })).toBe(true);
    expect(isPayFloorRow({ direction: "in", owner: "Xinyan", categoryId: "salary" })).toBe(false);
    expect(isPayFloorRow({ direction: "out", owner: "Gino", categoryId: "salary" })).toBe(false);
    // Two rows that both claim to be the floor is a question, not a figure to pick.
    const row = { direction: "in", owner: "Gino", categoryId: "salary", active: true, amount: 900 };
    expect(payFloorOf([row])).toBe(900);
    expect(payFloorOf([row, { ...row, amount: 950 }])).toBeNull();
  });

  it("firepower reports the floor beside the income it is part of, and the note says so", async () => {
    const body = await ask("finance.firepower");
    expect((body.plan as Record<string, unknown>).gino_pay_floor_per_check).toBe(900);
    const note = String(body.note);
    // FOUND 2026-10-10: "The household's cash floor is not in it and this door does
    // not know it." Both halves were wrong.
    expect(note).not.toMatch(/does not know it/i);
    expect(note).toMatch(/PLANNED, not measured/);
    expect(note).toMatch(/set low on purpose/);
    expect(note).toMatch(/upside/);
    expect(note).toMatch(/Never suggest raising it/);
  });

  it("forecast says only opening_cash is measured, and income is planned", async () => {
    const body = await ask("finance.forecast", TABLES(), { months: 2 });
    expect((body.assumed as Record<string, unknown>).gino_pay_floor_per_check).toBe(900);
    const note = String(body.note);
    // FOUND 2026-10-10: "Bills and income are measured from the bank."
    expect(note).not.toMatch(/income are measured/i);
    expect(note).toMatch(/Only opening_cash is measured/);
    expect(note).toMatch(/Income is PLANNED/);
  });
});
