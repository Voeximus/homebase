// The car payment arrives as an ACH transfer, and only the bill's own amount settles it.
//
// FOUND 2026-10-26. The car-payment rule matched the lender names it guessed before the
// first payment ("AHFC", "American Honda"), and the first real payment, on 2026-10-09,
// named neither: the bank wrote it as a web ACH transfer — "<NAME> DES:ACH XFER ID:…
// INDN:<NAME> CO ID:… WEB" — out of the joint account. It was filed as a new merchant and
// linked by hand, and the next one would have done the same.
//
// The shape is not the biller: every ACH transfer reads that way, whoever it pays. So the
// rule (SHAPE_BILL_RULES in categorize.ts) names the bill AND carries `billAmountGate`,
// and every place that resolves a named bill holds it to the bill's own figure TO THE
// CENT — the bank sync and the app's audit through matchBillForCharge, the statement
// import through billAmountToTheCent. A transfer of any other size never settles it.
//
// CHANGED 2026-10-26 in review, two ways. The gate was the fixed-bill band (the larger of
// $2 and 3%, a $13 window on a car payment) and is to the cent now: the amount is the only
// evidence a shape has. And the answer is SEED-ONLY: the sync files with `before` (the
// categorizer without the rule) any charge the bill does not take — another size, or a
// stored row not already linked to it — where the first version rewrote such a stored row
// to `other`, flagged. And a category a person tapped on the PENDING car payment no
// longer stops the posted one linking on its own account (mayLinkByShape).
//
// THE PUBLIC REPO RULE: every name, id, account and amount below is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mayLinkByShape } from "../supabase/functions/_shared/chargeStanding.ts";
import * as client from "../src/lib/categorize";
import * as edge from "../supabase/functions/_shared/categorize.ts";
import * as door from "../supabase/functions/_shared/muse/lib/categorize.ts";
import {
  BUILT_IN_BILL_NAMES,
  billAmountToTheCent,
  classify,
  forExistingRow,
  matchBillForCharge,
  type PayableBill,
} from "../src/lib/categorize";
import { bankWouldLink, linkContextOf } from "../src/lib/billMatch";
import { buildImportPlan } from "../src/lib/importStatement";
import type { Recurring } from "../src/types";

const JOINT = "acct-joint";
const MINE = "acct-mine";
const SHARED = new Set([JOINT]);
const CAR = "Car payment (Civic)";

/** An ACH transfer in the bank's own shape, with invented names and numbers. */
const ach = (who = "PAT EXAMPLE") => `${who} DES:ACH XFER ID:9900112 INDN:${who} CO ID:XXXXX0001 WEB`;

type Row = PayableBill & { id: string };
const CAR_BILL: Row = { id: "car", name: CAR, account_id: JOINT, amount: 312.5, variable: false, due_days: [6], cadence: "monthly" };

describe("the categorizer names the bill from the ACH shape, and says the amount must fit", () => {
  it("an ACH transfer reads as the car payment, gated", () => {
    const c = classify(ach(), -312.5);
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe(CAR);
    expect(c.billAmountGate).toBe(true);
  });

  it("seed-only: a row the ledger already holds is asked about as it was before the rule", () => {
    const c = classify(ach(), -312.5);
    expect(c.seedOnly).toBe(true);
    expect(c.before).toBeDefined();
    const old = forExistingRow(c);
    expect(old.kind).not.toBe("bill");
    expect(old.billAmountGate).toBeUndefined();
    // …which is the answer without the rule: an unknown name is a new merchant, asked.
    expect(old).toMatchObject({ kind: "variable", appCategory: "other", confidence: "low" });
  });

  it("whatever name is on it — the shape is the rule, so the amount has to be the gate", () => {
    const c = classify(ach("SAM SAMPLE"), -45);
    expect(c.billName).toBe(CAR);
    expect(c.billAmountGate).toBe(true);
  });

  it("a line that names its biller is settled by that name, never by the shape", () => {
    const rent = classify("Nollie MA DES:Rent ID:XXXXX0002 INDN:PAT EXAMPLE CO ID:XXXXX0003 WEB", -1500);
    expect(rent.billName).toBe("Rent");
    expect(rent.billAmountGate).toBeUndefined();
  });

  it("a lender-named payment still matches the old rule, ungated", () => {
    const c = classify("AMERICAN HONDA FINANCE", -312.5);
    expect(c.billName).toBe(CAR);
    expect(c.billAmountGate).toBeUndefined();
  });

  it("a rule a person taught on the name still wins, as every learned rule does", () => {
    const c = classify(ach(), -312.5, { "PAT EXAMPLE": { kind: "variable", categoryId: "other" } });
    expect(c.kind).toBe("variable");
  });

  it("the bill name stays on the list a rename is refused for", () => {
    expect(BUILT_IN_BILL_NAMES).toContain(CAR);
  });

  it("the app, the bank sync and the read door answer the same", () => {
    for (const amt of [-312.5, -45]) {
      const a = client.classify(ach(), amt);
      expect(edge.classify(ach(), amt)).toEqual(a);
      expect(door.classify(ach(), amt)).toEqual(a);
    }
  });
});

describe("only the bill's own amount settles it", () => {
  it("the bill's own amount links, from the account it is set on", () => {
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -312.5, SHARED, true)?.bill.id).toBe("car");
  });

  it("to the cent: a cent either side does not link (the band it replaced took $9.37 either side)", () => {
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -312.5, SHARED, true)?.bill.id).toBe("car");
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -312.51, SHARED, true)).toBeNull();
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -312.49, SHARED, true)).toBeNull();
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -(312.5 + 9.3), SHARED, true)).toBeNull();
    // Float noise in the stored figure is not a cent.
    expect(matchBillForCharge(CAR, [{ ...CAR_BILL, amount: 0.1 + 0.2 }], JOINT, -0.3, SHARED, true)?.bill.id).toBe("car");
  });

  it("a variable bill is never settled by a shape — its amount cannot tell its payment from another transfer", () => {
    const moving = { ...CAR_BILL, variable: true };
    expect(matchBillForCharge(CAR, [moving], JOINT, -312.5, SHARED, true)).toBeNull();
    expect(billAmountToTheCent(moving, -312.5)).toBe(false);
  });

  it("an unrelated ACH transfer of another size never settles it", () => {
    for (const amount of [45, 150, 1200]) {
      expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -amount, SHARED, true), String(amount)).toBeNull();
    }
  });

  it("from another of the household's accounts, the same to-the-cent test holds", () => {
    expect(matchBillForCharge(CAR, [CAR_BILL], MINE, -312.5, SHARED, true)).toMatchObject({ fromAnotherAccount: true });
    expect(matchBillForCharge(CAR, [CAR_BILL], MINE, -45, SHARED, true)).toBeNull();
    expect(matchBillForCharge(CAR, [CAR_BILL], MINE, -(312.5 + 2), SHARED, true)).toBeNull();
    // Ungated, the household fallback keeps its band, as before.
    expect(matchBillForCharge(CAR, [CAR_BILL], MINE, -(312.5 + 2), SHARED)).toMatchObject({ fromAnotherAccount: true });
  });

  it("without the gate, an own-account name match is exactly as it was (no amount test)", () => {
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -45, SHARED)?.bill.id).toBe("car");
    expect(matchBillForCharge(CAR, [CAR_BILL], JOINT, -45, SHARED, false)?.bill.id).toBe("car");
  });

  it("the amount follows the bill row, so a new payment amount needs no code change", () => {
    const repriced = { ...CAR_BILL, amount: 289.1 };
    expect(billAmountToTheCent(repriced, -289.1)).toBe(true);
    expect(billAmountToTheCent(repriced, -312.5)).toBe(false);
    // A figure a person read off the bill beats the contracted one, as everywhere else.
    expect(billAmountToTheCent({ ...CAR_BILL, known_amount: 300 }, -300)).toBe(true);
    // And the figure may be stored as text, the way a numeric column comes back.
    expect(billAmountToTheCent({ ...CAR_BILL, amount: "289.10" as unknown as number }, -289.1)).toBe(true);
  });

  it("a bill with no figure fits nothing", () => {
    expect(billAmountToTheCent({ ...CAR_BILL, amount: 0 }, -312.5)).toBe(false);
  });

  it("the edge copy agrees", () => {
    for (const amt of [-312.5, -45]) {
      expect(edge.matchBillForCharge(CAR, [CAR_BILL], JOINT, amt, SHARED, true)?.bill.id ?? null).toBe(
        client.matchBillForCharge(CAR, [CAR_BILL], JOINT, amt, SHARED, true)?.bill.id ?? null,
      );
    }
  });
});

const recurring = (over: Partial<Recurring> = {}): Recurring => ({
  id: "car",
  name: CAR,
  amount: 312.5,
  direction: "out",
  cadence: "monthly",
  accountId: JOINT,
  active: true,
  variable: false,
  dueDays: [6],
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("the app's own question — what would the bank sync link?", () => {
  const ctx = linkContextOf({ recurring: [recurring()], accounts: [{ id: JOINT, owner: "Joint" }, { id: MINE, owner: "Pat" }] });
  const charge = (amount: number) => ({ type: "expense" as const, date: "2026-11-07", amount, description: ach(), accountId: JOINT });

  it("the bill's own amount: linked, in the month it is due", () => {
    expect(bankWouldLink(charge(312.5), ctx)).toMatchObject({ monthKey: "2026-11", fromAnotherAccount: false });
  });

  it("another amount: nothing", () => {
    expect(bankWouldLink(charge(45), ctx)).toBeNull();
  });
});

describe("the bank sync holds the gate, and only links a charge arriving", () => {
  const src = readFileSync("supabase/functions/plaid/index.ts", "utf8").replace(/\r\n/g, "\n");
  const at = src.indexOf("const postedAnswer = ");
  const answer = src.slice(at, src.indexOf("\n    };\n", at));

  it("decides the shape-named bill once, gated, through the one matcher", () => {
    expect(answer).toContain("matchBillForCharge(c.billName, live, acctIdByProv[row.accountId] ?? null, row.amount, sharedAccts, true)");
    expect(answer).toContain("mayLinkByShape(standingOf(row), String(shapeHit.bill.id), shapeHit.fromAnotherAccount)");
    // A charge the bill does not take is filed with the answer from before the rule.
    expect(answer).toContain("shapeHit || td ? c : forExistingRow(c)");
    // The loop and the spend history both ask it, so they cannot disagree.
    expect(src).toContain("const { c, shapeHit } = postedAnswer(row);");
    expect(src).toContain('postedAnswer(r).c.kind !== "skip"');
    expect(src).toMatch(/let named = c\.billAmountGate\s*\? shapeHit\s*: matchBillForCharge\(c\.billName, liveRecs, chargeAcct, row\.amount, sharedAccts\);/);
  });

  const standing = (over: Partial<Parameters<typeof mayLinkByShape>[0]>) => ({
    isNew: true,
    answered: false,
    mapped: true,
    storedLink: null,
    ...over,
  });

  it("never links a stored, unlinked row by the new rule — a guess may seed a row, never re-decide one", () => {
    expect(mayLinkByShape(standing({ isNew: false }), "car", false)).toBe(false);
    expect(mayLinkByShape(standing({ isNew: false, storedLink: { kind: "bill", recurringId: "other-bill" } }), "car", false)).toBe(false);
    // The bank re-sending a row already linked to this bill writes it back as it is.
    expect(mayLinkByShape(standing({ isNew: false, storedLink: { kind: "bill", recurringId: "car" } }), "car", false)).toBe(true);
    expect(mayLinkByShape(standing({}), "car", false)).toBe(true);
  });

  it("a category tapped on the PENDING car payment does not stop the posted one linking on its own account", () => {
    expect(mayLinkByShape(standing({ answered: true }), "car", false)).toBe(true);
    // From another account the person's answer still stands, as for every cross-account link.
    expect(mayLinkByShape(standing({ answered: true }), "car", true)).toBe(false);
    expect(mayLinkByShape(standing({}), "car", true)).toBe(true);
  });

  it("the relabel sweep never reads a stored row as the shape-named bill", () => {
    expect(src).toMatch(/const c = forExistingRow\(\s*classify\(r\.description/);
    for (const amount of [-312.5, -45]) expect(forExistingRow(classify(ach(), amount)).kind).not.toBe("bill");
  });
});

describe("the statement import holds the same gate", () => {
  it("the bill's own amount is offered as the bill; another amount as spending to look at", () => {
    const plan = buildImportPlan(
      [
        { date: "2026-11-07", description: ach(), amount: -312.5 },
        { date: "2026-11-12", description: ach("SAM SAMPLE"), amount: -45 },
      ],
      [recurring()],
      [],
    );
    expect(plan.bills.map((b) => b.amount)).toEqual([312.5]);
    expect(plan.bills[0].billName).toBe(CAR);
    const other = plan.variable.find((v) => v.amount === 45)!;
    expect(other.appCategory).toBe("other");
    expect(other.lowConfidence).toBe(true);
  });
});
