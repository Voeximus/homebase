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
// Values, not types: kit.ts imports nothing back out of this file, so this closes no
// cycle. The placeholder id every example uses, and the shape-refusal pieces.
import { EXAMPLE_ID, isObject, problemPad, problemsOf, shapeRefused, type ShapeCtx, type Shaped } from "./kit.ts";
import { itemSays, kindOfValue, labelOf, renameBy, unknownKeysSays, type ListShape } from "./shapes.ts";
// A type-only import above, and this one from _shared: tools.ts imports THIS file's
// registry as a value, so anything imported back out of it would close a runtime cycle.
import { UUID } from "../_shared/muse/args.ts";
import {
  isMissingTable,
  StatementRefused,
  type BillRow,
  type ChargeRow,
  type CycleBudgetRow,
  type FinanceDb,
  type LabelRow,
} from "./dbFinance.ts";
// A budget goal for one pay cycle (2026-10-10): which cycles can be set, the six lines,
// and the targets a goal adds up to — the one module the app's budget bars and the read
// door's finance.budget_status also answer from, through the generated copy.
import {
  BUDGET_LINE_KEYS,
  cycleInProgress,
  cycleTargets,
  GOAL_LINE_MAX,
  goalCycleProblem,
  goalCycles,
  type CycleSpan,
} from "../_shared/muse/lib/cycleBudget.ts";
import type { CycleBudget } from "../_shared/muse/lib/types.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
// The cooldown, and the sentences that explain it, shared with the read door's
// freshness stamp so "too soon" has one definition rather than two.
import { REFRESH_TICK_MIN, refreshDecision } from "../_shared/muse/freshness.ts";
import { NAME_MAX, scrub, scrubCap, scrubName, scrubOr } from "../_shared/muse/scrub.ts";
// Gino's pay floor: the one sentence of the rule and the one test for its row, shared
// with the read door so the two cannot describe it two ways again.
import { isPayFloorRow, PAY_FLOOR_RULE } from "../_shared/muse/payFloor.ts";
import {
  billKey,
  BUILT_IN_BILL_NAMES,
  isMultiDepartment,
  isStatementNoiseKey,
  matchRecurringName,
  merchantKey,
  stripStatementNoise,
} from "../_shared/muse/lib/categorize.ts";
// The key finance.worth_a_look hands out, and the shape a dismissal must have. Shared with
// the read door, so the key it gives and the key this takes are one definition.
import { SUGGESTION_KEY, SUGGESTION_KEY_MAX } from "../_shared/muse/worthALook.ts";
import { DISPLAY } from "../_shared/muse/auth.ts";
import { CYCLE_BUDGET_INSERT, lineLabel, MERCHANT_RULE_INSERT, ruleHabit } from "./financeUndo.ts";
import { cycleKeyOf } from "../_shared/muse/lib/selfAudit.ts";
import { DUE_DAYS, STEP_DOWNS } from "../_shared/muse/lib/schedule.ts";
import { isCardName } from "../_shared/muse/lib/forecast.ts";
import { ATTACK_ORDER } from "../_shared/muse/lib/plan.ts";
import { DEFAULT_CATEGORIES } from "../_shared/muse/lib/seed.ts";
import {
  applyUndo,
  applyUndoRowByRow,
  checkSteps,
  MAX_STEPS,
  mintToken,
  ROW_BY_ROW_TOOLS,
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
function dateFor(payload: Record<string, unknown>, ctx: ShapeCtx, backDays: number): { date: string } | Refusal {
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

// ── every problem, before anything is read ───────────────────────────────────
//
// ADDED IN REVIEW 2026-10-10. Every tool in this file used to check its fields inside
// `run`, one at a time, stopping at the first — and `run` is only reached after the
// hourly write counter is bumped. So finance.add_transaction with a bad amount AND a bad
// category took two round trips and two slots of the hour to hear both, and a call
// whose amount was a string spent a slot for nothing that ever reached the ledger.
//
// Now each tool's checks that need no database are one `plan…` function: its `check`
// returns that function's problems (handler.ts runs it before anything is counted), and
// its `run` calls the same function first, so a tool driven directly refuses the same
// way. What does need the database — that the row exists, that it is not already in
// that state, that the slices add up to the charge — stays in `run`, where it was.

/** One or more ids, each the read door's, as a shape answer. `what` says whose id. */
function planIds(payload: Record<string, unknown>, ...wanted: [field: string, what: string][]): Shaped<string[]> {
  const pad = problemPad();
  const ids = wanted.map(([field, what]) => pad.take(idArg(payload[field], what)));
  return pad.done(() => ids.map((x) => x!));
}

/** A dollar figure above zero and not absurd, or the problem with it. */
function amountArg(v: unknown, say: string): number | Refusal {
  const n = money(v);
  if (n === null || n <= 0 || n > 100_000) return refuse(400, say);
  return n;
}

/** A month the caller MAY leave out, checked only when it was sent. */
function optionalMonth(v: unknown, say: string): string | null | Refusal {
  if (v === undefined) return null;
  if (typeof v !== "string" || !MONTH.test(v)) return refuse(400, say);
  return v;
}

const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "semiannual", "yearly"];

/** A bill's cadence, monthly when it is left out. */
function cadenceArg(v: unknown): string | Refusal {
  const cadence = v === undefined ? "monthly" : v;
  if (typeof cadence !== "string" || !CADENCES.includes(cadence)) {
    return refuse(400, `The cadence is one of: ${CADENCES.join(", ")}.`);
  }
  return cadence;
}

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

/** add_transaction's date, amount, category, kind, description and account id — every
 *  problem with any of them, so a wrong amount and a wrong category are heard together. */
function planCash(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{
  date: string;
  amount: number;
  category: string;
  kind: "expense" | "income";
  description: string;
  accountId: string | null;
}> {
  const pad = problemPad();
  const when = pad.take(dateFor(payload, ctx, 60));
  const amount = pad.take(amountArg(payload.amount, "I need the amount as a number above zero."));
  const category = pad.take(categoryArg(payload.category_id));
  const kind = payload.kind === undefined ? "expense" : payload.kind;
  if (kind !== "expense" && kind !== "income") pad.no("kind is expense or income.");
  const description = scrubCap(payload.description, 40);
  if (!description) pad.no("Tell me what the charge was for, in a few words.");
  const accountId = payload.account_id === undefined ? null : pad.take(idArg(payload.account_id, "the account"));
  return pad.done(() => ({
    date: when!.date,
    amount: amount!,
    category: category!,
    kind: kind as "expense" | "income",
    description,
    accountId: accountId ?? null,
  }));
}

const addTransaction: Tool = {
  kind: "direct",
  does: "Add a cash charge the bank will never see.",
  fields: ["date", "amount", "category_id", "description", "account_id", "kind"],
  // Placeholder words, not a believable purchase: a call that is exactly the example is
  // refused (handler.ts), and "$12.50 at the farmers market" is a real thing to say.
  example: { amount: 12.5, category_id: "groceries", description: "Sample purchase" },
  check: (payload, ctx) => problemsOf(planCash(payload, ctx)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planCash(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { amount, category, kind, description } = plan.value;
    const when = { date: plan.value.date };

    let accountId: string | null = null;
    if (plan.value.accountId !== null) {
      const id = plan.value.accountId;
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
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["transaction_id", "the charge"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["transaction_id", "the charge"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id] = plan.value;
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
/** categorize_charge's charge id and category — both problems at once. */
function planCategorize(payload: Record<string, unknown>): Shaped<{ id: string; category: string }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.transaction_id, "the charge"));
  const category = pad.take(categoryArg(payload.category_id));
  return pad.done(() => ({ id: id!, category: category! }));
}

const categorizeCharge: Tool = {
  kind: "direct",
  does: "Put one charge in a category.",
  fields: ["transaction_id", "category_id"],
  example: { transaction_id: EXAMPLE_ID, category_id: "dining" },
  check: (payload) => problemsOf(planCategorize(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planCategorize(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, category } = plan.value;
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

/** What one slice takes. Anything else inside a slice is refused by name. */
const SLICE_KEYS = ["category_id", "amount"] as const;
const SLICE_SHAPE: ListShape = { takes: SLICE_KEYS };

/**
 * split_charge's charge id and slices — EVERY problem with them, before any database
 * read, or the slices.
 *
 * FOUND 2026-10-10. The slices used to be checked only after the charge was read, one
 * at a time, stopping at the first bad one — and a key inside a slice that was not
 * category_id or amount was ignored. Now the whole list is read to the end, a stray key
 * is refused by name, and because none of it needs the database, handler.ts runs it
 * before the hourly write counter is bumped. Whether the slices add up to the charge
 * DOES need the charge, so that one is still decided in run.
 */
function planSlices(payload: Record<string, unknown>): { ok: true; id: string; slices: { categoryId: string; amount: number }[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const id = idArg(payload.transaction_id, "the charge");
  if (isRefusal(id)) problems.push(id.say);
  const raw = payload.slices;
  const slices: { categoryId: string; amount: number }[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    const what = raw === undefined || Array.isArray(raw) ? "" : ` slices has to be a list — it was ${kindOfValue(raw)}.`;
    problems.push(`I need at least one slice, each with a category_id and an amount.${what}`);
  } else if (raw.length > MAX_SLICES) {
    problems.push(`That is more than ${MAX_SLICES} slices.`);
  } else {
    raw.forEach((s, i) => {
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        problems.push(itemSays(labelOf("Slice", i), [`It is ${kindOfValue(s)}, not an object like {"category_id": "groceries", "amount": 30}.`], null));
        return;
      }
      const row = s as Record<string, unknown>;
      const { value, unknown, clashes } = renameBy(row, SLICE_SHAPE);
      const mine = [...clashes];
      if (unknown.length) mine.push(unknownKeysSays(unknown, SLICE_KEYS));
      const cat = categoryArg(value.category_id);
      if (isRefusal(cat)) mine.push(cat.say);
      const amt = money(value.amount);
      if (amt === null || amt <= 0) mine.push("It needs an amount above zero.");
      const label = labelOf("Slice", i, isRefusal(cat) ? undefined : cat);
      if (mine.length || isRefusal(cat) || amt === null) problems.push(itemSays(label, mine, row));
      else slices.push({ categoryId: cat, amount: amt });
    });
  }
  if (problems.length || isRefusal(id)) return { ok: false, problems };
  return { ok: true, id, slices };
}

const splitCharge: Tool = {
  kind: "direct",
  does: "Allocate one charge across several categories. The cash does not move.",
  fields: ["transaction_id", "slices"],
  example: { transaction_id: EXAMPLE_ID, slices: [{ category_id: "groceries", amount: 30 }, { category_id: "shopping", amount: 12.5 }] },
  lists: { slices: SLICE_SHAPE },
  check: (payload) => {
    const plan = planSlices(payload);
    return plan.ok ? [] : plan.problems;
  },
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planSlices(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, slices } = plan;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");

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
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["transaction_id", "the charge"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["transaction_id", "the charge"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id] = plan.value;
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
const LINK_MONTH_SAYS = "The month goes in as 2026-09, or leave it out and I will use the charge's own month.";

/** link_charge_to_bill's two ids and, when it was sent, its month. */
function planLink(payload: Record<string, unknown>): Shaped<{ txnId: string; billId: string }> {
  const pad = problemPad();
  const txnId = pad.take(idArg(payload.transaction_id, "the charge"));
  const billId = pad.take(idArg(payload.bill_id, "the bill"));
  pad.take(optionalMonth(payload.month, LINK_MONTH_SAYS));
  return pad.done(() => ({ txnId: txnId!, billId: billId! }));
}

const linkChargeToBill: Tool = {
  kind: "direct",
  does: "Attach a charge to a bill, which records that bill as paid for that month.",
  fields: ["transaction_id", "bill_id", "month"],
  example: { transaction_id: EXAMPLE_ID, bill_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planLink(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planLink(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { txnId, billId } = plan.value;
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
    // A month that was SENT was checked by planLink, before anything was counted. This
    // is the derived one, off the charge's own date — a row whose date did not give a
    // month would be the ledger's problem, and it is still refused rather than written.
    const month = payload.month === undefined ? t.date.slice(0, 7) : payload.month;
    if (typeof month !== "string" || !MONTH.test(month)) {
      return refuse(400, LINK_MONTH_SAYS);
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
/** mark_bill_paid's bill id, amount and month — this month when it is left out. */
function planPaid(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ billId: string; amount: number; month: string }> {
  const pad = problemPad();
  const billId = pad.take(idArg(payload.bill_id, "the bill"));
  const amount = pad.take(amountArg(payload.amount, "I need what was paid, as a number above zero."));
  const month = pad.take(optionalMonth(payload.month, "The month goes in as 2026-09, or leave it out and I will use this month."));
  return pad.done(() => ({ billId: billId!, amount: amount!, month: month ?? azDateISO(ctx.az).slice(0, 7) }));
}

const markBillPaid: Tool = {
  kind: "direct",
  does: "Record a bill as already paid, without moving any cash.",
  fields: ["bill_id", "amount", "month"],
  example: { bill_id: EXAMPLE_ID, amount: 54.99 },
  check: (payload, ctx) => problemsOf(planPaid(payload, ctx)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planPaid(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { billId, amount, month } = plan.value;
    const bill = await db.readBill(billId);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.direction !== "out") return refuse(409, "That row is not a bill going out.");
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
/** set_paid_override's month, bill key and flag — every problem at once. */
function planOverride(payload: Record<string, unknown>): Shaped<{ month: string; key: string; paid: boolean }> {
  const pad = problemPad();
  const month = payload.month;
  if (typeof month !== "string" || !MONTH.test(month)) pad.no("The month goes in as 2026-09.");
  const key = scrubCap(payload.bill_key, 80);
  if (!key) pad.no("I need the bill key, which finance.paid_bills gives you.");
  if (typeof payload.paid !== "boolean") pad.no("paid is either true or false.");
  return pad.done(() => ({ month: month as string, key, paid: payload.paid as boolean }));
}

const setPaidOverride: Tool = {
  kind: "direct",
  does: "Set or clear the hand-made paid/unpaid mark on one bill in one month.",
  fields: ["month", "bill_key", "paid"],
  example: { month: "2026-10", bill_key: "Sample bill@3", paid: true },
  check: (payload) => problemsOf(planOverride(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planOverride(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { month, key, paid } = plan.value;

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
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["transaction_id", "the charge"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["transaction_id", "the charge"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id] = plan.value;
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
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["transaction_id", "the charge"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["transaction_id", "the charge"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id] = plan.value;
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

/** set_bill_variable's bill id and flag. */
function planVariable(payload: Record<string, unknown>): Shaped<{ id: string; variable: boolean }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  if (typeof payload.variable !== "boolean") pad.no("variable is either true or false.");
  return pad.done(() => ({ id: id!, variable: payload.variable as boolean }));
}

const setBillVariable: Tool = {
  kind: "direct",
  does: "Mark a bill as varying month to month, or stop marking it that way.",
  fields: ["bill_id", "variable"],
  example: { bill_id: EXAMPLE_ID, variable: true },
  check: (payload) => problemsOf(planVariable(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planVariable(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, variable } = plan.value;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.variable === variable) {
      return refuse(409, `${scrubCap(bill.name, 40)} is already marked that way.`);
    }
    return oneRow(
      ctx,
      "finance.set_bill_variable",
      { table: "recurring", id: bill.id },
      { variable },
      { variable: bill.variable },
      variable
        ? `${scrubCap(bill.name, 40)} now counts as a bill whose amount varies, so the plan prices it from real payments.`
        : `${scrubCap(bill.name, 40)} now counts as a fixed bill, priced at its stored amount.`,
    );
  },
};

// ── incoming rows: the plan's income, and Gino's pay floor ───────────────────
//
// FOUND 2026-10-10: NOTHING STOOD BETWEEN A SENTENCE AND THE FLOOR. Gino's standing rule
// is that his paycheck row's amount is a deliberate floor — a planned paycheck amount
// set low on purpose, anything above it upside, never raised. finance.set_bill_amount
// had no direction check at all, so "my check was bigger this time, update it" would
// have raised it: undoably, but with no refusal and nobody told the rule. Two other bill
// tools refuse anything that is not an outgoing bill (link_charge_to_bill and
// mark_bill_paid); these three are the ones that legitimately touch income rows too, so
// they cannot simply refuse them.
//
// So three changes to ANY incoming row now need the call to carry `confirm: true`:
// raising its amount, turning it off, and ending (or shrinking) its window. Every one of
// them makes the plan count on less money arriving — or, for a raise, on more money than
// anyone has promised — and every figure the doors say is built on these rows: planMath
// takes income from them, and forecast() lays them down as paychecks.
//
// LOWERING ONE, TURNING ONE BACK ON, OR WIDENING ITS WINDOW STAYS FREE. Those only make
// the plan more cautious, and refusing them would train the assistant to send
// `confirm: true` by habit, which is how a confirmation stops meaning anything.
//
// The refusal for the floor row says the rule itself, in PAY_FLOOR_RULE's one sentence
// (_shared/muse/payFloor.ts, which the read door's notes follow), so the assistant hears
// why — not only that it was refused. `confirm` is the assistant saying the person told
// it to in this conversation; the door cannot check that, and says so in the refusal
// rather than pretending a flag is a signature.
//
// FOUND 2026-10-10, IN REVIEW: ON THE FLOOR ROW, `confirm` WAS ACCEPTED FROM EITHER KEY.
// The refusal said Gino had to be the one asking, but nothing checked who was calling,
// so Xinyan's assistant — told "his checks are bigger now, update his paycheck" — would
// have been handed the refusal, resent it with confirm: true as the refusal invited, and
// raised Gino's floor without Gino anywhere in it. What the door CAN check is the key:
// ctx.person comes from the secret that was presented, never from the body. So on the
// floor row a raise, an off or a shortened window goes through only on Gino's key, with
// confirm; on any other key it is refused with 403 whether or not confirm is sent, and
// the refusal does not invite a resend that cannot work. Lowering it stays free from
// either key, for the reason above: it only makes the plan more careful.
//
// Only the floor row is held to a key. It is the one row with a standing rule attached,
// and the one isPayFloorRow can name by what it is; other incoming rows are guarded by
// confirm alone.

/** `confirm`, read as a boolean and nothing else: absent is false, and a truthy string
 *  is refused rather than taken to mean yes. */
function confirmArg(payload: Record<string, unknown>): boolean | Refusal {
  if (payload.confirm === undefined) return false;
  if (typeof payload.confirm !== "boolean") return refuse(400, "confirm is either true or false.");
  return payload.confirm;
}

/**
 * The refusal for a change that takes money out of the plan's income, or null to let it
 * through. Null for every outgoing row; for any other incoming row once `confirm` is
 * true; and for Gino's floor row only when `confirm` is true AND the call came in on
 * his key (`person`, which is ctx.person — taken from the secret, never the body).
 *
 * `window` finishes the sentence for a window change — "after 2026-12-31", "until
 * 2026-11-01" — and is unused for the other two.
 */
function incomeChangeRefused(
  bill: BillRow,
  change: "raise" | "off" | "window",
  confirmed: boolean,
  person: Ctx["person"],
  window = "",
): Refusal | null {
  if (bill.direction !== "in") return null;
  const name = scrubCap(bill.name, 40) || "That income";
  if (isPayFloorRow(bill)) {
    const what =
      change === "raise"
        ? `So I have not raised ${name}.`
        : change === "off"
          ? `Turning ${name} off would take his planned pay out of every plan and forecast, so I have not.`
          : `That window would take his planned pay out of the plan ${window}, so I have not changed it.`;
    // Not his key: refused with or without confirm, and no resend is suggested,
    // because none would work. See the FOUND 2026-10-10, IN REVIEW note above.
    if (person !== "gino") {
      return refuse(
        403,
        `${PAY_FLOOR_RULE} ${what} Only Gino can change his own floor, from his own assistant; a call on this key is refused even with confirm: true.`,
      );
    }
    if (confirmed) return null;
    return refuse(
      409,
      `${PAY_FLOOR_RULE} ${what} If Gino has told you himself, in this conversation, to do it anyway, send the same call again with confirm: true.`,
    );
  }
  if (confirmed) return null;
  const what =
    change === "raise"
      ? `${name} is planned income, and raising it makes every plan and forecast count on money nobody has promised, so I have not.`
      : change === "off"
        ? `${name} is planned income, and turning it off takes it out of every plan and forecast, so I have not.`
        : `${name} is planned income, and that window would take it out of the plan ${window}, so I have not changed it.`;
  return refuse(
    409,
    `${what} If the person it belongs to has told you in this conversation to do it anyway, send the same call again with confirm: true.`,
  );
}

// ── finance.set_bill_amount ──────────────────────────────────────────────────
//
// THIS REPLACES PHASE 1'S QUEUED finance.note_known_amount, which asked for what a
// variable bill came to this month. Same write, and the reason for one name is that
// the app has one action for it (reviewApply.ts's `set-bill-amount`) and it decides
// WHICH column from the row rather than from the caller: a variable row's figure
// lives in `known_amount`, a fixed row's price is `amount`. Writing the wrong one
// leaves the old figure in force and reads as a fix that did nothing — which is
// exactly what reviewApply.ts:117-124 records.
/** set_bill_amount's bill id, amount and confirm — every problem at once. */
function planBillAmount(payload: Record<string, unknown>): Shaped<{ id: string; amount: number; confirmed: boolean }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  const amount = pad.take(amountArg(payload.amount, "I need the amount off the bill, as a number above zero."));
  const confirmed = pad.take(confirmArg(payload));
  return pad.done(() => ({ id: id!, amount: amount!, confirmed: confirmed! }));
}

const setBillAmount: Tool = {
  kind: "direct",
  does: "Record what a bill actually costs. Goes to the right column for a fixed or a variable bill. Raising an incoming row (a paycheck) needs confirm: true, and on Gino's pay floor only his own key can confirm.",
  fields: ["bill_id", "amount", "confirm"],
  example: { bill_id: EXAMPLE_ID, amount: 64.2 },
  check: (payload) => problemsOf(planBillAmount(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planBillAmount(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, amount, confirmed } = plan.value;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    const name = scrubCap(bill.name, 40) || "that bill";
    // ── AN INCOMING ROW IS PRICED AT `amount`, AND ONLY THERE ─────────────────
    // The variable/fixed split below is about BILLS: billExpected() honours
    // known_amount for an outgoing variable row. Income never reads known_amount —
    // planMath, monthlySchedule and the forecast all price an incoming row with
    // monthlyAmount(), off `amount` — so writing known_amount on a paycheck row would be
    // the fix that reads as done and changed nothing. Income goes to `amount`, compared
    // in cents so float noise cannot make a lowering look like a raise.
    if (bill.direction === "in") {
      if (Math.round(amount * 100) > Math.round(bill.amount * 100)) {
        const no = incomeChangeRefused(bill, "raise", confirmed, ctx.person);
        if (no) return no;
      }
      if (bill.amount === amount) return refuse(409, `${name} is already planned at ${dollars(amount)}.`);
      return oneRow(
        ctx,
        "finance.set_bill_amount",
        { table: "recurring", id: bill.id },
        { amount },
        { amount: bill.amount },
        `${name} is now planned at ${dollars(amount)} a time, ${movedFrom(bill.amount, amount)}.`,
        { column: "amount", was: bill.amount },
      );
    }
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
const FLOWS = ["earned", "spent", "moved", "repaid", "returned", "clear"];

/** set_flow's charge id and what the charge really is — null for "clear". */
function planFlow(payload: Record<string, unknown>): Shaped<{ id: string; next: string | null }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.transaction_id, "the charge"));
  const raw = payload.flow;
  // "clear" is spelled out rather than accepting null, because an omitted field and
  // a field meaning "undo my correction" must not be the same request.
  const asked = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!FLOWS.includes(asked)) {
    pad.no(`flow is one of: ${FLOWS.join(", ")}. "clear" puts it back to what the app works out itself.`);
  }
  return pad.done(() => ({ id: id!, next: asked === "clear" ? null : asked }));
}

const setFlow: Tool = {
  kind: "direct",
  does: "Say what a charge really is — spending, money in, a transfer between our own accounts, a debt payment, or money coming back. Overrules what the app worked out.",
  fields: ["transaction_id", "flow"],
  example: { transaction_id: EXAMPLE_ID, flow: "moved" },
  check: (payload) => problemsOf(planFlow(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planFlow(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, next } = plan.value;
    const t = await db.readCharge(id);
    if (!t) return refuse(404, "There is no charge with that id.");

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
  example: { bill_id: EXAMPLE_ID, account_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["bill_id", "the bill"], ["account_id", "the account"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["bill_id", "the bill"], ["account_id", "the account"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id, acctId] = plan.value;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");

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
/** A day of the month, the way every bill tool takes one. */
function dueDayArg(v: unknown): number | Refusal {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 31) {
    return refuse(400, "The due day is a whole number from 1 to 31.");
  }
  return v;
}

/** set_bill_due_day's bill id and day — both problems at once. */
function planDueDay(payload: Record<string, unknown>): Shaped<{ id: string; day: number }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  const day = pad.take(dueDayArg(payload.due_day));
  return pad.done(() => ({ id: id!, day: day! }));
}

const setBillDueDay: Tool = {
  kind: "direct",
  does: "Move a bill to the day of the month it actually comes out. Only for a bill that comes out on one day a month.",
  fields: ["bill_id", "due_day"],
  example: { bill_id: EXAMPLE_ID, due_day: 15 },
  check: (payload) => problemsOf(planDueDay(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planDueDay(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, day } = plan.value;
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
/** turn_bill_off's bill id, whether it should be on — off when it is left out — and
 *  confirm, every problem at once. */
function planActive(payload: Record<string, unknown>): Shaped<{ id: string; active: boolean; confirmed: boolean }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  const active = payload.active === undefined ? false : payload.active;
  if (typeof active !== "boolean") pad.no("active is either true or false.");
  const confirmed = pad.take(confirmArg(payload));
  return pad.done(() => ({ id: id!, active: active as boolean, confirmed: confirmed! }));
}

const turnBillOff: Tool = {
  kind: "direct",
  does: "Turn a bill off, or back on. Never deletes it. Turning an incoming row (a paycheck) off needs confirm: true, and on Gino's pay floor only his own key can confirm.",
  fields: ["bill_id", "active", "confirm"],
  example: { bill_id: EXAMPLE_ID, active: false },
  check: (payload) => problemsOf(planActive(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planActive(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, active, confirmed } = plan.value;
    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    if (bill.active === active) {
      return refuse(409, `${scrubCap(bill.name, 40)} is already ${active ? "on" : "off"}.`);
    }
    // Turning income OFF takes it out of every plan; turning it back on is free. See
    // incomeChangeRefused above.
    if (!active) {
      const no = incomeChangeRefused(bill, "off", confirmed, ctx.person);
      if (no) return no;
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

/**
 * set_bill_window's bill id and dates — everything that can be judged from the call.
 * A window whose two SENT dates run backwards is refused here; one that runs backwards
 * only against the date already on the bill needs the bill, so run still decides that.
 */
function planWindow(payload: Record<string, unknown>): Shaped<{ id: string; confirmed: boolean }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  const confirmed = pad.take(confirmArg(payload));
  for (const field of ["starts_on", "ends_on"] as const) {
    const v = payload[field];
    if (v !== undefined && v !== null && !isDateISO(v)) {
      pad.no(`${field} has to be a date like 2026-11-01, or null to clear it.`);
    }
  }
  if (payload.starts_on === undefined && payload.ends_on === undefined) {
    pad.no("Tell me a starts_on or an ends_on, or null to clear one.");
  }
  const s0 = payload.starts_on;
  const e0 = payload.ends_on;
  if (isDateISO(s0) && isDateISO(e0) && s0 > e0) pad.no("That window starts after it ends.");
  return pad.done(() => ({ id: id!, confirmed: confirmed! }));
}
const setBillWindow: Tool = {
  kind: "direct",
  does: "Set the first or last date a bill or an income may fire. Ending or shortening an incoming row's window (a paycheck) needs confirm: true, and on Gino's pay floor only his own key can confirm.",
  fields: ["bill_id", "starts_on", "ends_on", "confirm"],
  example: { bill_id: EXAMPLE_ID, ends_on: "2027-06-30" },
  check: (payload) => problemsOf(planWindow(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planWindow(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, confirmed } = plan.value;
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

    // ── A WINDOW THAT TAKES INCOME OUT OF THE PLAN ───────────────────────────
    // Ending an incoming row — an end date where there was none, or an earlier one —
    // stops it being planned after that day. Pushing its start into the future stops it
    // being planned until then, which is the same loss with the dates the other way
    // round, so it is held to the same confirmation. Clearing a bound, an end moved
    // later, or a start in the past takes nothing out and stays free.
    if (bill.direction === "in") {
      const endsSooner =
        "ends_on" in patch && patch.ends_on !== null && (bill.endsOn === null || String(patch.ends_on) < bill.endsOn);
      const today = azDateISO(ctx.az);
      const startsLater =
        "starts_on" in patch &&
        patch.starts_on !== null &&
        String(patch.starts_on) > today &&
        (bill.startsOn === null || String(patch.starts_on) > bill.startsOn);
      if (endsSooner || startsLater) {
        const no = incomeChangeRefused(
          bill,
          "window",
          confirmed,
          ctx.person,
          endsSooner ? `after ${String(patch.ends_on)}` : `until ${String(patch.starts_on)}`,
        );
        if (no) return no;
      }
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

// ── finance.edit_bill ────────────────────────────────────────────────────────
//
// ADDED 2026-10-10: rename a bill, or file it under another category — the two things
// about a bill NOBODY could change. FOUND that day in a scan of the door's own calls:
// bills sat in `other` while a category that fits them existed, one still carried the
// bank's all-caps name, and the only change the app has
// ever made to a bill is its variable flag. The door's bill tools change the amount,
// the account, the due day, the window and on/off; none of them touched these two.
//
// A CATEGORY CHANGE IS ONE COLUMN and goes down oneRow, like set_bill_account. It takes
// the app's own list (categoryArg) and two refusals that are the app's own idea of a
// category: `other` is the absence of one (add_bill refuses it for the same reason, from
// reviewApply.ts:159-162), and a bill going out is filed under a spending category, an
// income under an income one — the list says which is which. A transfer carries none.
//
// A RENAME IS NOT ONE COLUMN, and that is most of this tool. The name is how other things
// find the bill:
//   · a saved merchant rule of kind `bill` stores the bill it pays in `bill_name`, and
//     the importer finds the bill again with matchRecurringName;
//   · a paid mark is keyed "<label>@<day>" (schema_v3.sql), and the label is the bill's
//     name for every mark written that way;
//   · the app's own CODE knows some bills by name: the built-in bank rules
//     (categorize.ts BUILT_IN_BILL_NAMES), the old due-day table and the pre-July 2026
//     step-downs (schedule.ts DUE_DAYS, STEP_DOWNS), and the forecast's card line
//     (forecast.ts isCardName).
// The first two are rewritten IN THE SAME CHANGE: one token, and one undo that puts all
// of them back. The third is code, and a door cannot rewrite code — so a rename that
// would change what any of it finds is REFUSED, plainly, before anything is written.
// One exception, because it can be kept exactly rather than refused: a bill whose due day
// the old table knew only by its old name gets that day written onto the bill itself in
// the same step, so the calendar keeps placing it where it did.
//
// "CHANGE WHAT IT FINDS" IS CHECKED, NOT GUESSED. For every name something points at —
// each built-in rule name, each saved rule's bill_name — matchRecurringName is asked which
// bill it finds before the rename and after it, over every bill and over this bill on its
// own (the importer narrows the list to the bills live on a payment's date and account, so
// this bill alone is a real case). If the answer moves either way, the rename is refused.
// The two directions are the same bug: a rule that stops finding this bill leaves its
// payments in needs_review; a rule that starts finding it settles this bill with somebody
// else's payment — the parking charge that paid September's rent, by name.
//
// CADENCE AND DUE DAYS ARE NOT HERE, and that is a decision, made by reading
// src/lib/schedule.ts. Due days already have finance.set_bill_due_day, which refuses the
// two-part and biweekly cases for reasons it writes down. Cadence cannot be changed
// safely from here at all: quarterly, semiannual and yearly bills are placed by
// firesInMonth() from `anchor_date`, and a true biweekly by biweeklyDaysIn() from the same
// column — which no door tool writes. Without an anchor, firesInMonth() answers "fires
// every month" (so a real bill is never hidden), and the calendar prices a periodic bill
// at its FULL charge on every one of those months: a monthly bill switched to yearly
// would put its whole yearly charge into every month of the calendar and the forecast.
// Changing a cadence also re-prices the plan through monthlyAmount(). A tool that offered
// it would be one that made the calendar wrong in the common case.
type ColumnStep = Extract<UndoStep, { kind: "set_columns" }>;

/**
 * Write several one-row compare-and-sets that belong together, in order — and if one of
 * them finds its row moved, put the ones already written back before refusing.
 *
 * WHY THE PUTTING BACK. commit() marks a refused change `abandoned`, and STATE_SAYS reads
 * that out as "there is nothing for me to put back". For a rename that is only true if
 * the bill and its rules end up exactly as they were: a bill renamed while its rule still
 * names the old one is the orphan this tool exists to prevent. So a later row that moved
 * makes the earlier ones go back too, each with its own compare-and-set. `putBack` false
 * means one of THOSE had moved as well — said out loud rather than hidden.
 */
async function writeInStep(
  db: FinanceDb,
  steps: ColumnStep[],
): Promise<"ok" | { moved: number; putBack: boolean }> {
  const written: ColumnStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if ((await db.setColumns(s.table, s.id, s.after, s.before)) === "moved") {
      let putBack = true;
      for (const w of [...written].reverse()) {
        if ((await db.setColumns(w.table, w.id, w.before, w.after)) === "moved") putBack = false;
      }
      return { moved: i, putBack };
    }
    written.push(s);
  }
  return "ok";
}

/** What kind of category each id is, off the app's own list: a bill going out is filed
 *  under spending, an income under income, and a "both" category fits either. */
const CATEGORY_TYPE = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.type]));

/** The label half of a paid mark's "<label>@<day>" key, split at the LAST @ so a bill
 *  name with an @ in it still splits at the day. Null for a key with no day. */
function markLabel(key: string): { label: string; day: string } | null {
  const at = key.lastIndexOf("@");
  return at < 0 ? null : { label: key.slice(0, at), day: key.slice(at + 1) };
}

/** edit_bill's id, new name and new category — every problem with them at once. Whether
 *  the category fits THIS bill, and what a rename would move, are read off the bill. */
function planEditBill(payload: Record<string, unknown>): Shaped<{ id: string; category: string | null; typed: string | null }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.bill_id, "the bill"));
  if (payload.name === undefined && payload.category_id === undefined) {
    pad.no("Tell me the new name, the new category_id, or both. Cadence and due days are not changed here — finance.set_bill_due_day moves a due day.");
  }
  let category: string | null = null;
  if (payload.category_id !== undefined) category = pad.take(categoryArg(payload.category_id)) ?? null;
  let typed: string | null = null;
  if (payload.name !== undefined) {
    typed = scrubCap(payload.name, 40);
    if (!typed) pad.no("A bill needs a name.");
  }
  return pad.done(() => ({ id: id!, category, typed }));
}

const editBill: Tool = {
  kind: "direct",
  does: "Rename a bill, or file it under another category. A rename carries every saved merchant rule and paid mark that names the bill along with it, in one change that can be undone.",
  fields: ["bill_id", "name", "category_id"],
  // A placeholder name, for the reason on add_transaction's example.
  example: { bill_id: EXAMPLE_ID, name: "Sample streaming service", category_id: "entertainment" },
  check: (payload) => problemsOf(planEditBill(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planEditBill(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, category, typed } = plan.value;

    const bill = await db.readBill(id);
    if (!bill) return refuse(404, "There is no bill with that id.");
    const was = scrubCap(bill.name, 40) || "That bill";

    const patch: Record<string, UndoValue> = {};
    const before: Record<string, UndoValue> = {};

    if (category !== null && category !== (bill.categoryId ?? null)) {
      if (bill.direction === "transfer") {
        return refuse(409, `${was} moves money between your own accounts, so it is filed under no category — nothing would read one.`);
      }
      if (category === "other") {
        return refuse(400, "Give it a real category. `other` is the absence of one, and a bill filed there is watched by no budget line.");
      }
      const type = CATEGORY_TYPE.get(category);
      const fits = type === "both" || type === (bill.direction === "in" ? "income" : "expense");
      if (!fits) {
        return refuse(
          400,
          bill.direction === "in"
            ? `${was} is money coming in, so it goes under an income category. Ask finance.categories for the list.`
            : `${was} is a bill going out, so it goes under a spending category. Ask finance.categories for the list.`,
        );
      }
      patch.category_id = category;
      before.category_id = bill.categoryId;
    }
    // The cleaner rewrites an ellipsis as three dots, so a bill stored with one ("Card
    // payment (…1234)") sent back exactly as it reads would otherwise be "renamed" to the
    // cleaned spelling. That is the same name, and it is treated as one.
    const newName = typed !== null && typed !== bill.name && typed !== scrubCap(bill.name, 40) ? typed : null;

    if (!newName && Object.keys(patch).length === 0) {
      return refuse(409, `${was} already reads that way. Nothing to change.`);
    }

    // ── category only: one row ──────────────────────────────────────────────
    if (!newName) {
      return oneRow(
        ctx,
        "finance.edit_bill",
        { table: "recurring", id: bill.id },
        patch,
        before,
        `Filed ${was} under ${category}, from ${scrubCap(bill.categoryId, NAME_MAX) || "no category"}.`,
        { column: "category_id", was: bill.categoryId, now: category },
      );
    }

    // ── a rename ────────────────────────────────────────────────────────────
    const shown = scrubCap(newName, 40);
    const key = billKey(newName);
    if (!key) {
      return refuse(400, "A bill's name needs letters or numbers in it — the app matches bills by those, so a name without any would match nothing.");
    }
    const bills = await db.allBillNames();
    // Compared the way the app compares bill names, not by the exact string: billKey()
    // folds case and drops spaces and punctuation, and matchRecurringName resolves a name
    // through it. Two bills whose names read the same that way are two bills the app
    // cannot tell apart — the first one found would take every payment meant for both.
    const clash = bills.find((b) => b.id !== bill.id && billKey(b.name) === key);
    if (clash) {
      return refuse(
        409,
        `There is already a bill called ${scrubCap(clash.name, 40) || "that"}. Two bills whose names read the same would leave the app unable to tell which one a payment is for, so I changed nothing.`,
      );
    }

    // The calendar's pre-July 2026 prices are keyed on the EXACT name. A rename of one of
    // those — even to the same letters in other capitals — would re-price every month
    // before July; a rename TO one of those would give this bill that old price.
    if (STEP_DOWNS.has(bill.name) || STEP_DOWNS.has(newName)) {
      return refuse(
        409,
        `The calendar prices the months before July 2026 for a bill called ${STEP_DOWNS.has(bill.name) ? was : shown} by that exact name, so this rename would change what those months show. I changed nothing.`,
      );
    }
    // The forecast walks the card down by the first bill line whose name starts "Card
    // payment" (isCardName). A rename across that line either stops the card being paid
    // down in the forecast or starts paying it with the wrong bill.
    if (isCardName(bill.name) !== isCardName(newName)) {
      return refuse(
        409,
        isCardName(bill.name)
          ? `The forecast pays the card down with the bill whose name starts "Card payment", and ${was} is that bill — so renaming it to ${shown} would leave the card unpaid in every month the forecast shows. I changed nothing.`
          : `The forecast pays the card down with the bill whose name starts "Card payment", so naming ${was} ${shown} would make the forecast pay the card with this bill. I changed nothing.`,
      );
    }

    const rules = await db.billRules();
    const after = bills.map((b) => (b.id === bill.id ? { ...b, name: newName } : b));
    const alone = [{ id: bill.id, name: bill.name }];
    const aloneAfter = [{ id: bill.id, name: newName }];
    const finds = (name: string, list: readonly { id: string; name: string }[]) =>
      matchRecurringName(name, list)?.id ?? null;
    const moves = (name: string) =>
      finds(name, bills) !== finds(name, after) || finds(name, alone) !== finds(name, aloneAfter);

    // The rules that find THIS bill now are carried: their bill_name becomes the new name,
    // which finds it exactly. Every other name must find what it found before.
    const carried = rules.filter((r) => r.billName !== null && finds(r.billName, bills) === bill.id);
    const carriedIds = new Set(carried.map((r) => r.id));
    const builtIn = BUILT_IN_BILL_NAMES.find(moves);
    if (builtIn) {
      const lost = finds(builtIn, bills) === bill.id || finds(builtIn, alone) === bill.id;
      return refuse(
        409,
        `The app's own bank rules match a charge to a bill called ${scrubCap(builtIn, 40)}, by name, and renaming ${was} to ${shown} would ${lost ? "stop that rule finding it — its payments would stop settling it" : "make that rule find this bill instead"}. I changed nothing. A name that reads the same once capitals, spaces and punctuation are ignored keeps it working.`,
      );
    }
    const stray = rules.find((r) => !carriedIds.has(r.id) && r.billName !== null && moves(r.billName));
    if (stray) {
      return refuse(
        409,
        `The saved rule for ${scrubOr(stray.pattern, "a merchant", 60)} pays the bill it finds by the name ${scrubOr(stray.billName, "it was given", 40)}, and renaming ${was} to ${shown} would change which bill that is. I changed nothing. Re-teach that rule with finance.learn_merchant first, or pick a name that does not read like it.`,
      );
    }

    // A due day the old table knew only by the OLD name is written onto the row in the
    // same step, so the calendar keeps placing the bill where it did. Own-property lookups
    // only: DUE_DAYS is a plain object, and a bill called "constructor" must find nothing.
    const stored = bill.dueDays?.length ? bill.dueDays : null;
    const legacy = (name: string) => (Object.hasOwn(DUE_DAYS, name) && DUE_DAYS[name].length ? DUE_DAYS[name] : null);
    let pinned: number[] | null = null;
    if (!stored) {
      const fromOld = legacy(bill.name);
      if (fromOld) {
        pinned = [...fromOld];
        patch.due_days = pinned;
        before.due_days = bill.dueDays;
      } else if (legacy(newName)) {
        return refuse(
          409,
          `${was} has no due day of its own, and the calendar's old table gives a bill called ${shown} one — so the rename would quietly move it on the calendar. Give it its own due day first with finance.set_bill_due_day, then rename it.`,
        );
      }
    }
    patch.name = newName;
    before.name = bill.name;

    // Paid marks under the old name move with it. Marks already saved under the NEW name
    // — left by an older bill that was called that — would be read as this bill's, and
    // could collide with its own on (month, bill_key), which is unique.
    const marks = await db.paidMarks();
    const moving = marks.filter((m) => markLabel(m.billKey)?.label === bill.name);
    if (marks.some((m) => markLabel(m.billKey)?.label === newName)) {
      return refuse(
        409,
        `There are paid marks saved under the name ${shown} already, from an older bill of that name, so moving ${was}'s marks onto it would mix the two. I changed nothing.`,
      );
    }

    // The bill row FIRST, then its rules, then its marks — and the undo runs backwards.
    const steps: ColumnStep[] = [
      { kind: "set_columns", table: "recurring", id: bill.id, before, after: patch },
      ...carried.map((r): ColumnStep => ({
        kind: "set_columns",
        table: "merchant_rules",
        id: r.id,
        before: { bill_name: r.billName },
        after: { bill_name: newName },
      })),
      ...moving.map((m): ColumnStep => ({
        kind: "set_columns",
        table: "paid_bills",
        id: m.id,
        before: { bill_key: m.billKey },
        after: { bill_key: `${newName}@${markLabel(m.billKey)!.day}` },
      })),
    ];
    if (steps.length > MAX_STEPS) {
      return refuse(
        409,
        `Renaming ${was} would have to rewrite ${carried.length} saved ${carried.length === 1 ? "rule" : "rules"} and ${moving.length} paid ${moving.length === 1 ? "mark" : "marks"} along with it — more rows than I will change, and put back, in one go. I changed nothing.`,
      );
    }

    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const carriedSaid = [
      carried.length ? plural(carried.length, "saved merchant rule", "saved merchant rules") : "",
      moving.length ? plural(moving.length, "paid mark", "paid marks") : "",
    ].filter(Boolean);
    return commit(ctx, "finance.edit_bill", {
      steps,
      summary:
        `Renamed ${was} to ${shown}` +
        (patch.category_id !== undefined ? ` and filed it under ${category}` : "") +
        "." +
        (carriedSaid.length ? ` Its ${carriedSaid.join(" and ")} now name it that way too.` : ""),
      // Not stored: true when said, and about the calendar rather than about the change.
      note: pinned
        ? `Its due day (${pinned.join(" and ")}) is now stored on the bill itself — the app's old table knew it only by the old name.`
        : undefined,
      result: {
        id: bill.id,
        name: shown,
        was_name: was,
        category_id: patch.category_id !== undefined ? category : bill.categoryId,
        rules_carried: carried.length,
        paid_marks_carried: moving.length,
        due_days_pinned: pinned,
      },
      rowIds: [bill.id, ...carried.map((r) => r.id), ...moving.map((m) => m.id)],
      async write() {
        const hit = await writeInStep(db, steps);
        if (hit === "ok") return;
        return refuse(
          409,
          hit.putBack
            ? `Something changed ${hit.moved === 0 ? was : "a rule or a paid mark that names it"} while I was renaming it, so I put back what I had already changed and changed nothing. Read it again and ask me once more.`
            : `Something changed a row that names ${was} while I was renaming it, and one I had already changed had moved again too — so it may not all be back. Have a look at ${was} in the app before asking me again.`,
        );
      },
    });
  },
};

// ── finance.add_bill ─────────────────────────────────────────────────────────

/** add_bill's six fields — every problem with any of them, in one answer. */
function planBill(payload: Record<string, unknown>): Shaped<{
  name: string;
  amount: number;
  dueDay: number;
  cadence: string;
  direction: "out" | "in";
  category: string;
}> {
  const pad = problemPad();
  const name = scrubCap(payload.name, 40);
  if (!name) pad.no("That bill needs a name.");
  const amount = pad.take(amountArg(payload.amount, "That amount does not look right."));
  const dueDay = pad.take(dueDayArg(payload.due_day));
  const cadence = pad.take(cadenceArg(payload.cadence));
  const direction = payload.direction === undefined ? "out" : payload.direction;
  if (direction !== "out" && direction !== "in") pad.no("direction is out or in.");
  const category = pad.take(categoryArg(payload.category_id));
  // PORTED from reviewApply.ts:159-162. A bill row landing in an ungraded category
  // is the exact defect the app's orphan-category self-check exists to catch, and
  // `other` is the ABSENCE of a category rather than a category.
  if (category === "other") {
    pad.no("Give it a real category first. `other` is the absence of one, and a bill filed there is watched by no budget line.");
  }
  return pad.done(() => ({
    name,
    amount: amount!,
    dueDay: dueDay!,
    cadence: cadence!,
    direction: direction as "out" | "in",
    category: category!,
  }));
}
const addBill: Tool = {
  kind: "direct",
  does: "Model a repeating charge as a bill.",
  fields: ["name", "amount", "due_day", "cadence", "category_id", "direction"],
  // A placeholder name — see add_transaction's example for why.
  example: { name: "Sample subscription", amount: 25, due_day: 3, cadence: "monthly", category_id: "entertainment" },
  check: (payload) => problemsOf(planBill(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planBill(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name, amount, dueDay, cadence, direction, category } = plan.value;

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
// AND THE COUNT LOOKS IN BOTH PLACES THE LABELLER LOOKS. FOUND LATER ON 2026-10-09: the
// first version counted only merchantKey(description), and learnedFor() has a second
// namespace — the bank's raw line with its statement noise stripped. A charge with no
// clean merchant name carries the bank's line AS its description ("CHECKCARD 1006 BLUE
// HERON BAKERY 199 …"), whose key is the useless "CHECKCARD", while the rule that labels
// it is saved under the stripped key ("BLUE HERON BAKERY"). So a correct rule was told it
// matched nothing; on a re-count that evening, two of the saved rules the first version
// would have called dead were exactly this. The door may not read raw_description, so
// it applies learnedFor's second lookup to the description instead, which for exactly
// those charges IS the bank's line. What it still cannot see is the raw line behind a
// charge that has a clean name, so a zero is now said as "no charge I can see", not as
// a certainty. And because learnedFor() takes the name's own key FIRST, a charge counted
// only through the stripped key belongs to this rule only while its own key has no rule
// of its own — and with "CHECKCARD -> dining" still saved that day, it did not. The
// reply says how many such charges another rule answers first, and names that rule
// (FOUND IN REVIEW, same day).
//
// AND A RULE ON THE BANK'S OWN WORDING CAPTURES EVERYTHING. A "CHECKCARD -> dining"
// rule, saved from one tap in the app on 2026-09-24, files every Bank of America card
// line with no clean name as dining. Refused here, in the app, and in promote_to_bill,
// all through one predicate (isStatementNoiseKey in categorize.ts).

/**
 * What learn_merchant says when some of the charges it counted are filed by another
 * rule first — see "WHICH OF THOSE CHARGES ANOTHER RULE GETS TO FIRST" in the tool.
 *
 * `name` is already safe to say (the tool worked that out), and `named` holds only the
 * keys the cleaner said back exactly; a rule whose key could not be said is still
 * counted, as "another saved rule", so the sentence never claims fewer than there are.
 * About what comes NEXT, like the rest of the reply: learning a rule relabels nothing.
 */
function shadowNote(name: string, matches: number, shadowed: number, rules: number, named: string[]): string {
  const which = shadowed === matches
    ? matches === 1 ? "the one charge" : `all ${matches} charges`
    : `${shadowed} of the ${matches} charges`;
  const unnamed = rules - named.length;
  const ruleWords = named.length === 0
    ? rules === 1 ? "another saved rule" : `${rules} other saved rules`
    : `the saved ${rules === 1 ? "rule" : "rules"} on ${named.join(", ")}` +
      (unnamed > 0 ? ` and ${unnamed} more` : "");
  const one = rules === 1;
  return scrubCap(
    `But ${which} I can see under ${name} first ${shadowed === 1 ? "matches" : "match"} ${ruleWords}, which the app checks before this one — so charges that read like ${shadowed === 1 ? "it" : "those"} will keep being filed by ${one ? "that rule" : "those rules"}, not this one, until ${one ? "it is" : "they are"} forgotten (finance.forget_merchant).`,
    // A 60-character name, three 60-character keys and the sentence around them.
    520,
  );
}

/**
 * Everything learn_merchant can judge before it reads anything: the id's shape, a typed
 * merchant when there is no id (and that it is not the bank's own wording), the kind,
 * and the category or bill name the kind needs. Said together. What depends on the
 * charge — its name, and whether that name is the bank's wording — is still decided in
 * run, after the charge is read.
 */
function planRule(payload: Record<string, unknown>): Shaped<null> {
  const pad = problemPad();
  if (payload.transaction_id !== undefined) {
    pad.take(idArg(payload.transaction_id, "the charge"));
  } else {
    const typed = payload.merchant === undefined ? "" : scrubCap(payload.merchant, 60);
    const key = typed ? merchantKey(typed) : "";
    if (!typed) {
      pad.no("Tell me the merchant, as it reads on the charge — or give me the charge's transaction_id and I will read the name off it.");
    } else if (!key) {
      pad.no("There was nothing left of that merchant name once it was normalised.");
    } else if (isStatementNoiseKey(key)) {
      pad.no(
        `${typed} is how the bank labels a kind of charge, not a merchant. A rule on it would catch every charge the bank labels that way, whoever was paid, so I will not teach it. Put the charge in a category on its own instead.`,
      );
    }
  }
  const kind = payload.kind;
  if (kind !== "variable" && kind !== "bill" && kind !== "skip") {
    pad.no("kind is variable (ordinary spending), bill (it pays a bill), or skip (drop it from the ledger).");
  }
  if (kind === "variable") {
    const cat = pad.take(categoryArg(payload.category_id));
    if (cat === "other") {
      pad.no("I will not teach `other` for a merchant — that stops the app ever trying on it again. Filing one charge there is fine; teaching it is not.");
    }
  } else if (kind === "bill" && !scrubCap(payload.bill_name, 40)) {
    pad.no("For a bill rule I need the name of the bill it pays.");
  }
  return pad.done(() => null);
}

const learnMerchant: Tool = {
  kind: "direct",
  does: "Teach the app what a merchant is, so future charges label themselves. Give the charge's transaction_id and the name is read off the charge exactly.",
  fields: ["merchant", "transaction_id", "kind", "category_id", "bill_name"],
  example: { transaction_id: EXAMPLE_ID, kind: "variable", category_id: "groceries" },
  check: (payload) => problemsOf(planRule(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planRule(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
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
    //
    // TWO KEYS PER CHARGE, mirroring learnedFor()'s two lookups (see the note above the
    // tool): the name's own key, and the key of the name with the bank's statement noise
    // stripped off — the app's own stripStatementNoise, not a copy. The second is only
    // taken when stripping leaves something, exactly as learnedFor() skips an empty one.
    // A charge counts once however many of its keys match, and a key it carries that
    // merely STARTS with the pattern is offered below as a suggestion, from either side.
    const near = new Map<string, number>();
    let matchesNow = 0;
    // The charges that matched ONLY through the stripped key, counted by their own key
    // — what learnedFor() looks up before it ever gets to the stripped one. See below.
    const viaStripped = new Map<string, number>();
    for (const chargeName of await db.chargeNames()) {
      const key = merchantKey(chargeName);
      const stripped = stripStatementNoise(chargeName);
      const strippedKey = stripped ? merchantKey(stripped) : "";
      if (key === pattern) {
        matchesNow += 1;
        continue;
      }
      if (strippedKey === pattern) {
        matchesNow += 1;
        viaStripped.set(key, (viaStripped.get(key) ?? 0) + 1);
        continue;
      }
      if (key.startsWith(pattern)) near.set(key, (near.get(key) ?? 0) + 1);
      if (strippedKey && strippedKey !== key && strippedKey.startsWith(pattern)) {
        near.set(strippedKey, (near.get(strippedKey) ?? 0) + 1);
      }
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

    // WHICH OF THOSE CHARGES ANOTHER RULE GETS TO FIRST. FOUND IN REVIEW 2026-10-09,
    // the same day the stripped key was added to the count. learnedFor() looks the
    // name's own key up FIRST and returns at a hit; the stripped lookup only runs when
    // the own key has no rule at all. So a charge counted above only through its
    // stripped key is filed by the rule on its OWN key whenever there is one, and this
    // rule never reaches it. That was not hypothetical: the "CHECKCARD -> dining" rule
    // was still saved that day, and every card line with no clean name keys to CHECKCARD
    // before anything else — so a correct rule on the merchant behind those lines was counted
    // here, the reply said nothing, and every one of its charges kept landing as dining.
    // The FIRESTONE mistake in the other direction: the count said yes where the app
    // says no.
    //
    // One single-row read of merchant_rules per DISTINCT own key, the same read the tool
    // made above for the pattern itself. They are few: when stripping is what made a
    // charge match, its own key is where merchantKey() stopped — the bank's prefix word,
    // "CHECKCARD" and its cousins — not one per charge. Still before anything is written,
    // so a read that fails here saves no rule, like the ledger read above.
    //
    // matches_now keeps its meaning — the charges I can see that carry this key — and
    // `shadowed` says how many of them another rule answers first. The note names that
    // rule's key and the tool that takes it away, because forgetting it is the fix.
    const shadowers: { key: string; charges: number }[] = [];
    for (const [ownKey, charges] of viaStripped) {
      if (await db.readMerchantRule(ownKey)) shadowers.push({ key: ownKey, charges });
    }
    shadowers.sort((a, b) => b.charges - a.charges || a.key.localeCompare(b.key));
    const shadowed = shadowers.reduce((n, s) => n + s.charges, 0);
    // A key is only named if the cleaner says it back exactly, as with the suggestions
    // above: a name that came back changed would send the forget to the wrong rule.
    const shadowedBy = shadowers
      .map((s) => scrub(s.key, 60))
      .filter((said, i): said is string => said === shadowers[i].key)
      .slice(0, 3);

    // Through the cleaner as a whole as well as piece by piece, so "which strings out
    // were scrubbed" is never a judgement call made line by line.
    //
    // "No charge I can see", not "no charge": the door reads each charge's name and never
    // the bank's raw line behind it, which learnedFor() also checks. A zero here is the
    // door's best reading, and the sentence says so rather than claiming a certainty it
    // has no way to have — the same mistake as the "Taught the app…" this note exists for,
    // in the other direction.
    const note = matchesNow > 0
      ? shadowed > 0
        ? shadowNote(name, matchesNow, shadowed, shadowers.length, shadowedBy)
        : undefined
      : scrubCap(
          `But no charge I can see reads exactly ${name}, so this rule may match nothing yet — a rule only matches the whole name as it reads on the charge. I see each charge's name but not the bank's own line behind it, which the app also checks.` +
            (closest.length
              ? ` Charges that start with it read: ${closest.join("; ")}. Teach one of those, or give me the charge's transaction_id and I will read its name off it.`
              : " Give me the charge's transaction_id and I will read its name off it."),
          // Room for the longest case whole — a 60-character name and three 28-character
          // keys — now that the sentence also says what the door cannot see. A cap that
          // cut it would cut the instruction at the end, which is the useful half.
          520,
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
        { merchant, replaced: existing.kind, matches_now: matchesNow, shadowed, shadowed_by: shadowedBy, closest },
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
      result: { id, merchant, kind, matches_now: matchesNow, shadowed, shadowed_by: shadowedBy, closest },
      rowIds: [id],
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.forget_merchant ──────────────────────────────────────────────────
//
// ADDED 2026-10-09. The door could teach a rule and change one, and could not remove
// one. That mattered most for exactly the rules learn_merchant now refuses to save: a
// "CHECKCARD -> dining" rule, made from one tap in the app, files every card line with
// no clean name as dining, and a rule beats every built-in one. The refusal stopped new
// ones; the one already saved could only be taken out with raw SQL — which leaves no
// audit row, no token and no way back.
//
// SO THIS ACCEPTS THE BANK'S OWN WORDING, deliberately. isStatementNoiseKey is the gate
// on SAVING a rule, because a rule on "CHECKCARD" catches everything; removing one is
// the cure for that, and refusing it here would leave the worst rules as the only ones
// nothing can touch.
//
// THE KEY IS WORKED OUT EXACTLY AS learn_merchant WORKS IT OUT — the typed name through
// the cleaner, then the app's own merchantKey() — so "forget what I just taught" lands
// on the same row "teach" wrote. The reply names the rule's own key, not what was typed,
// so a forget that landed somewhere unexpected says where.
//
// THE DELETE IS A COMPARE-AND-SET on the three answers that were read: a rule re-taught
// on the phone between the read and the write keeps its id (the app upserts on the
// pattern) and changes its answer, and deleting it then would throw away the newer one.
//
// AND IT IS UNDONE BY A NAMED INVERSE, not a data step — financeUndo.ts says why. The
// before-state is written to muse_undo BEFORE the delete, like every write in this file,
// so even a door that dies mid-call leaves the rule's whole content recorded. The undo
// puts it back under the same id, and refuses rather than overwrite if the merchant has
// been given a rule again since.
/** forget_merchant's merchant, as the key the rule is saved under. */
function planForgetRule(payload: Record<string, unknown>): Shaped<string> {
  const pad = problemPad();
  const typed = payload.merchant === undefined ? "" : scrubCap(payload.merchant, 60);
  const pattern = typed ? merchantKey(typed) : "";
  if (!typed) {
    pad.no("Tell me the merchant the rule is saved under — finance.merchant_rules lists them, by the names they match.");
  } else if (!pattern) {
    pad.no("There was nothing left of that merchant name once it was normalised.");
  }
  return pad.done(() => pattern);
}

const forgetMerchant: Tool = {
  kind: "direct",
  does: "Stop applying a saved merchant rule. Charges already filed keep their category.",
  fields: ["merchant"],
  example: { merchant: "Sample Bakery" },
  check: (payload) => problemsOf(planForgetRule(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planForgetRule(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const pattern = plan.value;
    // NO isStatementNoiseKey HERE. See above: removing a rule on the bank's wording is
    // the main thing this tool is for.

    const rule = await db.readMerchantRule(pattern);
    if (!rule) {
      return refuse(
        404,
        `There is no saved rule for ${scrubOr(pattern, "that merchant", 60)}, so there is nothing to forget. finance.merchant_rules lists the ones there are, by the exact names they match.`,
      );
    }

    // The rule's own key, out of the database, so through the cleaner like every other
    // string out. Two fallbacks, as in learn_merchant: a sentence needs words, and the
    // structured field needs to say plainly that the key was withheld.
    const name = scrubOr(rule.pattern, "that merchant", 60);
    const merchant = scrubOr(rule.pattern, "(a merchant key I cannot say safely)", 60);
    // True of the app's own rule as well: a rule labels what arrives next and never
    // relabels a row already in the ledger. So forgetting it changes no charge, and the
    // undo — putting the rule back — is the whole of the inverse.
    const summary =
      `Forgot the rule for ${name}. The app will stop ${ruleHabit(rule)}. ` +
      "Charges already filed keep their category; only the ones that come next are labelled without it.";

    return commit(ctx, "finance.forget_merchant", {
      // Everything a rule IS, as it sits in the table — raw, not cleaned, because the
      // undo has to write back exactly what was there. Never emitted: system.changes
      // says how many rows a change touched, not what was in them.
      steps: [
        {
          kind: "run_handler",
          handler: MERCHANT_RULE_INSERT,
          before: {
            id: rule.id,
            pattern: rule.pattern,
            kind: rule.kind,
            category_id: rule.categoryId,
            bill_name: rule.billName,
          },
        },
      ],
      summary,
      result: {
        id: rule.id,
        merchant,
        kind: scrubName(rule.kind, 16) || null,
        category_id: rule.categoryId ? scrubName(rule.categoryId, NAME_MAX) || null : null,
        bill_name: rule.billName ? scrubOr(rule.billName, "a bill", 40) : null,
      },
      rowIds: [rule.id],
      async write() {
        const hit = await db.deleteRow("merchant_rules", rule.id, {
          kind: rule.kind,
          category_id: rule.categoryId,
          bill_name: rule.billName,
        });
        if (hit === "moved") {
          return refuse(
            409,
            `The rule for ${name} changed while I was working on it — it was taught again or removed — so I stopped and forgot nothing. Read finance.merchant_rules again and ask me once more.`,
          );
        }
      },
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
/** set_account_balance's account id and balance — both problems at once. */
function planBalance(payload: Record<string, unknown>): Shaped<{ id: string; balance: number }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.account_id, "the account"));
  const balance = money(payload.balance);
  if (balance === null || balance < -100_000 || balance > 1_000_000) pad.no("I need the balance as a number.");
  return pad.done(() => ({ id: id!, balance: balance! }));
}

const setAccountBalance: Tool = {
  kind: "direct",
  does: "Set an account's balance by hand. This is the number every other figure is derived from.",
  fields: ["account_id", "balance"],
  example: { account_id: EXAMPLE_ID, balance: 250 },
  check: (payload) => problemsOf(planBalance(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planBalance(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, balance } = plan.value;
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

/** add_debt's name, balance, APR and minimum — every problem with them. */
function planDebt(payload: Record<string, unknown>): Shaped<{
  name: string;
  balance: number;
  apr: number | null;
  minPayment: number | null;
}> {
  const pad = problemPad();
  const name = scrubCap(payload.name, 40);
  if (!name) pad.no("That debt needs a name.");
  const balance = money(payload.balance);
  if (balance === null || balance < 0 || balance > 1_000_000) pad.no("I need what is owed, as a number of zero or more.");
  let apr: number | null = null;
  if (payload.apr !== undefined && payload.apr !== null) {
    apr = money(payload.apr);
    if (apr === null || apr < 0 || apr > 100) pad.no("The APR is a percentage between 0 and 100.");
  }
  let minPayment: number | null = null;
  if (payload.min_payment !== undefined && payload.min_payment !== null) {
    minPayment = money(payload.min_payment);
    if (minPayment === null || minPayment < 0 || minPayment > 100_000) pad.no("The minimum payment is a number of zero or more.");
  }
  return pad.done(() => ({ name, balance: balance!, apr, minPayment }));
}
const addDebt: Tool = {
  kind: "direct",
  does: "Add a debt to track.",
  fields: ["name", "balance", "apr", "min_payment"],
  example: { name: "Sample store card", balance: 300, apr: 24.99, min_payment: 25 },
  check: (payload) => problemsOf(planDebt(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planDebt(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { name, balance, apr, minPayment } = plan.value;

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

/**
 * When a debt was closed, null while it is open — or undefined when the database has no
 * `closed_at` column yet (supabase/schema_v44_debt_closed.sql not run).
 *
 * The one failure worth naming, exactly as finance.refresh_bank names schema_v39's: the
 * column is not there. It is recognised by the column's name in Postgres's own message,
 * which the wiring's label deliberately does not carry. Anything else is a real failure
 * and goes on to the handler's 500 — a door that answered "not set up" to every error
 * would hide an outage behind a setup instruction.
 *
 * What undefined MEANS is the caller's call: edit_debt cannot close a debt without the
 * column, so it refuses; link_debt_to_card reads it as open, which is true — nothing can
 * have closed a debt on a database that cannot record it.
 */
async function readClosedAt(db: FinanceDb, id: string): Promise<string | null | undefined> {
  try {
    return await db.readDebtClosedAt(id);
  } catch (e) {
    if (/closed_at/.test(String((e as Error)?.message ?? e))) return undefined;
    throw e;
  }
}

// ── finance.link_debt_to_card ────────────────────────────────────────────────
//
// Pointing a debt at a connected card makes the bank drive its balance: the DB trigger
// keeps it in sync from there. So the write is TWO columns — the link and a snap of
// the card's current balance (FinanceStore.tsx:1254) — and the undo puts both back.
//
// A CLOSED DEBT IS REFUSED. FOUND in review 2026-10-10: edit_debt refuses to close a debt
// that follows a card, so a finished debt cannot quietly owe money again — and this tool
// was the other way into exactly that state. It copies the card's balance onto the debt
// on the spot and never touches closed_at, so a paid-off card used again and linked here
// read as `closed: true` with real money owed, and API.md tells the assistant to call a
// closed debt finished. Re-opening first (finance.edit_debt, closed false) is one call,
// and it keeps "closed" meaning one thing. A database without the column reads every
// debt as open (readClosedAt), so this check costs nothing there.
const linkDebtToCard: Tool = {
  kind: "direct",
  does: "Point a debt at a connected credit card, so the bank keeps its balance current. A closed debt is refused — re-open it first with finance.edit_debt.",
  fields: ["debt_id", "account_id"],
  example: { debt_id: EXAMPLE_ID, account_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["debt_id", "the debt"], ["account_id", "the account"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["debt_id", "the debt"], ["account_id", "the account"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [debtId, acctId] = plan.value;
    const [debt, acct, closedAt] = await Promise.all([
      db.readDebt(debtId),
      db.readAccount(acctId),
      readClosedAt(db, debtId),
    ]);
    if (!debt) return refuse(404, "There is no debt with that id.");
    if (!acct) return refuse(404, "There is no account with that id.");
    if (closedAt) {
      return refuse(
        409,
        `${scrubCap(debt.name, 40) || "That debt"} is closed — it was marked finished — so it cannot start following a card while it reads that way. Re-open it first with finance.edit_debt (closed: false), then link it. I changed nothing.`,
      );
    }
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
  example: { debt_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["debt_id", "the debt"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["debt_id", "the debt"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [debtId] = plan.value;
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

// ── finance.edit_debt ────────────────────────────────────────────────────────
//
// ADDED 2026-10-10. The debt tools could add a debt and point it at a card, and nothing —
// not the door, not the app (FinanceStore.tsx has addDebt, link and unlink, and no update)
// — could change one. FOUND in that day's scan of the door's calls: the card's minimum
// payment changes after every statement, finance.debts reads the stored minimum out loud,
// and the stored one could only be corrected with raw SQL, which leaves no audit row and
// no way back. So: the name, the minimum, the rate, and closing a finished debt.
//
// ONE ROW, ONE COMPARE-AND-SET, ONE UNDO, through oneRow like set_bill_account — however
// many of the four are changed at once. Each field has three spellings, the rule
// set_bill_window follows: absent leaves it alone, a value sets it, and null clears the
// minimum or the rate (a debt with no rate on record is a different state from 0%).
//
// WHAT EACH ONE MOVES, said in the reply because a person cannot see it from a chat:
//   · the MINIMUM is read by the debt list and nothing else. What the plan sets aside for
//     a card each month is the amount on the bill that pays it (plannedMonthly reads the
//     bill, and set_bill_amount changes that one). The reply says so, so "I updated the
//     minimum" is not heard as "the plan now pays it".
//   · the RATE is what payoffSchedule() and the forecast charge interest at, so the payoff
//     projection moves with it.
//   · the NAME is how ATTACK_ORDER in plan.ts puts the debts in order, by exact string. A
//     rename of a debt on that list would drop it to the back of the payoff order — and a
//     rename onto it would pull another debt forward — so both are refused, plainly.
//
// CLOSING IS A FLAG, NEVER A DELETE — `closed_at`, from supabase/schema_v44_debt_closed.sql,
// which this commit adds and does not run. Until it is run the column is missing, and
// closing or re-opening is refused with a sentence that names the file; everything else
// here still works, because closed_at is read on its own (readDebtClosedAt) and only when
// asked for. Two refusals, both about money that is still moving:
//   · a debt that still shows money owed. Closing it would take real money out of the
//     payoff plan and the debt total, with nothing in the ledger saying it was paid.
//   · a debt that still follows a card. The bank sets its balance on every sync
//     (schema_v12's trigger), so a card used again would quietly owe money on a debt
//     marked finished. Unlinking first (finance.unlink_debt_card) is the honest order.
// At a zero balance nothing the app adds up moves either way: the plan and the payoff
// already skip a debt at zero, and the calendar already drops the bill that pays it.
/**
 * edit_debt's id and its four changes — every problem with any of them, before anything
 * is read, so a bad field costs no round trip and none of the hour.
 *
 * Both money columns hold two decimals (numeric(12,2) and numeric(6,2)), so a figure is
 * taken to the cent HERE, before it is written: the undo compares what is stored against
 * what this call wrote, and 140.005 written is 140.01 stored — an undo that would then
 * refuse as "changed since" about a row nothing touched.
 */
function planEditDebt(payload: Record<string, unknown>): Shaped<{
  id: string;
  typed: string | null;
  minPayment: number | null | undefined;
  apr: number | null | undefined;
}> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.debt_id, "the debt"));
  if (
    payload.name === undefined &&
    payload.min_payment === undefined &&
    payload.apr === undefined &&
    payload.closed === undefined
  ) {
    pad.no("Tell me what to change: name, min_payment, apr (null clears either of those two), or closed (true or false).");
  }
  let typed: string | null = null;
  if (payload.name !== undefined) {
    typed = scrubCap(payload.name, 40);
    if (!typed) pad.no("A debt needs a name.");
  }
  const cents = (n: number) => Math.round(n * 100) / 100;
  let minPayment: number | null | undefined;
  if (payload.min_payment !== undefined) {
    minPayment = payload.min_payment === null ? null : money(payload.min_payment);
    if (payload.min_payment !== null && (minPayment === null || minPayment < 0 || minPayment > 100_000)) {
      pad.no("The minimum payment is a number of zero or more, or null to clear it.");
    } else if (minPayment !== null) minPayment = cents(minPayment);
  }
  let apr: number | null | undefined;
  if (payload.apr !== undefined) {
    apr = payload.apr === null ? null : money(payload.apr);
    if (payload.apr !== null && (apr === null || apr < 0 || apr > 100)) {
      pad.no("The APR is a percentage between 0 and 100, or null to clear it.");
    } else if (apr !== null) apr = cents(apr);
  }
  if (payload.closed !== undefined && typeof payload.closed !== "boolean") {
    pad.no("closed is either true or false.");
  }
  return pad.done(() => ({ id: id!, typed, minPayment, apr }));
}

const editDebt: Tool = {
  kind: "direct",
  does: "Change a debt's name, minimum payment or interest rate (null clears the minimum or the rate), or close a paid-off debt without deleting it — closed true, or false to re-open it.",
  fields: ["debt_id", "name", "min_payment", "apr", "closed"],
  example: { debt_id: EXAMPLE_ID, min_payment: 35 },
  check: (payload) => problemsOf(planEditDebt(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    // Every shape is checked before anything is read, so a bad field costs no round trip.
    const plan = planEditDebt(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, typed, minPayment, apr } = plan.value;

    const debt = await db.readDebt(id);
    if (!debt) return refuse(404, "There is no debt with that id.");
    const label = scrubCap(debt.name, 40) || "That debt";
    const patch: Record<string, UndoValue> = {};
    const before: Record<string, UndoValue> = {};
    const said: string[] = [];
    const notes: string[] = [];

    // Same rule as edit_bill: a name the cleaner merely re-spells is the same name.
    const newName = typed !== null && typed !== debt.name && typed !== scrubCap(debt.name, 40) ? typed : null;
    const now = newName ? scrubCap(newName, 40) : label;
    if (newName) {
      const ordered = ATTACK_ORDER.includes(debt.name);
      if (ordered || ATTACK_ORDER.includes(newName)) {
        return refuse(
          409,
          ordered
            ? `The payoff plan puts the debts in order by their exact names, and ${label} is one of them — renaming it would drop it to the back of that order. I changed nothing.`
            : `The payoff plan puts the debts in order by their exact names, and ${now} is one of those names — renaming ${label} to it would move it up the order. I changed nothing.`,
        );
      }
      const same = (a: string) => a.trim().toLowerCase() === newName.trim().toLowerCase();
      const clash = (await db.allDebtNames()).find((d) => d.id !== debt.id && same(d.name));
      if (clash) return refuse(409, `There is already a debt called ${scrubCap(clash.name, 40) || "that"}.`);
      patch.name = newName;
      before.name = debt.name;
      said.push(`Renamed ${label} to ${now}.`);
    }

    if (minPayment !== undefined && minPayment !== debt.minPayment) {
      patch.min_payment = minPayment;
      before.min_payment = debt.minPayment;
      said.push(
        minPayment === null
          ? `${now} has no minimum payment recorded any more (it was ${dollars(debt.minPayment ?? 0)}).`
          : debt.minPayment === null
            ? `${now}'s minimum payment is now ${dollars(minPayment)}, where none was recorded before.`
            : `${now}'s minimum payment is now ${dollars(minPayment)}, ${movedFrom(debt.minPayment, minPayment)}.`,
      );
      notes.push(
        "Only the debt list reads the minimum. What the plan sets aside for this debt each month is the amount on the bill that pays it, which finance.set_bill_amount changes.",
      );
    }

    if (apr !== undefined && apr !== debt.apr) {
      patch.apr = apr;
      before.apr = debt.apr;
      said.push(
        apr === null
          ? `${now} has no interest rate recorded any more (it was ${debt.apr}%).`
          : debt.apr === null
            ? `${now}'s interest rate is now ${apr}%, where none was recorded before.`
            : `${now}'s interest rate is now ${apr}%, ${apr > debt.apr ? "up" : "down"} from ${debt.apr}%.`,
      );
      notes.push("The payoff plan charges interest at this rate, so its projection moves with it.");
    }

    if (payload.closed !== undefined) {
      // readClosedAt says which failure is "the column is not there yet" and lets every
      // other one through to the handler's 500.
      const closedAt = await readClosedAt(db, debt.id);
      if (closedAt === undefined) {
        return refuse(
          503,
          "I cannot close or re-open a debt yet: the database is missing the column that records it " +
            "(schema_v44_debt_closed.sql has not been run). The name, the minimum payment and the rate can " +
            "still be changed — I changed nothing this time.",
        );
      }
      if (payload.closed && !closedAt) {
        if (Math.round(debt.balance * 100) > 0) {
          return refuse(
            409,
            `${label} still shows ${dollars(debt.balance)} owed, so closing it would take money that is owed out of the payoff plan. Close it once it reads $0.00. I changed nothing.`,
          );
        }
        if (debt.providerAccountId) {
          return refuse(
            409,
            `${label} still follows a card, so the bank sets its balance on every sync — a card used again would owe money on a debt marked finished. Stop it following the card first (finance.unlink_debt_card). I changed nothing.`,
          );
        }
        patch.closed_at = ctx.at.toISOString();
        before.closed_at = null;
        said.push(`Closed ${now}. It stays in the app at ${dollars(0)} with its history — it is finished, not deleted.`);
      } else if (!payload.closed && closedAt) {
        patch.closed_at = null;
        before.closed_at = closedAt;
        said.push(`Re-opened ${now}.`);
      }
    }

    if (Object.keys(patch).length === 0) {
      return refuse(409, `${label} already reads that way. Nothing to change.`);
    }
    return oneRow(
      ctx,
      "finance.edit_debt",
      { table: "debts", id: debt.id },
      patch,
      before,
      said.join(" "),
      {
        name: now,
        min_payment: "min_payment" in patch ? patch.min_payment : debt.minPayment,
        apr: "apr" in patch ? patch.apr : debt.apr,
        ...("closed_at" in patch ? { closed: patch.closed_at !== null } : {}),
        changed: Object.keys(patch),
      },
      notes.length ? notes.join(" ") : undefined,
    );
  },
};

// ── the two set-aside writes ─────────────────────────────────────────────────

/** set_aside's charge id and reason — both problems at once. */
function planSetAside(payload: Record<string, unknown>): Shaped<{ id: string; reason: "excluded" | "reimbursable" }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.transaction_id, "the charge"));
  const reason = payload.reason;
  if (reason !== "excluded" && reason !== "reimbursable") {
    pad.no("reason is excluded (not your budget) or reimbursable (owed back to you).");
  }
  return pad.done(() => ({ id: id!, reason: reason as "excluded" | "reimbursable" }));
}

const setAside: Tool = {
  kind: "direct",
  does: "Set a charge aside — out of the budget but still visible — as excluded or as owed back to you.",
  fields: ["transaction_id", "reason", "note"],
  example: { transaction_id: EXAMPLE_ID, reason: "reimbursable", note: "Work lunch" },
  check: (payload) => problemsOf(planSetAside(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planSetAside(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, reason } = plan.value;
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

/** settle_reimbursable's charge id and, when it was sent, the deposit's. */
function planSettle(payload: Record<string, unknown>): Shaped<{ id: string; creditId: string | null }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.transaction_id, "the charge"));
  const creditId = payload.credit_transaction_id === undefined
    ? null
    : pad.take(idArg(payload.credit_transaction_id, "the deposit"));
  return pad.done(() => ({ id: id!, creditId: creditId ?? null }));
}

const settleReimbursable: Tool = {
  kind: "direct",
  does: "Mark a reimbursable as paid back, optionally linking the deposit that paid it.",
  fields: ["transaction_id", "credit_transaction_id"],
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planSettle(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planSettle(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id } = plan.value;
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
    if (plan.value.creditId !== null) {
      credit = await db.readCharge(plan.value.creditId);
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
  example: { transaction_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planIds(payload, ["transaction_id", "the charge"])),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planIds(payload, ["transaction_id", "the charge"]);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const [id] = plan.value;
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
/** promote_to_bill's charge id and cadence — both problems at once. */
function planPromote(payload: Record<string, unknown>): Shaped<{ id: string; cadence: string }> {
  const pad = problemPad();
  const id = pad.take(idArg(payload.transaction_id, "the charge"));
  const cadence = pad.take(cadenceArg(payload.cadence));
  return pad.done(() => ({ id: id!, cadence: cadence! }));
}

const promoteToBill: Tool = {
  kind: "direct",
  does: "Turn a repeating charge into a bill, attach this charge to it, and remember the merchant.",
  fields: ["transaction_id", "cadence"],
  example: { transaction_id: EXAMPLE_ID, cadence: "monthly" },
  check: (payload) => problemsOf(planPromote(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planPromote(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const { id, cadence } = plan.value;
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

// ── finance.confirm_charges ──────────────────────────────────────────────────
//
// ADDED 2026-10-10. "Yes, these are right" for many charges in one call.
//
// WHY. A scan of the door's real calls on 2026-10-10 found a backlog of charges flagged
// for review, most of them at a handful of merchants and already filed in the right
// category. The only way through the door to clear a flag was finance.categorize_charge,
// one charge per call, against a cap of 60 writes an hour — hours of the cap just to say
// "yes" to each. The app's review screen, the one place that could do it faster, is
// being retired.
//
// TWO WAYS TO NAME THE BATCH, never both:
//   · `charges` — a list of up to CONFIRM_MAX charges. Each item is a charge id (it
//     keeps its category) or {transaction_id, category_id}. A top-level `category_id`
//     is the category for every item that does not name its own.
//   · `merchant` + `category_id` — every charge at that merchant still FLAGGED for
//     review, not chosen by hand, not paying a bill and not split.
//
// WHY MERCHANT MODE TOUCHES ONLY FLAGGED CHARGES, though the first sketch of this tool
// said "every matching charge". The flag is the question; a charge with no flag has
// already been answered — by a rule, a bank tag, or a person. The cases that matter are
// the merchants that run a fuel pump AND a store under one name (MULTI_DEPARTMENT in
// categorize.ts): a pump charge the bank tagged is filed as transport at high
// confidence, unflagged, and "confirm this merchant as groceries" would have moved it
// into groceries. Leaving unflagged charges alone is what makes the bulk version as
// safe as answering one at a time. They are counted in the reply, never touched.
//
// AND AT THOSE SAME MERCHANTS, IT NEVER MOVES A FLAGGED CHARGE EITHER. FOUND 2026-10-10
// in review: protecting the unflagged pump charges missed that the FLAGGED ones there
// are the ambiguous fill-ups. classify() flags them precisely because the bank's line
// does not say pump or store and the amount could be one tank — the household's own
// labels split about evenly, and categorize.ts records a bulk re-decide that once moved
// hundreds of dollars at once. Filing every one of them into the asked-for category, locked as chosen
// by hand so no sync or rule could correct it afterwards, was that same bulk re-decide.
// So at a fuel-and-store merchant merchant mode confirms only the flagged charges
// ALREADY in the asked-for category (the backlog the scan measured: charges sitting in
// the right place, asking anyway), counts the rest as `would_change_category`, and the
// reply says each one is its own answer, to be sent as a list after looking at it.
//
// AND NEVER A CHARGE STILL PROCESSING. FOUND 2026-10-10 in review: the bank sync deletes
// a processing charge and inserts it again under a NEW id, both when the bank re-sends
// it and when it posts (plaid/index.ts, the pending section). The person's answer is
// carried across, but this batch's undo names the OLD id and could never find that row
// again. Merchant mode counts them as `pending`; a list naming one is refused by item.
//
// WHAT IT WRITES is exactly what categorize_charge writes, per charge: the category,
// `user_categorized` (a human chose this — the sync never re-guesses it) and
// `needs_review` false (the question has been answered). The undo restores all three,
// for the reason categorize_charge gives: restoring only the category would leave the
// flag that freezes the row.
//
// ONE CHANGE, ONE TOKEN, one compare-and-set per charge — the steps are ordinary
// set_columns steps, one per row. system.undo puts a batch back ROW BY ROW
// (ROW_BY_ROW_TOOLS in undo.ts): every charge that still holds what this wrote goes
// back, one somebody has changed since keeps that change, and the reply counts both.
// It used to stop at the first row that moved, which froze the whole batch for good.
//
// ALL OR NOTHING. If a charge has moved between the read and its write (the phone
// re-filed it in the gap), the rows already written are put back, each by its own
// compare-and-set, and the reply says nothing changed. settle_reimbursable accepts "a
// small lie" for its two-row case; a batch of fifty that stopped at the thirtieth and
// called itself abandoned would be a large one. A row somebody changed AGAIN while it
// was being put back keeps that newer change, which is still "none of mine is left".
// A database FAILURE mid-batch puts back what it can and then fails as every other
// write does: the change row stays `pending`, because a put-back that also failed
// cannot be proved either way.

/** The most charges one confirm will touch. The same number as the most rows one undo
 *  will run, because each charge is one step of it. */
const CONFIRM_MAX = MAX_STEPS;

/** What an item of `charges` may carry when it is an object rather than a bare id.
 *  Anything else is refused by name — the scan found Muse's commonest failure was
 *  guessing what goes INSIDE a list. Declared once, as a ListShape, so the parser below
 *  and the tool's `lists` read the same thing (see shapes.ts). */
const CONFIRM_ITEM_KEYS = ["transaction_id", "category_id"] as const;
const CONFIRM_ITEM_SHAPE: ListShape = { takes: CONFIRM_ITEM_KEYS };

type SetColumnsStep = Extract<UndoStep, { kind: "set_columns" }>;

interface ConfirmPlan {
  /** The charges that will change, in the order they are written. */
  rows: { row: LabelRow; to: string }[];
  /** Charges named or matched that this left alone, by why. */
  leftAlone: Record<string, number>;
  /** Merchant mode: the merchant, as it is safe to say. */
  merchant?: string;
  /** Said after the summary and not stored — see commit()'s `note`. */
  note?: string;
}

/** Every problem with a list, said in one refusal: the scan found the write door
 *  naming only the first problem, so a batch with three bad items took three round
 *  trips and three of the hour's writes to get right. */
function problemsSay(problems: string[]): string {
  const shown = problems.slice(0, 5);
  const more = problems.length - shown.length;
  return `${shown.join(" ")}${more > 0 ? ` And ${more} more like that.` : ""} Nothing was changed.`;
}

const paysABill = (at: UndoValue): boolean =>
  typeof at === "object" && at !== null && !Array.isArray(at) && at.kind === "bill";

/** One charge the caller named in a list: its number in the list (from one), its id,
 *  and the category it should end up in — null for "keep the one it has". */
type ConfirmItem = { n: number; id: string; to: string | null };

/**
 * A `charges` list, every item read to the end — or every problem with it, item by item.
 * Nothing here reads the ledger: whether each id finds a charge, and what that charge
 * holds, is planConfirmList's, in run(), after the door has counted the call.
 */
function readConfirmItems(raw: unknown, fallback: string | null): Shaped<ConfirmItem[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    const what = Array.isArray(raw) || raw === undefined ? "" : ` It was ${kindOfValue(raw)}.`;
    return { ok: false, problems: [`charges is a list of charge ids — each item the id itself, or {transaction_id, category_id}.${what}`] };
  }
  if (raw.length > CONFIRM_MAX) {
    return {
      ok: false,
      problems: [
        `That is ${raw.length} charges. I confirm at most ${CONFIRM_MAX} in one call, so a whole batch can be put back with one undo — send them in groups of ${CONFIRM_MAX}.`,
      ],
    };
  }
  const problems: string[] = [];
  const items: ConfirmItem[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const n = i + 1;
    const label = labelOf("Item", i);
    let id: unknown = item;
    let cat: unknown = undefined;
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const { value, unknown, clashes } = renameBy(rec, CONFIRM_ITEM_SHAPE);
      if (unknown.length || clashes.length) {
        problems.push(itemSays(label, [...clashes, ...(unknown.length ? [unknownKeysSays(unknown, CONFIRM_ITEM_KEYS)] : [])], rec));
        return;
      }
      id = value.transaction_id;
      cat = value.category_id;
    } else if (typeof item !== "string") {
      problems.push(itemSays(label, [`It is ${kindOfValue(item)}, not a charge id or {transaction_id, category_id}.`], null));
      return;
    }
    if (typeof id !== "string" || !UUID.test(id)) {
      problems.push(itemSays(label, ["It needs the charge's id, as the read door gives it."], null));
      return;
    }
    if (seen.has(id)) {
      problems.push(itemSays(label, ["It names a charge that is already in the list."], null));
      return;
    }
    seen.add(id);
    let to = fallback;
    if (cat !== undefined) {
      if (typeof cat !== "string" || !CATEGORY_IDS.has(cat)) {
        problems.push(itemSays(label, ["Its category is not one of the app's — finance.categories has the list."], null));
        return;
      }
      to = cat;
    }
    items.push({ n, id, to });
  });
  return problems.length ? { ok: false, problems } : { ok: true, value: items };
}

/** A merchant to confirm by, as far as the call alone can tell: its cleaned name and the
 *  app's own key for it — or every problem with it and its category. */
function readConfirmMerchant(raw: unknown, category: string | null, categorySent: boolean): Shaped<{ name: string; key: string }> {
  const pad = problemPad();
  // Said only when no category came at all — a category that came and was not one of
  // the app's is already said, by categoryArg.
  if (!categorySent) pad.no("With a merchant I need the category_id its charges belong in. finance.categories has the list.");
  // learn_merchant's backstop, for the same reason: `other` is the absence of a
  // category, and confirming a whole merchant there marks every flagged charge as
  // answered "unfiled" and stops the app asking. One charge there is fine.
  if (category === "other") {
    pad.no("I will not confirm a whole merchant as `other` — that marks every flagged charge there as answered and unfiled. Put one charge there on its own, or send a list.");
  }
  const name = scrubCap(raw, 60);
  // The app's own key, so the batch is the charges the labeller itself would call this
  // merchant — not a search. "ACME MARKET" must not also catch a differently-named store
  // that merely starts with the same word.
  const key = name ? merchantKey(name) : "";
  if (!name) pad.no("Tell me the merchant, as it reads on the charge.");
  else if (!key) pad.no("There was nothing left of that merchant name once it was normalised.");
  else if (isStatementNoiseKey(key)) {
    pad.no(`${name} is how the bank labels a kind of charge, not a merchant, so it would catch charges to everyone paid that way. Send those charges as a list instead.`);
  }
  return pad.done(() => ({ name, key }));
}

type ConfirmAsk =
  | { mode: "list"; items: ConfirmItem[] }
  | { mode: "merchant"; name: string; key: string; category: string };

/**
 * confirm_charges' call, as far as it can be judged without the ledger — every problem
 * at once, so a batch with three bad items is one round trip, and a refusal here spends
 * none of the hour (handler.ts runs this as the tool's check, before the counter).
 */
function planConfirm(payload: Record<string, unknown>): Shaped<ConfirmAsk> {
  const pad = problemPad();
  const byList = payload.charges !== undefined;
  const byMerchant = payload.merchant !== undefined;
  if (byList && byMerchant) pad.no("Send either charges — a list of charge ids — or a merchant with a category_id, not both.");
  if (!byList && !byMerchant) {
    pad.no("Send charges — a list of charge ids — or a merchant and the category_id its flagged charges belong in.");
  }
  let category: string | null = null;
  if (payload.category_id !== undefined) category = pad.take(categoryArg(payload.category_id)) ?? null;
  let items: ConfirmItem[] = [];
  let merchant: { name: string; key: string } = { name: "", key: "" };
  if (byList && !byMerchant) {
    const read = readConfirmItems(payload.charges, category);
    if (read.ok) items = read.value;
    else pad.all(read.problems);
  }
  if (byMerchant && !byList) {
    const read = readConfirmMerchant(payload.merchant, category, payload.category_id !== undefined);
    if (read.ok) merchant = read.value;
    else pad.all(read.problems);
  }
  return pad.done((): ConfirmAsk => (byList ? { mode: "list", items } : { mode: "merchant", ...merchant, category: category! }));
}

async function planConfirmList(db: FinanceDb, items: ConfirmItem[]): Promise<ConfirmPlan | Refusal> {
  const problems: string[] = [];
  // ONE read for the batch, and nothing is written until every item has been checked
  // against it — so a refusal below has changed nothing.
  const byId = new Map((await db.readCharges(items.map((it) => it.id))).map((r) => [r.id, r]));
  const rows: ConfirmPlan["rows"] = [];
  let alreadyConfirmed = 0;
  let missing = false;
  for (const it of items) {
    const r = byId.get(it.id);
    if (!r) {
      missing = true;
      problems.push(`Item ${it.n}: there is no charge with that id. It may have been deleted since you read it.`);
      continue;
    }
    const to = it.to ?? r.categoryId;
    if (!to) {
      problems.push(`Item ${it.n} has no category yet, so there is nothing to confirm — give it a category_id.`);
      continue;
    }
    // categorize_charge's own refusal, for the same reason: one category on a split
    // charge contradicts its slices. Keeping the category it has is fine.
    if (r.splits && to !== r.categoryId) {
      problems.push(`Item ${it.n} is split across categories, so its one category cannot change — leave its category out, or change a slice in the app.`);
      continue;
    }
    if (to === r.categoryId && r.userCategorized && !r.needsReview) {
      alreadyConfirmed += 1;
      continue;
    }
    // After the already-confirmed check on purpose: a processing charge that needs no
    // write costs the undo nothing. One that would be written is the one the bank will
    // replace under a new id — see the header.
    if (r.pending) {
      problems.push(
        `Item ${it.n} is still processing at the bank, which replaces it with a new charge when it posts, so this batch's undo could not find it again. Leave it out and confirm it once it posts.`,
      );
      continue;
    }
    rows.push({ row: r, to });
  }
  if (problems.length) return refuse(missing ? 404 : 409, problemsSay(problems));
  return { rows, leftAlone: { already_confirmed: alreadyConfirmed } };
}

async function planConfirmMerchant(db: FinanceDb, name: string, key: string, category: string): Promise<ConfirmPlan | Refusal> {
  const kind = DEFAULT_CATEGORIES.find((c) => c.id === category)?.type ?? "expense";
  // A fuel-and-store merchant, by the categorizer's own closed list (see the header).
  // The key is the merchant's whole name, so it decides for every charge it matches; a
  // charge's own description is asked too, in case it names the store more fully.
  const keyIsMulti = isMultiDepartment(key);

  const leftAlone = {
    chosen_by_hand: 0,
    pays_a_bill: 0,
    split: 0,
    not_flagged: 0,
    other_kind: 0,
    pending: 0,
    would_change_category: 0,
  };
  const rows: ConfirmPlan["rows"] = [];
  for (const r of await db.chargeLabels()) {
    // Both of the labeller's namespaces, the way learn_merchant counts them: the name's
    // own key, and the key of the name with the bank's statement noise stripped — a
    // charge with no clean name carries the bank's line AS its description, and its own
    // key is the bank's prefix word rather than the merchant.
    const stripped = stripStatementNoise(r.description);
    const strippedKey = stripped ? merchantKey(stripped) : "";
    if (merchantKey(r.description) !== key && strippedKey !== key) continue;
    if (r.userCategorized) leftAlone.chosen_by_hand += 1;
    else if (paysABill(r.appliesTo)) leftAlone.pays_a_bill += 1;
    else if (r.splits) leftAlone.split += 1;
    else if (!r.needsReview) leftAlone.not_flagged += 1;
    // A refund at the merchant is money IN; filing it under a spending category would
    // be a different answer from the one asked for.
    else if (r.type !== kind) leftAlone.other_kind += 1;
    // Counted only once it would otherwise have been confirmed, so the number means
    // "waiting for the bank", not "processing" in general.
    else if (r.pending) leftAlone.pending += 1;
    else if (r.categoryId !== category && (keyIsMulti || isMultiDepartment(r.description))) {
      leftAlone.would_change_category += 1;
    } else rows.push({ row: r, to: category });
  }
  if (rows.length === 0) {
    const looked = Object.values(leftAlone).reduce((s, n) => s + n, 0);
    if (looked === 0) {
      return refuse(
        409,
        `No charge I can see reads exactly ${name}. A merchant matches the whole name as it reads on the charge — check it with finance.search_transactions.`,
      );
    }
    // The two reasons a FLAGGED charge was left alone, said by name — the generic
    // sentence below would claim nothing there is flagged, which is false for both.
    const why: string[] = [];
    const w = leftAlone.would_change_category;
    if (w > 0) {
      why.push(
        `${w === 1 ? "its flagged charge sits" : `its ${w} flagged charges sit`} in another category, and at a merchant with a fuel pump and a store each charge is its own pump-or-store answer — look at each and send the ones you are sure of as a list`,
      );
    }
    const p = leftAlone.pending;
    if (p > 0) {
      why.push(`${p === 1 ? "one is" : `${p} are`} still processing at the bank — confirm ${p === 1 ? "it" : "them"} once ${p === 1 ? "it posts" : "they post"}`);
    }
    return refuse(
      409,
      why.length
        ? `Nothing at ${name} can be confirmed in one go: ${why.join("; ")}.`
        : `Nothing at ${name} is waiting to be confirmed: none of its ${looked} charge${looked === 1 ? " is" : "s are"} flagged for review and free to change.`,
    );
  }
  if (rows.length > CONFIRM_MAX) {
    return refuse(
      400,
      `${rows.length} flagged charges at ${name} is more than the ${CONFIRM_MAX} I confirm in one call. Send them as lists of up to ${CONFIRM_MAX} ids — finance.search_transactions with merchant and needs_review true finds them.`,
    );
  }
  // WHY THESE KEEP ARRIVING FLAGGED, said where it will be read. FOUND 2026-10-10: a
  // merchant that runs a fuel pump and a store under one name has every charge the bank
  // did not tag, in the range one tank could cost, flagged on arrival — INCLUDING when a
  // saved rule names the merchant, because a rule keyed by merchant cannot tell the pump
  // from the aisles (classify() in categorize.ts says why that is deliberate). So
  // confirming the backlog does not stop new ones, and the assistant should know that
  // before it is asked why "that store is still asking".
  //
  // REWRITTEN the same day, in review. The first version ended "confirm them the same
  // way when they come in" — an instruction to keep bulk-filing the very charges
  // classify() refuses to answer in bulk. It now says each one is its own answer.
  const w = leftAlone.would_change_category;
  const note = keyIsMulti || w > 0
    ? scrubCap(
        `Each charge at ${name} is its own pump-or-store answer (the bank rarely says which), so I only confirmed ones already in ${category}.` +
          (w > 0 ? ` ${w === 1 ? "One flagged charge" : `${w} flagged charges`} in another category ${w === 1 ? "was" : "were"} left alone: look at each and send them as a list.` : "") +
          " New ones will keep arriving flagged even with a rule; that is deliberate.",
        300,
      )
    : undefined;
  return { rows, leftAlone, merchant: name, note };
}

/**
 * Put back every row a batch has already written, newest first, each by its own
 * compare-and-set. Returns how many could NOT be put back because something else had
 * changed them in the meantime — on those, none of this door's writes is left either.
 * Throws if the database does, and the caller lets that throw reach commit(), which
 * then leaves the change `pending`: a put-back that failed cannot be proved either way.
 */
async function putBack(db: FinanceDb, landed: readonly SetColumnsStep[]): Promise<number> {
  let changedSince = 0;
  for (const s of [...landed].reverse()) {
    if ((await db.setColumns(s.table, s.id, s.before, s.after)) === "moved") changedSince += 1;
  }
  return changedSince;
}

const confirmCharges: Tool = {
  kind: "direct",
  does:
    "Confirm many charges at once, so they stop asking for review: a list of charge ids (each keeps its category, or takes the one given), or a merchant and a category for its flagged charges (at a fuel-and-store merchant, only those already in that category). Not charges still processing. One undo puts back every charge nobody has changed since.",
  fields: ["charges", "merchant", "category_id"],
  // The object form of an item, because that is the shape nobody could guess; a bare id
  // works too and keeps the charge's category.
  example: { charges: [{ transaction_id: EXAMPLE_ID, category_id: "groceries" }] },
  lists: { charges: CONFIRM_ITEM_SHAPE },
  check: (payload) => problemsOf(planConfirm(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const ask = planConfirm(payload);
    if (!ask.ok) return shapeRefused(ask.problems, payload);

    const a = ask.value;
    const plan = a.mode === "list" ? await planConfirmList(db, a.items) : await planConfirmMerchant(db, a.name, a.key, a.category);
    if (isRefusal(plan)) return plan;
    if (plan.rows.length === 0) {
      return refuse(409, "Every one of those is already confirmed — chosen by hand and not flagged — so there was nothing to change.");
    }

    const steps: SetColumnsStep[] = plan.rows.map(({ row, to }) => ({
      kind: "set_columns",
      table: "transactions",
      id: row.id,
      before: { category_id: row.categoryId, user_categorized: row.userCategorized, needs_review: row.needsReview },
      after: { category_id: to, user_categorized: true, needs_review: false },
    }));

    const n = plan.rows.length;
    const moved = plan.rows.filter((x) => x.to !== x.row.categoryId).length;
    const byCategory: Record<string, number> = {};
    for (const x of plan.rows) byCategory[x.to] = (byCategory[x.to] ?? 0) + 1;
    const cats = Object.entries(byCategory).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const s = n === 1 ? "" : "s";
    const movedSays = moved === 0 ? "" : ` ${moved === n ? (n === 1 ? "It" : "All of them") : `${moved} of them`} moved category.`;
    const summary = plan.merchant
      ? `Confirmed ${n} flagged ${plan.merchant} charge${s} in ${cats[0][0]}.${movedSays} Each is marked as chosen by hand and no longer flagged for review.`
      : `Confirmed ${n} charge${s}: ${cats.slice(0, 3).map(([c, k]) => `${k} in ${c}`).join(", ")}${cats.length > 3 ? ` and ${cats.length - 3} more categories` : ""}.${movedSays} Each is marked as chosen by hand and no longer flagged for review.`;

    return commit(ctx, "finance.confirm_charges", {
      steps,
      summary,
      note: plan.note,
      result: {
        confirmed: n,
        moved_category: moved,
        by_category: byCategory,
        left_alone: plan.leftAlone,
        ...(plan.merchant ? { merchant: plan.merchant } : {}),
        ids: plan.rows.map((x) => x.row.id),
      },
      rowIds: plan.rows.map((x) => x.row.id),
      async write() {
        const landed: SetColumnsStep[] = [];
        for (const step of steps) {
          let hit: "ok" | "moved";
          try {
            hit = await db.setColumns(step.table, step.id, step.after, step.before);
          } catch (e) {
            // Put back what can be, then fail the way every write fails. If the put-back
            // fails too, the original error is the one worth reporting.
            try {
              await putBack(db, landed);
            } catch (backErr) {
              console.error("muse-write: confirm_charges could not put a batch back", String((backErr as Error)?.message ?? backErr));
            }
            throw e;
          }
          if (hit === "moved") {
            const changedSince = await putBack(db, landed);
            return refuse(
              409,
              (landed.length === 0
                ? "One of those charges changed while I was working, so I stopped and changed nothing."
                : `One of those charges changed while I was working, so I put back the ${landed.length} I had already done and changed nothing.`) +
                (changedSince > 0
                  ? ` ${changedSince === 1 ? "One of them was" : `${changedSince} of them were`} changed again in the meantime, so ${changedSince === 1 ? "it keeps" : "they keep"} that newer change.`
                  : "") +
                " Read them again and ask me once more.",
            );
          }
          landed.push(step);
        }
      },
    });
  },
};

// ── finance.dismiss_suggestion ───────────────────────────────────────────────
//
// ADDED 2026-10-10. Wave away one "worth a look" suggestion, for the whole household.
//
// Until now a dismissal lived only in the phone that tapped it ('hb-review-dismissed',
// src/lib/doctorDismissals.ts — whose own header says a household table was always the
// plan), finance.worth_a_look answered `dismissals_known: false`, and nothing on either
// door could dismiss anything. With the Activity tab retired, every suggestion anybody
// had decided about would have come back on every call, for ever.
//
// THE KEY IS THE ENGINE'S OWN, and that is what makes this one row and no logic. The
// evidence is inside the key (`drift:<bill>:<amount in cents>` — spec §B.9), so a
// dismissed suggestion comes back on its own the moment the facts change, with no
// snooze and no expiry anywhere. finance.worth_a_look hands the key out; this stores it
// exactly as handed, and worth_a_look leaves out anything stored.
//
// IT CANNOT CHECK THE KEY IS A LIVE SUGGESTION, and says so. Working out the current
// suggestions needs the whole ledger and the review engine, which live on the read
// door. So the shape is checked — one of the engine's kinds, or the hashed stand-in —
// and the reply says what to do if worth_a_look still lists it. A key that matches
// nothing hides nothing, which is the safe direction to be wrong in.
//
// THE UNDO is the delete of the row, the same insert-then-delete_row shape add_bill
// uses. Household-wide on purpose, so either key can dismiss and the table's unique
// index on `key` means a second dismissal of the same thing is "already done", whoever
// did the first.
const NO_DISMISSAL_TABLE_SAYS =
  "I cannot dismiss suggestions yet: the database is missing the table that remembers them " +
  "(schema_v43_review_dismissals.sql has not been run). Nothing was changed — say it is a judgement " +
  "call they have already made, and it will keep appearing until that is set up.";

/** What a suggestion is about, by the first part of its key — for the sentence. */
const SUGGESTION_ABOUT: Record<string, string> = {
  drift: "a bill whose amount looks out of date",
  phantom: "a bill that may be finished",
  unmodelled: "a repeat charge that is not in the bills",
  missing: "a bill cycle with no payment",
  duplicate: "something that may be in the ledger twice",
  "income-landed": "income that may have been a one-off",
  unlinked: "a charge that looks like an unlinked bill payment",
  dangling: "a charge pointing at something deleted",
  h: "one of the suggestions",
};

/** dismiss_suggestion's key, exactly as handed out — or the problem with it. A key the
 *  cleaner would change, or one with a shape the engine never makes, would be stored as
 *  a dismissal that matches nothing. */
function planSuggestionKey(payload: Record<string, unknown>): Shaped<string> {
  const pad = problemPad();
  const key = typeof payload.key === "string" ? payload.key.trim() : "";
  if (!key || key.length > SUGGESTION_KEY_MAX || !SUGGESTION_KEY.test(key) || scrubCap(key, SUGGESTION_KEY_MAX) !== key) {
    pad.no(
      "I need the suggestion's key exactly as finance.worth_a_look gave it — it starts with what kind of thing it is, like drift: or unlinked:, or with h:.",
    );
  }
  return pad.done(() => key);
}

const dismissSuggestion: Tool = {
  kind: "direct",
  does:
    "Wave away one \"worth a look\" suggestion for both of you, by the key finance.worth_a_look gave it. It stays away until what it noticed changes.",
  fields: ["key"],
  // A drift key on the placeholder bill: the shape worth_a_look hands out, matching no
  // suggestion — and a key that matches nothing hides nothing.
  example: { key: `drift:${EXAMPLE_ID}:2500` },
  check: (payload) => problemsOf(planSuggestionKey(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planSuggestionKey(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const key = plan.value;

    let existing: Awaited<ReturnType<FinanceDb["readDismissal"]>>;
    try {
      existing = await db.readDismissal(key);
    } catch (e) {
      if (isMissingTable(e, "review_dismissals")) return refuse(503, NO_DISMISSAL_TABLE_SAYS);
      throw e;
    }
    if (existing) {
      const who = existing.person === "gino" || existing.person === "xinyan" ? existing.person : null;
      return refuse(
        409,
        who && who !== ctx.person
          ? `That one is already dismissed — ${DISPLAY[who]} did it — so there was nothing to change.`
          : "That one is already dismissed, so there was nothing to change.",
      );
    }

    let id: string;
    try {
      id = await db.insertRow("review_dismissals", { key, person: ctx.person });
    } catch (e) {
      if (isMissingTable(e, "review_dismissals")) return refuse(503, NO_DISMISSAL_TABLE_SAYS);
      // The table's unique index answered: the other phone dismissed it in the instant
      // between the read above and this insert. Postgres refused the statement, so
      // nothing landed and nothing needs putting back.
      if (e instanceof StatementRefused && e.code === "23505") {
        return refuse(409, "That one was dismissed a moment ago, so there was nothing to change.");
      }
      throw e;
    }

    const about = SUGGESTION_ABOUT[key.slice(0, key.indexOf(":"))] ?? "one of the suggestions";
    return commit(ctx, "finance.dismiss_suggestion", {
      steps: [{ kind: "delete_row", table: "review_dismissals", id, after: { key } }],
      summary: `Dismissed the suggestion about ${about}, for both of you. It will not be listed again unless what it noticed changes.`,
      // About what comes next, so it is said and not stored — see commit()'s `note`.
      note: "If finance.worth_a_look still lists it, the key did not match — send it again exactly as it came.",
      result: { id, key },
      rowIds: [id],
      // The insert above IS the change; delete_row is its inverse. Nothing else to do.
      write: () => Promise.resolve(),
    });
  },
};

// ── finance.set_cycle_budget ─────────────────────────────────────────────────
//
// ADDED 2026-10-10. Set the budget goal for ONE pay cycle — what any of the six lines may
// spend between one payday and the day before the next — or clear it so the cycle goes
// back to the standard budget.
//
// WHY IT EXISTS. Every budget target in the app was a constant in src/lib/plan.ts: a
// monthly figure per line, halved for each cycle. Nobody — not the app and not either
// assistant — could say "this cycle we hold groceries here and aim lower on dining",
// which is the conversation the household actually has a few days before a paycheck.
// A goal is now a row per line in public.cycle_budgets
// (supabase/schema_v45_cycle_budgets.sql), and src/lib/cycleBudget.ts is the one place
// that turns those rows into targets: the app's budget bars and the read door's
// finance.budget_status both call it, so a goal set here shows on both phones and in
// both chats.
//
// WHICH CYCLE. `cycle_start` is the payday that opens the cycle, exactly as the app's
// own payCycleFor() spells it — the shared goalCycleProblem() refuses any other date,
// because a goal filed under the 16th would match no cycle and LOOK set. Left out, it is
// the cycle in progress. It may reach one cycle back (to correct the one just finished)
// and two ahead (the next paycheck and the one after); further than that is a plan, not
// a goal, and that refusal names the cycles that can be set.
//
// WHAT A CALL CHANGES. `lines` names any of the six lines with dollars FOR THE CYCLE —
// never a monthly figure. Each named line is set; every line not named keeps whatever it
// had (its own goal, or the standard budget). A line already at that amount is left
// alone, and a call where every line already is changes nothing and says so. An unknown
// line is refused by name, with the six it can be. `clear: true` instead removes the
// whole cycle's goal, so every line is back on the standard budget.
//
// THE UNDO RESTORES THE PREVIOUS GOAL EXACTLY — OR ITS ABSENCE. Every change is a
// compare-and-set recorded BEFORE anything is written (commit()):
//   · a line that had a goal → set_columns puts the old amount (and who set it) back,
//     only while the row still holds what this wrote;
//   · a line that had none → delete_row removes the new row, only while it still holds
//     what this wrote. Its id is chosen here, before the write, so the undo can name it
//     — FinanceDb.insertCycleBudget says why that needs its own verb;
//   · a cleared cycle → one named inverse per cleared line (financeUndo.ts
//     cycle-budget.insert) puts each row back under the id it had. A line given a goal
//     again since keeps the newer one, and the undo STOPS there and says so: the lines
//     it already put back stay back, and the ones after it wait. Once that newer change
//     is undone, asking again finishes the job — a line already back counts as done.
// The undo runs through applyUndo, not row by row (ROW_BY_ROW_TOOLS in undo.ts), on
// purpose: the lines of one call are one answer, the same reason the write below keeps
// nothing of a call that half landed.
// If the other phone changes a goal line while this is writing, everything this call
// had already written is put back and nothing is kept: a goal half from this call and
// half from the other phone is a goal nobody chose.
//
// PLAIN SENTENCES. The summary names the cycle by its label and first day and each line
// by the plan's own label with its dollars. No household figure is in this file; the
// example's numbers are made up.

/** Said when the goal table is not there yet. Nothing was changed by then. */
const NO_GOAL_TABLE_SAYS =
  "I cannot set a cycle's budget goal yet: the database is missing the table that holds goals " +
  "(schema_v45_cycle_budgets.sql has not been run). Nothing was changed — the app and the budget " +
  "status keep using the standard budget until that is set up.";

/** What finance.set_cycle_budget was asked to do, once every field has been checked. */
type GoalAsk =
  | { mode: "set"; cycle: CycleSpan; lines: { line: string; amount: number }[] }
  | { mode: "clear"; cycle: CycleSpan };

const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * set_cycle_budget's cycle, lines and clear — EVERY problem with them, before anything is
 * read. All of it is decidable from the payload and the Arizona calendar, so handler.ts
 * runs this before the hourly write counter is bumped and a malformed goal costs nothing.
 */
function planCycleBudget(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<GoalAsk> {
  const pad = problemPad();

  // Which cycle. The cycles a goal may be set for come from the shared module, walked
  // from the Arizona date — never the runtime's, which from 5 PM is already tomorrow and,
  // on a payday's eve, already the next cycle.
  let cycle: CycleSpan | undefined;
  if (payload.cycle_start === undefined) {
    cycle = cycleInProgress(ctx.az);
  } else if (!isDateISO(payload.cycle_start)) {
    pad.no("cycle_start is the payday that opens the cycle, as YYYY-MM-DD — or leave it out for the cycle in progress.");
  } else {
    const problem = goalCycleProblem(payload.cycle_start, ctx.az);
    if (problem) pad.no(problem);
    else cycle = goalCycles(ctx.az).find((c) => c.start === payload.cycle_start);
  }

  const clear = payload.clear;
  if (clear !== undefined && clear !== true) {
    pad.no("clear only takes true — it puts the whole cycle back on the standard budget. Leave it out to set amounts.");
  }

  const lines: { line: string; amount: number }[] = [];
  const raw = payload.lines;
  const example = `like {"groceries": 250}. The lines are ${BUDGET_LINE_KEYS.join(", ")}.`;
  if (clear === true) {
    if (raw !== undefined) pad.no("Send lines to set amounts, or clear: true to go back to the standard budget — not both.");
  } else if (raw === undefined) {
    pad.no(`I need lines: each budget line you are setting, with dollars for the cycle, ${example}`);
  } else if (!isObject(raw)) {
    pad.no(`lines has to be an object of budget line to dollars for the cycle — it was ${kindOfValue(raw)}. Send it ${example}`);
  } else {
    const keys = Object.keys(raw);
    if (keys.length === 0) pad.no(`lines is empty. Name at least one line, ${example}`);
    const unknown = keys.filter((k) => !BUDGET_LINE_KEYS.includes(k));
    if (unknown.length) pad.no(`lines: ${unknownKeysSays(unknown, BUDGET_LINE_KEYS)}`);
    // In the plan's own order, so the summary reads the lines the way every screen
    // lists them, whatever order they were sent in.
    for (const key of BUDGET_LINE_KEYS) {
      if (!own(raw, key)) continue;
      const v = raw[key];
      const n = money(v);
      if (n === null || n < 0 || n > GOAL_LINE_MAX) {
        const was = typeof v === "number" ? `${v}` : kindOfValue(v);
        pad.no(`${key} has to be dollars for the cycle, from 0 to ${GOAL_LINE_MAX} — it was ${was}.`);
      } else {
        // To the cent, before anything is written: the column holds cents, and an undo
        // compares what is there with what this wrote — a 12.345 stored as 12.35 would
        // never match again, and the goal could never be put back.
        lines.push({ line: key, amount: Math.round(n * 100) / 100 });
      }
    }
  }

  return pad.done((): GoalAsk => (clear === true ? { mode: "clear", cycle: cycle! } : { mode: "set", cycle: cycle!, lines }));
}

/** "the pay cycle Oct 15 – Oct 30 (starting 2026-10-15)" — both, because the label is
 *  what a person says and the date is what a later call has to send back. */
const cycleWords = (c: CycleSpan) => `the pay cycle ${c.label} (starting ${c.start})`;

/** A goal row as the shared maths reads one, so the reply's cycle total comes from the
 *  same function the screens use rather than from a sum written here. */
const asGoal = (r: CycleBudgetRow): CycleBudget => ({ id: r.id, cycleStart: r.cycleStart, line: r.line, amount: r.amount });

/** One line of a goal write: a line that had a goal and is changed, or one that had
 *  none and gets a new row under an id chosen before anything is written. */
type GoalOp =
  | { kind: "update"; row: CycleBudgetRow; amount: number }
  | { kind: "insert"; row: CycleBudgetRow };

/**
 * Put back what a goal write had already done, newest first — the same compare-and-set
 * an undo would make, so a line somebody changed again in the meantime keeps that newer
 * change. Returns how many could not go back for that reason.
 */
async function putBackGoal(db: FinanceDb, landed: readonly GoalOp[], me: string): Promise<number> {
  let changedSince = 0;
  for (const op of [...landed].reverse()) {
    const hit =
      op.kind === "update"
        ? await db.setColumns("cycle_budgets", op.row.id, { amount: op.row.amount, set_by: op.row.setBy }, { amount: op.amount, set_by: me })
        : await db.deleteRow("cycle_budgets", op.row.id, { amount: op.row.amount, set_by: me });
    if (hit === "moved") changedSince += 1;
  }
  return changedSince;
}

/** The refusal for a goal line that changed under the write. */
function goalMovedSays(putBack: number, changedSince: number): string {
  return (
    (putBack === 0
      ? "A goal line for that cycle changed while I was working, so I stopped and changed nothing."
      : `A goal line for that cycle changed while I was working, so I put back the ${putBack} I had already set and changed nothing.`) +
    (changedSince > 0
      ? ` ${changedSince === 1 ? "One of them was" : `${changedSince} of them were`} changed again in the meantime, so ${changedSince === 1 ? "it keeps" : "they keep"} that newer change.`
      : "") +
    " Read the budget again and ask me once more."
  );
}

async function setGoal(
  ctx: Ctx,
  cycle: CycleSpan,
  rows: CycleBudgetRow[],
  lines: { line: string; amount: number }[],
): Promise<ToolOutcome> {
  const db = ctx.db as FinanceDb;
  const me = ctx.person;
  const cents = (n: number) => Math.round(n * 100);
  const byLine = new Map(rows.map((r) => [r.line, r]));

  const ops: GoalOp[] = [];
  const already: string[] = [];
  for (const { line, amount } of lines) {
    const has = byLine.get(line);
    if (has && cents(has.amount) === cents(amount)) {
      already.push(line);
      continue;
    }
    ops.push(
      has
        ? { kind: "update", row: has, amount }
        : { kind: "insert", row: { id: crypto.randomUUID(), cycleStart: cycle.start, line, amount, setBy: me } },
    );
  }
  if (ops.length === 0) {
    return refuse(
      409,
      `${lines.length === 1 ? "That is" : "Those are"} already the goal for ${cycleWords(cycle)}, so nothing changed.`,
    );
  }

  // The goal as it will stand once every line lands, for the reply's cycle total —
  // computed by cycleTargets, the function the screens and the read door use.
  const after = new Map(rows.map((r) => [r.line, asGoal(r)]));
  for (const op of ops) {
    after.set(op.row.line, op.kind === "update" ? { ...asGoal(op.row), amount: op.amount } : asGoal(op.row));
  }
  const targets = cycleTargets(cycle.start, [...after.values()]);

  const steps: UndoStep[] = ops.map((op) =>
    op.kind === "update"
      ? {
          kind: "set_columns",
          table: "cycle_budgets",
          id: op.row.id,
          before: { amount: op.row.amount, set_by: op.row.setBy },
          after: { amount: op.amount, set_by: me },
        }
      : { kind: "delete_row", table: "cycle_budgets", id: op.row.id, after: { amount: op.row.amount, set_by: me } },
  );
  const newAmount = (op: GoalOp) => (op.kind === "update" ? op.amount : op.row.amount);
  const said = ops.map((op) => `${lineLabel(op.row.line)} ${dollars(newAmount(op))}`).join(", ");
  const keptSays = already.length
    ? ` ${already.map(lineLabel).join(", ")} ${already.length === 1 ? "was" : "were"} already at that amount.`
    : "";
  const restSays = lines.length < BUDGET_LINE_KEYS.length ? " The lines not named are unchanged." : "";

  // ONE THING commit() IS OVER-CAUTIOUS ABOUT HERE, and it is the safe direction. commit()
  // reads a delete_row step as "a row was inserted before I was called", so if a write
  // below is refused by Postgres it leaves the change `pending` ("I cannot prove what
  // happened") rather than `abandoned`. This tool inserts INSIDE write(), after the undo
  // row exists, so nothing has landed early — but `pending` is never a false thing to say,
  // and teaching commit() a second meaning of delete_row would be a change to every tool.
  return commit(ctx, "finance.set_cycle_budget", {
    steps,
    summary: `Set the budget goal for ${cycleWords(cycle)}: ${said}.${keptSays}${restSays}`,
    // About the state the goal leaves, so it is said and not stored — see commit()'s note.
    note: scrubCap(
      `Both phones and both assistants now grade that cycle against this goal; its budget comes to ${dollars(targets.total)} in all.`,
      300,
    ),
    result: {
      cycle_start: cycle.start,
      cycle_end: cycle.end,
      label: cycle.label,
      lines: ops.map((op) => ({
        key: op.row.line,
        label: lineLabel(op.row.line),
        was: op.kind === "update" ? op.row.amount : null,
        now: newAmount(op),
      })),
      unchanged: already,
      cycle_total: targets.total,
    },
    rowIds: ops.map((op) => op.row.id),
    async write() {
      const landed: GoalOp[] = [];
      for (const op of ops) {
        const hit =
          op.kind === "update"
            ? await db.setColumns("cycle_budgets", op.row.id, { amount: op.amount, set_by: me }, { amount: op.row.amount, set_by: op.row.setBy })
            : (await db.insertCycleBudget(op.row)) === "ok"
              ? "ok"
              : "moved";
        if (hit === "moved") {
          const changedSince = await putBackGoal(db, landed, me);
          return refuse(409, goalMovedSays(landed.length, changedSince));
        }
        landed.push(op);
      }
    },
  });
}

async function clearGoal(ctx: Ctx, cycle: CycleSpan, rows: CycleBudgetRow[]): Promise<ToolOutcome> {
  const db = ctx.db as FinanceDb;
  if (rows.length === 0) {
    return refuse(409, `There is no goal set for ${cycleWords(cycle)} — it already uses the standard budget — so nothing changed.`);
  }
  // One named inverse per cleared line, carrying the whole row, so each can go back
  // under its own id. A line given a goal again since stops the undo at that line
  // (applyUndo's rule for one answer): the lines already put back stay back, and asking
  // again once that newer change is undone puts back the rest, because the handler
  // counts a line that is already back as done. FIXED 2026-10-10 in review — this used
  // to say the newer line "stops only itself", which was never what applyUndo does, and
  // a line already back used to refuse every retry.
  const steps: UndoStep[] = rows.map((r) => ({
    kind: "run_handler",
    handler: CYCLE_BUDGET_INSERT,
    before: { id: r.id, cycle_start: r.cycleStart, line: r.line, amount: r.amount, set_by: r.setBy },
  }));
  const standard = cycleTargets(cycle.start, []);
  return commit(ctx, "finance.set_cycle_budget", {
    steps,
    summary: `Cleared the budget goal for ${cycleWords(cycle)}, so every line is back on the standard budget.`,
    note: scrubCap(`That cycle's budget comes to ${dollars(standard.total)} in all again.`, 300),
    result: {
      cycle_start: cycle.start,
      cycle_end: cycle.end,
      label: cycle.label,
      cleared: rows.map((r) => ({ key: r.line, label: lineLabel(r.line), was: r.amount })),
      cycle_total: standard.total,
    },
    rowIds: rows.map((r) => r.id),
    async write() {
      const gone: CycleBudgetRow[] = [];
      for (const r of rows) {
        if ((await db.deleteRow("cycle_budgets", r.id, { amount: r.amount, set_by: r.setBy })) === "moved") {
          // Put back what this call already cleared, under the ids they had. A line the
          // other phone has set again in the gap keeps that newer goal.
          let changedSince = 0;
          for (const g of [...gone].reverse()) {
            if ((await db.insertCycleBudget(g)) === "taken") changedSince += 1;
          }
          return refuse(409, goalMovedSays(gone.length, changedSince));
        }
        gone.push(r);
      }
    },
  });
}

const setCycleBudget: Tool = {
  kind: "direct",
  does:
    "Set the budget goal for one pay cycle — any of the six lines, in dollars for that cycle, not a month — or clear: true to put the cycle back on the standard budget. Leave cycle_start out for the cycle in progress; otherwise it is the payday that opens the cycle, up to one cycle back or two ahead. Lines not named keep what they had.",
  fields: ["cycle_start", "lines", "clear"],
  // Made-up figures on two lines and no cycle_start, so the example is the cycle in
  // progress whatever day it is read — a dated example would go stale in a month.
  example: { lines: { groceries: 250, dining: 100 } },
  check: (payload, ctx) => problemsOf(planCycleBudget(payload, ctx)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planCycleBudget(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const ask = plan.value;

    let rows: CycleBudgetRow[];
    try {
      rows = await db.readCycleBudgets(ask.cycle.start);
    } catch (e) {
      if (isMissingTable(e, "cycle_budgets")) return refuse(503, NO_GOAL_TABLE_SAYS);
      throw e;
    }
    return ask.mode === "clear" ? clearGoal(ctx, ask.cycle, rows) : setGoal(ctx, ask.cycle, rows, ask.lines);
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
/** system.undo's token, when one was sent — null means "the last change". */
function planUndo(payload: Record<string, unknown>): Shaped<string | null> {
  const pad = problemPad();
  let token: string | null = null;
  if (payload.token !== undefined) {
    const t = scrubCap(payload.token, 32);
    if (!/^u-[0-9a-hjkmnp-tv-z]{8}$/.test(t)) pad.no("An undo token looks like u-4k7m9qt2. Ask system.changes for the list.");
    else token = t;
  }
  return pad.done(() => token);
}

const systemUndo: Tool = {
  kind: "direct",
  does: "Put back a change I made. With no token, the last one.",
  fields: ["token"],
  example: { token: "u-4k7m9qt2" },
  check: (payload) => problemsOf(planUndo(payload)),
  async run(payload, ctx) {
    const db = ctx.db as FinanceDb;
    const plan = planUndo(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const token = plan.value;

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

    // A BATCH GOES BACK ROW BY ROW. FOUND 2026-10-10 in review: finance.confirm_charges
    // writes up to fifty separate charges as one change, and applyUndo stops at the first
    // row that moved — so one charge re-filed on the phone left the other forty-nine
    // confirmed, and every retry stopped again on the rows it had already put back.
    // ROW_BY_ROW_TOOLS in undo.ts says why only a named tool gets this. Each row is
    // still its own compare-and-set: one somebody changed since keeps that change.
    let rowsPutBack: number;
    let rowsChangedSince = 0;
    if (ROW_BY_ROW_TOOLS.has(record.tool)) {
      let each: { putBack: number; changedSince: number };
      try {
        each = await applyUndoRowByRow(steps, applier);
      } catch (e) {
        if (e instanceof UndoRefused) return refuse(409, e.say);
        throw e;
      }
      if (each.putBack === 0) {
        // Nothing went back, so nothing is called put back: the change stays `undoable`,
        // exactly as a one-row undo that found its row moved does. No pointer at the app
        // here — the screens are being retired, and the read door can show every row.
        return refuse(
          409,
          each.changedSince === 1
            ? "That row could not go back: it has been changed since — by a person, or by the bank replacing it — so it keeps what it holds now. Nothing was changed."
            : `None of those ${each.changedSince} rows could go back: each one has been changed since — by a person, or by the bank replacing it — so each keeps what it holds now. Nothing was changed.`,
        );
      }
      rowsPutBack = each.putBack;
      rowsChangedSince = each.changedSince;
    } else {
      const outcome = await applyUndo(steps, applier);
      if (!outcome.ok) {
        // The change stays `undoable`. Part of it may have been put back, and the
        // sentence says how much — so asking again after fixing the row in the app
        // finishes the job rather than being refused as already done.
        return refuse(409, outcome.say);
      }
      rowsPutBack = outcome.steps;
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
    //
    // A BATCH THAT WENT BACK IN PART IS STILL `undone`. Every row of it either went back
    // or no longer held this door's write — somebody changed it since, or the bank
    // replaced it — so nothing of the change is left for a retry to put back, and leaving
    // it `undoable` would only send the next "undo that" back to the same rows. The undo
    // row's own summary carries the count, so system.changes says how much went back.
    const mine = mintToken((into) => crypto.getRandomValues(into));
    const said =
      rowsChangedSince > 0
        ? `Put back ${rowsPutBack} of ${rowsPutBack + rowsChangedSince}: ${record.summary}`
        : `Put back: ${record.summary}`;
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

    const leftSays =
      rowsChangedSince === 0
        ? ""
        : rowsChangedSince === 1
          ? " One had been changed since — by a person, or by the bank replacing it — so it keeps what it holds now."
          : ` ${rowsChangedSince} had been changed since — by a person, or by the bank replacing them — so each keeps what it holds now.`;
    return {
      ok: true,
      result: {
        undone: record.token,
        tool: record.tool,
        rows_put_back: rowsPutBack,
        ...(ROW_BY_ROW_TOOLS.has(record.tool) ? { rows_changed_since: rowsChangedSince } : {}),
      },
      rowIds: [],
      say: `${said} ${rowsPutBack === 1 ? "One row" : `${rowsPutBack} rows`} went back the way they were.${leftSays} I cannot undo an undo — ask me for the change again if you want it after all.`,
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
  example: {},
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
  "finance.edit_bill": editBill,
  "finance.add_bill": addBill,
  "finance.learn_merchant": learnMerchant,
  "finance.forget_merchant": forgetMerchant,
  "finance.set_account_balance": setAccountBalance,
  "finance.add_debt": addDebt,
  "finance.link_debt_to_card": linkDebtToCard,
  "finance.unlink_debt_card": unlinkDebtCard,
  "finance.edit_debt": editDebt,
  // 2026-10-10: the review lists, so Muse can clear them once the screens are gone —
  // many flagged charges in one call, and a "worth a look" item waved away for both.
  "finance.confirm_charges": confirmCharges,
  "finance.dismiss_suggestion": dismissSuggestion,
  // 2026-10-10: a budget goal for one pay cycle, read back by the app and budget_status.
  "finance.set_cycle_budget": setCycleBudget,
  "system.undo": systemUndo,
};

/** Re-exported for the tests, which assert the guards are the app's own. */
export type { BillRow, ChargeRow };
