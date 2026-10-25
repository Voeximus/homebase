// Two write-door fixes from 2026-10-25, driven straight through the tools against the
// in-memory ledger (tests/museFinanceFake.ts), and the self-check that goes with the
// second one.
//
//   1. finance.set_bill_amount could set a variable bill's known_amount and never clear
//      it, so a figure read off one month's bill went on pricing every month after it.
//      clear: true hands the bill back to its rolling estimate.
//   2. A card's minimum payment lives on the debt AND on the bill that pays it, and
//      finance.edit_debt only ever changed the first. It now moves the bill too — but
//      only when the bill was set to the old minimum, because a bill above the minimum
//      is usually a payment somebody chose, and nothing here re-decides a person's choice.
//      selfAudit check 11 flags a bill that plans LESS than its debt's minimum.
//
// Every name, amount and id below is made up.

import { describe, expect, it } from "vitest";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import type { Ctx } from "../supabase/functions/muse-write/kit.ts";
import type { Db } from "../supabase/functions/muse-write/db.ts";
import { FINANCE_WRITE_TOOLS } from "../supabase/functions/muse-write/toolsFinance.ts";
import { TOKEN_SHAPE } from "../supabase/functions/_shared/muse/undo.ts";
import { FinanceFake } from "./museFinanceFake.ts";
import { billExpected } from "../src/lib/plan";
import { debtMinimumShortfalls, selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Debt, Recurring, Transaction } from "../src/types";

const AT = new Date("2026-10-25T19:00:00Z");
const BILL = "99999999-8888-7777-6666-000000000001";
const CARD_BILL = "99999999-8888-7777-6666-000000000002";
const OTHER_BILL = "99999999-8888-7777-6666-000000000003";
const DEBT = "dddd1111-2222-3333-4444-000000000001";

function ctxFor(db: FinanceFake): Ctx {
  const clock = clockNow(AT);
  return {
    db: db as unknown as Db,
    push: () => Promise.resolve(),
    person: "gino",
    at: clock.at,
    az: clock.az,
    appUrl: "https://example.test/homebase/",
  };
}

async function run(db: FinanceFake, tool: string, payload: Record<string, unknown>) {
  return FINANCE_WRITE_TOOLS[tool].run(payload, ctxFor(db));
}

/** Expect the call to land, and hand back its reply. */
async function ok(db: FinanceFake, tool: string, payload: Record<string, unknown>) {
  const out = await run(db, tool, payload);
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error("unreachable");
  return out;
}

/** Expect a refusal, and hand back its status and sentence. */
async function no(db: FinanceFake, tool: string, payload: Record<string, unknown>) {
  const out = await run(db, tool, payload);
  expect(out.ok, JSON.stringify(out)).toBe(false);
  if (out.ok) throw new Error("unreachable");
  return out;
}

const tokenOf = (out: { result: Record<string, unknown> }) => String(out.result.undo);

/** A recurring row the way the table holds it, present-and-null where the real row is. */
const billRow = (over: Record<string, unknown>) => ({
  id: BILL,
  name: "Power bill",
  amount: 90,
  direction: "out",
  cadence: "monthly",
  category_id: "utilities",
  active: true,
  variable: true,
  known_amount: null,
  due_days: [17],
  starts_on: null,
  ends_on: null,
  linked_debt_id: null,
  account_id: null,
  ...over,
});

// ── 1. clearing a recorded figure ─────────────────────────────────────────────

describe("finance.set_bill_amount clear: true hands a variable bill back to its rolling estimate", () => {
  const seeded = (knownAmount: number | null, over: Record<string, unknown> = {}) => {
    const db = new FinanceFake();
    db.tables.recurring.push(billRow({ known_amount: knownAmount, ...over }));
    return db;
  };

  it("is the October override still pricing November: clearing it puts the estimate back in force, and the undo restores it", async () => {
    // What the plan prices the bill at, off the app's own function, before and after —
    // so the test shows the failure itself, not only a column changing.
    const payments: Transaction[] = [80, 84, 88].map((amount, i) => ({
      id: `p${i}`,
      date: `2026-0${7 + i}-17`,
      amount,
      type: "expense",
      categoryId: "utilities",
      description: "Power co",
      appliesTo: { kind: "bill", recurringId: BILL, monthKey: `2026-0${7 + i}`, day: 17 },
      createdAt: "2026-07-17T12:00:00Z",
    }));
    const asRecurring = (db: FinanceFake): Recurring => {
      const r = db.tables.recurring[0];
      return {
        id: BILL,
        name: String(r.name),
        amount: Number(r.amount),
        direction: "out",
        cadence: "monthly",
        active: true,
        variable: true,
        ...(r.known_amount == null ? {} : { knownAmount: Number(r.known_amount) }),
        createdAt: "2026-01-01T00:00:00Z",
      };
    };

    const db = seeded(140);
    // The one-month figure wins over three real payments for as long as it sits there.
    expect(billExpected(asRecurring(db), payments)).toBe(140);

    const before = JSON.parse(JSON.stringify(db.tables));
    const out = await ok(db, "finance.set_bill_amount", { bill_id: BILL, clear: true });
    expect(db.tables.recurring[0].known_amount).toBeNull();
    // ONE column. The stored amount — the fallback until a payment is seen — is untouched.
    expect(db.tables.recurring[0].amount).toBe(90);
    expect(billExpected(asRecurring(db), payments)).toBe(84);
    expect(out.say).toContain("Cleared the $140.00 recorded for Power bill");
    expect(out.say).toContain("rolling estimate");
    expect(out.result).toMatchObject({ column: "known_amount", was: 140, now: null, priced_from: "recent payments" });

    // One change, one token, and it puts the figure back exactly.
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0].tool).toBe("finance.set_bill_amount");
    expect(tokenOf(out)).toMatch(TOKEN_SHAPE);
    await ok(db, "system.undo", { token: tokenOf(out) });
    expect(JSON.parse(JSON.stringify(db.tables))).toEqual(before);
  });

  it("refuses when there is nothing recorded to clear, and changes nothing", async () => {
    const db = seeded(null);
    const r = await no(db, "finance.set_bill_amount", { bill_id: BILL, clear: true });
    expect(r.status).toBe(409);
    expect(r.say).toContain("already priced from its recent real payments");
    expect(db.writes).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
  });

  it("on a fixed bill it clears the figure the app was judging payments against, and says so", async () => {
    // CORRECTED in review 2026-10-25. The first reply said "nothing was reading it" on a
    // fixed bill. Check 6 (settled-means-settled) reads it: a month paid at the stored
    // price fails against a stale figure above it, and passes once it is cleared.
    const NOW = new Date(2026, 9, 25, 12);
    const audit = (knownAmount: number | undefined) => {
      const fixed: Recurring = {
        id: BILL,
        name: "Power bill",
        amount: 90,
        direction: "out",
        cadence: "monthly",
        active: true,
        variable: false,
        dueDays: [17],
        ...(knownAmount === undefined ? {} : { knownAmount }),
        createdAt: "2026-01-01T00:00:00Z",
      };
      const paid: Transaction = {
        id: "p",
        date: "2026-10-17",
        amount: 90,
        type: "expense",
        categoryId: "utilities",
        description: "Power co",
        appliesTo: { kind: "bill", recurringId: BILL, monthKey: "2026-10", day: 17 },
        createdAt: "2026-10-17T12:00:00Z",
      };
      const d: AppData = {
        transactions: [paid],
        debts: [],
        goals: [],
        categories: DEFAULT_CATEGORIES,
        accounts: [],
        recurring: [fixed],
        paidBills: [],
        merchantRules: [],
        foods: [],
      };
      return selfAudit(d, NOW).checks.find((c) => c.id === "settled-means-settled")!.status;
    };
    expect(audit(110)).toBe("fail");
    expect(audit(undefined)).toBe("ok");

    const db = seeded(110, { variable: false });
    const out = await ok(db, "finance.set_bill_amount", { bill_id: BILL, clear: true });
    expect(db.tables.recurring[0].known_amount).toBeNull();
    expect(db.tables.recurring[0].amount).toBe(90);
    expect(out.say).not.toContain("Nothing was reading it");
    expect(out.say).toContain("judging its payments against $110.00");
    expect(out.say).toContain("It judges them against $90.00 now");
    expect(out.result).toMatchObject({ priced_from: "stored amount" });
  });

  it("on a variable transfer it says the estimate is back, because the calendar priced it from the figure", async () => {
    // monthlySchedule prices a variable row that is not income through billExpected, so
    // a transfer's figure WAS its price there. The first version gave it the income line.
    const db = seeded(60, { direction: "transfer" });
    const out = await ok(db, "finance.set_bill_amount", { bill_id: BILL, clear: true });
    expect(db.tables.recurring[0].known_amount).toBeNull();
    expect(out.say).toContain("rolling estimate");
    expect(out.say).not.toContain("Money coming in");
    expect(out.result).toMatchObject({ priced_from: "recent payments" });
  });

  it("on an incoming row it clears the figure and says the planned pay is unchanged", async () => {
    const db = seeded(60, { direction: "in", variable: false, category_id: "salary" });
    const out = await ok(db, "finance.set_bill_amount", { bill_id: BILL, clear: true });
    expect(db.tables.recurring[0].known_amount).toBeNull();
    expect(db.tables.recurring[0].amount).toBe(90);
    expect(out.say).toContain("Money coming in is planned at its stored amount, which is unchanged");
  });

  it("refuses clear and an amount together, and a clear that is not true or false, before reading anything", async () => {
    const tool = FINANCE_WRITE_TOOLS["finance.set_bill_amount"];
    const shape = { az: clockNow(AT).az, at: clockNow(AT).at };
    const both = tool.check!({ bill_id: BILL, clear: true, amount: 50 }, shape);
    expect(both.join(" ")).toContain("not both");
    const yes = tool.check!({ bill_id: BILL, clear: "yes", amount: 50 }, shape);
    expect(yes.join(" ")).toContain("clear is either true or false");
    // And `run` refuses the same way, without touching the ledger.
    const db = seeded(140);
    const r = await no(db, "finance.set_bill_amount", { bill_id: BILL, clear: true, amount: 50 });
    expect(r.status).toBe(400);
    expect(db.tables.recurring[0].known_amount).toBe(140);
    expect(db.changes).toHaveLength(0);
  });

  it("clear: false is the ordinary call and still needs an amount; the amount path is unchanged", async () => {
    const db = seeded(null);
    const r = await no(db, "finance.set_bill_amount", { bill_id: BILL, clear: false });
    expect(r.status).toBe(400);
    await ok(db, "finance.set_bill_amount", { bill_id: BILL, amount: 101.5, clear: false });
    expect(db.tables.recurring[0].known_amount).toBe(101.5);
  });

  it("takes clear in its fields, so the door does not refuse it as an unknown key", () => {
    expect(FINANCE_WRITE_TOOLS["finance.set_bill_amount"].fields).toContain("clear");
  });
});

// ── 2. a new minimum moves the bill that pays the debt ────────────────────────

describe("finance.edit_debt moves the bill that pays the debt with its minimum", () => {
  /** A debt with a minimum on record, and a monthly fixed bill paying it. */
  const seeded = (billAmount: number, over: Record<string, unknown> = {}, oldMinimum: number | null = 40) => {
    const db = new FinanceFake();
    db.tables.debts.push({
      id: DEBT,
      name: "Store card",
      balance: 900,
      provider_account_id: null,
      track_pattern: null,
      apr: 24,
      min_payment: oldMinimum,
    });
    db.tables.recurring.push(
      billRow({
        id: CARD_BILL,
        name: "Store card payment",
        amount: billAmount,
        variable: false,
        category_id: "other",
        due_days: [19],
        linked_debt_id: DEBT,
        ...over,
      }),
    );
    return db;
  };

  it("is the statement that raised the minimum: the bill set to the old minimum moves too, in one change with one undo", async () => {
    const db = seeded(40);
    const before = JSON.parse(JSON.stringify(db.tables));
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(db.tables.debts[0].min_payment).toBe(47);
    expect(db.tables.recurring[0].amount).toBe(47);
    expect(out.say).toContain("Store card payment, the bill that pays it, now costs $47.00 a month too, up from $40.00");
    expect(out.say).not.toContain("which finance.set_bill_amount changes");
    expect(out.result).toMatchObject({ bill_moved: { id: CARD_BILL, was: 40, now: 47 } });
    expect(out.rowIds.sort()).toEqual([CARD_BILL, DEBT].sort());

    // ONE change row carrying both rows, ONE token — so "undo that" puts both back.
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0].state).toBe("undoable");
    expect((db.changes[0].steps as unknown[]).length).toBe(2);
    await ok(db, "system.undo", { token: tokenOf(out) });
    expect(JSON.parse(JSON.stringify(db.tables))).toEqual(before);
  });

  it("follows a minimum that went down, too", async () => {
    const db = seeded(40);
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 33 });
    expect(db.tables.recurring[0].amount).toBe(33);
    expect(out.say).toContain("down from $40.00");
  });

  it("leaves a bill above the old minimum alone — a payment somebody chose is not re-decided", async () => {
    const db = seeded(150);
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(db.tables.debts[0].min_payment).toBe(47);
    expect(db.tables.recurring[0].amount).toBe(150);
    expect(out.say).toContain("reads as a payment somebody chose");
    expect(out.result).toMatchObject({ bill_moved: null });
    // The ordinary one-row change, exactly as before.
    expect((db.changes[0].steps as unknown[]).length).toBe(1);
  });

  it("says so when the bill it left alone is now below the new minimum", async () => {
    const db = seeded(45);
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 50 });
    expect(db.tables.recurring[0].amount).toBe(45);
    expect(out.say).toContain("now below the new minimum");
  });

  it("leaves the bill alone when no minimum was on record before", async () => {
    const db = seeded(40, {}, null);
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(db.tables.recurring[0].amount).toBe(40);
    expect(out.say).toContain("no minimum was on record");
  });

  it("leaves the bill alone when the minimum is cleared or set to zero", async () => {
    const cleared = seeded(40);
    await ok(cleared, "finance.edit_debt", { debt_id: DEBT, min_payment: null });
    expect(cleared.tables.recurring[0].amount).toBe(40);
    const zero = seeded(40);
    const out = await ok(zero, "finance.edit_debt", { debt_id: DEBT, min_payment: 0 });
    expect(zero.tables.recurring[0].amount).toBe(40);
    expect(out.say).toContain("cleared or zero");
  });

  it("leaves a variable bill, a bill that is not monthly, and a pair of bills alone", async () => {
    const variable = seeded(40, { variable: true });
    await ok(variable, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(variable.tables.recurring[0].amount).toBe(40);

    const quarterly = seeded(40, { cadence: "quarterly" });
    await ok(quarterly, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(quarterly.tables.recurring[0].amount).toBe(40);

    const pair = seeded(40);
    pair.tables.recurring.push(billRow({ id: OTHER_BILL, name: "Second payment", amount: 40, variable: false, linked_debt_id: DEBT }));
    const out = await ok(pair, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(pair.tables.recurring.map((r) => r.amount)).toEqual([40, 40]);
    expect(out.say).toContain("2 bills pay this debt");
  });

  it("does not count a bill that has ended as a second payer, but still counts one that has not started", async () => {
    // FOUND in review 2026-10-25: an old bill past its ends_on, still switched on,
    // blocked the move with "2 bills pay this debt". Today here is 2026-10-25.
    const ended = seeded(40);
    ended.tables.recurring.push(
      billRow({ id: OTHER_BILL, name: "Old card payment", amount: 40, variable: false, linked_debt_id: DEBT, ends_on: "2026-09-30" }),
    );
    const out = await ok(ended, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(ended.tables.recurring.map((r) => r.amount)).toEqual([47, 40]);
    expect(out.result).toMatchObject({ bill_moved: { id: CARD_BILL } });

    // A replacement that starts next month will plan whatever it carries, so it is a
    // payer — and with two, the door picks neither. The over-reach this guards against.
    const later = seeded(40);
    later.tables.recurring.push(
      billRow({ id: OTHER_BILL, name: "New card payment", amount: 40, variable: false, linked_debt_id: DEBT, starts_on: "2026-11-01" }),
    );
    const left = await ok(later, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(later.tables.recurring.map((r) => r.amount)).toEqual([40, 40]);
    expect(left.say).toContain("2 bills pay this debt");

    // A bill that ends TODAY still pays this month, so it still counts.
    const today = seeded(40);
    today.tables.recurring.push(
      billRow({ id: OTHER_BILL, name: "Last card payment", amount: 40, variable: false, linked_debt_id: DEBT, ends_on: "2026-10-25" }),
    );
    await ok(today, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(today.tables.recurring.map((r) => r.amount)).toEqual([40, 40]);
  });

  it("ignores a bill that is turned off, and says what it always said when nothing pays the debt", async () => {
    const db = seeded(40, { active: false });
    const out = await ok(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(db.tables.recurring[0].amount).toBe(40);
    expect(out.say).toContain("which finance.set_bill_amount changes");
  });

  it("changes neither row when the bill moved in the gap, and the change is abandoned", async () => {
    const db = seeded(40);
    // The phone sets the bill's amount between the door's read and its write.
    db.onReadBillsPayingDebt = () => {
      db.tables.recurring[0].amount = 60;
    };
    const r = await no(db, "finance.edit_debt", { debt_id: DEBT, min_payment: 47 });
    expect(r.status).toBe(409);
    expect(r.say).toContain("put back what I had already changed");
    // The debt's minimum was written first and put back; the phone's figure stands.
    expect(db.tables.debts[0].min_payment).toBe(40);
    expect(db.tables.recurring[0].amount).toBe(60);
    expect(db.changes[0].state).toBe("abandoned");
  });
});

// ── 3. selfAudit check 11 ─────────────────────────────────────────────────────

describe("selfAudit check 11 — a bill that pays a debt plans at least that debt's minimum", () => {
  const NOW = new Date(2026, 9, 25, 12); // Oct 25 2026, local noon
  const debt = (over: Partial<Debt> = {}): Debt => ({
    id: "d",
    name: "Store card",
    balance: 900,
    originalBalance: 1200,
    minPayment: 47,
    color: "#888888",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  const bill = (over: Partial<Recurring> = {}): Recurring => ({
    id: "b",
    name: "Store card payment",
    amount: 40,
    direction: "out",
    cadence: "monthly",
    active: true,
    dueDays: [19],
    linkedDebtId: "d",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  const data = (recurring: Recurring[], debts: Debt[]): AppData => ({
    transactions: [],
    debts,
    goals: [],
    categories: DEFAULT_CATEGORIES,
    accounts: [],
    recurring,
    paidBills: [],
    merchantRules: [],
    foods: [],
  });
  const check = (d: AppData) => selfAudit(d, NOW).checks.find((c) => c.id === "bill-covers-debt-minimum")!;

  it("is the minimum that rose while the bill stayed put: it fails, and names the bill, the debt and both figures", () => {
    const c = check(data([bill()], [debt()]));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Store card payment plans $40.00 a month for Store card, whose minimum is $47.00");
    expect(debtMinimumShortfalls(data([bill()], [debt()]), NOW)).toEqual([
      { debt: "Store card", bills: ["Store card payment"], plans: 40, minimum: 47, due: 47 },
    ]);
  });

  it("passes the last payment: a bill planning what is left, when less than the minimum is left", () => {
    // FOUND in review 2026-10-25: compared against the bare minimum, a correct final
    // instalment failed. What the lender can take is the smaller of the two.
    expect(check(data([bill({ amount: 18 })], [debt({ balance: 18 })])).status).toBe("ok");
    // Still exact on the other side: planning less than what is left fails, and says
    // what is left rather than the minimum it can no longer reach.
    const c = check(data([bill({ amount: 10 })], [debt({ balance: 18 })]));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Store card payment plans $10.00 a month for Store card, which has $18.00 left to pay");
    // And a balance above the minimum is judged against the minimum, as before.
    expect(check(data([bill({ amount: 40 })], [debt({ balance: 48 })])).status).toBe("fail");
  });

  it("passes a bill set to the minimum, and a bill set ABOVE it — paying more than the minimum is a choice, not a defect", () => {
    expect(check(data([bill({ amount: 47 })], [debt()])).status).toBe("ok");
    expect(check(data([bill({ amount: 150 })], [debt()])).status).toBe("ok");
  });

  it("adds up every live bill that pays one debt", () => {
    const two = [bill({ id: "b1", amount: 25 }), bill({ id: "b2", name: "Second payment", amount: 25 })];
    expect(check(data(two, [debt()])).status).toBe("ok");
    expect(check(data([two[0]], [debt()])).status).toBe("fail");
  });

  it("skips what has nothing to disagree with: a cleared or closed debt, no minimum, a bill off or out of its window", () => {
    expect(check(data([bill()], [debt({ balance: 0 })])).status).toBe("ok");
    expect(check(data([bill()], [debt({ closedAt: "2026-10-01T00:00:00.000Z" })])).status).toBe("ok");
    expect(check(data([bill()], [debt({ minPayment: undefined })])).status).toBe("ok");
    expect(check(data([bill()], [debt({ minPayment: 0 })])).status).toBe("ok");
    expect(check(data([bill({ active: false })], [debt()])).status).toBe("ok");
    expect(check(data([bill({ endsOn: "2026-09-30" })], [debt()])).status).toBe("ok");
    // A bill pointing at a debt that does not exist is check 8's, not this one's.
    expect(check(data([bill({ linkedDebtId: "gone" })], [debt()])).status).toBe("ok");
  });

  it("prices a variable bill the way the plan does — off its recorded figure", () => {
    expect(check(data([bill({ variable: true, amount: 100, knownAmount: 40 })], [debt()])).status).toBe("fail");
    expect(check(data([bill({ variable: true, amount: 10, knownAmount: 60 })], [debt()])).status).toBe("ok");
  });
});
