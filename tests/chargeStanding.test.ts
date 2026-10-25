// The bank sync decides something NEW only for a charge that is arriving.
//
// FOUND 2026-10-25 in review of the 2026-10-24 bill work. The sync learned two things that
// day: a named bill paid from another of the household's accounts links (matchBillForCharge),
// and a bank charge can take a bill month from a hand-made "(already paid)" note. Both were
// written for charges arriving — but the sync also re-sends charges it already stores
// (Plaid's `modified`, and the whole history after a cursor reset), and apply_bank_sync
// writes a re-sent row with `applies_to = coalesce(existing, new)` and no user_categorized
// guard. So a charge already in the ledger with no link — the car-insurance charges a person
// had answered by hand because they never linked are exactly that shape — would have gained a
// bill link the next time the bank touched it: out of the budget, settling a month nobody
// asked it to. A guess re-deciding a row, which the sync must never do (schema_v26).
//
// What is held here:
//   1. the motivating failure, modelled the way the sync runs it: a stored, unlinked charge
//      re-sent in `modified` goes back to reconcile's upsert list, the household fallback
//      WOULD name a bill on another account for it — and the gate says no;
//   2. the over-reach guards: a new charge still links across accounts; a stored charge
//      this sync already linked is written back as it is; a charge whose pending row a
//      person answered keeps their answer; the takeover needs a new charge from an account
//      the sync writes;
//   3. the wiring in plaid/index.ts, which no test can import.
// Every id, name and amount is invented.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchBillForCharge, type PayableBill } from "../src/lib/categorize";
import { mayLinkFromAnotherAccount, mayTakeOver, type ChargeStanding } from "../supabase/functions/_shared/chargeStanding.ts";
import { reconcile, type PlaidTxn } from "../supabase/functions/_shared/plaidSync.ts";

const A = "acct-a"; // one person's own checking
const JOINT = "acct-joint";
const SHARED = new Set([JOINT]);

type Row = PayableBill & { id: string };
const INSURANCE_ON_JOINT: Row = {
  id: "ins", name: "Car insurance — last two instalments", account_id: JOINT, amount: 140.25, variable: false, due_days: [28],
};

const standing = (over: Partial<ChargeStanding> = {}): ChargeStanding => ({
  isNew: true, answered: false, mapped: true, storedLink: null, ...over,
});

/** The sync's bill decision for one named charge, exactly as plaid/index.ts makes it:
 *  the household fallback first, then the gate on a link from another account. */
function syncNames(billName: string, chargeAcct: string, amount: number, s: ChargeStanding): string | null {
  let named = matchBillForCharge(billName, [INSURANCE_ON_JOINT], chargeAcct, amount, SHARED);
  if (named?.fromAnotherAccount && !mayLinkFromAnotherAccount(s, String(named.bill.id))) named = null;
  return named?.bill.id ?? null;
}

const txn = (over: Partial<PlaidTxn>): PlaidTxn => ({
  transaction_id: "tx-1", pending: false, account_id: "plaid-a", date: "2026-09-27",
  name: "SAMPLE INSURER PAYMENT", merchant_name: "Sample Insurer", amount: 140.25, ...over,
});

// ── 1. the motivating failure ────────────────────────────────────────────────
describe("a charge already in the ledger is never linked across accounts by a re-sync", () => {
  it("the bank re-sends a stored, unlinked charge — the fallback would name the bill, and the gate keeps it as it is", () => {
    // The ledger already holds tx-1 (a person answered it by hand: no link). The bank
    // changes something about it and lists it in `modified`.
    const known = new Set(["tx-1"]);
    const ops = reconcile({ added: [], modified: [txn({})], removed: [] }, () => "key", new Set(), known);
    expect(ops.upsertPosted.map((r) => r.providerTxnId)).toEqual(["tx-1"]); // it IS written again

    const row = ops.upsertPosted[0];
    // Without the gate, the household fallback names the bill on the joint account…
    expect(matchBillForCharge("Car insurance", [INSURANCE_ON_JOINT], A, row.amount, SHARED)).toMatchObject({
      bill: { id: "ins" },
      fromAnotherAccount: true,
    });
    // …and with it, the stored row is not re-decided: today's shape, no link.
    expect(syncNames("Car insurance", A, row.amount, standing({ isNew: false, storedLink: null }))).toBeNull();
  });

  it("the same for every link the stored row does not already carry", () => {
    for (const storedLink of [null, { kind: "setaside", reason: "excluded" }, { kind: "bill", recurringId: "other-bill", monthKey: "2026-09" }]) {
      expect(mayLinkFromAnotherAccount(standing({ isNew: false, storedLink }), "ins"), JSON.stringify(storedLink)).toBe(false);
    }
  });
});

// ── 2. the over-reach guards ─────────────────────────────────────────────────
describe("what still links — the fallback is not switched off, only kept to arriving charges", () => {
  it("a NEW charge from a personal account links to the bill on the joint account", () => {
    expect(syncNames("Car insurance", A, -140.25, standing())).toBe("ins");
  });

  it("a stored charge this sync already linked to that bill is written back as it is", () => {
    // The bank re-sending a row the sync linked across accounts on the day it arrived.
    const storedLink = { kind: "bill", recurringId: "ins", monthKey: "2026-09", day: 28, settled: true };
    expect(syncNames("Car insurance", A, -140.25, standing({ isNew: false, storedLink }))).toBe("ins");
  });

  it("a new charge whose pending row a person answered keeps their answer, and links nothing across accounts", () => {
    expect(syncNames("Car insurance", A, -140.25, standing({ answered: true }))).toBeNull();
  });

  it("an own-account match is not gated at all — it behaves exactly as before 2026-10-24", () => {
    // The charge comes from the joint account, where the bill is set: no fallback involved.
    expect(syncNames("Car insurance", JOINT, -140.25, standing({ isNew: false, storedLink: null }))).toBe("ins");
  });

  it("a bank charge may take a month from a hand note only when it is new, unanswered, and from an account the sync writes", () => {
    expect(mayTakeOver(standing())).toBe(true);
    expect(mayTakeOver(standing({ isNew: false }))).toBe(false); // a re-sent row
    expect(mayTakeOver(standing({ answered: true }))).toBe(false); // their answer is carried instead
    // A bank account not in `accounts` is never written by the sync, so a note removed
    // for its charge would leave the month paid by nothing.
    expect(mayTakeOver(standing({ mapped: false }))).toBe(false);
  });
});

// ── 3. the wiring ────────────────────────────────────────────────────────────
describe("plaid/index.ts asks the gate before it decides anything new", () => {
  const src = readFileSync("supabase/functions/plaid/index.ts", "utf8");

  it("reads which charges are stored BEFORE the loop that decides links, and stops the sync if that read fails", () => {
    const read = src.indexOf('readAllPages("stored charges"');
    const loop = src.indexOf("for (const row of ops.upsertPosted) {");
    expect(read).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(read);
    // Seeded from the dedup scan's ids, so a row in the delta's own dates costs no read.
    expect(src).toMatch(/const storedIds = new Set<string>\(knownProviderIds\)/);
    // No try/catch turns a failed read into "nothing is stored".
    const block = src.slice(read - 400, read + 400);
    expect(block).not.toMatch(/catch/);
  });

  it("gates the cross-account link and the takeover on the charge's standing", () => {
    expect(src).toMatch(/named\?\.fromAnotherAccount && !mayLinkFromAnotherAccount\(standingOf\(row\), String\(named\.bill\.id\)\)/);
    expect(src).toMatch(/mayTakeOver\(standingOf\(row\)\)\s*\?\s*handNoteToRetire\(cycleHolders\.get\(key\)/);
    expect(src).toMatch(/answered: !!row\.pendingTxnId && corrections\.has\(row\.pendingTxnId\)/);
    expect(src).toMatch(/mapped: !!acctIdByProv\[row\.accountId\]/);
  });

  it("removes a note only for an account it writes, and logs enough of the note to put it back", () => {
    expect(src).toMatch(/if \(acctIdByProv\[tk\.acct\]\) \{/);
    expect(src).toMatch(/\.select\("id, date, amount, description, category_id, applies_to, record_only, created_at, person"\)/);
    // The old after-the-loop read is gone: one read, before the loop, answers both.
    expect(src).not.toMatch(/readAllPages\("takeover ids"/);
  });
});
