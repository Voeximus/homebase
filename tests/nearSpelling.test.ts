// A rule you taught reaches the same merchant spelled another way — and nothing more.
//
// FOUND 2026-10-25. A learned rule matched only the whole merchant key, character for
// character. A rule saved as "H MART MESA LLC" never reached charges Plaid names plain
// "H Mart", and one saved as "E.T. TEA" never reached "E T Tea & Popcorn Chicken", so
// shops already answered were flagged for review again. The fix is looseLearnedFor in
// src/lib/categorize.ts; these tests reproduce both shapes with made-up merchants, and
// pin the over-reach it must never do: a short key swallowing a longer, different
// merchant, one merchant's rule answering for another, a bill or skip rule settling on a
// near match, and a new rule re-deciding a row the ledger already has.
//
// Also here: Gino's Sam's Club rule of 2026-10-24 (untagged $35–$50 is gas), which sets
// only the pre-fill of a charge the bank did not tag, and the sync's seed-only flags.
//
// THE PUBLIC REPO RULE. Every merchant, name and amount below is invented, except the
// merchant names the categorizer itself already carries (Sam's Club, Costco).

import { describe, expect, it } from "vitest";
import * as clientCat from "../src/lib/categorize";
import * as edgeCat from "../supabase/functions/_shared/categorize.ts";
import * as doorCat from "../supabase/functions/_shared/muse/lib/categorize.ts";
import {
  classify,
  forExistingRow,
  looseMerchantMatch,
  merchantCore,
  merchantKey,
  type LearnedRules,
} from "../src/lib/categorize";
import { seedFlags } from "../supabase/functions/_shared/seedOnly.ts";

const spend = (desc: string, amount: number, learned?: LearnedRules, raw?: string) =>
  classify(desc, -Math.abs(amount), learned, raw);
const rule = (categoryId: string) => ({ kind: "variable" as const, categoryId });

describe("a taught rule reaches the same merchant spelled another way", () => {
  // The "H MART MESA LLC" shape: the rule carries a town and a suffix the charge drops.
  it("a rule with a corporate suffix and a town reaches the plain name", () => {
    const learned: LearnedRules = { "QUILL MART MESA LLC": rule("groceries") };
    const c = spend("Quill Mart", 38.12, learned);
    expect(c.appCategory).toBe("groceries");
    expect(c.confidence).toBe("high");
    expect(c.reason).toContain("QUILL MART MESA LLC");
    // The failure it reproduces: without the near-spelling look the charge was a
    // stranger, filed at low confidence and asked about again.
    expect(spend("Quill Mart", 38.12, {}).confidence).toBe("low");
  });

  // The "E.T. TEA" shape: punctuation in the rule, and the charge runs on past it.
  it("a punctuated rule reaches a longer name that starts with it", () => {
    const learned: LearnedRules = { "Z.Q. TEA": rule("dining") };
    const c = spend("Z Q Tea & Popcorn Chicken", 14.6, learned);
    expect(c.appCategory).toBe("dining");
    expect(c.confidence).toBe("high");
    // Before: the keyword guess got the category right and still asked, every time.
    expect(spend("Z Q Tea & Popcorn Chicken", 14.6, {}).confidence).toBe("low");
  });

  it("case, punctuation, apostrophes, suffixes and store numbers are not part of a name", () => {
    expect(looseMerchantMatch(merchantKey("Blue-Finch Bakery"), merchantKey("BLUE FINCH BAKERY"))).toBe(true);
    expect(looseMerchantMatch("ACME WIDGETS INC", merchantKey("Acme Widgets"))).toBe(true);
    expect(looseMerchantMatch("PEBBLE GROCER", merchantKey("PEBBLE GROCER STORE 12"))).toBe(true);
    expect(looseMerchantMatch("TARGETTO", merchantKey("TARGETTO T-1429"))).toBe(true);
    expect(looseMerchantMatch("MOLLY'S OVEN", merchantKey("Molly S Oven"))).toBe(true);
    expect(looseMerchantMatch("MOLLY&APOS S OVEN", merchantKey("Molly's Oven"))).toBe(true);
  });

  it("a name of two words or more loses a trailing town and state, even one the bank cut short", () => {
    expect(looseMerchantMatch("BLUE FINCH BAKERY", merchantKey("BLUE FINCH BAKERY TEMPE AZ"))).toBe(true);
    // The bank cuts the town short; a cut of six letters or more is still the town.
    expect(looseMerchantMatch("BLUE FINCH BAKERY", merchantKey("BLUE FINCH BAKERY CHANDL"))).toBe(true);
    expect(merchantCore("BLUE FINCH SCOTTSDALE")).toEqual(["BLUE", "FINCH"]);
  });

  // CHANGED 2026-10-25 in review. This said a one-word name also lost its town and
  // state. It no longer does: with one word in front, the place may be the very thing
  // that tells two merchants apart ("CITY OF" is one word and a filler), so it stays —
  // see the tests under "…and never reaches a different merchant". A store code is not
  // a place and still comes off.
  it("a one-word name keeps its town and state, and still loses a store code", () => {
    expect(looseMerchantMatch("FJORDIA", merchantKey("FJORDIA TEMPE AZ"))).toBe(false);
    expect(merchantCore("FJORDIA SCOTTSDALE")).toEqual(["FJORDIA", "SCOTTSDALE"]);
    expect(looseMerchantMatch("FJORDIA", "FJORDIA #2210")).toBe(true);
  });

  it("the leading number of a name is part of the name", () => {
    expect(merchantCore("7-STAR MART")).toEqual(["7", "STAR", "MART"]);
    expect(looseMerchantMatch("7-STAR MART", "8 STAR MART")).toBe(false);
  });

  it("is the same in all three copies of the categorizer", () => {
    for (const cat of [clientCat, edgeCat, doorCat]) {
      expect(cat.looseMerchantMatch("QUILL MART MESA LLC", "QUILL MART")).toBe(true);
      expect(cat.looseMerchantMatch("SAM", "SAMS CLUB")).toBe(false);
    }
  });
});

describe("…and never reaches a different merchant", () => {
  it("a short key never swallows a longer one: whole words, and one word only matches itself", () => {
    expect(looseMerchantMatch("SAM", "SAMS CLUB")).toBe(false);
    expect(looseMerchantMatch("BOLT", "BOLTS HARDWARE")).toBe(false);
    expect(looseMerchantMatch("UBERTO", "UBERTO EATS")).toBe(false);
    expect(looseMerchantMatch("NOVA", "NOVA KINDLE")).toBe(false);
  });

  it("a name that is one real word and a filler word is still one word", () => {
    expect(looseMerchantMatch("THE ALLEY", "THE ALLEY CAT BAR")).toBe(false);
  });

  // FOUND 2026-10-25 in review. A trailing town came off whatever was left in front,
  // so every "CITY OF <town>" came down to "CITY OF", and equal cores match with no
  // floor at all. The town names here are real places on the categorizer's own list —
  // they have to be, the list is what strips them — and no charge or amount is real.
  it("one city, university or town is never another: the place IS the name after 'OF'", () => {
    expect(merchantCore("CITY OF PHOENIX")).toEqual(["CITY", "OF", "PHOENIX"]);
    expect(looseMerchantMatch("CITY OF PHOENIX", "CITY OF MESA")).toBe(false);
    expect(looseMerchantMatch("CITY OF TEMPE", merchantKey("City of Gilbert AZ"))).toBe(false);
    expect(looseMerchantMatch("UNIVERSITY OF ARIZONA", "UNIVERSITY OF PHOENIX")).toBe(false);
    expect(looseMerchantMatch("TOWN OF GILBERT", "TOWN OF QUEEN CREEK")).toBe(false);
    // Nor when two real words come before the filler.
    expect(looseMerchantMatch("FAMILY DENTAL OF MESA", "FAMILY DENTAL OF TEMPE")).toBe(false);
    // The same city, spelled with its state, is still the same city.
    expect(looseMerchantMatch("CITY OF MESA", merchantKey("City of Mesa AZ"))).toBe(true);
  });

  it("a rule taught on one city's charge does not file another city's", () => {
    const learned: LearnedRules = { "CITY OF PHOENIX": rule("transport") };
    const c = spend("City of Mesa", 85, learned, "CITY OF MESA UTILITY MESA AZ");
    expect(c.reason).not.toContain("you taught it");
    expect(c.seedOnly).toBeFalsy();
    expect(c.confidence).toBe("low"); // still asked about, as before
    const u = spend("University of Phoenix", 120, { "UNIVERSITY OF ARIZONA": rule("education") });
    expect(u.reason).not.toContain("you taught it");
  });

  it("look-alike names are different merchants", () => {
    expect(looseMerchantMatch("PINE CAFE", "PINECONE CAFE")).toBe(false);
    expect(looseMerchantMatch("RIVER STONE GRILL", "RIVER STONES")).toBe(false);
    expect(looseMerchantMatch("QUILL MART", "QUILT MART")).toBe(false);
  });

  it("a short single-word key with a taught rule does not answer for a longer merchant", () => {
    const learned: LearnedRules = { NOVA: rule("shopping") };
    const c = spend("Nova Kindle Unlimited", 11.99, learned);
    expect(c.reason).not.toContain("you taught it");
  });

  it("two rules that disagree about a name leave it to a person", () => {
    const learned: LearnedRules = {
      "BRISK FOODS": rule("groceries"),
      "BRISK FOODS EXPRESS": rule("dining"),
    };
    const c = spend("Brisk Foods Express Tempe", 22.4, learned);
    expect(c.seedOnly).toBeFalsy();
    expect(c.reason).not.toContain("you taught it");
  });

  it("a payment rail is never matched loosely — the person after it is the whole name", () => {
    expect(looseMerchantMatch("ZELLE PAYMENT TO JO", "ZELLE PAYMENT TO JO ANN")).toBe(false);
    const learned: LearnedRules = { "ZELLE PAYMENT TO JO": rule("dining") };
    expect(spend("Zelle payment to JO ANN Conf# TESTNS1", 30, learned).appCategory).not.toBe("dining");
  });

  it("the bank's own wording is never a merchant, loosely or not", () => {
    expect(looseMerchantMatch("CHECKCARD", "CHECKCARD 0901")).toBe(false);
  });

  it("a bill rule and a skip rule stay exact: a near match never settles a bill or drops a charge", () => {
    const learned: LearnedRules = {
      "MOSSWATER UTILITY CO": { kind: "bill", billName: "Water" },
      "GLINT PAYMENTS SVC": { kind: "skip" },
    };
    expect(spend("Mosswater Utility", 61.2, learned).kind).not.toBe("bill");
    expect(spend("Glint Payments Svc Tempe", 18, learned).kind).not.toBe("skip");
  });

  it("an exact rule still answers first, and a near rule never outranks a bill rule", () => {
    const learned: LearnedRules = { "QUILL MART": rule("dining"), "QUILL MART MESA LLC": rule("groceries") };
    expect(spend("Quill Mart", 9, learned).appCategory).toBe("dining");
    // A built-in bill rule names the biller; a near-spelled learned rule cannot take it.
    expect(spend("Spotify USA", 11.99, { "SPOTIFY USA PREMIUM": rule("entertainment") }).kind).toBe("bill");
  });

  it("never at a merchant that runs a fuel station and a store", () => {
    const learned: LearnedRules = { "SAMS CLUB.COM": rule("groceries") };
    const c = spend("Sam's Club", 120, learned, "CHECKCARD 0905 SAMS CLUB #1234");
    expect(c.seedOnly).toBeFalsy();
  });

  // FOUND 2026-10-25 in review. The near-spelling step ran before the last-resort
  // lookup that strips the bank's noise off the raw line and asks his history labels
  // again — and that lookup is not a guess: it can say SKIP, a row kept out of the
  // ledger. "AZ DEPT OF REV" is a key the categorizer's own history already carries,
  // labelled a tax refund (skip); the rule and the amount are invented.
  it("never over his own history label for the merchant under the raw line's noise", () => {
    const raw = "POS DEBIT 1012 AZ DEPT OF REV PHOENIX AZ";
    const before = spend("Pos Debit", 40, {}, raw);
    expect(before.kind).toBe("skip");
    const c = spend("Pos Debit", 40, { "AZ DEPT OF REV LLC": rule("shopping") }, raw);
    expect(c).toEqual(before);
    expect(c.seedOnly).toBeFalsy();
  });

  it("…while a raw line with no history label under it still takes the near rule", () => {
    const c = spend("Pos Debit", 40, { "QUILL MART MESA LLC": rule("groceries") }, "POS DEBIT 1012 QUILL MART TEMPE AZ");
    expect(c.appCategory).toBe("groceries");
    expect(c.seedOnly).toBe(true);
  });
});

describe("a near-spelling answer seeds a new row and never re-decides an old one", () => {
  const learned: LearnedRules = { "QUILL MART MESA LLC": rule("groceries") };

  it("carries what the categorizer said before the rule, for a row already in the ledger", () => {
    const c = spend("Quill Mart", 38.12, learned);
    expect(c.seedOnly).toBe(true);
    // The sync's relabel sweep and a re-delivered row are asked with forExistingRow:
    // exactly the old answer, as if the rule did not exist.
    expect(forExistingRow(c)).toEqual(spend("Quill Mart", 38.12, {}));
    expect(forExistingRow(c).confidence).toBe("low");
  });

  it("a rule taught after the first charge was read is seen on the next one", () => {
    const rules: LearnedRules = {};
    expect(spend("Quill Mart", 5, rules).seedOnly).toBeFalsy();
    rules["QUILL MART MESA LLC"] = rule("groceries");
    expect(spend("Quill Mart", 5, rules).appCategory).toBe("groceries");
  });

  it("an ordinary answer is its own answer for an existing row", () => {
    const c = spend("Quill Mart", 38.12, { "QUILL MART": rule("groceries") });
    expect(c.seedOnly).toBeFalsy();
    expect(forExistingRow(c)).toBe(c);
  });

  // apply_bank_sync's ON CONFLICT, as schema_v26 wrote it: a user-chosen row is sacred;
  // otherwise keep_category keeps the category, and needs_review always takes what is
  // sent. A mirror in a test, so the flags can be proven against it.
  type Stored = { category_id: string; needs_review: boolean; user_categorized: boolean };
  const onConflict = (existing: Stored, sent: { category_id: string; needs_review: boolean; keep_category: boolean }): Stored => ({
    category_id: existing.user_categorized || sent.keep_category ? existing.category_id : sent.category_id,
    needs_review: existing.user_categorized ? existing.needs_review : sent.needs_review,
    user_categorized: existing.user_categorized,
  });

  it("a NEW row takes the rule's answer, unflagged", () => {
    const c = spend("Quill Mart", 38.12, learned);
    expect(seedFlags(c, undefined)).toEqual({ needs_review: false, keep_category: true });
  });

  it("an OLD row comes back exactly as it was — category and review flag both", () => {
    const c = spend("Quill Mart", 38.12, learned);
    const old: Stored = { category_id: "other", needs_review: true, user_categorized: false };
    const sent = { category_id: c.appCategory!, ...seedFlags(c, old.needs_review) };
    expect(onConflict(old, sent)).toEqual(old);
  });

  it("a row the rule seeded is not flagged again by the next re-sync", () => {
    const c = spend("Quill Mart", 38.12, learned);
    const seeded: Stored = { category_id: "groceries", needs_review: false, user_categorized: false };
    const sent = { category_id: c.appCategory!, ...seedFlags(c, seeded.needs_review) };
    expect(onConflict(seeded, sent)).toEqual(seeded);
  });

  it("an answer that is not seed-only is sent exactly as before", () => {
    expect(seedFlags({ confidence: "low" }, true)).toEqual({ needs_review: true, keep_category: false });
    expect(seedFlags({ confidence: "high" }, true)).toEqual({ needs_review: false, keep_category: false });
    expect(seedFlags({ confidence: "low", ambiguous: true }, undefined)).toEqual({ needs_review: true, keep_category: true });
  });
});

describe("Sam's Club: Gino's band sets the pre-fill of an untagged charge (2026-10-24)", () => {
  const store = (amount: number) => spend("Sam's Club", amount, undefined, "CHECKCARD 1012 SAMS CLUB #1234 TEMPE AZ");

  it("$35 to $50 with no pump tag is gas, both ends included", () => {
    for (const amount of [35, 41.5, 50]) {
      const c = store(amount);
      expect(c.appCategory, String(amount)).toBe("transport");
      expect(c.reason, String(amount)).toContain("household rule");
    }
  });

  it("any other untagged amount is the store", () => {
    for (const amount of [12.4, 34.99, 50.01, 66]) expect(store(amount).appCategory, String(amount)).toBe("groceries");
  });

  it("it is still asked about, and still never overwrites a row the ledger has", () => {
    const c = store(41.5);
    expect(c.ambiguous).toBe(true);
    expect(c.confidence).toBe("low");
    expect(seedFlags(c, undefined).keep_category).toBe(true);
  });

  it("a charge the bank tagged as the pump keeps its tag", () => {
    const c = spend("Sam's Club", 62, undefined, "SAMSCLUB 1234 GAS 10/12");
    expect(c.appCategory).toBe("transport");
    expect(c.ambiguous).toBeFalsy();
    expect(c.confidence).toBe("high");
  });

  it("the band is only Sam's Club's — another fuel-and-store merchant keeps its own pre-fill", () => {
    const c = spend("Costco", 41.5, undefined, "CHECKCARD 1012 COSTCO WHSE #1234 TEMPE AZ");
    expect(c.ambiguous).toBe(true);
    expect(c.appCategory).toBe("groceries");
    expect(c.reason).not.toContain("household rule");
  });
});
