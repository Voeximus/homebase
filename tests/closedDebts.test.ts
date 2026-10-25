// A closed debt takes no payments and counts toward no total.
//
// FOUND 2026-10-25. finance.edit_debt can close a paid-off debt (debts.closed_at,
// schema_v44) — finished and kept, never deleted. The bank sync never read that column.
// A tracked debt's pattern is usually the LENDER's name, and a household that pays one
// loan off often takes the next from the same lender — so once a loan was closed, a
// payment on the new one would match the closed loan first, be recorded against the
// finished debt, and be summed into its recompute, where max(0, baseline − paid) keeps it
// at $0.00. The payment would leave the budget and never reach the new loan, and nothing
// would say so.
//
// The sync is a Deno edge function no test can import, so its rule lives in
// supabase/functions/_shared/trackedDebts.ts and the sync calls it. Every name, pattern
// and amount below is made up — except one of the categorizer's own history keys, which
// the second half looks up BY LABEL at run time and never spells.
import { describe, expect, it } from "vitest";
import {
  armedTrackedDebts,
  CLOSED_DEBT_FILING,
  closedDebtPayment,
  closedTrackedDebts,
  trackedDebtFor,
} from "../supabase/functions/_shared/trackedDebts";
import { classify, merchantKey } from "../supabase/functions/_shared/categorize.ts";
import { MERCHANT_CATEGORY } from "../src/lib/categorizeData";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import type { Ctx } from "../supabase/functions/muse-write/kit.ts";
import type { Db } from "../supabase/functions/muse-write/db.ts";
import { FINANCE_WRITE_TOOLS } from "../supabase/functions/muse-write/toolsFinance.ts";
import { FinanceFake } from "./museFinanceFake.ts";
import { isOpenDebt, orderedDebts, payoffSchedule, planMath } from "../src/lib/plan";
import type { Debt } from "../src/types";

/** A debts row the way the sync's `select *` hands it over. */
const row = (over: Record<string, unknown>) => ({
  id: "d",
  name: "Loan",
  balance: 0,
  track_pattern: "LENDERCO",
  tracked_baseline: 600,
  tracked_since: "2026-03-01",
  provider_account_id: null,
  closed_at: null,
  ...over,
});

describe("the bank sync's tracked debts skip a closed one", () => {
  it("is the new loan from the same lender: its payment no longer goes to the closed one", () => {
    const old = row({ id: "old", name: "First loan", closed_at: "2026-09-01T00:00:00.000Z" });
    const fresh = row({ id: "new", name: "Second loan", balance: 400, tracked_baseline: 400, tracked_since: "2026-10-01" });
    // The closed loan is listed FIRST — the order the sync reads them in — which is
    // exactly how it used to win the match.
    const armed = armedTrackedDebts([old, fresh]);
    expect(armed.map((d) => d.id)).toEqual(["new"]);
    expect(trackedDebtFor(armed, "LENDERCO PAYMENT 1234")?.id).toBe("new");
  });

  it("credits nothing when the only debt with that pattern is closed — the payment goes on to the categorizer", () => {
    const armed = armedTrackedDebts([row({ closed_at: "2026-09-01T00:00:00.000Z" })]);
    expect(armed).toEqual([]);
    expect(trackedDebtFor(armed, "LENDERCO PAYMENT")).toBeUndefined();
  });

  it("still arms an open debt exactly as before, and still refuses the three it always refused", () => {
    // An open, patterned, baselined, unlinked debt is tracked — the fix narrows nothing else.
    expect(armedTrackedDebts([row({ id: "open" })]).map((d) => d.id)).toEqual(["open"]);
    // A closed_at of null, or no such key at all (a database before schema_v44), is open.
    const { closed_at: _drop, ...noColumn } = row({ id: "older-db" });
    expect(armedTrackedDebts([noColumn]).map((d) => d.id)).toEqual(["older-db"]);
    expect(armedTrackedDebts([row({ track_pattern: null })])).toEqual([]);
    expect(armedTrackedDebts([row({ tracked_baseline: null })])).toEqual([]);
    expect(armedTrackedDebts([row({ provider_account_id: "plaid-card" })])).toEqual([]);
    expect(armedTrackedDebts([row({ track_pattern: "   " })])).toEqual([]);
    expect(armedTrackedDebts(null)).toEqual([]);
  });

  it("matches the pattern anywhere in the description, ignoring case, as the sync always did", () => {
    const armed = armedTrackedDebts([row({ id: "open", track_pattern: "LenderCo" })]);
    expect(trackedDebtFor(armed, "web pmt to lenderco.com")?.id).toBe("open");
    expect(trackedDebtFor(armed, "SOMEONE ELSE")).toBeUndefined();
  });
});

describe("a closed debt counts toward no total", () => {
  const debt = (over: Partial<Debt> = {}): Debt => ({
    id: "d",
    name: "Loan",
    balance: 500,
    originalBalance: 1000,
    apr: 20,
    color: "#888888",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });

  it("isOpenDebt reads closed_at and nothing else", () => {
    expect(isOpenDebt(debt())).toBe(true);
    expect(isOpenDebt(debt({ closedAt: "2026-09-01T00:00:00.000Z" }))).toBe(false);
  });

  it("planMath's debt total leaves out a closed debt even if a balance came back on it", () => {
    const open = debt({ id: "open", balance: 500 });
    const closed = debt({ id: "closed", balance: 250, closedAt: "2026-09-01T00:00:00.000Z" });
    expect(planMath([], [open, closed], 0, "2026-10-25").totalDebt).toBe(500);
    // And with nothing closed, the total is every debt — the same as before.
    expect(planMath([], [open, debt({ id: "two", balance: 250 })], 0, "2026-10-25").totalDebt).toBe(750);
  });

  it("the payoff plan never aims money at a closed debt", () => {
    const open = debt({ id: "open", name: "Open loan", balance: 320 });
    const closed = debt({ id: "closed", name: "Closed loan", balance: 250, closedAt: "2026-09-01T00:00:00.000Z" });
    const events = payoffSchedule(orderedDebts([closed, open]), 400, new Date(2026, 9, 25, 12));
    const hit = new Set(events.flatMap((e) => e.payments.map((p) => p.debtId)));
    expect(hit.has("closed")).toBe(false);
    expect(hit.has("open")).toBe(true);
  });
});

// ── A payment only a closed debt matches is recorded, never dropped ──────────────
//
// FOUND in review 2026-10-25, on live data. The categorizer files an instalment lender's
// payments as `skip` (his history labels them "Debt: <lender>"), and the sync drops every
// skip row no armed debt claims. So once the lender's loan was closed — and the closed
// debt no longer armed — a payment on a NEW loan from that lender was written nowhere at
// all. The write door agreed with neither: it still refused the payment by hand, saying
// the feed would credit it. The lender's real key is looked up BY LABEL at run time, as
// historyRow.test.ts does, so no real name is typed here.

/** The first history key labelled as a debt that reads back as itself. */
const DEBT_KEY = Object.keys(MERCHANT_CATEGORY).find(
  (k) => MERCHANT_CATEGORY[k].startsWith("Debt:") && merchantKey(k) === k,
)!;

/** What the sync does with one outflow, in its own order (plaid/index.ts): an armed debt
 *  first, then the categorizer, then — only for a row it would drop — a closed debt. */
function syncSays(debtRows: ReturnType<typeof row>[], description: string, alreadyLinked = false) {
  const armed = armedTrackedDebts(debtRows);
  const td = trackedDebtFor(armed, description);
  if (td) return { credited: td.id };
  const c = classify(description, -42.5, {}, description);
  if (c.kind !== "skip") return { classified: c.kind };
  const gone = closedDebtPayment(closedTrackedDebts(debtRows), description, alreadyLinked);
  return gone?.record ? { recorded: gone.record, matched: gone.debt.id } : { dropped: true };
}

describe("the bank sync records a payment that only a closed debt matches", () => {
  const closed = (over: Record<string, unknown> = {}) =>
    row({ id: "closed", track_pattern: DEBT_KEY, closed_at: "2026-10-01T00:00:00.000Z", ...over });

  it("has a debt-labelled history key to test with, and the categorizer drops it", () => {
    // If the data file loses these labels, every test below would pass on nothing.
    expect(DEBT_KEY).toBeTruthy();
    expect(classify(DEBT_KEY, -42.5, {}, DEBT_KEY).kind).toBe("skip");
  });

  it("is the live failure: the lender's loan is closed, no open debt has its pattern, and the payment is recorded for a look", () => {
    const said = syncSays([closed()], DEBT_KEY);
    expect(said).toEqual({ recorded: CLOSED_DEBT_FILING, matched: "closed" });
    // A bill payment — on no budget line — flagged, and a guess that never re-decides.
    expect(CLOSED_DEBT_FILING).toEqual({ category_id: "bills", needs_review: true, keep_category: true });
    // Linked to nothing: the filing carries no applies_to, so it settles no bill and is
    // summed into no debt's recompute.
    expect("applies_to" in CLOSED_DEBT_FILING).toBe(false);
  });

  it("leaves a charge that already carries a link exactly as it is — the closed loan's own old payments", () => {
    expect(syncSays([closed()], DEBT_KEY, true)).toEqual({ dropped: true });
    expect(closedDebtPayment(closedTrackedDebts([closed()]), DEBT_KEY, true)).toEqual({
      debt: expect.objectContaining({ id: "closed" }),
      record: null,
    });
  });

  it("credits the new loan once it has its own open debt row, and the closed one never", () => {
    const fresh = row({ id: "new", track_pattern: DEBT_KEY, tracked_baseline: 400, tracked_since: "2026-10-20" });
    expect(syncSays([closed(), fresh], DEBT_KEY)).toEqual({ credited: "new" });
  });

  it("drops every other skip row as before — a closed debt widens nothing", () => {
    // A row the categorizer drops that matches no closed debt.
    expect(closedDebtPayment(closedTrackedDebts([closed()]), "SOMETHING ELSE ENTIRELY", false)).toBeNull();
    // A closed debt the sync never armed while open: no baseline, or it follows a card —
    // recording a card payment as spending would count it on top of the card's charges.
    expect(syncSays([closed({ tracked_baseline: null })], DEBT_KEY)).toEqual({ dropped: true });
    expect(syncSays([closed({ provider_account_id: "plaid-card" })], DEBT_KEY)).toEqual({ dropped: true });
    // An OPEN debt is never in the closed list.
    expect(closedTrackedDebts([row({ id: "open" })])).toEqual([]);
  });
});

describe("finance.add_history_row judges a closed debt's payment the way the sync does", () => {
  const ACCT = "aaaa1111-2222-4333-8444-000000000025";
  const AT = new Date("2026-10-25T19:00:00Z");
  const seeded = (debt: Record<string, unknown>) => {
    const db = new FinanceFake();
    db.tables.accounts.push({ id: ACCT, name: "Sample Checking", owner: "Sample", balance: 500, provider_account_id: null, last4: null });
    db.tables.debts.push({ id: "dddd1111-2222-4333-8444-000000000025", name: "Sample loan", balance: 0, ...debt });
    return db;
  };
  const add = (db: FinanceFake, args: Record<string, unknown> = {}) => {
    const clock = clockNow(AT);
    const ctx: Ctx = { db: db as unknown as Db, push: () => Promise.resolve(), person: "gino", at: clock.at, az: clock.az, appUrl: "https://example.test/" };
    return FINANCE_WRITE_TOOLS["finance.add_history_row"].run(
      { account_id: ACCT, date: "2026-10-20", amount: 42.5, type: "expense", description: DEBT_KEY, ...args },
      ctx,
    );
  };
  const closedDebt = { track_pattern: DEBT_KEY, tracked_baseline: 320, tracked_since: "2026-03-01", provider_account_id: null, closed_at: "2026-10-01T00:00:00.000Z" };

  it("files it as a bill payment flagged for review instead of refusing it — the feed's own row", async () => {
    const db = seeded(closedDebt);
    const out = await add(db);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const written = db.tables.transactions.find((r) => r.id === out.result.id)!;
    expect(written).toMatchObject({
      category_id: "bills",
      needs_review: true,
      user_categorized: false,
      applies_to: null,
      record_only: true,
    });
    expect(out.say).toContain("flagged it for review");
    expect(out.say).toContain("which is closed");
    // Nothing is credited: the closed debt stays exactly where it was.
    expect(db.tables.debts[0].balance).toBe(0);
  });

  it("uses a named category as given, like any row the app would file", async () => {
    const db = seeded(closedDebt);
    const out = await add(db, { category_id: "other" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(db.tables.transactions.find((r) => r.id === out.result.id)).toMatchObject({ category_id: "other", user_categorized: true });
  });

  it("still refuses a payment on an OPEN debt with that pattern, exactly as before", async () => {
    const out = await add(seeded({ ...closedDebt, closed_at: null, balance: 320 }));
    expect(out).toMatchObject({ ok: false, status: 409 });
    if (out.ok) return;
    expect(out.say).toContain("nothing overrides this one");
  });

  it("still refuses when the closed debt is one the sync never credited — the sync drops that row too", async () => {
    const out = await add(seeded({ ...closedDebt, tracked_baseline: null }));
    expect(out).toMatchObject({ ok: false, status: 409 });
    if (out.ok) return;
    expect(out.say).toContain("payment on a debt");
  });
});
