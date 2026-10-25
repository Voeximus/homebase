// A bill paid from whichever account had the money.
//
// FOUND 2026-10-24. The household is one unit and pays a bill from whichever account
// has the money that week, but a charge could only settle a bill set to pay from the
// charge's OWN account (billsPayableFrom, written 2026-10-05 for the Claude Pro case).
// So the car insurance came out of two different accounts and not one instalment ever
// linked, and an electric bill paid from the joint account never linked while the bill
// named another account. Each charge was filed as spending while its bill read unpaid.
//
// matchBillForCharge keeps the own-account match exactly as it was and, only when that
// finds nothing, looks at the bills set on the household's other accounts — on the
// name AND the amount band, and only when one side of it is a shared account. These
// tests hold all three halves of that sentence, and the case billsPayableFrom exists
// for. Every amount and id here is invented.
import { describe, expect, it } from "vitest";
import * as client from "../src/lib/categorize";
import * as edge from "../supabase/functions/_shared/categorize.ts";
import {
  billAmountBand,
  billLiveOnPaymentDate,
  billPerCharge,
  billsPayableFrom,
  matchBillForCharge,
  sharedAccountIds,
  type PayableBill,
} from "../src/lib/categorize";
import { bankWouldLink, linkContextOf } from "../src/lib/billMatch";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Account, AppData, Recurring, Transaction } from "../src/types";

const A = "acct-a"; // one person's own checking
const B = "acct-b"; // the other person's own checking
const JOINT = "acct-joint";
const SHARED = new Set([JOINT]);

type Row = PayableBill & { id: string };
const row = (over: Partial<Row>): Row => ({ id: "b", name: "Bill", account_id: null, amount: 100, variable: false, due_days: [15], ...over });

const ELECTRIC_ON_A = row({ id: "elec", name: "Electric (SRP)", account_id: A, amount: 90, variable: true, due_days: [17] });
const INSURANCE_ON_JOINT = row({ id: "ins", name: "Car insurance — last two instalments", account_id: JOINT, amount: 312.4, due_days: [30] });
const PRO_ON_B = row({ id: "pro", name: "Claude Pro", account_id: B, amount: 24.5, due_days: [20] });

describe("matchBillForCharge — the household fallback", () => {
  it("links an electric payment from the joint account to the bill set on one person's account", () => {
    const hit = matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], JOINT, -96.1, SHARED);
    expect(hit?.bill.id).toBe("elec");
    expect(hit?.fromAnotherAccount).toBe(true);
  });

  it("links car insurance whichever account it came from, while the bill sits on the joint account", () => {
    // The categorizer names "Car insurance"; the modelled row qualifies it, and the
    // name matcher resolves the unique prefix — exactly as on the bill's own account.
    for (const from of [A, B]) {
      const hit = matchBillForCharge("Car insurance", [INSURANCE_ON_JOINT], from, -312.4, SHARED);
      expect(hit?.bill.id, from).toBe("ins");
      expect(hit?.fromAnotherAccount).toBe(true);
    }
  });

  it("a different merchant never matches, whatever the amount", () => {
    expect(matchBillForCharge("Verizon", [ELECTRIC_ON_A, INSURANCE_ON_JOINT], JOINT, -96.1, SHARED)).toBeNull();
    expect(matchBillForCharge(undefined, [ELECTRIC_ON_A], JOINT, -90, SHARED)).toBeNull();
    expect(matchBillForCharge("", [ELECTRIC_ON_A], JOINT, -90, SHARED)).toBeNull();
  });

  it("a small charge never settles a large bill from another account", () => {
    // The parking-garage-settles-the-rent shape, arriving by the new door: right name,
    // wrong size. The own-account path has no amount gate; this one must.
    const rent = row({ id: "rent", name: "Rent", account_id: JOINT, amount: 1450, due_days: [1] });
    expect(matchBillForCharge("Rent", [rent], A, -6, SHARED)).toBeNull();
    expect(matchBillForCharge("Car insurance", [INSURANCE_ON_JOINT], B, -40, SHARED)).toBeNull();
    // A fixed bill's band is tight: three percent, at least two dollars.
    expect(matchBillForCharge("Car insurance", [INSURANCE_ON_JOINT], B, -(312.4 + 9.0), SHARED)?.bill.id).toBe("ins");
    expect(matchBillForCharge("Car insurance", [INSURANCE_ON_JOINT], B, -(312.4 + 9.5), SHARED)).toBeNull();
  });

  it("a variable bill keeps the generous band its figure has always had, and no more", () => {
    // billAmountBand(90, variable) = max(15, 13.5) = 15.
    expect(matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], JOINT, -104.9, SHARED)?.bill.id).toBe("elec");
    expect(matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], JOINT, -105.1, SHARED)).toBeNull();
    // known_amount, when a person has read the bill, is the figure the band is around.
    const known = { ...ELECTRIC_ON_A, known_amount: 140 };
    expect(matchBillForCharge("Electric (SRP)", [known], JOINT, -150, SHARED)?.bill.id).toBe("elec");
  });

  it("an own-account match still wins over a same-named bill on another account", () => {
    const own = row({ id: "pet-own", name: "Pet insurance", account_id: A, amount: 33 });
    const other = row({ id: "pet-joint", name: "Pet insurance", account_id: JOINT, amount: 33 });
    const hit = matchBillForCharge("Pet insurance", [other, own], A, -33, SHARED);
    expect(hit?.bill.id).toBe("pet-own");
    expect(hit?.fromAnotherAccount).toBe(false);
    // …and from the other person's account it is the household one, never the
    // first person's own.
    expect(matchBillForCharge("Pet insurance", [other, own], B, -33, SHARED)?.bill.id).toBe("pet-joint");
  });

  it("the own-account path is exactly what it was — no new amount gate on it", () => {
    // Nothing that links today may stop linking: the first pass is still the bare
    // name match over billsPayableFrom, whatever the amount.
    const hit = matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], A, -1, SHARED);
    expect(hit?.bill.id).toBe("elec");
    expect(hit?.fromAnotherAccount).toBe(false);
    expect(client.matchRecurringName("Electric (SRP)", billsPayableFrom([ELECTRIC_ON_A], A))?.id).toBe("elec");
  });

  it("KEEPS THE CLAUDE PRO CASE SHUT: one person's own seat never pays the other person's bill", () => {
    // Why billsPayableFrom exists. Both of them can hold the same subscription at the
    // same price, so name and amount both pass — what separates it from the household
    // paying a shared bill is that neither account is shared.
    expect(matchBillForCharge("Claude Pro", [PRO_ON_B], A, -24.5, SHARED)).toBeNull();
    // And with no shared account known at all, nothing crosses accounts.
    expect(matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], JOINT, -90, new Set())).toBeNull();
  });

  // The guard's two known edges, written down in review on 2026-10-25 so nobody finds
  // them the hard way (see the note on matchBillForCharge).
  it("EDGE: one person's same-named seat paid FROM the joint account settles the other person's bill", () => {
    // The joint account is the household's money, so this reads as the household
    // paying; paid-from-its-own-account names it, and a person unlinks it if it was the
    // other seat.
    expect(matchBillForCharge("Claude Pro", [PRO_ON_B], JOINT, -24.5, SHARED)).toMatchObject({
      bill: { id: "pro" },
      fromAnotherAccount: true,
    });
  });

  it("EDGE: a payment between the two PERSONAL accounts never links — the bill has to be moved", () => {
    // The electric bill is set on A; paid from B, neither side is shared.
    expect(matchBillForCharge("Electric (SRP)", [ELECTRIC_ON_A], B, -90, SHARED)).toBeNull();
  });

  it("a charge whose account the app does not know still searches every bill, as before", () => {
    expect(matchBillForCharge("Claude Pro", [PRO_ON_B], null, -24.5, SHARED)?.bill.id).toBe("pro");
  });

  it("the edge copy answers exactly as the app's does", () => {
    const bills = [ELECTRIC_ON_A, INSURANCE_ON_JOINT, PRO_ON_B];
    const cases: [string, string, number][] = [
      ["Electric (SRP)", JOINT, -96.1],
      ["Car insurance", B, -312.4],
      ["Claude Pro", A, -24.5],
      ["Rent", A, -6],
    ];
    for (const [name, acct, amt] of cases) {
      expect(edge.matchBillForCharge(name, bills, acct, amt, SHARED)?.bill.id ?? null).toBe(
        client.matchBillForCharge(name, bills, acct, amt, SHARED)?.bill.id ?? null,
      );
    }
  });
});

describe("the pieces it stands on", () => {
  it("billPerCharge expects a share per instalment, the whole amount for biweekly", () => {
    expect(billPerCharge({ name: "x", amount: 240, due_days: [15, 30] })).toBe(120);
    expect(billPerCharge({ name: "x", amount: 240, due_days: [15, 30], cadence: "biweekly" })).toBe(240);
    expect(billPerCharge({ name: "x", amount: "75.5", due_days: [3] })).toBe(75.5);
    expect(billPerCharge({ name: "x", amount: 0 })).toBeNaN();
  });

  it("billAmountBand is the sync's band", () => {
    expect(billAmountBand(10, false)).toBe(2);
    expect(billAmountBand(1000, false)).toBe(30);
    expect(billAmountBand(10, true)).toBe(15);
    expect(billAmountBand(1000, true)).toBe(150);
  });

  it("billLiveOnPaymentDate keeps the sync's week of slack", () => {
    const r = { starts_on: "2026-11-01", ends_on: "2026-11-30" };
    expect(billLiveOnPaymentDate(r, "2026-10-25")).toBe(true);
    expect(billLiveOnPaymentDate(r, "2026-10-24")).toBe(false);
    expect(billLiveOnPaymentDate(r, "2026-12-07")).toBe(true);
    expect(billLiveOnPaymentDate(r, "2026-12-08")).toBe(false);
  });

  it("sharedAccountIds is the accounts owned Joint", () => {
    expect([...sharedAccountIds([{ id: A, owner: "Gino" }, { id: JOINT, owner: "Joint" }, { id: B, owner: "Xinyan" }])]).toEqual([JOINT]);
  });
});

// ── through the categorizer, the way the sync and the app's audit both ask it ──
const acct = (id: string, owner: Account["owner"]): Account =>
  ({ id, name: "Checking", owner, type: "checking", balance: 0, sortOrder: 0, createdAt: "2026-01-01T00:00:00Z" }) as Account;
const bill = (over: Partial<Recurring>): Recurring =>
  ({ id: "b", name: "Bill", amount: 100, direction: "out", cadence: "monthly", active: true, dueDays: [15], createdAt: "2026-01-01T00:00:00Z", ...over }) as Recurring;
const charge = (over: Partial<Transaction>): Transaction =>
  ({ id: "t", date: "2026-10-18", amount: 50, type: "expense", categoryId: "other", description: "Store", provider: "plaid", createdAt: "2026-10-18T12:00:00Z", ...over }) as Transaction;
const ledger = (over: Partial<AppData>): AppData => ({
  transactions: [], debts: [], goals: [], categories: DEFAULT_CATEGORIES,
  accounts: [acct(A, "Gino"), acct(B, "Xinyan"), acct(JOINT, "Joint")],
  recurring: [], paidBills: [], merchantRules: [], foods: [], ...over,
});

describe("bankWouldLink — the sync's question, asked in the app", () => {
  const ELECTRIC = bill({ id: "elec", name: "Electric (SRP)", amount: 90, variable: true, dueDays: [17], accountId: A });

  it("names an electric payment from the joint account as the bill on the other account", () => {
    const link = bankWouldLink(charge({ description: "SRP", amount: 93.2, accountId: JOINT }), linkContextOf(ledger({ recurring: [ELECTRIC] })));
    expect(link).toMatchObject({ monthKey: "2026-10", day: 17, fromAnotherAccount: true });
    expect(link?.bill.id).toBe("elec");
  });

  it("leaves ordinary spending alone, at any amount", () => {
    const ctx = linkContextOf(ledger({ recurring: [ELECTRIC] }));
    expect(bankWouldLink(charge({ description: "Trader Joe's", amount: 90, accountId: JOINT }), ctx)).toBeNull();
    expect(bankWouldLink(charge({ description: "SRP", amount: 90, type: "income", accountId: JOINT }), ctx)).toBeNull();
  });

  it("asks only about bills live on the payment date, with the sync's slack", () => {
    const later = { ...ELECTRIC, startsOn: "2026-12-01" };
    expect(bankWouldLink(charge({ description: "SRP", amount: 90, accountId: A }), linkContextOf(ledger({ recurring: [later] })))).toBeNull();
  });

  it("never matches a turned-off bill", () => {
    const off = { ...ELECTRIC, active: false };
    expect(bankWouldLink(charge({ description: "SRP", amount: 90, accountId: A }), linkContextOf(ledger({ recurring: [off] })))).toBeNull();
  });
});

describe("paid-from-its-own-account still flags a cross-account payment — it just no longer blocks the link", () => {
  it("fails on the linked payment, naming the bill, so a person can move it", () => {
    const now = new Date(2026, 9, 25, 12);
    const electric = bill({ id: "elec", name: "Electric (SRP)", amount: 90, variable: true, dueDays: [17], accountId: A });
    const linked = charge({
      id: "srp", description: "SRP", amount: 93.2, accountId: JOINT,
      appliesTo: { kind: "bill", recurringId: "elec", monthKey: "2026-10", day: 17, settled: true },
    });
    const check = selfAudit(ledger({ recurring: [electric], transactions: [linked] }), now).checks.find(
      (c) => c.id === "paid-from-its-own-account",
    )!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("Electric (SRP)");
  });
});
