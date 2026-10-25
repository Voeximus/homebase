// Money coming in is read for what it is: earnings, a payment, or money coming back.
//
// FOUND 2026-10-25, three ways the app misread money IN:
//
//   1. EVERY CREDIT ON A CARD WAS "A PAYMENT". flow.ts rule 2 called any credit landing
//      on a credit card `moved`, the far half of a card payment. A refunded online
//      course landed on a card and read "a payment arriving at a card" — untrue.
//   2. EVERY OTHER CREDIT WAS EARNINGS. The feed filed any credit that was not a
//      paycheck or a transfer as `other-income`, which flow.ts counts as earned — so a
//      merchant's refund and a friend paying back their half of dinner read as the
//      household making money.
//   3. CASH PUT BACK VANISHED. classifyCredit called an ATM cash deposit a transfer and
//      the feed dropped it, while the withdrawal it came out of is recorded as spending.
//      $100 out, $40 of it put back unspent, and the only record was the $100 leaving.
//      Now the deposit is recorded, as a refund: in the ledger, not earnings, and the
//      account's cash change is right. Spending is NOT brought down by it — the
//      withdrawal still counts as spent in full (see the cash tests below, and the
//      CHANGED note in classifyCredit); netting the two is a separate piece.
//
// These pin each fix, and what must NOT change: paychecks, transfers between their own
// accounts, the Mom support, tax refunds, a phone cheque deposit, and — the household's
// standing rule — no new rule moving a row the ledger already has.
//
// THE PUBLIC REPO RULE. Every merchant, person, amount, account number and confirmation
// code below is invented.

import { describe, expect, it } from "vitest";
import {
  classifyCredit,
  creditCategory,
  creditHistoryFrom,
} from "../src/lib/categorize";
import * as edgeCat from "../supabase/functions/_shared/categorize.ts";
import * as doorCat from "../supabase/functions/_shared/muse/lib/categorize.ts";
import { classify, COUNTS_TOWARD_NET, flowOf, ownAccountsFrom } from "../src/lib/flow";
import { normalize, type PlaidTxn } from "../supabase/functions/_shared/plaidSync.ts";
import { pendingFields } from "../supabase/functions/_shared/pendingRow.ts";
import { fileHistoryRow, type HistoryPlan } from "../supabase/functions/muse-write/historyRow.ts";
import { creditFlags, spendHistoryDescriptions } from "../supabase/functions/_shared/seedOnly.ts";
import type { Account, Transaction } from "../src/types";

// ── 1. a credit on a card ───────────────────────────────────────────────────────

const ACCOUNTS: Account[] = [
  { id: "chk", name: "Checking", owner: "Gino", last4: "9001", type: "checking", balance: 0, sortOrder: 0, createdAt: "" },
  { id: "card", name: "Card", owner: "Gino", last4: "9002", type: "credit card", balance: 0, sortOrder: 1, createdAt: "" },
];
const own = ownAccountsFrom(ACCOUNTS);
const txn = (o: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2),
  date: "2026-10-20",
  amount: 25,
  type: "income",
  categoryId: "other-income",
  description: "Sample",
  accountId: "card",
  ...o,
});

describe("a credit on a card is a payment only when it is one", () => {
  it("a merchant's refund on a card is money returned, not a payment", () => {
    const v = flowOf(txn({ description: "Lumen Courses" }), own);
    expect(v.flow).toBe("returned");
    expect(v.why).toContain("refund");
    expect(v.why).not.toContain("other half");
  });

  it("a payment says so: its words, or one of the household's own last fours", () => {
    for (const d of ["PAYMENT FROM CHK 9001 CONF#TESTMI01", "PAYMENT - THANK YOU", "AUTOPAY 1020", "ONLINE PYMT RECEIVED", "BA ELECTRONIC PMT", "TRANSFER 9001"]) {
      expect(flowOf(txn({ description: d }), own).flow, d).toBe("moved");
    }
  });

  it("a card credit with no payment words is still moved when its other half left their own account", () => {
    const rows = classify(
      [
        txn({ id: "out", type: "expense", accountId: "chk", amount: 80, description: "Mobile Banking payment to CRD 9002 Confirmation# TESTPAIRMI" }),
        txn({ id: "in", type: "income", accountId: "card", amount: 80, description: "BANK CREDIT CONF#TESTPAIRMI" }),
      ],
      ACCOUNTS,
    );
    expect(rows.map((r) => r.verdict.flow)).toEqual(["moved", "moved"]);
  });

  it("neither one counts toward net, so no total moves — only the reason does", () => {
    expect(flowOf(txn({ description: "Lumen Courses" }), own).flow).not.toBe("earned");
  });

  it("a credit on a checking account is untouched by this rule", () => {
    expect(flowOf(txn({ accountId: "chk", description: "Lumen Courses" }), own).flow).toBe("earned");
  });
});

// ── 2. refunds and paybacks ─────────────────────────────────────────────────────

const SPENT = [
  "Lumen Courses",
  "BRAMBLE OUTFITTERS LLC",
  "CHECKCARD 0905 HARBOR INN NORTH LAS VEGNV XXXXX1234XXXXXXXXXX5678",
  "Zelle payment to RIVA TOLL Conf# TESTMI02",
  'Zelle payment to DAN for "tickets"; Conf# TESTMI03',
  "Zelle Transfer Conf# TESTMI04; OSKAR VEE",
  "Zelle payment to mon Conf# TESTMI05",
  "IRS USATAXPYMT",
  "PAYPAL *KNICKKNACK",
  "Remitly",
  "SAMPLE EMPLOYER",
];
const history = creditHistoryFrom(SPENT);

describe("money back from a merchant the household spent at is a refund", () => {
  it("the same merchant", () => {
    expect(creditCategory("Lumen Courses", undefined, history)).toMatchObject({ categoryId: "refund", seedOnly: true });
  });

  it("the same merchant spelled another way — the near-spelling rule a taught rule uses", () => {
    expect(creditCategory("Bramble Outfitters", undefined, history).categoryId).toBe("refund");
    // A credit with no clean name: the bank's own line is all there is.
    expect(creditCategory("CHECKCARD 1002 HARBOR INN NORTH LAS VEGNV XXXXX1234", undefined, history).categoryId).toBe("refund");
  });

  it("a merchant the household never spent at is still other income", () => {
    expect(creditCategory("Quasar Rebates", undefined, history).categoryId).toBe("other-income");
    // One word only matches itself: having spent at "LUMEN" is not "LUMEN COURSES".
    expect(creditCategory("Lumen Courses", undefined, creditHistoryFrom(["Lumen"])).categoryId).toBe("other-income");
  });

  // FOUND 2026-10-25 in review: the town came off "CITY OF <town>", so spending at one
  // city made money in from any other city a refund. Real place names (the list that
  // strips them is real); the charges are invented.
  it("money in from one city or university is not a refund for spending at another", () => {
    const cities = creditHistoryFrom(["City of Phoenix", "UNIVERSITY OF ARIZONA"]);
    expect(creditCategory("City of Tempe", undefined, cities).categoryId).toBe("other-income");
    expect(creditCategory("City of Mesa AZ", undefined, cities).categoryId).toBe("other-income");
    expect(creditCategory("University of Phoenix", undefined, cities).categoryId).toBe("other-income");
    // The same city is still the same city.
    expect(creditCategory("City of Phoenix AZ", undefined, cities).categoryId).toBe("refund");
  });

  it("a tax refund, a payout platform, a remittance rail and cashback stay income though the name was paid before", () => {
    for (const d of ["IRS TREAS 310 TAX REF", "PAYPAL TRANSFER", "REMITLY REFUND", "BANKAMERIDEALS CASHBACK"]) {
      expect(creditCategory(d, undefined, history).categoryId, d).toBe("other-income");
    }
  });

  it("a paycheck is salary first, whatever the household has paid that name", () => {
    expect(creditCategory("SAMPLE EMPLOYER DES:PAYROLL ID:TESTMI06", undefined, history).categoryId).toBe("salary");
  });

  it("without the spend history only the paycheck and cash rules answer, as before", () => {
    expect(creditCategory("Lumen Courses").categoryId).toBe("other-income");
  });
});

describe("a Zelle back from someone the household sent money to is a payback", () => {
  it("the same person, posted or pending wording", () => {
    expect(creditCategory("Zelle payment from RIVA TOLL Conf# TESTMI07", undefined, history)).toMatchObject({ categoryId: "refund", seedOnly: true });
    expect(creditCategory("Zelle Transfer Conf# TESTMI08; RIVA TOLL", undefined, history).categoryId).toBe("refund");
    // Sent while pending, paid back posted.
    expect(creditCategory("Zelle payment from OSKAR VEE Conf# TESTMI09", undefined, history).categoryId).toBe("refund");
  });

  // CHANGED 2026-10-25 in review. This test said the opposite: a first name sent to
  // ("DAN") was the start of the full name paid back from ("DAN BRIGHT"), so it was a
  // payback. That is the first-name collision — two people who share a first name are
  // two people — and the household's own history holds a one-word name. A one-word name
  // now matches only itself.
  it("a one-word name sent to is not a different, longer name paid back from — either way round", () => {
    expect(creditCategory('Zelle payment from DAN BRIGHT for "half"; Conf# TESTMI10', undefined, history).categoryId).toBe("other-income");
    expect(creditCategory("Zelle Transfer Conf# TESTMI17; DAN BRIGHT", undefined, history).categoryId).toBe("other-income");
    // Sent to "RIVA TOLL", paid back from a bare "RIVA": not known to be the same person.
    expect(creditCategory("Zelle payment from RIVA Conf# TESTMI18", undefined, history).categoryId).toBe("other-income");
  });

  it("a one-word name matches itself, and a full name matches a longer form of itself", () => {
    expect(creditCategory("Zelle payment from DAN Conf# TESTMI19", undefined, history).categoryId).toBe("refund");
    expect(creditCategory("Zelle payment from RIVA TOLL JR Conf# TESTMI20", undefined, history).categoryId).toBe("refund");
  });

  // FOUND 2026-10-25 in review: a Zelle between the two of them put one of them on the
  // "sent money to" list. "BABE" is a key the categorizer's own history already labels
  // "Internal: spouse"; the confirmation codes are invented.
  it("one of the household is never someone money comes back from", () => {
    const withSpouse = creditHistoryFrom([...SPENT, "Zelle payment to BABE Conf# TESTMI21"]);
    expect(withSpouse.zelledTo.map((p) => p.join(" "))).not.toContain("BABE");
    expect(creditCategory("Zelle Transfer Conf# TESTMI22; BABE", undefined, withSpouse).categoryId).toBe("other-income");
  });

  // A LIMIT, pinned so nobody finds it by surprise: the rule reads the PERSON, never
  // the memo, so pay for a job, money for something sold or a gift from someone the
  // household once paid is filed as a payback too. Whether a Zelle in with a memo
  // keeps this seed is Gino's call (see the note above creditCategory); until then a
  // person refiles that row by hand.
  it("LIMIT: the memo is not read — a Zelle in for work from someone paid before is still a payback", () => {
    expect(creditCategory('Zelle payment from RIVA TOLL for "yard work"; Conf# TESTMI23', undefined, history).categoryId).toBe("refund");
  });

  it("a different person is not a payback: whole words only", () => {
    expect(creditCategory("Zelle payment from DANIELA ROSS Conf# TESTMI11", undefined, history).categoryId).toBe("other-income");
    expect(creditCategory("Zelle payment from PELL ANDO Conf# TESTMI12", undefined, history).categoryId).toBe("other-income");
  });

  it("the person the Mom support goes to is never someone money comes BACK from", () => {
    expect(creditCategory("Zelle payment from mon Conf# TESTMI13", undefined, history).categoryId).toBe("other-income");
  });

  it("a Zelle is matched as a person, never as a merchant", () => {
    // The household spent at "Lumen Courses"; a person of that name is still a person.
    expect(creditCategory("Zelle payment from LUMEN COURSES Conf# TESTMI14", undefined, history).categoryId).toBe("other-income");
  });

  it("a transfer between their own accounts is still dropped before any of this", () => {
    expect(classifyCredit("TRANSFER FROM ACCT #9001 ON 10/20 VIA WEB")).toBe("transfer");
    expect(classifyCredit("PAYMENT FROM CHK 9001 CONF#TESTMI15")).toBe("transfer");
  });
});

// ── 3. cash put back ────────────────────────────────────────────────────────────

describe("cash put back into the bank is recorded as cash coming back", () => {
  const ATM_IN = "BKOFAMERICA ATM 10/03 #000009999 DEPOSIT SAMPLE ST";

  it("is no longer dropped as a transfer", () => {
    expect(classifyCredit(ATM_IN)).toBe("income");
    expect(classifyCredit("Bkofamerica Atm")).toBe("income");
  });

  it("is a refund, with or without the spend history, from the clean name or the raw line", () => {
    expect(creditCategory(ATM_IN)).toMatchObject({ categoryId: "refund", seedOnly: true });
    expect(creditCategory("Bkofamerica Atm", ATM_IN, history).categoryId).toBe("refund");
    expect(creditCategory("ATM CASH DEPOSIT 10/03").categoryId).toBe("refund");
  });

  it("a phone cheque deposit is left as it was — written, as other income", () => {
    const cheque = "BKOFAMERICA MOBILE 10/03 XXXXX12345 DEPOSIT *MOBILE";
    expect(classifyCredit(cheque)).toBe("income");
    expect(creditCategory(cheque, undefined, history).categoryId).toBe("other-income");
  });

  it("the same answer in all three copies of the categorizer", () => {
    for (const cat of [edgeCat, doorCat]) {
      expect(cat.classifyCredit(ATM_IN)).toBe("income");
      expect(cat.creditCategory(ATM_IN).categoryId).toBe("refund");
    }
  });

  // What the fix does and does NOT do, pinned — FOUND 2026-10-25 in review, where the
  // first write-up claimed cash put back "stops reading as spent". It does not.
  it("the deposit is money returned — recorded and not earnings — and the withdrawal stays spent in full", () => {
    const deposit = flowOf(txn({ accountId: "chk", categoryId: "refund", amount: 40, description: ATM_IN }), own);
    expect(deposit.flow).toBe("returned");
    expect(COUNTS_TOWARD_NET.returned).toBe(false); // so it lowers neither earned nor spent
    const withdrawal = flowOf(
      txn({ accountId: "chk", type: "expense", categoryId: "other", amount: 100, description: "BKOFAMERICA ATM 10/02 #000009998 WITHDRWL SAMPLE ST" }),
      own,
    );
    expect(withdrawal.flow).toBe("spent");
  });

  // A LIMIT, pinned: a cheque deposited at the bank's machine is worded like cash, and
  // nothing in the line tells them apart, so it is filed as cash put back too. It was
  // dropped altogether before, so the earned figures are no worse; the label is wrong.
  it("LIMIT: a cheque deposited at the cash machine reads the same as cash, and is filed the same way", () => {
    expect(creditCategory("BKOFAMERICA ATM 10/03 #000009997 DEPOSIT SAMPLE ST").categoryId).toBe("refund");
  });
});

// ── the pending path and the write door file money in the same way ───────────────

const pendingIn = (name: string, dollars: number): PlaidTxn => ({
  transaction_id: `p-${name}`,
  pending: true,
  account_id: "acct",
  date: "2026-10-20",
  name,
  merchant_name: null,
  amount: -dollars, // Plaid's sign: − is money IN
});

describe("a pending credit is filed the way its posted twin will be", () => {
  it("a payback while it processes", () => {
    expect(pendingFields(normalize(pendingIn("Zelle Transfer Conf# TESTMI16; RIVA TOLL", 42)), {}, history)?.category_id).toBe("refund");
  });

  it("cash put back while it processes — it used to be dropped", () => {
    expect(pendingFields(normalize(pendingIn("BKOFAMERICA ATM 10/20 #000009999 DEPOSIT SAMPLE ST", 40)), {})?.category_id).toBe("refund");
  });

  it("without the history, other income as before", () => {
    expect(pendingFields(normalize(pendingIn("Lumen Courses", 19)), {})?.category_id).toBe("other-income");
  });
});

describe("the write door files cash put back as the feed does, instead of refusing it", () => {
  const plan = (description: string): HistoryPlan => ({
    accountId: "acct",
    date: "2026-10-20",
    amount: 40,
    type: "income",
    description,
    categoryId: null,
    confirmed: false,
    override: null,
  });

  it("an ATM deposit is a refund", () => {
    expect(fileHistoryRow(plan("BKOFAMERICA ATM 10/20 #000009999 DEPOSIT SAMPLE ST"), {})).toMatchObject({ categoryId: "refund" });
  });

  it("anything else still files exactly as before", () => {
    expect(fileHistoryRow(plan("SAMPLE CO DES:PAYROLL"), {})).toMatchObject({ categoryId: "salary" });
    expect(fileHistoryRow(plan("Lumen Courses"), {})).toMatchObject({ categoryId: "other-income" });
  });
});

// ── never re-decide a credit already in the ledger ───────────────────────────────

describe("a re-sync never re-decides a credit the ledger already has", () => {
  // apply_bank_sync's ON CONFLICT for the category, as schema_v26 wrote it.
  type Stored = { category_id: string; user_categorized: boolean };
  const onConflict = (existing: Stored, sentCategory: string): Stored => {
    const { keep_category } = creditFlags(sentCategory);
    return { ...existing, category_id: existing.user_categorized || keep_category ? existing.category_id : sentCategory };
  };

  it("an old credit filed as other income stays other income when the new rule now says refund", () => {
    const old: Stored = { category_id: "other-income", user_categorized: false };
    const now = creditCategory("Lumen Courses", undefined, history).categoryId;
    expect(now).toBe("refund");
    expect(onConflict(old, now)).toEqual(old);
  });

  it("a refund the rule seeded is not turned back into earnings when the history cannot be read", () => {
    const seeded: Stored = { category_id: "refund", user_categorized: false };
    const now = creditCategory("Lumen Courses", undefined, undefined).categoryId; // the read failed
    expect(now).toBe("other-income");
    expect(onConflict(seeded, now)).toEqual(seeded);
  });

  it("a paycheck is still re-asked, exactly as before", () => {
    expect(creditFlags("salary")).toEqual({ needs_review: false, keep_category: false });
  });

  it("no credit is ever flagged for review, as before", () => {
    for (const c of ["salary", "refund", "other-income"]) expect(creditFlags(c).needs_review).toBe(false);
  });
});

// ── a purchase and its refund in the same sync ───────────────────────────────────
//
// FOUND 2026-10-25 in review. The sync read the spend history from the database
// before writing this sync's own rows, so a purchase and its refund arriving together
// (a re-linked account's first pull, a catch-up after missed syncs) never met: the
// refund was filed other-income, and a credit keeps its category on every re-sync, so
// it stayed earnings for good. spendHistoryDescriptions is the sync's own input to
// creditHistoryFrom; `writtenAsSpend` stands in for the sync's decision.

describe("the spend history includes this sync's own money out", () => {
  type Row = { amount: number; description: string; skip?: boolean };
  const delta: Row[] = [
    { amount: -64.5, description: "Wrenfield Outfitters" }, // the purchase
    { amount: 64.5, description: "Wrenfield Outfitters" }, // its refund, same delta
    { amount: -30, description: "Gallowmere Books", skip: true }, // a row the sync keeps out
    { amount: 12, description: "Tallis Rebates" }, // money in is never history
  ];
  const written = (r: Row) => !r.skip;

  it("reproduces the failure: the stored rows alone do not know the purchase", () => {
    expect(creditCategory("Wrenfield Outfitters", undefined, creditHistoryFrom(["Lumen Courses"])).categoryId).toBe("other-income");
  });

  it("with the delta's own purchase in it, the refund in the same delta is a refund", () => {
    const h = creditHistoryFrom(spendHistoryDescriptions(["Lumen Courses"], delta, written));
    expect(creditCategory("Wrenfield Outfitters", undefined, h).categoryId).toBe("refund");
    // The stored history is still there.
    expect(creditCategory("Lumen Courses", undefined, h).categoryId).toBe("refund");
  });

  it("only rows the sync writes as money out count — not a kept-out row, not a credit", () => {
    expect(spendHistoryDescriptions([], delta, written)).toEqual(["Wrenfield Outfitters"]);
    const h = creditHistoryFrom(spendHistoryDescriptions([], delta, written));
    expect(creditCategory("Gallowmere Books", undefined, h).categoryId).toBe("other-income");
    expect(creditCategory("Tallis Rebates", undefined, h).categoryId).toBe("other-income");
  });
});
