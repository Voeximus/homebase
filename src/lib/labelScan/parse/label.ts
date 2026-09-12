// Row label → what the row is. Label letters may be matched fuzzily (OCR reads
// "Tota1 Fat" and "Saturted Fat"); numbers never are — that is rule 1, and it
// lives in the lexer, not here.

import type { FieldKey, Regime } from "../types";
import { labelKey, type Lexeme } from "./lexer";
import { CJK, FILLER, LATIN, type RowKey, type Synonym } from "./lexicon";
import { editDistance } from "./text";

export interface LabelMatch {
  key: RowKey;
  syn: Synonym;
  /** Character offset in the row where the matched label words end. */
  end: number;
  /** Set when the Chinese and English halves of a bilingual label disagree. */
  conflict?: string;
}

/**
 * Edits allowed for a synonym of this length. Short nouns get none: "fat", "salt"
 * and "sat" are one letter apart from each other, and a fuzzy "fat" would swallow
 * every one of them.
 */
function tolerance(len: number): number {
  return len <= 4 ? 0 : len <= 9 ? 1 : 2;
}

/** Longest contiguous run of label words considered as one label ("includes added sugars" is 3). */
const MAX_WINDOW = 5;

/**
 * Words outside the matched label that are not filler. More than this and the
 * row is prose (an ingredients list mentioning "sugar", the footnote's "2,000
 * calories a day"), not a panel row.
 */
const MAX_EXTRAS = 2;

interface Scored extends LabelMatch {
  score: number;
}

function matchLatin(regime: Regime, lx: Lexeme[]): Scored | null {
  const words = lx.filter((l) => l.kind === "word").map((l) => ({ key: labelKey(l.text), l }));
  if (!words.length) return null;
  const isFiller = words.map((w) => FILLER.has(w.key));
  const nonFiller = isFiller.filter((f) => !f).length;
  let best: Scored | null = null;
  for (let i = 0; i < words.length; i++) {
    let joined = "";
    let insideNonFiller = 0;
    for (let j = i; j < Math.min(words.length, i + MAX_WINDOW); j++) {
      joined += words[j].key;
      if (!isFiller[j]) insideNonFiller++;
      if (!joined) continue;
      const extras = nonFiller - insideNonFiller;
      for (const syn of LATIN[regime]) {
        const tol = tolerance(syn.form.length);
        if (Math.abs(joined.length - syn.form.length) > tol) continue;
        const d = joined === syn.form ? 0 : editDistance(joined, syn.form);
        if (d > tol) continue;
        // A serving line carries a household measure of any length ("3/4 cup (30g/about 12 pieces)").
        const servingLine = syn.key === "servingSize" || syn.key === "servingsPer";
        if (!servingLine && extras > MAX_EXTRAS) continue;
        const score = syn.form.length - 4 * d - 0.5 * extras;
        if (!best || score > best.score) best = { key: syn.key, syn, end: words[j].l.end, score };
      }
    }
  }
  return best;
}

function matchCjk(regime: Regime, lx: Lexeme[]): Scored | null {
  const syns = CJK[regime];
  // "其中" (of which) and a dash lead indented rows; they are not part of the noun.
  const runs = lx.filter((l) => l.kind === "cjk" && l.text !== "项目");
  if (!syns.length || !runs.length) return null;
  let best: Scored | null = null;
  for (let i = 0; i < runs.length; i++) {
    let joined = "";
    for (let j = i; j < Math.min(runs.length, i + 3); j++) {
      joined += runs[j].text;
      const stripped = joined.startsWith("其中") && joined.length > 2 ? joined.slice(2) : joined;
      const extras = runs.length - (j - i + 1);
      if (extras > 1) continue;
      for (const syn of syns) {
        let d = stripped === syn.form ? 0 : Infinity;
        // One wrong character is tolerated only in long nouns; "钠" vs "钙" is a different row.
        if (d !== 0 && syn.form.length >= 4 && Math.abs(stripped.length - syn.form.length) <= 1) {
          d = editDistance(stripped, syn.form);
        }
        if (d > 1) continue;
        // A Chinese character carries roughly what two Latin letters do; weight so bilingual rows compare fairly.
        const score = 2 * syn.form.length - 4 * d - extras;
        if (!best || score > best.score) best = { key: syn.key, syn, end: runs[j].end, score };
      }
    }
  }
  return best;
}

export function matchLabel(regime: Regime, lx: Lexeme[]): LabelMatch | null {
  const cjk = matchCjk(regime, lx);
  const latin = matchLatin(regime, lx);
  if (cjk && latin && cjk.key !== latin.key) {
    return {
      key: cjk.key,
      syn: cjk.syn,
      end: Math.max(cjk.end, latin.end),
      conflict: `the Chinese label reads as "${cjk.syn.form}" but the English as "${latin.syn.form}"; used the Chinese`,
    };
  }
  if (cjk && latin) return { key: cjk.key, syn: cjk.syn, end: Math.max(cjk.end, latin.end) };
  const m = cjk ?? latin;
  return m ? { key: m.key, syn: m.syn, end: m.end } : null;
}

/**
 * How much a row's label resembles a field, for placing a garbled row by the
 * regulation's order. 0 = identical, 1 = nothing in common. An empty label (the
 * OCR lost it entirely) returns 0: position is then the only evidence there is.
 */
export function labelDistance(regime: Regime, lx: Lexeme[], field: FieldKey): number {
  const latin = lx
    .filter((l) => l.kind === "word")
    .map((l) => labelKey(l.text))
    .join("");
  const cjk = lx
    .filter((l) => l.kind === "cjk")
    .map((l) => l.text)
    .join("");
  if (!latin && !cjk) return 0;
  let best = 1;
  for (const syn of [...LATIN[regime], ...CJK[regime]]) {
    if (syn.key !== field) continue;
    const text = /[a-z]/.test(syn.form) ? latin : cjk;
    if (!text) continue;
    best = Math.min(best, editDistance(text, syn.form) / Math.max(text.length, syn.form.length));
  }
  return best;
}
