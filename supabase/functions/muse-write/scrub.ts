// Rule 4: every string that crosses this door is scrubbed. Both ways.
//
// OUTWARD is the direction people forget. Anything the door says lands in the
// assistant's context labelled as trusted output from a connector he installed.
// Some of those strings are typed by people — a transaction description is free
// text either of them enters, and a bank descriptor or a payment memo line is
// written by whoever sent the money. So someone who can get a sentence into a
// memo line can get words into his assistant's head. "No raw ledger rows" does
// not cover that at all, because a name is not a row.
//
// INWARD matters here too, because this is the WRITE door. A reminder message
// ends up on a lock screen, and a queued charge description ends up in the
// ledger — where a read tool could later hand it back out. Cleaning on the way
// in means the bad string never gets stored in the first place.
//
// What the cleaner does, in order: drop control characters and newlines, drop
// anything URL-shaped, drop anything instruction-shaped, squeeze the spaces, and
// cap the length. If a string cannot survive that, the door sends an id instead
// and lets the app be the place names are read.

/** Rule 4's default cap for anything the door SAYS. */
export const SCRUB_CAP = 64;

/** The cap on a reminder in his own words. PLAN.md §5. The stored message is
 *  this plus the six-character "Muse: " marker, so the line that reaches a lock
 *  screen is at most 86 characters. */
export const MESSAGE_CAP = 80;

/** The marker every assistant-written reminder starts with, so both phones can
 *  see at a glance that an assistant wrote it and Homebase did not. */
export const MUSE_MARKER = "Muse: ";

// Instruction-shaped text. Not a security boundary on its own — a determined
// injection will find words that are not on this list. It is here because the
// cheap, common attempts are worth stopping, and because a string that trips it
// is a string nobody needed.
const INSTRUCTION_SHAPED: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?previous/gi,
  /disregard\s+(all\s+|any\s+)?(previous|prior)/gi,
  /\bsystem\s*:/gi,
  /\bassistant\s*:/gi,
  /\buser\s*:/gi,
  /\{\{/g,
  /\}\}/g,
  /`/g,
];

/**
 * Clean one string. Returns "" when nothing usable survives — callers decide
 * whether an empty result is a refusal or a dropped field, because those are
 * different bugs.
 */
export function scrub(input: unknown, cap: number = SCRUB_CAP): string {
  if (typeof input !== "string") return "";
  let s = input;
  // Control characters, newlines and tabs → a space. Done first so a newline
  // cannot hide the middle of a URL from the patterns below. The control range is
  // the whole point of the expression, hence the disable.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  // Anything URL-shaped.
  s = s.replace(/https?:\/\/\S*/gi, " ");
  s = s.replace(/\bwww\.\S*/gi, " ");
  s = s.replace(/:\/\//g, " ");
  // Anything instruction-shaped.
  for (const re of INSTRUCTION_SHAPED) s = s.replace(re, " ");
  // Squeeze, then cap. Cutting BEFORE the squeeze would spend the budget on
  // whitespace.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > cap) s = s.slice(0, cap).trimEnd();
  return s;
}

/**
 * Did cleaning take something out? The reminder tool uses it to say so out loud —
 * a message that arrives shorter than he said it should not arrive silently
 * shorter.
 *
 * Squeezed whitespace does not count. Saying "I took the links out" because two
 * spaces became one would be a small lie, and the whole value of this sentence is
 * that it is only said when it is true.
 */
export function wasChanged(input: string, cleaned: string): boolean {
  return input.replace(/\s+/g, " ").trim() !== cleaned;
}
