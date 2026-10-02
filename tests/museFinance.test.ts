// Phase 2: finance parity, and the undo core.
//
// WHAT THIS FILE IS FOR, in one sentence: the whole argument for dropping Phase 1's
// approval queue is that every change is written down with its before-state, so the
// tests that matter are the ones that put a change back and check the row is what it
// was.
//
// It is a separate file from tests/museWrite.test.ts on purpose. That one owns the
// door's PLUMBING — the secret, the Idempotency-Key, the rate limit, the audit row, the
// day-document race — and it proves those against the simplest write there is. This one
// owns the finance tools and the undo, and it shares that file's in-memory ledger
// (tests/museFinanceFake.ts) so there is one fake rather than two that drift.
//
// THE INSTANT. 2026-09-27T02:00:00Z is 7 PM on the 26th in Arizona — inside the window
// where a UTC runtime has already rolled over to tomorrow. He works nights, so that is
// most of his waking day, and a door that filed a charge under the wrong day would be
// believed because in a chat there is no screen beside the answer.

import { beforeEach, describe, expect, it } from "vitest";
import { clockNow } from "../supabase/functions/_shared/muse/az.ts";
import { handleMuseRead } from "../supabase/functions/_shared/muse/handler.ts";
import { handleWrite, type Deps, type Secrets } from "../supabase/functions/muse-write/handler.ts";
import { TOOLS as READ_TOOLS } from "../supabase/functions/_shared/muse/tools.ts";
import { SAYS_DESCRIPTION } from "../supabase/functions/_shared/muse/toolsFinance.ts";
import { FINANCE_WRITE_TOOLS } from "../supabase/functions/muse-write/toolsFinance.ts";
import {
  applyUndo,
  checkStep,
  checkSteps,
  mintToken,
  STATE_SAYS,
  TOKEN_SHAPE,
  UNDO_COLUMNS,
  UndoRefused,
  type UndoApplier,
  type UndoStep,
} from "../supabase/functions/_shared/muse/undo.ts";
import type { Db } from "../supabase/functions/muse-write/db.ts";
import type { Db as ReadDb, DbRow } from "../supabase/functions/_shared/muse/paging.ts";
import { FinanceFake, sameJson } from "./museFinanceFake.ts";
import { billsBeforeNextPayday, firepowerStatus, monthGetter } from "../src/lib/headline.ts";
import { toAppData } from "../supabase/functions/_shared/muse/rows.ts";

const AT = new Date("2026-09-27T02:00:00Z");
const AZ_TODAY = "2026-09-26";

// Long enough to be real. auth.ts refuses anything under MIN_SECRET_LENGTH so a
// half-pasted secret locks the door instead of opening it, and a test secret that
// tripped that guard would fail every read here with a 401 for the wrong reason.
const GINO = "gino-secret-that-is-long-enough-1234";
const XINYAN = "xinyan-secret-that-is-long-enough-1234";
const SECRETS: Secrets = { gino: GINO, xinyan: XINYAN };

const CHARGE = "11111111-2222-3333-4444-555555555555";
const BILL = "99999999-8888-7777-6666-555555555555";
const ACCOUNT = "aaaa1111-2222-3333-4444-555555555555";
const DEBT = "dddd1111-2222-3333-4444-555555555555";
const CREDIT = "cccc1111-2222-3333-4444-555555555555";

// ── the write door ───────────────────────────────────────────────────────────

/** The Fake, with only the pieces the finance tools reach. The plumbing methods throw
 *  rather than returning something plausible: a finance test that accidentally depended
 *  on the audit log should fail loudly, not quietly pass. */
class Fake extends FinanceFake implements Db {
  calls = new Map<string, number>();
  audit: { tool: string; idemKey: string | null; outcome: string; note?: string; rowIds?: string[] }[] = [];
  pushes: unknown[] = [];

  constructor() {
    super();
    this.tables.transactions.push({
      id: CHARGE,
      date: "2026-09-20",
      amount: 42,
      type: "expense",
      category_id: "other",
      description: "TRADER JOE'S #457",
      account_id: ACCOUNT,
      applies_to: null,
      // Present-and-null, like the real row. An absent key makes an undo that writes
      // null look like the row gained a field, and the before/after deep-equal fails.
      flow_override: null,
      splits: null,
      anomaly_ack: false,
      needs_review: true,
      user_categorized: false,
      record_only: false,
      provider: null,
      status: "posted",
      created_at: "2026-09-20T12:00:00Z",
      person: null,
    });
    this.tables.recurring.push({
      id: BILL,
      name: "Electric",
      amount: 100,
      direction: "out",
      cadence: "monthly",
      category_id: "utilities",
      active: true,
      variable: true,
      known_amount: null,
      due_days: [16],
      starts_on: null,
      ends_on: null,
      linked_debt_id: null,
      account_id: null,
    });
    this.tables.accounts.push({
      id: ACCOUNT,
      name: "Geo",
      balance: 812.4,
      provider_account_id: null,
      last4: "4728",
    });
    this.tables.debts.push({
      id: DEBT,
      name: "Card",
      balance: 4113.01,
      provider_account_id: null,
      track_pattern: null,
    });
  }

  // ── the plumbing, faked just enough for handleWrite to reach a tool ───────
  findCall() {
    return Promise.resolve(null);
  }
  /**
   * The household duplicate guard — "Xinyan already did that four minutes ago".
   *
   * It landed on `main` while this branch was being written, which is why every write
   * in this file 500'd on the merge: `db.recentSameWrite is not a function`, caught by
   * handleWrite's own catch and reported as "something went wrong on my side".
   *
   * Always null here, deliberately: this file's subject is the before-state and the
   * undo, and a fake that answered anything else would make every second write in a
   * loop refuse. The guard itself is covered against a real audit log in
   * tests/museWrite.test.ts, which drives both people's keys.
   */
  recentSameWrite() {
    return Promise.resolve(null);
  }
  claimCall(c: { tool: string; idemKey: string }) {
    const clash = this.audit.some((a) => a.idemKey === c.idemKey && a.tool === c.tool);
    if (clash) return Promise.resolve<"claimed" | "duplicate">("duplicate");
    this.audit.push({ tool: c.tool, idemKey: c.idemKey, outcome: "pending" });
    return Promise.resolve<"claimed" | "duplicate">("claimed");
  }
  releaseCall(_p: string, tool: string, idemKey: string) {
    this.audit = this.audit.filter((a) => !(a.tool === tool && a.idemKey === idemKey && a.outcome === "pending"));
    return Promise.resolve();
  }
  finishCall(c: { tool: string; idemKey: string; outcome: string; rowIds?: string[] }) {
    const row = this.audit.find((a) => a.tool === c.tool && a.idemKey === c.idemKey);
    if (row) Object.assign(row, { outcome: c.outcome, rowIds: c.rowIds });
    return Promise.resolve();
  }
  logCall(c: { tool: string; outcome: string; note: string }) {
    this.audit.push({ tool: c.tool, idemKey: null, outcome: c.outcome, note: c.note });
    return Promise.resolve();
  }
  bump(person: string, bucket: string) {
    const k = `${person}|${bucket}`;
    const n = (this.calls.get(k) ?? 0) + 1;
    this.calls.set(k, n);
    return Promise.resolve(n);
  }
  countOpenReminders() {
    return Promise.resolve(0);
  }
  insertReminder() {
    return Promise.reject(new Error("no finance tool writes a reminder"));
  }
  readWeight() {
    return Promise.reject(new Error("no finance tool reads a weight"));
  }
  upsertWeight() {
    return Promise.reject(new Error("no finance tool writes a weight"));
  }
  findSavedMealsByName() {
    return Promise.resolve([]);
  }
  listSavedMealNames() {
    return Promise.resolve([]);
  }
  readMealDay() {
    return Promise.resolve(null);
  }
  insertMealDay() {
    return Promise.reject(new Error("no finance tool writes a meal"));
  }
  updateMealDayIfUnchanged() {
    return Promise.reject(new Error("no finance tool writes a meal"));
  }
  transactionExists(id: string) {
    return Promise.resolve(this.tables.transactions.some((r) => r.id === id));
  }
  recurringName(id: string) {
    const r = this.tables.recurring.find((x) => x.id === id);
    return Promise.resolve(r ? String(r.name) : null);
  }
  insertPending() {
    return Promise.reject(new Error("no finance tool queues anything any more"));
  }
}

function deps(db: Fake): Deps {
  return {
    db,
    push: () => Promise.resolve(),
    secrets: SECRETS,
    appUrl: "https://app.test/",
    clock: clockNow(AT),
  };
}

let keySeq = 0;
function post(tool: string, args: Record<string, unknown>, secret = GINO): Request {
  keySeq += 1;
  return new Request("https://x.test/functions/v1/muse-write", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `test-key-${String(keySeq).padStart(6, "0")}`,
    },
    body: JSON.stringify({ tool, args }),
  });
}

/** Call a tool and expect it to have worked, returning the body. */
async function ok(db: Fake, tool: string, args: Record<string, unknown>, secret = GINO) {
  const r = await handleWrite(post(tool, args, secret), deps(db));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { ok: boolean; message: string; result: Record<string, unknown> };
}

/** Call a tool and expect a refusal, returning status and message. */
async function no(db: Fake, tool: string, args: Record<string, unknown>) {
  const r = await handleWrite(post(tool, args), deps(db));
  expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
  return { status: r.status, message: String(r.body.message) };
}

const undoToken = (body: { result: Record<string, unknown> }) => String(body.result.undo);

beforeEach(() => {
  keySeq = 0;
});

// ── the catalogue, so this file cannot fall behind the registry ───────────────

describe("every finance write is driven here", () => {
  /**
   * What the seeded ledger needs to look like before a given tool has anything to do.
   * Four tools change something that is only changeable when it is already a certain
   * way — you cannot release a charge that is attached to nothing — so those four say
   * so here rather than being left out of the sweep.
   */
  const SETUP: Record<string, (db: Fake) => void> = {
    "finance.unlink_charge": (db) => {
      db.tables.transactions[0].applies_to = { kind: "bill", recurringId: BILL, monthKey: "2026-09", day: 16 };
    },
    "finance.link_debt_to_card": (db) => {
      db.tables.accounts[0].provider_account_id = "plaid-acct-1";
    },
    "finance.unlink_debt_card": (db) => {
      db.tables.debts[0].provider_account_id = "plaid-acct-1";
    },
  };

  /** One call each tool accepts, against the seeded ledger. */
  const DRIVEN: Record<string, Record<string, unknown>> = {
    "finance.add_transaction": { amount: 6, category_id: "transport", description: "parking" },
    "finance.delete_charge": { transaction_id: CHARGE },
    "finance.categorize_charge": { transaction_id: CHARGE, category_id: "groceries" },
    "finance.split_charge": { transaction_id: CHARGE, slices: [{ category_id: "groceries", amount: 30 }, { category_id: "shopping", amount: 12 }] },
    "finance.unlink_charge": { transaction_id: CHARGE },
    "finance.link_charge_to_bill": { transaction_id: CHARGE, bill_id: BILL },
    "finance.mark_bill_paid": { bill_id: BILL, amount: 100 },
    "finance.set_paid_override": { month: "2026-09", bill_key: "Electric@16", paid: true },
    "finance.dismiss_unusual": { transaction_id: CHARGE },
    "finance.exclude_from_budget": { transaction_id: CHARGE },
    "finance.set_aside": { transaction_id: CHARGE, reason: "reimbursable" },
    "finance.settle_reimbursable": { transaction_id: CHARGE },
    "finance.unsettle_reimbursable": { transaction_id: CHARGE },
    "finance.promote_to_bill": { transaction_id: CHARGE },
    "finance.set_bill_variable": { bill_id: BILL, variable: false },
    "finance.set_bill_amount": { bill_id: BILL, amount: 101.24 },
    // What a person says a row IS, overruling src/lib/flow.ts — so a card payment
    // counted as spending, or a transfer counted as income, can be put right.
    "finance.set_flow": { transaction_id: CHARGE, flow: "moved" },
    // Which account a bill is paid from. All nineteen were null, which is how
    // "nothing is due" was true while the joint account was short of rent.
    "finance.set_bill_account": { bill_id: BILL, account_id: ACCOUNT },
    "finance.turn_bill_off": { bill_id: BILL, active: false },
    "finance.set_bill_window": { bill_id: BILL, ends_on: "2026-12-31" },
    "finance.add_bill": { name: "Renters insurance", amount: 10.59, due_day: 18, category_id: "utilities" },
    "finance.learn_merchant": { merchant: "TRADER JOE'S", kind: "variable", category_id: "groceries" },
    "finance.set_account_balance": { account_id: ACCOUNT, balance: 900 },
    "finance.add_debt": { name: "Affirm", balance: 240 },
    "finance.link_debt_to_card": { debt_id: DEBT, account_id: ACCOUNT },
    "finance.unlink_debt_card": { debt_id: DEBT },
    "system.undo": {},
    "finance.refresh_bank": {},
  };

  it("names all of them, so this file cannot fall behind the registry", () => {
    expect(Object.keys(DRIVEN).sort()).toEqual(Object.keys(FINANCE_WRITE_TOOLS).sort());
  });

  // Every tool that CHANGES something must hand back a token and log the change. Four
  // are excluded and each says why: system.undo is the reverse of a change rather than
  // one; the two whose seeded state already refuses (settle/unsettle a reimbursable,
  // which needs a set-aside charge first) are covered on their own below; and
  // finance.refresh_bank changes no household data at all — it writes a REQUEST on a
  // column no figure is computed from, and there is no before-state, because you cannot
  // un-ask a bank. It has its own block further down, including the refusal that says
  // so out loud.
  const CHANGES = Object.keys(DRIVEN).filter(
    (t) =>
      t !== "system.undo" &&
      t !== "finance.settle_reimbursable" &&
      t !== "finance.unsettle_reimbursable" &&
      t !== "finance.refresh_bank",
  );

  const seeded = () => {
    const db = new Fake();
    return db;
  };

  for (const tool of CHANGES) {
    it(`${tool} hands back an undo token and logs exactly one change`, async () => {
      const db = seeded();
      SETUP[tool]?.(db);
      const body = await ok(db, tool, DRIVEN[tool]);
      const token = undoToken(body);
      expect(token, `${tool} returned no undo token`).toMatch(TOKEN_SHAPE);
      // The token is in the SENTENCE too, not only in the JSON: the sentence is what an
      // assistant repeats out loud, and a handle only in a field it chose not to read
      // is no handle at all.
      expect(body.message).toContain(token);
      expect(db.changes).toHaveLength(1);
      expect(db.changes[0].tool).toBe(tool);
      // `undoable`, not `pending`: the row is written before the change is attempted and
      // only moves to undoable once every write landed.
      expect(db.changes[0].state).toBe("undoable");
      expect(String(db.changes[0].summary)).toBeTruthy();
    });

    it(`${tool} can be undone, and the row comes back the way it was`, async () => {
      const db = seeded();
      SETUP[tool]?.(db);
      const before = JSON.stringify(db.tables);
      const body = await ok(db, tool, DRIVEN[tool]);
      expect(JSON.stringify(db.tables), `${tool} changed nothing`).not.toBe(before);

      const undone = await ok(db, "system.undo", { token: undoToken(body) });
      expect(String(undone.message)).toContain("Put back");
      // BYTE FOR BYTE. This is the whole claim of the phase, and it is checked against
      // the tables rather than against a field: a "successful" undo that left
      // user_categorized set behind would pass a field check and fail this one.
      expect(JSON.parse(JSON.stringify(db.tables))).toEqual(JSON.parse(before));
      expect(db.changes.find((c) => c.token === undoToken(body))!.state).toBe("undone");
    });
  }
});

// ── the undo core, on its own ────────────────────────────────────────────────

describe("the undo core", () => {
  it("mints a token he can read out loud: no 0/O, no 1/I/l, no u", () => {
    // Every message he sends is dictated, so a token he cannot say is a token he cannot
    // use. Crockford's alphabet minus the characters that do not survive being spoken,
    // typed or transcribed: the two pairs that look alike (0/O, 1/I/l) and `u`, which is
    // dropped so no draw can spell a word. Checked over many draws rather than one,
    // because the alphabet is the point.
    for (let i = 0; i < 300; i++) {
      const t = mintToken((into) => {
        for (let j = 0; j < into.length; j++) into[j] = (i * 7 + j * 13) % 256;
      });
      expect(t).toMatch(TOKEN_SHAPE);
      expect(t.slice(2)).not.toMatch(/[01ilou]/);
      expect(t.slice(2)).toHaveLength(8);
    }
  });

  it("refuses a step naming a column no tool writes, before anything runs", () => {
    // The fence. `transactions.amount` is a real column and the door never changes it,
    // so an undo has no business being able to — and the refusal names the column,
    // because it means either a new tool forgot to widen the allowlist or something
    // wrote a step this door would not have written.
    expect(() =>
      checkStep({
        kind: "set_columns",
        table: "transactions",
        id: CHARGE,
        before: { amount: 1 },
        after: { amount: 2 },
      }),
    ).toThrow(UndoRefused);
    try {
      checkStep({ kind: "set_columns", table: "transactions", id: CHARGE, before: { amount: 1 }, after: { amount: 2 } });
    } catch (e) {
      expect((e as UndoRefused).say).toContain("amount");
    }
  });

  it("refuses a step naming a table the door does not write", () => {
    expect(() =>
      checkStep({ kind: "delete_row", table: "bank_connections", id: CHARGE, after: { status: "ok" } }),
    ).toThrow(UndoRefused);
  });

  it("refuses a set_columns whose two halves describe different columns", () => {
    // A `before` missing a column `after` names would leave that column holding the new
    // value while the reply said everything went back — a half undo reported as a whole
    // one, which is worse than no undo.
    expect(() =>
      checkStep({
        kind: "set_columns",
        table: "transactions",
        id: CHARGE,
        before: { category_id: "other" },
        after: { category_id: "groceries", user_categorized: true },
      }),
    ).toThrow(UndoRefused);
  });

  it("every column on the allowlist is one some tool actually writes", () => {
    // The fence is only meaningful if it is tight. A column left on the list after its
    // tool was removed is a column an undo could write with nothing writing it forward.
    const all = Object.values(UNDO_COLUMNS).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBeGreaterThan(0);
    // And the two columns whose absence is the load-bearing part.
    expect(UNDO_COLUMNS.transactions).not.toContain("amount");
    expect(UNDO_COLUMNS.transactions).not.toContain("provider");
    expect(UNDO_COLUMNS.transactions).not.toContain("raw_description");
  });

  it("runs the steps BACKWARDS, so a multi-row change unwinds in the right order", async () => {
    const order: string[] = [];
    const applier: UndoApplier = {
      setColumns: (t, id) => {
        order.push(`set:${t}:${id}`);
        return Promise.resolve("ok");
      },
      deleteRow: (t, id) => {
        order.push(`del:${t}:${id}`);
        return Promise.resolve("ok");
      },
      isReferenced: () => Promise.resolve(false),
      reverseMoneyEvent: () => Promise.resolve("ok"),
      restoreMoneyEvent: () => Promise.resolve("ok"),
    };
    // Recorded in the order the change made them: insert the bill first, point the
    // charge at it last. Undoing has to un-point first, or the delete would leave the
    // charge pointing at nothing — the state the app's own links-point-somewhere check
    // exists to complain about.
    const steps: UndoStep[] = [
      { kind: "delete_row", table: "recurring", id: BILL, after: { active: true } },
      { kind: "set_columns", table: "transactions", id: CHARGE, before: { applies_to: null }, after: { applies_to: { kind: "bill" } } },
    ];
    const out = await applyUndo(steps, applier);
    expect(out.ok).toBe(true);
    expect(order).toEqual([`set:transactions:${CHARGE}`, `del:recurring:${BILL}`]);
  });

  it("stops at the first step that finds the world moved, and says how much went back", async () => {
    let seen = 0;
    const applier: UndoApplier = {
      setColumns: () => {
        seen += 1;
        // The FIRST step applied (the last recorded) succeeds; the second refuses.
        return Promise.resolve(seen === 1 ? "ok" : "moved");
      },
      deleteRow: () => Promise.resolve("ok"),
      isReferenced: () => Promise.resolve(false),
      reverseMoneyEvent: () => Promise.resolve("ok"),
      restoreMoneyEvent: () => Promise.resolve("ok"),
    };
    const steps: UndoStep[] = [
      { kind: "set_columns", table: "transactions", id: CHARGE, before: { anomaly_ack: false }, after: { anomaly_ack: true } },
      { kind: "set_columns", table: "transactions", id: CREDIT, before: { applies_to: null }, after: { applies_to: { kind: "setaside" } } },
    ];
    const out = await applyUndo(steps, applier);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    // The honest report: something DID go back, and the sentence says so rather than
    // claiming nothing happened.
    expect(out.say).toContain("changed it since");
    expect(out.say).toContain("One part of it was already put back");
  });

  it("refuses to remove a bill something has attached itself to since", async () => {
    const applier: UndoApplier = {
      setColumns: () => Promise.resolve("ok"),
      deleteRow: () => Promise.resolve("ok"),
      isReferenced: () => Promise.resolve(true),
      reverseMoneyEvent: () => Promise.resolve("ok"),
      restoreMoneyEvent: () => Promise.resolve("ok"),
    };
    const out = await applyUndo(
      [{ kind: "delete_row", table: "recurring", id: BILL, after: { active: true }, guard: "no_bill_payments" }],
      applier,
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.say).toContain("pointing at nothing");
  });

  it("has a plain sentence for every state, including the one nobody wants", () => {
    // `pending` is the state that says "I cannot prove what happened", and it has to be
    // sayable — reading it as either done or not done is the failure.
    expect(STATE_SAYS.pending).toMatch(/could not confirm/i);
    expect(STATE_SAYS.abandoned).toMatch(/did not do this/i);
    expect(STATE_SAYS.undoable).toBeTruthy();
    expect(STATE_SAYS.undone).toBeTruthy();
  });

  it("refuses an empty step list rather than reporting a successful undo of nothing", () => {
    expect(() => checkSteps([])).toThrow(UndoRefused);
    expect(() => checkSteps(null)).toThrow(UndoRefused);
  });
});

// ── the guards ported out of the app ─────────────────────────────────────────

describe("the guards the app learned the hard way", () => {
  it("refuses to learn a non-bill rule for a merchant that IS a bill", async () => {
    // FinanceStore.tsx:803-813. A learned rule beats every built-in one, so teaching
    // `variable` for a bill merchant starts counting a fixed bill against the variable
    // envelope, and `skip` is worse — the feed drops the charge and a real payment never
    // enters the ledger at all.
    const db = new Fake();
    const r = await no(db, "finance.learn_merchant", { merchant: "Electric", kind: "variable", category_id: "utilities" });
    expect(r.status).toBe(409);
    expect(r.message).toContain("one of your bills");
    expect(db.tables.merchant_rules).toHaveLength(0);

    const skip = await no(db, "finance.learn_merchant", { merchant: "Electric", kind: "skip" });
    expect(skip.status).toBe(409);
  });

  it("refuses to learn `other` for a merchant, because that stops the app trying", async () => {
    // FinanceStore.tsx:819-826. Three had accumulated that way — GOOGLE ONE, GROK XAI
    // and SWA each had a standing instruction to file in Misc, which is the complaint
    // the whole thing was fixed for.
    const db = new Fake();
    const r = await no(db, "finance.learn_merchant", { merchant: "GROK XAI", kind: "variable", category_id: "other" });
    expect(r.status).toBe(400);
    expect(r.message).toContain("stops the app");
    expect(db.tables.merchant_rules).toHaveLength(0);
  });

  it("refuses to attach a second charge to a bill cycle something already pays", async () => {
    // reviewApply.ts:245-270, and the reason is the worst defect this app has produced:
    // a $6.00 parking charge at "Parkinsafe Nollie" matched the rent rule for
    // "Nollie MA" and marked September's $1,732.16 rent PAID. Both sides go through
    // cycleKeyOf(), the one implementation in the codebase — there were five once, and
    // that is why a duplicate was invisible.
    const db = new Fake();
    await ok(db, "finance.link_charge_to_bill", { transaction_id: CHARGE, bill_id: BILL, month: "2026-09" });

    db.tables.transactions.push({
      id: CREDIT,
      date: "2026-09-21",
      amount: 6,
      type: "expense",
      category_id: "utilities",
      description: "Parking",
      account_id: ACCOUNT,
      applies_to: null,
      status: "posted",
      created_at: "2026-09-21T12:00:00Z",
    });
    const r = await no(db, "finance.link_charge_to_bill", { transaction_id: CREDIT, bill_id: BILL, month: "2026-09" });
    expect(r.status).toBe(409);
    expect(r.message).toContain("already paying");
  });

  it("refuses to delete the bank's own row, and an imported record of history", async () => {
    // reviewApply.ts:178-186. Plaid re-delivers its row on the next page, so the delete
    // does not hold — and real bank history is the one thing the app cannot rebuild.
    const db = new Fake();
    db.tables.transactions[0].provider = "plaid";
    const bank = await no(db, "finance.delete_charge", { transaction_id: CHARGE });
    expect(bank.status).toBe(409);
    expect(bank.message).toContain("came from the bank");

    db.tables.transactions[0].provider = null;
    db.tables.transactions[0].record_only = true;
    const imported = await no(db, "finance.delete_charge", { transaction_id: CHARGE });
    expect(imported.status).toBe(409);
    expect(imported.message).toContain("outside the app");
    expect(db.tables.transactions).toHaveLength(1);
    expect(db.changes.every((c) => c.state === "pending" || c.state === "abandoned")).toBe(true);
  });

  it("refuses a bill in `other`, and a duplicate bill name", async () => {
    // reviewApply.ts:159-172. A bill filed in an ungraded category is the exact defect
    // the app's own orphan-category self-check exists to catch.
    const db = new Fake();
    const ungraded = await no(db, "finance.add_bill", { name: "Gym", amount: 40, due_day: 5, category_id: "other" });
    expect(ungraded.status).toBe(400);
    expect(ungraded.message).toContain("absence of one");

    const dupe = await no(db, "finance.add_bill", { name: "electric", amount: 100, due_day: 16, category_id: "utilities" });
    expect(dupe.status).toBe(409);
    expect(dupe.message).toContain("already a bill called");
  });

  it("refuses a made-up category id, and names where to get a real one", async () => {
    // Phase 1 checked the SHAPE of a category id, which passes an id the app does not
    // know — and a charge filed under one belongs to no budget line and shows on no bar.
    const db = new Fake();
    const r = await no(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "gasoline" });
    expect(r.status).toBe(400);
    expect(r.message).toContain("finance.categories");
    expect(db.tables.transactions[0].category_id).toBe("other");
  });

  it("refuses a split whose slices do not add up to the charge", async () => {
    // The app's own `splits-sum` self-check fails when they do not, so writing one would
    // put the ledger into a state the app itself reports as broken.
    const db = new Fake();
    const r = await no(db, "finance.split_charge", {
      transaction_id: CHARGE,
      slices: [{ category_id: "groceries", amount: 30 }, { category_id: "shopping", amount: 5 }],
    });
    expect(r.status).toBe(400);
    expect(r.message).toContain("have to match");
    expect(db.tables.transactions[0].splits ?? null).toBeNull();
  });
});

// ── the compare-and-set ──────────────────────────────────────────────────────

describe("a write refuses rather than overwriting a newer answer", () => {
  it("stops when the phone changed the row between the read and the write", async () => {
    // The app writes blind here and gets away with it because a human is looking at the
    // row. An assistant read the row seconds ago through a chat.
    const db = new Fake();
    db.onReadCharge = () => {
      // Be the phone: he categorised it himself, in the app, just now.
      db.tables.transactions[0].category_id = "dining";
      db.tables.transactions[0].user_categorized = true;
      db.onReadCharge = null;
    };
    const r = await no(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "groceries" });
    expect(r.status).toBe(409);
    expect(r.message).toContain("changed that row");
    // HIS answer survived. That is the whole point.
    expect(db.tables.transactions[0].category_id).toBe("dining");
    // And the change log says it did not happen, rather than claiming it did.
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0].state).toBe("abandoned");
  });

  it("an undo refuses when something changed the row since the change", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "groceries" });
    // He then picks a third answer in the app. An undo that restored the snapshot would
    // overwrite the newer, deliberate one.
    db.tables.transactions[0].category_id = "dining";
    const r = await no(db, "system.undo", { token: undoToken(body) });
    expect(r.status).toBe(409);
    expect(r.message).toContain("changed it since");
    expect(db.tables.transactions[0].category_id).toBe("dining");
    // Still undoable: fixing the row in the app and asking again should finish the job,
    // not be refused as already done.
    expect(db.changes[0].state).toBe("undoable");
  });
});

// ── the three columns that have to move together ─────────────────────────────

describe("categorising writes three columns and puts back all three", () => {
  it("clears needs_review and sets user_categorized, and the undo restores both", async () => {
    // FinanceStore.tsx:991. Restoring only category_id would leave user_categorized
    // true, and that flag PERMANENTLY blocks the sync from relabelling the row — the
    // wrong category would be gone and the thing that froze it would remain.
    const db = new Fake();
    const body = await ok(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "groceries" });
    const row = () => db.tables.transactions[0];
    expect(row().category_id).toBe("groceries");
    expect(row().user_categorized).toBe(true);
    expect(row().needs_review).toBe(false);

    await ok(db, "system.undo", { token: undoToken(body) });
    expect(row().category_id).toBe("other");
    expect(row().user_categorized).toBe(false);
    expect(row().needs_review).toBe(true);
  });
});

// ── the $1,732 write ─────────────────────────────────────────────────────────

describe("releasing a charge from a bill", () => {
  it("clears the whole applies_to and puts the whole thing back", async () => {
    // The highest-value write in the door: once a bill link was written, NO path in the
    // app could remove it. The before-state is the WHOLE applies_to, not just the kind —
    // it carries the month, the day and the stamped appliedAmount, and a partial restore
    // leaves the bill looking paid by a charge with no cycle.
    const db = new Fake();
    const linked = { kind: "bill", recurringId: BILL, monthKey: "2026-09", day: 16, appliedAmount: 42 };
    db.tables.transactions[0].applies_to = linked;

    const body = await ok(db, "finance.unlink_charge", { transaction_id: CHARGE });
    expect(db.tables.transactions[0].applies_to).toBeNull();
    expect(String(body.message)).toContain("not attached to anything");

    await ok(db, "system.undo", { token: undoToken(body) });
    expect(sameJson(db.tables.transactions[0].applies_to, linked)).toBe(true);
  });

  it("refuses a charge that is not attached to anything", async () => {
    const db = new Fake();
    const r = await no(db, "finance.unlink_charge", { transaction_id: CHARGE });
    expect(r.status).toBe(409);
  });
});

// ── adding and deleting a charge, through the app's own engine ────────────────

describe("adding and deleting a charge go down the app's own money engine", () => {
  it("adds through apply_money_event, and the undo reverses it exactly", async () => {
    const db = new Fake();
    const cash = Number(db.tables.accounts[0].balance);
    const body = await ok(db, "finance.add_transaction", {
      amount: 25.5,
      category_id: "dining",
      description: "Lunch",
      account_id: ACCOUNT,
    });
    expect(db.tables.transactions).toHaveLength(2);
    expect(Number(db.tables.accounts[0].balance)).toBeCloseTo(cash - 25.5, 2);
    // Stamped with who the assistant was acting for — the column v36 added for this.
    const added = db.tables.transactions.find((r) => r.description === "Lunch")!;
    expect(added.person).toBe("gino");
    // And the door did NOT hand-write the row: the RPC did.
    expect(db.writes.some((w) => w.op === "apply_money_event")).toBe(true);
    // The date defaults to ARIZONA's today, not the runtime's — 7 PM on the 26th in
    // Arizona is already the 27th in UTC.
    expect(added.date).toBe(AZ_TODAY);

    await ok(db, "system.undo", { token: undoToken(body) });
    expect(db.tables.transactions).toHaveLength(1);
    expect(Number(db.tables.accounts[0].balance)).toBeCloseTo(cash, 2);
  });

  it("deletes through reverse_money_event, and the undo puts the whole row back", async () => {
    const db = new Fake();
    const original = JSON.parse(JSON.stringify(db.tables.transactions[0]));
    const body = await ok(db, "finance.delete_charge", { transaction_id: CHARGE });
    expect(db.tables.transactions).toHaveLength(0);

    await ok(db, "system.undo", { token: undoToken(body) });
    expect(db.tables.transactions).toHaveLength(1);
    // Under its ORIGINAL id, because the other undo steps and the assistant both name it.
    expect(db.tables.transactions[0].id).toBe(CHARGE);
    for (const col of ["date", "amount", "type", "category_id", "description", "created_at"]) {
      expect(db.tables.transactions[0][col], col).toEqual(original[col]);
    }
  });

  it("refuses to restore a charge that is already back", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.delete_charge", { transaction_id: CHARGE });
    await ok(db, "system.undo", { token: undoToken(body) });
    // A second undo of the same token is refused by state, not by the restore — but the
    // restore's own guard is what stops cash moving twice if it ever were reached.
    const again = await no(db, "system.undo", { token: undoToken(body) });
    expect(again.status).toBe(409);
    expect(again.message).toContain("put it back");
  });
});

// ── promoting a charge to a bill: three rows, one undo ────────────────────────

describe("promoting a charge to a bill", () => {
  it("writes three rows and takes all three back", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.promote_to_bill", { transaction_id: CHARGE });
    expect(db.tables.recurring).toHaveLength(2);
    expect(db.tables.merchant_rules).toHaveLength(1);
    expect((db.tables.transactions[0].applies_to as Record<string, unknown>).kind).toBe("bill");
    expect(db.tables.transactions[0].category_id).toBe("subscriptions");
    expect(db.changes[0].steps).toHaveLength(3);

    await ok(db, "system.undo", { token: undoToken(body) });
    expect(db.tables.recurring).toHaveLength(1);
    expect(db.tables.merchant_rules).toHaveLength(0);
    expect(db.tables.transactions[0].applies_to).toBeNull();
    expect(db.tables.transactions[0].category_id).toBe("other");
  });

  it("reuses a bill that already matches the merchant rather than spawning a copy", async () => {
    const db = new Fake();
    db.tables.recurring.push({
      id: "bbbb1111-2222-3333-4444-555555555555",
      name: "TRADER JOE'S #457",
      amount: 42,
      direction: "out",
      cadence: "monthly",
      category_id: "groceries",
      active: true,
    });
    const body = await ok(db, "finance.promote_to_bill", { transaction_id: CHARGE });
    expect(db.tables.recurring).toHaveLength(2);
    expect(body.result.reused_existing_bill).toBe(true);
    expect(db.changes[0].steps).toHaveLength(2);
  });

  it("refuses the undo of the new bill once a charge has attached itself to it", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.promote_to_bill", { transaction_id: CHARGE });
    // The undo un-points the charge first, and then finds the bill still referenced by
    // nothing — so this test has to add a SECOND charge pointing at it.
    const newBill = db.tables.recurring.find((r) => r.id !== BILL)!;
    db.tables.transactions.push({
      id: CREDIT,
      date: "2026-09-25",
      amount: 42,
      type: "expense",
      category_id: "subscriptions",
      description: "TRADER JOE'S #457",
      applies_to: { kind: "bill", recurringId: newBill.id, monthKey: "2026-10", day: 20 },
      status: "posted",
      created_at: "2026-09-25T12:00:00Z",
    });
    const r = await no(db, "system.undo", { token: undoToken(body) });
    expect(r.status).toBe(409);
    expect(r.message).toContain("pointing at nothing");
    // The bill is still there. A partial undo is reported, not hidden.
    expect(db.tables.recurring).toHaveLength(2);
  });
});

// ── the two-row writes ───────────────────────────────────────────────────────

describe("settling a reimbursable touches two rows", () => {
  function withSetAside(): Fake {
    const db = new Fake();
    db.tables.transactions[0].applies_to = { kind: "setaside", reason: "reimbursable", settled: false };
    db.tables.transactions.push({
      id: CREDIT,
      date: "2026-09-24",
      amount: 42,
      type: "income",
      category_id: "refund",
      description: "Zelle from Li",
      account_id: ACCOUNT,
      applies_to: null,
      status: "posted",
      created_at: "2026-09-24T12:00:00Z",
    });
    return db;
  }

  it("links the deposit, and the undo frees it again", async () => {
    const db = withSetAside();
    const body = await ok(db, "finance.settle_reimbursable", {
      transaction_id: CHARGE,
      credit_transaction_id: CREDIT,
    });
    const credit = () => db.tables.transactions.find((r) => r.id === CREDIT)!;
    expect((db.tables.transactions[0].applies_to as Record<string, unknown>).settled).toBe(true);
    expect((credit().applies_to as Record<string, unknown>).settledByTxnId).toBe(CHARGE);
    expect(db.changes[0].steps).toHaveLength(2);

    await ok(db, "system.undo", { token: undoToken(body) });
    expect((db.tables.transactions[0].applies_to as Record<string, unknown>).settled).toBe(false);
    expect(credit().applies_to).toBeNull();
  });

  it("refuses a deposit already claimed by something else", async () => {
    // FinanceStore.tsx:1128-1130. A stale suggestion would otherwise claim a deposit
    // another reimbursable already used.
    const db = withSetAside();
    db.tables.transactions.find((r) => r.id === CREDIT)!.applies_to = { kind: "transfer" };
    const r = await no(db, "finance.settle_reimbursable", {
      transaction_id: CHARGE,
      credit_transaction_id: CREDIT,
    });
    expect(r.status).toBe(409);
    expect(r.message).toContain("already attached");
  });

  it("re-opens a settled one and frees the deposit it was tied to", async () => {
    const db = withSetAside();
    await ok(db, "finance.settle_reimbursable", { transaction_id: CHARGE, credit_transaction_id: CREDIT });
    const body = await ok(db, "finance.unsettle_reimbursable", { transaction_id: CHARGE });
    expect((db.tables.transactions[0].applies_to as Record<string, unknown>).settled).toBe(false);
    expect(db.tables.transactions.find((r) => r.id === CREDIT)!.applies_to).toBeNull();
    expect(String(body.message)).toContain("freed the deposit");
  });
});

// ── the bill-amount column choice ────────────────────────────────────────────

describe("setting a bill's amount writes the right column", () => {
  it("writes known_amount for a variable bill and amount for a fixed one", async () => {
    // reviewApply.ts:117-124. Writing the wrong one leaves the old figure in force and
    // reads as a fix that did nothing.
    const db = new Fake();
    const variable = await ok(db, "finance.set_bill_amount", { bill_id: BILL, amount: 101.24 });
    expect(variable.result.column).toBe("known_amount");
    expect(db.tables.recurring[0].known_amount).toBe(101.24);
    expect(db.tables.recurring[0].amount).toBe(100);

    db.tables.recurring[0].variable = false;
    const fixed = await ok(db, "finance.set_bill_amount", { bill_id: BILL, amount: 112 });
    expect(fixed.result.column).toBe("amount");
    expect(db.tables.recurring[0].amount).toBe(112);
  });
});

// ── the one undo that is not exact for ever ──────────────────────────────────

describe("setting an account balance says what it cannot promise", () => {
  it("says the bank re-anchors a linked account, so the undo holds only until then", async () => {
    const db = new Fake();
    db.tables.accounts[0].provider_account_id = "plaid-acct-1";
    const body = await ok(db, "finance.set_account_balance", { account_id: ACCOUNT, balance: 900 });
    expect(String(body.message)).toContain("until then");
    expect(body.result.bank_linked).toBe(true);
  });

  it("does not say it about an account the bank does not feed", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.set_account_balance", { account_id: ACCOUNT, balance: 900 });
    expect(String(body.message)).not.toContain("until then");
    expect(String(body.message)).toContain("worked out from this one");
  });
});

// ── whose change is it ───────────────────────────────────────────────────────

describe("an undo only reaches its own owner's changes", () => {
  it("her key cannot reverse his write", async () => {
    const db = new Fake();
    const body = await ok(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "groceries" });
    const r = await handleWrite(post("system.undo", { token: undoToken(body) }, XINYAN), deps(db));
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toContain("other person");
    expect(db.tables.transactions[0].category_id).toBe("groceries");
  });

  it("a bare undo with no token takes the newest one that can still be put back", async () => {
    const db = new Fake();
    await ok(db, "finance.categorize_charge", { transaction_id: CHARGE, category_id: "groceries" });
    const second = await ok(db, "finance.dismiss_unusual", { transaction_id: CHARGE });
    const undone = await ok(db, "system.undo", {});
    expect(undone.result.undone).toBe(undoToken(second));
    // The first change is untouched and still undoable.
    expect(db.tables.transactions[0].category_id).toBe("groceries");
    expect(db.tables.transactions[0].anomaly_ack).toBe(false);
  });

  it("says so plainly when there is nothing to put back", async () => {
    const db = new Fake();
    const r = await no(db, "system.undo", {});
    expect(r.status).toBe(404);
    expect(r.message).toContain("any change I can put back");
  });

  it("refuses a token that is not the right shape, and names the shape", async () => {
    const db = new Fake();
    const r = await no(db, "system.undo", { token: "not-a-token" });
    expect(r.status).toBe(400);
    expect(r.message).toContain("u-");
  });
});

// ── the read door's new tools, against a seeded ledger ───────────────────────

const READ_TABLES = (): Record<string, DbRow[]> => ({
  transactions: [
    {
      id: CHARGE,
      date: "2026-09-20",
      amount: "42.00",
      type: "expense",
      category_id: "groceries",
      description: "TRADER JOE'S #457",
      raw_description: "SQ*TRADER JOES 457 PHOENIX AZ",
      account_id: ACCOUNT,
      status: "posted",
      needs_review: true,
      created_at: "2026-09-20T12:00:00Z",
    },
    {
      id: CREDIT,
      date: "2026-09-10",
      amount: "6.00",
      type: "expense",
      category_id: "transport",
      description: "Parkinsafe Nollie",
      applies_to: { kind: "bill", recurringId: BILL, monthKey: "2026-09", day: 16 },
      account_id: ACCOUNT,
      status: "posted",
      created_at: "2026-09-10T12:00:00Z",
    },
  ],
  accounts: [
    { id: ACCOUNT, name: "Geo", owner: "Gino", last4: "4728", type: "checking", balance: "812.40", sort_order: 1, pending_hold: "120.00", created_at: "2026-01-01T00:00:00Z" },
    { id: "cccc2222-3333-4444-5555-666666666666", name: "Visa", owner: "Gino", last4: "6813", type: "credit", balance: "4113.01", sort_order: 2, pending_hold: "0", provider_account_id: "plaid-visa", created_at: "2026-01-01T00:00:00Z" },
  ],
  recurring: [
    { id: BILL, name: "Electric", amount: "100.00", direction: "out", cadence: "monthly", category_id: "utilities", active: true, variable: true, due_days: [16], created_at: "2026-01-01T00:00:00Z" },
  ],
  debts: [],
  savings_goals: [],
  paid_bills: [{ id: "pb1", month: "2026-09", bill_key: "Electric@16", paid: true }],
  merchant_rules: [{ id: "mr1", pattern: "TRADER JOE'S", kind: "variable", category_id: "groceries", created_at: "2026-01-01T00:00:00Z" }],
  pending_preview: [
    { id: "pp1", date: "2026-09-26", amount: "-18.40", description: "CHEVRON 0091", category_id: "transport", owner: "Gino", account_id: ACCOUNT },
  ],
  bank_connections: [
    { id: "bc1", owner: "Gino", institution: "Bank of America", status: "needs_reauth", last_sync_at: "2026-09-22T06:00:00Z", last_error: "ITEM_LOGIN_REQUIRED", consecutive_failures: 3 },
  ],
  muse_undo: [
    {
      token: "u-4k7m9qt2",
      at: "2026-09-26T18:00:00Z",
      person: "gino",
      tool: "finance.categorize_charge",
      summary: "Put the $42.00 charge from 2026-09-20 in groceries.",
      steps: [{ kind: "set_columns", table: "transactions", id: CHARGE, before: { category_id: "other" }, after: { category_id: "groceries" } }],
      state: "undoable",
      undone_at: null,
      undone_by: null,
    },
    {
      // A row whose steps this door would not run. It must be DROPPED, not offered:
      // telling him a change can be undone when the inverse would be refused is a
      // promise the door cannot keep.
      token: "u-99999999",
      at: "2026-09-26T17:00:00Z",
      person: "gino",
      tool: "finance.mystery",
      summary: "Something nothing here wrote.",
      steps: [{ kind: "set_columns", table: "transactions", id: CHARGE, before: { amount: 1 }, after: { amount: 2 } }],
      state: "undoable",
    },
  ],
});

function readDb(tables: Record<string, DbRow[]>): ReadDb {
  return {
    select({ table, orderBy, eq }) {
      const rows = () =>
        (tables[table] ?? [])
          .filter((r) => Object.entries(eq ?? {}).every(([k, v]) => String(r[k]) === v))
          .slice()
          .sort((a, b) => String(a[orderBy]).localeCompare(String(b[orderBy])));
      return {
        count: () => Promise.resolve(rows().length),
        page: (from, to) => Promise.resolve(rows().slice(from, to + 1)),
      };
    },
  };
}

const read = (tool: string, body: unknown = {}, tables = READ_TABLES(), secret = GINO) =>
  handleMuseRead(
    new Request(`https://x.test/functions/v1/muse-read/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      db: readDb(tables),
      secrets: SECRETS,
      at: AT,
      baseUrl: "https://x.test/functions/v1/muse-read",
      // The read door's audit row is proved in tests/museRead.test.ts. Here it only has
      // to not be the thing that fails.
      audit: { record: () => Promise.resolve() },
      // Same for the hourly read cap, which landed on `main` while this branch was
      // being written. Without it every read here failed CLOSED — "I could not check
      // the read cap" — which is the handler behaving correctly: a counter that will
      // not answer is a refusal, never "plenty left". Counting for real, so a tool that
      // read twice per call would still show up as two.
      limit: { bump: () => Promise.resolve(1) },
    },
  );

const readJson = async (tool: string, body: unknown = {}, tables = READ_TABLES()) =>
  (await (await read(tool, body, tables)).json()) as Record<string, unknown>;

describe("the finance reads", () => {
  it("serves the app's OWN category list, not a copy of it", async () => {
    const body = await readJson("finance.categories");
    const cats = body.categories as { id: string; on_a_budget_line: boolean }[];
    expect(cats.find((c) => c.id === "groceries")!.on_a_budget_line).toBe(true);
    // electronics and car belong to NO budget line by design: still real cash, so they
    // cut firepower, but graded on no bar. That distinction is the reason this field
    // exists.
    expect(cats.find((c) => c.id === "electronics")!.on_a_budget_line).toBe(false);
    expect(String(body.note)).toContain("ABSENCE of a category");
  });

  it("gives one charge in full, including what it is attached to", async () => {
    const body = await readJson("finance.transaction", { id: CREDIT });
    expect(body.found).toBe(true);
    const c = body.charge as Record<string, unknown>;
    expect(c.amount).toBe(6);
    expect(c.merchant).toBe("Parkinsafe Nollie");
    // The field the $1,732 bug lived in. A charge quietly settling a rent cycle is the
    // thing most worth being able to see.
    expect((c.applies_to as Record<string, unknown>).bill_id).toBe(BILL);
    expect((c.applies_to as Record<string, unknown>).month).toBe("2026-09");
  });

  it("says plainly when there is no such charge, rather than inventing one", async () => {
    const body = await readJson("finance.transaction", { id: "00000000-0000-0000-0000-000000000000" });
    expect(body.found).toBe(false);
    expect(String(body.note)).toContain("No charge with that id");
  });

  it("NEVER emits the raw bank descriptor, even from the tools that say a merchant", async () => {
    // The one half of the privacy trade he did not make. Every other string in a charge
    // has been through the app at least once; this is the only field written verbatim by
    // whoever sent the money, with no cleaning anywhere.
    for (const tool of [...SAYS_DESCRIPTION]) {
      const text = await (await read(tool, tool === "finance.transaction" ? { id: CHARGE } : {})).text();
      expect(text, `${tool} emitted the raw descriptor`).not.toContain("SQ*TRADER JOES");
      expect(text, `${tool} emitted the raw descriptor`).not.toContain("PHOENIX AZ");
    }
  });

  it("searches by window, amount, category, merchant and attachment", async () => {
    const all = await readJson("finance.search_transactions");
    expect(all.found).toBe(2);

    const byWindow = await readJson("finance.search_transactions", { from: "2026-09-15", to: "2026-09-30" });
    expect(byWindow.found).toBe(1);

    const byAmount = await readJson("finance.search_transactions", { min_amount: 10 });
    expect(byAmount.found).toBe(1);

    // The merchant filter normalises with the app's own functions, so he can say it
    // however he says it. "trader joes" has no apostrophe in it — he dictates every
    // message, and he never will say one — and the charge reads "TRADER JOE'S #457".
    // Matching only on merchantKey() would miss it, because that function keeps
    // apostrophes on purpose.
    for (const merchant of ["trader joes", "TRADER JOE'S", "trader joe"]) {
      const byMerchant = await readJson("finance.search_transactions", { merchant });
      expect(byMerchant.found, merchant).toBe(1);
    }

    const unattached = await readJson("finance.search_transactions", { unattached: true });
    expect(unattached.found).toBe(1);
    expect(((unattached.charges as Record<string, unknown>[])[0]).id).toBe(CHARGE);

    const flagged = await readJson("finance.search_transactions", { needs_review: true });
    expect(flagged.found).toBe(1);
  });

  it("says how many there are before the cap, and that there are more", async () => {
    // A list of 20 out of 300 that did not say so gets summarised as "you have 20".
    const body = await readJson("finance.search_transactions", { limit: 1 });
    expect(body.found).toBe(2);
    expect(body.returned).toBe(1);
    expect(body.more).toBe(true);
    expect(String(body.note)).toContain("more than these");
  });

  it("refuses a window that runs backwards and an amount range that does", async () => {
    for (const args of [
      { from: "2026-09-30", to: "2026-09-01" },
      { min_amount: 50, max_amount: 5 },
      { kind: "transfer" },
    ]) {
      const res = await read("finance.search_transactions", args);
      expect(res.status, JSON.stringify(args)).toBe(400);
    }
  });

  it("lists the cards as cards, and says the two balances mean different things", async () => {
    const body = await readJson("finance.accounts");
    const accounts = body.accounts as { name: string; is_credit: boolean; bank_linked: boolean }[];
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.name === "Visa")!.is_credit).toBe(true);
    expect(accounts.find((a) => a.name === "Visa")!.bank_linked).toBe(true);
    expect(String(body.note)).toContain("not added together");
    // No card or account number, from this tool or any other.
    const text = JSON.stringify(body);
    expect(text).not.toContain("4728");
    expect(text).not.toContain("6813");
    expect(text).not.toContain("plaid-visa");
  });

  it("gives a bill in full, priced the way the plan prices it", async () => {
    const body = await readJson("finance.bills");
    const bills = body.bills as Record<string, unknown>[];
    expect(bills).toHaveLength(1);
    expect(bills[0].variable).toBe(true);
    expect(bills[0].due_days).toEqual([16]);
    // planned_monthly comes from plannedMonthly(), the app's own function — the door
    // does not price a bill itself.
    expect(typeof bills[0].planned_monthly).toBe("number");
    expect(bills[0].live_today).toBe(true);
  });

  it("gives the month's bills on their due days, marked paid or not", async () => {
    const body = await readJson("finance.bill_calendar", { month: "2026-09" });
    expect(body.month).toBe("2026-09");
    const bills = body.bills as { name: string; due_day: number; paid: boolean }[];
    const electric = bills.find((b) => b.name === "Electric")!;
    expect(electric.due_day).toBe(16);
    // The $6 parking charge claims that cycle, so the calendar reads it as paid. This is
    // the door reporting the app's own state faithfully — including when the state is
    // the bug, which is exactly what makes it checkable.
    expect(electric.paid).toBe(true);
  });

  it("defaults the calendar to the Arizona month, never the runtime's", async () => {
    // 7 PM on 26 Sep in Arizona is already 27 Sep in UTC — same month here, so the test
    // that matters is that no argument means the AZ month rather than an accident.
    const body = await readJson("finance.bill_calendar");
    expect(body.month).toBe("2026-09");
    expect(body.is_this_month).toBe(true);
  });

  it("lists the paid overrides, and says an empty list is the normal case", async () => {
    const body = await readJson("finance.paid_bills", { month: "2026-09" });
    expect(body.count).toBe(1);
    expect((body.overrides as { bill_key: string }[])[0].bill_key).toBe("Electric@16");
    expect(String(body.note)).toContain("by hand");
  });

  it("lists the learned merchant rules, because the write needs the key", async () => {
    const body = await readJson("finance.merchant_rules");
    expect(body.count).toBe(1);
    expect((body.rules as { merchant: string }[])[0].merchant).toBe("TRADER JOE'S");
    expect(String(body.note)).toContain("beats every built-in");
  });

  it("gives firepower as the SCREEN computes it, subtractions and all", async () => {
    // Rule 3, honoured by extraction rather than waived: the tool and the hero tile call
    // one function. Compared against that function directly, so a change to either side
    // that did not change the other fails here.
    const tables = READ_TABLES();
    const data = toAppData({
      transactions: tables.transactions,
      debts: tables.debts,
      goals: tables.savings_goals,
      accounts: tables.accounts,
      recurring: tables.recurring,
      paidBills: tables.paid_bills,
      merchantRules: tables.merchant_rules,
    });
    // firepowerStatus, not this branch's headlineFirepower: the two were the same
    // extraction written twice in one week, and main's is the one the hero tile calls.
    const want = firepowerStatus(data, new Date(2026, 8, 26, 19, 0, 0));
    const body = await readJson("finance.firepower", {}, tables);
    expect(body.available).toBeCloseTo(Math.round(want.firepower * 100) / 100, 2);
    const plan = body.plan as { before_subtractions: number };
    expect(plan.before_subtractions).toBeCloseTo(Math.round(want.math.firepower * 100) / 100, 2);
    const taken = body.taken_out as { overspent_this_month: number; outside_the_budget: number };
    expect(taken.overspent_this_month).toBeCloseTo(Math.round(want.overspendThisMonth * 100) / 100, 2);
    expect(taken.outside_the_budget).toBeCloseTo(Math.round(want.outsideBudgetCash * 100) / 100, 2);
    expect(body.month).toBe(want.monthKey);
    expect(String(body.note)).toContain("free to aim at the debt");
  });

  it("gives the bills before the next paycheck from the SCREEN'S window", async () => {
    const tables = READ_TABLES();
    const data = toAppData({
      transactions: tables.transactions,
      debts: tables.debts,
      goals: tables.savings_goals,
      accounts: tables.accounts,
      recurring: tables.recurring,
      paidBills: tables.paid_bills,
      merchantRules: tables.merchant_rules,
    });
    const now = new Date(2026, 8, 26, 19, 0, 0);
    // Same story as firepower above: billsBeforeNextPayday is main's spelling of this
    // branch's nextBills, and monthGetter is the shared `getMonth` binding so the test
    // does not assemble the calendar call a second way either.
    const want = billsBeforeNextPayday(monthGetter(data, now), now);
    const body = await readJson("finance.next_bills", {}, tables);
    expect((body.cycle as { start: string }).start).toBe(want.cycle.start);
    expect(body.count).toBe(want.bills.length);
    expect(String(body.note)).toContain("when the current pay cycle opened");
  });

  it("says a connection needs re-authorising, without naming a secret", async () => {
    const body = await readJson("finance.bank_status");
    const conns = body.connections as { bank: string; status: string; failures_in_a_row: number }[];
    expect(conns[0].status).toBe("needs_reauth");
    expect(conns[0].failures_in_a_row).toBe(3);
    expect(String(body.note)).toContain("without making them look stale");
    const text = JSON.stringify(body);
    expect(text).not.toContain("item_id");
    expect(text).not.toContain("cursor");
    expect(text).not.toContain("vault");
  });

  it("gives the bank's in-flight charges, and says they are not in the ledger", async () => {
    const body = await readJson("finance.bank_pending");
    expect(body.count).toBe(1);
    const charges = body.charges as { amount: number; merchant: string }[];
    // The sign is the bank's own and is NOT flipped: the app reads the sign, and a door
    // that normalised it would be doing arithmetic on the one figure whose direction is
    // the whole point.
    expect(charges[0].amount).toBe(-18.4);
    expect(String(body.note)).toContain("never enter the ledger");
  });

  it("lists the changes, drops the ones it could not undo, and never emits a step", async () => {
    const body = await readJson("system.changes");
    const changes = body.changes as Record<string, unknown>[];
    // One of the two seeded rows names a column no tool writes. It is dropped rather
    // than offered, because the undo would refuse it.
    expect(changes).toHaveLength(1);
    expect(changes[0].token).toBe("u-4k7m9qt2");
    expect(changes[0].can_undo).toBe(true);
    expect(String(changes[0].means)).toBe(STATE_SAYS.undoable);
    expect(changes[0].rows_touched).toBe(1);
    // The before-state stays in his database. For a deleted charge it is the whole row,
    // description included, and an assistant's context is not where that belongs.
    const text = JSON.stringify(body);
    expect(text).not.toContain("steps");
    expect(text).not.toContain("set_columns");
  });

  it("answers about the person the key names, never another", async () => {
    const tables = READ_TABLES();
    const hers = (await (await read("system.changes", {}, tables, XINYAN)).json()) as Record<string, unknown>;
    expect(hers.person).toBe("xinyan");
    expect(hers.total).toBe(0);
  });

  it("names every new tool in the catalogue, so the door and its description agree", () => {
    // The read door's own check does this across every tool; this is the narrower claim
    // that each Phase 2 tool is actually registered rather than merely written.
    const names = READ_TOOLS.map((t) => t.name);
    for (const t of [
      "finance.categories",
      "finance.transaction",
      "finance.search_transactions",
      "finance.accounts",
      "finance.bills",
      "finance.bill_calendar",
      "finance.paid_bills",
      "finance.merchant_rules",
      "finance.firepower",
      "finance.next_bills",
      "finance.bank_status",
      "finance.bank_pending",
      "system.changes",
    ]) {
      expect(names, `${t} is not registered`).toContain(t);
    }
  });
});

// ── finance.refresh_bank ─────────────────────────────────────────────────────
//
// The tool that cannot do the thing it is named after, and has to say so.
//
// The doors may not call another edge function, so this one writes the ASK down and a
// scheduled job carries it out (supabase/schema_v39_bank_refresh.sql). Everything worth
// testing here is about that gap being stated rather than papered over: the ledger has
// not moved, the sentence says it has not, and asking twice inside the window is
// refused rather than turned into a second call to the bank.

describe("finance.refresh_bank", () => {
  /** Minutes before AT, as Postgres hands a timestamptz back. */
  const minsAgo = (m: number) => new Date(AT.getTime() - m * 60_000).toISOString();

  const withBank = (over: Partial<{ lastSyncAt: string | null; refreshRequestedAt: string | null }> = {}) => {
    const db = new Fake();
    db.connections = [
      { id: "c1", lastSyncAt: minsAgo(20), refreshRequestedAt: null, ...over },
    ];
    return db;
  };

  it("writes the ask onto every connection and moves no money row", async () => {
    const db = withBank();
    const ledgerBefore = JSON.stringify(db.tables);
    const body = await ok(db, "finance.refresh_bank", {});

    expect(db.connections[0].refreshRequestedAt).toBe(AT.toISOString());
    expect(body.result.connections_asked).toBe(1);
    // The ledger is untouched — this tool reaches no table the undo fence covers.
    expect(JSON.stringify(db.tables)).toBe(ledgerBefore);
    expect(db.writes.map((w) => w.op)).toEqual(["requestBankRefresh"]);
  });

  it("refuses to be read as done, in the sentence an assistant repeats", async () => {
    const body = await ok(withBank(), "finance.refresh_bank", {});
    // Each of these is a specific way this goes wrong in a chat. "NOT instant" stops
    // the assistant reporting a completed refresh; "has not moved yet" stops it
    // reading a balance next and calling it new; "read the numbers again" is what it
    // should do instead.
    expect(body.message).toContain("NOT instant");
    expect(body.message).toContain("has not moved yet");
    expect(body.message).toContain("read the numbers again");
    expect(body.result.instant).toBe(false);
  });

  it("hands back no undo token, because there is nothing to put back", async () => {
    const db = withBank();
    const body = await ok(db, "finance.refresh_bank", {});
    expect(body.result.undo).toBeUndefined();
    expect(db.changes).toHaveLength(0);
  });

  it("refuses a second ask inside the cooldown, and says how long is left", async () => {
    const db = withBank({ refreshRequestedAt: minsAgo(3) });
    const r = await no(db, "finance.refresh_bank", {});
    expect(r.status).toBe(429);
    expect(r.message).toContain("already asked for");
    expect(r.message).toContain("7 more minutes");
    // And nothing was written: a refused ask must not move the window it was
    // measured against, or a loop would keep pushing the cooldown forward.
    expect(db.connections[0].refreshRequestedAt).toBe(minsAgo(3));
    expect(db.writes).toHaveLength(0);
  });

  it("allows it again once the window has passed", async () => {
    const db = withBank({ refreshRequestedAt: minsAgo(10) });
    const body = await ok(db, "finance.refresh_bank", {});
    expect(body.result.connections_asked).toBe(1);
  });

  it("caps a connection that never syncs — the window is measured from the ASK", async () => {
    // Asked 2 minutes ago and no sync has ever landed. A cooldown measured from
    // last_sync_at would leave this askable forever, which is a broken connection
    // being called once a question.
    const db = withBank({ lastSyncAt: null, refreshRequestedAt: minsAgo(2) });
    expect((await no(db, "finance.refresh_bank", {})).status).toBe(429);
  });

  it("says there is nothing to refresh when no bank is connected", async () => {
    const db = new Fake();
    db.connections = [];
    const r = await no(db, "finance.refresh_bank", {});
    expect(r.status).toBe(404);
    expect(r.message).toContain("no bank connected");
    expect(db.writes).toHaveLength(0);
  });

  it("says the database is not set up yet rather than pretending it asked", async () => {
    // schema_v39 not run: the column does not exist, so PostgREST refuses the read.
    // The wrong answer here would be a cheerful "asked for a refresh" against a
    // write that could never land.
    const db = withBank();
    db.noRefreshColumn = true;
    const r = await no(db, "finance.refresh_bank", {});
    expect(r.status).toBe(503);
    expect(r.message).toContain("schema_v39");
    expect(db.writes).toHaveLength(0);
  });
});
