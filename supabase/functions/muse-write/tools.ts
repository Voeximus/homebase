// What an assistant may change, and nothing else. The ledger and health writes are
// below; the memory store's three are registered from ./memoryWrites.ts. The count
// is whatever TOOLS holds — a number spelled in a comment here was already wrong
// once, and openapi.ts now counts instead of spelling too.
//
// THE LEDGER AND HEALTH WRITES THAT LAND STRAIGHT AWAY ("direct")
//   health.log_weight       one number, one row, visible on the weight screen,
//                           deletable in two taps.
//   health.log_saved_meal   a meal the household already saved, by name. The
//                           macros are already known, so there is nothing to
//                           parse and nothing to get wrong.
//   schedule.remind         a reminder in Homebase's own list, which Homebase's
//                           cron delivers as a real push.
//
// FOUR ONLY ASK ("queued")
//   finance.categorize_charge, finance.note_known_amount,
//   finance.add_transaction, health.log_meal
//   Each one writes a single row into muse_pending and NOTHING ELSE. The ledger
//   does not move until he taps it in the app, where the app's own read-and-
//   refuse guards run and he can see both numbers.
//
// WHY THE SPLIT IS NOT "ASK HIM IN THE ASSISTANT"
//   Meta's approval choices are per "type of action" on a connector, in the
//   future — "Always allow: Muse can take this type of action for this Connector
//   in the future without asking again". Nobody outside Meta knows how wide a
//   "type of action" is, and the door cannot tell an approved write from an
//   auto-approved one. So the door treats EVERY write as unattended, and the tap
//   that matters lives inside Homebase where it can actually be enforced.
//
// WHAT IS NOT HERE, AND WILL NOT BE
//   Moving money. Deleting anything. Settling a bill cycle or writing paid_bills
//   — a $6 parking charge once settled September's rent and moved the month by
//   $1,732, and that was a human doing it in daylight. Changing a debt balance or
//   a savings goal. Writing food_cache. Calling another edge function. None of
//   these is a disabled flag: there is no code for them, so there is nothing to
//   talk the assistant into finding.
//
// AND THE THING THIS FILE DOES NOT DO: ARITHMETIC
//   Not one number below is derived. A weigh-in is stored as it was said. A saved
//   meal's portions are copied across exactly as they sit in `saved_meals`. A
//   queued row stores the request and lets the app compute. That is why this door
//   imports nothing out of src/lib — it has no maths to keep in step with the
//   screens, which is the drift that told the phones "Electric $85" while every
//   screen said $100.

import type { Db, MealDayRow, Person, Push } from "./db.ts";
import { addDays, azDateISO, azWallClock, daysBetweenISO, isDateISO, parseInstant } from "../_shared/muse/az.ts";
import { MESSAGE_CAP, MUSE_MARKER, scrubCap, wasChanged } from "../_shared/muse/scrub.ts";
// The memory store's three writes. Their own file, so nothing about how a memory
// works lives in here and nothing about the ledger lives in there.
import { MEMORY_WRITE_TOOLS } from "./memoryWrites.ts";

/** The push_subscriptions "owner" spelling, and the name a sentence uses. */
export const DISPLAY: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };

export interface Ctx {
  db: Db;
  push: Push;
  /** Taken from the secret that was presented. NEVER from the request body. */
  person: Person;
  /** The true instant, built once at the top of the request. */
  at: Date;
  /** The same instant as Arizona's calendar and clock. Built once, passed down. */
  az: Date;
  appUrl: string;
}

export type Refusal = { ok: false; status: number; say: string };
export type Success = {
  ok: true;
  result: Record<string, unknown>;
  rowIds: string[];
  say: string;
};
export type ToolOutcome = Refusal | Success;

export interface Tool {
  kind: "direct" | "queued";
  /** One line, for the OpenAPI description and for the "no such tool" reply. */
  does: string;
  /** Every field this tool accepts. Anything else is refused by name — a typo
   *  that silently did nothing would be worse than a refusal. */
  fields: string[];
  run(payload: Record<string, unknown>, ctx: Ctx): Promise<ToolOutcome>;
}

// ── small shared checks ──────────────────────────────────────────────────────

const refuse = (status: number, say: string): Refusal => ({ ok: false, status, say });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A category id is a stable slug in the app's own list. That list is code
// (src/lib/seed.ts DEFAULT_CATEGORIES) and it is deliberately NOT copied here:
// a hand-made copy of the app's data is exactly the mirror that drifts. The door
// checks the shape; the app resolves the id when he taps, and refuses one it does
// not know.
const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, and not a numeric string — a string that looks like a number
 *  is a sign the caller guessed at the shape. */
function money(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The date this write is for. Defaults to Arizona's today — never the runtime's,
 * which from 5 PM onward is already tomorrow.
 *
 * `backDays` is how far back the tool is willing to look. It is small on purpose:
 * a weigh-in from three months ago is a typo far more often than a memory, and a
 * wrong date is invisible in a chat.
 */
function dateFor(
  payload: Record<string, unknown>,
  ctx: Ctx,
  backDays: number,
): { date: string } | Refusal {
  const today = azDateISO(ctx.az);
  if (payload.date === undefined) return { date: today };
  if (!isDateISO(payload.date)) {
    return refuse(400, "I need the date as YYYY-MM-DD, or leave it out and I will use today.");
  }
  const delta = daysBetweenISO(payload.date, today);
  if (delta < 0) return refuse(400, `${payload.date} has not happened yet in Arizona. Today is ${today}.`);
  if (delta > backDays) {
    return refuse(
      400,
      `${payload.date} is more than ${backDays} days back. Add that one in the app so you can see what is already there.`,
    );
  }
  return { date: payload.date };
}

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

// ── health.log_weight ────────────────────────────────────────────────────────

const logWeight: Tool = {
  kind: "direct",
  does: "Record a weigh-in.",
  fields: ["weight", "date"],
  async run(payload, ctx) {
    const weight = money(payload.weight);
    if (weight === null) return refuse(400, "I need the weight as a number, in pounds.");
    // A plausible range, not a judgement about his body: the point is to catch a
    // misheard number (19.84, 1984) before it lands in the trend line, where a
    // single wild point bends the slope the app reports.
    if (weight < 50 || weight > 700) {
      return refuse(400, "That weight does not look like pounds. Say it as you read it off the scale.");
    }
    const when = dateFor(payload, ctx, 14);
    if ("ok" in when) return when;

    const previous = await ctx.db.readWeight(ctx.person, when.date);
    // Stored exactly as it was said. No rounding: the door does no arithmetic,
    // and a number that comes back different from the one he spoke is the small
    // end of the same problem.
    await ctx.db.upsertWeight(ctx.person, when.date, weight, ctx.at.toISOString());

    const who = DISPLAY[ctx.person];
    const say = previous === null
      ? `Logged ${weight} lb for ${who} on ${when.date}.`
      : `Logged ${weight} lb for ${who} on ${when.date}. That replaced the ${previous} already saved for that day.`;
    // rowIds stays empty: body_weights has one row per person per date, so the
    // person and the date in `result` already name the row exactly. The audit log
    // can still answer "did that actually happen" without a second round trip.
    return {
      ok: true,
      result: { person: ctx.person, date: when.date, weight, replaced: previous },
      rowIds: [],
      say,
    };
  },
};

// ── health.log_saved_meal ────────────────────────────────────────────────────

const MAX_MEAL_ATTEMPTS = 3;

const logSavedMeal: Tool = {
  kind: "direct",
  does: "Log one of the household's saved meals by name.",
  fields: ["name", "date"],
  async run(payload, ctx) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 80) {
      return refuse(400, "Tell me the name of the saved meal, as it is spelled in the app.");
    }
    const when = dateFor(payload, ctx, 2);
    if ("ok" in when) return when;

    const matches = await ctx.db.findSavedMealsByName(name);
    if (matches.length === 0) {
      const names = (await ctx.db.listSavedMealNames(8)).map((n) => scrubCap(n, 40)).filter(Boolean);
      const list = names.length ? ` Saved meals right now: ${names.join(", ")}.` : "";
      return refuse(404, `There is no saved meal called that.${list}`);
    }
    if (matches.length > 1) {
      return refuse(409, "More than one saved meal has that name. Pick it in the app so the right one lands.");
    }
    const saved = matches[0];

    // The portions are copied across EXACTLY as they sit in saved_meals. Each one
    // already carries its own per-100g snapshot, which is why the app's log stays
    // correct after a library food is edited. The door does not look inside them
    // and never computes a macro.
    //
    // The id is generated once, outside the retry loop on purpose: the app merges
    // day documents by meal id, so a retry that appends the same id can never
    // show up twice.
    const meal = { id: crypto.randomUUID(), name: saved.name, items: saved.items };
    const atISO = ctx.at.toISOString();

    let day: MealDayRow | null = null;
    let landed = false;
    for (let attempt = 0; attempt < MAX_MEAL_ATTEMPTS && !landed; attempt++) {
      // THE RE-READ, IMMEDIATELY BEFORE THE WRITE. A meal_days row holds the
      // WHOLE day as one json document, so every write replaces the lot — writing
      // a copy read a moment ago erases anything the phone logged in between.
      // Reading here, inside the loop, means each attempt carries the freshest
      // copy rather than re-sending a stale one.
      day = await ctx.db.readMealDay(ctx.person, when.date);
      if (!day) {
        landed = (await ctx.db.insertMealDay({
          person: ctx.person,
          date: when.date,
          meals: [meal],
          atISO,
        })) === "ok";
        continue;
      }
      // status and note are left exactly as they are, which is what the app's own
      // write does — nothing clears a day's status, so a day the other phone
      // marked skipped survives this write.
      landed = (await ctx.db.updateMealDayIfUnchanged(day.id, day.updatedAt, {
        meals: [...day.meals, meal],
        atISO,
      })) === "ok";
    }

    if (!landed) {
      // Fails closed and says so plainly. The phone was writing the same day at
      // the same moment, three times over; a fourth blind attempt is how the
      // phone's meals get erased.
      return refuse(
        503,
        "The phone was writing that same day at the same moment. Nothing was changed — try again in a few seconds.",
      );
    }

    const total = (day ? day.meals.length : 0) + 1;
    return {
      ok: true,
      result: {
        person: ctx.person,
        date: when.date,
        meal: scrubCap(saved.name, 40),
        items: saved.items.length,
        meals_on_day: total,
      },
      rowIds: [],
      say:
        `Added ${scrubCap(saved.name, 40)} to ${DISPLAY[ctx.person]}'s food log for ${when.date}. ` +
        `That day now has ${total} ${total === 1 ? "meal" : "meals"}.`,
    };
  },
};

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

// ── health.log_meal (queued) ─────────────────────────────────────────────────

const MAX_ITEMS = 12;

const logMeal: Tool = {
  kind: "queued",
  does: "Ask for free-form food to be added to a day's log.",
  fields: ["date", "items"],
  async run(payload, ctx) {
    const when = dateFor(payload, ctx, 2);
    if ("ok" in when) return when;
    const items = payload.items;
    if (!Array.isArray(items) || items.length === 0) {
      return refuse(400, "I need at least one food, each with its calories and macros.");
    }
    if (items.length > MAX_ITEMS) {
      return refuse(400, `That is more than ${MAX_ITEMS} foods at once. Split it into two meals.`);
    }
    const clean: Record<string, unknown>[] = [];
    for (const raw of items) {
      if (!isObject(raw)) return refuse(400, "Each food is an object with a name, calories and macros.");
      const name = scrubCap(raw.name, 40);
      if (!name) return refuse(400, "Each food needs a name.");
      const nums: Record<string, number> = {};
      for (const k of ["kcal", "p", "c", "f"]) {
        const v = money(raw[k]);
        if (v === null || v < 0 || v > 10_000) {
          return refuse(400, `${name} needs ${k} as a number of zero or more.`);
        }
        nums[k] = v;
      }
      let grams: number | null = null;
      if (raw.grams !== undefined) {
        grams = money(raw.grams);
        if (grams === null || grams <= 0 || grams > 5_000) {
          return refuse(400, `${name} needs grams as a number above zero, or leave it out.`);
        }
      }
      clean.push({ name, grams, ...nums });
    }
    // No totals. The app adds these up when he taps, with the same code that
    // draws the screen.
    const first = String(clean[0].name);
    const more = clean.length - 1;
    const summary = more > 0
      ? `Add ${first} and ${more} more to ${DISPLAY[ctx.person]}'s food log for ${when.date}.`
      : `Add ${first} to ${DISPLAY[ctx.person]}'s food log for ${when.date}.`;
    return queue(ctx, "health.log_meal", { date: when.date, items: clean }, summary);
  },
};

// ── the registry ─────────────────────────────────────────────────────────────

export const TOOLS: Record<string, Tool> = {
  "health.log_weight": logWeight,
  "health.log_saved_meal": logSavedMeal,
  "schedule.remind": remind,
  "finance.categorize_charge": categorizeCharge,
  "finance.note_known_amount": noteKnownAmount,
  "finance.add_transaction": addTransaction,
  "health.log_meal": logMeal,
  // remember / forget / restore. All three land straight away and all three are
  // reversible: see memoryWrites.ts for why memory's undo is a tool of its own
  // rather than a token read back out of the audit log.
  ...MEMORY_WRITE_TOOLS,
};

export const TOOL_NAMES = Object.keys(TOOLS);
