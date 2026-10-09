// A merchant rule on the bank's own wording captures every charge that wording is on.
//
// FOUND 2026-10-09. The live merchant_rules table holds "CHECKCARD -> dining", saved on
// 2026-09-24 from one tap in the app. merchantKey() returns the literal word
// "CHECKCARD" for every Bank of America card line that has no clean name — learnedFor()
// in categorize.ts says so in its own comment — so that one rule files all of them as
// dining, whatever they were. "ZELLE TRANSFER -> shopping" was saved the same way.
//
// The fix is a refusal at SAVE time, in every path that writes merchant_rules, all
// asking one predicate. Matching is not touched: learnedFor() is unchanged, and the
// rules already in the table keep firing until Gino decides what to do with them.
//
// The descriptor shapes below are the ones the bank writes, as categorize.ts and
// flow.ts already quote them. The "leave alone" list is mostly keys the live rules
// table or ledger held on 2026-10-09, because those are the ones a wrong predicate
// would break.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isStatementNoiseKey, merchantKey } from "../src/lib/categorize";

describe("isStatementNoiseKey — the bank's sentence, not a merchant", () => {
  it("refuses the card-line prefixes stripStatementNoise already knows", () => {
    for (const key of [
      "CHECKCARD",
      "PURCHASE",
      "MOBILE PURCHASE",
      "CHECKCARD PURCHASE",
      "POS PURCHASE",
      "POS DEBIT",
      "DEBIT CARD PURCHASE",
      "RECURRING PAYMENT",
      "MOBILE PAYMENT",
      "RECURRING",
    ]) {
      expect(isStatementNoiseKey(key), key).toBe(true);
    }
  });

  it("refuses the bare payment rails", () => {
    for (const key of ["POS", "DEBIT CARD", "ACH", "ACH DEBIT", "ZELLE", "ZELLE TRANSFER", "ZELLE PAYMENT", "ZELLE PAYMENT TO", "CHECK"]) {
      expect(isStatementNoiseKey(key), key).toBe(true);
    }
  });

  it("refuses the account-to-account shapes, however merchantKey cut them", () => {
    // What merchantKey() actually returns for the bank's transfer and card-payment
    // lines. The account number is the only thing that told two cards apart, and it is
    // gone from every one of these keys.
    const lines = [
      "Mobile Banking payment to CRD 6813 Confirmation# x7k2m9q4p",
      "Online Banking payment to CRD 4728 Confirmation# 1234567890",
      "Online Banking transfer to CHK 1211 Confirmation# 7815500990",
      "Online Banking transfer from CHK 1211 Confirmation# 7815500990",
      "PAYMENT TO ACCT #6813 ON 08/25 VIA WEB",
      "TRANSFER TO ACCT #0366 ON 09/06 VIA WEB",
      "TRANSFER FROM ACCT #1211 ON 09/10 VIA WEB",
      "PAYMENT FROM CHK 1211 CONF#ABC123XYZ",
    ];
    for (const line of lines) {
      const key = merchantKey(line);
      expect(isStatementNoiseKey(key), `${line} -> ${key}`).toBe(true);
    }
    // And a card line with no clean name, which is the CHECKCARD rule's own source.
    expect(merchantKey("CHECKCARD 0628 AZ MVD FEE NOW PHOENIX AZ")).toBe("CHECKCARD");
  });

  it("refuses the cash machine and the bank's deposit channel, however the line reads", () => {
    // FOUND 2026-10-09 in review. merchantKey() cuts an ATM line at the date, so the
    // WITHDRWL / DEPOSIT word never reaches the key: every withdrawal at a Bank of
    // America machine keys to "BKOFAMERICA ATM", another bank's machine to the bare
    // "EFT", a phone cheque deposit to "BKOFAMERICA MOBILE". classify() asks a person
    // what a withdrawal went on; a rule on one of these keys would answer for ever.
    // The shapes are the ones the live ledger held that day, with the digits changed.
    const lines: [string, string][] = [
      ["BKOFAMERICA ATM 08/31 #000004567 WITHDRWL PHOENIX AZ", "BKOFAMERICA ATM"],
      ["BKOFAMERICA ATM 03/29 #000004904 DEPOSIT PHOENIX AZ", "BKOFAMERICA ATM"],
      ["Bkofamerica Atm", "BKOFAMERICA ATM"],
      ["EFT 10/03 #XXXXX1234 WITHDRWL EFT", "EFT"],
      ["EFT 10/03 #XXXXX1234 WITHDRWL EFT Phoenix AZ FEE", "EFT"],
      ["BKOFAMERICA MOBILE 09/25 XXXXX12345 DEPOSIT *MOBILE", "BKOFAMERICA MOBILE"],
    ];
    for (const [line, key] of lines) {
      expect(merchantKey(line), line).toBe(key);
      expect(isStatementNoiseKey(merchantKey(line)), `${line} -> ${key}`).toBe(true);
    }
    for (const key of ["ATM", "ATM WITHDRAWAL", "ATM CASH WITHDRAWAL", "ATM CASH DEPOSIT", "BANK OF AMERICA ATM"]) {
      expect(isStatementNoiseKey(key), key).toBe(true);
    }
  });

  it("is too short to be anything", () => {
    expect(isStatementNoiseKey("")).toBe(true);
    expect(isStatementNoiseKey("X")).toBe(true);
  });

  it("leaves real merchants alone — including ones that START or END with a rail word", () => {
    for (const key of [
      // Real rules in the table, which must stay teachable.
      "INTEREST CHARGED ON PURCHASE",
      "ZELLE PAYMENT TO JANE DOE",
      "ZELLE PAYMENT TO MON",
      "FIRESTONE COMPLETE AUTO CARE",
      "SAM'S CLUB",
      "365 RETAIL MARKETS",
      // Two characters is a real merchant here: QuikTrip's pump reads "QT 465 OUTSIDE".
      "QT",
      // A payment that names a person is a payment to somebody.
      "PAYMENT TO JOHN",
      "TEMPORARY CREDIT ADJUSTMENT ",
      // Next to the cash-machine keys, and not them. Every ATM fee IS a fee, so a rule
      // on it is right; an operator that names itself is a merchant; and a phone
      // carrier is not the bank's "MOBILE" deposit channel.
      "ATM FEE",
      "COINME ATM",
      "T-MOBILE",
    ]) {
      expect(isStatementNoiseKey(key), key).toBe(false);
    }
  });
});

// ── every path in the APP that saves a rule asks first ───────────────────────
//
// FinanceStore.tsx is a React module and cannot be loaded headlessly (the same reason
// tests/live-selfaudit.test.ts gives), so its two writes are checked in the source:
// every method in src/ that upserts or inserts into merchant_rules must ask
// isStatementNoiseKey before it does. It covers the NEXT screen that learns a rule as
// well, which is the point — the app's other two backstops live in saveMerchantRule
// precisely because two of three call sites forgot the guard.

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

/** `async name(…) {` sections, the shape the store's methods are written in. */
function methodsOf(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/^\s*async (\w+)\(/gm)];
  return starts.map((m, i) => ({
    name: m[1],
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : src.length),
  }));
}

describe("the app refuses a statement-noise key before it saves a rule", () => {
  const writers = filesUnder("src").flatMap((file) =>
    methodsOf(readFileSync(file, "utf8"))
      .filter((m) => /\.from\("merchant_rules"\)\s*\.(upsert|insert)\(/.test(m.body))
      .map((m) => ({ file, ...m })),
  );

  it("finds the two places the app writes a rule", () => {
    // If this drops, the regex stopped seeing them and the check below is vacuous.
    expect(writers.map((w) => w.name).sort()).toEqual(["makeRecurringBill", "saveMerchantRule"]);
  });

  for (const w of ["saveMerchantRule", "makeRecurringBill"]) {
    it(`${w} asks isStatementNoiseKey before it writes`, () => {
      const m = writers.find((x) => x.name === w);
      expect(m, `${w} no longer writes merchant_rules`).toBeTruthy();
      const asks = m!.body.indexOf("isStatementNoiseKey(");
      const writes = m!.body.search(/\.from\("merchant_rules"\)\s*\.(upsert|insert)\(/);
      expect(asks, `${w} writes a rule without asking`).toBeGreaterThanOrEqual(0);
      expect(asks).toBeLessThan(writes);
    });
  }
});
