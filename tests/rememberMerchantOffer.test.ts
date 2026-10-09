// The app must not offer to "Remember merchant" on a charge that names no merchant.
//
// FOUND 2026-10-09 in review. saveMerchantRule now refuses a key that is only the
// bank's own wording — the bare "CHECKCARD" of a card line with no clean name, the
// "BKOFAMERICA ATM" every withdrawal keys to — because a rule on it catches every charge
// that carries it (a "CHECKCARD -> dining" rule saved from one tap on 2026-09-24 is
// still filing them). But it refuses with a console warning, which nobody sees on the
// phone. Both sheets that recategorize a charge showed "✓ Remember merchant", ON by
// default, on exactly those charges: a tap set the one row, nothing was remembered, and
// nothing on screen said so. TxnSheet's own comment calls a toggle that reads
// "Remember" while the rule is refused worse than no toggle at all.
//
// vitest runs in node (no jsdom), so the sheets are checked as static markup, the way
// workoutViews.test.ts checks its views. The store is a stand-in; the edit sheet inside
// LedgerSheet only opens on a tap, so its `edit` state is seeded through useState.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Transaction } from "../src/types";

const mock = vi.hoisted(() => ({
  store: null as unknown,
  // The transaction LedgerSheet's `useState<Transaction | null>(null)` starts as.
  edit: null as unknown,
}));

vi.mock("../src/store/FinanceStore", () => ({ useStore: () => mock.store }));

vi.mock("react", async (importOriginal) => {
  const R = await importOriginal<typeof import("react")>();
  return {
    ...R,
    useState: (init: unknown) => R.useState(init === null && mock.edit ? mock.edit : init),
  };
});

const { TxnSheet } = await import("../src/views/redesign/TxnSheet");
const { LedgerSheet } = await import("../src/components/LedgerSheet");

const charge = (description: string): Transaction =>
  ({
    id: "t1",
    date: "2026-10-03",
    amount: 42,
    type: "expense",
    categoryId: "other",
    description,
    createdAt: "2026-10-03T12:00:00Z",
  }) as Transaction;

const noop = async () => {};
function storeWith(txn: Transaction) {
  return {
    data: { transactions: [txn], categories: DEFAULT_CATEGORIES, recurring: [], accounts: [] },
    setTransactionCategory: noop,
    setTransactionSplits: noop,
    saveMerchantRule: noop,
    makeRecurringBill: noop,
    setAsideTransaction: noop,
    deleteTransaction: noop,
    unlinkFromBill: noop,
    excludeFromBudget: noop,
  };
}

function txnSheet(description: string): string {
  const txn = charge(description);
  mock.store = storeWith(txn);
  mock.edit = null;
  return renderToStaticMarkup(createElement(TxnSheet, { txnId: txn.id, open: true, onClose: () => {} }));
}

function ledgerEditSheet(description: string): string {
  const txn = charge(description);
  mock.store = storeWith(txn);
  mock.edit = txn;
  try {
    return renderToStaticMarkup(
      createElement(LedgerSheet, { open: false, onClose: () => {}, txns: [], hasRule: () => false }),
    );
  } finally {
    mock.edit = null;
  }
}

// The bank's wording: what each of these keys to is pinned in statementNoise.test.ts.
const BANK_WORDING = [
  "CHECKCARD 0628 AZ MVD FEE NOW PHOENIX AZ",
  "BKOFAMERICA ATM 08/31 #000004567 WITHDRWL PHOENIX AZ",
  "EFT 10/03 #XXXXX1234 WITHDRWL EFT",
];
const MERCHANT = "Firestone Complete Auto Care";

describe("TxnSheet offers to remember only a real merchant", () => {
  for (const line of BANK_WORDING) {
    it(`no Remember pill on "${line}", and says the tap sets only this charge`, () => {
      const html = txnSheet(line);
      expect(html).toContain(line); // the sheet did open on this charge
      expect(html).not.toContain("Remember merchant");
      expect(html).toContain("Sets only this charge — other charges from this merchant stay as they are.");
    });
  }

  it("still offers it, ON, on a real merchant", () => {
    const html = txnSheet(MERCHANT);
    expect(html).toContain("✓ Remember merchant");
    expect(html).not.toContain("Sets only this charge");
  });
});

describe("LedgerSheet's categorize sheet offers to remember only a real merchant", () => {
  for (const line of BANK_WORDING) {
    it(`no Remember pill on "${line}", and says the tap sets only this charge`, () => {
      const html = ledgerEditSheet(line);
      expect(html).toContain(line);
      expect(html).not.toContain("Remember merchant");
      expect(html).toContain("Sets only this charge — other charges from this merchant stay as they are.");
    });
  }

  it("still offers it, ON, on a real merchant", () => {
    const html = ledgerEditSheet(MERCHANT);
    expect(html).toContain(MERCHANT);
    expect(html).toContain("✓ Remember merchant");
    expect(html).not.toContain("Sets only this charge");
  });
});
