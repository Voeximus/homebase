// What an assistant may change, and nothing else.
//
// NO COUNT IN THIS COMMENT, deliberately. It said "the seven things" while nine
// existed, and the same number was typed in four other places — openapi.ts, index.ts,
// API.md, and again further down this file. Every sentence that states it is now
// counted from CATALOGUE at the bottom, through _shared/muse/catalogue.ts, and
// tests/museCatalogue.test.ts fails if a typed one comes back.
//
// THESE LAND STRAIGHT AWAY ("direct")
//   health.log_weight       one number, one row, visible on the weight screen,
//                           deletable in two taps.
//   health.log_saved_meal   a meal the household already saved, by name. The
//                           macros are already known, so there is nothing to
//                           parse and nothing to get wrong.
//   schedule.remind         a reminder in Homebase's own list, which Homebase's
//                           cron delivers as a real push.
//   schedule.cancel_reminder  stops one that has not gone off yet.
//   schedule.update_reminder  moves its time, changes its words, or changes how
//                           often it repeats.
//
// WHY THE LAST TWO ARE NOT A LOOSENING. They are the correction half of the tool
// above them. `schedule.remind` could put a 3 AM reminder on a lock screen and
// nothing could take it back: the app has no reminders screen — nothing in `src/`
// reads or writes that table — so the only fix was the Supabase dashboard. A door
// that can make a mistake and not undo it is not safer, it is just less finished.
// Neither of them is a delete: "cancel" sets `canceled_at` and the row stays, which
// is what lets the audit log still point at it and what makes "that one already went
// out" answerable instead of guessable.
//
// THESE ONLY ASK ("queued")
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

import type { Db, MealDayRow, Person, Push, ReminderRow } from "./db.ts";
import {
  addDays,
  azDateISO,
  azWallClock,
  daysBetweenISO,
  instantOf,
  isDateISO,
  parseInstant,
} from "../_shared/muse/az.ts";
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
 *
 * WHAT THE SENTENCE USED TO SAY, AND WHY IT HAD TO CHANGE. It said the request was
 * "waiting in the app for your tap". Nothing in the app reads muse_pending — there
 * is no list, no screen and no tap, and no code path anywhere that applies one of
 * these rows. PLAN.md Phase 4 puts the app half and the door half in the same phase
 * and only the door half was built. So the door was sending him to a screen that
 * does not exist, on every queued tool, and "go and tap it" is the one sentence
 * in the whole bridge a person cannot check without walking into the app and finding
 * nothing.
 *
 * The sentence now says what is true TODAY: the request is written down, the ledger
 * has not moved, and nothing will move it until the app grows the screen. When that
 * screen lands, this is the line to change back — and PLAN.md's Phase 4 gate ("undo
 * each in the app and confirm it undoes cleanly") is what proves it.
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
      // Not "Waiting for your tap": there is nothing to tap yet, and a notification
      // that sends him looking for a screen that is not there is worse than none.
      title: "Written down, not applied",
      body: summary,
      url: ctx.appUrl,
      tag: "muse-pending",
    },
    DISPLAY[ctx.person],
  );
  return {
    ok: true,
    result: {
      queued: true,
      id: row.id,
      expires_at: row.expiresAt,
      summary,
      applied: false,
      can_be_applied_yet: false,
    },
    rowIds: [row.id],
    say:
      `${summary} Nothing has changed, and nothing will: the app has no screen for ` +
      `these yet, so this is only written down. It clears itself after 24 hours. ` +
      `Do it in the app if it needs to actually happen.`,
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
 *  finishes. Twenty standing reminders is already more than anybody reads, and the
 *  way to clear one is schedule.cancel_reminder: there is no reminders screen in the
 *  app (nothing in `src/` reads the table), which is the whole reason the cancel and
 *  edit tools below exist. */
export const REMIND_OPEN_MAX = 20;

/** The moment a reminder is set for, checked. Shared by remind and update_reminder
 *  so "at least a minute out" and "no more than a year ahead" cannot end up meaning
 *  two different things on the two tools that set a time. */
function dueFrom(at: unknown, ctx: Ctx): { due: Date } | Refusal {
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
  const id = typeof payload.reminder_id === "string" ? payload.reminder_id : "";
  if (!UUID.test(id)) {
    return refuse(
      400,
      "I need the reminder's id. schedule.list_reminders on the read door gives you one for each reminder that is still waiting.",
    );
  }
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

/** "…, daily." / "." — said the same way by all three reminder tools. */
const cadenceSays = (repeats: string) => (repeats === "once" ? "." : `, ${repeats}.`);

const remind: Tool = {
  kind: "direct",
  does: "Put a reminder in Homebase's own list. Homebase's cron delivers it as a real push.",
  fields: ["message", "at", "repeats"],
  async run(payload, ctx) {
    // One copy of the message rule, in _shared/muse/reminders.ts, because
    // update_reminder sets a message too — and the marker in particular has to go on
    // in both places or an edited reminder stops saying an assistant wrote it.
    const said = messageFor(payload.message);
    if (!said.ok) return refuse(400, said.say);

    const when = dueFrom(payload.at, ctx);
    if ("ok" in when) return when;

    const repeats = payload.repeats === undefined ? "once" : payload.repeats;
    if (!isRepeats(repeats)) return refuse(400, "Repeats can be once, daily or weekly.");

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

const cancelReminder: Tool = {
  kind: "direct",
  does: "Cancel a reminder that has not gone off yet. A repeating one stops for good.",
  fields: ["reminder_id"],
  async run(payload, ctx) {
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
  async run(payload, ctx) {
    const wantsTime = payload.at !== undefined;
    const wantsText = payload.message !== undefined;
    const wantsRepeats = payload.repeats !== undefined;
    if (!wantsTime && !wantsText && !wantsRepeats) {
      return refuse(400, "Tell me what to change: a new time, new words, or how often it repeats.");
    }

    const found = await reminderFor(payload, ctx, "change");
    if ("ok" in found) return found;
    const { row } = found;

    const patch: { dueAt?: string; message?: string; repeats?: Repeats } = {};
    const changed: string[] = [];
    let due = instantOf(row.dueAt);
    let message = row.message;
    let repeats = row.repeats;
    let trimmed = false;

    if (wantsTime) {
      const when = dueFrom(payload.at, ctx);
      if ("ok" in when) return when;
      due = when.due;
      patch.dueAt = when.due.toISOString();
      changed.push("time");
    }
    if (wantsText) {
      const said = messageFor(payload.message);
      if (!said.ok) return refuse(400, said.say);
      // Through the same rule remind uses, so an edited reminder is capped, cleaned
      // and still carries the marker. A message that quietly lost its marker would
      // stop saying an assistant wrote it, on the one screen where that matters.
      message = said.message;
      patch.message = said.message;
      trimmed = said.trimmed;
      changed.push("words");
    }
    if (wantsRepeats) {
      if (!isRepeats(payload.repeats)) return refuse(400, "Repeats can be once, daily or weekly.");
      repeats = payload.repeats;
      patch.repeats = payload.repeats;
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

// ── finance.categorize_charge (queued) ───────────────────────────────────────

const categorizeCharge: Tool = {
  kind: "queued",
  does: "Ask for one charge to be put in a category, and optionally to remember that merchant.",
  fields: ["transaction_id", "category_id", "learn_merchant"],
  async run(payload, ctx) {
    const id = typeof payload.transaction_id === "string" ? payload.transaction_id : "";
    // THE SENTENCE USED TO SAY "which the read door gives you". It does not. No tool
    // on the read door returns a transaction id — `finance.search_transactions` is
    // forbidden, and worth_a_look strips `evidence`, `fix` and `key`, which are the
    // only three places a charge id lives. So an assistant read that sentence,
    // concluded it had missed a call, and either looped on reads that contain no ids
    // or invented a uuid. Saying where the id actually has to come from is what stops
    // the loop.
    if (!UUID.test(id)) {
      return refuse(
        400,
        "I need the charge's id, and nothing on the read door hands one out — so this cannot be done from here today. Categorise it in the app.",
      );
    }
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
    // The read door hands out a bill id in exactly one place: the `bill` field on a
    // `finance.worth_a_look` suggestion, and only for bills that happened to raise
    // one. Said precisely, because "the read door gives you" sent an assistant
    // hunting through tools that carry no ids at all.
    if (!UUID.test(id)) {
      return refuse(
        400,
        "I need the bill's id. The only place to get one is the `bill` field on a worth_a_look suggestion — otherwise do it in the app.",
      );
    }
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

const REGISTRY: Record<string, Tool> = {
  "health.log_weight": logWeight,
  "health.log_saved_meal": logSavedMeal,
  "schedule.remind": remind,
  "schedule.cancel_reminder": cancelReminder,
  "schedule.update_reminder": updateReminder,
  "finance.categorize_charge": categorizeCharge,
  "finance.note_known_amount": noteKnownAmount,
  "finance.add_transaction": addTransaction,
  "health.log_meal": logMeal,
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
