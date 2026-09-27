// The finance and reminder half of what an assistant may change, plus the door's
// one queued path.
//
// WHERE THE HEALTH TOOLS WENT. Phase 1 had seven tools in this file. Phase 2 is
// parity — a tool for everything the app can do — and the health and workout side
// of that is 22 tools of its own, so it lives in healthTools.ts and is registered
// at the bottom of this file. The shape of a tool and the checks both halves share
// moved to kit.ts, so neither catalogue has to import the other.
//
// WHAT "queued" MEANT, AND WHY THE HEALTH SIDE LEFT IT
//   A queued tool writes one row into muse_pending and NOTHING else, and waits for
//   a tap in the app. The measurement that changed this phase's mind: nothing in
//   src/ reads muse_pending — `grep -rn "muse_pending" src/` finds nothing — so the
//   tap does not exist, and a queued row sits until cron-reminders marks it expired
//   a day later. His instruction for this phase is that the assistant has every
//   functionality the app has, and what makes that safe is a captured before-state
//   and an undo token, not a queue nobody drains.
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

import { addDays, azWallClock, azDateISO, parseInstant } from "../_shared/muse/az.ts";
import { MESSAGE_CAP, MUSE_MARKER, scrubCap, wasChanged } from "../_shared/muse/scrub.ts";
import { HEALTH_TOOLS } from "./healthTools.ts";
import {
  DISPLAY,
  SLUG,
  UUID,
  dateFor,
  dollars,
  money,
  refuse,
  type Ctx,
  type Success,
  type Tool,
} from "./kit.ts";

// The shape of a tool and the checks every tool shares now live in kit.ts, so this
// catalogue and healthTools.ts can both use them without one importing the other.
// Re-exported here because handler.ts, openapi.ts and the tests have always asked
// tools.ts for them.
export type { Ctx, Refusal, Success, Tool, ToolOutcome } from "./kit.ts";
export { DISPLAY } from "./kit.ts";

// ── the queued path ──────────────────────────────────────────────────────────

/**
 * One row in muse_pending, one push, and nothing else. This function is the
 * whole of the queued path, which is the point: there is no branch anywhere in
 * it that touches the ledger.
 */
async function queue(
  ctx: Ctx,
  tool: string,
  payload: Record<string, unknown>,
  summary: string,
): Promise<Success> {
  const row = await ctx.db.insertPending({ person: ctx.person, tool, payload, summary });
  await ctx.push(
    {
      title: "Waiting for your tap",
      body: summary,
      url: ctx.appUrl,
      tag: "muse-pending",
    },
    DISPLAY[ctx.person],
  );
  return {
    ok: true,
    result: { queued: true, id: row.id, expires_at: row.expiresAt, summary },
    rowIds: [row.id],
    say:
      `${summary} Nothing has changed yet — it is waiting in the app for your tap, ` +
      `and it expires in 24 hours if nobody taps it.`,
  };
}

// ── schedule.remind ──────────────────────────────────────────────────────────

/** How many reminders a person may create in one Arizona day. */
export const REMIND_PER_DAY = 10;
/** How many may be waiting undelivered at once. Note that a daily or weekly
 *  reminder counts as waiting for as long as it exists, because it is — it never
 *  finishes. Twenty standing reminders is already more than anybody reads, and
 *  clearing one is a swipe in the app. */
export const REMIND_OPEN_MAX = 20;
/** The raw message length the door will even look at. */
const MESSAGE_INPUT_MAX = 200;
/** How far ahead a reminder may be set. */
const REMIND_MAX_DAYS = 365;
/** cron-reminders runs on a 15-minute schedule, so this is the honest grain to
 *  promise. Saying "at 11:00 exactly" would be a promise the pipeline does not
 *  make. */
const DELIVERY_GRAIN_MIN = 15;

const remind: Tool = {
  kind: "direct",
  does: "Put a reminder in Homebase's own list. Homebase's cron delivers it as a real push.",
  fields: ["message", "at", "repeats"],
  async run(payload, ctx) {
    const raw = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!raw) return refuse(400, "Tell me what the reminder should say.");
    if (raw.length > MESSAGE_INPUT_MAX) {
      return refuse(
        400,
        `That reminder is ${raw.length} characters. Keep it under ${MESSAGE_CAP} — it has to fit on a lock screen.`,
      );
    }
    const clean = scrubCap(raw, MESSAGE_INPUT_MAX);
    if (!clean) return refuse(400, "There was nothing left of that reminder once the links were taken out.");
    if (clean.length > MESSAGE_CAP) {
      return refuse(
        400,
        `That reminder is ${clean.length} characters. Keep it under ${MESSAGE_CAP} — it has to fit on a lock screen.`,
      );
    }

    const due = parseInstant(payload.at);
    if (!due) {
      return refuse(
        400,
        "I need the time as 2026-09-26T23:00 (Arizona) or with an offset on the end.",
      );
    }
    if (due.getTime() < ctx.at.getTime() + 60_000) {
      return refuse(400, "That time has already passed. Pick one at least a minute out.");
    }
    if (due.getTime() > addDays(ctx.at, REMIND_MAX_DAYS).getTime()) {
      return refuse(400, `I only set reminders up to ${REMIND_MAX_DAYS} days ahead.`);
    }

    const repeats = payload.repeats === undefined ? "once" : payload.repeats;
    if (repeats !== "once" && repeats !== "daily" && repeats !== "weekly") {
      return refuse(400, "Repeats can be once, daily or weekly.");
    }

    // Two caps, because this is the one tool that reaches out of the system to a
    // lock screen. The daily one stops a runaway loop; the open one stops a slow
    // pile-up nobody notices until twenty of them fire.
    const open = await ctx.db.countOpenReminders(ctx.person);
    if (open >= REMIND_OPEN_MAX) {
      return refuse(
        429,
        `There are already ${open} reminders waiting. Clear some in the app before adding more.`,
      );
    }
    const today = azDateISO(ctx.az);
    const n = await ctx.db.bump(ctx.person, `remind:${today}`);
    if (n > REMIND_PER_DAY) {
      return refuse(429, `That is ${REMIND_PER_DAY} reminders for today already. Try again tomorrow.`);
    }

    // The marker goes on here, once, and it is stored — so it shows in the app's
    // list as well as on the lock screen, and both phones can see at a glance
    // that an assistant wrote this and Homebase did not.
    const message = MUSE_MARKER + clean;
    const id = await ctx.db.insertReminder({
      person: ctx.person,
      dueAt: due.toISOString(),
      repeats,
      message,
      source: "muse",
    });

    const trimmed = wasChanged(raw, clean)
      ? " I shortened it and took out anything link-shaped."
      : "";
    return {
      ok: true,
      result: {
        id,
        person: ctx.person,
        due_at: due.toISOString(),
        due_arizona: azWallClock(due),
        repeats,
        message,
      },
      rowIds: [id],
      say:
        `Saved. ${DISPLAY[ctx.person]}'s phone gets "${message}" within about ` +
        `${DELIVERY_GRAIN_MIN} minutes of ${azWallClock(due)}` +
        (repeats === "once" ? "." : `, ${repeats}.`) +
        trimmed,
    };
  },
};

// ── finance.categorize_charge (queued) ───────────────────────────────────────

const categorizeCharge: Tool = {
  kind: "queued",
  does: "Ask for one charge to be put in a category, and optionally to remember that merchant.",
  fields: ["transaction_id", "category_id", "learn_merchant"],
  async run(payload, ctx) {
    const id = typeof payload.transaction_id === "string" ? payload.transaction_id : "";
    if (!UUID.test(id)) return refuse(400, "I need the charge's id, which the read door gives you.");
    const category = typeof payload.category_id === "string" ? payload.category_id : "";
    if (!SLUG.test(category)) return refuse(400, "I need a category id, like groceries or transport.");
    const learn = payload.learn_merchant;
    if (learn !== undefined && typeof learn !== "boolean") {
      return refuse(400, "learn_merchant is either true or false.");
    }
    if (!(await ctx.db.transactionExists(id))) {
      return refuse(404, "There is no charge with that id. It may have been deleted since you read it.");
    }
    // No merchant, no amount, no date in the sentence — he is looking at the
    // charge on screen when he taps, and the sentence is also going back into an
    // assistant's context.
    const summary = learn
      ? `Put one charge in ${category}, and remember that merchant.`
      : `Put one charge in ${category}.`;
    return queue(ctx, "finance.categorize_charge", { transaction_id: id, category_id: category, learn_merchant: learn === true }, summary);
  },
};

// ── finance.note_known_amount (queued) ───────────────────────────────────────

const noteKnownAmount: Tool = {
  kind: "queued",
  does: "Ask for what a variable bill actually came to this month to be recorded.",
  fields: ["recurring_id", "amount", "month_key"],
  async run(payload, ctx) {
    const id = typeof payload.recurring_id === "string" ? payload.recurring_id : "";
    if (!UUID.test(id)) return refuse(400, "I need the bill's id, which the read door gives you.");
    const amount = money(payload.amount);
    if (amount === null || amount < 0 || amount > 100_000) {
      return refuse(400, "I need the amount off the bill as a number.");
    }
    const monthKey = payload.month_key;
    if (monthKey !== undefined && !(typeof monthKey === "string" && /^\d{4}-\d{2}$/.test(monthKey))) {
      return refuse(400, "The month goes in as 2026-09, or leave it out.");
    }
    const name = await ctx.db.recurringName(id);
    if (name === null) return refuse(404, "There is no bill with that id.");

    const forMonth = monthKey ? ` for ${monthKey}` : "";
    const summary = `Record ${scrubCap(name, 40)}${forMonth} as ${dollars(amount)}.`;
    return queue(ctx, "finance.note_known_amount", { recurring_id: id, amount, month_key: monthKey ?? null }, summary);
  },
};

// ── finance.add_transaction (queued) ─────────────────────────────────────────

const addTransaction: Tool = {
  kind: "queued",
  does: "Ask for a cash expense the bank will never see to be added.",
  fields: ["date", "amount", "category_id", "description"],
  async run(payload, ctx) {
    const when = dateFor(payload, ctx, 60);
    if ("ok" in when) return when;
    const amount = money(payload.amount);
    if (amount === null || amount <= 0 || amount > 100_000) {
      return refuse(400, "I need the amount as a number above zero.");
    }
    const category = typeof payload.category_id === "string" ? payload.category_id : "";
    if (!SLUG.test(category)) return refuse(400, "I need a category id, like groceries or transport.");
    const description = scrubCap(payload.description, 40);

    // `type` is not a field this tool takes, and neither is applies_to — see the
    // per-tool field list and the refusals in handler.ts. An expense that cannot
    // point at a bill is the whole reason this one is allowed to exist: settling a
    // bill cycle unattended is how a $6 parking charge moved a month by $1,732.
    const summary = description
      ? `Add a ${dollars(amount)} expense on ${when.date} in ${category}: ${description}.`
      : `Add a ${dollars(amount)} expense on ${when.date} in ${category}.`;
    return queue(
      ctx,
      "finance.add_transaction",
      { date: when.date, amount, category_id: category, description, type: "expense" },
      summary,
    );
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

export const TOOLS: Record<string, Tool> = {
  "schedule.remind": remind,
  "finance.categorize_charge": categorizeCharge,
  "finance.note_known_amount": noteKnownAmount,
  "finance.add_transaction": addTransaction,
  // Phase 2's health and workout parity, defined in healthTools.ts. Spread rather
  // than listed, so a tool added there cannot be missing from the door — and the
  // "no such tool" reply, the description and the tests all read this one object.
  ...HEALTH_TOOLS,
};

export const TOOL_NAMES = Object.keys(TOOLS);
