// Suggested repairs. A repair is only ever SHOWN: when exactly one repair fitted every
// check in the research it was still the wrong one 4.0% of the time (types.ts rule 2).
//
// This search runs the simulated OCR channel exactly backwards, so on that channel its
// wrong-repair rate falls to 0.1% — but that is close to true by construction, because
// the real value is always among its candidates. Against misreads OUTSIDE the model
// (two digits swapped, a digit doubled) it offered a single, necessarily wrong repair
// for 15.5% of them (tests/labelScan.research.test.ts). A camera makes both kinds, which
// is why rule 2 stands.
import { fieldName, formatAmount, formatNumber, verify } from "./verify";
import type { CheckName, FieldKey, PanelColumn, ParsedPanel, ReadValue, Repair } from "./types";

// The channel: which printed digit gets READ as which. These are the well-documented
// confusions on printed labels that the research simulated (label_channel.py CONFUSE).
const MISREAD_AS: Record<string, string> = {
  "0": "689",
  "1": "74",
  "2": "7",
  "3": "8",
  "4": "1",
  "5": "68",
  "6": "508",
  "7": "12",
  "8": "3069",
  "9": "80",
};

// Repair runs the channel backwards: for each digit that was READ, the printed digits
// that could have produced it. Almost symmetric, except 5 is read as 8 but 8 is not read as 5.
const COULD_HAVE_BEEN: Record<string, string> = {};
for (const [printed, reads] of Object.entries(MISREAD_AS)) {
  for (const r of reads) COULD_HAVE_BEEN[r] = (COULD_HAVE_BEEN[r] ?? "") + printed;
}

/**
 * The number inside a raw read, normalised: "<2,5 g" → "2.5", "1,200" → "1200".
 * A comma followed by exactly three digits is a thousands separator; any other comma
 * is a decimal comma, as printed on European and many Chinese labels.
 */
export function numberText(raw: string): string {
  const m = raw.match(/\d[\d.,]*/);
  if (!m) return "";
  let s = m[0].replace(/[.,]+$/, "");
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(/,/g, ".");
  return s;
}

const WELL_FORMED = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * What the printed text could have been, given what was read: every single OCR
 * confusion run backwards. A read of "89" may have been "8" (the unit g read as a 9),
 * "25" may have been "2.5" (a dropped decimal point), "50" may have been "150" or
 * "500" (a clipped digit), and each digit may have been one that is misread as it.
 *
 * Returns number strings only — deduplicated, never empty, at most one decimal point,
 * no leading zeros, and never a value equal to the read itself.
 */
export function ocrConfusions(raw: string): string[] {
  const s = numberText(raw);
  if (!s) return [];
  const out = new Set<string>();
  // One digit misread.
  for (let i = 0; i < s.length; i++) {
    for (const t of COULD_HAVE_BEEN[s[i]] ?? "") out.add(s.slice(0, i) + t + s.slice(i + 1));
  }
  // A dropped decimal point.
  if (!s.includes(".")) {
    for (let i = 1; i < s.length; i++) out.add(`${s.slice(0, i)}.${s.slice(i)}`);
  }
  // The unit "g" read as a trailing 9.
  if (s.length > 1 && s.endsWith("9")) out.add(s.slice(0, -1));
  // A clipped leading or trailing digit.
  for (let d = 0; d <= 9; d++) {
    out.add(`${d}${s}`);
    out.add(`${s}${d}`);
  }
  const value = Number(s);
  return [...out].filter((c) => WELL_FORMED.test(c) && Number(c) !== value);
}

// ── suggestRepairs ───────────────────────────────────────────────────────────

type Kind = Repair["target"]["kind"];

function withValue(panel: ParsedPanel, columnIndex: number, field: FieldKey, kind: Kind, rv: ReadValue): ParsedPanel {
  const col = panel.columns[columnIndex];
  const next: PanelColumn =
    kind === "amount" ? { ...col, fields: { ...col.fields, [field]: rv } } : { ...col, refPct: { ...col.refPct, [field]: rv } };
  const columns = panel.columns.slice();
  columns[columnIndex] = next;
  return { ...panel, columns };
}

/** One plain sentence citing the strongest evidence the repair satisfies. */
function because(panel: ParsedPanel, col: PanelColumn, field: FieldKey, kind: Kind, from: ReadValue, to: number, fixes: CheckName[]): string {
  const f = col.fields;
  const name = fieldName(field).toLowerCase();
  if (fixes.includes("ref")) {
    if (kind === "amount" && col.refPct[field]) {
      return `The ${formatNumber(col.refPct[field]!.value)}% printed beside it only fits ${formatAmount(field, to)}.`;
    }
    if (kind === "refPct" && f[field]) {
      return `${formatAmount(field, f[field]!.value)} of ${name} works out to ${formatNumber(to)}%, not ${formatNumber(from.value)}%.`;
    }
  }
  if (fixes.includes("units")) {
    if (field === "kcal" && f.kj) return `The ${formatAmount("kj", f.kj.value)} printed beside it only fits ${formatAmount("kcal", to)}.`;
    if (field === "kj" && f.kcal) return `The ${formatAmount("kcal", f.kcal.value)} printed beside it only fits ${formatAmount("kj", to)}.`;
    if (field === "salt" && f.sodium) return `The ${formatAmount("sodium", f.sodium.value)} of sodium only fits ${formatAmount("salt", to)} of salt.`;
    if (field === "sodium" && f.salt) return `The ${formatAmount("salt", f.salt.value)} of salt only fits ${formatAmount("sodium", to)} of sodium.`;
  }
  if (fixes.includes("energy")) {
    if (field === "kcal") return `The protein, carbs and fat printed with it only fit ${formatNumber(to)} calories.`;
    if (field === "kj") return `The protein, carbs and fat printed with it only fit ${formatAmount("kj", to)}.`;
    return `The energy printed on the label only adds up with ${formatAmount(field, to)} of ${name}.`;
  }
  if (fixes.includes("parts")) return `Only ${formatAmount(field, to)} of ${name} keeps every part of the label within its total.`;
  if (fixes.includes("mass")) {
    const grams = col.servingGrams ?? panel.serving?.value;
    return `Only ${formatAmount(field, to)} of ${name} fits inside the ${grams ? `${formatNumber(grams)} g ` : ""}it is printed for.`;
  }
  return `${formatNumber(from.value)} can't be printed for ${name}; ${formatNumber(to)} can, and it is a common misread of it.`;
}

/**
 * Single-token repairs that make a conflicting panel consistent, drawn ONLY from
 * known OCR confusions. Suggestions — the caller must never apply one without a
 * person's tap (types.ts rule 2). Empty when the panel is already consistent or
 * no unique repair explains the conflict.
 */
export function suggestRepairs(panel: ParsedPanel, columnIndex = 0): Repair[] {
  const col = panel.columns[columnIndex];
  if (!col) return [];
  const before = verify(panel, columnIndex);
  if (before.consistent) return [];

  // A changed token can only turn a failing check into a passing one if that check
  // reads it, and EVERY failure must pass afterwards. So the only tokens worth trying
  // belong to fields that every failure involves. This is exact, not a heuristic, and
  // it is what keeps the search cheap.
  let shared = new Set<FieldKey>(before.failures[0].fields);
  for (const fail of before.failures.slice(1)) shared = new Set(fail.fields.filter((k) => shared.has(k)));

  const fits: Array<{ field: FieldKey; kind: Kind; from: ReadValue; to: number }> = [];
  for (const field of shared) {
    for (const kind of ["amount", "refPct"] as const) {
      const from = kind === "amount" ? col.fields[field] : col.refPct[field];
      if (!from) continue;
      const tried = new Set<number>([from.value]);
      for (const text of ocrConfusions(from.raw || formatNumber(from.value))) {
        const to = Number(text);
        if (!Number.isFinite(to) || tried.has(to)) continue;
        tried.add(to);
        if (verify(withValue(panel, columnIndex, field, kind, { ...from, value: to, raw: text }), columnIndex).consistent) {
          fits.push({ field, kind, from, to });
        }
      }
    }
  }
  // Several repairs fitting means the label cannot say which one is true: abstain.
  if (fits.length !== 1) return [];

  const { field, kind, from, to } = fits[0];
  const fixes = [...new Set(before.failures.map((x) => x.check))];
  return [{ target: { field, kind }, from, to, because: because(panel, col, field, kind, from, to, fixes), fixes }];
}
