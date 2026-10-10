// The reminder half of what an assistant may change, and the door's registry.
//
// NO COUNT IN THIS COMMENT, deliberately. It said "the seven things" while nine
// existed, and the same number was typed in four other places — openapi.ts, index.ts,
// API.md, and again further down this file. Every sentence that states it is now
// counted from CATALOGUE at the bottom, through _shared/muse/catalogue.ts, and
// tests/museCatalogue.test.ts fails if a typed one comes back.
//
// WHERE EVERYTHING ELSE WENT. Phase 1 had seven tools in this file. Phase 2 is parity —
// a tool for everything the app can do — which is 25 finance tools (toolsFinance.ts) and
// 22 health and workout tools (healthTools.ts), including the three health tools that
// started here. The shape of a tool and the checks all three files share live in kit.ts,
// so no catalogue imports another: the registry is built at module load, and a cycle
// here is a door that does not start.
//
// WHAT IS LEFT HERE is the three reminder tools, and they belong together.
// `schedule.remind` could put a 3 AM reminder on a lock screen and nothing could take it
// back: the app has no reminders screen — nothing in `src/` reads or writes that table —
// so the only fix was the Supabase dashboard. cancel and update are the correction half
// of it, and neither is a delete: "cancel" sets `canceled_at` and the row stays, which is
// what lets the audit log still point at it and what makes "that one already went out"
// answerable instead of guessable.
//
// WHY THE SPLIT WAS NOT "ASK HIM IN THE ASSISTANT"
//   Meta's approval choices are per "type of action" on a connector, in the
//   future — "Always allow: Muse can take this type of action for this Connector
//   in the future without asking again". Nobody outside Meta knows how wide a
//   "type of action" is, and the door cannot tell an approved write from an
//   auto-approved one. So the door treats EVERY write as unattended.
//
// AND THE THING THIS FILE DOES NOT DO: ARITHMETIC
//   Not one number below is derived. A queued row stores the request and lets the
//   app compute. Where phase 2 needed a rule the app had — a portion's per-100g
//   values, a set's shape after the fact — that rule was moved into src/lib and
//   imported rather than copied, because a hand-written mirror is the drift that
//   told the phones "Electric $85" while every screen said $100.

import type { ReminderRow } from "./db.ts";
import { addDays, azDateISO, azWallClock, instantOf, parseInstant } from "../_shared/muse/az.ts";
import {
  closedBecause,
  DELIVERY_GRAIN_MIN,
  isRepeats,
  messageFor,
  overSays,
  REMIND_MAX_DAYS,
  TRIMMED_SAYS,
  type Repeats,
} from "../_shared/muse/reminders.ts";
import { catalogueOf, namesOf, writeEntries } from "../_shared/muse/catalogue.ts";
import { scrubCap } from "../_shared/muse/scrub.ts";
import {
  DISPLAY,
  EXAMPLE_ID,
  problemPad,
  problemsOf,
  refuse,
  shapeRefused,
  UUID,
  type Ctx,
  type Refusal,
  type Shaped,
  type ShapeCtx,
  type Tool,
} from "./kit.ts";
import { FINANCE_WRITE_TOOLS } from "./toolsFinance.ts";
import { HEALTH_TOOLS } from "./healthTools.ts";
// The memory store's three writes. Their own file, so nothing about how a memory works
// lives in here and nothing about the ledger lives in there.
import { MEMORY_WRITE_TOOLS } from "./memoryWrites.ts";

// The shape of a tool and the checks every tool shares live in kit.ts, so this
// catalogue, toolsFinance.ts and healthTools.ts can all use them without one importing
// another. Re-exported here because handler.ts, openapi.ts and the tests have always
// asked tools.ts for them, and moving a file should not move a door's front door.
export type { Ctx, Refusal, Success, Tool, ToolOutcome } from "./kit.ts";
export { DISPLAY } from "./kit.ts";

// THE QUEUED PATH USED TO BE HERE, and it is worth one paragraph rather than a silent
// deletion, because the sentence it wrote is the one a person could not check.
//
// It wrote one row into muse_pending, fired a push, and touched nothing else. Its reply
// said the request was "waiting in the app for your tap" — and nothing in the app reads
// muse_pending. No list, no screen, no code path that applies one of those rows.
// PLAN.md's Phase 4 puts the app half and the door half in one phase, and only the door
// half was built. So four tools sent him to a screen that does not exist, and a queued
// row sat there until cron-reminders marked it expired a day later.
//
// Phase 2 answered that by making all four direct with a captured before-state and an
// undo token, which is the trade his instruction asks for: the tap moved from before the
// change to after it, if he wants it back. With no queued tool left, the helper was
// unreachable, and tsc refuses unreachable code here rather than leaving a reader to
// wonder which path runs.
//
// If the app ever grows that approval screen, this is the commit to read: the row shape
// and the RLS for muse_pending are still in schema_v36, and `Tool.kind` still has the
// "queued" variant with catalogue.ts still holding the one sentence that describes it.

// ── schedule.remind ──────────────────────────────────────────────────────────

/** How many reminders a person may create in one Arizona day. */
export const REMIND_PER_DAY = 10;
/** How many may be waiting undelivered at once. Note that a daily or weekly
 *  reminder counts as waiting for as long as it exists, because it is — it never
 *  finishes. Twenty standing reminders is already more than anybody reads, and the
 *  way to clear one is schedule.cancel_reminder: there is no reminders screen in the
 *  app (nothing in `src/` reads the table), which is the whole reason the cancel and
 *  edit tools below exist. */
export const REMIND_OPEN_MAX = 20;

/** The moment a reminder is set for, checked. Shared by remind and update_reminder
 *  so "at least a minute out" and "no more than a year ahead" cannot end up meaning
 *  two different things on the two tools that set a time. It needs the request's
 *  instant and nothing else, so it runs in a shape check, before anything is counted. */
function dueFrom(at: unknown, ctx: ShapeCtx): { due: Date } | Refusal {
  const due = parseInstant(at);
  if (!due) {
    return refuse(400, "I need the time as 2026-09-26T23:00 (Arizona) or with an offset on the end.");
  }
  if (due.getTime() < ctx.at.getTime() + 60_000) {
    return refuse(400, "That time has already passed. Pick one at least a minute out.");
  }
  if (due.getTime() > addDays(ctx.at, REMIND_MAX_DAYS).getTime()) {
    return refuse(400, `I only set reminders up to ${REMIND_MAX_DAYS} days ahead.`);
  }
  return { due };
}

/**
 * The reminder this call is about, or the refusal to give instead.
 *
 * THREE REFUSALS, AND THE FIRST TWO SAY THE SAME THING ON PURPOSE.
 *
 * A reminder that does not exist and a reminder that belongs to the other person get
 * the identical sentence. That is not laziness — it is the same choice auth.ts makes
 * about a wrong key ("one refusal for every kind of wrong key, so the body cannot be
 * used to tell one from another"). If his assistant were told "that one is Xinyan's",
 * the door would have confirmed the existence and the ownership of one of her rows to
 * a caller holding only his secret. Two people, two keys, and the key says who is
 * calling: an assistant may not see, cancel or edit the other person's reminders, and
 * "see" includes learning that one is there.
 *
 * The third is the reminder that is already over, and it is the one that matters
 * most: a cancel that answered "done" for a reminder whose push is already on a lock
 * screen would leave the person believing it was stopped.
 */
async function reminderFor(
  payload: Record<string, unknown>,
  ctx: Ctx,
  verb: string,
): Promise<{ row: ReminderRow } | Refusal> {
  const id = reminderIdOf(payload);
  if (typeof id !== "string") return id;
  const row = await ctx.db.readReminder(id);
  const NOT_YOURS = "There is no reminder with that id on your list.";
  if (!row) return refuse(404, NOT_YOURS);
  if (row.person !== ctx.person) return refuse(404, NOT_YOURS);
  const closed = closedBecause(row);
  if (closed) {
    const when = instantOf(closed === "delivered" ? row.sentAt : row.canceledAt);
    return refuse(409, overSays(closed, verb, when ? azWallClock(when) : null));
  }
  return { row };
}

/** The reminder id a call names, in the right shape — before anything is read, so it
 *  can sit in a shape check as well as in reminderFor. */
function reminderIdOf(payload: Record<string, unknown>): string | Refusal {
  const id = typeof payload.reminder_id === "string" ? payload.reminder_id : "";
  if (!UUID.test(id)) {
    return refuse(
      400,
      "I need the reminder's id. schedule.list_reminders on the read door gives you one for each reminder that is still waiting.",
    );
  }
  return id;
}

/** remind's words, time and cadence — every problem with them, before anything is
 *  counted. The two caps (open reminders, reminders today) need the database, so they
 *  stay in run. */
function planRemind(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{ message: string; trimmed: boolean; due: Date; repeats: Repeats }> {
  const pad = problemPad();
  const said = messageFor(payload.message);
  if (!said.ok) pad.no(said.say);
  const when = pad.take(dueFrom(payload.at, ctx));
  const repeats = payload.repeats === undefined ? "once" : payload.repeats;
  if (!isRepeats(repeats)) pad.no("Repeats can be once, daily or weekly.");
  return pad.done(() => ({
    message: said.ok ? said.message : "",
    trimmed: said.ok ? said.trimmed : false,
    due: when!.due,
    repeats: repeats as Repeats,
  }));
}

/** update_reminder's id and changes — every problem with any of them. */
function planReminderEdit(payload: Record<string, unknown>, ctx: ShapeCtx): Shaped<{
  id: string;
  due: Date | null;
  message: { message: string; trimmed: boolean } | null;
  repeats: Repeats | null;
}> {
  const pad = problemPad();
  const wantsTime = payload.at !== undefined;
  const wantsText = payload.message !== undefined;
  const wantsRepeats = payload.repeats !== undefined;
  if (!wantsTime && !wantsText && !wantsRepeats) {
    pad.no("Tell me what to change: a new time, new words, or how often it repeats.");
  }
  const id = pad.take(reminderIdOf(payload));
  const when = wantsTime ? pad.take(dueFrom(payload.at, ctx)) : null;
  const said = wantsText ? messageFor(payload.message) : null;
  if (said && !said.ok) pad.no(said.say);
  if (wantsRepeats && !isRepeats(payload.repeats)) pad.no("Repeats can be once, daily or weekly.");
  return pad.done(() => ({
    id: id!,
    due: when ? when.due : null,
    message: said && said.ok ? { message: said.message, trimmed: said.trimmed } : null,
    repeats: wantsRepeats ? (payload.repeats as Repeats) : null,
  }));
}

/** "…, daily." / "." — said the same way by all three reminder tools. */
const cadenceSays = (repeats: string) => (repeats === "once" ? "." : `, ${repeats}.`);

const remind: Tool = {
  kind: "direct",
  does: "Put a reminder in Homebase's own list. Homebase's cron delivers it as a real push.",
  fields: ["message", "at", "repeats"],
  // A date a long way out on purpose, so the example is still a valid time for months:
  // `at` has to be at least a minute ahead and at most REMIND_MAX_DAYS. It was
  // 2026-12-01 at first, which would have printed an example that is refused for being
  // in the past from that December on; moved out as far as the cap allows from when it
  // was written, so it holds until the late summer of 2027.
  example: { message: "Take the recycling out", at: "2027-09-01T19:00", repeats: "weekly" },
  check: (payload, ctx) => problemsOf(planRemind(payload, ctx)),
  async run(payload, ctx) {
    // One copy of the message rule, in _shared/muse/reminders.ts, because
    // update_reminder sets a message too — and the marker in particular has to go on
    // in both places or an edited reminder stops saying an assistant wrote it.
    const plan = planRemind(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const said = { message: plan.value.message, trimmed: plan.value.trimmed };
    const when = { due: plan.value.due };
    const { repeats } = plan.value;

    // Two caps, because this is the one tool that reaches out of the system to a
    // lock screen. The daily one stops a runaway loop; the open one stops a slow
    // pile-up nobody notices until twenty of them fire.
    const open = await ctx.db.countOpenReminders(ctx.person);
    if (open >= REMIND_OPEN_MAX) {
      return refuse(
        429,
        `There are already ${open} reminders waiting. Cancel one with schedule.cancel_reminder before adding more.`,
      );
    }
    const today = azDateISO(ctx.az);
    const n = await ctx.db.bump(ctx.person, `remind:${today}`);
    if (n > REMIND_PER_DAY) {
      return refuse(429, `That is ${REMIND_PER_DAY} reminders for today already. Try again tomorrow.`);
    }

    const message = said.message;
    const id = await ctx.db.insertReminder({
      person: ctx.person,
      dueAt: when.due.toISOString(),
      repeats,
      message,
      source: "muse",
    });

    return {
      ok: true,
      result: {
        id,
        person: ctx.person,
        due_at: when.due.toISOString(),
        due_arizona: azWallClock(when.due),
        repeats,
        message,
      },
      rowIds: [id],
      say:
        `Saved. ${DISPLAY[ctx.person]}'s phone gets "${message}" within about ` +
        `${DELIVERY_GRAIN_MIN} minutes of ${azWallClock(when.due)}` +
        cadenceSays(repeats) +
        (said.trimmed ? TRIMMED_SAYS : ""),
    };
  },
};

// ── schedule.cancel_reminder ─────────────────────────────────────────────────
//
// THE REASON THIS TOOL EXISTS. `schedule.remind` could write a reminder and nothing
// could take one back. The app has no reminders screen — nothing in `src/` reads or
// writes the table — so a reminder set for 3 AM instead of 3 PM could only be fixed
// in the Supabase dashboard, and until then it woke somebody up. A door that can
// only make a mistake and never correct one is not finished.
//
// AND IT IS STILL NOT A DELETE. No door has a delete verb, and this does not add
// one: it sets `canceled_at`, the row survives, the audit log's row_ids points at
// something that still exists, and cron-reminders stops picking it up. The
// difference matters for the reminder that had already gone out — a delete would
// have removed the evidence and answered "done"; this refuses and says when it went.

/** cancel_reminder's whole shape: the id. */
function planReminderId(payload: Record<string, unknown>): Shaped<string> {
  const pad = problemPad();
  const id = pad.take(reminderIdOf(payload));
  return pad.done(() => id!);
}

const cancelReminder: Tool = {
  kind: "direct",
  does: "Cancel a reminder that has not gone off yet. A repeating one stops for good.",
  fields: ["reminder_id"],
  example: { reminder_id: EXAMPLE_ID },
  check: (payload) => problemsOf(planReminderId(payload)),
  async run(payload, ctx) {
    const plan = planReminderId(payload);
    if (!plan.ok) return shapeRefused(plan.problems, payload);
    const found = await reminderFor(payload, ctx, "cancel");
    if ("ok" in found) return found;
    const { row } = found;

    const landed = await ctx.db.updateReminderIfUnchanged(
      row.id,
      { dueAt: row.dueAt },
      { canceledAt: ctx.at.toISOString() },
    );
    if (landed === "stale") {
      // Fails closed and says which way. Something moved in the second between the
      // read and the write: the 15-minute job delivered it, or advanced a repeating
      // one, or the other phone got there first. The one answer this must never give
      // is "cancelled" for a push that is already on a lock screen.
      return refuse(
        409,
        "That reminder changed while I was cancelling it — it may have just gone out. Nothing was changed. Ask me to list them again.",
      );
    }

    const due = instantOf(row.dueAt);
    const message = scrubCap(row.message, 120);
    const forever = row.repeats === "once"
      ? ""
      : ` That stops the ${row.repeats} one for good — there are no more after this.`;
    return {
      ok: true,
      result: {
        id: row.id,
        person: ctx.person,
        canceled: true,
        message,
        due_at: row.dueAt,
        due_arizona: due ? azWallClock(due) : null,
        repeats: row.repeats,
      },
      rowIds: [row.id],
      say:
        `Cancelled "${message}" for ${DISPLAY[ctx.person]}` +
        (due ? `, which was set for ${azWallClock(due)}` : "") +
        `. It will not arrive.${forever}`,
    };
  },
};

// ── schedule.update_reminder ─────────────────────────────────────────────────
//
// Time, text, or how it repeats. At least one of the three, because an update that
// changed nothing and answered "done" is the same silent lie as a cancel that missed.

const updateReminder: Tool = {
  kind: "direct",
  does: "Change a reminder's time, its words, or how often it repeats.",
  fields: ["reminder_id", "at", "message", "repeats"],
  example: { reminder_id: EXAMPLE_ID, at: "2027-09-01T20:30" },
  check: (payload, ctx) => problemsOf(planReminderEdit(payload, ctx)),
  async run(payload, ctx) {
    const plan = planReminderEdit(payload, ctx);
    if (!plan.ok) return shapeRefused(plan.problems, payload);

    const found = await reminderFor(payload, ctx, "change");
    if ("ok" in found) return found;
    const { row } = found;

    const patch: { dueAt?: string; message?: string; repeats?: Repeats } = {};
    const changed: string[] = [];
    let due = instantOf(row.dueAt);
    let message = row.message;
    let repeats = row.repeats;
    let trimmed = false;

    if (plan.value.due) {
      due = plan.value.due;
      patch.dueAt = plan.value.due.toISOString();
      changed.push("time");
    }
    if (plan.value.message) {
      // Through the same rule remind uses (messageFor, in planReminderEdit), so an
      // edited reminder is capped, cleaned and still carries the marker. A message that
      // quietly lost its marker would stop saying an assistant wrote it, on the one
      // screen where that matters.
      message = plan.value.message.message;
      patch.message = plan.value.message.message;
      trimmed = plan.value.message.trimmed;
      changed.push("words");
    }
    if (plan.value.repeats) {
      repeats = plan.value.repeats;
      patch.repeats = plan.value.repeats;
      changed.push("how often");
    }

    const landed = await ctx.db.updateReminderIfUnchanged(row.id, { dueAt: row.dueAt }, patch);
    if (landed === "stale") {
      return refuse(
        409,
        "That reminder changed while I was editing it — it may have just gone out. Nothing was changed. Ask me to list them again.",
      );
    }

    return {
      ok: true,
      result: {
        id: row.id,
        person: ctx.person,
        changed,
        message,
        due_at: patch.dueAt ?? row.dueAt,
        due_arizona: due ? azWallClock(due) : null,
        repeats,
      },
      rowIds: [row.id],
      say:
        `Changed the ${changed.join(" and ")}. ${DISPLAY[ctx.person]}'s phone now gets ` +
        `"${message}" within about ${DELIVERY_GRAIN_MIN} minutes of ` +
        `${due ? azWallClock(due) : "its set time"}` +
        cadenceSays(repeats) +
        (trimmed ? TRIMMED_SAYS : ""),
    };
  },
};

// ── the three finance tools that used to only ASK ────────────────────────────
//
// finance.categorize_charge, finance.note_known_amount and finance.add_transaction
// were queued in Phase 1: each wrote one row into muse_pending, fired a push, and
// changed nothing until he tapped it in the app.
//
// THEY ARE NOW DIRECT, WITH AN UNDO, AND THEY LIVE IN toolsFinance.ts. Two things
// made the queue the wrong answer rather than the careful one:
//
//   1. NOTHING IN THE APP READS muse_pending. `grep -rn "muse_pending" src/` returns
//      nothing, so a queued row sat there until cron-reminders marked it expired 24
//      hours later. The three careful tools were the three that did nothing.
//   2. HOMEBASE NEVER MOVES MONEY. The worst a wrong write does is make data wrong,
//      and data can be put back — so the tap moved from "before the change" to "after
//      it, if he wants it back".
//
// finance.note_known_amount became finance.set_bill_amount, because the app has ONE
// action for that write and it decides which column from the ROW rather than from the
// caller: a variable bill's figure lives in known_amount, a fixed bill's price is
// amount, and writing the wrong one reads as a fix that did nothing.
//
// health.log_meal WAS the fourth, and the finance half left the decision to the health
// half, which made it direct too. So the queued path now has no tools at all. `Tool.kind`
// keeps the variant and catalogue.ts keeps the sentence — the machinery is sound and what
// it was missing was a screen — but the helper that wrote those rows is gone, because an
// unreachable function is something tsc refuses rather than something a reader trusts.

// ── the registry ───────────────────────────────────────────

const REGISTRY: Record<string, Tool> = {
  "schedule.remind": remind,
  "schedule.cancel_reminder": cancelReminder,
  "schedule.update_reminder": updateReminder,
  // Phase 2's parity, one file per domain. Spread rather than listed, so a tool added
  // there cannot be missing from the door — and the "no such tool" reply, the served
  // description and the tests all read this one object.
  ...FINANCE_WRITE_TOOLS,
  ...HEALTH_TOOLS,
  // remember / forget / restore. All three land straight away and all three are
  // reversible: see memoryWrites.ts for why memory's undo is a tool of its own rather
  // than a token read back out of the change log.
  ...MEMORY_WRITE_TOOLS,
};

/**
 * The catalogue, as a Map — which is the lookup the door uses.
 *
 * WHY NOT THE OBJECT. `REGISTRY[name]` answers for every key on Object.prototype,
 * so "constructor", "__proto__", "toString", "valueOf" and "hasOwnProperty" each
 * found an inherited value and got past the door's "no such tool" check. A Map has
 * no inherited keys, so the only names in it are the ones listed above. The read door
 * has always been a Map; this is the same shape.
 */
export const TOOL_BY_NAME: ReadonlyMap<string, Tool> = new Map(Object.entries(REGISTRY));

/**
 * This door's half of the catalogue, normalised and validated — see catalogue.ts.
 * openapi.ts builds every sentence of the served description from it, including the
 * count, which was typed by hand in five places and wrong in two of them.
 *
 * catalogueOf throws, so a tool whose name, summary or field list is malformed takes
 * this door down at deploy rather than being described wrongly to an assistant.
 */
export const CATALOGUE = catalogueOf(writeEntries(TOOL_BY_NAME));

/** The names, for the OpenAPI enum and the "no such tool" reply. Off the catalogue,
 *  so it cannot be a different list from the one the description was built from. */
export const TOOL_NAMES = namesOf(CATALOGUE);

/** The catalogue by name, for the description builder and the tests. Reading it is
 *  safe; ROUTING goes through TOOL_BY_NAME above. */
export const TOOLS: Readonly<Record<string, Tool>> = REGISTRY;
