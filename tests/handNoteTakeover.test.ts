// A hand-made "(already paid)" note gives way to the bank's own charge.
//
// FOUND 2026-10-24. Four hand notes were in the ledger and three of them paid a bill the
// bank had also paid. The bank's charge sat beside each note as ordinary spending — the
// same money twice in the budget, the run rate and the plan — and because the note held
// the bill's month, the bank sync, Worth a look's W7 and the write door's
// link_charge_to_bill all read the month as taken, so nothing could ever attach the real
// charge. selfAudit said all clear: it skips rows with no account, and nothing claimed a
// month twice.
//
// The shape here is the real one, with invented numbers: an electric bill set on one
// person's account, paid by the bank from the JOINT account, and a hand note written for
// the same month because that charge had not linked.
//
// What is held, in order:
//   1. the self-check that FAILS while the pair coexists — and stays quiet on every
//      correct ledger that looks like it (a bill paid in cash, part paid in cash, a
//      different merchant, the Cherry debt shape);
//   2. Worth a look's W5c, whose one-tap repair removes the NOTE and never the bank row,
//      and W7, which offers the link once the month is free;
//   3. the write door's link_charge_to_bill, which does both in one step with one undo;
//   4. the bank sync's own decision (handNote.ts), which takes the month for a NEW
//      charge and keeps today's behaviour for everything else;
//   5. the budget partition: once repaired, the charge counts once.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { handNotesBesideBankCharges, selfAudit } from "../src/lib/selfAudit";
import { reviewLedger } from "../src/lib/ledgerReview";
import { isHandNote } from "../src/lib/billMatch";
import { spentByCategoryBetween } from "../src/lib/plan";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { Account, AppData, Recurring, Transaction } from "../src/types";
import { handNoteToRetire, holderOf, isRetirableHandNote, type CycleHolder } from "../supabase/functions/_shared/handNote.ts";
import { FINANCE_WRITE_TOOLS } from "../supabase/functions/muse-write/toolsFinance.ts";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import { redactSuggestions } from "../supabase/functions/_shared/muse/worthALook.ts";
import type { Ctx } from "../supabase/functions/muse-write/kit.ts";
import type { Db } from "../supabase/functions/muse-write/db.ts";
import { FinanceFake } from "./museFinanceFake.ts";
import { merchantKey } from "../src/lib/categorize";
import { applyFix, type ReviewWrites } from "../src/views/redesign/reviewApply";
import { toSurfaceFix } from "../src/lib/reviewEngine";

const NOW = new Date(2026, 9, 25, 12); // 25 Oct 2026, local noon
const A = "acct-a";
const B = "acct-b";
const JOINT = "acct-joint";

const acct = (id: string, owner: Account["owner"]): Account =>
  ({ id, name: "Checking", owner, type: "checking", balance: 0, sortOrder: 0, createdAt: "2026-01-01T00:00:00Z" }) as Account;
const bill = (over: Partial<Recurring>): Recurring =>
  ({ id: "b", name: "Bill", amount: 100, direction: "out", cadence: "monthly", active: true, dueDays: [15], createdAt: "2026-01-01T00:00:00Z", ...over }) as Recurring;
const txn = (over: Partial<Transaction>): Transaction =>
  ({ id: "t", date: "2026-10-18", amount: 50, type: "expense", categoryId: "other", description: "Store", createdAt: "2026-10-18T12:00:00Z", ...over }) as Transaction;
const ledger = (over: Partial<AppData>): AppData => ({
  transactions: [], debts: [], goals: [], categories: DEFAULT_CATEGORIES,
  accounts: [acct(A, "Gino"), acct(B, "Xinyan"), acct(JOINT, "Joint")],
  recurring: [], paidBills: [], merchantRules: [], foods: [], ...over,
});

const ELECTRIC = bill({ id: "elec", name: "Electric (SRP)", amount: 85, variable: true, dueDays: [17], accountId: A, categoryId: "utilities" });

/** What the app's "paid" tap and Muse's mark_bill_paid write. */
const NOTE = txn({
  id: "note",
  date: "2026-10-20",
  amount: 81.37,
  categoryId: "utilities",
  description: "Electric (SRP) (already paid)",
  appliesTo: { kind: "bill", recurringId: "elec", monthKey: "2026-10", day: 17, settled: true },
});

/** The bank's own charge for the same bill, from the joint account, attached to nothing. */
const BANK = txn({
  id: "bank",
  date: "2026-10-19",
  amount: 81.37,
  categoryId: "utilities",
  description: "Srp",
  accountId: JOINT,
  provider: "plaid",
});

const check10 = (d: AppData) => selfAudit(d, NOW).checks.find((c) => c.id === "hand-note-beside-bank-charge")!;

// ── 1. the self-check ────────────────────────────────────────────────────────
describe("check 10 — a hand note beside the bank's own charge", () => {
  it("FAILS on the real shape, naming the bill, the month and both rows", () => {
    const d = ledger({ recurring: [ELECTRIC], transactions: [NOTE, BANK] });
    const c = check10(d);
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Electric (SRP) 2026-10");
    expect(c.detail).toContain("$81.37");
    expect(c.detail).toContain("2026-10-19");
    // The checks that existed all passed on this ledger — the reason for this one.
    const r = selfAudit(d, NOW);
    expect(r.checks.find((x) => x.id === "one-payment-per-cycle")!.status).toBe("ok");
    expect(r.checks.find((x) => x.id === "links-point-somewhere")!.status).toBe("ok");
    expect(r.failures).toBe(1);
  });

  it("also fails when the note is on the bill's own account's charge — the plain same-account case", () => {
    const own = { ...BANK, accountId: A };
    expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE, own] })).status).toBe("fail");
  });

  it("passes on a bill paid in cash — a note with no bank charge is what the note is for", () => {
    expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE] })).status).toBe("ok");
  });

  it("passes when the amounts are too far apart to be one payment — part cash, part card", () => {
    const part = { ...BANK, amount: 40 };
    expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE, part] })).status).toBe("ok");
  });

  it("passes on a different merchant for the same amount on the same day", () => {
    const other = { ...BANK, description: "Trader Joe's", categoryId: "groceries" };
    expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE, other] })).status).toBe("ok");
  });

  it("passes when the bank charge falls in another month", () => {
    const next = { ...BANK, date: "2026-11-18" };
    expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE, next] })).status).toBe("ok");
  });

  it("passes on a still-processing charge, a hand-entered charge, and a charge already attached", () => {
    const pending = { ...BANK, pending: true };
    const typed = { ...BANK, provider: undefined };
    const attached = { ...BANK, appliesTo: { kind: "setaside" as const, reason: "excluded" as const } };
    for (const t of [pending, typed, attached]) {
      expect(check10(ledger({ recurring: [ELECTRIC], transactions: [NOTE, t] })).status).toBe("ok");
    }
  });

  it("passes on the Cherry shape — the bank row claimed the DEBT; that one stays a suggestion (W5b)", () => {
    const cherry = bill({ id: "ch", name: "Cherry (dental)", amount: 64.2, dueDays: [24], accountId: A, linkedDebtId: "d" });
    const note = { ...NOTE, id: "n2", amount: 64.2, description: "Cherry (dental) (already paid)", appliesTo: { kind: "bill" as const, recurringId: "ch", monthKey: "2026-10", day: 24, settled: true } };
    const bank = { ...BANK, id: "b2", date: "2026-10-24", amount: 64.2, description: "CHERRY TECHNOLOGIES", accountId: A, appliesTo: { kind: "debt" as const, debtId: "d", settled: true } };
    const d = ledger({
      recurring: [cherry],
      debts: [{ id: "d", name: "Dental", balance: 300, originalBalance: 600, color: "#888888", createdAt: "2026-01-01T00:00:00Z" }],
      transactions: [note, bank],
    });
    expect(check10(d).status).toBe("ok");
  });

  it("passes once repaired — the note gone and the bank's charge holding the month", () => {
    const linked = { ...BANK, appliesTo: { kind: "bill" as const, recurringId: "elec", monthKey: "2026-10", day: 17, settled: true } };
    const r = selfAudit(ledger({ recurring: [ELECTRIC], transactions: [linked] }), NOW);
    expect(r.checks.find((x) => x.id === "hand-note-beside-bank-charge")!.status).toBe("ok");
    expect(r.checks.find((x) => x.id === "one-payment-per-cycle")!.status).toBe("ok");
  });

  it("isHandNote is the hand note and nothing else", () => {
    expect(isHandNote(NOTE)).toBe(true);
    expect(isHandNote({ ...NOTE, accountId: A })).toBe(false); // a cash payment the app moved
    expect(isHandNote({ ...NOTE, provider: "plaid" })).toBe(false);
    expect(isHandNote({ ...NOTE, appliesTo: { ...NOTE.appliesTo!, settled: false } })).toBe(false);
    expect(isHandNote(BANK)).toBe(false);
  });
});

// ── 2. Worth a look ──────────────────────────────────────────────────────────
describe("W5c — Worth a look offers the repair, and it is always the note that goes", () => {
  it("names the bill and the month and removes the hand note, never the bank's row", () => {
    const out = reviewLedger(ledger({ recurring: [ELECTRIC], transactions: [NOTE, BANK] }), NOW);
    const w5c = out.filter((s) => s.rule === "W5c");
    expect(w5c).toHaveLength(1);
    expect(w5c[0].title).toContain("Electric (SRP)");
    expect(w5c[0].evidence.txnIds.sort()).toEqual(["bank", "note"]);
    expect(w5c[0].fix).toMatchObject({ action: "deleteTransaction", txnId: "note" });
    // W7 does not ALSO offer the bank charge while the note holds the month: one card.
    expect(out.filter((s) => s.rule === "W7")).toHaveLength(0);
  });

  it("after the note is gone, W7 offers to attach the bank's charge — across accounts, by the sync's own rules", () => {
    const out = reviewLedger(ledger({ recurring: [ELECTRIC], transactions: [BANK] }), NOW);
    const w7 = out.filter((s) => s.rule === "W7");
    expect(w7).toHaveLength(1);
    expect(w7[0].fix).toMatchObject({ action: "linkTransactionToBill", txnId: "bank", recurringId: "elec", monthKey: "2026-10" });
  });

  it("says nothing about a bill paid in cash", () => {
    const out = reviewLedger(ledger({ recurring: [ELECTRIC], transactions: [NOTE] }), NOW);
    expect(out.filter((s) => s.rule === "W5c")).toHaveLength(0);
  });

  it("reaches Muse with both rows and a sentence that says how to repair it", () => {
    const d = ledger({ recurring: [ELECTRIC], transactions: [NOTE, BANK] });
    const { suggestions } = redactSuggestions(reviewLedger(d, NOW), d);
    const w5c = suggestions.find((s) => s.rule === "W5c")!;
    expect(w5c.bill).toBe("elec");
    expect(w5c.month).toBe("2026-10");
    expect(w5c.charges?.map((c) => c.id).sort()).toEqual(["bank", "note"]);
    expect(w5c.sentence).toContain("Attach the bank's charge");
    // The month BY ITS KEY (2026-10-25): link_charge_to_bill, sent no month, would use
    // the charge's calendar month, and for a bill due on the 1st paid a few days early
    // that is the month before the one this card names.
    expect(w5c.sentence).toContain("sending month 2026-10");
  });

  // FOUND 2026-10-25 in review: a note the statement import wrote carries record_only,
  // and applyFix refuses every record-only delete — so W5c's one button could only ever
  // refuse (the dead button W5a was fixed for). The double count is still real, so the
  // card stays; it just offers no button and says what a person can do.
  describe("a note the statement import wrote", () => {
    const IMPORTED = { ...NOTE, recordOnly: true };

    it("the button W5c used to offer could never succeed on it", async () => {
      const d = ledger({ recurring: [ELECTRIC], transactions: [IMPORTED, BANK] });
      const surface = toSurfaceFix({ action: "deleteTransaction", txnId: "note", label: "Remove the hand-entered one" })!;
      const writes = { deleteTransaction: () => Promise.resolve(true) } as unknown as ReviewWrites;
      const res = await applyFix(surface, d, writes);
      expect(res.ok).toBe(false);
    });

    it("gets the card with no button, and a sentence that says to delete it by hand", () => {
      const out = reviewLedger(ledger({ recurring: [ELECTRIC], transactions: [IMPORTED, BANK] }), NOW);
      const w5c = out.filter((s) => s.rule === "W5c");
      expect(w5c).toHaveLength(1);
      expect(w5c[0].fix).toBeNull();
      expect(w5c[0].detail).toContain("statement import");
      expect(w5c[0].detail).toContain("delete the imported note yourself");
      expect(w5c[0].evidence.txnIds.sort()).toEqual(["bank", "note"]);
    });

    it("still fails check 10 — the money is counted twice all the same", () => {
      expect(check10(ledger({ recurring: [ELECTRIC], transactions: [IMPORTED, BANK] })).status).toBe("fail");
    });

    it("a note tapped in by hand keeps its one-tap fix, and it works", async () => {
      const d = ledger({ recurring: [ELECTRIC], transactions: [NOTE, BANK] });
      const [w5c] = reviewLedger(d, NOW).filter((s) => s.rule === "W5c");
      const surface = toSurfaceFix(w5c.fix!)!;
      const deleted: string[] = [];
      const writes = { deleteTransaction: (id: string) => (deleted.push(id), Promise.resolve(true)) } as unknown as ReviewWrites;
      expect((await applyFix(surface, d, writes)).ok).toBe(true);
      expect(deleted).toEqual(["note"]);
    });
  });
});

describe("W7's third arm stays as strict as the sync", () => {
  it("never offers one person's own subscription for the other person's bill", () => {
    const pro = bill({ id: "pro", name: "Claude Pro", amount: 24.5, dueDays: [20], accountId: B, categoryId: "subscriptions" });
    const mine = txn({ id: "mine", date: "2026-10-08", amount: 24.5, description: "Anthropic", accountId: A, provider: "plaid" });
    const out = reviewLedger(ledger({ recurring: [pro], transactions: [mine] }), NOW);
    expect(out.filter((s) => s.rule === "W7")).toHaveLength(0);
  });

  it("a charge the categorizer names is offered for that bill only, never also for a look-alike on the same account", () => {
    const rent = bill({ id: "rent", name: "Rent", amount: 1450, dueDays: [1], accountId: JOINT, categoryId: "housing" });
    const twin = bill({ id: "twin", name: "Something Else", amount: 1450, dueDays: [2], accountId: JOINT, categoryId: "housing" });
    const paid = txn({ id: "r", date: "2026-10-02", amount: 1450, description: "ACH HOLD Nollie MA Rent ON 10/02", accountId: JOINT, provider: "plaid" });
    const w7 = reviewLedger(ledger({ recurring: [rent, twin], transactions: [paid] }), NOW).filter((s) => s.rule === "W7");
    expect(w7.map((s) => s.recurringId)).toEqual(["rent"]);
  });
});

// ── 3. the write door ────────────────────────────────────────────────────────
const CHARGE = "11111111-2222-3333-4444-555555555555";
const NOTE_ID = "22222222-3333-4444-5555-666666666666";
const BILL = "99999999-8888-7777-6666-555555555555";
const DOOR_ACCT = "aaaa1111-2222-3333-4444-555555555555";
const AT = new Date("2026-10-25T19:00:00Z");

function door(
  over: { note?: Record<string, unknown>; charge?: Record<string, unknown>; bill?: Record<string, unknown>; rule?: boolean } = {},
): FinanceFake {
  const db = new FinanceFake();
  db.tables.accounts.push({ id: DOOR_ACCT, name: "Sample Joint", owner: "Joint", balance: 500, provider_account_id: "p1", last4: null });
  db.tables.recurring.push({
    id: BILL, name: "Sample power", amount: 85, direction: "out", cadence: "monthly", category_id: "utilities",
    active: true, variable: true, known_amount: null, due_days: [17], starts_on: null, ends_on: null,
    linked_debt_id: null, account_id: null, ...over.bill,
  });
  // What makes the bank read the charge as THIS bill (2026-10-25): the household taught
  // the app that this merchant pays it — the same learned rule the sync reads first.
  if (over.rule !== false) {
    db.tables.merchant_rules.push({
      id: "rule-power", pattern: merchantKey("Sample Power Co"), kind: "bill", category_id: null, bill_name: "Sample power",
    });
  }
  db.tables.transactions.push({
    id: CHARGE, date: "2026-10-19", amount: 81.37, type: "expense", category_id: "utilities",
    description: "Sample Power Co", account_id: DOOR_ACCT, applies_to: null, flow_override: null, splits: null,
    anomaly_ack: false, needs_review: true, user_categorized: false, record_only: false, provider: "plaid",
    status: "posted", created_at: "2026-10-19T12:00:00Z", person: null, ...over.charge,
  });
  db.tables.transactions.push({
    id: NOTE_ID, date: "2026-10-20", amount: 81.37, type: "expense", category_id: "utilities",
    description: "Sample power (already paid)", account_id: null,
    applies_to: { kind: "bill", recurringId: BILL, monthKey: "2026-10", day: 17, settled: true },
    flow_override: null, splits: null, anomaly_ack: false, needs_review: false, user_categorized: false,
    record_only: false, provider: null, status: "posted", created_at: "2026-10-20T12:00:00Z", person: "gino", ...over.note,
  });
  return db;
}
function ctx(db: FinanceFake): Ctx {
  const clock = clockNow(AT);
  return { db: db as unknown as Db, push: () => Promise.resolve(), person: "gino", at: clock.at, az: clock.az, appUrl: "https://example.test/" };
}
const tool = (name: string) => FINANCE_WRITE_TOOLS[name];
const link = (db: FinanceFake) =>
  tool("finance.link_charge_to_bill").run({ transaction_id: CHARGE, bill_id: BILL, month: "2026-10" }, ctx(db)) as Promise<
    { ok: true; result: Record<string, unknown>; say: string } | { ok: false; status: number; say: string }
  >;

describe("finance.link_charge_to_bill — the bank's charge takes the month from a hand note", () => {
  it("attaches the charge and removes the note in one step, and the undo puts both back exactly", async () => {
    const db = door();
    const before = JSON.parse(JSON.stringify(db.tables));
    const out = await link(db);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const charge = db.tables.transactions.find((r) => r.id === CHARGE)!;
    expect(charge.applies_to).toMatchObject({ kind: "bill", recurringId: BILL, monthKey: "2026-10", day: 17 });
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(false);
    // No cash moved: the note had no account, and the bank's balance is the bank's.
    expect(db.tables.accounts[0].balance).toBe(500);
    if (!out.ok) return;
    expect(out.result.retired_note).toBe(NOTE_ID);

    const undone = await tool("system.undo").run({ token: out.result.undo }, ctx(db));
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    const sorted = (t: typeof before) => ({ ...t, transactions: [...t.transactions].sort((a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1)) });
    expect(sorted(JSON.parse(JSON.stringify(db.tables)))).toEqual(sorted(before));
  });

  it("refuses when the note is for a different amount — part paid another way, both stay", async () => {
    const db = door({ note: { amount: 30 } });
    const out = await link(db);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.say).toContain("hand note");
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === CHARGE)!.applies_to).toBeNull();
  });

  it("refuses for a hand-entered charge — one hand note's word does not replace another's", async () => {
    const db = door({ charge: { provider: null } });
    const out = await link(db);
    expect(out.ok).toBe(false);
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
  });

  it("refuses when the month is held by a real payment, exactly as before", async () => {
    // A row WITH an account is a payment the app moved cash for, not a hand note.
    const db = door({ note: { account_id: DOOR_ACCT, description: "Sample power" } });
    const out = await link(db);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.say).toContain("already paying");
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
  });

  // FOUND 2026-10-25 in review. The takeover first shipped on the amount alone, so a wrong
  // pairing from Muse — a charge that is not this bill, the same size — removed a real
  // note and paid the bill with it, where the door used to refuse any month already held.
  // Rule 6 of this repo: never link on a weak match. The bank's own reading of the charge
  // must name THIS bill now.
  it("refuses when nothing in the charge's name says it is that bill — the note stays", async () => {
    const db = door({ rule: false });
    const before = JSON.parse(JSON.stringify(db.tables.transactions));
    const out = await link(db);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.say).toContain("nothing in this charge's name says it is that bill");
    expect(db.tables.transactions).toEqual(before);
  });

  it("refuses a charge the bank reads as a DIFFERENT bill of the same size", async () => {
    const db = door({ rule: false });
    db.tables.recurring.push({
      id: "88888888-7777-6666-5555-444444444444", name: "Desert water", amount: 85, direction: "out", cadence: "monthly",
      category_id: "utilities", active: true, variable: true, known_amount: null, due_days: [17], starts_on: null,
      ends_on: null, linked_debt_id: null, account_id: null,
    });
    db.tables.merchant_rules.push({
      id: "rule-water", pattern: merchantKey("Sample Power Co"), kind: "bill", category_id: null, bill_name: "Desert water",
    });
    const out = await link(db);
    expect(out.ok).toBe(false);
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === CHARGE)!.applies_to).toBeNull();
  });

  it("a note the statement import wrote gives way the same way — replaced by the bank's charge, and the undo puts it back", async () => {
    const db = door({ note: { record_only: true } });
    const out = await link(db);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(false);
    if (!out.ok) return;
    const undone = await tool("system.undo").run({ token: out.result.undo }, ctx(db));
    expect(undone.ok, JSON.stringify(undone)).toBe(true);
    expect(db.tables.transactions.find((r) => r.id === NOTE_ID)?.record_only).toBe(true);
  });

  // FOUND 2026-10-25 in review. W5c places the pair the way the bank sync does — with
  // billCycleFor's week of grace — and the door, sent no month, used the charge's calendar
  // month. A bill due on the 1st and paid on the 28th: the note holds NEXT month, and the
  // charge was attached to THIS month instead, beside it. The double count stayed, and
  // hid from check 10, because the charge was no longer unattached.
  describe("the month, when Muse leaves it out", () => {
    const early = (over: { note?: Record<string, unknown> } = {}) =>
      door({
        bill: { due_days: [1] },
        charge: { date: "2026-10-28" },
        note: { date: "2026-10-29", applies_to: { kind: "bill", recurringId: BILL, monthKey: "2026-11", day: 1, settled: true }, ...over.note },
      });
    const linkNoMonth = (db: FinanceFake) =>
      tool("finance.link_charge_to_bill").run({ transaction_id: CHARGE, bill_id: BILL }, ctx(db)) as Promise<
        { ok: true; result: Record<string, unknown>; say: string } | { ok: false; status: number; say: string }
      >;

    it("takes the month the note holds when the bank would count the charge toward it", async () => {
      const db = early();
      const out = await linkNoMonth(db);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(db.tables.transactions.find((r) => r.id === CHARGE)!.applies_to).toMatchObject({ monthKey: "2026-11", day: 1 });
      expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(false);
    });

    it("with no note in that month, it is the charge's own month, exactly as before", async () => {
      const db = early();
      db.tables.transactions = db.tables.transactions.filter((r) => r.id !== NOTE_ID);
      const out = await linkNoMonth(db);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(db.tables.transactions.find((r) => r.id === CHARGE)!.applies_to).toMatchObject({ monthKey: "2026-10" });
    });

    it("never for a note of a different amount — then it is the charge's own month, as before", async () => {
      const db = early({ note: { amount: 30 } });
      const out = await linkNoMonth(db);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      expect(db.tables.transactions.find((r) => r.id === CHARGE)!.applies_to).toMatchObject({ monthKey: "2026-10" });
      expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
    });

    it("a month that was SENT is the month used; a note it does not match the bank's month for stays", async () => {
      // The note holds October; the bank counts a charge on the 28th toward November.
      const db = early({ note: { applies_to: { kind: "bill", recurringId: BILL, monthKey: "2026-10", day: 1, settled: true } } });
      const out = await link(db);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.say).toContain("counts this charge toward 2026-11");
      expect(db.tables.transactions.some((r) => r.id === NOTE_ID)).toBe(true);
    });
  });
});

// ── 4. the bank sync's own decision ──────────────────────────────────────────
describe("the bank sync — a NEW bank charge takes the month from a hand note alone", () => {
  const scanNote = {
    id: "n", type: "expense", amount: "81.37", provider: null, account_id: null, status: "posted",
    applies_to: { kind: "bill", recurringId: "elec", monthKey: "2026-10", day: 17, settled: true },
    user_categorized: false, flow_override: null, splits: null,
  };
  const holders = (...h: CycleHolder[]) => h;

  it("a hand note is retirable only while nobody has answered it and it moved no cash", () => {
    expect(isRetirableHandNote(scanNote)).toBe(true);
    expect(isRetirableHandNote({ ...scanNote, provider: "plaid" })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, account_id: "acct" })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, applies_to: { ...scanNote.applies_to, settled: false } })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, status: "pending" })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, user_categorized: true })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, flow_override: "spent" })).toBe(false);
    expect(isRetirableHandNote({ ...scanNote, splits: [{ categoryId: "utilities", amount: 81.37 }] })).toBe(false);
  });

  it("takes the month for the same amount, inside the sync's band", () => {
    const h = holderOf(scanNote);
    expect(handNoteToRetire(holders(h), -81.37, true, new Set())?.id).toBe("n");
    expect(handNoteToRetire(holders(h), -95, true, new Set())?.id).toBe("n"); // variable: ±$15
    expect(handNoteToRetire(holders(h), -97, true, new Set())).toBeNull();
    expect(handNoteToRetire(holders(h), -84, false, new Set())).toBeNull(); // fixed: ±$2.44
  });

  it("keeps today's behaviour for every other month", () => {
    const h = holderOf(scanNote);
    const paidByBank: CycleHolder = { id: "x", handNote: false, amount: 81.37 };
    expect(handNoteToRetire(undefined, -81.37, true, new Set())).toBeNull(); // income claim, nothing listed
    expect(handNoteToRetire(holders(paidByBank), -81.37, true, new Set())).toBeNull(); // a real payment holds it
    expect(handNoteToRetire(holders(h, paidByBank), -81.37, true, new Set())).toBeNull(); // two rows: a person decides
    expect(handNoteToRetire(holders(holderOf({ ...scanNote, user_categorized: true })), -81.37, true, new Set())).toBeNull();
    expect(handNoteToRetire(holders(h), -81.37, true, new Set(["n"]))).toBeNull(); // already given to an earlier charge
  });

  it("is wired the narrow way: the delete is hard-scoped, and the day-and-amount guess never crosses accounts", () => {
    const src = readFileSync("supabase/functions/plaid/index.ts", "utf8");
    expect(src).toMatch(/handNoteToRetire\(cycleHolders\.get\(key\)/);
    const del = src.slice(src.indexOf('.eq("id", tk.note.id)'), src.indexOf(".select(", src.indexOf('.eq("id", tk.note.id)')));
    for (const scope of ['.is("provider", null)', '.is("account_id", null)', '"applies_to->>settled", "true"', '.is("flow_override", null)', '.is("splits", null)']) {
      expect(del).toContain(scope);
    }
    // Only a charge NEW to the ledger takes over; a re-sync never re-decides one. Since
    // 2026-10-25 that is one read before the loop, shared with the cross-account link —
    // held in tests/chargeStanding.test.ts.
    expect(src).toMatch(/readAllPages\("stored charges"/);
    expect(src).toMatch(/mayTakeOver\(standingOf\(row\)\)/);
    expect(src).toMatch(/matchBillByDayAmount\(payable, row\.date/);
    // Unchanged for a bill named by its biller. A bill named from the shape of the line
    // (an ACH transfer as the car payment, 2026-10-26) is decided once, before the loop
    // (postedAnswer) — held in tests/carPaymentAch.test.ts.
    expect(src).toMatch(/matchBillForCharge\(c\.billName, liveRecs, chargeAcct, row\.amount, sharedAccts\)/);
  });
});

// ── 5. the money counts once ─────────────────────────────────────────────────
describe("once repaired, the charge counts once", () => {
  it("the note's month is paid by the bank's charge, which leaves the budget lines, and every line still equals its rows", () => {
    const before = ledger({ recurring: [ELECTRIC], transactions: [NOTE, { ...BANK, categoryId: "other" }] });
    // Before: the charge is graded as Misc spending AND the note pays the bill.
    expect(spentByCategoryBetween(before.transactions, "2026-10-15", "2026-10-30").other).toBeCloseTo(81.37, 2);

    const after = ledger({
      recurring: [ELECTRIC],
      transactions: [{ ...BANK, categoryId: "other", appliesTo: { kind: "bill", recurringId: "elec", monthKey: "2026-10", day: 17, settled: true } }],
    });
    expect(spentByCategoryBetween(after.transactions, "2026-10-15", "2026-10-30").other ?? 0).toBe(0);
    const r = selfAudit(after, NOW);
    expect(r.checks.find((c) => c.id === "bar-vs-rows")!.status).toBe("ok");
    expect(r.checks.find((c) => c.id === "hand-note-beside-bank-charge")!.status).toBe("ok");
  });
});
