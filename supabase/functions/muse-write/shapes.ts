// What goes INSIDE a write — the keys a list item takes, the other spellings the door
// will take for them, and how a refusal about any of it is said.
//
// FOUND 2026-10-10, in a scan of the door's own audit log. Close to half the calls that
// failed were not a wrong tool or a wrong id: they were the assistant guessing a field
// name or the shape of a list, and the door either refusing one guess at a time or,
// worse, quietly dropping what it did not recognise. The worst case was a back-fill of
// several workouts sent at once: every one came back refused, then refused again for a
// different reason, then again — no `name` on the exercise, then a name the library did
// not know, then no minutes. Each refusal named ONE problem, so each fix only uncovered
// the next, and nearly all of that person's refusals that week were that one back-fill.
//
// Four things went wrong together, and this file is where three of them are fixed:
//
//   1  THE TWO DOORS SPOKE DIFFERENT WORDS. The read door answers `protein_g`,
//      `duration_min` and `weight_lb`; the write door wanted `p`, `minutes` and
//      `weight`. An assistant that read a meal and wrote one back was refused for using
//      the door's own vocabulary. READ_DOOR_NAMES below makes the read door's words
//      good on the write door too.
//   2  A LIST ITEM HAD NO KEY CHECK. The top level of every call refuses an unknown
//      field by name (handler.ts) — but inside an exercise, a meal item or a set, an
//      unknown key was simply ignored. That is not a convenience. A set sent as
//      `{ reps: 8, weight_lb: 30 }` was saved as a BODYWEIGHT set: `weight_lb` was
//      dropped, the missing weight became 0, and the reply said "logged". renameAliases()
//      below gives every list item the same rule the top level has.
//   3  EACH REFUSAL NAMED ONE PROBLEM, and never said what it had been sent. itemSays()
//      and shapeSays() are how every problem in a call is said in ONE reply, each with
//      the keys that item actually carried, so one correction fixes all of it.
//
// The fourth — refused calls spending the 60-writes-an-hour budget — is handler.ts's,
// which now runs these checks before it counts anything.
//
// NOTHING HERE READS THE DATABASE OR A CLOCK, and that is load-bearing: handler.ts runs
// these checks before the rate counter, precisely because they cost nothing.

import { scrubName } from "../_shared/muse/scrub.ts";

/**
 * The read door's word for something → the write door's word for the same thing.
 *
 * Every one of these is a name the READ door hands out (healthRead.ts: `macros()`,
 * `saySet`, `sayExercise`, the weigh-in log), so an assistant that copies a value it
 * just read keeps the word it read it under. `calories` is the plain-English one a
 * person says, and is here for the same reason.
 *
 * Applied wherever the write door's word is a field the tool or the list item takes —
 * top level or inside a list. A tool that does not take `kcal` does not suddenly take
 * `calories` either: an alias only ever stands in for a field that exists.
 *
 * Sending BOTH spellings of one field is refused (see renameAliases), rather than one
 * of them winning. Two values for one thing is a caller with two answers and no way to
 * say which it meant — the same reasoning readItem already applies to a food_id sent
 * beside loose macros.
 */
export const READ_DOOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  calories: "kcal",
  protein_g: "p",
  carbs_g: "c",
  fat_g: "f",
  duration_min: "minutes",
  duration: "minutes",
  weight_lb: "weight",
});

/** Own-property lookup. A plain object answers `"constructor" in x` for every key on
 *  Object.prototype — the bug handler.ts already met once with tool names — so a key
 *  called `toString` must not find an alias. */
const own = (o: Readonly<Record<string, string>>, k: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

/** A key the caller sent, made safe to say back — a key is a string the caller chose,
 *  and it lands in the reply and in the audit log. The same treatment handler.ts gives
 *  a top-level field. */
export const sayKey = (k: string): string => scrubName(k, 24) || "?";

/** The keys an object carried, made safe to say, in the order they were sent. */
export const keysOf = (o: Record<string, unknown>): string[] => Object.keys(o).map(sayKey);

export interface Renamed {
  /** The object with every alias replaced by the word it stands for. */
  value: Record<string, unknown>;
  /** Keys that are neither a field nor an alias for one. Raw — say them with sayKey. */
  unknown: string[];
  /** One sentence per field that arrived under two spellings. */
  clashes: string[];
}

/**
 * Put every alias under the word it stands for, and sort out what is left.
 *
 * `takes` is the list of real keys at this level. `extra` is any alias that only makes
 * sense here — `exercise` for an exercise's `name` inside a workout, where the same
 * word at the top level of health.log_sets is already a field of its own.
 */
export function renameAliases(
  raw: Record<string, unknown>,
  takes: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): Renamed {
  const value: Record<string, unknown> = {};
  const unknown: string[] = [];
  const spellings = new Map<string, string[]>();
  for (const [k, v] of Object.entries(raw)) {
    const target = takes.includes(k) ? k : own(extra, k) ?? own(READ_DOOR_NAMES, k);
    if (target === undefined || !takes.includes(target)) {
      unknown.push(k);
      continue;
    }
    spellings.set(target, [...(spellings.get(target) ?? []), k]);
    value[target] = v;
  }
  const clashes: string[] = [];
  for (const [target, sent] of spellings) {
    if (sent.length < 2) continue;
    clashes.push(`${sent.map(sayKey).join(" and ")} are two names for ${target} — send one of them.`);
  }
  return { value, unknown, clashes };
}

/**
 * What one kind of list item takes: its real keys, any alias that only means something
 * at this level, and the lists nested inside it.
 *
 * Declared ONCE per kind of item, next to the parser that reads it (SET_SHAPE beside
 * readSet in healthTools.ts, and so on), and used twice: by that parser, through
 * renameAliases, and by a tool's `lists`, which tells handler.ts where the lists in a
 * call are so canonicalArgs below can put their aliases under their real names too.
 * Two copies of "what a set takes" would be the drift this file exists to stop, so
 * there is one, and tests/museShapes.test.ts walks every example against these.
 */
export interface ListShape {
  takes: readonly string[];
  extra?: Readonly<Record<string, string>>;
  lists?: Readonly<Record<string, ListShape>>;
}

/** renameAliases with a ListShape, so a parser and the canonical form below read one
 *  declaration. */
export const renameBy = (raw: Record<string, unknown>, shape: ListShape): Renamed =>
  renameAliases(raw, shape.takes, shape.extra);

/**
 * The call as the door's own words would have spelled it, at every level — for telling
 * whether two calls are THE SAME, and for nothing else.
 *
 * FOUND IN REVIEW 2026-10-10. handler.ts renames the read door's words at the top level
 * before it takes a call's fingerprint, so `weight_lb: 182.4` and `weight: 182.4` were
 * one request to the duplicate guard. Inside a list they were not: a meal sent with
 * `calories`, `protein_g`, `carbs_g` and `fat_g` and then again with `kcal`, `p`, `c` and
 * `f` printed two different fingerprints, so it was logged twice — exactly the case of
 * an assistant whose reply timed out after the write landed, which retries under a new
 * key having switched spellings after reading the example. Same for `weight_lb` in a
 * set, and `exercise`, `duration_min` or `duration` in a logged workout's exercises.
 *
 * So each list a tool declares is walked, and every item's aliases are put under the
 * word they stand for, recursively. Deliberately forgiving, because it judges nothing:
 *
 *   · a key that is neither a field nor an alias is KEPT as it was sent — two calls that
 *     differ in a stray key are two different calls, and the shape check refuses both;
 *   · an item that sent two spellings of one field is left exactly as it was, for the
 *     same reason (the shape check refuses it);
 *   · anything that is not a list of objects where a list was declared is left alone.
 *
 * And a call that carries no alias comes out IDENTICAL to what was sent, key for key,
 * so every fingerprint already stored in muse_audit still matches its own retry.
 */
export function canonicalArgs(
  args: Record<string, unknown>,
  lists: Readonly<Record<string, ListShape>> | undefined,
): Record<string, unknown> {
  if (!lists) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [field, shape] of Object.entries(lists)) {
    const v = args[field];
    if (Array.isArray(v)) out[field] = v.map((item) => canonicalItem(item, shape));
  }
  return out;
}

function canonicalItem(item: unknown, shape: ListShape): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const raw = item as Record<string, unknown>;
  const named = renameBy(raw, shape);
  if (named.clashes.length) return raw;
  const out: Record<string, unknown> = { ...named.value };
  // The stray keys go back in under their own names, so they still count as different.
  // defineProperty, not `out[k] =`, so a key called `__proto__` stays an ordinary
  // property instead of quietly becoming the object's prototype.
  for (const k of named.unknown) Object.defineProperty(out, k, { value: raw[k], enumerable: true, writable: true, configurable: true });
  return shape.lists ? canonicalArgs(out, shape.lists) : out;
}

/**
 * One list item's problems, as one sentence that names the item and says what it held.
 *
 * `label` is "Exercise 2 (Walking)" or "Food 1": numbered from one, because that is how
 * a person counts the list they just said, and with the item's own name when it has
 * one, because "the third one" is hard to find in a back-fill of six.
 */
export function itemSays(label: string, problems: readonly string[], had: Record<string, unknown> | null): string {
  const held = had === null ? "" : ` It had ${Object.keys(had).length ? keysOf(had).join(", ") : "no keys at all"}.`;
  return `${label}: ${problems.join(" ")}${held}`;
}

/** "Exercise 2", or "Exercise 2 (Walking)" when the item has a name worth saying. The
 *  name must already be cleaned. */
export const labelOf = (kind: string, index: number, name?: string): string =>
  name ? `${kind} ${index + 1} (${name})` : `${kind} ${index + 1}`;

/** "It does not take reps, kg." — the in-list twin of handler.ts's top-level sentence,
 *  with the keys it DOES take, so the next try can be right. */
export const unknownKeysSays = (unknown: readonly string[], takes: readonly string[]): string =>
  `It does not take ${unknown.map(sayKey).join(", ")} — it takes ${takes.join(", ")}.`;

/** Neither an array nor an object where one was needed: say what arrived instead. */
export const kindOfValue = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : `a ${typeof v}`;

/**
 * Said beside an example, every time one is handed back.
 *
 * FOUND IN REVIEW 2026-10-10. The warning that an example's values are made up lived only
 * in the served description, while every shape refusal hands the example back in its
 * body — and an assistant stuck on a refusal is the one most likely to send back the
 * last thing it was given. Most examples carry no id, so sent as they stand they are
 * real writes: a weigh-in, a reminder, a macro target. handler.ts now refuses a call that
 * IS its tool's example; this sentence is the other half, said before it happens.
 */
export const EXAMPLE_SAYS =
  "The example beside this shows the shape only — every value in it is made up, so never send it as it stands.";

/**
 * The whole refusal for a call whose shape was wrong: every problem, then what was sent.
 *
 * "Nothing was written" FIRST, because it is the one thing a person needs to hear if
 * the assistant reads this out — and it is true: every caller of this refuses before
 * any write. `withExample` is for the reply that carries the tool's example beside the
 * sentence (handler.ts), which says what the example is for.
 */
export function shapeSays(problems: readonly string[], sent: readonly string[], withExample = false): string {
  const keys = sent.length ? sent.join(", ") : "no fields at all";
  return `Nothing was written. ${problems.join(" ")} You sent: ${keys}.${withExample ? ` ${EXAMPLE_SAYS}` : ""}`;
}
