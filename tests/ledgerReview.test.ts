import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { billKey, merchantKey } from "../src/lib/categorize";
import { setLangVar } from "../src/lib/i18n";
import { REVIEW_STRINGS, reviewLedger, type Suggestion } from "../src/lib/ledgerReview";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Debt, Recurring, Transaction } from "../src/types";

// Every fixture here reproduces one of the six problems a weekly audit by hand
// found on 2026-09-26, plus the negative cases that MUST stay silent. The
// negatives are the real work: a suggestion that fires on a correct ledger is
// worse than no suggestion at all, because it trains him to ignore the panel.
//
// Each test name states its own threshold, so the numbers are readable from the
// test output without opening the engine.

const NOW = new Date(2026, 8, 26, 12); // Sep 26 2026, local noon — the day of the audit

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b",
  name: "Bill",
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  dueDays: [15],
  categoryId: "subscriptions",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const incomeRow = (over: Partial<Recurring> = {}): Recurring =>
  bill({ id: "in", name: "Paycheck", direction: "in", categoryId: undefined, ...over });

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t",
  date: "2026-09-10",
  amount: 20,
  type: "expense",
  categoryId: "shopping",
  description: "Store",
  createdAt: "2026-09-10T12:00:00Z",
  ...over,
});

/** A row the bank feed delivered. */
const bank = (over: Partial<Transaction> = {}): Transaction =>
  txn({ provider: "plaid", accountId: "a1", ...over });

/** A bank row already linked to a bill cycle. */
const paid = (
  recurringId: string,
  monthKey: string,
  day: number,
  over: Partial<Transaction> = {},
): Transaction =>
  bank({
    id: `${recurringId}-${monthKey}`,
    date: `${monthKey}-${String(day).padStart(2, "0")}`,
    appliesTo: { kind: "bill", recurringId, monthKey, day, settled: true },
    ...over,
  });

const debt = (over: Partial<Debt> = {}): Debt => ({
  id: "d",
  name: "Debt",
  balance: 1200,
  originalBalance: 2000,
  color: "#fff",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const data = (over: Partial<AppData> = {}): AppData => ({
  transactions: [],
  debts: [],
  goals: [],
  categories: DEFAULT_CATEGORIES,
  accounts: [],
  recurring: [],
  paidBills: [],
  merchantRules: [],
  foods: [],
  ...over,
});

const kinds = (s: Suggestion[]) => s.map((x) => x.kind);
const rules = (s: Suggestion[]) => s.map((x) => x.rule);

// ── W1 drift — the band is $2 or 3% for a fixed bill, $15 or 15% for a variable one
describe("W1 drift — the app's figure against the LAST charge, never an average", () => {
  const spotify = bill({ id: "spotify", name: "Spotify", amount: 14.04, dueDays: [10] });
  const charges = [
    paid("spotify", "2026-06", 10, { id: "s6", amount: 14.04 }),
    paid("spotify", "2026-07", 10, { id: "s7", amount: 14.04 }),
    paid("spotify", "2026-08", 10, { id: "s8", amount: 14.04 }),
    paid("spotify", "2026-09", 10, { id: "s9", amount: 27.0 }),
  ];

  it("fires on 14.04 modelled against a 27.00 charge — $12.96 past a $2.00 band", () => {
    const out = reviewLedger(data({ recurring: [spotify], transactions: charges }), NOW);
    expect(rules(out)).toEqual(["W1"]);
    expect(out[0].key).toBe("drift:spotify:2700");
    expect(out[0].amount).toBeCloseTo(12.96, 2);
    expect(out[0].evidence.modelled).toBe(14.04);
    expect(out[0].evidence.observed).toBe(27.0);
    expect(out[0].fix).toMatchObject({
      action: "setRecurringAmount",
      recurringId: "spotify",
      field: "amount",
      from: 14.04,
      to: 27.0,
    });
  });

  it("compares the LAST charge, not the mean of three — a mean of 18.36 would keep arguing for two more months", () => {
    // The three older charges average $14.04 and the mean of the last three is
    // $18.36. Either average would call the correct $27.00 wrong. The fix must
    // propose exactly what the biller charged.
    const out = reviewLedger(data({ recurring: [spotify], transactions: charges }), NOW);
    expect(out[0].fix).toMatchObject({ to: 27.0 });
  });

  it("stays silent on a debt-linked row — a card payment of 300.00 against a 129.00 model is a CHOICE", () => {
    const card = bill({
      id: "card",
      name: "Card payment (…4728)",
      amount: 129,
      linkedDebtId: "d",
      variable: true,
      knownAmount: 129,
    });
    const out = reviewLedger(
      data({
        recurring: [card],
        debts: [debt({ id: "d", balance: 3904.83 })],
        transactions: [
          paid("card", "2026-07", 15, { id: "c7", amount: 129 }),
          paid("card", "2026-08", 15, { id: "c8", amount: 129 }),
          paid("card", "2026-09", 15, { id: "c9", amount: 300 }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a variable bill with no knownAmount — that figure IS the average of its own actuals", () => {
    const electric = bill({
      id: "srp",
      name: "Electric (SRP)",
      amount: 85,
      variable: true,
      dueDays: [17],
    });
    const out = reviewLedger(
      data({
        recurring: [electric],
        transactions: [
          paid("srp", "2026-07", 17, { id: "e7", amount: 81.36 }),
          paid("srp", "2026-08", 17, { id: "e8", amount: 132.77 }),
          paid("srp", "2026-09", 17, { id: "e9", amount: 136.0 }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a variable bill inside its band — 95.00 against a known 86.66 is 8.34 of a 15.00 allowance", () => {
    const electric = bill({
      id: "srp",
      name: "Electric (SRP)",
      amount: 85,
      variable: true,
      knownAmount: 86.66,
      dueDays: [17],
    });
    const out = reviewLedger(
      data({
        recurring: [electric],
        transactions: [
          paid("srp", "2026-07", 17, { id: "e7", amount: 81.36 }),
          paid("srp", "2026-08", 17, { id: "e8", amount: 86.66 }),
          paid("srp", "2026-09", 17, { id: "e9", amount: 95.0 }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent when the bill has never been charged — there is no last charge to compare", () => {
    const out = reviewLedger(data({ recurring: [bill({ id: "x", createdAt: "2026-09-20T00:00:00Z" })] }), NOW);
    expect(out).toEqual([]);
  });
});

// ── W2 phantom — THREE closed cycles with nothing charged
describe("W2 phantom — three silent closed cycles, the grace window being seven days", () => {
  const affirm = bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] });

  it("fires on 200.00 a month with no charge in the newest 3 closed cycles (Jul, Aug, Sep)", () => {
    const out = reviewLedger(data({ recurring: [affirm] }), NOW);
    expect(rules(out)).toEqual(["W2"]);
    expect(out[0].key).toBe("phantom:affirm:2026-09");
    expect(out[0].amount).toBe(200);
    expect(out[0].detail).toContain("$600.00"); // three cycles of planned money
    expect(out[0].fix).toMatchObject({ action: "setRecurringActive", to: false });
  });

  it("never proposes a DELETE — deleting a bill row is what left $165 of charges pointing at nothing", () => {
    const out = reviewLedger(data({ recurring: [affirm] }), NOW);
    expect(out[0].fix?.action).toBe("setRecurringActive");
  });

  it("stays silent when the row was created after the oldest of those cycles — only 2 cycles it could have had", () => {
    const out = reviewLedger(
      data({ recurring: [bill({ ...affirm, createdAt: "2026-08-01T00:00:00Z" })] }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent with a charge in the MIDDLE of the three cycles — 2 silent cycles is a coincidence, not a finding", () => {
    const out = reviewLedger(
      data({
        recurring: [affirm],
        transactions: [paid("affirm", "2026-08", 15, { amount: 200 })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent for a bill legitimately ending — endsOn 2026-06-30 means no future month plans for it", () => {
    const dental = bill({
      id: "dental",
      name: "Dental loan",
      amount: 200,
      dueDays: [15],
      endsOn: "2026-06-30",
    });
    const out = reviewLedger(
      data({
        recurring: [dental],
        transactions: [
          paid("dental", "2026-04", 15, { amount: 200 }),
          paid("dental", "2026-05", 15, { amount: 200 }),
          paid("dental", "2026-06", 15, { amount: 200 }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a debt-linked bill whose debt is at $0 — the calendar already drops it and brings it back on its own", () => {
    const out = reviewLedger(
      data({
        recurring: [bill({ id: "card", name: "Card payment (…4728)", amount: 129, linkedDebtId: "d" })],
        debts: [debt({ id: "d", balance: 0 })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a yearly membership — three missed yearly cycles is three years", () => {
    const out = reviewLedger(
      data({
        recurring: [
          bill({
            id: "sams",
            name: "Sam's Club membership",
            amount: 16.22,
            cadence: "yearly",
            anchorDate: "2026-03-16",
            dueDays: [16],
          }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });
});

// ── W4 missing — the newest closed cycle empty, the two before it both paid
describe("W4 missing — one empty cycle behind two clean ones", () => {
  const rent = bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1] });

  it("fires when Jul and Aug were charged 1726.88 and Sep is empty, and offers NO one-tap fix", () => {
    const out = reviewLedger(
      data({
        recurring: [rent],
        transactions: [
          paid("rent", "2026-07", 1, { amount: 1726.88 }),
          paid("rent", "2026-08", 1, { amount: 1726.88 }),
        ],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W4"]);
    expect(out[0].key).toBe("missing:rent:2026-09:0");
    expect(out[0].fix).toBeNull();
    expect(out[0].amount).toBe(1726.88);
  });

  it("cannot fire alongside W2 — one empty cycle after two paid ones is never three empty ones", () => {
    const out = reviewLedger(
      data({
        recurring: [rent],
        transactions: [
          paid("rent", "2026-07", 1, { amount: 1726.88 }),
          paid("rent", "2026-08", 1, { amount: 1726.88 }),
        ],
      }),
      NOW,
    );
    expect(kinds(out)).not.toContain("phantom");
  });

  it("stays silent when only ONE cycle behind it was paid — an erratic bill is not a missing charge", () => {
    const out = reviewLedger(
      data({
        recurring: [rent],
        transactions: [paid("rent", "2026-08", 1, { amount: 1726.88 })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });
});

// ── W3 unmodelled — 3 distinct months, at most months+1 charges, every amount
//    within $2 or 3% of the median
describe("W3 unmodelled repeat — 3 months, ≤ months+1 charges, all within $2-or-3% of the median", () => {
  const sub = (id: string, date: string, amount: number, description = "Grok Ai") =>
    bank({ id, date, amount, description, categoryId: "subscriptions" });

  it("fires on 29.99 charged in exactly 3 of the last 6 months, always the same amount", () => {
    const out = reviewLedger(
      data({
        transactions: [
          sub("g1", "2026-07-22", 29.99),
          sub("g2", "2026-08-22", 29.99),
          sub("g3", "2026-09-22", 29.99),
        ],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W3"]);
    expect(out[0].key).toBe("unmodelled:GROK AI:2999");
    expect(out[0].amount).toBeCloseTo(29.99, 2);
    expect(out[0].fix).toMatchObject({
      action: "addRecurring",
      amount: 29.99,
      dueDay: 22,
      cadence: "monthly",
      categoryId: "subscriptions",
    });
  });

  it("stays silent on the REAL Grok history — 30.00 / 16.00 / 29.99 is outside a $2.00 band, and this is the documented limitation", () => {
    // The charges the rule was written for are "Grok Xai $30.00" (16 Jun),
    // "Grok Xai $16.00" (5 Aug) and "Grok Ai $29.99" (22 Sep): two merchant keys
    // and three amounts. No honest rule catches that from history alone. W7
    // catches the same money from the other side, once a bill row exists.
    const out = reviewLedger(
      data({
        transactions: [
          sub("g1", "2026-06-16", 30.0, "Grok Xai"),
          sub("g2", "2026-08-05", 16.0, "Grok Xai"),
          sub("g3", "2026-09-22", 29.99, "Grok Ai"),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on 38 Sam's Club charges over 4 months — 38 > months+1, so it is a habit", () => {
    const rows: Transaction[] = [];
    let n = 0;
    for (const month of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
      for (let d = 1; d <= 10 && n < 38; d++, n++) {
        rows.push(
          sub(`sc${n}`, `${month}-${String(d).padStart(2, "0")}`, 42.5, "SAM'S CLUB"),
        );
      }
    }
    expect(rows.length).toBe(38);
    const out = reviewLedger(data({ transactions: rows }), NOW);
    expect(out).toEqual([]);
  });

  it("stays silent on a merchant with VARIED amounts in 3 months — 14.00 / 25.19 / 41.80 is far past a $2 band", () => {
    const out = reviewLedger(
      data({
        transactions: [
          sub("c1", "2026-07-11", 14.0, "CHIPOTLE"),
          sub("c2", "2026-08-11", 25.19, "CHIPOTLE"),
          sub("c3", "2026-09-11", 41.8, "CHIPOTLE"),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on the same amount in only 2 months — three is the threshold because two is a coincidence", () => {
    const out = reviewLedger(
      data({ transactions: [sub("g1", "2026-08-22", 29.99), sub("g2", "2026-09-22", 29.99)] }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a brand-new merchant seen once", () => {
    const out = reviewLedger(data({ transactions: [sub("n1", "2026-09-20", 52.0, "NEW PLACE")] }), NOW);
    expect(out).toEqual([]);
  });

  it("stays silent when a bill of that exact name is already modelled — the charges are W7's business, not W3's", () => {
    const out = reviewLedger(
      data({
        recurring: [bill({ id: "grok", name: "Grok Ai", amount: 29.99, dueDays: [22], createdAt: "2026-09-25T00:00:00Z" })],
        transactions: [
          sub("g1", "2026-07-22", 29.99),
          sub("g2", "2026-08-22", 29.99),
          sub("g3", "2026-09-22", 29.99),
        ],
      }),
      NOW,
    );
    expect(kinds(out)).not.toContain("unmodelled");
  });

  it("blocks the one-tap fix when the charges live in an ungraded category — a bill row in `other` is the utilities defect again", () => {
    const out = reviewLedger(
      data({
        transactions: [
          sub("g1", "2026-07-22", 29.99, "Grok Ai"),
          sub("g2", "2026-08-22", 29.99, "Grok Ai"),
          sub("g3", "2026-09-22", 29.99, "Grok Ai"),
        ].map((r) => ({ ...r, categoryId: "other" })),
      }),
      NOW,
    );
    expect(out[0].fix).toMatchObject({ action: "addRecurring", blockedReason: "Give it a category first" });
  });
});

// ── W5 duplicate
describe("W5a duplicate — same account, same date, same amount, one hand-entered and one from the bank", () => {
  it("fires on 151.72 twice on 2026-09-24 in account a1, one manual and one bank", () => {
    const out = reviewLedger(
      data({
        transactions: [
          bank({ id: "b1", date: "2026-09-24", amount: 151.72, description: "Cherry" }),
          txn({ id: "m1", date: "2026-09-24", amount: 151.72, description: "Cherry", accountId: "a1" }),
        ],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W5a"]);
    expect(out[0].key).toBe("duplicate:b1:m1");
    expect(out[0].fix).toMatchObject({ action: "deleteTransaction", txnId: "m1" });
  });

  it("never offers to delete the BANK row — Plaid re-delivers it and real history cannot be rebuilt", () => {
    const out = reviewLedger(
      data({
        transactions: [
          bank({ id: "b1", date: "2026-09-24", amount: 151.72 }),
          txn({ id: "m1", date: "2026-09-24", amount: 151.72, accountId: "a1" }),
        ],
      }),
      NOW,
    );
    expect(out[0].fix).toMatchObject({ txnId: "m1" });
  });

  it("stays silent on two real identical parking charges on one day — both from the bank, so neither is hand-entered", () => {
    const rows = [
      bank({ id: "p1", date: "2026-09-08", amount: 6.0, description: "PARKINSAFE NOLLIE" }),
      bank({ id: "p2", date: "2026-09-08", amount: 6.0, description: "PARKINSAFE NOLLIE" }),
    ];
    expect(reviewLedger(data({ transactions: rows }), NOW)).toEqual([]);
    // Positive control: the ONLY thing keeping this quiet is that both rows came
    // from the bank. Make one hand-entered and the same fixture fires, which is
    // what proves this negative is a real trap and not a vacuous pass.
    const mixed = [rows[0], { ...rows[1], provider: undefined }];
    expect(rules(reviewLedger(data({ transactions: mixed }), NOW))).toEqual(["W5a"]);
  });

  it("stays silent on the same amount on the same day in DIFFERENT accounts", () => {
    const out = reviewLedger(
      data({
        transactions: [
          bank({ id: "r1", date: "2026-09-15", amount: 1.8, description: "365 RETAIL MARKETS" }),
          txn({ id: "r2", date: "2026-09-15", amount: 1.8, description: "365 RETAIL MARKETS", accountId: "a2" }),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("offers no fix when TWO hand-entered rows sit in the group — the engine cannot tell which is the extra", () => {
    const out = reviewLedger(
      data({
        transactions: [
          bank({ id: "b1", date: "2026-09-24", amount: 60.0, description: "BKOFAMERICA ATM" }),
          txn({ id: "m1", date: "2026-09-24", amount: 60.0, description: "BKOFAMERICA ATM", accountId: "a1" }),
          txn({ id: "m2", date: "2026-09-24", amount: 60.0, description: "BKOFAMERICA ATM", accountId: "a1" }),
        ],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W5a"]);
    expect(out[0].fix).toBeNull();
  });
});

describe("W5b duplicate — a hand marker claims the BILL while the bank row claims the DEBT, same cycle", () => {
  const cherry = bill({
    id: "cherry",
    name: "Cherry",
    amount: 151.72,
    dueDays: [24],
    linkedDebtId: "cherrydebt",
    createdAt: "2026-08-20T00:00:00Z",
  });
  const marker = txn({
    id: "m1",
    date: "2026-09-24",
    amount: 151.72,
    description: "Cherry (already paid)",
    appliesTo: { kind: "bill", recurringId: "cherry", monthKey: "2026-09", day: 24, settled: true },
  });
  const bankRow = bank({
    id: "b1",
    date: "2026-09-24",
    amount: 151.72,
    description: "CHERRY TECHNOLOGY",
    appliesTo: { kind: "debt", debtId: "cherrydebt" },
  });

  it("fires on a 151.72 marker and a 151.72 bank charge inside the same seven-day cycle window", () => {
    const out = reviewLedger(
      data({
        recurring: [cherry],
        debts: [debt({ id: "cherrydebt", name: "Cherry" })],
        transactions: [marker, bankRow],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W5b"]);
    expect(out[0].key).toBe("duplicate:b1:m1");
    expect(out[0].fix).toMatchObject({ action: "deleteTransaction", txnId: "m1" });
    expect(out[0].detail).toContain("$151.72");
  });

  it("stays silent when the bank payment is a different size — 50.00 against 151.72 is past a $4.55 band, so it is an extra payment", () => {
    const out = reviewLedger(
      data({
        recurring: [cherry],
        debts: [debt({ id: "cherrydebt", name: "Cherry" })],
        transactions: [marker, { ...bankRow, amount: 50.0 }],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent when the bill carries no linkedDebtId — there is nothing for the bank row to have claimed", () => {
    const out = reviewLedger(
      data({
        recurring: [bill({ ...cherry, linkedDebtId: undefined })],
        transactions: [marker, { ...bankRow, appliesTo: undefined }],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent when two rows already claim the cycle — that is an exact CHECK failure, not a suggestion", () => {
    const out = reviewLedger(
      data({
        recurring: [cherry],
        debts: [debt({ id: "cherrydebt", name: "Cherry" })],
        transactions: [marker, paid("cherry", "2026-09", 24, { id: "x1", amount: 151.72 }), bankRow],
      }),
      NOW,
    );
    expect(kinds(out)).not.toContain("duplicate");
  });
});

// ── W6 income that landed once
describe("W6 one-off income — exactly ONE matching month, band $15-or-15%, row at least 2 months old", () => {
  const carIns = incomeRow({
    id: "carins",
    name: "Car insurance check",
    amount: 1100,
    createdAt: "2026-06-20T00:00:00Z",
  });
  const deposit = (id: string, date: string, amount = 1137.2) =>
    bank({ id, date, amount, type: "income", categoryId: "income", description: "Deposit" });

  it("fires on 1100.00 expected and a single 1137.20 deposit — 3.4% out, inside the 15% band", () => {
    const out = reviewLedger(
      data({ recurring: [carIns], transactions: [deposit("dep1", "2026-09-25")] }),
      NOW,
    );
    expect(rules(out)).toEqual(["W6"]);
    expect(out[0].key).toBe("income-landed:carins:dep1");
    expect(out[0].fix).toMatchObject({
      action: "setRecurringWindow",
      field: "endsOn",
      to: "2026-09-30",
    });
  });

  it("sets endsOn rather than deactivating — past months must still show the income they really had", () => {
    const out = reviewLedger(
      data({ recurring: [carIns], transactions: [deposit("dep1", "2026-09-25")] }),
      NOW,
    );
    expect(out[0].fix?.action).toBe("setRecurringWindow");
  });

  it("stays silent when matching deposits landed in 3 months — real recurring income matches in many months", () => {
    const out = reviewLedger(
      data({
        recurring: [carIns],
        transactions: [
          deposit("d1", "2026-07-25"),
          deposit("d2", "2026-08-25"),
          deposit("d3", "2026-09-25"),
        ],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent for a row created 3 weeks ago — 2 months of age before a new paycheck may be accused", () => {
    const out = reviewLedger(
      data({
        recurring: [incomeRow({ ...carIns, createdAt: "2026-09-05T00:00:00Z" })],
        transactions: [deposit("dep1", "2026-09-25")],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent when the row already carries an endsOn — it has been judged once already", () => {
    const out = reviewLedger(
      data({
        recurring: [incomeRow({ ...carIns, endsOn: "2026-09-30" })],
        transactions: [deposit("dep1", "2026-09-25")],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });
});

// ── W7 a charge that matches a bill you already model
describe("W7 unlinked — EXACT normalized name plus the amount band, one suggestion per cycle", () => {
  const prime = (over: Partial<Recurring> = {}) =>
    bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], ...over });
  const primeCharge = (id: string, date: string, amount = 16.2) =>
    bank({ id, date, amount, description: "Amazon Prime", categoryId: "shopping" });

  it("fires on a 16.20 'Amazon Prime' charge against a 16.20 Amazon Prime bill due on the 23rd", () => {
    const out = reviewLedger(
      data({
        recurring: [prime({ createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [primeCharge("p1", "2026-09-23")],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W7"]);
    expect(out[0].key).toBe("unlinked:prime:2026-09:p1");
    expect(out[0].fix).toMatchObject({
      action: "linkTransactionToBill",
      txnId: "p1",
      recurringId: "prime",
      monthKey: "2026-09",
      day: 23,
      installmentIndex: 0,
    });
  });

  it("finds all three months of the live Amazon Prime case, and silences W2 and W3 while doing it", () => {
    const out = reviewLedger(
      data({
        recurring: [prime()],
        transactions: [
          primeCharge("p7", "2026-07-23"),
          primeCharge("p8", "2026-08-24"),
          primeCharge("p9", "2026-09-23"),
        ],
      }),
      NOW,
    );
    expect(rules(out)).toEqual(["W7", "W7", "W7"]);
    expect(out.map((s) => s.evidence.monthKey).sort()).toEqual(["2026-07", "2026-08", "2026-09"]);
  });

  it("keeps ONE suggestion for a cycle two charges both land in — the one nearer the due day wins", () => {
    // The seven-day grace puts an 08-31 charge on the September cycle, and the
    // 09-23 charge is nearer the 23rd. The loser gets no card at all: two
    // charges, one cycle, is out of scope rather than a guess.
    const out = reviewLedger(
      data({
        recurring: [prime({ createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [primeCharge("late", "2026-08-31"), primeCharge("near", "2026-09-23")],
      }),
      NOW,
    );
    expect(out.length).toBe(1);
    expect(out[0].evidence.txnIds).toEqual(["near"]);
  });

  it("stays silent on a $130 Sam's Club run against a $16.22 Sam's Club membership bill", () => {
    const out = reviewLedger(
      data({
        recurring: [
          bill({
            id: "sams",
            name: "Sam's Club membership",
            amount: 16.22,
            cadence: "yearly",
            anchorDate: "2026-03-16",
            dueDays: [16],
          }),
        ],
        transactions: [bank({ id: "s1", date: "2026-09-12", amount: 130, description: "SAM'S CLUB #4728" })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a 16.22 SAM'S CLUB charge too — a PREFIX match would settle the membership cycle with a store run", () => {
    // Proof the fixture is a real trap: the charge's key IS a prefix of the
    // bill's key, the amounts are identical and the day is the due day. Reusing
    // matchRecurringName's prefix arm here would settle the yearly membership
    // cycle with a store run. Exact equality is the only thing holding.
    expect(billKey("Sam's Club membership").startsWith(billKey(merchantKey("SAM'S CLUB")))).toBe(true);
    const out = reviewLedger(
      data({
        recurring: [
          bill({
            id: "sams",
            name: "Sam's Club membership",
            amount: 16.22,
            cadence: "yearly",
            anchorDate: "2026-09-16",
            dueDays: [16],
          }),
        ],
        transactions: [bank({ id: "s1", date: "2026-09-16", amount: 16.22, description: "SAM'S CLUB" })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent on a 25.19 Chipotle on the 11th against a 27.00 Spotify bill on the 10th — day+amount would have paired them", () => {
    // |25.19 − 27.00| = 1.81, inside the $2.00 band, one day from the due day.
    // The feed's day+amount arm is only safe after the categorizer has already
    // decided a charge is a bill; out here the exact name is the only guard.
    expect(Math.abs(25.19 - 27.0)).toBeLessThanOrEqual(Math.max(2, 0.03 * 27.0));
    const out = reviewLedger(
      data({
        recurring: [
          bill({ id: "spotify", name: "Spotify", amount: 27.0, dueDays: [10], createdAt: "2026-09-01T00:00:00Z" }),
        ],
        transactions: [bank({ id: "c1", date: "2026-09-11", amount: 25.19, description: "CHIPOTLE 2094" })],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent when the cycle is already settled by a linked charge", () => {
    const out = reviewLedger(
      data({
        recurring: [prime({ createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [paid("prime", "2026-09", 23, { amount: 16.2 }), primeCharge("p1", "2026-09-23")],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("stays silent outside the amount band — a 159.00 AMAZON PRIME order is not the 16.20 subscription", () => {
    const out = reviewLedger(
      data({
        recurring: [prime({ createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [primeCharge("p1", "2026-09-23", 159.0)],
      }),
      NOW,
    );
    expect(out).toEqual([]);
  });
});

// ── the three gates that apply to every rule
describe("the three gates — posted only, the row must have existed, windows honoured", () => {
  it("a PENDING row is never evidence, in any rule's position", () => {
    const pend = (t: Transaction) => ({ ...t, pending: true });

    const drift = reviewLedger(
      data({
        recurring: [bill({ id: "spotify", name: "Spotify", amount: 14.04, dueDays: [10], createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [pend(paid("spotify", "2026-09", 10, { amount: 27.0 }))],
      }),
      NOW,
    );
    expect(kinds(drift)).not.toContain("drift");

    const unmodelled = reviewLedger(
      data({
        transactions: [
          pend(bank({ id: "g1", date: "2026-07-22", amount: 29.99, description: "Grok Ai" })),
          pend(bank({ id: "g2", date: "2026-08-22", amount: 29.99, description: "Grok Ai" })),
          pend(bank({ id: "g3", date: "2026-09-22", amount: 29.99, description: "Grok Ai" })),
        ],
      }),
      NOW,
    );
    expect(unmodelled).toEqual([]);

    const dupe = reviewLedger(
      data({
        transactions: [
          bank({ id: "b1", date: "2026-09-24", amount: 151.72 }),
          pend(txn({ id: "m1", date: "2026-09-24", amount: 151.72, accountId: "a1" })),
        ],
      }),
      NOW,
    );
    expect(dupe).toEqual([]);

    const landed = reviewLedger(
      data({
        recurring: [incomeRow({ id: "carins", amount: 1100, createdAt: "2026-06-20T00:00:00Z" })],
        transactions: [pend(bank({ id: "d1", date: "2026-09-25", amount: 1137.2, type: "income" }))],
      }),
      NOW,
    );
    expect(landed).toEqual([]);

    const unlinked = reviewLedger(
      data({
        recurring: [bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [pend(bank({ id: "p1", date: "2026-09-23", amount: 16.2, description: "Amazon Prime" }))],
      }),
      NOW,
    );
    expect(unlinked).toEqual([]);
  });

  it("a cycle outside startsOn/endsOn is not a cycle — a bill dormant until November is silent", () => {
    const out = reviewLedger(
      data({ recurring: [bill({ id: "mom", name: "Mom", amount: 300, dueDays: [15], startsOn: "2026-11-01" })] }),
      NOW,
    );
    expect(out).toEqual([]);
  });
});

// ── dismissal
describe("dismissal — the key carries the evidence, so it re-surfaces on its own when the numbers move", () => {
  const cases: { name: string; data: AppData }[] = [
    {
      name: "drift",
      data: data({
        recurring: [bill({ id: "spotify", name: "Spotify", amount: 14.04, dueDays: [10] })],
        transactions: [
          paid("spotify", "2026-07", 10, { id: "s7", amount: 14.04 }),
          paid("spotify", "2026-08", 10, { id: "s8", amount: 14.04 }),
          paid("spotify", "2026-09", 10, { id: "s9", amount: 27.0 }),
        ],
      }),
    },
    { name: "phantom", data: data({ recurring: [bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] })] }) },
    {
      name: "missing",
      data: data({
        recurring: [bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1] })],
        transactions: [
          paid("rent", "2026-07", 1, { amount: 1726.88 }),
          paid("rent", "2026-08", 1, { amount: 1726.88 }),
        ],
      }),
    },
    {
      name: "unmodelled",
      data: data({
        transactions: [
          bank({ id: "g1", date: "2026-07-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
          bank({ id: "g2", date: "2026-08-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
          bank({ id: "g3", date: "2026-09-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
        ],
      }),
    },
    {
      name: "duplicate",
      data: data({
        transactions: [
          bank({ id: "b1", date: "2026-09-24", amount: 151.72 }),
          txn({ id: "m1", date: "2026-09-24", amount: 151.72, accountId: "a1" }),
        ],
      }),
    },
    {
      name: "income-landed",
      data: data({
        recurring: [incomeRow({ id: "carins", amount: 1100, createdAt: "2026-06-20T00:00:00Z" })],
        transactions: [bank({ id: "d1", date: "2026-09-25", amount: 1137.2, type: "income" })],
      }),
    },
    {
      name: "unlinked",
      data: data({
        recurring: [bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], createdAt: "2026-09-01T00:00:00Z" })],
        transactions: [bank({ id: "p1", date: "2026-09-23", amount: 16.2, description: "Amazon Prime" })],
      }),
    },
  ];

  for (const c of cases) {
    it(`a dismissed ${c.name} key yields nothing`, () => {
      const first = reviewLedger(c.data, NOW);
      expect(first.length).toBe(1);
      expect(reviewLedger(c.data, NOW, [first[0].key])).toEqual([]);
    });
  }

  it("a drift key carries the charge in cents, so a further drift asks again", () => {
    const base = cases[0].data;
    const dismissed = [reviewLedger(base, NOW)[0].key];
    const worse = {
      ...base,
      transactions: base.transactions.map((t) =>
        t.id === "s9" ? { ...t, amount: 35.0 } : t,
      ),
    };
    const out = reviewLedger(worse, NOW, dismissed);
    expect(out.map((s) => s.key)).toEqual(["drift:spotify:3500"]);
  });
});

// ── a bill billed in INSTALLMENTS ─────────────────────────────────────────────
//
// The calendar divides a row's figure by its due-day count (schedule.ts), so on a
// row with two due days the row's own figure is the MONTH's and a single charge is
// half of it. Every rule that compared the two, or counted cycles while speaking
// in months, was wrong on exactly one live row: Mom, $300, due on the 15th and the
// 30th. These tests are that row.
describe("a bill paid in two installments a month", () => {
  const mom = (amount: number) =>
    bill({ id: "mom", name: "Mom", amount, dueDays: [15, 30], categoryId: "kids" });
  const cycle = (monthKey: string, day: number, idx: number, amount: number): Transaction =>
    bank({
      id: `mom-${monthKey}-${day}`,
      date: `${monthKey}-${String(day).padStart(2, "0")}`,
      amount,
      description: "Zelle payment to Mom",
      appliesTo: { kind: "bill", recurringId: "mom", monthKey, day, installmentIndex: idx, settled: true },
    });

  // W1 read one $300 installment against the $600 month and called the price
  // halved, then offered to write $300 into the plan. One tap would have taken $300
  // a month out of the household's fixed costs on a bill that was already right.
  it("W1 stays silent on a correctly modelled $600 a month paid $300 twice, and offers no fix", () => {
    const out = reviewLedger(
      data({
        recurring: [mom(600)],
        transactions: [cycle("2026-09", 15, 0, 300), cycle("2026-08", 30, 1, 300)],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W1")).toEqual([]);
    expect(out.some((s) => s.fix?.action === "setRecurringAmount")).toBe(false);
  });

  // W2 counted three CYCLES and then wrote the sentence in MONTHS: Aug 15, Aug 30
  // and Sep 15 came out as "August 2026, August 2026, September 2026" and $900 of
  // planned money, for six weeks.
  it("W2 names three DIFFERENT months and claims three months of money", () => {
    const w2 = reviewLedger(data({ recurring: [mom(300)] }), NOW).find((s) => s.rule === "W2")!;
    expect(w2).toBeTruthy();
    expect(w2.detail).toContain("July 2026, August 2026, September 2026");
    expect(w2.detail).toContain("$900.00 of planned money");
    // The month must not be named twice, whatever the wording becomes.
    expect(w2.detail.match(/August 2026/g)).toHaveLength(1);
  });

  it("W2 needs three silent MONTHS, so a row silent for six weeks is not called finished", () => {
    // July fully paid, then nothing: two silent months, which is a coincidence a
    // real household has, not a finished bill.
    const out = reviewLedger(
      data({
        recurring: [mom(300)],
        transactions: [cycle("2026-07", 15, 0, 150), cycle("2026-07", 30, 1, 150)],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W2")).toEqual([]);
  });

  // W4 named the whole month's figure beside ONE due day — "Mom is $300.00, due on
  // the 15th" — and repeated a month in the list of the ones that were charged.
  it("W4 names the price of THAT payment and each paid month once", () => {
    const w4 = reviewLedger(
      data({
        recurring: [mom(300)],
        transactions: [
          cycle("2026-07", 15, 0, 150),
          cycle("2026-07", 30, 1, 150),
          cycle("2026-08", 15, 0, 150),
          cycle("2026-08", 30, 1, 150),
        ],
      }),
      NOW,
    ).find((s) => s.rule === "W4")!;
    expect(w4).toBeTruthy();
    expect(w4.detail).toContain("Mom is $150.00, due on the 15th");
    expect(w4.detail).toContain("It was charged in July 2026, August 2026,");
    expect(w4.amount).toBeCloseTo(150, 2);
  });

  it("a single-installment bill is unchanged — the divisor only ever applies to installments", () => {
    const rent = bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1], categoryId: "housing" });
    const w4 = reviewLedger(
      data({
        recurring: [rent],
        transactions: [
          paid("rent", "2026-07", 1, { id: "r7", amount: 1726.88 }),
          paid("rent", "2026-08", 1, { id: "r8", amount: 1726.88 }),
        ],
      }),
      NOW,
    ).find((s) => s.rule === "W4")!;
    expect(w4.detail).toContain("Rent is $1,726.88, due on the 1st");
    expect(w4.detail).toContain("It was charged in July 2026, August 2026,");
  });
});

// ── W6 and the cadences it may judge ──────────────────────────────────────────
describe("W6 fires only on income that arrives at least monthly", () => {
  // "Matched in exactly one month" IS the expected state for a yearly row, so the
  // one card the app showed said a correct tax refund had already come in, and its
  // fix would have written an end date onto live recurring income.
  it("stays silent on a correct YEARLY income row with its one real deposit", () => {
    const yearly = incomeRow({
      id: "refund",
      name: "Tax refund",
      cadence: "yearly",
      amount: 1200,
      createdAt: "2026-01-02T00:00:00Z",
    });
    const out = reviewLedger(
      data({
        recurring: [yearly],
        transactions: [
          bank({ id: "dep", type: "income", date: "2026-03-14", amount: 1200, description: "IRS TREAS 310" }),
        ],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W6")).toEqual([]);
    expect(out.some((s) => s.fix?.action === "setRecurringWindow")).toBe(false);
  });

  it("still fires on a MONTHLY income row that landed once — the case it was written for", () => {
    const monthly = incomeRow({
      id: "carins",
      name: "Car insurance check",
      amount: 1100,
      createdAt: "2026-06-20T00:00:00Z",
    });
    const out = reviewLedger(
      data({
        recurring: [monthly],
        transactions: [
          bank({ id: "dep", type: "income", date: "2026-09-25", amount: 1137.2, description: "Insurance" }),
        ],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W6")).toHaveLength(1);
  });
});

// ── W3 and the bank's own words ───────────────────────────────────────────────
describe("W3 groups by merchant key, so the descriptors have to agree too", () => {
  const checkcard = (id: string, date: string, tail: string): Transaction =>
    bank({ id, date, amount: 9.99, description: `CHECKCARD 0${date.slice(5, 7)}21 ${tail}`, categoryId: "dining" });

  // merchantKey strips the trailing digits, so "CHECKCARD 0921 TC @ TSMC ARIZONA
  // 199 PHOENIX AZ" collapses to the bare word CHECKCARD — and on the live ledger
  // that one key holds a cafeteria charge, a service charge and an MVD fee, in
  // three different months. Same amount and the card would have said three
  // unrelated merchants were one subscription.
  it("stays silent when one key holds three different merchants", () => {
    const out = reviewLedger(
      data({
        transactions: [
          checkcard("x1", "2026-07-21", "TC @ TSMC ARIZONA"),
          checkcard("x2", "2026-08-21", "SERVICE CHARGE"),
          checkcard("x3", "2026-09-21", "AZ MVD FEE"),
        ],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W3")).toEqual([]);
  });

  it("still fires when every descriptor is the same text — only the digits may move", () => {
    const out = reviewLedger(
      data({
        transactions: [
          checkcard("y1", "2026-07-21", "TC @ TSMC ARIZONA"),
          checkcard("y2", "2026-08-21", "TC @ TSMC ARIZONA"),
          checkcard("y3", "2026-09-21", "TC @ TSMC ARIZONA"),
        ],
      }),
      NOW,
    );
    expect(out.filter((s) => s.rule === "W3")).toHaveLength(1);
  });

  it("keeps a long bank descriptor out of the headline and puts it in the evidence line", () => {
    const long = (id: string, date: string) =>
      bank({
        id,
        date,
        amount: 3.26,
        description: `CHECKCARD 0${date.slice(5, 7)}21 TC @ TSMC ARIZONA 199 PHOENIX AZ`,
        categoryId: "dining",
      });
    const w3 = reviewLedger(
      data({ transactions: [long("l1", "2026-07-21"), long("l2", "2026-08-21"), long("l3", "2026-09-21")] }),
      NOW,
    ).find((s) => s.rule === "W3")!;
    expect(w3.title).toBe("A repeat charge looks like a monthly subscription");
    expect(w3.detail).toContain("TC @ TSMC ARIZONA");
  });

  it("names a merchant that fits, and picks the SHORTEST descriptor for the bill it would create", () => {
    const grok = (id: string, date: string, desc: string) =>
      bank({ id, date, amount: 29.99, description: desc, categoryId: "subscriptions" });
    const w3 = reviewLedger(
      data({
        transactions: [
          grok("g1", "2026-07-22", "Grok Ai 07/22"),
          grok("g2", "2026-08-22", "Grok Ai"),
          grok("g3", "2026-09-22", "Grok Ai 09/22"),
        ],
      }),
      NOW,
    ).find((s) => s.rule === "W3")!;
    expect(w3.title).toBe("Grok Ai looks like a monthly subscription");
    expect(w3.fix).toMatchObject({ action: "addRecurring", name: "Grok Ai" });
  });
});

// ── W5a and where a row came from ─────────────────────────────────────────────
describe("W5a — an imported row is not a hand-entered one", () => {
  // commitImport() writes no provider and an accountId, so a statement row read as
  // "entered by hand" beside the bank's own copy of it — and applyFix refuses every
  // record-only delete, so the card's only button could never succeed.
  it("stays silent on an imported record-only row beside its bank twin", () => {
    const out = reviewLedger(
      data({
        transactions: [
          bank({ id: "b", date: "2026-09-08", amount: 63.41, description: "Safeway" }),
          txn({ id: "imp", accountId: "a1", recordOnly: true, date: "2026-09-08", amount: 63.41, description: "Safeway" }),
        ],
      }),
      NOW,
    );
    expect(out.filter((s) => s.kind === "duplicate")).toEqual([]);
  });

  it("says 'two charges' in words, and calls a deposit a deposit", () => {
    const pair = (type: "expense" | "income") =>
      data({
        transactions: [
          bank({ id: "b", type, date: "2026-09-24", amount: 151.72, description: "Cherry" }),
          txn({ id: "m", accountId: "a1", type, date: "2026-09-24", amount: 151.72, description: "Cherry (already paid)" }),
        ],
      });
    const charge = reviewLedger(pair("expense"), NOW).find((s) => s.rule === "W5a")!;
    expect(charge.title).toBe("This charge may be in twice");
    expect(charge.detail).toContain("Two charges of $151.72");
    expect(charge.detail).not.toMatch(/^2 charges/);

    const deposit = reviewLedger(pair("income"), NOW).find((s) => s.rule === "W5a")!;
    expect(deposit.title).toBe("This deposit may be in twice");
    expect(deposit.detail).toContain("Two deposits of $151.72");
  });
});

// ── W7 says which month ───────────────────────────────────────────────────────
describe("W7 names the month, because one bill can produce several of these at once", () => {
  it("puts the month in the headline and the sentence, and never says 'cycle'", () => {
    const prime = bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], createdAt: "2026-06-01T00:00:00Z" });
    const out = reviewLedger(
      data({
        recurring: [prime],
        transactions: [
          bank({ id: "p1", date: "2026-07-23", amount: 16.2, description: "Amazon Prime" }),
          bank({ id: "p2", date: "2026-08-24", amount: 16.2, description: "Amazon Prime" }),
          bank({ id: "p3", date: "2026-09-23", amount: 16.2, description: "Amazon Prime" }),
        ],
      }),
      NOW,
    ).filter((s) => s.rule === "W7");
    expect(out).toHaveLength(3);
    // Three cards, three different titles — on a phone they are otherwise the same
    // title, the same amount and the same button, each settling a different month.
    expect(new Set(out.map((s) => s.title)).size).toBe(3);
    for (const s of out) {
      expect(s.title).toMatch(/for (July|August|September) 2026$/);
      expect(s.detail).not.toMatch(/cycle/i);
      expect(s.detail).toContain("is still showing as unpaid");
    }
  });
});

// ── the day, in the other language ────────────────────────────────────────────
describe("the due day reads correctly in Simplified Chinese", () => {
  // The ZH templates say "{day} 号", so an English ordinal suffix lands in front of
  // the Chinese marker and reads as a typo: "每月 23rd 号到期".
  it("says the day as a bare number under zh, and keeps the suffix under en", () => {
    const prime = bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], createdAt: "2026-09-01T00:00:00Z" });
    const live = data({
      recurring: [prime],
      transactions: [bank({ id: "p1", date: "2026-09-23", amount: 16.2, description: "Amazon Prime" })],
    });
    try {
      setLangVar("zh");
      const zh = reviewLedger(live, NOW).find((s) => s.rule === "W7")!;
      expect(zh.detail).toContain("23 号");
      expect(zh.detail).not.toContain("23rd");
    } finally {
      setLangVar("en");
    }
    const en = reviewLedger(live, NOW).find((s) => s.rule === "W7")!;
    expect(en.detail).toContain("due on the 23rd");
  });
});

// ── the contract
describe("the contract — pure, total, ordered, and free of any confidence claim", () => {
  it("an empty ledger yields no suggestions", () => {
    expect(reviewLedger(data(), NOW)).toEqual([]);
  });

  it("odd and missing data never throws", () => {
    const broken = {
      transactions: [
        { id: "x", date: "", amount: NaN, type: "expense", categoryId: "", description: "", createdAt: "" },
        null,
        { id: "y", date: "2026-09-01", amount: 10, type: "expense", categoryId: "a", description: "A", createdAt: "", appliesTo: { kind: "bill", recurringId: "gone" } },
      ],
      recurring: [
        null,
        { id: "r", name: "", amount: 0, direction: "out", cadence: "monthly", active: true, createdAt: "" },
        { id: "r2", name: "No days", amount: 50, direction: "out", cadence: "monthly", active: true, createdAt: "2026-01-01" },
      ],
      debts: undefined,
    } as unknown as AppData;
    expect(() => reviewLedger(broken, NOW)).not.toThrow();
    expect(() => reviewLedger(undefined as unknown as AppData, NOW)).not.toThrow();
    expect(() => reviewLedger(data(), new Date(NaN))).not.toThrow();
  });

  it("never mutates the data it is handed", () => {
    const d = data({
      recurring: [bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] })],
      transactions: [bank({ id: "b1", date: "2026-09-24", amount: 151.72 })],
    });
    const before = JSON.stringify(d);
    reviewLedger(d, NOW);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("is deterministic and sorted biggest money first", () => {
    const d = data({
      recurring: [
        bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1] }),
        bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] }),
      ],
      transactions: [
        paid("rent", "2026-07", 1, { amount: 1726.88 }),
        paid("rent", "2026-08", 1, { amount: 1726.88 }),
      ],
    });
    const a = reviewLedger(d, NOW);
    const b = reviewLedger(d, NOW);
    expect(a).toEqual(b);
    expect(a.map((s) => s.amount)).toEqual([...a.map((s) => s.amount)].sort((x, y) => y - x));
    expect(a.map((s) => s.kind)).toEqual(["missing", "phantom"]);
  });

  it("every string it emits is filled in — no leftover {placeholder}", () => {
    const d = data({
      recurring: [
        bill({ id: "spotify", name: "Spotify", amount: 14.04, dueDays: [10] }),
        bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] }),
        bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1] }),
        bill({ id: "prime", name: "Amazon Prime", amount: 16.2, dueDays: [23], createdAt: "2026-09-01T00:00:00Z" }),
        incomeRow({ id: "carins", name: "Car insurance check", amount: 1100, createdAt: "2026-06-20T00:00:00Z" }),
      ],
      transactions: [
        paid("spotify", "2026-07", 10, { id: "s7", amount: 14.04 }),
        paid("spotify", "2026-08", 10, { id: "s8", amount: 14.04 }),
        paid("spotify", "2026-09", 10, { id: "s9", amount: 27.0 }),
        paid("rent", "2026-07", 1, { amount: 1726.88 }),
        paid("rent", "2026-08", 1, { amount: 1726.88 }),
        bank({ id: "p1", date: "2026-09-23", amount: 16.2, description: "Amazon Prime" }),
        bank({ id: "g1", date: "2026-07-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
        bank({ id: "g2", date: "2026-08-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
        bank({ id: "g3", date: "2026-09-22", amount: 29.99, description: "Grok Ai", categoryId: "subscriptions" }),
        bank({ id: "d1", date: "2026-09-25", amount: 1137.2, type: "income" }),
        bank({ id: "b1", date: "2026-09-24", amount: 151.72 }),
        txn({ id: "m1", date: "2026-09-24", amount: 151.72, accountId: "a1" }),
      ],
    });
    const out = reviewLedger(d, NOW);
    expect(new Set(out.map((s) => s.kind)).size).toBeGreaterThanOrEqual(6);
    for (const s of out) {
      expect(s.title).not.toMatch(/[{}]/);
      expect(s.detail).not.toMatch(/[{}]/);
      expect(s.fix?.label ?? "").not.toMatch(/[{}]/);
    }
  });

  it("states no confidence anywhere — not a percentage, not a score, not 'probably'", () => {
    const out = reviewLedger(
      data({
        recurring: [bill({ id: "affirm", name: "Affirm", amount: 200, dueDays: [15] })],
      }),
      NOW,
    );
    const all = [...REVIEW_STRINGS, ...out.map((s) => `${s.title} ${s.detail}`)].join(" ");
    expect(all).not.toMatch(/probabl|likel|confiden|certain|\d\s?%|score/i);
  });

  it("every English source string is listed once for translation", () => {
    expect(REVIEW_STRINGS.length).toBe(new Set(REVIEW_STRINGS).size);
    expect(REVIEW_STRINGS.length).toBeGreaterThan(20);
  });

  it("REVIEW_STRINGS matches the code both ways, so nothing ships untranslated", () => {
    // The list is what the Chinese file is built from, so a string the engine can
    // emit and the list does not carry would ship as English to Xinyan with
    // nobody noticing. Read the source, pull out every user-facing literal, and
    // require the two sides to agree exactly.
    const src = readFileSync(join(process.cwd(), "src", "lib", "ledgerReview.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => {
        const s = l.trim();
        return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
      })
      .join("\n");
    const literals = new Set(
      [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => m[1])
        .filter((s) => s.length > 12 && s.includes(" ")),
    );
    expect([...literals].sort()).toEqual([...REVIEW_STRINGS].sort());
  });
});

// ── against the REAL ledger ────────────────────────────────────────────────────
//
// Runs the engine over the newest local snapshot (`npm run snapshot`), which is
// gitignored because it holds real balances. Skipped when there is none, so
// `npx vitest run` stays offline and needs no credentials. Point it elsewhere
// with HB_SNAPSHOT=<path to a snapshot json>.
//
// It asserts INVARIANTS only, never a count. A suggestion count legitimately
// changes the moment he fixes one, so "expect 4" would read as a broken test the
// first time the feature worked. The list is printed instead — that is the part a
// person should look at.

function newestSnapshot(): string | null {
  const explicit = process.env.HB_SNAPSHOT;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const dir = join(process.cwd(), "docs", "snapshots");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

const snapshotPath = newestSnapshot();
const num = (v: unknown) => Number(v ?? 0);

/** The snapshot holds raw DB rows, so this mirrors the store's mappers the same
 *  way tests/live-selfaudit.test.ts does — FinanceStore.tsx is a React module and
 *  cannot be loaded headlessly. Keep the field lists in step with mapTxn. */
function fromSnapshot(raw: Record<string, unknown>): AppData {
  const rows = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as Record<string, unknown>[]) : []);
  return {
    categories: DEFAULT_CATEGORIES,
    goals: [],
    paidBills: [],
    foods: [],
    merchantRules: rows("merchant_rules").map((r) => ({
      id: r.id as string,
      pattern: r.pattern as string,
      kind: r.kind as AppData["merchantRules"][number]["kind"],
      categoryId: (r.category_id as string) ?? undefined,
      billName: (r.bill_name as string) ?? undefined,
      createdAt: r.created_at as string,
    })),
    accounts: rows("accounts").map((a) => ({
      id: a.id as string,
      name: a.name as string,
      owner: a.owner as AppData["accounts"][number]["owner"],
      type: a.type as string,
      balance: num(a.balance),
      sortOrder: num(a.sort_order),
      createdAt: a.created_at as string,
    })),
    debts: rows("debts").map((d) => ({
      id: d.id as string,
      name: d.name as string,
      balance: num(d.balance),
      originalBalance: num(d.original_balance),
      apr: d.apr == null ? undefined : num(d.apr),
      color: (d.color as string) ?? "#000",
      createdAt: d.created_at as string,
    })),
    recurring: rows("recurring").map((r) => ({
      id: r.id as string,
      name: r.name as string,
      amount: num(r.amount),
      direction: r.direction as AppData["recurring"][number]["direction"],
      cadence: r.cadence as AppData["recurring"][number]["cadence"],
      active: !!r.active,
      variable: !!r.variable,
      categoryId: (r.category_id as string) ?? undefined,
      dueDays: (r.due_days as number[]) ?? undefined,
      anchorDate: (r.anchor_date as string) ?? undefined,
      startsOn: (r.starts_on as string) ?? undefined,
      endsOn: (r.ends_on as string) ?? undefined,
      knownAmount: r.known_amount == null ? undefined : num(r.known_amount),
      linkedDebtId: (r.linked_debt_id as string) ?? undefined,
      createdAt: r.created_at as string,
    })),
    transactions: rows("transactions").map((t) => ({
      id: t.id as string,
      date: t.date as string,
      amount: num(t.amount),
      type: t.type as "income" | "expense",
      categoryId: t.category_id as string,
      description: (t.description as string) ?? "",
      accountId: (t.account_id as string) ?? undefined,
      appliesTo: (t.applies_to as AppData["transactions"][number]["appliesTo"]) ?? undefined,
      pending: t.status === "pending",
      provider: (t.provider as string) ?? undefined,
      recordOnly: !!t.record_only,
      createdAt: t.created_at as string,
    })),
  };
}

describe.skipIf(!snapshotPath)("against the real ledger snapshot", () => {
  it("produces a stable, fully-formed list", () => {
    const raw = JSON.parse(readFileSync(snapshotPath as string, "utf8")) as Record<string, unknown>;
    const live = fromSnapshot(raw);
    const now = raw.takenAt ? new Date(raw.takenAt as string) : new Date();
    const out = reviewLedger(live, now);

    for (const s of out) {
      console.log(
        `  [${s.rule} ${s.kind}] ${s.title}\n         ${s.detail}\n         key=${s.key} fix=${s.fix?.action ?? "none"}`,
      );
    }
    const byKind: Record<string, number> = {};
    for (const s of out) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    console.log(
      `\n  ${out.length} suggestion(s) over ${live.transactions.length} transactions · ${live.recurring.length} recurring — ${JSON.stringify(byKind)}`,
    );

    // Keys must be unique, or one dismissal would silence two things at once.
    expect(new Set(out.map((s) => s.key)).size).toBe(out.length);
    for (const s of out) {
      expect(s.title).not.toMatch(/[{}]/);
      expect(s.detail).not.toMatch(/[{}]/);
      expect(Number.isFinite(s.amount)).toBe(true);
      expect(s.amount).toBeGreaterThanOrEqual(0);
    }
    // Pure: the same data and the same clock twice give the same answer.
    expect(reviewLedger(live, now)).toEqual(out);
    // And every dismissal sticks.
    expect(reviewLedger(live, now, out.map((s) => s.key))).toEqual([]);
  });
});

// W7's account arm — the one that could not see rent.
//
// The bill is called "Rent". The bank writes "ACH HOLD Nollie MA Rent ON 10/02". W7
// matched on exact normalised merchant name, deliberately — loose matching paired
// Chipotle with Spotify on this very ledger — so four months of rent went unlinked
// and the biggest bill in the house read as unpaid. That is the exact failure W7 was
// written to prevent, happening to the one bill that matters most.
//
// Safe only because every bill now knows which account pays it (2026-10-01).
describe("W7 matches a bill by the account it is paid from", () => {
  const JOINT = "acct-joint";
  const base = (over: Partial<AppData> = {}): AppData => ({
    transactions: [],
    recurring: [],
    debts: [],
    goals: [],
    accounts: [],
    paidBills: [],
    merchantRules: [],
    categories: [],
    ...(over as object),
  }) as AppData;

  const rentBill = {
    id: "bill-rent", name: "Rent", amount: 1726.88, direction: "out" as const,
    cadence: "monthly", categoryId: "housing", active: true, dueDays: [1],
    accountId: JOINT, createdAt: "2026-01-01",
  };
  const rentCharge = (over: Record<string, unknown> = {}) => ({
    id: "tx-rent", date: "2026-10-02", amount: 1732.05, type: "expense" as const,
    categoryId: "housing", description: "ACH HOLD Nollie MA Rent ON 10/02",
    accountId: JOINT, ...over,
  });

  it("finds rent, which the name arm never could", () => {
    const out = reviewLedger(
      base({ recurring: [rentBill] as never, transactions: [rentCharge()] as never }),
      new Date("2026-10-05T12:00:00Z"),
    );
    const w7 = out.filter((s) => s.rule === "W7");
    expect(w7, "rent should be offered for linking").toHaveLength(1);
    expect(w7[0].evidence.txnIds).toEqual(["tx-rent"]);
  });

  it("will not match a charge on a different account", () => {
    // "A charge somewhere in the household for about this much" is the heuristic that
    // paired Chipotle with Spotify. The account is what makes this narrow.
    const out = reviewLedger(
      base({ recurring: [rentBill] as never, transactions: [rentCharge({ accountId: "acct-gino" })] as never }),
      new Date("2026-10-05T12:00:00Z"),
    );
    expect(out.filter((s) => s.rule === "W7")).toHaveLength(0);
  });

  it("says nothing when one charge fits two bills on the same account", () => {
    // A coin toss wearing a suggestion's clothes. Dropped, not resolved.
    const twin = { ...rentBill, id: "bill-twin", name: "Something Else", dueDays: [2] };
    const out = reviewLedger(
      base({ recurring: [rentBill, twin] as never, transactions: [rentCharge()] as never }),
      new Date("2026-10-05T12:00:00Z"),
    );
    expect(out.filter((s) => s.rule === "W7")).toHaveLength(0);
  });

  it("ignores a bill nobody has given an account", () => {
    const out = reviewLedger(
      base({
        recurring: [{ ...rentBill, accountId: undefined }] as never,
        transactions: [rentCharge()] as never,
      }),
      new Date("2026-10-05T12:00:00Z"),
    );
    expect(out.filter((s) => s.rule === "W7")).toHaveLength(0);
  });
});

// The five false positives the account arm produced on its first live run.
//
// All five from one ledger, all five wrong, all five offered confidently. They are
// the reason the account arm has its own tolerance and its own day window instead of
// reusing band(), which is tuned for a variable bill whose amount genuinely moves and
// is far too generous once the merchant name has been taken away.
describe("W7's account arm refuses the charges it got wrong the first time", () => {
  const ACCT = "acct-gino";
  const base = (recurring: unknown[], transactions: unknown[]): AppData => ({
    transactions, recurring, debts: [], goals: [], accounts: [],
    paidBills: [], merchantRules: [], categories: [],
  }) as unknown as AppData;

  const bill = (over: Record<string, unknown>) => ({
    id: "b1", name: "Grok AI", amount: 29.99, direction: "out", cadence: "monthly",
    categoryId: "subscriptions", active: true, dueDays: [22], accountId: ACCT,
    createdAt: "2026-01-01", ...over,
  });
  const charge = (over: Record<string, unknown>) => ({
    id: "t1", date: "2026-08-22", amount: 29.99, type: "expense",
    categoryId: "groceries", description: "Somewhere", accountId: ACCT, ...over,
  });

  const w7 = (r: unknown[], t: unknown[]) =>
    reviewLedger(base(r, t), new Date("2026-09-15T12:00:00Z")).filter((s) => s.rule === "W7");

  it.each([
    ["99 Ranch Market", 36.03, "2026-07-21"],
    ["Safeway", 17.97, "2026-08-20"],
    ["Itch.io", 15, "2026-05-21"],
    ["Anthropic", 21.62, "2026-06-22"],
  ])("refuses %s at $%s — the amount is nowhere near", (description, amount, date) => {
    expect(w7([bill({})], [charge({ description, amount, date })])).toHaveLength(0);
  });

  it("refuses a grocery run that happens to cost the same, because of the date", () => {
    // H Mart $21.44 against Claude Pro $21.62 is 0.83% — inside any sane amount
    // tolerance. Eight days from the due day is what gives it away.
    const claudePro = bill({ id: "b2", name: "Claude Pro", amount: 21.62, dueDays: [20] });
    expect(w7([claudePro], [charge({ description: "H Mart", amount: 21.44, date: "2026-09-28" })])).toHaveLength(0);
  });

  it("still finds rent, which is the whole point of the arm", () => {
    const rent = bill({ id: "b3", name: "Rent", amount: 1726.88, dueDays: [1], categoryId: "housing" });
    const paid = charge({ description: "ACH HOLD Nollie MA Rent ON 09/02", amount: 1732.05, date: "2026-09-02" });
    expect(w7([rent], [paid])).toHaveLength(1);
  });
});
