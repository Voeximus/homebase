import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyFix, hasWrite, type ReviewWrites } from "../src/views/redesign/reviewApply";
import {
  clearDismissed,
  dismissLocally,
  loadDismissed,
  mergeDismissed,
  undismissLocally,
} from "../src/lib/doctorDismissals";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData, Recurring, Transaction } from "../src/types";
import type { SuggestionFix } from "../src/lib/reviewTypes";

// ── The one-tap fixes, and what they must refuse ─────────────────────────────
//
// These are the tests that matter in this piece. The screen can be checked by
// looking at it (?doctorlab); the GUARDS cannot, because the whole point of a
// guard is the case you never see. Each one below is a way a tap could have cost
// real money or destroyed history the app cannot rebuild.

const rec = (over: Partial<Recurring> & Pick<Recurring, "id" | "name">): Recurring => ({
  amount: 100,
  direction: "out",
  cadence: "monthly",
  active: true,
  dueDays: [10],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const txn = (over: Partial<Transaction> & Pick<Transaction, "id">): Transaction => ({
  date: "2026-09-10",
  amount: 100,
  type: "expense",
  categoryId: "subscriptions",
  description: "A charge",
  createdAt: "2026-09-10T12:00:00.000Z",
  ...over,
});

function appData(over: Partial<AppData> = {}): AppData {
  return {
    transactions: [],
    debts: [],
    goals: [],
    categories: DEFAULT_CATEGORIES,
    accounts: [],
    recurring: [],
    paidBills: [],
    merchantRules: [],
    foods: [],
    ...over,
  };
}

/** Records every call, so a test can assert a write did NOT happen. */
function spyWrites(extra: Partial<ReviewWrites> = {}) {
  const calls: string[] = [];
  const writes: ReviewWrites = {
    unlinkFromBill: async (id) => void calls.push(`unlink:${id}`),
    deleteTransaction: async (id) => void calls.push(`delete:${id}`),
    setRecurringAmount: async (id, p) => void calls.push(`amount:${id}:${JSON.stringify(p)}`),
    setRecurringActive: async (id, a) => void calls.push(`active:${id}:${a}`),
    setRecurringWindow: async (id, p) => void calls.push(`window:${id}:${JSON.stringify(p)}`),
    addRecurringFromCharges: async (b) => void calls.push(`add:${b.name}`),
    linkTransactionToBill: async (t, r) => void calls.push(`link:${t}:${r}`),
    ...extra,
  };
  return { calls, writes };
}

describe("applyFix — deleting a charge", () => {
  const fix = (txnId: string): SuggestionFix => ({
    label: "Remove the hand-entered one",
    write: "remove-manual-charge",
    txnId,
  });

  it("removes a hand-entered row", async () => {
    const data = appData({ transactions: [txn({ id: "t1" })] });
    const { calls, writes } = spyWrites();
    expect(await applyFix(fix("t1"), data, writes)).toEqual({ ok: true });
    expect(calls).toEqual(["delete:t1"]);
  });

  // The hard rule. Plaid re-delivers a bank row on the next cursor page, and real
  // bank history is the one thing in this feature the app cannot rebuild. The
  // engine only ever proposes the hand-entered side — but the engine ran BEFORE
  // the tap, and this is the check that runs at the tap.
  it("refuses a row that came from the bank, and writes nothing", async () => {
    const data = appData({ transactions: [txn({ id: "t1", provider: "plaid" })] });
    const { calls, writes } = spyWrites();
    const res = await applyFix(fix("t1"), data, writes);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a row that only RECORDS money moved outside the app", async () => {
    const data = appData({ transactions: [txn({ id: "t1", recordOnly: true })] });
    const { calls, writes } = spyWrites();
    expect((await applyFix(fix("t1"), data, writes)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses when the row is already gone", async () => {
    const { calls, writes } = spyWrites();
    expect((await applyFix(fix("t1"), appData(), writes)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("applyFix — linking a charge to a bill", () => {
  const bill = rec({ id: "r1", name: "Cloud Drive", amount: 16.2, dueDays: [23] });
  const fix: SuggestionFix = {
    label: "Yes, that is the bill",
    write: "link-charge-to-bill",
    txnId: "t1",
    recurringId: "r1",
  };

  it("links a free charge to a free cycle", async () => {
    const data = appData({
      recurring: [bill],
      transactions: [txn({ id: "t1", date: "2026-09-23", amount: 16.2 })],
    });
    const { calls, writes } = spyWrites();
    expect(await applyFix(fix, data, writes)).toEqual({ ok: true });
    expect(calls).toEqual(["link:t1:r1"]);
  });

  // Settling one bill cycle twice is the exact defect the whole feature exists to
  // stop. The feed can claim the cycle between the card being drawn and the tap,
  // so the cycle is re-derived from the data at tap time.
  it("refuses when another charge already pays that cycle", async () => {
    const data = appData({
      recurring: [bill],
      transactions: [
        txn({ id: "t1", date: "2026-09-23", amount: 16.2 }),
        txn({
          id: "t2",
          date: "2026-09-23",
          amount: 16.2,
          provider: "plaid",
          appliesTo: { kind: "bill", recurringId: "r1", monthKey: "2026-09", day: 23 },
        }),
      ],
    });
    const { calls, writes } = spyWrites();
    expect((await applyFix(fix, data, writes)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  // A bill paid twice a month (support to family, on the 15th AND the 30th) has two
  // independent cycles. Refusing the second one because the first is paid would
  // make the fix useless on exactly the bills that need it.
  it("allows the second installment of a two-installment bill", async () => {
    const twice = rec({ id: "r2", name: "Support", amount: 300, dueDays: [15, 30] });
    const data = appData({
      recurring: [twice],
      transactions: [
        txn({ id: "t1", date: "2026-09-30", amount: 300 }),
        txn({
          id: "t2",
          date: "2026-09-15",
          amount: 300,
          appliesTo: { kind: "bill", recurringId: "r2", monthKey: "2026-09", day: 15 },
        }),
      ],
    });
    const { calls, writes } = spyWrites();
    const res = await applyFix(
      { label: "Yes, that is the bill", write: "link-charge-to-bill", txnId: "t1", recurringId: "r2" },
      data,
      writes,
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(["link:t1:r2"]);
  });

  // The engine placed the cycle with the row's due days OR the legacy name map
  // (dueDaysOf in ledgerReview.ts), so the guard has to read the same map. Given
  // only `rec.dueDays`, billCycleFor() falls back to the CHARGE's own day — the
  // guard would then be looking at 16 Sep instead of the 15th cycle the card
  // offered, find it free, and let a second charge settle it.
  it("refuses a taken cycle on a row whose due days live only in the legacy map", async () => {
    const legacy = rec({ id: "r3", name: "Mom", amount: 300, dueDays: undefined });
    const data = appData({
      recurring: [legacy],
      transactions: [
        txn({ id: "t1", date: "2026-09-16", amount: 300 }),
        txn({
          id: "t2",
          date: "2026-09-15",
          amount: 300,
          appliesTo: { kind: "bill", recurringId: "r3", monthKey: "2026-09", day: 15 },
        }),
      ],
    });
    const { calls, writes } = spyWrites();
    expect(
      (
        await applyFix(
          { label: "Yes, that is the bill", write: "link-charge-to-bill", txnId: "t1", recurringId: "r3" },
          data,
          writes,
        )
      ).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a charge that is already attached to something", async () => {
    const data = appData({
      recurring: [bill],
      transactions: [
        txn({ id: "t1", date: "2026-09-23", appliesTo: { kind: "setaside", reason: "excluded" } }),
      ],
    });
    const { calls, writes } = spyWrites();
    expect((await applyFix(fix, data, writes)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  // A pending row can vanish or change amount when it posts, and settling a cycle
  // with one would leave the bill marked paid by a charge that never existed.
  it("refuses a charge that is still processing", async () => {
    const data = appData({
      recurring: [bill],
      transactions: [txn({ id: "t1", date: "2026-09-23", amount: 16.2, pending: true })],
    });
    const { calls, writes } = spyWrites();
    expect((await applyFix(fix, data, writes)).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("applyFix — changing a bill's amount", () => {
  it("writes `amount` for a fixed bill", async () => {
    const data = appData({ recurring: [rec({ id: "r1", name: "Streamly", amount: 14.04 })] });
    const { calls, writes } = spyWrites();
    await applyFix(
      { label: "Use $27.00 from now on", write: "set-bill-amount", recurringId: "r1", amount: 27, variable: false },
      data,
      writes,
    );
    expect(calls).toEqual(['amount:r1:{"amount":27}']);
  });

  // A variable row's figure lives in known_amount. Writing `amount` there would
  // leave the old estimate in force and read as a fix that did nothing.
  it("writes `knownAmount` for a variable bill", async () => {
    const data = appData({
      recurring: [rec({ id: "r1", name: "City Power", amount: 85, variable: true })],
    });
    const { calls, writes } = spyWrites();
    await applyFix(
      { label: "Use $132.77 from now on", write: "set-bill-amount", recurringId: "r1", amount: 132.77, variable: true },
      data,
      writes,
    );
    expect(calls).toEqual(['amount:r1:{"knownAmount":132.77}']);
  });
});

describe("applyFix — turning a bill off and ending an income", () => {
  it("turns a bill off rather than deleting it", async () => {
    const data = appData({ recurring: [rec({ id: "r1", name: "Fitness Club" })] });
    const { calls, writes } = spyWrites();
    await applyFix({ label: "Turn this bill off", write: "turn-bill-off", recurringId: "r1" }, data, writes);
    expect(calls).toEqual(["active:r1:false"]);
  });

  it("refuses a bill that is already off", async () => {
    const data = appData({ recurring: [rec({ id: "r1", name: "Fitness Club", active: false })] });
    const { calls, writes } = spyWrites();
    expect(
      (await applyFix({ label: "Turn this bill off", write: "turn-bill-off", recurringId: "r1" }, data, writes)).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  // endsOn, never inactive: the past months must still show the income they had.
  it("ends a one-off income with a window, not a switch", async () => {
    const data = appData({
      recurring: [rec({ id: "r1", name: "Insurance check", direction: "in", amount: 1100 })],
    });
    const { calls, writes } = spyWrites();
    await applyFix(
      { label: "It was one-off", write: "end-income", recurringId: "r1", endsOn: "2026-09-30" },
      data,
      writes,
    );
    expect(calls).toEqual(['window:r1:{"endsOn":"2026-09-30"}']);
  });
});

describe("applyFix — adding a bill", () => {
  const draft = { name: "Notes App", amount: 1.99, dueDay: 6, cadence: "monthly" as const };

  it("adds a bill in a graded category", async () => {
    const { calls, writes } = spyWrites();
    const res = await applyFix(
      { label: "Add it", write: "add-bill", bill: { ...draft, categoryId: "subscriptions" } },
      appData(),
      writes,
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(["add:Notes App"]);
  });

  // A bill row in an ungraded category is exactly the `utilities` defect the
  // orphan-category self-check exists to catch: money that leaves the account and
  // appears on no screen.
  it("refuses an ungraded category", async () => {
    const { calls, writes } = spyWrites();
    expect(
      (await applyFix({ label: "Add it", write: "add-bill", bill: { ...draft, categoryId: "other" } }, appData(), writes))
        .ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses a bill that is already modelled under that name", async () => {
    const data = appData({ recurring: [rec({ id: "r1", name: "notes app" })] });
    const { calls, writes } = spyWrites();
    expect(
      (
        await applyFix(
          { label: "Add it", write: "add-bill", bill: { ...draft, categoryId: "subscriptions" } },
          data,
          writes,
        )
      ).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("applyFix — a blocked fix", () => {
  it("never writes, whatever it would have done", async () => {
    const { calls, writes } = spyWrites();
    const res = await applyFix(
      {
        label: "Turn this bill off",
        blocked: "Give it a category first.",
        write: "turn-bill-off",
        recurringId: "r1",
      },
      appData({ recurring: [rec({ id: "r1", name: "X" })] }),
      writes,
    );
    expect(res).toEqual({ ok: false, reason: "Give it a category first." });
    expect(calls).toEqual([]);
  });
});

describe("hasWrite", () => {
  const full = spyWrites().writes;

  it("is true for every fix when every action is connected", () => {
    const all: SuggestionFix[] = [
      { label: "", write: "unlink-charge", txnId: "t" },
      { label: "", write: "remove-manual-charge", txnId: "t" },
      { label: "", write: "set-bill-amount", recurringId: "r", amount: 1, variable: false },
      { label: "", write: "turn-bill-off", recurringId: "r" },
      { label: "", write: "end-income", recurringId: "r", endsOn: "2026-09-30" },
      { label: "", write: "add-bill", bill: { name: "n", amount: 1, dueDay: 1, categoryId: "c", cadence: "monthly" } },
      { label: "", write: "link-charge-to-bill", txnId: "t", recurringId: "r" },
    ];
    for (const f of all) expect(hasWrite(f, full)).toBe(true);
  });

  // The two that exist in the store today keep working while the other five are
  // still landing, and a fix whose action is missing is simply not offered.
  it("is false only for the actions that are missing", () => {
    const partial: ReviewWrites = {
      unlinkFromBill: full.unlinkFromBill,
      deleteTransaction: full.deleteTransaction,
    };
    expect(hasWrite({ label: "", write: "unlink-charge", txnId: "t" }, partial)).toBe(true);
    expect(hasWrite({ label: "", write: "remove-manual-charge", txnId: "t" }, partial)).toBe(true);
    expect(hasWrite({ label: "", write: "turn-bill-off", recurringId: "r" }, partial)).toBe(false);
    expect(hasWrite({ label: "", write: "link-charge-to-bill", txnId: "t", recurringId: "r" }, partial)).toBe(false);
  });

  it("reports a blocked fix as having its write — being blocked is not being absent", () => {
    expect(hasWrite({ label: "", blocked: "why", write: "turn-bill-off", recurringId: "r" }, full)).toBe(true);
  });
});

// ── Dismissals ───────────────────────────────────────────────────────────────

function fakeStorage(fail = false) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (fail) throw new Error("blocked");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (fail) throw new Error("blocked");
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (fail) throw new Error("blocked");
      map.delete(k);
    },
  };
}

describe("dismissals on this phone", () => {
  const g = globalThis as unknown as { localStorage?: unknown };
  const had = "localStorage" in g;

  beforeEach(() => {
    g.localStorage = fakeStorage();
  });
  afterEach(() => {
    if (!had) delete g.localStorage;
  });

  it("remembers, forgets and clears a key", () => {
    expect(loadDismissed().size).toBe(0);
    expect(dismissLocally("drift:r1:2700").has("drift:r1:2700")).toBe(true);
    expect(loadDismissed().has("drift:r1:2700")).toBe(true);
    expect(undismissLocally("drift:r1:2700").size).toBe(0);
    dismissLocally("a");
    dismissLocally("b");
    expect(clearDismissed().size).toBe(0);
    expect(loadDismissed().size).toBe(0);
  });

  it("does not store the same key twice", () => {
    dismissLocally("k");
    dismissLocally("k");
    expect(loadDismissed().size).toBe(1);
  });

  // Storage is absent in a private window, blocked by site settings, and
  // unavailable during a thumbnail capture. A throw there must render a correct
  // screen, not an empty one and not an error.
  it("never throws when storage is unavailable", () => {
    g.localStorage = fakeStorage(true);
    expect(() => loadDismissed()).not.toThrow();
    expect(loadDismissed().size).toBe(0);
    expect(() => dismissLocally("k")).not.toThrow();
    expect(() => clearDismissed()).not.toThrow();
  });

  it("survives junk in storage", () => {
    g.localStorage = fakeStorage();
    (g.localStorage as { setItem: (k: string, v: string) => void }).setItem(
      "hb-review-dismissed",
      '{"not":"an array"}',
    );
    expect(loadDismissed().size).toBe(0);
  });

  // The household table (spec piece 3) and this phone are a UNION: a key dismissed
  // on either phone stays dismissed, and neither side can bring one back.
  it("merges the household's dismissals with this phone's", () => {
    const local = new Set(["mine"]);
    expect(mergeDismissed(local, undefined)).toBe(local);
    const merged = mergeDismissed(local, [{ key: "theirs" }, { key: 7 }, { key: "" }]);
    expect([...merged].sort()).toEqual(["mine", "theirs"]);
  });
});
