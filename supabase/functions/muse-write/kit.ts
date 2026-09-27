// What a write tool IS, and the handful of checks every one of them shares.
//
// WHY THIS IS NOT IN tools.ts ANY MORE. Phase 1 had seven write tools and one
// file, so the shape and the checks lived beside them. Phase 2's instruction is
// his own: "Muse has to have every functionality given in the app and the app must
// become a database for patterns and information storage." That turns seven tools
// into dozens across two domains, and two catalogue files that both need `dateFor`
// would either import it from each other — a cycle, and the registry is built at
// module load, so a cycle here is a door that does not start — or carry a copy
// each. A copy is the drift the whole bridge exists to stop: the two doors already
// grew two clocks and two cleaners once, and scripts/check-categorizer-sync.mjs
// fails the build over it.
//
// So the shape and the checks are HERE, once. Nothing in this file touches the
// database, reads a clock, or decides anything a tool decides.

import type { Db, Person, Push } from "./db.ts";
import { azDateISO, daysBetweenISO, isDateISO } from "../_shared/muse/az.ts";
import type { UndoRecord } from "./undoContract.ts";

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
  /**
   * How to put this change back, captured BEFORE the change landed.
   *
   * This is the whole safety net phase 2 trades for letting an assistant change
   * anything. His reasoning, and it is sound: Homebase never moves money — it
   * records, categorises and computes — so the worst a wrong write does is make
   * data wrong, and wrong data can be undone as long as the before-state was
   * written down first.
   *
   * Optional on purpose. A tool that cannot honestly capture its before-state must
   * leave this off rather than return a record that would not restore anything,
   * and the handler then tells the caller plainly that this one cannot be undone.
   */
  undo?: UndoRecord;
};
export type ToolOutcome = Refusal | Success;

export interface Tool {
  /**
   * "direct" lands straight away. "queued" writes a row into muse_pending and
   * nothing else, and waits for a tap in the app.
   *
   * PHASE 2 MOVED THE HEALTH SIDE OFF "queued", and the reason is measured rather
   * than preferred: nothing in src/ reads muse_pending — `grep -rn "muse_pending"
   * src/` finds nothing — so a queued row sits until cron-reminders marks it
   * expired 24 hours later. The tap it was waiting for does not exist. Direct
   * with an undo token is the version that actually does something, and the
   * before-state is what makes it safe.
   */
  kind: "direct" | "queued";
  /** One line, for the OpenAPI description and for the "no such tool" reply. */
  does: string;
  /** Every field this tool accepts. Anything else is refused by name — a typo
   *  that silently did nothing would be worse than a refusal. */
  fields: string[];
  run(payload: Record<string, unknown>, ctx: Ctx): Promise<ToolOutcome>;
}

// ── small shared checks ──────────────────────────────────────────────────────

export const refuse = (status: number, say: string): Refusal => ({ ok: false, status, say });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A category id is a stable slug in the app's own list.
export const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * An id the read door handed out, echoed back.
 *
 * Deliberately NOT a uuid check, and the same reasoning as the read door's idArg:
 * `workouts.id` is a uuid, but a meal id written by an older app version comes
 * from mealLog's own rowId() ("m9k2x-1f"), and a routine id may be one of the code
 * seeds ("seed-gino-upper-a"). A uuid regex would refuse rows that exist.
 */
export const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A finite number, and not a numeric string — a string that looks like a number
 *  is a sign the caller guessed at the shape. */
export function money(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

export const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The date this write is for. Defaults to Arizona's today — never the runtime's,
 * which from 5 PM onward is already tomorrow.
 *
 * `backDays` is how far back the tool is willing to look. It is small on purpose:
 * a weigh-in from three months ago is a typo far more often than a memory, and a
 * wrong date is invisible in a chat.
 */
export function dateFor(
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
