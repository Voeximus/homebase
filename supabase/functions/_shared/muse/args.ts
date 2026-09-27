// What a read tool IS, and the handful of argument checks every tool shares.
//
// WHY THIS IS NOT IN tools.ts ANY MORE. Phase 1 had eleven read tools and one
// catalogue file, and the types and the checks lived in it. Phase 2's job is
// parity — a tool for every remaining thing the app can do — so the catalogue is
// now split by domain (finance in tools.ts, health and workouts in healthRead.ts).
// Two files that both need the same `dateArg` would either import it from each
// other, which is a cycle, or carry a copy each, which is the drift this bridge
// exists to stop: scripts/check-categorizer-sync.mjs fails the build over exactly
// that, and it already caught the two doors growing two clocks.
//
// So the shape and the checks are HERE, once, and every catalogue imports them.
// Nothing in this file reads the database, the clock, or a person.

import type { Loader } from "./load.ts";

/** Anything a reply may be made of. No functions, no undefined: a reply is JSON. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ToolContext {
  /** Forced from the secret. Never read from the request body — see the ARGS note
   *  in tools.ts. */
  person: "gino" | "xinyan";
  /** The Arizona "now", built once per request. The door's only clock reading. */
  now: Date;
  load: Loader;
  args: Record<string, unknown>;
}

export interface Tool {
  name: string;
  /** One plain sentence, used in the catalogue and in the OpenAPI description. */
  summary: string;
  /**
   * The arguments, for the OpenAPI description and for the handler's own refusal
   * of a key that is not on the list. `person` is never one of them.
   *
   * `type` is declared HERE rather than guessed in openapi.ts, which used to read
   * `name === "days" ? "integer" : "string"`. That worked for the one integer
   * argument that exists and would have quietly described the next one as a
   * string — and an assistant told "string" sends "3", and intArg refuses it, and
   * the refusal reads like the assistant's mistake.
   */
  args?: { name: string; type: "string" | "integer"; required: boolean; description: string }[];
  run(ctx: ToolContext): Promise<{ [k: string]: Json }>;
}

/** A caller sent something the tool cannot answer. A 400, not a 500. */
export class BadArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArgs";
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Is this a real calendar day? Checked arithmetically rather than by building a
 *  Date, because building one here would trip the door's own no-clocks guard for
 *  no reason — and because "2026-02-31" is a well-shaped string that would
 *  compare against real dates and quietly include or exclude a day. */
export function isRealDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : DAYS_IN_MONTH[m - 1];
  return d <= last;
}

export function dateArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !DATE.test(v)) {
    throw new BadArgs(`${name} has to be a date like 2026-09-01.`);
  }
  if (!isRealDate(v)) throw new BadArgs(`${v} is not a real date.`);
  return v;
}

/** A date argument that may be left out. The caller supplies the fallback, which
 *  is always derived from the request's one `now` — never from a clock in here. */
export function optDateArg(args: Record<string, unknown>, name: string, fallback: string): string {
  return args[name] === undefined ? fallback : dateArg(args, name);
}

export function monthArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !MONTH.test(v)) {
    throw new BadArgs(`${name} has to be a month like 2026-09.`);
  }
  return v;
}

export function intArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = args[name];
  if (v == null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BadArgs(`${name} has to be a whole number between ${min} and ${max}.`);
  }
  return v;
}

export function textArg(args: Record<string, unknown>, name: string, max = 64): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) throw new BadArgs(`${name} is missing.`);
  if (v.length > max) throw new BadArgs(`${name} is too long.`);
  return v.trim();
}

/** Optional free text. "" means "the caller did not say", which is different from
 *  "the caller said nothing usable" — the second one is a refusal. */
export function optTextArg(args: Record<string, unknown>, name: string, max = 64): string {
  return args[name] === undefined ? "" : textArg(args, name, max);
}

/**
 * An id the read door handed out, echoed back.
 *
 * Deliberately NOT a uuid check. `workouts.id` and `meal_days.meals[].id` are
 * uuids in the database, but a meal id created by an older app version comes from
 * mealLog's own rowId() ("m9k2x-1f"), and a routine id may be one of the code
 * seeds ("seed-gino-upper-a"). A uuid regex here would refuse rows that exist.
 * So: the characters an id is made of, and a length, and nothing else.
 */
export function idArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
    throw new BadArgs(`${name} has to be an id as the read door gave it to you.`);
  }
  return v;
}
