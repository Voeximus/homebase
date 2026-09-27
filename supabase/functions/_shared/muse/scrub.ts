// Rule 4 — every string that leaves a door goes through here first.
//
// WHICH DIRECTION THIS DEFENDS
//
// Not the obvious one. The obvious worry is a web page talking the assistant into
// calling the door; Meta's own gate is the only thing standing there and we cannot
// help it. This file is about the OTHER direction, which is the likelier one:
// everything the door says lands in the assistant's context labelled as trusted
// output from a connector he installed, and some of those strings are written by
// people who are not him.
//
//   · `transactions.description` is free text either of them types, or Plaid's
//     merchant name (supabase/schema.sql, src/types.ts).
//   · a bank descriptor and a payment memo line are written by whoever sent the
//     money.
//   · bill names and food names are typed in the app.
//
// So someone who can get a string into a memo line can get words into his
// assistant's head. "No raw ledger rows" does not touch any of this, because
// names and sentences are not rows.
//
// WHAT THIS DOES
//
//   · strips control characters and newlines, and collapses runs of whitespace;
//   · removes anything URL-shaped and anything instruction-shaped;
//   · REFUSES anything longer than the cap instead of slicing it, and refuses
//     anything left empty. A sliced sentence loses the half that says what it
//     meant, and a sliced offender list silently drops offenders mid-word — so
//     the caller substitutes its own fixed sentence instead, which is the
//     "send the id and let the app be the place names are read" half of Rule 4.
//
// WHAT IT DOES NOT DO, AND CANNOT
//
// It cannot make a bank descriptor safe. `never emit description or a raw bank
// descriptor at all, under any tool` is a rule about which FIELDS the door reads,
// enforced by the tools never touching them and by a test that seeds a canary
// string into every description in the fixture and asserts it appears in no
// reply. Scrubbing is the second line, not the first.

/** Names, labels, category ids — anything one of them could have typed. */
export const NAME_MAX = 64;

/** The `a`/`b` labels on an audit check ("lines", "envelope"). */
export const LABEL_MAX = 32;

// Instruction-shaped fragments. Removed rather than refused, because a real bill
// called "System: Electric" should still be answerable — it just must not arrive
// wearing a prompt's clothes. The list is deliberately short and literal: a
// cleverer matcher would be a filter to argue with rather than a rule to read.
const INSTRUCTION_SHAPES: RegExp[] = [
  /ignore\s+(all\s+)?previous/gi,
  /ignore\s+(all\s+)?above/gi,
  /disregard\s+(all\s+)?previous/gi,
  /\bsystem\s*:/gi,
  /\bassistant\s*:/gi,
  /\buser\s*:/gi,
  /`/g,
  /\{\{/g,
  /\}\}/g,
];

// URL-shaped, and dropped WHOLE rather than edited. Removing just the "http:" out
// of a link leaves "//evil.test/now" behind, which is still a destination and still
// reads as one — so the whole token goes. A link is the shortest path from "words in
// his assistant's head" to "his assistant fetched something".
const URLISH = /https?:|:\/\/|\/\/|www\.|\.[a-z]{2,}([/?#]|$)/i;

function stripControl(s: string): string {
  // Written as code points rather than as a regex with escapes in it, because a
  // regex literal containing U+2028 or U+2029 is a syntax error in some tools and
  // a silent copy hazard in every editor: they ARE line terminators, so the file
  // reads as if the expression ended. Ranges: C0 controls, DEL and the C1 block,
  // and the two Unicode line separators.
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
    out += control ? " " : ch;
  }
  return out;
}

/**
 * A database string, made safe to say — or null when it cannot be.
 *
 * Returns null for: not a string, empty, empty after cleaning, or longer than
 * `max`. Every caller must have a fixed sentence of its own ready for null. That
 * is not a nuisance; it is the rule. A door that had to emit something would end
 * up slicing.
 */
export function scrub(raw: unknown, max: number = NAME_MAX): string | null {
  if (typeof raw !== "string") return null;
  // Control characters (including newlines) become spaces, never nothing: joining
  // two words that were on separate lines invents a word that was never written.
  let s = stripControl(raw);
  // Token by token, so a link leaves nothing of itself behind.
  s = s
    .split(/\s+/)
    .filter((tok) => tok && !URLISH.test(tok))
    .join(" ");
  for (const rx of INSTRUCTION_SHAPES) s = s.replace(rx, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > max) return null;
  return s;
}

/** `scrub`, with the caller's fixed sentence when the string cannot be said. */
export function scrubOr(raw: unknown, fallback: string, max: number = NAME_MAX): string {
  return scrub(raw, max) ?? fallback;
}

/**
 * Dollars, to the cent, as a number — never a string.
 *
 * Numbers go out as numbers so nothing downstream has to parse one, and so a
 * number can never carry a sentence. A value that is not finite comes back null
 * rather than 0: "I do not know" and "zero dollars" are different answers, and
 * the whole point of this bridge is that a number in a chat has no screen beside
 * it to correct it.
 */
export function money(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

/** Whole dollars, for the places the plan says to round to the dollar. */
export function dollars(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n);
}
