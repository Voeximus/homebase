// A Zelle between their own accounts is not spending, and not income either.
//
// FOUND LIVE on 2026-10-04, in a plain data refresh. Both of their checking accounts
// are synced, so when Xinyan Zelles Gino $250 the ledger gets TWO rows: $250 leaving
// hers, $250 arriving in his. Nothing in flow.ts could see that — rule 3 catches the
// same double-count only when the money lands on a credit card — so October was
// carrying $300 of spending nobody did and $300 of income nobody earned, with the
// "spending" half filed under Household + Hygiene.
//
// The pairing is the evidence, which is why this can be done at all: a Zelle to
// somebody OUTSIDE the household appears once, and only an internal one appears twice
// under the same confirmation code. Half these tests are the cases that must NOT fire,
// because a wrong `moved` deletes real spending from the month.
import { describe, expect, it } from "vitest";
import { classify, transferRef } from "../src/lib/flow";
import type { Account, Transaction } from "../src/types";

const acct = (id: string, owner: string, last4: string): Account => ({
  id,
  name: "Checking",
  owner,
  last4,
  type: "checking",
  balance: 0,
  sortOrder: 1,
});

const ACCOUNTS: Account[] = [
  acct("xinyan", "Xinyan", "1111"),
  acct("gino", "Gino", "4728"),
];

let n = 0;
const txn = (over: Partial<Transaction>): Transaction =>
  ({
    id: `t${++n}`,
    date: "2026-10-04",
    amount: 250,
    type: "expense",
    categoryId: "household",
    description: "",
    accountId: "xinyan",
    ...over,
  }) as Transaction;

/** The real pair, as Bank of America wrote it — note the two spellings of "Conf". */
const PAIR = (): Transaction[] => [
  txn({
    amount: 250,
    type: "expense",
    accountId: "xinyan",
    description: "Zelle Transfer CONF# YOMIM8KBL; GIO",
  }),
  txn({
    amount: 250,
    type: "income",
    accountId: "gino",
    description: "Zelle Transfer Conf# YOMIM8KBL; XINYAN LI",
  }),
];

const flows = (txns: Transaction[]) => classify(txns, ACCOUNTS).map((r) => r.verdict.flow);

describe("transferRef", () => {
  it("reads the code whichever way the bank capitalises it", () => {
    expect(transferRef("Zelle Transfer CONF# YOMIM8KBL; GIO")).toBe("yomim8kbl");
    expect(transferRef("Zelle Transfer Conf# YOMIM8KBL; XINYAN LI")).toBe("yomim8kbl");
    // The code at the end of the descriptor, which is how an older row reads.
    expect(transferRef('Zelle payment to Gio for "Rent"; Conf# sj8fhx6l3')).toBe("sj8fhx6l3");
  });

  it("wants the word, not just a long token", () => {
    // An account number is not a confirmation code. Matching bare tokens would pair
    // a card payment with whatever else happened to name the same digits.
    expect(transferRef("PAYMENT TO ACCT #4728 ON 09/30 VIA WEB")).toBeNull();
    expect(transferRef("Sam's Club 1234567")).toBeNull();
    expect(transferRef("")).toBeNull();
    expect(transferRef(undefined)).toBeNull();
  });
});

describe("the two halves of one transfer", () => {
  it("calls both halves moved, and says why", () => {
    const rows = classify(PAIR(), ACCOUNTS);
    expect(rows.map((r) => r.verdict.flow)).toEqual(["moved", "moved"]);
    for (const r of rows) {
      expect(r.verdict.why).toContain("transfer between their own accounts");
      // The code is named, so the claim can be checked against the ledger rather
      // than believed.
      expect(r.verdict.why).toContain("yomim8kbl");
    }
  });

  it("is what stops $300 of invented spending — the live case, both pairs", () => {
    const fifty = [
      txn({ amount: 50, type: "expense", accountId: "xinyan", description: "Zelle Transfer CONF# XZ31RH99F; GIO" }),
      txn({ amount: 50, type: "income", accountId: "gino", description: "Zelle Transfer Conf# XZ31RH99F; XINYAN LI" }),
    ];
    const rows = classify([...PAIR(), ...fifty], ACCOUNTS);
    expect(rows.map((r) => r.verdict.flow)).toEqual(["moved", "moved", "moved", "moved"]);
  });
});

describe("the cases it must not fire on", () => {
  it("leaves a Zelle to somebody outside the household as spending", () => {
    // The live row that SHOULD stay spending: $40 out, its own code, no sibling —
    // because the other side of it is in a stranger's bank, not this ledger.
    const flow = flows([
      txn({ amount: 40, type: "expense", accountId: "xinyan", description: "Zelle Transfer CONF# UGNG0672V; PINGTING YANG" }),
    ]);
    expect(flow).toEqual(["spent"]);
  });

  it("leaves money arriving from outside as earned", () => {
    const flow = flows([
      txn({ amount: 20, type: "income", accountId: "xinyan", description: "Zelle Transfer Conf# 99CYLXDNO; YINAN LI" }),
      txn({ amount: 6, type: "income", accountId: "xinyan", description: "Zelle Transfer Conf# 99CYPE3V5; YINAN LI" }),
    ]);
    expect(flow).toEqual(["earned", "earned"]);
  });

  it("will not pair two amounts that differ, however close", () => {
    const [out, into] = PAIR();
    const flow = flows([out, { ...into, amount: 250.01 }]);
    expect(flow).toEqual(["spent", "earned"]);
  });

  it("will not pair two rows going the same way", () => {
    const [out] = PAIR();
    const flow = flows([out, { ...out, id: "t99", accountId: "gino" }]);
    expect(flow).toEqual(["spent", "spent"]);
  });

  it("will not pair a row with itself on one account", () => {
    const [out, into] = PAIR();
    const flow = flows([out, { ...into, accountId: "xinyan" }]);
    expect(flow).toEqual(["spent", "earned"]);
  });

  it("gives up rather than guess when three rows share a code", () => {
    const [out, into] = PAIR();
    const flow = flows([out, into, { ...into, id: "t98" }]);
    expect(flow).toEqual(["spent", "earned", "earned"]);
  });

  it("ignores a row on an account the household does not own", () => {
    const [out, into] = PAIR();
    const flow = flows([out, { ...into, accountId: "someone-elses" }]);
    expect(flow).toEqual(["spent", "earned"]);
  });

  it("never overrules a correction made by hand", () => {
    // Somebody looked at this and said it was real spending. An inference does not
    // get to argue — rule 0 in flowOf, and the pairing pass has to honour it too or
    // the correction would be silently undone on the next read.
    const [out, into] = PAIR();
    const rows = classify([{ ...out, flowOverride: "spent" }, into], ACCOUNTS);
    expect(rows[0].verdict.flow).toBe("spent");
    expect(rows[0].verdict.why).toContain("set by hand");
    // And its partner is left alone too, because a half-applied pairing would be a
    // $250 expense with a $250 transfer facing it — worse than either answer.
    expect(rows[1].verdict.flow).toBe("earned");
  });
});
