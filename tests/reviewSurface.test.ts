import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    linkTransactionToBill: async (t, r, c) =>
      void calls.push(`link:${t}:${r}:${c.monthKey}|${c.day}|${c.installmentIndex}`),
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
  // The cycle travels ON the fix — the engine placed it and the card stated it —
  // so the write and the guard both read the cycle the person actually saw.
  const fix: SuggestionFix = {
    label: "Yes, that is the bill",
    write: "link-charge-to-bill",
    txnId: "t1",
    recurringId: "r1",
    monthKey: "2026-09",
    day: 23,
    installmentIndex: 0,
  };

  it("links a free charge to a free cycle", async () => {
    const data = appData({
      recurring: [bill],
      transactions: [txn({ id: "t1", date: "2026-09-23", amount: 16.2 })],
    });
    const { calls, writes } = spyWrites();
    expect(await applyFix(fix, data, writes)).toEqual({ ok: true });
    expect(calls).toEqual(["link:t1:r1:2026-09|23|0"]);
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
      {
        label: "Yes, that is the bill",
        write: "link-charge-to-bill",
        txnId: "t1",
        recurringId: "r2",
        monthKey: "2026-09",
        day: 30,
        installmentIndex: 1,
      },
      data,
      writes,
    );
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(["link:t1:r2:2026-09|30|1"]);
  });

  // The STORED rows place their own installment, and they do it with the row's due
  // days OR the legacy name map (dueDaysOf in ledgerReview.ts) — so the guard has to
  // read the same map the engine read. Without it a row claiming the 15th and a row
  // claiming the 30th both collapse to installment 0, and one month's two cycles
  // stop being distinguishable in either direction.
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
          {
            label: "Yes, that is the bill",
            write: "link-charge-to-bill",
            txnId: "t1",
            recurringId: "r3",
            monthKey: "2026-09",
            day: 15,
            installmentIndex: 0,
          },
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

// ── a write that did not land ─────────────────────────────────────────────────
//
// Every action here used to resolve `void`, so a failed write was unrepresentable:
// an RLS-filtered UPDATE returns error:null with zero rows and a failed RPC
// resyncs, and both resolved the same way a success did. applyFix returned
// {ok:true} either way, the sheet replaced the card with its green "done" line, and
// the optimistic local state hid the failure until the next refetch — at which
// point the self-check reported the same thing he believed he had just fixed.
describe("applyFix reports a write the store says did not happen", () => {
  it("refuses instead of confirming when unlinkFromBill comes back false", async () => {
    const data = appData({
      recurring: [rec({ id: "r1", name: "Rent" })],
      transactions: [
        txn({ id: "t1", appliesTo: { kind: "bill", recurringId: "gone", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const { calls, writes } = spyWrites({
      unlinkFromBill: async () => false,
    });
    const res = await applyFix(
      { label: "Take it off that bill", write: "unlink-charge", txnId: "t1" },
      data,
      writes,
    );
    expect(res).toEqual({
      ok: false,
      reason: "That did not save. Nothing has changed — try again in a moment.",
    });
    expect(calls).toEqual([]);
  });

  it("refuses instead of confirming when deleteTransaction comes back false", async () => {
    const data = appData({ transactions: [txn({ id: "t1" })] });
    const { writes } = spyWrites({ deleteTransaction: async () => false });
    const res = await applyFix(
      { label: "Remove the hand-entered one", write: "remove-manual-charge", txnId: "t1" },
      data,
      writes,
    );
    expect(res.ok).toBe(false);
  });

  it("still confirms when the action resolves without saying anything", async () => {
    // The five unshipped writes return Promise<void>, and so does the dev harness.
    // Only an explicit false is a failure.
    const data = appData({
      recurring: [rec({ id: "r1", name: "Rent" })],
      transactions: [
        txn({ id: "t1", appliesTo: { kind: "bill", recurringId: "gone", monthKey: "2026-09", day: 15 } }),
      ],
    });
    const { writes } = spyWrites({ unlinkFromBill: async () => undefined });
    expect(
      await applyFix({ label: "x", write: "unlink-charge", txnId: "t1" }, data, writes),
    ).toEqual({ ok: true });
  });
});

// ── what the sheet says, read from the sheet ──────────────────────────────────
//
// There is no DOM in this suite (no jsdom, by design — every other test here is a
// pure function), so these read the source. They are narrow on purpose: each one
// guards a sentence or a gate that was wrong, not the markup around it.
describe("the sheet's own honesty", () => {
  const src = readFileSync(join(process.cwd(), "src", "views", "redesign", "ReviewSheet.tsx"), "utf8");

  it("does not call everything in it 'not mistakes'", () => {
    // One card — the charge attached to a deleted bill — is the exact self-check's
    // own finding, which Profile calls a real mistake in red. Two screens describing
    // the same money differently is the defect selfAudit.ts exists to catch.
    expect(src).not.toMatch(/t\(\s*"Not mistakes/);
    expect(src).toContain("Most are guesses you can wave off");
  });

  it("does not offer to dismiss the one certain finding", () => {
    // Dismissing it removed the only route to the fix while check 8 went on
    // reporting it and pointing at this screen.
    expect(src).toMatch(/const canDismiss = s\.kind !== "dangling"/);
    expect(src).toMatch(/\{canDismiss && \(/);
    expect(src).toMatch(/The self-check found this one/);
  });

  it("says when a fix is not ready, instead of silently becoming a different card", () => {
    // `hasWrite` stripped an unshipped fix before it could be applied, so every
    // `notConnected()` refusal in reviewApply.ts was unreachable and the card became
    // a plain "Show me the charge" with nothing said about why.
    expect(src).toMatch(/const notReady =/);
    expect(src).toMatch(/\{\(blocked \|\| notReady\) && \(/);
  });

  it("sends a card about a BILL to the bills screen, not to the charge sheet", () => {
    // A drift, phantom, missing or income-landed card is about a recurring row, and
    // the charge sheet has no control for a bill's amount, its window or whether it
    // is on.
    expect(src).toMatch(/const openLabel = s\.recurringId\s*\n?\s*\? t\("Show me the bill"\)/);
    expect(src).toMatch(/if \(s\.recurringId\) onBills\(\);/);
  });
});
