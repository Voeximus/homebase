import { describe, it, expect } from "vitest";
import { classify, matchRecurringName, merchantKey, type LearnedRules } from "../src/lib/categorize";

// The categorizer decides, for every line the bank sends, whether money is a
// modeled bill, living spend, or not spending at all. Until this file existed it
// had no test of its own — and the worst defect this app has produced lived
// here: a bill rule matching a single shared word.
//
// Real descriptors only. Every string below was copied out of the live ledger or
// a Bank of America statement, because the whole failure mode is the gap between
// what a rule was written for and what the bank actually sends.

const spend = (desc: string, amount: number, raw?: string, learned?: LearnedRules) =>
  classify(desc, -Math.abs(amount), learned, raw);

describe("a bill rule must identify the biller, not a word it shares", () => {
  // Nollie MA is the landlord. Parkinsafe Nollie is the SAME landlord's parking
  // garage, $6 a visit, several times a month.
  //
  // With a bare /NOLLIE/i the $6 parking charge classified as a $1,732.16 rent
  // payment. It settled the SEPTEMBER cycle (billAppliesTo rolls a mid-August
  // payment forward to the Sep 1 due date), so the calendar read
  // "Sep 1 — Rent — PAID $6.00", September's bills fell from $2,979.70 to
  // $1,247.54, and the projected September low point flipped sign: −$721.47 true,
  // +$1,010.69 as shown. In the month this household's cash is tightest.
  //
  // The second charge is that the importer DISCARDS a payment landing in an
  // already-settled cycle, so the two later parking charges vanished as well.
  it("the parking garage is not the rent", () => {
    const c = spend("Parkinsafe Nollie", 6, "CHECKCARD 0817 PARKINSAFE NOLLIE PARKINSAFE.COAZ XXXXX6662XX");
    expect(c.kind).toBe("variable");
    expect(c.appCategory).toBe("transport");
  });

  it("the rent is still the rent", () => {
    const c = spend("Nollie MA", 1732.16, "Nollie MA DES:Rent ID:XXXXX6948 INDN:GIOVANNI CIRINO");
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe("Rent");
  });

  // billKey() strips punctuation, so "PARKINSAFE NOLLIE" normalizes to
  // "parkinsafenollie" — which CONTAINS "nollie". Without the same veto, the
  // drift-tolerant alias pass re-opens the hole the regex veto just closed.
  it("the alias pass cannot re-open the collision", () => {
    const c = spend("PARKINSAFE NOLLIE", 6, "PARKINSAFE NOLLIE PARKINSAFE.COAZ");
    expect(c.kind).not.toBe("bill");
  });

  // The veto reads the raw bank line too, because Plaid's clean merchant name can
  // drop the very token that separates the two.
  it("the veto reads the raw descriptor as well as the clean name", () => {
    const c = spend("Nollie", 6, "CHECKCARD 0821 PARKINSAFE NOLLIE PARKINSAFE.COAZ");
    expect(c.kind).not.toBe("bill");
  });
});

describe("card payments are recognised in every form the bank writes them", () => {
  // Bank of America uses three descriptors for the same act depending on channel.
  // Only the first two said "CRD", so the third was filed as a brand-new merchant
  // in `other` — paying down a credit card recorded as discretionary Misc spend.
  const FORMS: [string, string][] = [
    ["Online Banking payment to CRD 4728 Confirmation# z4xrmaeau", "Card payment (…4728)"],
    ["Mobile Banking payment to CRD 6813 Confirmation# z3avx58ga", "Card payment (…6813)"],
    ["PAYMENT TO ACCT #6813 ON 08/25 VIA WEB", "Card payment (…6813)"],
  ];
  for (const [desc, bill] of FORMS) {
    it(`"${desc.slice(0, 34)}…" → ${bill}`, () => {
      const c = spend(desc, 25);
      expect(c.kind).toBe("bill");
      expect(c.billName).toBe(bill);
    });
  }

  // The two cards must never be confused for each other: they are different
  // debts with different balances and different minimums.
  it("the two cards stay distinct", () => {
    expect(spend("Online Banking payment to CRD 4728", 200).billName).toBe("Card payment (…4728)");
    expect(spend("PAYMENT TO ACCT #6813 ON 08/25 VIA WEB", 25).billName).toBe("Card payment (…6813)");
  });
});

describe("bills whose merchant key is too blunt to hold a learned rule", () => {
  // merchantKey() cuts at the "*", so "MHE*ALEKS ALEKS.COM" keys to the bare
  // "MHE" — a publisher, not a product. A learned rule on it can only ever say
  // "subscription", never "this is the ALEKS bill", so the real charge was filed
  // as ordinary spend while a hand-typed placeholder settled the bill: two rows,
  // one charge, $21.57 double-counted every month.
  it("merchantKey really does truncate MHE*ALEKS to MHE", () => {
    expect(merchantKey("Mhe*aleks")).toBe("MHE");
  });

  it("ALEKS settles its bill even against a learned rule on MHE", () => {
    const learned: LearnedRules = { MHE: { kind: "variable", categoryId: "subscriptions" } };
    const c = spend("Mhe*aleks", 21.57, "CHECKCARD 0815 MHE*ALEKS ALEKS.COM NY XXXXX2962", learned);
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe("ALEKS calculus");
  });

  // Cherry is BOTH a tracked debt and a modeled monthly bill. Naming it here is
  // what lets the importer link a payment to both at once — without a name the
  // tracked-debt branch could only ever settle the debt, and the Bills tab showed
  // Cherry unpaid in a month it had been paid.
  it("Cherry names its bill so a payment can settle bill and debt together", () => {
    const c = spend("Cherry Technol", 151.72, "CHECKCARD 0822 Cherry Technol");
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe("Cherry (dental)");
  });
});

describe("merchants that were falling into Misc", () => {
  // `other` is the $125/mo Misc line — a prompt, not an allowance. Anything that
  // lands there wrongly both overstates Misc and understates its real line.
  const CASES: [string, string, string][] = [
    ["Parkinsafe Nollie", "transport", "parking at their own building, several times a month"],
    ["Hourglas", "shopping", "Plaid truncates HOURGLASSCOSME; Health/Personal folds into shopping"],
  ];
  for (const [desc, cat, why] of CASES) {
    it(`${desc} → ${cat} (${why})`, () => {
      expect(spend(desc, 20).appCategory).toBe(cat);
    });
  }
});

describe("regressions the existing rules already guard — pinned so a fix cannot undo them", () => {
  it("a learned rule still wins over a keyword guess", () => {
    const learned: LearnedRules = { SAFEWAY: { kind: "variable", categoryId: "shopping" } };
    // Safeway sells fuel and groceries, so the result stays flagged — but the
    // category it pre-fills must be the one that was taught.
    const c = spend("Safeway", 17.97, "Safeway", learned);
    expect(c.appCategory).toBe("shopping");
  });

  it("the Anthropic price band still routes by amount, not by merchant", () => {
    expect(spend("Claude Sub Anthropic.comca", 21.62).billName).toBe("Claude Pro");
    expect(spend("Claude Sub Anthropic.comca", 108.1).billName).toBe("Claude Max");
    expect(spend("Anthropic", 3.4).kind).toBe("variable"); // API spend, not a seat
  });

  it("a Zelle to mom below the support amount is not the Mom bill", () => {
    expect(spend("Zelle payment to mon", 300).billName).toBe("Mom");
    expect(spend("Zelle payment to mon", 50).kind).toBe("skip");
  });

  it("card interest is neither a bill nor budgeted spend", () => {
    const c = spend("INTEREST CHARGED ON PURCHASES", 94.78);
    expect(c.kind).toBe("variable");
    expect(c.appCategory).toBe("interest");
  });

  it("a bank-tagged pump is fuel, an untagged warehouse run is a question", () => {
    expect(spend("Sam's Club", 41, "SAMSCLUB 4956 GAS 07/16").appCategory).toBe("transport");
    expect(spend("Sam's Club", 130.64, "CHECKCARD 0822 SAMS CLUB #495").ambiguous).toBe(true);
  });
});

describe("a rule you taught must be reachable from the descriptor the bank sends", () => {
  // A learned rule is stored under the merchant key of whatever descriptor was on
  // screen when it was taught, and there are two: Plaid's clean merchant name and
  // the bank's raw statement line. Seven live rules were stored in the raw
  // namespace and could never fire, because merchantKey() on a raw Bank of America
  // card line stops at the transaction-type prefix and returns "CHECKCARD".
  //
  // One of the seven was PARKINSAFE NOLLIE → transport. It out-ranks BILL_RULES,
  // so had it been reachable it would have prevented the rent collision outright.
  const LIVE: LearnedRules = {
    "SAMS CLUB.COM": { kind: "variable", categoryId: "groceries" },
    "PARKINSAFE NOLLIE": { kind: "variable", categoryId: "transport" },
  };

  it("a rule taught on the raw statement line now fires", () => {
    const c = classify("Sam's Club", -16.22, LIVE, "CHECKCARD 0616 SAMS CLUB.COM 888-746-7726 AR XXXXX1962");
    expect(c.appCategory).toBe("groceries");
    expect(c.reason).toBe("you taught it");
  });

  // The reason the raw line must be STRIPPED first, not keyed directly: every
  // BoA card line begins "CHECKCARD", so a single rule on that key would swallow
  // the whole ledger.
  it("CHECKCARD can never become a key that matches a rule", () => {
    const evil: LearnedRules = { CHECKCARD: { kind: "skip" } };
    const c = classify("Trader Joe's", -29.41, evil, "CHECKCARD 0815 TRADER JOE S # TEMPE AZ");
    expect(c.kind).not.toBe("skip");
  });
});

describe("car insurance survives its own term change", () => {
  // GEICO had no rule at all: every instalment classified as a new merchant and
  // landed in the $125/mo Misc line while the bill read unpaid. The complication
  // is that ONE biller pays TWO modelled rows — the current term ends 30 Nov 2026,
  // its replacement starts 1 Feb 2027 — so the rule names the shared prefix and
  // the caller narrows by window.
  const ROWS = [
    { id: "old", name: "Car insurance — finishing this term" },
    { id: "new", name: "Car insurance (both cars)" },
  ];

  it("GEICO names the biller", () => {
    const c = classify("GEICO", -363.3, undefined, "GEICO *AUTO");
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe("Car insurance");
  });

  it("a prefix resolves when exactly one row is live", () => {
    expect(matchRecurringName("Car insurance", [ROWS[0]])?.id).toBe("old");
    expect(matchRecurringName("Car insurance", [ROWS[1]])?.id).toBe("new");
  });

  // Guessing between two candidates would settle the wrong cycle, so it must
  // refuse and fall through to a review flag instead.
  it("an ambiguous prefix refuses rather than guessing", () => {
    expect(matchRecurringName("Car insurance", ROWS)).toBeNull();
  });

  it("an exact name still beats a prefix", () => {
    const exact = [...ROWS, { id: "exact", name: "Car insurance" }];
    expect(matchRecurringName("Car insurance", exact)?.id).toBe("exact");
  });
});
