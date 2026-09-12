// One printed line → words, amounts, percentages. This is where rule 1 lives:
// a number's `raw` is sliced from the recognised text, and its `value` is the
// parse of that text and nothing more. The only liberty taken is reading a
// LETTER that sits in a digit slot (O→0, l/I→1, S→5) so the value parses at all,
// and every such reading leaves a note that surfaces as a warning if the number
// is used.

import type { Regime } from "../types";
import type { Row } from "./rows";
import { isCjk, isDigit, isLatin, isLower, isSpace, isUpper } from "./text";

export type Unit = "g" | "mg" | "mcg" | "kcal" | "kj" | "ml" | "%";

export interface Lexeme {
  kind: "word" | "cjk" | "amount" | "pct" | "fraction" | "punct";
  /** Offsets into Row.raw / Row.norm (same indexing). */
  start: number;
  end: number;
  /** Folded text of the span. */
  text: string;
  /** Numbers only: the exact source text of qualifier + number, without the unit. */
  raw?: string;
  value?: number;
  unit?: Unit;
  lessThan?: boolean;
  /** Page token index holding the first digit. */
  token?: number;
  /** Where the digits themselves sit, for column geometry (the unit is excluded). */
  numStart?: number;
  numEnd?: number;
  /** Interpretations made while reading this number — shown only if the number is used. */
  notes?: string[];
}

// Longest first, so "mg" wins over "g" and "kcal" over "cal".
const LATIN_UNITS: Array<[string, Unit]> = [
  ["kcal", "kcal"],
  ["grams", "g"],
  ["gram", "g"],
  ["mcg", "mcg"],
  ["cal", "kcal"],
  ["mg", "mg"],
  ["kj", "kj"],
  ["ml", "ml"],
  ["µg", "mcg"],
  ["μg", "mcg"],
  ["ug", "mcg"],
  ["g", "g"],
];
const CJK_UNITS: Array<[string, Unit]> = [
  ["毫克", "mg"],
  ["微克", "mcg"],
  ["千焦", "kj"],
  ["千卡", "kcal"],
  ["毫升", "ml"],
  ["克", "g"],
];

/** A unit starting at `pos` that ENDS at a word boundary, so the "g" of "grain" is not a unit. */
export function unitAt(s: string, pos: number): { unit: Unit; len: number } | null {
  if (s[pos] === "%") return { unit: "%", len: 1 };
  for (const [form, unit] of CJK_UNITS) {
    if (s.startsWith(form, pos)) return { unit, len: form.length };
  }
  const lower = s.slice(pos, pos + 5).toLowerCase();
  for (const [form, unit] of LATIN_UNITS) {
    if (!lower.startsWith(form)) continue;
    const after = s[pos + form.length];
    const last = s[pos + form.length - 1];
    // A merged "10gAdded" still ends the unit: lower-case unit, upper-case next word.
    const boundary = !isLatin(after) || (isLower(last) && isUpper(after));
    if (boundary) return { unit, len: form.length };
  }
  return null;
}

const LETTER_DIGIT: Record<string, string> = { O: "0", o: "0", l: "1", I: "1", S: "5" };
const CORE = /[0-9OoIlS]+(?:[.,][0-9OoIlS]+)*/y;

interface Parsed {
  value: number;
  notes: string[];
}

/** Parse number text (letters already mapped to digits). null when the separators make no sense. */
export function parseNumberText(t: string, regime: Regime): Parsed | null {
  if (/^\d+(\.\d+)?$/.test(t)) return { value: Number(t), notes: [] };
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, "")), notes: [] };
  if (/^\d{1,3},\d{1,2}$/.test(t)) {
    const value = Number(t.replace(",", "."));
    const where = regime === "us" ? "a US label, where a decimal comma is unusual" : "a decimal comma";
    return { value, notes: [`read "${t}" as ${value} (${where})`] };
  }
  return null;
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

/**
 * Try to read a number at `pos`. Returns null if what is there is really part of
 * a word. `qualStart` is where a "<" / "less than" began, if any.
 */
function readNumber(row: Row, pos: number, regime: Regime, qualStart: number | null): Lexeme | null {
  const s = row.norm;
  CORE.lastIndex = pos;
  const m = CORE.exec(s);
  if (!m) return null;
  let end = pos + m[0].length;
  // Letters swallowed at the end belong to a following word ("5Sodium" is 5 + Sodium).
  while (end > pos && isLatin(s[end - 1]) && isLatin(s[end]) && !unitAt(s, end)) end--;
  while (end > pos && (s[end - 1] === "." || s[end - 1] === ",")) end--;
  if (end <= pos) return null;
  const core = s.slice(pos, end);
  const hasDigit = /[0-9]/.test(core);
  const hasLetter = /[^0-9.,]/.test(core);
  const uPos = skipSpaces(s, end);
  const u = unitAt(s, uPos);
  // A letter-only reading ("Og" for "0g") must be backed by a unit right after it;
  // otherwise "Oil" or "Is" would become numbers.
  if (!hasDigit && (!u || core.length > 2)) return null;
  // A letter-mapped reading glued to a following lower-case word is that word ("So" of "Sodium").
  // Plain digits stay a number: a tight merge prints "8servings per container".
  if (!u && hasLetter && isLower(s[end])) return null;

  const mapped = hasLetter ? core.replace(/[OoIlS]/g, (c) => LETTER_DIGIT[c]) : core;
  const parsed = parseNumberText(mapped, regime);
  const notes: string[] = parsed ? [...parsed.notes] : [];
  if (hasLetter) notes.unshift(`read the letters in "${row.raw.slice(pos, end)}" as the digits "${mapped}"`);

  // "2/3 cup": a fraction is one quantity, not two amounts.
  if (!u && !hasLetter && s[skipSpaces(s, end)] === "/") {
    const after = skipSpaces(s, skipSpaces(s, end) + 1);
    const dm = /\d+/y;
    dm.lastIndex = after;
    const d = dm.exec(s);
    if (d) {
      const fEnd = after + d[0].length;
      // "1046/250kcal" is two energies; only a bare n/d is a household fraction.
      if (!unitAt(s, skipSpaces(s, fEnd))) {
        return {
          kind: "fraction",
          start: pos,
          end: fEnd,
          text: s.slice(pos, fEnd),
          raw: row.raw.slice(pos, fEnd),
          value: Number(core) / Number(d[0]),
          token: row.charTok[pos],
          numStart: pos,
          numEnd: fEnd,
        };
      }
    }
  }

  const start = qualStart ?? pos;
  const lexEnd = u ? uPos + u.len : end;
  return {
    kind: u?.unit === "%" ? "pct" : "amount",
    start,
    end: lexEnd,
    text: s.slice(start, lexEnd),
    raw: row.raw.slice(start, end),
    value: parsed ? parsed.value : NaN,
    unit: u && u.unit !== "%" ? u.unit : undefined,
    lessThan: qualStart !== null ? true : undefined,
    token: row.charTok[pos],
    numStart: pos,
    numEnd: end,
    notes: parsed ? notes : [...notes, `could not read "${row.raw.slice(pos, end)}" as a number`],
  };
}

/**
 * Is the digit run [j, k) inside a word rather than a number? Two cases, both
 * OCR reading a letter as a digit in LABEL text:
 *   "Satur4ted" — digits with lower-case letters on both sides and no unit after;
 *   "Tota1 Fat" — one 0/1/5 glued to the end of a word, followed by another word.
 * "Fat9g", "Calories230" and "Includes10gAdded" stay numbers.
 */
function digitsInWord(s: string, j: number, k: number): boolean {
  if (unitAt(s, k)) return false;
  if (isLower(s[k]) && k - j <= 2) return true;
  if (k - j === 1 && "015".includes(s[j])) {
    const n = skipSpaces(s, k);
    if (n > k && isLatin(s[n]) && !unitAt(s, n)) return true;
  }
  return false;
}

export function lexRow(row: Row, regime: Regime): Lexeme[] {
  const s = row.norm;
  const out: Lexeme[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    const prevLatin = isLatin(s[i - 1]);

    // "<1g", "< 1 g", "less than 1g"
    if (!prevLatin && (c === "<" || c === "≤" || c.toLowerCase() === "l")) {
      const q = /(?:<|≤|less\s*than)\s*/iy;
      q.lastIndex = i;
      const qm = q.exec(s);
      if (qm && (isDigit(s[i + qm[0].length]) || "Oo".includes(s[i + qm[0].length] ?? "x"))) {
        const n = readNumber(row, i + qm[0].length, regime, i);
        if (n) {
          out.push(n);
          i = n.end;
          continue;
        }
      }
    }

    if (isDigit(c) || (!prevLatin && "OoIlS".includes(c))) {
      const n = readNumber(row, i, regime, null);
      if (n) {
        out.push(n);
        i = n.end;
        continue;
      }
    }

    if (isLatin(c)) {
      let j = i;
      while (j < s.length) {
        if (isLatin(s[j])) {
          j++;
          continue;
        }
        if (isDigit(s[j])) {
          let k = j;
          while (isDigit(s[k])) k++;
          if (digitsInWord(s, j, k)) {
            j = k;
            continue;
          }
        }
        break;
      }
      out.push({ kind: "word", start: i, end: j, text: s.slice(i, j) });
      i = j;
      continue;
    }

    if (isCjk(c)) {
      let j = i;
      while (isCjk(s[j])) j++;
      out.push({ kind: "cjk", start: i, end: j, text: s.slice(i, j) });
      i = j;
      continue;
    }

    if (isDigit(c)) {
      // A digit run that readNumber rejected (glued into a word it could not join).
      let j = i;
      while (isDigit(s[j])) j++;
      out.push({ kind: "punct", start: i, end: j, text: s.slice(i, j) });
      i = j;
      continue;
    }

    out.push({ kind: "punct", start: i, end: i + 1, text: c });
    i++;
  }
  return out;
}

/** A Latin word as a label key: lower-case letters only, with digits that stood in for letters mapped back. */
export function labelKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[015]/g, (d) => ({ "0": "o", "1": "l", "5": "s" })[d] ?? "")
    .replace(/[^a-z]/g, "");
}
