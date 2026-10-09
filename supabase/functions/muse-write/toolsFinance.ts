// Phase 2's finance writes: everything the app can change about the money side, and
// every one of them reversible.
//
// WHAT CHANGED, AND WHY IT IS NOT A LOOSENING
//
// Phase 1 asked "is this write safe to do unattended?" and split the tools two ways
// on the answer: three landed, four only ASKED — writing a row into muse_pending to
// wait for a tap. Two things made that split wrong rather than cautious:
//
//   1. NOTHING READS THE QUEUE. `grep -rn "muse_pending" src/` returns nothing, so a
//      queued write sat there until cron-reminders marked it expired 24 hours later.
//      The four careful tools were the four that did nothing at all.
//   2. HOMEBASE NEVER MOVES MONEY. It records, categorises and computes. The worst a
//      wrong write can do is make DATA wrong — and data can be put back, as long as
//      what it replaced was written down first.
//
// So the tap moved from "before the change" to "after it, if he wants it back". Every
// tool below records its before-state and returns a token, and `system.undo` reverses
// it. The queue is gone from the finance side.
//
// THE FENCE THAT MAKES THAT TRUE: the door can only write a column it can also put
// back. The three shaped writes in dbFinance.ts take a table and columns from the
// SAME allowlist the undo core validates against, so a tool that wanted to change
// `transactions.amount` would not get past it. Adding a column to that list is the
// moment to ask whether the change is reversible, which is where the question
// belongs.
//
// STILL NOT HERE, AND NOT BECAUSE IT IS SWITCHED OFF
//   · Disconnecting a bank. It hard-deletes the accounts and their whole
//     transaction history (the `disconnect` action reached by an anonymous caller in
//     the audit _shared/callerAuth.ts records), and no undo can put real bank
//     history back. That takes a code he types.
//   · Deleting a bank-fed charge. Plaid re-delivers it on the next page, so the
//     delete does not hold — and real history is the one thing the app cannot
//     rebuild. Refused by name, the same refusal src/views/redesign/reviewApply.ts
//     makes at tap time.
//   · Deleting a bill. The app never deletes one either — it turns it off
//     (reviewApply.ts's §D.3: "Never a delete"), because a deleted bill leaves every
//     charge that paid it pointing at nothing.
//
// THE GUARDS THE APP LEARNED THE HARD WAY ARE RE-STATED HERE, not imported, because
// they live inside src/store/FinanceStore.tsx — a React file a Deno function cannot
// reach. Each one is marked PORTED with the line it came from, and the door's copy is
// the one under test. There are four:
//   · no non-bill merchant rule for a merchant that IS a bill  (FinanceStore 803-813)
//   · never learn "other"/Misc as a merchant rule              (FinanceStore 819-826)
//   · one payment per bill cycle, via cycleKeyOf               (reviewApply 245-270)
//   · never delete the bank's own row, or an imported record   (reviewApply 178-186)
// A fifth, added 2026-10-09, is NOT re-stated, because it was written to be shared:
// never learn the bank's own wording ("CHECKCARD", "ZELLE TRANSFER") as a merchant.
// That one is isStatementNoiseKey in categorize.ts, and the app imports the same one.
//
// AND THE THING THIS FILE STILL DOES NOT DO: ARITHMETIC. Adding a charge goes down
// the app's own apply_money_event, which clamps the debt paydown and stamps the
// applied amount inside one transaction. Deleting one goes down reverse_money_event.
// Putting a deleted one back goes down restore_money_event. Not one dollar figure
// below is derived.

import type { Ctx, Refusal, Tool, ToolOutcome } from "./tools.ts";
import { UNDO_REGISTRY } from "./undoRegistry.ts";
// A type-only import above, and this one from _shared: tools.ts imports THIS file's
// registry as a value, so anything imported back out of it would close a runtime cycle.
import { UUID } from "../_shared/muse/args.ts";
import { StatementRefused, type BillRow, type ChargeRow, type FinanceDb } from "./dbFinance.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
// The cooldown, and the sentences that explain it, shared with the read door's
// freshness stamp so "too soon" has one definition rather than two.
import { REFRESH_TICK_MIN, refreshDecision } from "../_shared/muse/freshness.ts";
import { scrub, scrubCap, scrubOr } from "../_shared/muse/scrub.ts";
import { isStatementNoiseKey, merchantKey } from "../_shared/muse/lib/categorize.ts";
import { cycleKeyOf } from "../_shared/muse/lib/selfAudit.ts";
import { DUE_DAYS } from "../_shared/muse/lib/schedule.ts";
import { DEFAULT_CATEGORIES } from "../_shared/muse/lib/seed.ts";
import {
  applyUndo,
  checkSteps,
  mintToken,
  STATE_SAYS,
  undoSummary,
  UndoRefused,
  type UndoApplier,
  type UndoStep,
  type UndoTable,
  type UndoValue,
} from "../_shared/muse/undo.ts";

// ── small shared checks ──────────────────────────────────────────────────────

const refuse = (status: number, say: string): Refusal => ({ ok: false, status, say });


/**
 * A category id, checked against the APP'S OWN LIST and not against a shape.
 *
 * Phase 1 checked the shape (`/^[a-z][a-z0-9-]{1,40}$/`) with a comment saying the
 * app's list was deliberately not copied into the door. The reasoning about copies
 * was right; the consequence was not. The list lives in code only — src/lib/seed.ts
 * DEFAULT_CATEGORIES, with no table anywhere — and the read door did not serve it, so
 * the argument could only ever be guessed, and a guess that passes a shape check
 * writes a category the app does not know: the charge then belongs to no budget line,
 * on no bar, and the app's own orphan-category self-check starts failing.
 *
 * It is still not a copy. It is the app's own constant, imported through the
 * generated file the build checks byte for byte. `finance.categories` on the read
 * door serves the same constant, so the assistant can look the id up rather than
 * inventing one.
 */
const CATEGORY_IDS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));

function categoryArg(v: unknown): string | Refusal {
  if (typeof v !== "string" || !CATEGORY_IDS.has(v)) {
    return refuse(400, "That is not one of the app's categories. Ask finance.categories for the list.");
  }
  return v;
}

function idArg(v: unknown, what: string): string | Refusal {
  if (typeof v !== "string" || !UUID.test(v)) {
    return refuse(400, `I need ${what}'s id, which the read door gives you.`);
  }
  return v;
}

function isRefusal(v: unknown): v is Refusal {
  return typeof v === "object" && v !== null && (v as Refusal).ok === false;
}

/** A finite number, and not a numeric string — a string that looks like a number is a
 *  sign the caller guessed at the shape. */
function money(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The date this write is for, defaulting to Arizona's today — never the runtime's,
 *  which from 5 PM onward is already tomorrow. Copied in shape from tools.ts's own
 *  dateFor; kept here so the finance tools can have their own back-window. */
function dateFor(payload: Record<string, unknown>, ctx: Ctx, backDays: number): { date: string } | Refusal {
  const today = azDateISO(ctx.az);
  if (payload.date === undefined) return { date: today };
  if (!isDateISO(payload.date)) {
    return refuse(400, "I need the date as YYYY-MM-DD, or leave it out and I will use today.");
  }
  const delta = daysBetweenISO(payload.date as string, today);
  if (delta < 0) return refuse(400, `${payload.date} has not happened yet in Arizona. Today is ${today}.`);
  if (delta > backDays) {
    return refuse(
      400,
      `${payload.date} is more than ${backDays} days back. Add that one in the app so you can see what is already there.`,
    );
  }
  return { date: payload.date as string };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── the commit, which is the whole of the undo contract ──────────────────────

/** What undoing a finance change does, said the same way for every one of them. The
 *  specific sentence — what was changed — is the summary he was just told; this is the
 *  other half, and its condition is the real one: every step is a compare-and-set, so
 *  the undo refuses rather than overwriting something changed since. */
const RECORDED_SAYS = "put this back the way it was, unless something has changed it since";

/**
 * Record the inverse, make the change, say what happened.
 *
 * THE ORDER IS THE DESIGN, and it is the same order v36 argues for on muse_audit's
 * claim row. The undo row is written FIRST, as `pending`, because a row that only
 * appeared afterwards would leave a change nobody can account for if the door died
 * between the write and the log. Then:
 *
 *   every write lands  → `undoable`, and he gets the token
 *   a write reports "moved" (the row changed since it was read) → `abandoned`,
 *                        and NOTHING was written
 *   a write THROWS, and the door can show nothing landed → `abandoned` too, and the
 *                        error goes on to handler.ts, which answers 500 and keeps the
 *                        reason in the audit row
 *   a write THROWS any other way → the row stays `pending`, error rethrown the same
 *   the door dies      → the row stays `pending`, and system.changes says plainly
 *                        that it cannot prove what happened
 *
 * THE THROWN CASE WAS MISSING UNTIL 2026-10-09, and it is not hypothetical. Two
 * finance.settle_reimbursable calls on 2026-09-27 failed on `invalid input syntax for
 * type json` (the compare-and-set handing Postgres "[object Object]" — expectParts.ts
 * has that story). The exception went straight past the state change below, so both
 * change rows stayed `pending`, and system.changes still reads them out as "I started
 * this and could not confirm it finished" — about two writes the database refused
 * outright. Those two old rows are left exactly as they are: this changes what the door
 * writes from now on, not the history.
 *
 * "CAN SHOW NOTHING LANDED" IS THREE THINGS, ALL REQUIRED. The first version of this fix
 * (same day) marked the row `abandoned` on ANY throw, and review caught what that says:
 * "this did not go through, there is nothing for me to put back" — and a throw does not
 * prove that. So, together:
 *
 *   1. The error is a StatementRefused: Postgres answered with a code that proves the
 *      statement rolled back (dbFinance.ts). A failed fetch is NOT one — PostgREST may
 *      have committed and the answer been lost on the way back.
 *   2. No row was INSERTED before this was called. An insert has to land before commit()
 *      runs (see below — there is no row to delete until it exists), and its inverse is
 *      the step that says so: `delete_row`, or `reverse_money_event` for a cash charge.
 *      promote_to_bill is the case: it inserts the bill and the merchant rule, then its
 *      write() sets transactions.applies_to — the very column the json bug was on. Had
 *      that failed, `abandoned` would have said nothing landed while a new bill and a new
 *      rule were live, and the delete_row steps that remove them would be unreachable.
 *   3. No earlier statement inside write() changed a row. settle_reimbursable writes the
 *      charge and then the deposit; a refusal on the deposit leaves the charge written.
 *      db.writesLanded() is read before write() and again at the throw.
 *
 * Anything short of all three leaves `pending`, which is the true state: something may
 * be in, and system.changes tells him to check the app rather than guessing either way.
 *
 * The middle case is why every write in this file is a compare-and-set. The app
 * writes blind and gets away with it because a human is looking at the row; an
 * assistant read the row seconds ago through a chat, and the phone may have written
 * in between. Refusing costs a retry. Overwriting costs the newer, deliberate answer.
 *
 * THE ONE CASE THIS ORDER DOES NOT COVER, said out loud because it is real. A tool whose
 * change is an INSERT has to do the insert before it calls this at all — the undo step is
 * "delete row X" and there is no X until the row exists. Six tools are like that
 * (add_transaction, mark_bill_paid, set_paid_override, add_bill, learn_merchant's new-rule
 * path, add_debt, and promote_to_bill's new bill). For those, an insert that lands and a
 * `recordChange` that then fails leaves a row nothing can put back.
 *
 * It is accepted rather than engineered around, for two reasons. The realistic failure is
 * Postgres being unreachable, and the insert one round trip earlier would have failed the
 * same way. And handler.ts already answers that case honestly: the call comes back 500
 * with "Something went wrong on my side and I stopped. Nothing was retried. Check the
 * app." The alternative — insert, fail to log, then delete what was just inserted — is
 * more moving parts in the path that is already failing.
 *
 * `write` may make more than one change, and is called AFTER the undo row exists so that
 * every column write in it is covered.
 */
async function commit(
  ctx: Ctx,
  tool: string,
  plan: {
    /** The inverse, in the order the changes are made. system.undo runs it backwards. */
    steps: UndoStep[];
    /** One plain sentence, in the past tense, said to him and stored in the log. */
    summary: string;
    /**
     * A warning about the state the change leaves behind, said right after the summary
     * and NOT stored in the log. Added 2026-10-09 for learn_merchant's "this rule
     * matches no charge yet": that is true at the moment of saying it and stops being
     * true the day a matching charge arrives, so it belongs in the reply and not in
     * the permanent record of what changed. Must already be scrubbed.
     */
    note?: string;
    /** Anything else worth putting in the structured reply. */
    result?: Record<string, unknown>;
    /** The rows this touched, for muse_audit's row_ids column. */
    rowIds?: string[];
    /** Make the change. Returns a refusal, or nothing. */
    write: () => Promise<Refusal | void>;
  },
): Promise<ToolOutcome> {
  const db = ctx.db as FinanceDb;
  let steps: UndoStep[];
  try {
    // Checked on the way OUT as well as on the way in. A tool that built a step
    // naming a column the allowlist does not carry is a bug in this file, and it is
    // worth catching here — before anything is written — rather than the day somebody
    // tries to undo it.
    steps = checkSteps(plan.steps);
  } catch (e) {
    if (e instanceof UndoRefused) {
      console.error("muse-write: refused to build an undo for", tool, e.say);
      return refuse(500, "I could not work out how to undo that, so I did not do it.");
    }
    throw e;
  }

  const summary = undoSummary(plan.summary);
  const token = mintToken((into) => crypto.getRandomValues(into));
  await db.recordChange({ token, person: ctx.person, tool, summary, steps });

  // Point 2 above: an insert-first tool has already changed the ledger by now.
  const insertedFirst = steps.some((s) => s.kind === "delete_row" || s.kind === "reverse_money_event");
  // Point 3: read again at a throw. Anything that moved it changed a row.
  const landedBefore = db.writesLanded();

  let refusal: Refusal | void;
  try {
    refusal = await plan.write();
  } catch (e) {
    // Closed off only when nothing can have landed, then rethrown either way. The
    // rethrow is what keeps handler.ts's 500 and the statement-level reason in the audit
    // row — which is how the json bug was found. If closing the row fails too, the
    // original error is the one worth reporting, so that second failure is logged and
    // swallowed; the row then stays `pending`, which is still a true thing to say.
    const nothingLanded =
      e instanceof StatementRefused && !insertedFirst && db.writesLanded() === landedBefore;
    if (nothingLanded) {
      try {
        await db.setChangeState(token, "abandoned", {});
      } catch (stateErr) {
        console.error("muse-write: could not close the change row for", tool, String((stateErr as Error)?.message ?? stateErr));
      }
    } else {
      console.error("muse-write: left the change row pending — part of", tool, "may have landed");
    }
    throw e;
  }
  if (refusal) {
    await db.setChangeState(token, "abandoned", {});
    return refusal;
  }
  await db.setChangeState(token, "undoable", {});

  return {
    ok: true,
    result: { ...(plan.result ?? {}), undo: token, what_changed: summary },
    rowIds: plan.rowIds ?? [],
    // The token in the sentence, not only in the JSON: the sentence is what an
    // assistant repeats, and "say undo and I will put it back" is useless if the
    // handle is only in a field it decided not to read.
    say: `${summary}${plan.note ? ` ${plan.note}` : ""} Say "undo ${token}" and I will put it back.`,
    // AND IN THE ENVELOPE. FOUND 2026-10-09: finance.set_bill_amount handed back a
    // token in result.undo, naming a real undoable row, while the envelope beside it
    // said `undo: null` and "Nothing was written down that could put this back."
    // handler.ts only knew about a record IT would write, and this row is already
    // written. `recorded` is how a tool says "the change is in muse_undo under this
    // token" — see kit.ts.
    recorded: { token, says: RECORDED_SAYS },
  };
}

/** The sentence for a write whose row moved between the read and the write. Said the
 *  same way everywhere, because it is the same event. */
const MOVED = "Something changed that row while I was working on it, so I stopped and changed nothing. Read it again and ask me once more.";

// ── finance.add_transaction ──────────────────────────────────────────────────
//
// WAS QUEUED, NOW DIRECT. Its inverse is the app's own reverse_money_event, which
// uses the `appliedAmount` that apply_money_event stamped on the row — so undoing a
// payment that cleared a debt adds back exactly what came off, not the face value.
// That is the most exact inverse in the whole door, and it is exact because the door
// did not write it.
const addTransaction: Tool = {
  kind: "direct",
  does: "Add a cash charge the bank will never see.",
  fields: ["date", "amount", "category_id", "description", "account_id", "kind"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const when = dateFor(payload, ctx, 60);
    if ("ok" in when) return when;
    const amount = money(payload.amount);
    if (amount === null || amount <= 0 || amount > 100_000) {
      return refuse(400, "I need the amount as a number above zero.");
    }
    const category = categoryArg(payload.category_id);
    if (isRefusal(category)) return category;
    const kind = payload.kind === undefined ? "expense" : payload.kind;
    if (kind !== "expense" && kind !== "income") return refuse(400, "kind is expense or income.");
    const description = scrubCap(payload.description, 40);
    if (!description) return refuse(400, "Tell me what the charge was for, in a few words.");

    let accountId: string | null = null;
    if (payload.account_id !== undefined) {
      const id = idArg(payload.account_id, "the account");
      if (isRefusal(id)) return id;
      const acct = await db.readAccount(id);
      if (!acct) return refuse(404, "There is no account with that id.");
      accountId = acct.id;
    }

    // `applies_to` is not a field this tool takes, and that has not changed. A charge
    // that can point at a bill can settle a bill cycle on the way in, which is how a
    // $6 parking charge marked a $1,732 rent paid. Attaching one is its own tool with
    // its own collision guard (finance.link_charge_to_bill).
    const id = await db.applyMoneyEvent({
      date: when.date,
      amount,
      type: kind,
      categoryId: category,
      description,
      accountId,
      person: ctx.person,
    });

    return commit(ctx, "finance.add_transaction", {
      steps: [{ kind: "reverse_money_event", id }],
      summary: `Added a ${dollars(amount)} ${kind === "income" ? "deposit" : "charge"} on ${when.date} in ${category}: ${description}.`,
      result: { id, date: when.date, amount, category_id: category, kind },
      rowIds: [id],
      // The write already happened above, because apply_money_event has to run before
      // there is an id to undo. Nothing here can fail, so there is no refusal.
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.delete_charge ────────────────────────────────────────────────────
const deleteCharge: Tool = {
  kind: "direct",
  does: "Remove a hand-entered charge, and put its cash, debt and goal back the way they were.",
  fields: ["transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id. It may have been deleted already.");

    // PORTED from src/views/redesign/reviewApply.ts:178-186. The bank re-delivers its
    // own rows on the next page, so the delete does not hold — and real bank history
    // is the one thing in this whole app that cannot be rebuilt.
    if (t.provider) {
      return refuse(409, "That one came from the bank, so it stays. Bank history is the one thing I cannot rebuild.");
    }
    if (t.recordOnly) {
      return refuse(
        409,
        "That one records money that moved outside the app, so it stays — its cash is already inside the balance the bank anchored.",
      );
    }

    // The whole row, captured BEFORE the delete, is the undo. Every column
    // restore_money_event needs to redo the fan-out exactly.
    const row: Record<string, UndoValue> = {
      id: t.id,
      date: t.date,
      amount: t.amount,
      type: t.type,
      category_id: t.categoryId,
      description: t.description,
      account_id: t.accountId,
      applies_to: t.appliesTo,
      // Restored with the row. Without it, undoing a delete brings the charge back
      // classified the way the app works it out — quietly discarding the answer
      // somebody had already overruled by hand.
      flow_override: t.flowOverride,
      splits: t.splits,
      anomaly_ack: t.anomalyAck,
      user_categorized: t.userCategorized,
      needs_review: t.needsReview,
      record_only: t.recordOnly,
      created_at: t.createdAt,
      person: t.person,
    };

    return commit(ctx, "finance.delete_charge", {
      steps: [{ kind: "restore_money_event", row }],
      summary: `Removed the ${dollars(t.amount)} charge from ${t.date} in ${t.categoryId}.`,
      result: { id: t.id, date: t.date, amount: t.amount },
      rowIds: [t.id],
      async write() {
        if ((await db.reverseMoneyEvent(t.id)) === "moved") {
          return refuse(409, "That charge is not there any more, so there was nothing to remove.");
        }
      },
    });
  },
};

// ── the one-row column writes ────────────────────────────────────────────────
//
// Eleven of the tools below are the same three lines with different columns: read the
// row, work out the before and the after, write it if it has not moved. So they share
// one helper, and what is left in each tool is the part that is actually its own —
// the guard, and the sentence.
//
// `extra` is for the writes that touch a SECOND row (settling a reimbursable links
// two charges; promoting a charge to a bill touches three rows). Those pass their own
// steps and do their own writes, in the order the undo will reverse.
async function oneRow(
  ctx: Ctx,
  tool: string,
  target: { table: UndoTable; id: string },
  patch: Record<string, UndoValue>,
  before: Record<string, UndoValue>,
  summary: string,
  result?: Record<string, unknown>,
  note?: string,
): Promise<ToolOutcome> {
  const db = ctx.db as FinanceDb;
  return commit(ctx, tool, {
    steps: [{ kind: "set_columns", table: target.table, id: target.id, before, after: patch }],
    summary,
    note,
    result: { ...(result ?? {}), id: target.id },
    rowIds: [target.id],
    async write() {
      if ((await db.setColumns(target.table, target.id, patch, before)) === "moved") {
        return refuse(409, MOVED);
      }
    },
  });
}

// ── finance.categorize_charge ────────────────────────────────────────────────
//
// WAS QUEUED, NOW DIRECT. Three columns, not one, and the undo has to restore all
// three — which is the reason this tool is worth reading twice. The app writes
// `category_id` AND `user_categorized` AND `needs_review` together
// (FinanceStore.tsx:991), because `user_categorized` means "a human chose this, never
// re-guess it" and `needs_review` means "the app could not tell — answer this" and
// the answer has just been given. An undo that restored only `category_id` would
// leave `user_categorized = true` behind, and that flag PERMANENTLY blocks the sync
// from ever relabelling the row. The wrong category would be gone and the thing that
// froze it would remain.
const categorizeCharge: Tool = {
  kind: "direct",
  does: "Put one charge in a category.",
  fields: ["transaction_id", "category_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const category = categoryArg(payload.category_id);
    if (isRefusal(category)) return category;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id. It may have been deleted since you read it.");
    if (t.splits) {
      return refuse(
        409,
        "That charge is split across categories. Changing its one category would contradict the slices — clear the split first, or change a slice in the app.",
      );
    }

    return oneRow(
      ctx,
      "finance.categorize_charge",
      { table: "transactions", id: t.id },
      { category_id: category, user_categorized: true, needs_review: false },
      { category_id: t.categoryId, user_categorized: t.userCategorized, needs_review: t.needsReview },
      `Put the ${dollars(t.amount)} charge from ${t.date} in ${category}.`,
      { was: t.categoryId, now: category },
    );
  },
};

// ── finance.split_charge ─────────────────────────────────────────────────────
const MAX_SLICES = 8;

const splitCharge: Tool = {
  kind: "direct",
  does: "Allocate one charge across several categories. The cash does not move.",
  fields: ["transaction_id", "slices"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");

    const raw = payload.slices;
    if (!Array.isArray(raw) || raw.length === 0) {
      return refuse(400, "I need at least one slice, each with a category and an amount.");
    }
    if (raw.length > MAX_SLICES) return refuse(400, `That is more than ${MAX_SLICES} slices.`);
    const slices: { categoryId: string; amount: number }[] = [];
    for (const s of raw) {
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        return refuse(400, "Each slice is an object with category_id and amount.");
      }
      const row = s as Record<string, unknown>;
      const cat = categoryArg(row.category_id);
      if (isRefusal(cat)) return cat;
      const amt = money(row.amount);
      if (amt === null || amt <= 0) return refuse(400, `The ${cat} slice needs an amount above zero.`);
      slices.push({ categoryId: cat, amount: amt });
    }

    // THE SLICES MUST ADD UP TO THE CHARGE, and this is the door's own check rather
    // than arithmetic it is doing on his behalf: the app's `splits-sum` self-check
    // fails when they do not, so writing a split that does not add up would put the
    // ledger into a state the app itself reports as broken. Compared in cents,
    // because a sum of two-decimal numbers is not exactly a two-decimal number.
    const cents = (n: number) => Math.round(n * 100);
    const sum = slices.reduce((a, s) => a + cents(s.amount), 0);
    if (sum !== cents(t.amount)) {
      return refuse(
        400,
        `Those slices add up to ${dollars(sum / 100)} and the charge is ${dollars(t.amount)}. They have to match, or the app's own check starts failing.`,
      );
    }

    // A one-slice split is just a charge with one category — the app collapses it the
    // same way (FinanceStore.tsx:1018), and the primary category follows the LARGEST
    // slice so the row's colour and icon stay sensible.
    const useSplits = slices.length > 1 ? slices : null;
    const primary = useSplits
      ? [...useSplits].sort((a, b) => b.amount - a.amount)[0].categoryId
      : slices[0].categoryId;

    const patch: Record<string, UndoValue> = {
      splits: useSplits ? useSplits.map((s) => ({ categoryId: s.categoryId, amount: s.amount })) : null,
      user_categorized: true,
      needs_review: false,
      category_id: primary,
    };
    return oneRow(
      ctx,
      "finance.split_charge",
      { table: "transactions", id: t.id },
      patch,
      {
        splits: t.splits,
        user_categorized: t.userCategorized,
        needs_review: t.needsReview,
        category_id: t.categoryId,
      },
      useSplits
        ? `Split the ${dollars(t.amount)} charge from ${t.date} across ${useSplits.length} categories.`
        : `Put the ${dollars(t.amount)} charge from ${t.date} in ${primary}, in one piece.`,
      { slices: slices.length, primary_category: primary },
    );
  },
};

// ── finance.unlink_charge ────────────────────────────────────────────────────
//
// THE HIGHEST-VALUE WRITE IN THIS FILE, and the reason is in the repo's own history.
// Once a bill link was written, NO path in the app could remove it: re-categorising
// leaves it alone deliberately, and the importer's upsert does
// `applies_to = coalesce(existing, excluded)`, which by design never overwrites one.
// So a single bad match was permanent — a $6.00 parking charge at "Parkinsafe Nollie"
// matched the rent rule for "Nollie MA" and marked September's $1,732.16 rent PAID,
// and the app read September $1,726 lighter than it was in the month the cash was
// tightest. `unlinkFromBill` was added to the store for exactly that
// (FinanceStore.tsx:1040). This is that, from a chat.
const unlinkCharge: Tool = {
  kind: "direct",
  does: "Release a charge that was wrongly attached to a bill.",
  fields: ["transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (!t.appliesTo) return refuse(409, "That charge is not attached to anything.");

    // The WHOLE applies_to is the before-state, not just the kind. It carries the
    // month, the day and the stamped appliedAmount, and putting back a partial copy
    // would leave the bill looking paid by a charge with no cycle.
    return oneRow(
      ctx,
      "finance.unlink_charge",
      { table: "transactions", id: t.id },
      { applies_to: null },
      { applies_to: t.appliesTo },
      `Released the ${dollars(t.amount)} charge from ${t.date} — it is not attached to anything now.`,
    );
  },
};

// ── finance.link_charge_to_bill ──────────────────────────────────────────────
//
// The most dangerous write here, because it SETTLES A BILL CYCLE: the calendar will
// read that bill as paid for that month. So it carries the app's own collision guard,
// ported verbatim.
const linkChargeToBill: Tool = {
  kind: "direct",
  does: "Attach a charge to a bill, which records that bill as paid for that month.",
  fields: ["transaction_id", "bill_id", "month"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const txnId = idArg(payload.transaction_id, "the charge");
    if (isRefusal(txnId)) return txnId;
    const billId = idArg(payload.bill_id, "the bill");
    if (isRefusal(billId)) return billId;
    const [t, bill] = await Promise.all([db.readCharge(txnId), db.readBill(billId)]);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (!bill) return refuse(404, "There is no bill with that id.");

    if (t.appliesTo) return refuse(409, "That charge is already attached to something.");
    // PORTED from reviewApply.ts:213-215. A pending charge can be attached once it
    // posts; attaching it now would settle a cycle with a charge the bank may still
    // withdraw.
    if (t.pending) {
      return refuse(409, "That charge is still processing. It can be attached once it posts.");
    }
    if (bill.direction !== "out") return refuse(409, "That row is not a bill going out.");

    // The month comes from the CALLER or from the charge's own date, and never from a
    // grace-window derivation. reviewApply.ts records why: billCycleFor()'s seven-day
    // grace maps a charge paid early into the FOLLOWING month, so a [1]-due bill paid
    // on the 24th would be written to a different cycle than the one anybody was
    // looking at. The day comes off the bill's own due days, which is where the
    // calendar reads it.
    const month = payload.month === undefined ? t.date.slice(0, 7) : payload.month;
    if (typeof month !== "string" || !MONTH.test(month)) {
      return refuse(400, "The month goes in as 2026-09, or leave it out and I will use the charge's own month.");
    }
    const dueDays = bill.dueDays?.length ? bill.dueDays : DUE_DAYS[bill.name];
    const day = dueDays?.length ? dueDays[0] : Number(t.date.slice(8, 10)) || 1;

    // PORTED from reviewApply.ts:245-270 — guard 3. The feed may have linked this
    // cycle since the charge was read, so the CURRENT rows decide. Both sides go
    // through cycleKeyOf(), the one implementation in the codebase: there were five
    // spellings of this once, and that is the reason a duplicate payment was
    // invisible.
    const applies = { kind: "bill", recurringId: bill.id, monthKey: month, day };
    const wanted = cycleKeyOf(applies, dueDays);
    const payments = await db.billPayments(bill.id);
    const taken = payments.some((p) => {
      if (p.id === t.id) return false;
      if (p.type !== "expense") return false;
      const at = p.appliesTo as { kind?: string; recurringId?: string } | null;
      if (!at || at.kind !== "bill" || at.recurringId !== bill.id) return false;
      return cycleKeyOf(at, dueDays) === wanted;
    });
    if (taken) {
      return refuse(409, `Something else is already paying ${scrubCap(bill.name, 40)} for ${month}.`);
    }

    return oneRow(
      ctx,
      "finance.link_charge_to_bill",
      { table: "transactions", id: t.id },
      { applies_to: applies },
      { applies_to: null },
      `Attached the ${dollars(t.amount)} charge from ${t.date} to ${scrubCap(bill.name, 40)} for ${month}, which records that bill as paid.`,
      { bill_id: bill.id, month, day },
    );
  },
};

// ── finance.mark_bill_paid ───────────────────────────────────────────────────
//
// A RECONCILIATION MARKER, and the distinction is the whole tool: it inserts a
// `settled` row that records paid-state and moves NO cash, because the payment is
// already inside the balance the bank anchored (FinanceStore.tsx:727). Its inverse is
// a plain delete of the row it inserted — reverse_money_event would short-circuit on
// the settled flag and delete it too, but a delete is the honest spelling of "take
// back the row I added".
const markBillPaid: Tool = {
  kind: "direct",
  does: "Record a bill as already paid, without moving any cash.",
  fields: ["bill_id", "amount", "month"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const billId = idArg(payload.bill_id, "the bill");
    if (isRefusal(billId)) return billId;
    const bill = await db.readBill(billId);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.direction !== "out") return refuse(409, "That row is not a bill going out.");
    const amount = money(payload.amount);
    if (amount === null || amount <= 0 || amount > 100_000) {
      return refuse(400, "I need what was paid, as a number above zero.");
    }
    const month = payload.month === undefined ? azDateISO(ctx.az).slice(0, 7) : payload.month;
    if (typeof month !== "string" || !MONTH.test(month)) {
      return refuse(400, "The month goes in as 2026-09, or leave it out and I will use this month.");
    }
    const dueDays = bill.dueDays?.length ? bill.dueDays : DUE_DAYS[bill.name];
    const day = dueDays?.length ? dueDays[0] : 1;

    // The same cycle guard as linking, for the same reason: two settled markers on
    // one cycle is the app's own `one-payment-per-cycle` check failing.
    const applies = { kind: "bill", recurringId: bill.id, monthKey: month, day, settled: true };
    const wanted = cycleKeyOf(applies, dueDays);
    const payments = await db.billPayments(bill.id);
    if (
      payments.some((p) => {
        const at = p.appliesTo as { kind?: string; recurringId?: string } | null;
        if (p.type !== "expense" || !at || at.kind !== "bill" || at.recurringId !== bill.id) return false;
        return cycleKeyOf(at, dueDays) === wanted;
      })
    ) {
      return refuse(409, `${scrubCap(bill.name, 40)} is already recorded as paid for ${month}.`);
    }

    const name = scrubCap(bill.name, 40) || "a bill";
    const row: Record<string, UndoValue> = {
      date: azDateISO(ctx.az),
      amount,
      type: "expense",
      category_id: bill.categoryId ?? "other",
      // The app's own suffix, so the row reads the same in the ledger whether the
      // app or the door wrote it.
      description: `${name} (already paid)`,
      account_id: null,
      applies_to: applies,
      person: ctx.person,
    };

    const id = await db.insertRow("transactions", row);
    return commit(ctx, "finance.mark_bill_paid", {
      steps: [{ kind: "delete_row", table: "transactions", id, after: { applies_to: applies } }],
      summary: `Recorded ${name} as already paid for ${month}, ${dollars(amount)}. No cash moved.`,
      result: { id, bill_id: bill.id, month, amount },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.set_paid_override ────────────────────────────────────────────────
//
// The hand-set paid/unpaid flag, upserted on (month, bill_key) exactly as the app
// does (FinanceStore.tsx:1469). The interesting half is the undo: the row may not
// have existed, and "put it back" then means REMOVE it, not "set it to false".
// Setting it to false would be a new override saying the opposite, which is a
// different state from having no opinion at all.
const setPaidOverride: Tool = {
  kind: "direct",
  does: "Set or clear the hand-made paid/unpaid mark on one bill in one month.",
  fields: ["month", "bill_key", "paid"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const month = payload.month;
    if (typeof month !== "string" || !MONTH.test(month)) return refuse(400, "The month goes in as 2026-09.");
    const key = scrubCap(payload.bill_key, 80);
    if (!key) return refuse(400, "I need the bill key, which finance.paid_bills gives you.");
    if (typeof payload.paid !== "boolean") return refuse(400, "paid is either true or false.");
    const paid = payload.paid;

    const existing = await db.readPaidOverride(month, key);
    if (existing && existing.paid === paid) {
      return refuse(409, `That is already how ${key} is marked for ${month}.`);
    }

    const said = `Marked ${key} as ${paid ? "paid" : "not paid"} for ${month}.`;
    if (existing) {
      return oneRow(
        ctx,
        "finance.set_paid_override",
        { table: "paid_bills", id: existing.id },
        { paid },
        { paid: existing.paid },
        said,
        { month, bill_key: key, paid },
      );
    }

    const id = await db.insertRow("paid_bills", { month, bill_key: key, paid });
    return commit(ctx, "finance.set_paid_override", {
      steps: [{ kind: "delete_row", table: "paid_bills", id, after: { paid } }],
      summary: said,
      result: { id, month, bill_key: key, paid },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── the three one-boolean writes ─────────────────────────────────────────────

const dismissUnusual: Tool = {
  kind: "direct",
  does: "Dismiss the unusual-purchase flag on one charge.",
  fields: ["transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (t.anomalyAck) return refuse(409, "That flag is already dismissed.");
    return oneRow(
      ctx,
      "finance.dismiss_unusual",
      { table: "transactions", id: t.id },
      { anomaly_ack: true },
      { anomaly_ack: t.anomalyAck },
      `Dismissed the unusual-purchase flag on the ${dollars(t.amount)} charge from ${t.date}.`,
    );
  },
};

const excludeFromBudget: Tool = {
  kind: "direct",
  does: "Take one charge out of the variable budget, without deleting it or moving cash.",
  fields: ["transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (t.appliesTo) return refuse(409, "That charge is already attached to something, so it is already out of the budget.");
    // `{kind:"transfer"}` is the app's own spelling (FinanceStore.tsx:1089): the
    // budget partition gates on `type expense && !appliesTo`, so ANY applies_to takes
    // a row out of the envelope — and transfer is the one that says "this was an
    // internal move" rather than claiming a bill.
    return oneRow(
      ctx,
      "finance.exclude_from_budget",
      { table: "transactions", id: t.id },
      { applies_to: { kind: "transfer" } },
      { applies_to: null },
      `Took the ${dollars(t.amount)} charge from ${t.date} out of the budget. The record and the cash are untouched.`,
    );
  },
};

const setBillVariable: Tool = {
  kind: "direct",
  does: "Mark a bill as varying month to month, or stop marking it that way.",
  fields: ["bill_id", "variable"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    if (typeof payload.variable !== "boolean") return refuse(400, "variable is either true or false.");
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.variable === payload.variable) {
      return refuse(409, `${scrubCap(bill.name, 40)} is already marked that way.`);
    }
    return oneRow(
      ctx,
      "finance.set_bill_variable",
      { table: "recurring", id: bill.id },
      { variable: payload.variable },
      { variable: bill.variable },
      payload.variable
        ? `${scrubCap(bill.name, 40)} now counts as a bill whose amount varies, so the plan prices it from real payments.`
        : `${scrubCap(bill.name, 40)} now counts as a fixed bill, priced at its stored amount.`,
    );
  },
};

// ── finance.set_bill_amount ──────────────────────────────────────────────────
//
// THIS REPLACES PHASE 1'S QUEUED finance.note_known_amount, which asked for what a
// variable bill came to this month. Same write, and the reason for one name is that
// the app has one action for it (reviewApply.ts's `set-bill-amount`) and it decides
// WHICH column from the row rather than from the caller: a variable row's figure
// lives in `known_amount`, a fixed row's price is `amount`. Writing the wrong one
// leaves the old figure in force and reads as a fix that did nothing — which is
// exactly what reviewApply.ts:117-124 records.
const setBillAmount: Tool = {
  kind: "direct",
  does: "Record what a bill actually costs. Goes to the right column for a fixed or a variable bill.",
  fields: ["bill_id", "amount"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    const amount = money(payload.amount);
    if (amount === null || amount <= 0 || amount > 100_000) {
      return refuse(400, "I need the amount off the bill, as a number above zero.");
    }
    const name = scrubCap(bill.name, 40) || "that bill";
    if (bill.variable) {
      if (bill.knownAmount === amount) return refuse(409, `${name} is already recorded at ${dollars(amount)}.`);
      return oneRow(
        ctx,
        "finance.set_bill_amount",
        { table: "recurring", id: bill.id },
        { known_amount: amount },
        { known_amount: bill.knownAmount },
        `${name} is a variable bill, so I recorded ${dollars(amount)} as what it actually is. That beats the rolling average everywhere.`,
        { column: "known_amount", was: bill.knownAmount },
      );
    }
    if (bill.amount === amount) return refuse(409, `${name} is already ${dollars(amount)}.`);
    return oneRow(
      ctx,
      "finance.set_bill_amount",
      { table: "recurring", id: bill.id },
      { amount },
      { amount: bill.amount },
      `${name} is now ${dollars(amount)} a time, ${movedFrom(bill.amount, amount)}.`,
      { column: "amount", was: bill.amount },
    );
  },
};

/**
 * "up from $X", "down from $X", or "the same as before" — which way a figure moved.
 *
 * FOUND 2026-10-09: finance.set_bill_amount lowered a bill and said "up from" the old
 * price. The sentence hardcoded "up from", so every decrease was announced as an
 * increase — and the sentence is the part an assistant reads out, so a bill that had
 * gone DOWN was reported as going up, with the two numbers in the same breath saying
 * otherwise.
 * Compared in cents, like the split check above, because two two-decimal numbers are not
 * exactly two-decimal numbers. That is also why the "same" arm exists: the refusal above
 * compares exactly, so two figures that differ only by float noise get through it, and
 * "down from $0.30" about $0.30 would be the same lie in the other direction.
 */
function movedFrom(was: number, now: number): string {
  const cents = (n: number) => Math.round(n * 100);
  if (cents(now) > cents(was)) return `up from ${dollars(was)}`;
  if (cents(now) < cents(was)) return `down from ${dollars(was)}`;
  return "the same as before";
}

// ── finance.set_flow ─────────────────────────────────────────────────────────
//
// What a row IS, when the app has worked it out wrong.
//
// src/lib/flow.ts classifies every transaction on every read — earned, spent, moved,
// repaid, returned — from the household's own accounts. It is right nearly always and
// it carries its reasoning, so when it is wrong the wrong line is visible. This is how
// that gets corrected, and the correction is the ONLY thing stored: null means the
// derived answer stands.
//
// WHY IT MATTERS MORE THAN A CATEGORY. A category decides which budget line a charge
// lands in. This decides whether it counts AT ALL. Both cards are synced, so a card
// payment appears twice — leaving checking and arriving at the card — and getting that
// wrong inflated one month's income and its spending by $2,500 each.
const setFlow: Tool = {
  kind: "direct",
  does: "Say what a charge really is — spending, money in, a transfer between our own accounts, a debt payment, or money coming back. Overrules what the app worked out.",
  fields: ["transaction_id", "flow"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");

    const raw = payload.flow;
    // "clear" is spelled out rather than accepting null, because an omitted field and
    // a field meaning "undo my correction" must not be the same request.
    const asked = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const ALLOWED = ["earned", "spent", "moved", "repaid", "returned", "clear"];
    if (!ALLOWED.includes(asked)) {
      return refuse(400, `flow is one of: ${ALLOWED.join(", ")}. "clear" puts it back to what the app works out itself.`);
    }
    const next = asked === "clear" ? null : asked;
    if ((t.flowOverride ?? null) === next) {
      return refuse(409, next === null ? "That charge has no correction on it already." : `That charge is already set to ${next}.`);
    }

    const said = scrubCap(t.description, 36) || "that charge";
    const says = next === null
      ? `Cleared the correction on the ${dollars(t.amount)} ${said} from ${t.date}. The app works it out again now.`
      : `Recorded that the ${dollars(t.amount)} ${said} from ${t.date} is ${WHAT_IT_MEANS[next]}.`;
    return oneRow(
      ctx,
      "finance.set_flow",
      { table: "transactions", id: t.id },
      { flow_override: next },
      { flow_override: t.flowOverride ?? null },
      says,
      { column: "flow_override", was: t.flowOverride ?? null },
    );
  },
};

/** Said out loud, because "repaid" is jargon and "a payment towards a debt" is not. */
const WHAT_IT_MEANS: Record<string, string> = {
  earned: "money coming into the house from outside",
  spent: "real spending",
  moved: "a transfer between our own accounts, so it counts as neither",
  repaid: "a payment towards a debt, which moves money rather than spends it",
  returned: "money coming back for something already counted",
};

// ── finance.set_bill_account ─────────────────────────────────────────────────
//
// Which account actually pays this bill.
//
// ALL NINETEEN WERE NULL, and that is not untidiness. "What is due before your next
// check" answered $0 and was right — while the joint account held $703.73 against rent
// of $1,726.88 due in two days. The household was being treated as one wallet because
// the data said nothing about three, and a shortfall in the account rent comes out of
// was invisible in a correct household total.
const setBillAccount: Tool = {
  kind: "direct",
  does: "Say which account a bill is paid from, so what is due can be read per account instead of as one household total.",
  fields: ["bill_id", "account_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");

    const acctId = idArg(payload.account_id, "the account");
    if (isRefusal(acctId)) return acctId;
    const account = await db.readAccount(acctId);
    // Checked against the real list rather than trusted: an id that is not an account
    // would leave the bill pointing at nothing, which is the orphan the app's own
    // links-point-somewhere check exists to catch.
    if (!account) return refuse(404, "There is no account with that id.");

    if ((bill.accountId ?? null) === acctId) {
      return refuse(409, `${scrubCap(bill.name, 36)} is already set to come out of ${scrubCap(account.name, 30)}.`);
    }
    return oneRow(
      ctx,
      "finance.set_bill_account",
      { table: "recurring", id: bill.id },
      { account_id: acctId },
      { account_id: bill.accountId ?? null },
      `${scrubCap(bill.name, 36)} comes out of ${scrubCap(account.owner, 12)}'s ${scrubCap(account.name, 30)}.`,
      { column: "account_id", was: bill.accountId ?? null },
    );
  },
};

// ── finance.set_bill_due_day ─────────────────────────────────────────────────
//
// Which day of the month a bill actually comes out.
//
// FOUND 2026-10-09: NOTHING COULD MOVE ONE. T-Mobile's row says the 29th; the charge
// landed on the 14th in July, August and September. The calendar (schedule.ts) places a
// bill on its due days, and "what is due before the next paycheck" reads the calendar —
// so with the paychecks on the 15th and the 31st, a bill that really leaves on the 14th
// was being counted against the wrong check. The app has no screen that edits due_days
// either; it is written once, when a bill is made. Modelled on set_bill_amount and
// set_bill_account: one row, one column, compare-and-set, and an undo.
//
// ONE DAY ONLY — A BILL WITH SEVERAL DUE DAYS IS REFUSED, AND THAT IS A DECISION. A row
// with two due days is paid in installments: schedule.ts puts `monthly / dueDays.length`
// on each day, and cycleKeyOf() decides WHICH installment a payment settled by finding
// the due day nearest the payment's own day. Mom is [15, 30] — $300 a month as two
// payments of $150. A single `due_day` cannot say which of the two to move; replacing
// both with one would double each calendar entry and fold two installments into one
// cycle, so a month already paid in two parts could read as one cycle paid twice. Moving a
// single-day bill has none of that: with one due day every payment is installment 0
// whatever day it carries, so past payments keep settling exactly the cycles they did.
//
// A biweekly row with an anchor date is refused too, for a different reason: its dates
// come every 14 days from the anchor and its due days are never read, so writing one
// would be a change that changes nothing — the failure set_bill_amount's comment warns
// about, of a fix that reads as done and did nothing.
const setBillDueDay: Tool = {
  kind: "direct",
  does: "Move a bill to the day of the month it actually comes out. Only for a bill that comes out on one day a month.",
  fields: ["bill_id", "due_day"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    const day = payload.due_day;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
      return refuse(400, "The due day is a whole number from 1 to 31.");
    }
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    const name = scrubCap(bill.name, 40) || "That bill";

    if (bill.cadence === "biweekly" && bill.anchorDate) {
      return refuse(
        409,
        `${name} comes every two weeks, counted from its first date, so a day of the month is not what places it. There is nothing for a due day to move.`,
      );
    }

    // The days the calendar uses TODAY: the row's own, or — for a row made before
    // due_days was stored — the app's legacy map, exactly as schedule.ts and
    // link_charge_to_bill read it. Judged on what is in force, not only on the column.
    const stored = bill.dueDays?.length ? bill.dueDays : null;
    const inForce = stored ?? (DUE_DAYS[bill.name]?.length ? DUE_DAYS[bill.name] : null);
    if (inForce && inForce.length > 1) {
      return refuse(
        409,
        `${name} is paid in ${inForce.length} parts, on days ${inForce.join(" and ")}. One day cannot say which part to move, and folding them into one would change which payment counts for which part — so I only move a bill that comes out on one day.`,
      );
    }
    if (stored && stored[0] === day) return refuse(409, `${name} is already due on day ${day}.`);

    const was = inForce ? inForce[0] : null;
    return oneRow(
      ctx,
      "finance.set_bill_due_day",
      { table: "recurring", id: bill.id },
      { due_days: [day] },
      // The STORED value, not the one in force: the compare-and-set and the undo are
      // about the column, and a row that held null must get null back.
      { due_days: bill.dueDays },
      was === null
        ? `${name} is now due on day ${day} of the month. It had no due day before.`
        : was === day
          ? `${name} is now due on day ${day} of the month, stored on the bill itself.`
          : `${name} is now due on day ${day} of the month, moved from day ${was}.`,
      { column: "due_days", was: bill.dueDays, now: [day] },
    );
  },
};

// ── finance.turn_bill_off ────────────────────────────────────────────────────
//
// NEVER A DELETE, and that is not this tool being careful — it is the app's rule
// (reviewApply.ts:128-135, "§D.3 — a bill that looks finished. Never a delete"). A
// deleted bill leaves every charge that ever paid it pointing at nothing, which the
// app's own `links-point-somewhere` self-check then reports for ever.
const turnBillOff: Tool = {
  kind: "direct",
  does: "Turn a bill off, or back on. Never deletes it.",
  fields: ["bill_id", "active"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    const active = payload.active === undefined ? false : payload.active;
    if (typeof active !== "boolean") return refuse(400, "active is either true or false.");
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.active === active) {
      return refuse(409, `${scrubCap(bill.name, 40)} is already ${active ? "on" : "off"}.`);
    }
    return oneRow(
      ctx,
      "finance.turn_bill_off",
      { table: "recurring", id: bill.id },
      { active },
      { active: bill.active },
      active
        ? `Turned ${scrubCap(bill.name, 40)} back on. It will show in the plan and the calendar again.`
        : `Turned ${scrubCap(bill.name, 40)} off. It stays in the app with its history — it just stops being planned for.`,
    );
  },
};

// ── finance.set_bill_window ──────────────────────────────────────────────────
const setBillWindow: Tool = {
  kind: "direct",
  does: "Set the first or last date a bill or an income may fire.",
  fields: ["bill_id", "starts_on", "ends_on"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.bill_id, "the bill");
    if (isRefusal(id)) return id;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");

    // Either side may be set, either side may be cleared with null, and a side left
    // out is left alone. Three different instructions, so they need three different
    // spellings — "absent" cannot mean "clear it", or a caller that sent only an end
    // date would silently wipe the start date.
    const patch: Record<string, UndoValue> = {};
    const before: Record<string, UndoValue> = {};
    for (const [field, column, current] of [
      ["starts_on", "starts_on", bill.startsOn],
      ["ends_on", "ends_on", bill.endsOn],
    ] as const) {
      if (payload[field] === undefined) continue;
      const v = payload[field];
      if (v !== null && !isDateISO(v)) {
        return refuse(400, `${field} has to be a date like 2026-11-01, or null to clear it.`);
      }
      patch[column] = v as UndoValue;
      before[column] = current;
    }
    if (Object.keys(patch).length === 0) {
      return refuse(400, "Tell me a starts_on or an ends_on, or null to clear one.");
    }
    const starts = (patch.starts_on ?? bill.startsOn) as string | null;
    const ends = (patch.ends_on ?? bill.endsOn) as string | null;
    if (starts && ends && starts > ends) {
      return refuse(400, "That window starts after it ends.");
    }

    const name = scrubCap(bill.name, 40) || "that row";
    const parts: string[] = [];
    if ("starts_on" in patch) parts.push(patch.starts_on ? `starts ${String(patch.starts_on)}` : "has no start date");
    if ("ends_on" in patch) parts.push(patch.ends_on ? `ends ${String(patch.ends_on)}` : "has no end date");
    return oneRow(
      ctx,
      "finance.set_bill_window",
      { table: "recurring", id: bill.id },
      patch,
      before,
      `${name} now ${parts.join(" and ")}. Outside that window it is dormant, not deleted.`,
    );
  },
};

// ── finance.add_bill ─────────────────────────────────────────────────────────
const addBill: Tool = {
  kind: "direct",
  does: "Model a repeating charge as a bill.",
  fields: ["name", "amount", "due_day", "cadence", "category_id", "direction"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const name = scrubCap(payload.name, 40);
    if (!name) return refuse(400, "That bill needs a name.");
    const amount = money(payload.amount);
    if (amount === null || amount <= 0 || amount > 100_000) {
      return refuse(400, "That amount does not look right.");
    }
    const dueDay = payload.due_day;
    if (typeof dueDay !== "number" || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      return refuse(400, "The due day is a whole number from 1 to 31.");
    }
    const cadence = payload.cadence === undefined ? "monthly" : payload.cadence;
    const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "semiannual", "yearly"];
    if (typeof cadence !== "string" || !CADENCES.includes(cadence)) {
      return refuse(400, `The cadence is one of: ${CADENCES.join(", ")}.`);
    }
    const direction = payload.direction === undefined ? "out" : payload.direction;
    if (direction !== "out" && direction !== "in") return refuse(400, "direction is out or in.");
    const category = categoryArg(payload.category_id);
    if (isRefusal(category)) return category;
    // PORTED from reviewApply.ts:159-162. A bill row landing in an ungraded category
    // is the exact defect the app's orphan-category self-check exists to catch, and
    // `other` is the ABSENCE of a category rather than a category.
    if (category === "other") {
      return refuse(400, "Give it a real category first. `other` is the absence of one, and a bill filed there is watched by no budget line.");
    }

    // PORTED from reviewApply.ts:167-172. A bill that is already modelled must not be
    // modelled twice — the calendar would show both and the plan would price both.
    const bills = await db.allBillNames();
    const clash = bills.some(
      (b) => b.active && b.direction === direction && b.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (clash) return refuse(409, `There is already a ${direction === "in" ? "income" : "bill"} called ${name}.`);

    const row: Record<string, UndoValue> = {
      name,
      amount,
      direction,
      cadence,
      category_id: category,
      active: true,
      due_days: [dueDay],
    };
    const id = await db.insertRow("recurring", row);
    return commit(ctx, "finance.add_bill", {
      // The undo is a delete, GUARDED: if a charge has attached itself to this bill
      // since (the feed can do that on its own), removing it would leave that charge
      // pointing at nothing. The undo refuses instead.
      steps: [{ kind: "delete_row", table: "recurring", id, after: { active: true }, guard: "no_bill_payments" }],
      summary: `Added ${name} as a ${cadence} ${direction === "in" ? "income" : "bill"} of ${dollars(amount)}, due on day ${dueDay}, in ${category}.`,
      result: { id, name, amount, cadence, due_day: dueDay, category_id: category, direction },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.learn_merchant ───────────────────────────────────────────────────
//
// A LEARNED RULE BEATS EVERY BUILT-IN RULE, so a wrong one re-teaches the feed
// permanently. Both of the app's backstops are ported, and both exist because the
// failure had already happened.
//
// AND A RULE ONLY MATCHES THE WHOLE KEY. FOUND 2026-10-09. A learned rule is an exact
// lookup on merchantKey() of the charge's name (learnedFor in categorize.ts) — not a
// prefix, not a search. On 10-05 this tool was taught "FIRESTONE", replied "Taught the
// app…", and saved a rule that could never fire: the charge it was about reads
// "FIRESTONE COMPLETE AUTO CARE". Eight of the 88 saved rules on 10-09 matched no
// charge in the ledger at all. The matching is
// right and stays as it is — a prefix rule on "FIRE" would be the CHECKCARD problem
// below with a different word. What was wrong was the door saying "taught" about a
// rule it had no way of knowing would match.
//
// So two things changed. The key can come FROM THE CHARGE — `transaction_id` reads the
// charge's own name and derives the key from it with the app's own function, so the
// key is the one the labeller will compute and cannot be mistyped. And every save now
// counts how many charges in the ledger carry exactly that key, says the number, and
// when it is zero says so plainly, with the nearest real keys that start with what was
// typed.
//
// AND A RULE ON THE BANK'S OWN WORDING CAPTURES EVERYTHING. A "CHECKCARD -> dining"
// rule, saved from one tap in the app on 2026-09-24, files every Bank of America card
// line with no clean name as dining. Refused here, in the app, and in promote_to_bill,
// all through one predicate (isStatementNoiseKey in categorize.ts).
const learnMerchant: Tool = {
  kind: "direct",
  does: "Teach the app what a merchant is, so future charges label themselves. Give the charge's transaction_id and the name is read off the charge exactly.",
  fields: ["merchant", "transaction_id", "kind", "category_id", "bill_name"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const typed = payload.merchant === undefined ? "" : scrubCap(payload.merchant, 60);

    // WHERE THE KEY COMES FROM. A charge, when one is named — its `description`, the
    // clean name, never the raw bank line — or else what was typed. Either way it is
    // normalised with the app's own function, so the door's rule lands in the same key
    // space the labeller reads. A rule written under a raw descriptor would simply
    // never match anything.
    let pattern: string;
    let fromCharge = false;
    if (payload.transaction_id !== undefined) {
      const id = idArg(payload.transaction_id, "the charge");
      if (isRefusal(id)) return id;
      const t = await db.readCharge(id);
      if (!t) return refuse(404, "There is no charge with that id.");
      pattern = merchantKey(t.description);
      if (!pattern) return refuse(400, "I cannot work out a merchant from that charge's name.");
      fromCharge = true;
      // Both given and they disagree: the id is probably the wrong charge. "FIRESTONE"
      // against "FIRESTONE COMPLETE AUTO CARE" is the case this exists for and is
      // fine — the charge's whole name wins. "SAFEWAY" against it is not.
      const typedKey = typed ? merchantKey(typed) : "";
      if (typedKey && !pattern.startsWith(typedKey)) {
        return refuse(
          409,
          `That charge reads ${scrubOr(pattern, "as something else", 60)}, not ${typed}. Check the id — or leave merchant out and I will use the charge's own name.`,
        );
      }
    } else {
      if (!typed) {
        return refuse(400, "Tell me the merchant, as it reads on the charge — or give me the charge's transaction_id and I will read the name off it.");
      }
      pattern = merchantKey(typed);
      if (!pattern) return refuse(400, "There was nothing left of that merchant name once it was normalised.");
    }
    // What is said back. From a charge it is the charge's own key, which came out of
    // the database and so goes through the cleaner like every other string out.
    const name = fromCharge ? scrubOr(pattern, "that merchant", 60) : typed;

    if (isStatementNoiseKey(pattern)) {
      return refuse(
        400,
        `${name} is how the bank labels a kind of charge, not a merchant. A rule on it would catch every charge the bank labels that way, whoever was paid, so I will not teach it. Put the charge in a category on its own instead.`,
      );
    }

    const kind = payload.kind;
    if (kind !== "variable" && kind !== "bill" && kind !== "skip") {
      return refuse(400, "kind is variable (ordinary spending), bill (it pays a bill), or skip (drop it from the ledger).");
    }

    let categoryId: string | null = null;
    let billName: string | null = null;
    if (kind === "variable") {
      const cat = categoryArg(payload.category_id);
      if (isRefusal(cat)) return cat;
      // PORTED from FinanceStore.tsx:819-826. `other` is the ABSENCE of a category,
      // so a rule teaching it tells the labeller to stop trying on that merchant for
      // ever, and no later rule can override it. Three had accumulated that way —
      // GOOGLE ONE, GROK XAI and SWA each had a standing instruction to file in Misc,
      // which is the complaint the whole thing was fixed for. Filing ONE charge there
      // is fine and stays; teaching it is not.
      if (cat === "other") {
        return refuse(
          400,
          "I will not teach `other` for a merchant — that stops the app ever trying on it again. Filing one charge there is fine; teaching it is not.",
        );
      }
      categoryId = cat;
    } else if (kind === "bill") {
      billName = scrubCap(payload.bill_name, 40) || null;
      if (!billName) return refuse(400, "For a bill rule I need the name of the bill it pays.");
    }

    // PORTED from FinanceStore.tsx:803-813. Never learn "ordinary spending" or "skip"
    // for a merchant that IS one of the bills: `variable` starts counting a fixed bill
    // against the variable envelope, and `skip` is worse — the feed drops the charge
    // entirely and a real payment never enters the ledger at all.
    if (kind !== "bill") {
      const bills = await db.allBillNames();
      const isBill = bills.some(
        (b) => b.active && b.direction === "out" && merchantKey(b.name) === pattern,
      );
      if (isBill) {
        return refuse(
          409,
          `${name} is one of your bills. Teaching it as ${kind === "skip" ? "something to skip" : "ordinary spending"} would make the app stop treating its payments as bill payments.`,
        );
      }
    }

    const existing = await db.readMerchantRule(pattern);
    if (existing && existing.kind === kind && existing.categoryId === categoryId && existing.billName === billName) {
      return refuse(409, `The app already knows that about ${name}.`);
    }

    // DOES ANY CHARGE CARRY THIS KEY? Read BEFORE anything is written, through the paged
    // read in dbFinanceSupabase.ts, which throws rather than answering from part of the
    // ledger — so a ledger that cannot be read cleanly saves no rule at all, and the
    // handler says something went wrong. The key of every charge is derived with the
    // app's own merchantKey(), the same call learnedFor() makes when it looks a rule up.
    const near = new Map<string, number>();
    let matchesNow = 0;
    for (const chargeName of await db.chargeNames()) {
      const key = merchantKey(chargeName);
      if (key === pattern) matchesNow += 1;
      else if (key.startsWith(pattern)) near.set(key, (near.get(key) ?? 0) + 1);
    }
    // The nearest real keys: the fewest extra characters beyond what was typed, then
    // the most charges. A suggestion is only offered if the cleaner says it back
    // EXACTLY, character for character — "SAMS CLUB.COM" cleans to "SAMS" because
    // ".COM" reads as a link, and a key merchantKey() cut at 28 characters can end in
    // a space the cleaner trims. Either way, typing the suggestion back would teach
    // the next rule that matches nothing. Noise keys are never offered; they would only
    // be refused.
    const closest = [...near.entries()]
      .filter(([key]) => !isStatementNoiseKey(key))
      .sort((a, b) => a[0].length - b[0].length || b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key]) => ({ key, said: scrub(key, 60) }))
      .filter((k): k is { key: string; said: string } => k.said === k.key)
      .slice(0, 3)
      .map((k) => k.said);
    // Through the cleaner as a whole as well as piece by piece, so "which strings out
    // were scrubbed" is never a judgement call made line by line.
    const note = matchesNow > 0
      ? undefined
      : scrubCap(
          `But no charge in the ledger reads exactly ${name} yet, so this rule matches nothing today — a rule only matches the whole name as it reads on the charge.` +
            (closest.length
              ? ` Charges that start with it read: ${closest.join("; ")}. Teach one of those, or give me the charge's transaction_id and I will read its name off it.`
              : " Give me the charge's transaction_id and I will read its name off it."),
          480,
        );

    const said =
      kind === "variable"
        ? `Taught the app that ${name} is ordinary ${categoryId} spending.`
        : kind === "bill"
          ? `Taught the app that ${name} pays ${billName}.`
          : `Taught the app to drop ${name} from the ledger entirely.`;
    // This does NOT relabel existing rows, and neither does the app's own rule — so
    // the undo is complete: putting the rule back the way it was is the whole of it.
    const tail = " It does not change any charge already in the ledger, only the ones that come next.";
    const merchant = scrubOr(pattern, "(a merchant key I cannot say safely)", 60);

    if (existing) {
      return oneRow(
        ctx,
        "finance.learn_merchant",
        // merchant_rules is upserted on `pattern` in the app; here it is an update by
        // id, because the id is what the undo has to name.
        { table: "merchant_rules", id: existing.id },
        { kind, category_id: categoryId, bill_name: billName },
        { kind: existing.kind, category_id: existing.categoryId, bill_name: existing.billName },
        said + tail,
        { merchant, replaced: existing.kind, matches_now: matchesNow, closest },
        note,
      );
    }

    const id = await db.insertRow("merchant_rules", {
      pattern,
      kind,
      category_id: categoryId,
      bill_name: billName,
    });
    return commit(ctx, "finance.learn_merchant", {
      steps: [{ kind: "delete_row", table: "merchant_rules", id, after: { kind } }],
      summary: said + tail,
      note,
      result: { id, merchant, kind, matches_now: matchesNow, closest },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.set_account_balance ──────────────────────────────────────────────
//
// THE ONE UNDO THAT IS NOT EXACT FOR EVER, and the reply says so rather than
// implying otherwise. `accounts.balance` is the bank-truth anchor every other number
// is derived from — safe-to-spend, the per-cycle budget, the bills runway — and a
// Plaid sync SETS it from the bank's own figure. So the undo restores the number this
// door replaced, and holds until the next sync re-anchors it.
const setAccountBalance: Tool = {
  kind: "direct",
  does: "Set an account's balance by hand. This is the number every other figure is derived from.",
  fields: ["account_id", "balance"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.account_id, "the account");
    if (isRefusal(id)) return id;
    const balance = money(payload.balance);
    if (balance === null || balance < -100_000 || balance > 1_000_000) {
      return refuse(400, "I need the balance as a number.");
    }
    const acct = await db.readAccount(id);
    if (!acct) return refuse(404, "There is no account with that id.");
    if (acct.balance === balance) {
      return refuse(409, `${scrubCap(acct.name, 40)} is already ${dollars(balance)}.`);
    }
    const linked = acct.providerAccountId
      ? " That account is bank-linked, so the next sync will set it from the bank's own figure again — this holds until then, and so does the undo."
      : "";
    return oneRow(
      ctx,
      "finance.set_account_balance",
      { table: "accounts", id: acct.id },
      { balance },
      { balance: acct.balance },
      `Set ${scrubCap(acct.name, 40)} to ${dollars(balance)}, from ${dollars(acct.balance)}. Every other figure is worked out from this one.${linked}`,
      { was: acct.balance, now: balance, bank_linked: !!acct.providerAccountId },
    );
  },
};

// ── finance.add_debt ─────────────────────────────────────────────────────────
const addDebt: Tool = {
  kind: "direct",
  does: "Add a debt to track.",
  fields: ["name", "balance", "apr", "min_payment"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const name = scrubCap(payload.name, 40);
    if (!name) return refuse(400, "That debt needs a name.");
    const balance = money(payload.balance);
    if (balance === null || balance < 0 || balance > 1_000_000) {
      return refuse(400, "I need what is owed, as a number of zero or more.");
    }
    let apr: number | null = null;
    if (payload.apr !== undefined && payload.apr !== null) {
      apr = money(payload.apr);
      if (apr === null || apr < 0 || apr > 100) return refuse(400, "The APR is a percentage between 0 and 100.");
    }
    let minPayment: number | null = null;
    if (payload.min_payment !== undefined && payload.min_payment !== null) {
      minPayment = money(payload.min_payment);
      if (minPayment === null || minPayment < 0 || minPayment > 100_000) {
        return refuse(400, "The minimum payment is a number of zero or more.");
      }
    }

    const id = await db.insertRow("debts", {
      name,
      balance,
      // original_balance is what the app writes on a new debt: today's balance is the
      // starting point, and payoff progress is measured from it.
      original_balance: balance,
      apr,
      min_payment: minPayment,
      color: "#ef4444",
    });
    return commit(ctx, "finance.add_debt", {
      steps: [{ kind: "delete_row", table: "debts", id, after: { balance }, guard: "no_debt_payments" }],
      summary: `Added ${name} as a debt of ${dollars(balance)}${apr == null ? "" : ` at ${apr}%`}.`,
      result: { id, name, balance, apr, min_payment: minPayment },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.link_debt_to_card ────────────────────────────────────────────────
//
// Pointing a debt at a connected card makes the bank drive its balance: the DB trigger
// keeps it in sync from there. So the write is TWO columns — the link and a snap of
// the card's current balance (FinanceStore.tsx:1254) — and the undo puts both back.
const linkDebtToCard: Tool = {
  kind: "direct",
  does: "Point a debt at a connected credit card, so the bank keeps its balance current.",
  fields: ["debt_id", "account_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const debtId = idArg(payload.debt_id, "the debt");
    if (isRefusal(debtId)) return debtId;
    const acctId = idArg(payload.account_id, "the account");
    if (isRefusal(acctId)) return acctId;
    const [debt, acct] = await Promise.all([db.readDebt(debtId), db.readAccount(acctId)]);
    if (!debt) return refuse(404, "There is no debt with that id.");
    if (!acct) return refuse(404, "There is no account with that id.");
    if (!acct.providerAccountId) {
      return refuse(409, `${scrubCap(acct.name, 40)} is not bank-linked, so there is nothing for the debt to follow.`);
    }
    if (debt.providerAccountId === acct.providerAccountId) {
      return refuse(409, "That debt already follows that card.");
    }
    const snap = Math.max(0, acct.balance);
    return oneRow(
      ctx,
      "finance.link_debt_to_card",
      { table: "debts", id: debt.id },
      { provider_account_id: acct.providerAccountId, balance: snap },
      { provider_account_id: debt.providerAccountId, balance: debt.balance },
      `${scrubCap(debt.name, 40)} now follows ${scrubCap(acct.name, 40)}, starting at ${dollars(snap)}. The bank keeps it current from here, so payments stop being counted twice.`,
      { was: debt.balance, now: snap },
    );
  },
};

const unlinkDebtCard: Tool = {
  kind: "direct",
  does: "Stop a debt following a card. Its balance then stays where it is until somebody changes it.",
  fields: ["debt_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const debtId = idArg(payload.debt_id, "the debt");
    if (isRefusal(debtId)) return debtId;
    const debt = await db.readDebt(debtId);
    if (!debt) return refuse(404, "There is no debt with that id.");
    if (!debt.providerAccountId) return refuse(409, "That debt does not follow a card.");
    return oneRow(
      ctx,
      "finance.unlink_debt_card",
      { table: "debts", id: debt.id },
      { provider_account_id: null },
      { provider_account_id: debt.providerAccountId },
      `${scrubCap(debt.name, 40)} no longer follows a card. Its balance stays at ${dollars(debt.balance)} until something changes it, and payments against it count again.`,
    );
  },
};

// ── the two set-aside writes ─────────────────────────────────────────────────

const setAside: Tool = {
  kind: "direct",
  does: "Set a charge aside — out of the budget but still visible — as excluded or as owed back to you.",
  fields: ["transaction_id", "reason", "note"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const reason = payload.reason;
    if (reason !== "excluded" && reason !== "reimbursable") {
      return refuse(400, "reason is excluded (not your budget) or reimbursable (owed back to you).");
    }
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (t.appliesTo) return refuse(409, "That charge is already attached to something. Release it first.");
    const note = scrubCap(payload.note, 80);
    const applies: Record<string, UndoValue> = {
      kind: "setaside",
      reason,
      settled: false,
      ...(note ? { note } : {}),
    };
    return oneRow(
      ctx,
      "finance.set_aside",
      { table: "transactions", id: t.id },
      { applies_to: applies },
      { applies_to: null },
      reason === "reimbursable"
        ? `Set the ${dollars(t.amount)} charge from ${t.date} aside as owed back to you. It stays in the history and out of the budget until it is settled.`
        : `Set the ${dollars(t.amount)} charge from ${t.date} aside as not your budget. No cash moved.`,
    );
  },
};

const settleReimbursable: Tool = {
  kind: "direct",
  does: "Mark a reimbursable as paid back, optionally linking the deposit that paid it.",
  fields: ["transaction_id", "credit_transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    const at = t.appliesTo as { kind?: string; reason?: string; settled?: boolean; note?: string } | null;
    if (!at || at.kind !== "setaside" || at.reason !== "reimbursable") {
      return refuse(409, "That charge is not set aside as owed back to you.");
    }
    if (at.settled) return refuse(409, "That one is already settled.");

    // The linked deposit, if there is one. PORTED from FinanceStore.tsx:1128-1130: only
    // link a credit that is STILL a free, unlinked income row — otherwise a stale
    // suggestion would claim a deposit another reimbursable already used.
    let credit: ChargeRow | null = null;
    if (payload.credit_transaction_id !== undefined) {
      const creditId = idArg(payload.credit_transaction_id, "the deposit");
      if (isRefusal(creditId)) return creditId;
      credit = await db.readCharge(creditId);
      if (!credit) return refuse(404, "There is no deposit with that id.");
      if (credit.type !== "income") return refuse(409, "That row is not a deposit.");
      if (credit.appliesTo) return refuse(409, "That deposit is already attached to something else.");
    }

    const settledAt = ctx.at.toISOString();
    const reimbAfter: Record<string, UndoValue> = {
      kind: "setaside",
      reason: "reimbursable",
      settled: true,
      settledAt,
      ...(at.note ? { note: at.note } : {}),
      ...(credit ? { settledByTxnId: credit.id } : {}),
    };
    const steps: UndoStep[] = [
      {
        kind: "set_columns",
        table: "transactions",
        id: t.id,
        before: { applies_to: t.appliesTo },
        after: { applies_to: reimbAfter },
      },
    ];
    let creditAfter: Record<string, UndoValue> | null = null;
    if (credit) {
      creditAfter = {
        kind: "setaside",
        reason: "reimbursable",
        settled: true,
        settledByTxnId: t.id,
        settledAt,
      };
      steps.push({
        kind: "set_columns",
        table: "transactions",
        id: credit.id,
        before: { applies_to: null },
        after: { applies_to: creditAfter },
      });
    }

    const creditRow = credit;
    const creditPatch = creditAfter;
    return commit(ctx, "finance.settle_reimbursable", {
      steps,
      summary: creditRow
        ? `Marked the ${dollars(t.amount)} charge from ${t.date} paid back, and tied the ${dollars(creditRow.amount)} deposit from ${creditRow.date} to it.`
        : `Marked the ${dollars(t.amount)} charge from ${t.date} paid back. No deposit is tied to it.`,
      result: { id: t.id, credit_id: creditRow?.id ?? null },
      rowIds: creditRow ? [t.id, creditRow.id] : [t.id],
      async write() {
        // In the order the undo reverses: the reimbursable first, the deposit second.
        // If the second one moved, the undo carries a step for it that will refuse —
        // and the refusal below stops the change being marked undoable at all, so the
        // log says `abandoned` and he is told nothing landed. That is a small lie in
        // the rare case where the FIRST row did land, so it is said out loud rather
        // than hidden: the reply names both rows.
        if ((await db.setColumns("transactions", t.id, { applies_to: reimbAfter }, { applies_to: t.appliesTo })) === "moved") {
          return refuse(409, MOVED);
        }
        if (creditRow && creditPatch) {
          if ((await db.setColumns("transactions", creditRow.id, { applies_to: creditPatch }, { applies_to: null })) === "moved") {
            return refuse(
              409,
              "I marked the charge paid back, and then the deposit had already been claimed by something else — so the two are not tied together. Have a look in the app.",
            );
          }
        }
      },
    });
  },
};

const unsettleReimbursable: Tool = {
  kind: "direct",
  does: "Re-open a reimbursable as still owed, and free the deposit it was tied to.",
  fields: ["transaction_id"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    const at = t.appliesTo as
      | { kind?: string; reason?: string; settled?: boolean; note?: string; settledByTxnId?: string }
      | null;
    if (!at || at.kind !== "setaside" || at.reason !== "reimbursable") {
      return refuse(409, "That charge is not set aside as owed back to you.");
    }
    if (!at.settled) return refuse(409, "That one is already open as still owed.");

    const reopened: Record<string, UndoValue> = {
      kind: "setaside",
      reason: "reimbursable",
      settled: false,
      ...(at.note ? { note: at.note } : {}),
    };
    const steps: UndoStep[] = [
      {
        kind: "set_columns",
        table: "transactions",
        id: t.id,
        before: { applies_to: t.appliesTo },
        after: { applies_to: reopened },
      },
    ];
    const creditId = typeof at.settledByTxnId === "string" && UUID.test(at.settledByTxnId) ? at.settledByTxnId : null;
    let creditBefore: UndoValue = null;
    if (creditId) {
      const credit = await db.readCharge(creditId);
      // A deposit that is already gone is not a reason to refuse: the reimbursable
      // still has to re-open. It just has nothing to unlink.
      if (credit) {
        creditBefore = credit.appliesTo;
        steps.push({
          kind: "set_columns",
          table: "transactions",
          id: credit.id,
          before: { applies_to: credit.appliesTo },
          after: { applies_to: null },
        });
      }
    }

    const unlinkId = steps.length > 1 ? creditId : null;
    return commit(ctx, "finance.unsettle_reimbursable", {
      steps,
      summary: unlinkId
        ? `Re-opened the ${dollars(t.amount)} charge from ${t.date} as still owed, and freed the deposit that was tied to it.`
        : `Re-opened the ${dollars(t.amount)} charge from ${t.date} as still owed.`,
      result: { id: t.id, freed_credit_id: unlinkId },
      rowIds: unlinkId ? [t.id, unlinkId] : [t.id],
      async write() {
        if ((await db.setColumns("transactions", t.id, { applies_to: reopened }, { applies_to: t.appliesTo })) === "moved") {
          return refuse(409, MOVED);
        }
        if (unlinkId) {
          if ((await db.setColumns("transactions", unlinkId, { applies_to: null }, { applies_to: creditBefore })) === "moved") {
            return refuse(
              409,
              "I re-opened the charge, and then the deposit had already changed — so it is still tied to something. Have a look in the app.",
            );
          }
        }
      },
    });
  },
};

// ── finance.promote_to_bill ──────────────────────────────────────────────────
//
// THREE ROWS IN ONE WRITE, which is why it is last. The app does the same three
// (FinanceStore.tsx:1190): insert the bill unless one already matches the merchant,
// point THIS charge at it so it leaves variable spend, and teach the categoriser so
// the next one lands on its own.
const promoteToBill: Tool = {
  kind: "direct",
  does: "Turn a repeating charge into a bill, attach this charge to it, and remember the merchant.",
  fields: ["transaction_id", "cadence"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const id = idArg(payload.transaction_id, "the charge");
    if (isRefusal(id)) return id;
    const cadence = payload.cadence === undefined ? "monthly" : payload.cadence;
    const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "semiannual", "yearly"];
    if (typeof cadence !== "string" || !CADENCES.includes(cadence)) {
      return refuse(400, `The cadence is one of: ${CADENCES.join(", ")}.`);
    }
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");
    if (t.appliesTo) return refuse(409, "That charge is already attached to something.");
    if (t.type !== "expense") return refuse(409, "That row is a deposit, not a charge.");

    const key = merchantKey(t.description);
    if (!key) return refuse(400, "I cannot work out a merchant from that charge's name.");
    const day = Number(t.date.slice(8, 10)) || 1;
    const month = t.date.slice(0, 7);
    const cleanName = scrubCap(t.description, 40) || "Subscription";

    // A CHARGE WHOSE NAME IS ONLY THE BANK'S WORDING. FOUND 2026-10-09: a card line with
    // no clean name keys to the bare word "CHECKCARD", and the live rules table already
    // holds "CHECKCARD -> dining", which files every such line as dining. Promoting one
    // of those charges used to do worse: it would REWRITE that rule into a bill rule, so
    // every card line with no clean name would settle this bill — and the dedupe below
    // would attach the charge to whichever unrelated bill happened to key to the same
    // word. So for such a charge the bill is still made and the charge still attached,
    // exactly as asked, but nothing is reused by that key and nothing is taught. The
    // app's makeRecurringBill does the same, through the same predicate.
    const noMerchant = isStatementNoiseKey(key);

    // Reuse an existing active bill whose merchant matches — the app's own dedupe,
    // which is what stops this spawning a copy every time it is asked.
    const existing = noMerchant
      ? undefined
      : (await db.allBillNames()).find((b) => b.active && b.direction === "out" && merchantKey(b.name) === key);

    const steps: UndoStep[] = [];
    let billId: string;
    let billName: string;
    if (existing) {
      billId = existing.id;
      billName = existing.name;
    } else {
      billId = await db.insertRow("recurring", {
        name: cleanName,
        amount: t.amount,
        direction: "out",
        cadence,
        category_id: "subscriptions",
        active: true,
        due_days: [day],
      });
      billName = cleanName;
      steps.push({
        kind: "delete_row",
        table: "recurring",
        id: billId,
        after: { active: true },
        guard: "no_bill_payments",
      });
    }

    const applies: Record<string, UndoValue> = { kind: "bill", recurringId: billId, monthKey: month, day };
    steps.push({
      kind: "set_columns",
      table: "transactions",
      id: t.id,
      before: { applies_to: t.appliesTo, category_id: t.categoryId },
      after: { applies_to: applies, category_id: "subscriptions" },
    });

    // Not read at all for a noise key: an existing rule on that word is exactly the one
    // this must not rewrite, and what happens to it is Gino's call.
    const rule = noMerchant ? null : await db.readMerchantRule(key);
    let ruleId: string | null = null;
    if (noMerchant) {
      // Nothing taught; see above.
    } else if (rule) {
      ruleId = rule.id;
      steps.push({
        kind: "set_columns",
        table: "merchant_rules",
        id: rule.id,
        before: { kind: rule.kind, category_id: rule.categoryId, bill_name: rule.billName },
        after: { kind: "bill", category_id: null, bill_name: billName },
      });
    } else {
      ruleId = await db.insertRow("merchant_rules", {
        pattern: key,
        kind: "bill",
        category_id: null,
        bill_name: billName,
      });
      steps.push({ kind: "delete_row", table: "merchant_rules", id: ruleId, after: { kind: "bill" } });
    }

    const ruleRow = rule;
    return commit(ctx, "finance.promote_to_bill", {
      steps,
      summary: noMerchant
        ? `Made ${scrubCap(billName, 40)} a ${cadence} bill of ${dollars(t.amount)} due on day ${day} and attached this charge to it. I did not teach the app the merchant: the charge's name is the bank's own wording, and a rule on it would catch every charge that carries it.`
        : existing
          ? `Attached the ${dollars(t.amount)} charge from ${t.date} to the ${scrubCap(billName, 40)} bill you already have, and taught the app that merchant pays it.`
          : `Made ${scrubCap(billName, 40)} a ${cadence} bill of ${dollars(t.amount)} due on day ${day}, attached this charge to it, and taught the app to recognise the merchant.`,
      result: {
        bill_id: billId,
        charge_id: t.id,
        rule_id: ruleId,
        reused_existing_bill: !!existing,
        taught_merchant: !noMerchant,
      },
      rowIds: ruleId ? [billId, t.id, ruleId] : [billId, t.id],
      async write() {
        if (
          (await db.setColumns(
            "transactions",
            t.id,
            { applies_to: applies, category_id: "subscriptions" },
            { applies_to: t.appliesTo, category_id: t.categoryId },
          )) === "moved"
        ) {
          return refuse(409, MOVED);
        }
        if (ruleRow) {
          await db.setColumns(
            "merchant_rules",
            ruleRow.id,
            { kind: "bill", category_id: null, bill_name: billName },
            { kind: ruleRow.kind, category_id: ruleRow.categoryId, bill_name: ruleRow.billName },
          );
        }
      },
    });
  },
};

// ── system.undo ──────────────────────────────────────────────────────────────
//
// The other half of the bargain. Phase 2's argument for dropping the approval queue
// is that every change is written down with its before-state, and that argument is
// only worth anything if reversing one is as easy as making one.
//
// IT ONLY UNDOES HIS OWN CHANGES, and it says so rather than hiding it. `person`
// comes from the secret and never from the body, so her key cannot reverse his write
// — the same rule every other tool on this door follows, for the same reason.
//
// A BARE "undo that" WITH NO TOKEN takes the newest change that can still be put
// back. That is the request he will actually make, so it is the one the tool is built
// for; the token exists for "undo the one before that".
const systemUndo: Tool = {
  kind: "direct",
  does: "Put back a change I made. With no token, the last one.",
  fields: ["token"],
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    let token: string | null = null;
    if (payload.token !== undefined) {
      const t = scrubCap(payload.token, 32);
      if (!/^u-[0-9a-hjkmnp-tv-z]{8}$/.test(t)) {
        return refuse(400, "An undo token looks like u-4k7m9qt2. Ask system.changes for the list.");
      }
      token = t;
    }

    const record = token ? await db.findChange(ctx.person, token) : await db.latestUndoable(ctx.person);
    if (!record) {
      return token
        ? refuse(404, "I have no change under that token. It may be one I made for the other person, or one that never happened.")
        : refuse(404, "I have not made any change I can put back.");
    }
    if (record.state !== "undoable") {
      return refuse(409, `${record.summary} — ${STATE_SAYS[record.state]}`);
    }

    let steps: UndoStep[];
    try {
      steps = checkSteps(record.steps);
    } catch (e) {
      if (e instanceof UndoRefused) return refuse(409, e.say);
      throw e;
    }

    const applier: UndoApplier = {
      setColumns: (table, rowId, before, after) => db.setColumns(table, rowId, before, after),
      deleteRow: (table, rowId, after) => db.deleteRow(table, rowId, after),
      isReferenced: async (guard, rowId) =>
        guard === "no_bill_payments"
          ? (await db.billPayments(rowId)).length > 0
          : (await db.countDebtPayments(rowId)) > 0,
      reverseMoneyEvent: (rowId) => db.reverseMoneyEvent(rowId),
      restoreMoneyEvent: (row) => db.restoreMoneyEvent(row),
      // The fifth step kind: a named inverse out of the one registry. This is where the
      // health half of phase 2 joins the core — 22 tools whose rows are documents rather
      // than columns, so their inverse is code with the before-state as data.
      //
      // A handler the registry does not have is a REFUSAL with a sentence, not a throw.
      // The case is real and survivable: a change recorded by an older deploy, naming a
      // handler that has since been renamed. A rename orphans tokens, which is why a
      // `kind` is treated as a migration and not a refactor — and when it happens anyway,
      // the honest answer is "I cannot put that one back", not a 500.
      runHandler: async (handler, before) => {
        const h = UNDO_REGISTRY[handler];
        if (!h) return { say: "I recorded how to put that back, but I no longer know how to run it. Have a look in the app." };
        const out = await h.apply(before, ctx);
        return out.ok ? "ok" : { say: out.say };
      },
    };

    const outcome = await applyUndo(steps, applier);
    if (!outcome.ok) {
      // The change stays `undoable`. Part of it may have been put back, and the
      // sentence says how much — so asking again after fixing the row in the app
      // finishes the job rather than being refused as already done.
      return refuse(409, outcome.say);
    }

    // The undo is itself a change, and it gets its own row so the log reads as a history
    // rather than a set of flags.
    //
    // IT IS BORN `undone`, AND THAT IS NOT A TRICK. The row has to carry steps (the column
    // is not null, and a row whose steps this door would refuse is dropped when it is read
    // back), and the only steps it could carry are the original change's — which, run
    // again, would undo the undo. So the row is created and immediately marked `undone`,
    // which is the one state system.undo will not act on. There is deliberately no redo:
    // a redo is a new write with its own before-state, and asking for the change again is
    // the honest way to get one.
    const mine = mintToken((into) => crypto.getRandomValues(into));
    const said = `Put back: ${record.summary}`;
    await db.recordChange({
      token: mine,
      person: ctx.person,
      tool: "system.undo",
      summary: undoSummary(said),
      steps,
    });
    await db.setChangeState(record.token, "undone", {
      undoneAt: ctx.at.toISOString(),
      undoneBy: mine,
    });
    await db.setChangeState(mine, "undone", { undoneAt: ctx.at.toISOString() });

    return {
      ok: true,
      result: { undone: record.token, tool: record.tool, rows_put_back: outcome.steps },
      rowIds: [],
      say: `${said} ${outcome.steps === 1 ? "One row" : `${outcome.steps} rows`} went back the way they were. I cannot undo an undo — ask me for the change again if you want it after all.`,
    };
  },
};

// ── finance.refresh_bank ─────────────────────────────────────────────────────
//
// "Check the bank for anything new."
//
// WHY THIS IS A WRITE TOOL THAT WRITES ALMOST NOTHING. The doors may not call another
// edge function — that is item 7 of what an assistant may never do, and it is enforced
// by neither door importing a client or a URL. The bank pull lives in the `plaid`
// function, so this tool cannot perform one. What it can do is write the ASK down, on
// a column a scheduled job watches (supabase/schema_v39_bank_refresh.sql), and then
// say so honestly.
//
// AND THAT HONESTY IS THE HARD PART. The queued tools of Phase 1 shipped with a
// sentence that promised a tap in an app screen that did not exist, and the whole
// reason `landing` is carried through the catalogue is so an assistant cannot read
// "done" into "written down". This tool has the same trap with a different shape: an
// assistant that hears "refreshed" will go straight on to read a balance, get the OLD
// one, and say it with a fresh-sounding preamble. So the sentence says NOT instant, it
// says the ledger has not moved, and it says to read the numbers again afterwards —
// and the cooldown's refusal says the same thing from the other side.
//
// NO ARGUMENTS, deliberately. "Check the bank" is one instruction. A per-connection
// version would need the door to hand out connection ids and then be told which one,
// which is a choice nobody asking the question has any way to make.
//
// NO UNDO, and that is a decision rather than an omission: see requestBankRefresh in
// dbFinance.ts. There is no before-state — you cannot un-ask a bank — and a token that
// looked like it could reverse this would be the door promising what it cannot do.
const refreshBank: Tool = {
  kind: "direct",
  does: "Ask the bank for anything new. It is not instant — the scheduled job carries it out.",
  fields: [],
  async run(_payload, ctx) {
    const db = ctx.db as FinanceDb;

    let conns: { id: string; lastSyncAt: string | null; refreshRequestedAt: string | null }[];
    try {
      conns = await db.bankSyncTimes();
    } catch (e) {
      // The one shape worth naming: the column does not exist yet, because
      // schema_v39 has not been run. Anything else is a real failure and is left to
      // the handler's 500 — a door that answered "not set up" to every database
      // error would hide an outage behind a setup instruction.
      const msg = String((e as Error)?.message ?? e);
      if (/refresh_requested_at/.test(msg)) {
        return refuse(
          503,
          "I cannot ask for a bank refresh yet: the database is missing the column that records the " +
            "request (schema_v39_bank_refresh.sql has not been run). The scheduled pull is what keeps " +
            "the numbers current anyway — read them and say when they were last synced.",
        );
      }
      throw e;
    }

    // The window, and the sentence that goes with it, both come from the shared
    // module the read door's stamp uses. One definition of "too soon", one place it
    // is explained — the same reason the two doors share one clock and one cleaner.
    const decision = refreshDecision(conns, ctx.at);
    if (!decision.allowed) {
      // 429 when it is the cooldown, 404 when there is no bank at all. Both are
      // refusals the assistant should repeat rather than retry, and the `says`
      // sentence is what it repeats.
      return refuse(conns.length === 0 ? 404 : 429, decision.says);
    }

    const touched = await db.requestBankRefresh(ctx.at.toISOString());
    if (touched === 0) {
      return refuse(
        503,
        "I could not write the refresh request down, so nothing was asked for. Try again, and check " +
          "the app if it keeps happening.",
      );
    }

    return {
      ok: true,
      // No connection ids, no bank names: the caller does not need them and
      // finance.bank_status is the tool that names a connection.
      result: { connections_asked: touched, instant: false, arrives_within_minutes: REFRESH_TICK_MIN },
      // rowIds stays empty. These rows are not a change anybody can look up later,
      // and the audit row already records that the call happened.
      rowIds: [],
      say: decision.says,
    };
  },
};

export const FINANCE_WRITE_TOOLS: Record<string, Tool> = {
  "finance.refresh_bank": refreshBank,
  "finance.add_transaction": addTransaction,
  "finance.delete_charge": deleteCharge,
  "finance.categorize_charge": categorizeCharge,
  "finance.split_charge": splitCharge,
  "finance.unlink_charge": unlinkCharge,
  "finance.link_charge_to_bill": linkChargeToBill,
  "finance.mark_bill_paid": markBillPaid,
  "finance.set_paid_override": setPaidOverride,
  "finance.dismiss_unusual": dismissUnusual,
  "finance.exclude_from_budget": excludeFromBudget,
  "finance.set_aside": setAside,
  "finance.settle_reimbursable": settleReimbursable,
  "finance.unsettle_reimbursable": unsettleReimbursable,
  "finance.promote_to_bill": promoteToBill,
  "finance.set_bill_variable": setBillVariable,
  "finance.set_bill_amount": setBillAmount,
  "finance.set_flow": setFlow,
  "finance.set_bill_account": setBillAccount,
  "finance.set_bill_due_day": setBillDueDay,
  "finance.turn_bill_off": turnBillOff,
  "finance.set_bill_window": setBillWindow,
  "finance.add_bill": addBill,
  "finance.learn_merchant": learnMerchant,
  "finance.set_account_balance": setAccountBalance,
  "finance.add_debt": addDebt,
  "finance.link_debt_to_card": linkDebtToCard,
  "finance.unlink_debt_card": unlinkDebtCard,
  "system.undo": systemUndo,
};

/** Re-exported for the tests, which assert the guards are the app's own. */
export type { BillRow, ChargeRow };
