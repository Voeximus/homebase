import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENGINE_WIRED,
  danglingSuggestions,
  reviewSuggestions,
  sortSuggestions,
  toSurfaceFix,
} from "../src/lib/reviewEngine";
import { hasWrite, applyFix, type ReviewWrites } from "../src/views/redesign/reviewApply";
import { REVIEW_STRINGS } from "../src/lib/ledgerReview";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import { ZH } from "../src/lib/i18n_zh";
import type { AppData, Account, Recurring, Transaction } from "../src/types";

// The seam. Two things were built against the same spec section in two worktrees,
// and §B.1 names `SuggestionFix` without defining it — so each side defined the
// half it needed and `reviewEngine.ts` is the translation. A mistranslation here
// would not fail a type check on either side: it would silently write the wrong
// column, or hide a button that works. That is what these tests are for.

const NOW = new Date(2026, 8, 26, 12); // Sep 26 2026, local noon

const acct = (over: Partial<Account> = {}): Account => ({
  id: "a1",
  name: "Checking",
  owner: "gino",
  type: "checking",
  balance: 100,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const bill = (over: Partial<Recurring> = {}): Recurring => ({
  id: "b1",
  name: "Bill",
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  dueDays: [15],
  categoryId: "subscriptions",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  id: "t1",
  date: "2026-09-16",
  amount: 20,
  type: "expense",
  categoryId: "bills",
  description: "Card payment",
  accountId: "a1",
  createdAt: "2026-09-16T12:00:00Z",
  ...over,
});

const data = (over: Partial<AppData> = {}): AppData => ({
  categories: DEFAULT_CATEGORIES,
  goals: [],
  paidBills: [],
  foods: [],
  merchantRules: [],
  accounts: [acct()],
  debts: [],
  recurring: [bill()],
  transactions: [],
  ...over,
});

describe("the engine is connected", () => {
  it("ENGINE_WIRED is true, so the dev harness shows no banner", () => {
    // If this is ever false again the whole feature ships silently dead: the card
    // is hidden at zero suggestions by design, so the user sees nothing at all.
    expect(ENGINE_WIRED).toBe(true);
  });

  it("reviewSuggestions returns what the engine finds, translated to surface fixes", () => {
    // Spotify modelled 14.04, last charge 27.00 — the live drift case.
    const live = data({
      recurring: [
        bill({ id: "sp", name: "Spotify", amount: 14.04, dueDays: [10], categoryId: "subscriptions" }),
      ],
      transactions: [
        txn({ id: "x1", date: "2026-06-10", amount: 14.04, description: "Spotify", categoryId: "subscriptions", appliesTo: { kind: "bill", recurringId: "sp", monthKey: "2026-06", day: 10 } }),
        txn({ id: "x2", date: "2026-07-10", amount: 14.04, description: "Spotify", categoryId: "subscriptions", appliesTo: { kind: "bill", recurringId: "sp", monthKey: "2026-07", day: 10 } }),
        txn({ id: "x3", date: "2026-08-10", amount: 14.04, description: "Spotify", categoryId: "subscriptions", appliesTo: { kind: "bill", recurringId: "sp", monthKey: "2026-08", day: 10 } }),
        txn({ id: "x4", date: "2026-09-10", amount: 27.0, description: "Spotify", categoryId: "subscriptions", appliesTo: { kind: "bill", recurringId: "sp", monthKey: "2026-09", day: 10 } }),
      ],
    });
    const out = reviewSuggestions(live, NOW, new Set());
    const drift = out.find((s) => s.kind === "drift");
    expect(drift).toBeTruthy();
    // The engine said `setRecurringAmount`; the surface must see a write it can run.
    expect(drift?.fix?.write).toBe("set-bill-amount");
    expect(drift?.fix && "amount" in drift.fix ? drift.fix.amount : 0).toBeCloseTo(27.0, 2);
  });

  it("a dismissed key stays dismissed on both halves of the list", () => {
    const live = data({
      recurring: [bill({ id: "gone-ref" })],
      transactions: [txn({ appliesTo: { kind: "bill", recurringId: "not-here", monthKey: "2026-09", day: 15 } })],
    });
    const out = reviewSuggestions(live, NOW, new Set());
    // Both halves are represented: the engine's rules and the dangling charge.
    expect(out.some((s) => s.kind === "dangling")).toBe(true);
    expect(out.some((s) => s.kind !== "dangling")).toBe(true);
    // Dismissal is applied on both sides, not just the engine's.
    expect(reviewSuggestions(live, NOW, new Set(out.map((s) => s.key)))).toEqual([]);
    const one = out.find((s) => s.kind === "dangling")!;
    expect(reviewSuggestions(live, NOW, new Set([one.key])).some((s) => s.key === one.key)).toBe(
      false,
    );
  });

  it("is sorted biggest money first, and ties break on the key so it is stable", () => {
    const list = sortSuggestions([
      { key: "b", kind: "drift", title: "", detail: "", amount: 5, fix: null },
      { key: "a", kind: "drift", title: "", detail: "", amount: 5, fix: null },
      { key: "c", kind: "drift", title: "", detail: "", amount: 50, fix: null },
    ]);
    expect(list.map((s) => s.key)).toEqual(["c", "a", "b"]);
  });
});

// ── the translation ───────────────────────────────────────────────────────────

describe("every engine action maps to a write the surface can run", () => {
  const writes: ReviewWrites = {
    unlinkFromBill: async () => {},
    deleteTransaction: async () => {},
    setRecurringAmount: async () => {},
    setRecurringActive: async () => {},
    setRecurringWindow: async () => {},
    addRecurringFromCharges: async () => {},
    linkTransactionToBill: async () => {},
  };

  it("setRecurringAmount on a FIXED row writes `amount`, not the estimate column", () => {
    const fix = toSurfaceFix({
      action: "setRecurringAmount",
      recurringId: "b1",
      field: "amount",
      from: 14.04,
      to: 27,
      label: "Use $27.00 from now on",
    });
    expect(fix?.write).toBe("set-bill-amount");
    expect(fix && "variable" in fix ? fix.variable : null).toBe(false);
    expect(fix && "amount" in fix ? fix.amount : null).toBe(27);
  });

  it("setRecurringAmount on a VARIABLE row writes the estimate column instead", () => {
    // Getting this backwards is the one mistranslation that would look like a fix
    // that did nothing: the old figure stays in force and the card comes back.
    const fix = toSurfaceFix({
      action: "setRecurringAmount",
      recurringId: "b1",
      field: "knownAmount",
      from: 85,
      to: 132.77,
      label: "Use $132.77 from now on",
    });
    expect(fix && "variable" in fix ? fix.variable : null).toBe(true);
  });

  it("setRecurringActive false turns a bill off; true maps to nothing at all", () => {
    const off = toSurfaceFix({
      action: "setRecurringActive",
      recurringId: "b1",
      from: true,
      to: false,
      label: "Turn this bill off",
    });
    expect(off?.write).toBe("turn-bill-off");
    // There is no "turn a bill on" one-tap fix, and there should not be one.
    expect(
      toSurfaceFix({
        action: "setRecurringActive",
        recurringId: "b1",
        from: false,
        to: true,
        label: "x",
      }),
    ).toBeNull();
  });

  it("setRecurringWindow becomes an end date, never a delete", () => {
    const fix = toSurfaceFix({
      action: "setRecurringWindow",
      recurringId: "b1",
      field: "endsOn",
      from: null,
      to: "2026-09-30",
      label: "It was one-off — stop expecting it",
    });
    expect(fix?.write).toBe("end-income");
    expect(fix && "endsOn" in fix ? fix.endsOn : null).toBe("2026-09-30");
  });

  it("addRecurring carries the whole draft through, median amount and all", () => {
    const fix = toSurfaceFix({
      action: "addRecurring",
      name: "Grok AI",
      amount: 29.99,
      dueDay: 22,
      categoryId: "subscriptions",
      cadence: "monthly",
      label: "Add it as a monthly bill",
    });
    expect(fix?.write).toBe("add-bill");
    expect(fix && "bill" in fix ? fix.bill : null).toEqual({
      name: "Grok AI",
      amount: 29.99,
      dueDay: 22,
      categoryId: "subscriptions",
      cadence: "monthly",
    });
  });

  it("a blocked fix keeps its reason, so the button greys out instead of vanishing", () => {
    const fix = toSurfaceFix({
      action: "addRecurring",
      name: "Something",
      amount: 10,
      dueDay: 1,
      categoryId: "other",
      cadence: "monthly",
      label: "Add it as a monthly bill",
      blockedReason: "Give it a category first",
    });
    expect(fix?.blocked).toBe("Give it a category first");
    // And it is refused if it is somehow tapped anyway.
    expect(hasWrite(fix!, writes)).toBe(true);
  });

  it("deleteTransaction becomes remove-manual-charge, never a bank-row delete", () => {
    const fix = toSurfaceFix({
      action: "deleteTransaction",
      txnId: "t1",
      label: "Remove the hand-entered one",
    });
    expect(fix?.write).toBe("remove-manual-charge");
  });

  it("linkTransactionToBill keeps the charge and the bill and drops the rest", () => {
    const fix = toSurfaceFix({
      action: "linkTransactionToBill",
      txnId: "t1",
      recurringId: "b1",
      monthKey: "2026-09",
      day: 15,
      installmentIndex: 0,
      label: "Yes, that is the bill",
    });
    expect(fix?.write).toBe("link-charge-to-bill");
    expect(fix && "txnId" in fix ? fix.txnId : null).toBe("t1");
    expect(fix && "recurringId" in fix ? fix.recurringId : null).toBe("b1");
    // The CYCLE travels with it. Dropping it here left the write and the guard to
    // re-derive it separately, and billCycleFor()'s seven-day grace maps a charge
    // paid early into the FOLLOWING month — so the month settled could differ from
    // the month the card stated out loud.
    expect(fix).toMatchObject({ monthKey: "2026-09", day: 15, installmentIndex: 0 });
  });

  it("every mapped fix names a write the surface knows how to run", () => {
    const fixes = [
      toSurfaceFix({ action: "setRecurringAmount", recurringId: "b1", field: "amount", from: 1, to: 2, label: "x" }),
      toSurfaceFix({ action: "setRecurringActive", recurringId: "b1", from: true, to: false, label: "x" }),
      toSurfaceFix({ action: "setRecurringWindow", recurringId: "b1", field: "endsOn", from: null, to: "2026-09-30", label: "x" }),
      toSurfaceFix({ action: "addRecurring", name: "n", amount: 1, dueDay: 1, categoryId: "subscriptions", cadence: "monthly", label: "x" }),
      toSurfaceFix({ action: "deleteTransaction", txnId: "t1", label: "x" }),
      toSurfaceFix({ action: "linkTransactionToBill", txnId: "t1", recurringId: "b1", monthKey: "2026-09", day: 15, installmentIndex: 0, label: "x" }),
    ];
    for (const f of fixes) {
      expect(f).toBeTruthy();
      expect(hasWrite(f!, writes)).toBe(true);
      // Every one says what it did afterwards, in the user's own terms.
      expect(f!.done && f!.done.length > 0).toBe(true);
    }
  });
});

// ── the charge whose bill was deleted ─────────────────────────────────────────

describe("the dangling-link fix — spec §D.1, the live $165", () => {
  it("a charge pointing at a deleted bill gets one card and a working button", () => {
    const live = data({
      transactions: [
        txn({ appliesTo: { kind: "bill", recurringId: "deleted-row", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const out = danglingSuggestions(live);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("dangling");
    expect(out[0].amount).toBe(20);
    expect(out[0].fix?.write).toBe("unlink-charge");
    // The headline stays short; the row's own words go in the evidence line, where
    // "Mobile Banking payment to CRD 6813 Confirmation# 1hrcz18pd" belongs.
    expect(out[0].title).toBe("A charge is attached to a bill that was deleted");
    expect(out[0].detail).toContain("Card payment");
    expect(out[0].detail).toContain("$20.00");
    expect(out[0].title).not.toMatch(/[{}]/);
    expect(out[0].detail).not.toMatch(/[{}]/);
  });

  it("the fix actually runs against the store action that exists today", async () => {
    const live = data({
      transactions: [
        txn({ appliesTo: { kind: "bill", recurringId: "deleted-row", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const freed: string[] = [];
    const res = await applyFix(danglingSuggestions(live)[0].fix!, live, {
      unlinkFromBill: async (id) => void freed.push(id),
      deleteTransaction: async () => {},
    });
    expect(res).toEqual({ ok: true });
    expect(freed).toEqual(["t1"]);
  });

  it("a healthy ledger gets nothing", () => {
    const live = data({
      transactions: [txn({ appliesTo: { kind: "bill", recurringId: "b1", monthKey: "2026-09", day: 15 } })],
    });
    expect(danglingSuggestions(live)).toEqual([]);
  });

  it("an UNLOADED table is not evidence that a row was deleted", () => {
    // The guard that matters. Check 8 is right to fail here — live links into an
    // empty table really is a defect — but a card with a button on every charge in
    // the ledger is not the way to say so.
    const live = data({
      accounts: [],
      transactions: [txn({ accountId: "a1" }), txn({ id: "t2", accountId: "a1" })],
    });
    expect(danglingSuggestions(live)).toEqual([]);
    // Same for goals, which the dev harness and the snapshot mapper both leave empty.
    const g = data({
      goals: [],
      transactions: [txn({ appliesTo: { kind: "goal", goalId: "g1" } })],
    });
    expect(danglingSuggestions(g)).toEqual([]);
  });

  it("a populated table IS evidence, on the same rows", () => {
    const live = data({
      accounts: [acct({ id: "other" })],
      transactions: [txn({ accountId: "a1" })],
    });
    const out = danglingSuggestions(live);
    expect(out.length).toBe(1);
    expect(out[0].title).toBe("A charge is attached to something that was deleted");
  });

  it("a dangling bill→debt link is reported by the check and offered no button here", () => {
    // The write would clear a column on a bill row, which §D.7 does not allow.
    const live = data({
      debts: [{ id: "d-real", name: "Card", balance: 10, originalBalance: 10, color: "#000", createdAt: "2026-01-01T00:00:00Z" }],
      recurring: [bill({ linkedDebtId: "gone" })],
      transactions: [],
    });
    expect(danglingSuggestions(live)).toEqual([]);
  });

  // ── WHICH dangling rows may be offered the button ───────────────────────────
  //
  // `unlinkFromBill` writes `applies_to = null` — the WHOLE object, not the one
  // broken id. So it is a repair in exactly one shape, and on every other shape the
  // same tap destroyed a link that still worked and pushed real money into the
  // variable budget. Each test below is one of those shapes.

  it("offers NO button when the charge also names a debt that still exists", () => {
    // A card payment whose bill row was deleted by hand. `applies_to` still carries
    // debtId and appliedAmount; clearing the column drops the debt attribution and
    // a $300 card payment lands in the variable budget.
    const live = data({
      debts: [{ id: "d1", name: "Card", balance: 1200, originalBalance: 2000, color: "#000", createdAt: "2026-01-01T00:00:00Z" }],
      transactions: [
        txn({
          id: "pay",
          amount: 300,
          appliesTo: {
            kind: "bill",
            recurringId: "deleted-row",
            debtId: "d1",
            monthKey: "2026-09",
            day: 15,
            installmentIndex: 0,
            settled: true,
            appliedAmount: 300,
          },
        }),
      ],
    });
    const out = danglingSuggestions(live);
    expect(out).toHaveLength(1);
    expect(out[0].fix).toBeNull();
    // Still reported, so check 8 and this screen say the same thing.
    expect(out[0].title).toBe("A charge is attached to a bill that was deleted");
  });

  it("offers NO button on a reimbursable set-aside whose settling credit was deleted", () => {
    // Reachable in the app today: settle a reimbursable against a deposit, then
    // delete that deposit in the charge sheet — nothing clears the back-link. The
    // tap would have dropped the reason, the note and the owed-back marker, and
    // moved $120 of fronted money into the Misc envelope.
    const live = data({
      transactions: [
        txn({
          id: "front",
          amount: 120,
          appliesTo: {
            kind: "setaside",
            reason: "reimbursable",
            settled: true,
            settledByTxnId: "credit-gone",
            note: "her share",
          },
        }),
      ],
    });
    const out = danglingSuggestions(live);
    expect(out).toHaveLength(1);
    expect(out[0].fix).toBeNull();
    // And it must not claim the set-aside is money on no screen: counting against
    // no budget IS what a set-aside is for.
    expect(out[0].detail).not.toContain("counts against no budget");
  });

  it("offers NO button when only the ACCOUNT link is broken", () => {
    // There is no write in the §D.7 union that can repair an accountId. On a row
    // with no bill link the button could only refuse; on a row WITH a good one it
    // un-settled a real bill cycle and left the account link exactly as broken.
    const orphan = data({
      accounts: [acct({ id: "other" })],
      transactions: [txn({ accountId: "a1", appliesTo: undefined })],
    });
    expect(danglingSuggestions(orphan)[0].fix).toBeNull();

    const settled = data({
      accounts: [acct({ id: "other" })],
      recurring: [bill({ id: "rent", name: "Rent", amount: 1726.88, dueDays: [1] })],
      transactions: [
        txn({
          accountId: "a1",
          amount: 1726.88,
          appliesTo: { kind: "bill", recurringId: "rent", monthKey: "2026-09", day: 1, settled: true },
        }),
      ],
    });
    const out = danglingSuggestions(settled);
    expect(out).toHaveLength(1);
    expect(out[0].fix).toBeNull();
  });

  it("keeps the button on the live shape — a bill link and nothing else", () => {
    // All four rows on the real ledger are this shape: kind 'bill', the recurring
    // row gone, no debt, no goal, no settling charge.
    const live = data({
      transactions: [
        txn({
          amount: 85,
          description: "Mobile Banking payment to CRD 6813 Confirmation# 1hrcz18pd",
          appliesTo: { kind: "bill", recurringId: "deleted-row", monthKey: "2026-06", day: 8, settled: true },
        }),
      ],
    });
    const out = danglingSuggestions(live);
    expect(out[0].fix?.write).toBe("unlink-charge");
    // The label says what happens. "Free" reads as an adjective first on a phone.
    expect(out[0].fix?.label).toBe("Take it off that bill");
    expect(out[0].fix?.done).toBe("Taken off. It counts as ordinary spending again.");
    // And the bank's confirmation code is not in the sentence — it is nothing he can
    // use and it pushed the useful half onto a third line.
    expect(out[0].detail).toContain("Mobile Banking payment to CRD 6813");
    expect(out[0].detail).not.toMatch(/Confirmation#/i);
  });

  it("survives missing and odd data rather than throwing", () => {
    expect(() => danglingSuggestions({ ...data(), accounts: undefined } as unknown as AppData)).not.toThrow();
    expect(() => danglingSuggestions(undefined as unknown as AppData)).not.toThrow();
    expect(() => danglingSuggestions({ ...data(), transactions: [null] } as unknown as AppData)).not.toThrow();
  });

  it("two broken links on one charge give one card, not two", () => {
    const live = data({
      accounts: [acct({ id: "other" })],
      transactions: [
        txn({ accountId: "a1", appliesTo: { kind: "bill", recurringId: "gone", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const out = danglingSuggestions(live);
    expect(out.length).toBe(1);
    // Both targets are in the key, so re-linking one does not retire the card.
    expect(out[0].key).toBe("dangling:t1:bill+account");
  });
});

// ── nothing ships untranslated ────────────────────────────────────────────────

describe("the seam's own strings", () => {
  it("every t() literal in reviewEngine.ts has a Simplified Chinese entry", () => {
    const src = readFileSync(join(process.cwd(), "src", "lib", "reviewEngine.ts"), "utf8");
    const missing: string[] = [];
    for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const s = m[1].replace(/\\"/g, '"');
      if (!ZH[s]) missing.push(s);
    }
    expect(missing).toEqual([]);
  });

  // The other half of the sheet. The test above only reads this file, and the
  // engine writes most of what a card says — so two W1 evidence lines shipped
  // with no Chinese and the sheet rendered a Chinese headline over an English
  // sentence, on the one rule that fires on the real ledger. REVIEW_STRINGS is
  // the right list to check: ledgerReview.test.ts already proves it is exactly
  // the set of user-facing literals in the engine, both ways.
  it("every string the engine can emit has a Simplified Chinese entry", () => {
    expect(REVIEW_STRINGS.filter((s) => !ZH[s])).toEqual([]);
  });

  // The third file that writes words onto this sheet. The subtitle, the button
  // labels and every refusal sentence live here, and a card with a Chinese headline
  // over an English sentence has already shipped once.
  it("every t() literal in the sheet and the fixes has a Simplified Chinese entry", () => {
    const missing: string[] = [];
    for (const file of ["ReviewSheet.tsx", "reviewApply.ts"]) {
      const src = readFileSync(join(process.cwd(), "src", "views", "redesign", file), "utf8");
      for (const m of src.matchAll(/\bt\(\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)) {
        const s = m[1].replace(/\\"/g, '"');
        if (!ZH[s]) missing.push(`${file}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("says what it saw and never how likely it is", () => {
    const live = data({
      transactions: [
        txn({ appliesTo: { kind: "bill", recurringId: "deleted-row", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const all = danglingSuggestions(live)
      .map((s) => `${s.title} ${s.detail} ${s.fix?.label ?? ""} ${s.fix?.done ?? ""}`)
      .join(" ");
    expect(all).not.toMatch(/probabl|likel|confiden|certain|\d\s?%|score/i);
  });
});
