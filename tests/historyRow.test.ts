// Money that left the household is recorded, and a missing statement row can be put back.
//
// FOUND 2026-10-10 by reconciling the three bank statements line by line against the
// ledger. Two halves, tested here together because they are one story:
//
//   1. THE CATEGORIZER DROPPED A REAL ZELLE. The history label "Zelle: friends/family"
//      mapped to `skip`, and `skip` means the row is written nowhere — so money sent to
//      a friend or relative was missing from every figure built on the ledger. Money
//      SENT that way is spending now (filed in `other`, flagged for review); money
//      RECEIVED that way was already income and still is; money moving between the
//      household's own accounts is still dropped.
//   2. THE ONE THAT ALREADY WENT MISSING CANNOT COME BACK BY ITSELF — the bank feed
//      never re-sends a row that did not change. finance.add_history_row writes it as
//      history (record_only, no balance moved), the way the statement import does.
//
// THE PUBLIC REPO RULE. No real names, amounts or confirmation codes are typed here.
// The categorizer's own history labels are keyed by real names (src/lib/categorizeData.ts
// already holds them); the tests below look those keys up BY LABEL at run time instead
// of spelling any of them, and every amount and code is made up.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as clientCat from "../src/lib/categorize";
import * as edgeCat from "../supabase/functions/_shared/categorize.ts";
import * as doorCat from "../supabase/functions/_shared/muse/lib/categorize.ts";
import { MERCHANT_CATEGORY } from "../src/lib/categorizeData";
import { buildImportPlan } from "../src/lib/importStatement";
import { spentByCategoryBetween } from "../src/lib/plan";
import { normalize, reconcile, type PlaidTxn } from "../supabase/functions/_shared/plaidSync.ts";
import { pendingFields } from "../supabase/functions/_shared/pendingRow.ts";
import {
  armDedupGuard,
  claimStatementCopy,
  contentKey,
  dedupScanWindow,
  type DedupScanRow,
} from "../supabase/functions/_shared/dedupGuard.ts";
import { toTransaction } from "../supabase/functions/_shared/muse/rows.ts";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import { FINANCE_WRITE_TOOLS } from "../supabase/functions/muse-write/toolsFinance.ts";
import {
  earliestHistoryDate,
  findDuplicate,
  planHistoryRow,
} from "../supabase/functions/muse-write/historyRow.ts";
import type { Ctx } from "../supabase/functions/muse-write/kit.ts";
import type { Db } from "../supabase/functions/muse-write/db.ts";
import { FinanceFake, type Row } from "./museFinanceFake.ts";

// ── the history labels, found by label rather than typed ─────────────────────

const labelled = (label: string, prefix: string) =>
  Object.keys(MERCHANT_CATEGORY).filter((k) => MERCHANT_CATEGORY[k] === label && k.startsWith(prefix));

const TO = "ZELLE PAYMENT TO ";
const FROM = "ZELLE PAYMENT FROM ";
const FRIENDS_OUT = labelled("Zelle: friends/family", TO);
const FRIENDS_IN = labelled("Zelle: friends/family", FROM);
const SPOUSE_OUT = labelled("Internal: spouse", TO);
const SPOUSE_IN = labelled("Internal: spouse", FROM);

/** merchantKey() keeps 28 characters AFTER trimming, so a history key built from a long
 *  name is the name cut short — sometimes mid-word, sometimes ending in the space before
 *  a second word. Rebuilding a line from such a key needs the rest of a name after it, or
 *  the rebuilt line trims to a DIFFERENT key (the trailing space is lost) and the label
 *  lookup misses. The added word is made up; the cut drops it again. */
const KEY_LEN = 28;
const nameOf = (key: string, prefix: string) => {
  const name = key.slice(prefix.length);
  return key.length === KEY_LEN ? `${name}SAMPLETAIL` : name;
};

/** The posted wording Bank of America uses, rebuilt from a history key. The code is made up. */
const posted = (key: string) =>
  key.startsWith(TO)
    ? `Zelle payment to ${nameOf(key, TO)} Conf# TESTFF1`
    : `Zelle payment from ${nameOf(key, FROM)} Conf# TESTFF1`;

/** The PENDING wording of the same Zelle: "Zelle Transfer Conf# …; NAME". */
const pendingWording = (key: string) => `Zelle Transfer Conf# TESTFF1; ${nameOf(key, key.startsWith(TO) ? TO : FROM)}`;

describe("the history labels this is about are really there", () => {
  it("has friends/family and spouse keys in both directions, and each rebuilds to its own key", () => {
    // If the data file is regenerated without these, the tests below would pass by
    // looping over nothing. Say so instead.
    for (const keys of [FRIENDS_OUT, FRIENDS_IN, SPOUSE_OUT, SPOUSE_IN]) expect(keys.length).toBeGreaterThan(0);
    for (const k of [...FRIENDS_OUT, ...FRIENDS_IN, ...SPOUSE_OUT, ...SPOUSE_IN]) {
      expect(clientCat.merchantKey(posted(k))).toBe(k);
    }
  });
});

// ── 1. the categorizer, all three copies ─────────────────────────────────────

const COPIES = [
  ["the app (src/lib)", clientCat],
  ["the bank feed (supabase/functions/_shared)", edgeCat],
  ["the Muse doors (generated _shared/muse/lib)", doorCat],
] as const;

for (const [where, cat] of COPIES) {
  describe(`money sent to a friend or relative is spending — ${where}`, () => {
    it("files an outgoing friends/family Zelle as `other`, at low confidence so it asks", () => {
      for (const k of FRIENDS_OUT) {
        const d = posted(k);
        // Both ways the importers call it: with the clean name as its own raw line (the
        // feed and the statement import), and with no raw line at all.
        for (const c of [cat.classify(d, -40, {}, d), cat.classify(d, -40, {})]) {
          expect(c.kind).toBe("variable");
          expect(c.appCategory).toBe("other");
          expect(c.confidence).toBe("low");
        }
      }
    });

    it("lets a rule he taught for that person win, as for any merchant", () => {
      for (const k of FRIENDS_OUT) {
        const c = cat.classify(posted(k), -40, { [k]: { kind: "variable", categoryId: "entertainment" } }, posted(k));
        expect(c).toMatchObject({ kind: "variable", appCategory: "entertainment", confidence: "high" });
      }
    });

    it("leaves money RECEIVED from a friend or relative as income, unchanged", () => {
      for (const k of FRIENDS_IN) {
        expect(cat.classifyCredit(posted(k))).toBe("income");
        // classify() never files a credit, whatever the label.
        expect(cat.classify(posted(k), 40, {}, posted(k)).kind).toBe("skip");
      }
    });

    it("still drops money moving between their own accounts, in both directions", () => {
      for (const k of SPOUSE_OUT) expect(cat.classify(posted(k), -40, {}, posted(k)).kind).toBe("skip");
      for (const k of SPOUSE_IN) expect(cat.classifyCredit(posted(k))).toBe("transfer");
      expect(cat.classify("Online Banking transfer to CHK 1234 Confirmation# TEST1", -40).kind).toBe("skip");
    });
  });
}

describe("every path that classifies a statement line now records it", () => {
  it("the statement import offers it as a row to take, flagged, instead of skipping it", () => {
    const k = FRIENDS_OUT[0];
    const plan = buildImportPlan([{ date: "2026-09-12", description: posted(k), amount: -40 }], [], [], {});
    expect(plan.skipped).toEqual([]);
    expect(plan.variable).toHaveLength(1);
    expect(plan.variable[0]).toMatchObject({ appCategory: "other", lowConfidence: true, include: true });
    // …and a spouse Zelle is still skipped.
    const spouse = buildImportPlan([{ date: "2026-09-12", description: posted(SPOUSE_OUT[0]), amount: -40 }], [], [], {});
    expect(spouse.variable).toEqual([]);
    expect(spouse.skipped).toHaveLength(1);
  });

  it("the pending path writes it too, filed the way its posted twin will be", () => {
    // The live learned rule on the pending wording's bare key. Without the posted-wording
    // filing it would have filed a relative's Zelle as Household + Hygiene, unflagged,
    // for as long as it was processing — and then moved it to Misc the day it settled.
    const learned = { "ZELLE TRANSFER": { kind: "variable" as const, categoryId: "shopping" } };
    for (const k of FRIENDS_OUT) {
      const t: PlaidTxn = {
        transaction_id: `p-${k.length}`,
        pending: true,
        account_id: "acct-sample",
        date: "2026-09-12",
        name: pendingWording(k),
        merchant_name: null,
        amount: 40, // Plaid's sign: + is money out
      };
      expect(pendingFields(normalize(t), learned)).toEqual({
        type: "expense",
        amount: 40,
        category_id: "other",
        needs_review: true,
      });
      // The posted twin, as plaid/index.ts files it: the same category, the same flag.
      const c = edgeCat.classify(posted(k), -40, learned, posted(k));
      expect([c.appCategory, c.confidence === "low"]).toEqual(["other", true]);
    }
  });

  it("the pending path still drops a Zelle between their own accounts", () => {
    for (const k of SPOUSE_OUT) {
      const t: PlaidTxn = {
        transaction_id: "p-spouse",
        pending: true,
        account_id: "acct-sample",
        date: "2026-09-12",
        name: pendingWording(k),
        merchant_name: null,
        amount: 40,
      };
      expect(pendingFields(normalize(t), {})).toBeNull();
    }
  });
});

// ── 2. finance.add_history_row ───────────────────────────────────────────────

// 7 PM on 26 Sep 2026 in Arizona — already the 27th on a UTC clock, the window where a
// door that read the runtime's date would file a row under tomorrow.
const AT = new Date("2026-09-27T02:00:00Z");
const ACCT = "aaaa1111-2222-4333-8444-555555555555";
const DEBT = "dddd1111-2222-4333-8444-555555555555";
const FEED = "ffff1111-2222-4333-8444-555555555555";
const BILL = "bbbb1111-2222-4333-8444-555555555555";

/** A ledger row with every column present, the way the real table returns one. */
const ledgerRow = (over: Row): Row => ({
  date: "2026-09-10",
  amount: 25,
  type: "expense",
  category_id: "dining",
  description: "Sample Diner",
  account_id: ACCT,
  applies_to: null,
  flow_override: null,
  splits: null,
  anomaly_ack: false,
  needs_review: false,
  user_categorized: false,
  record_only: false,
  provider: "plaid",
  status: "posted",
  created_at: "2026-09-10T12:00:00Z",
  person: null,
  ...over,
});

function household(): FinanceFake {
  const db = new FinanceFake();
  db.tables.accounts.push({ id: ACCT, name: "Sample Checking", owner: "Sample", balance: 500, provider_account_id: null, last4: null });
  db.tables.debts.push({ id: DEBT, name: "Sample card", balance: 900, provider_account_id: null, track_pattern: null });
  db.tables.recurring.push({
    id: BILL,
    name: "Sample bill",
    amount: 40,
    direction: "out",
    cadence: "monthly",
    category_id: "utilities",
    active: true,
    variable: false,
    known_amount: null,
    due_days: [12],
    starts_on: null,
    ends_on: null,
    linked_debt_id: null,
    account_id: null,
  });
  db.tables.transactions.push(ledgerRow({ id: FEED }));
  return db;
}

function ctx(db: FinanceFake): Ctx {
  const clock = clockNow(AT);
  return { db: db as unknown as Db, push: () => Promise.resolve(), person: "gino", at: clock.at, az: clock.az, appUrl: "https://example.test/" };
}

const tool = (name: string) => FINANCE_WRITE_TOOLS[name];
const add = (db: FinanceFake, args: Record<string, unknown>) => tool("finance.add_history_row").run(args, ctx(db));

/** A call that works against household(), with only what a test is about changed. */
const CALL = { account_id: ACCT, date: "2026-09-12", amount: 40, type: "expense", description: "Corner Bakery" };

type Ok = { ok: true; result: Record<string, unknown>; say: string };
type No = { ok: false; status: number; say: string };

describe("finance.add_history_row writes the statement import's row, and moves nothing", () => {
  it("writes record_only, no provider, the account it was for — and no balance or debt moves", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, category_id: "dining" })) as Ok;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const row = db.tables.transactions.find((r) => r.id === out.result.id);
    // Every column, exactly: the import's choices plus the two review flags.
    expect(row).toEqual({
      id: out.result.id,
      date: "2026-09-12",
      amount: 40,
      type: "expense",
      category_id: "dining",
      description: "Corner Bakery",
      account_id: ACCT,
      applies_to: null,
      record_only: true,
      user_categorized: true,
      needs_review: false,
      person: "gino",
    });
    expect(row!.provider).toBeUndefined(); // the table's default, null — never "plaid"
    expect(db.tables.accounts[0].balance).toBe(500);
    expect(db.tables.debts[0].balance).toBe(900);
    // A plain insert — never apply_money_event, which would take the $40 off the account.
    expect(db.writes.map((w) => w.op)).toEqual(["insert"]);
    expect(out.say).toContain("No balance moved");
    expect(out.say).toContain("Sample's Sample Checking");
  });

  it("files a missing friends/family Zelle the way the categorizer now does: other, flagged", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, description: posted(FRIENDS_OUT[0]) })) as Ok;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === out.result.id)).toMatchObject({
      category_id: "other",
      needs_review: true,
      user_categorized: false,
      record_only: true,
    });
    expect(out.say).toContain("flagged it for review");
  });

  it("uses his learned rule for the merchant before the app's own guess", async () => {
    const db = household();
    db.tables.merchant_rules.push({ id: "rule-1", pattern: "CORNER BAKERY", kind: "variable", category_id: "groceries", bill_name: null });
    const out = (await add(db, CALL)) as Ok;
    expect(db.tables.transactions.find((r) => r.id === out.result.id)).toMatchObject({
      category_id: "groceries",
      needs_review: false,
      user_categorized: false,
    });
  });

  it("files money in the way the bank feed does: a paycheck is salary, anything else other-income", async () => {
    const db = household();
    const pay = (await add(db, { ...CALL, type: "income", description: "SAMPLE CO DES:PAYROLL" })) as Ok;
    const gift = (await add(db, { ...CALL, type: "income", amount: 41, description: posted(FRIENDS_IN[0]) })) as Ok;
    expect(db.tables.transactions.find((r) => r.id === pay.result.id)?.category_id).toBe("salary");
    expect(db.tables.transactions.find((r) => r.id === gift.result.id)?.category_id).toBe("other-income");
    expect(db.tables.accounts[0].balance).toBe(500);
  });

  it("refuses an account that does not exist", async () => {
    const out = (await add(household(), { ...CALL, account_id: "11111111-2222-4333-8444-999999999999" })) as No;
    expect(out).toMatchObject({ ok: false, status: 404 });
  });
});

describe("finance.add_history_row will not add a row that is already there", () => {
  it("refuses the same amount, account and merchant within three days, and names the row", async () => {
    const db = household();
    const before = db.tables.transactions.length;
    const out = (await add(db, { ...CALL, amount: 25, description: "SAMPLE DINER" })) as No;
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(out.say).toContain(FEED);
    expect(out.say).toContain("2026-09-10");
    expect(db.tables.transactions).toHaveLength(before);
    expect(db.changes).toEqual([]);
  });

  it("recognises the statement's wording of a feed row, the way the statement import does", async () => {
    const out = (await add(household(), { ...CALL, amount: 25, description: "CHECKCARD 0910 SAMPLE DINER PHOENIX AZ" })) as No;
    expect(out).toMatchObject({ ok: false, status: 409 });
  });

  it("counts a row still processing as already there", async () => {
    const db = household();
    db.tables.transactions[0].status = "pending";
    const out = (await add(db, { ...CALL, amount: 25, description: "Sample Diner" })) as No;
    expect(out.status).toBe(409);
    expect(out.say).toContain("still processing");
  });

  it("adds it beside the other one when the caller says the statement really shows two", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, amount: 25, description: "Sample Diner", confirm: true })) as Ok;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(out.say).toContain("shows it twice");
  });

  it("is not fooled into refusing a different amount, direction, account or week", async () => {
    const db = household();
    expect((await add(db, { ...CALL, amount: 25.01, description: "Sample Diner" })).ok).toBe(true);
    expect((await add(db, { ...CALL, amount: 25, type: "income", description: "Sample Diner" })).ok).toBe(true);
    expect((await add(db, { ...CALL, amount: 25, date: "2026-09-14", description: "Sample Diner" })).ok).toBe(true);
  });

  it("writes a same-amount row under another name, and says to check it", async () => {
    const out = (await add(household(), { ...CALL, amount: 25, date: "2026-09-11", description: "Another Place" })) as Ok;
    expect(out.ok).toBe(true);
    expect(out.say).toContain("Check it is not the same money");
    expect(out.say).toContain("2026-09-10");
  });

  it("matches on the merchant key both ways, and never on a two-letter coincidence", () => {
    const near = [{ id: FEED, date: "2026-09-10", amount: 9, type: "expense" as const, description: "QT 465 INSIDE", pending: false }];
    expect(findDuplicate({ amount: 9, type: "expense", description: "QTX" }, near).duplicate).toBeNull();
    expect(findDuplicate({ amount: 9, type: "expense", description: "QT 465 INSIDE" }, near).duplicate?.id).toBe(FEED);
  });
});

describe("finance.add_history_row asks the app's judgement every time, a named category or not", () => {
  // FOUND 2026-10-10 in review. The first version returned straight away when a
  // category_id was named, so none of the refusals below ran for a named category — and
  // a test here asserted that a spouse transfer sent with category "other" was ACCEPTED.
  // The review's probe: an own-account transfer out sent with "other" was written as a
  // $40 expense, and the matching transfer in sent with "other-income" as income. The
  // feed drops the other leg of such a transfer, so nothing pairs with it and cancels
  // it: spending went up by money the household still had.
  const OWN_OUT = "Online Banking transfer to CHK 1234 Confirmation# TEST1";
  const OWN_IN = "Online Banking transfer from CHK 1234 Confirmation# TEST1";

  it("refuses money between their own accounts, with no category and with one", async () => {
    const db = household();
    for (const args of [
      { description: posted(SPOUSE_OUT[0]) },
      { description: posted(SPOUSE_OUT[0]), category_id: "other" },
      { description: OWN_OUT, category_id: "other" },
      { type: "income", description: OWN_IN },
      { type: "income", description: OWN_IN, category_id: "other-income" },
      { type: "income", description: posted(SPOUSE_IN[0]), category_id: "other-income" },
    ]) {
      const out = (await add(db, { ...CALL, ...args })) as No;
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, status: 409 });
      expect(out.say).toContain('override "kept_out"');
    }
    expect(db.tables.transactions).toHaveLength(1);
    expect(db.changes).toEqual([]);
  });

  it("takes it only with the override that names the refusal, flags it, and says it overrode the app", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, description: OWN_OUT, category_id: "entertainment", override: "kept_out" })) as Ok;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === out.result.id)).toMatchObject({
      category_id: "entertainment",
      user_categorized: true,
      needs_review: true, // it shows once more where he looks
      record_only: true,
    });
    expect(out.result.overrode).toBe("kept_out");
    expect(out.say).toContain("overrides the app");
    expect(db.tables.accounts[0].balance).toBe(500);
  });

  it("will not let one override carry a row past a different refusal, or override nothing", async () => {
    const db = household();
    const crossed = (await add(db, { ...CALL, description: OWN_OUT, category_id: "other", override: "bill_payment" })) as No;
    expect(crossed).toMatchObject({ ok: false, status: 409 });
    expect(crossed.say).toContain('override "bill_payment" does not apply');
    // An ordinary merchant: nothing for the override to set aside. Refused, so an
    // override cannot become a habit sent on every call "just in case".
    const idle = (await add(db, { ...CALL, category_id: "dining", override: "kept_out" })) as No;
    expect(idle).toMatchObject({ ok: false, status: 409 });
    expect(idle.say).toContain("nothing to override");
    // `confirm` is the duplicate's answer and overrides none of this.
    const confirmed = (await add(db, { ...CALL, description: OWN_OUT, category_id: "other", confirm: true })) as No;
    expect(confirmed).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.transactions).toHaveLength(1);
  });

  it("reads his learned rule even when a category is named — a rule saying skip is part of the judgement", async () => {
    const db = household();
    db.tables.merchant_rules.push({ id: "rule-skip", pattern: "CORNER BAKERY", kind: "skip", category_id: null, bill_name: null });
    const out = (await add(db, { ...CALL, category_id: "dining" })) as No;
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(out.say).toContain('override "kept_out"');
  });

  it("refuses a bill payment with a category unless the override names it, then lets the link follow", async () => {
    const db = household();
    const plain = (await add(db, { ...CALL, description: "SPOTIFY USA", category_id: "bills" })) as No;
    expect(plain).toMatchObject({ ok: false, status: 409 });
    expect(plain.say).toContain("Spotify");
    expect(plain.say).toContain('override "bill_payment"');
    expect(plain.say).toContain("finance.link_charge_to_bill");
    const out = (await add(db, { ...CALL, description: "SPOTIFY USA", category_id: "bills", override: "bill_payment" })) as Ok;
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === out.result.id)).toMatchObject({
      category_id: "bills",
      user_categorized: true,
      needs_review: false, // the link is the next step, not a review
      applies_to: null,
    });
    expect(out.say).toContain("finance.link_charge_to_bill");
  });

  it("refuses a payment on a tracked debt outright — no category, no override gets it in as spending", async () => {
    const db = household();
    db.tables.debts.push({ id: "dddd2222-2222-4333-8444-555555555555", name: "Sample loan", balance: 300, provider_account_id: null, track_pattern: "SAMPLELOAN" });
    for (const args of [
      {},
      { category_id: "other" },
      { category_id: "other", override: "kept_out" },
      { category_id: "bills", override: "bill_payment" },
    ]) {
      const out = (await add(db, { ...CALL, description: "SAMPLELOAN PAYMENT 0912", ...args })) as No;
      expect(out, JSON.stringify(args)).toMatchObject({ ok: false, status: 409 });
      expect(out.say).toContain("Sample loan");
      expect(out.say).toContain("nothing overrides this one");
    }
    expect(db.tables.transactions).toHaveLength(1);
    expect(db.tables.debts.map((d) => d.balance)).toEqual([900, 300]);
  });

  it("refuses a payment his history labels as a debt, with its own sentence, not the transfer one", async () => {
    // Found by label, not typed: the first history key labelled "Debt: ..." that reads
    // back as itself.
    const key = Object.keys(MERCHANT_CATEGORY).find(
      (k) => MERCHANT_CATEGORY[k].startsWith("Debt:") && clientCat.merchantKey(k) === k,
    )!;
    expect(key).toBeTruthy();
    const out = (await add(household(), { ...CALL, description: key, category_id: "other" })) as No;
    expect(out).toMatchObject({ ok: false, status: 409 });
    expect(out.say).toContain("payment on a debt");
    expect(out.say).toContain("nothing overrides this one");
    expect(out.say).not.toContain('override "');
  });

  it("checks the override's shape before anything is read", () => {
    const shape = (args: Record<string, unknown>) => planHistoryRow({ ...CALL, ...args }, clockNow(AT));
    expect(shape({ override: "kept_out" }).ok).toBe(false); // no category_id
    expect(shape({ override: "yes", category_id: "other" }).ok).toBe(false);
    expect(shape({ override: true, category_id: "other" }).ok).toBe(false);
    expect(shape({ override: "kept_out", category_id: "other" }).ok).toBe(true);
  });
});

describe("finance.add_history_row's shape check, before anything is read", () => {
  it("names every problem at once and reads nothing", async () => {
    const db = household();
    const bad = { account_id: "nope", date: "2026-09-27", amount: 12.345, type: "spending", description: "  " };
    const problems = tool("finance.add_history_row").check!(bad, clockNow(AT));
    expect(problems).toHaveLength(5);
    expect(problems.join(" ")).toContain("has not happened yet");
    const out = (await add(db, bad)) as No;
    expect(out).toMatchObject({ ok: false, status: 400 });
    for (const p of problems) expect(out.say).toContain(p);
    expect(db.nearReads).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it("refuses a category of the wrong kind for the direction", () => {
    const shape = (args: Record<string, unknown>) => planHistoryRow({ ...CALL, ...args }, clockNow(AT));
    expect(shape({ category_id: "salary" }).ok).toBe(false);
    expect(shape({ type: "income", category_id: "dining" }).ok).toBe(false);
    expect(shape({ type: "income", category_id: "refund" }).ok).toBe(true);
    expect(shape({ category_id: "not-a-category" }).ok).toBe(false);
  });

  it("takes the last 24 months and nothing older, counted in calendar months", () => {
    const shape = (date: string) => planHistoryRow({ ...CALL, date }, clockNow(AT)).ok;
    // Arizona's today here is 2026-09-26.
    expect(shape("2024-09-26")).toBe(true);
    expect(shape("2024-09-25")).toBe(false);
    expect(shape("2026-09-26")).toBe(true);
    expect(earliestHistoryDate("2028-02-29")).toBe("2026-02-28");
  });
});

describe("finance.add_history_row's undo", () => {
  it("removes exactly that row, and the ledger is what it was — no balance moved either way", async () => {
    const db = household();
    const before = JSON.parse(JSON.stringify(db.tables));
    const out = (await add(db, CALL)) as Ok;
    expect(db.changes[0].steps).toEqual([
      { kind: "delete_row", table: "transactions", id: out.result.id, after: { applies_to: null, splits: null } },
    ]);
    const undone = await tool("system.undo").run({ token: out.result.undo }, ctx(db));
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    expect(JSON.parse(JSON.stringify(db.tables))).toEqual(before);
    expect(db.writes.map((w) => w.op)).toEqual(["insert", "delete"]);
  });

  it("refuses once something has been attached to the row, and leaves it there", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, category_id: "bills" })) as Ok;
    const linked = await tool("finance.link_charge_to_bill").run({ transaction_id: out.result.id, bill_id: BILL }, ctx(db));
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    const undone = await tool("system.undo").run({ token: out.result.undo }, ctx(db));
    expect(undone.ok).toBe(false);
    expect(db.tables.transactions.some((r) => r.id === out.result.id)).toBe(true);
  });

  it("is the only way out: delete_charge refuses a history row, as it does every imported record", async () => {
    const db = household();
    const out = (await add(db, CALL)) as Ok;
    const del = (await tool("finance.delete_charge").run({ transaction_id: out.result.id }, ctx(db))) as No;
    expect(del).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.accounts[0].balance).toBe(500);
  });
});

// ── 3. what the rest of the app does with such a row ──────────────────────────

/** What the sync's dedup scan selects, for every row in the fake ledger. A feed row the
 *  fake seeds without an id gets one, as every real feed row has. */
const scanOf = (db: FinanceFake): DedupScanRow[] =>
  db.tables.transactions.map((r) => ({
    date: String(r.date),
    amount: Number(r.amount),
    type: String(r.type),
    description: (r.description as string | null) ?? null,
    account_id: (r.account_id as string | null) ?? null,
    provider_txn_id:
      (r.provider_txn_id as string | undefined) ?? (r.provider === "plaid" ? `plaid-old-${String(r.id)}` : null),
    status: (r.status as string | undefined) ?? "posted", // the column's default
    record_only: r.record_only === true,
  }));

/** The bank delivering posted rows, through the guard exactly as plaid/index.ts arms it. */
function deliver(prior: DedupScanRow[], txns: PlaidTxn[], ours: ReadonlySet<string> = new Set()) {
  const { existingKeys, knownProviderIds, copies } = armDedupGuard(prior, ours);
  return reconcile(
    { added: txns, modified: [], removed: [] },
    contentKey,
    existingKeys,
    knownProviderIds,
    (row) => claimStatementCopy(copies, row),
  );
}

const plaidRow = (over: Partial<PlaidTxn>): PlaidTxn => ({
  transaction_id: "plaid-later-1",
  pending: false,
  account_id: "plaid-acct-sample",
  date: "2026-09-12",
  name: "SAMPLE BAKERY 0912",
  merchant_name: "Sample Bakery",
  amount: 40, // Plaid's sign: + is money out
  ...over,
});

describe("a history row counts as spending and is seen by the bank sync's duplicate guard", () => {
  it("counts in the budget partition the app grades spending from", async () => {
    const db = household();
    const out = (await add(db, { ...CALL, description: posted(FRIENDS_OUT[0]) })) as Ok;
    const txn = toTransaction(db.tables.transactions.find((r) => r.id === out.result.id)!);
    expect(txn.recordOnly).toBe(true);
    expect(spentByCategoryBetween([txn], "2026-09-01", "2026-09-30")).toEqual({ other: 40 });
  });

  it("is absorbed when the bank delivers the same charge later, not doubled", async () => {
    const db = household();
    await add(db, { ...CALL, description: "Sample Bakery" });
    const ops = deliver(scanOf(db), [plaidRow({})]);
    expect(ops.absorbed.map((r) => r.providerTxnId)).toEqual(["plaid-later-1"]);
    expect(ops.upsertPosted).toEqual([]);
  });

  it("still never arms this connection's own feed rows", () => {
    const own: DedupScanRow = {
      date: "2026-09-12", amount: 40, type: "expense", description: "Sample Bakery",
      account_id: ACCT, provider_txn_id: "plaid-own-1", status: "posted", record_only: false,
    };
    const { existingKeys, knownProviderIds, copies } = armDedupGuard([own], new Set([ACCT]));
    expect(existingKeys.size).toBe(0);
    expect(copies).toEqual([]);
    expect(knownProviderIds.has("plaid-own-1")).toBe(true);
  });
});

describe("the sync recognises a statement copy the way add_history_row's own check does", () => {
  // FOUND 2026-10-10 in review, by probing the first version on a scratch copy. The
  // door's duplicate check looked three days either side and stripped the statement's
  // noise; the sync's guard matched the exact date and merchant key only. Each probe
  // below came back "0 absorbed, 1 inserted" — and W5a skips record_only rows, so the
  // double would never have surfaced. A cursor reset (the backfill tool) or a re-link
  // re-sends up to 24 months, which is exactly when these deliveries happen.

  it("absorbs the bank's twin dated a day after the statement's date (probe 1)", async () => {
    const db = household();
    const d = posted(FRIENDS_OUT[0]);
    await add(db, { ...CALL, date: "2026-09-11", description: d });
    const ops = deliver(scanOf(db), [plaidRow({ date: "2026-09-12", name: d, merchant_name: null })]);
    expect(ops.absorbed).toHaveLength(1);
    expect(ops.upsertPosted).toEqual([]);
  });

  it("absorbs it when the copy carries the statement's wording and the feed the clean name (probe 2)", async () => {
    const db = household();
    await add(db, { ...CALL, amount: 26, date: "2026-09-12", description: "CHECKCARD 0912 SAMPLE DINER PHOENIX AZ", category_id: "dining" });
    const ops = deliver(scanOf(db), [
      plaidRow({ transaction_id: "plaid-diner", amount: 26, name: "SAMPLE DINER PHOENIX AZ", merchant_name: "Sample Diner" }),
    ]);
    expect(ops.absorbed.map((r) => r.providerTxnId)).toEqual(["plaid-diner"]);
  });

  it("lets one copy absorb only one delivery — a second identical charge still lands", async () => {
    const db = household();
    await add(db, { ...CALL, description: "Sample Bakery" });
    const ops = deliver(scanOf(db), [plaidRow({}), plaidRow({ transaction_id: "plaid-later-2", date: "2026-09-13" })]);
    expect(ops.absorbed.map((r) => r.providerTxnId)).toEqual(["plaid-later-1"]);
    expect(ops.upsertPosted.map((r) => r.providerTxnId)).toEqual(["plaid-later-2"]);
  });

  it("gives each delivery its nearest copy, so two copies a few days apart each find their own", () => {
    const copy = (date: string): DedupScanRow => ({
      date, amount: 40, type: "expense", description: "Sample Bakery",
      account_id: ACCT, provider_txn_id: null, status: "posted", record_only: true,
    });
    const ops = deliver([copy("2026-09-09"), copy("2026-09-12")], [
      plaidRow({ transaction_id: "on-12", date: "2026-09-12" }),
      plaidRow({ transaction_id: "on-06", date: "2026-09-06" }),
    ]);
    // Taking the first copy in the list instead would have spent the 9th on the 12th's
    // delivery, and the 6th's would have found nothing within three days.
    expect(ops.absorbed.map((r) => r.providerTxnId)).toEqual(["on-12", "on-06"]);
  });

  it("does not stretch to four days, another amount, another merchant, or another direction", () => {
    const copy: DedupScanRow = {
      date: "2026-09-12", amount: 40, type: "expense", description: "Sample Bakery",
      account_id: ACCT, provider_txn_id: null, status: "posted", record_only: true,
    };
    for (const t of [
      plaidRow({ date: "2026-09-16" }),
      plaidRow({ date: "2026-09-08" }),
      plaidRow({ amount: 40.01 }),
      plaidRow({ name: "OTHER SHOP 0912", merchant_name: "Other Shop" }),
      plaidRow({ amount: -40 }), // money in
    ]) {
      const ops = deliver([copy], [t]);
      expect(ops.absorbed, JSON.stringify(t)).toEqual([]);
      expect(ops.upsertPosted).toHaveLength(1);
    }
  });

  it("leaves a hand-entered row on the exact rule it always had — only statement copies are matched loosely", () => {
    const hand: DedupScanRow = {
      date: "2026-09-11", amount: 40, type: "expense", description: "Sample Bakery",
      account_id: ACCT, provider_txn_id: null, status: "posted", record_only: false,
    };
    expect(deliver([hand], [plaidRow({ date: "2026-09-12" })]).absorbed).toEqual([]);
    expect(deliver([hand], [plaidRow({ date: "2026-09-11" })]).absorbed).toHaveLength(1);
  });

  it("never absorbs a row we already store, so a cursor reset still heals instead of skipping", () => {
    const copy: DedupScanRow = {
      date: "2026-09-12", amount: 40, type: "expense", description: "Sample Bakery",
      account_id: ACCT, provider_txn_id: null, status: "posted", record_only: true,
    };
    const stored: DedupScanRow = { ...copy, provider_txn_id: "plaid-later-1", record_only: false };
    const ops = deliver([copy, stored], [plaidRow({})], new Set([ACCT]));
    expect(ops.absorbed).toEqual([]);
    expect(ops.upsertPosted.map((r) => r.providerTxnId)).toEqual(["plaid-later-1"]);
  });

  it("is what the sync actually runs: a wider scan, record_only selected and never filtered on", () => {
    expect(dedupScanWindow(["2026-09-12", "2026-09-01", "2026-09-30"])).toEqual({ from: "2026-08-29", to: "2026-10-03" });
    const src = readFileSync("supabase/functions/plaid/index.ts", "utf8");
    expect(src).toMatch(/armDedupGuard\(prior/);
    expect(src).toMatch(/claimStatementCopy\(copies, row\)/);
    // The query alone — from the scan's name to the `);` that closes it.
    const start = src.indexOf('readAllPages("dedup scan"');
    expect(start).toBeGreaterThan(-1);
    const scan = src.slice(start, src.indexOf(");", start));
    expect(scan).toContain('.select("date, amount, type, description, account_id, provider_txn_id, status, record_only")');
    expect(scan).toContain("scanWindow.from");
    expect(scan).toContain("scanWindow.to");
    expect(scan).not.toMatch(/\.(eq|is|not|neq|filter)\("record_only"/);
  });

  it("tells the caller to send the posting date and the bank's line word for word", () => {
    const t = tool("finance.add_history_row");
    expect(t.does).toContain("POSTING date");
    expect(t.does).toContain("word for word");
  });
});
