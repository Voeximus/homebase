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

  // The descriptor below is the one actually in the ledger. Plaid does not send
  // "MHE*ALEKS" as the merchant name — it sends the bare publisher code "MHE",
  // and only the raw line carries the product. A first version of this rule was
  // written against "MHE*ALEKS", passed its test, and matched nothing at all in
  // the live corpus. Which is why bill matching now reads the raw line too, and
  // why tests/live-categorize.test.ts exists to run the whole real corpus.
  it("ALEKS settles its bill from the descriptor the bank really sends", () => {
    const learned: LearnedRules = { MHE: { kind: "variable", categoryId: "subscriptions" } };
    const c = spend("MHE", 21.57, "CHECKCARD 0815 MHE*ALEKS ALEKS.COM NY XXXXX2962XXXXXXXXXX8", learned);
    expect(c.kind).toBe("bill");
    expect(c.billName).toBe("ALEKS calculus");
  });

  // Without the raw line there is nothing to go on, and it must NOT guess — "MHE"
  // alone could be any McGraw-Hill product.
  it("with no raw line, the bare publisher code stays what it was taught", () => {
    const learned: LearnedRules = { MHE: { kind: "variable", categoryId: "subscriptions" } };
    expect(spend("MHE", 21.57, undefined, learned).appCategory).toBe("subscriptions");
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

  // The gate is 120, not 250: from 2026-11-01 the modelled Mom row resumes at
  // $300/month paid as TWO $150 installments, so a 250 gate would have rejected
  // every real installment from the day it restarts — $3,600 a year.
  //
  // And below the gate it is VARIABLE, never SKIP. "skip" means the importer
  // writes the row nowhere at all, and money that left the account must always be
  // recorded. A $50 Zelle on 2026-08-19 is missing from the ledger for exactly
  // this reason. Being unsure what a charge was is not a reason to pretend it did
  // not happen.
  it("a Zelle to mom is gated at the installment amount, and below it is still recorded", () => {
    expect(spend("Zelle payment to mon", 300).billName).toBe("Mom");
    expect(spend("Zelle payment to mon", 150).billName).toBe("Mom");
    const small = spend("Zelle payment to mon", 50);
    expect(small.kind).toBe("variable");
    expect(small.confidence).toBe("low");
  });

  it("card interest is neither a bill nor budgeted spend", () => {
    const c = spend("INTEREST CHARGED ON PURCHASES", 94.78);
    expect(c.kind).toBe("variable");
    expect(c.appCategory).toBe("interest");
  });

  it("a bank-tagged pump is fuel; an untagged charge inside the fuel range is a question", () => {
    expect(spend("Sam's Club", 41, "SAMSCLUB 4956 GAS 07/16").appCategory).toBe("transport");
    expect(spend("Sam's Club", 34.91, "CHECKCARD 0815 SAMS CLUB #4956 TEMPE AZ").ambiguous).toBe(true);
  });
});

describe("the department question, asked only where it is genuinely a question", () => {
  // Every bank-CONFIRMED fuel charge in this household's history is a Sam's Club
  // pump sale between $32.83 and $45.28 — one tank for one car. The middle is
  // genuinely undecidable (a $34.93 hand-labelled STORE run sits inside that
  // range), so the band is not narrowed there. But a charge far outside it cannot
  // be a fill-up, and asking about those forever taught nobody anything.
  it("above the fuel ceiling it is a store run, not a question", () => {
    // $130.64 is 39 gallons at $3.30 — about three tanks for a 2012 Civic. It was
    // sitting on the gas line, 36% of August's whole transport total.
    const c = spend("Sam's Club", 130.64, "CHECKCARD 0822 SAMS CLUB #495");
    expect(c.ambiguous).toBeUndefined();
    expect(c.appCategory).toBe("groceries");
  });

  it("below the floor it is a snack, not a question", () => {
    expect(spend("Sam's Club", 4.05, "CHECKCARD 0822 SAMS CLUB #495").ambiguous).toBeUndefined();
  });

  // QuikTrip writes the department on every single line and the categorizer was
  // throwing it away: 16 OUTSIDE and 4 INSIDE across the whole ledger, and the
  // same station's charges sat split between dining and transport at random.
  it("QuikTrip says which side of the building the charge came from", () => {
    expect(spend("QT", 30.04, "QT 465 OUTSIDE 08/14 #XXXXX3833 PURCHASE QT 465 OUTSIDE").appCategory).toBe("transport");
    expect(spend("QT", 7.38, "QT 465 INSIDE 04/17 #XXXXX1122 PURCHASE QT 465 INSIDE").ambiguous).toBeUndefined();
  });

  // Scoped to QuikTrip: a stray "OUTSIDE" in an unrelated descriptor must not
  // mean fuel.
  it("OUTSIDE only means the pump at QuikTrip", () => {
    expect(spend("Trader Joe's", 29.41, "OUTSIDE PATIO CAFE TEMPE AZ").appCategory).not.toBe("transport");
  });
});

describe("categories the app could never reach", () => {
  // His own "Pets" hand-label routed to `other`, so the $75 Pets budget line
  // could only ever be fed by a merchant rule he had typed himself.
  it("pet merchants reach the Pets line", () => {
    expect(spend("Petsmart", 42).appCategory).toBe("pets");
    expect(spend("Docupet Pet Licensing", 24, "CHECKCARD 0801 DOCUPET PET LICENSING DOCUPET.COM NY").appCategory).toBe("pets");
  });

  // Vehicle registration arrives as a raw line whose merchant key collapses to
  // the literal word "CHECKCARD" — so it sat in Misc and no rule could be taught
  // on it that would not capture every other unrecognised charge too.
  it("vehicle registration is a car cost, not Misc", () => {
    expect(spend("CHECKCARD", 48.46, "CHECKCARD 0628 AZ MVD FEE NOW PHOENIX AZ").appCategory).toBe("transport");
  });

  // The membership token lives only in the raw line, so $9.99/mo was filed as a
  // rideshare trip against the gas budget.
  it("an Uber One membership is a subscription, an Uber trip is transport", () => {
    expect(spend("Uber", 9.99, "UBER *ONE MEMBERSHIP help.uber.com").appCategory).toBe("subscriptions");
    expect(spend("Uber", 18.4, "UBER *TRIP help.uber.com").appCategory).toBe("transport");
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

describe("bill matching must not invent a match out of the descriptor it was given", () => {
  // Both of these were introduced by the fix that made bill matching read the raw
  // bank line, and both are the SAME shape as the parking charge that marked
  // September's rent paid: a bill cycle settled by a charge that had nothing to do
  // with the bill, at high confidence, with no amount tolerance anywhere in the
  // path. That shape is the one to keep testing for.

  // billKey() strips every non-alphanumeric, INCLUDING the space that separated
  // the clean name from the raw line — so searching the concatenation invented
  // aliases at the join: "Busan Mart" + "MOBILE PURCHASE …" collapsed to
  // "busanmar|tmobile|purchase…". A $27.48 meal settled the $27.48 phone bill.
  // "MOBILE PURCHASE" is Bank of America's standard card prefix, so every
  // restaurant whose name ends in "t" was one descriptor away from paying it.
  it("a restaurant cannot pay the phone bill", () => {
    expect(spend("Busan Mart", 27.48, "MOBILE PURCHASE 0326 BUSAN MART MESA AZ XXXXX1662").kind).not.toBe("bill");
    expect(spend("First And Last Rest", 27.12, "MOBILE PURCHASE 0412 FIRST AND LAST REST TEMPE AZ").kind).not.toBe("bill");
  });

  it("the real phone bill still settles, in all three forms the bank sends", () => {
    for (const [d, raw] of [
      ["T-Mobile", "T-Mobile"],
      ["T-Mobile", "CHECKCARD 0814 T-MOBILE*PREPAID WEB WA"],
      ["T Mobile", "CHECKCARD 0814 TMOBILE*PREPAID WEB WA"],
    ] as [string, string][]) {
      expect(spend(d, 27.48, raw).billName).toBe("T-Mobile");
    }
  });

  // A late fee carries the biller's name, so the bill rule matches it — and the
  // name-matched path applies no amount tolerance at all. The fee rule is written
  // to win this race; it was reading only the clean name while the bill rule read
  // the raw line, so it lost whenever the "LATE FEE" token lived in the raw.
  it("a late fee does not settle the bill it is a fee on", () => {
    expect(spend("Nollie Ma", 86.6, "GREYSTAR NOLLIE LATE FEE").kind).not.toBe("bill");
    expect(spend("SRP", 25, "SRP LATE FEE").kind).not.toBe("bill");
  });

  it("the real rent and electric bills still settle", () => {
    expect(spend("Nollie MA", 1732.16, "Nollie MA DES:Rent ID:XXXXX6948").billName).toBe("Rent");
    expect(spend("SRP", 132.77, "SRP DES:ECHXPWR-S1 ID:XXXXX9008").billName).toBe("Electric (SRP)");
  });

  // A shell heredoc that is not quoted, or a Python string that is not raw, turns
  // the two characters \b into a single 0x08 BACKSPACE. The regex still compiles,
  // type-checks, lints and reviews clean — and matches only a descriptor
  // containing a literal backspace, i.e. never. `od -c` even renders 0x08 back as
  // "\b". Two bill rules shipped dead this way: /\bGEICO\b/i and /\bALEKS\.COM\b/i.
  it("no source file carries a control byte where an escape was meant", async () => {
    const fs = await import("node:fs");
    for (const f of ["src/lib/categorize.ts", "supabase/functions/_shared/categorize.ts"]) {
      const bad = fs.readFileSync(f, "utf8").match(/[ --]/g);
      expect(bad, `${f} contains ${bad?.length} control byte(s)`).toBeNull();
    }
  });

  it("the rules those bytes had killed actually fire", () => {
    expect(spend("GEICO", 363.3, "GEICO *AUTO").billName).toBe("Car insurance");
    expect(spend("MHE", 21.57, "CHECKCARD 0815 MHE*ALEKS ALEKS.COM NY").billName).toBe("ALEKS calculus");
  });
});
