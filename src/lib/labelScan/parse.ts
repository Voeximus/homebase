// OcrPage → ParsedPanel. The stages, each in its own file under ./parse/:
//
//   rows.ts     tokens in any order → printed lines (deskew, group, left → right)
//   lexicon.ts  which rulebook printed this (with the evidence), and its vocabulary
//   lexer.ts    one line → words, amounts, percentages (rule 1 lives here)
//   label.ts    a line's words → which row it is
//
// This file puts the lines into the regulation's grammar: which row is which
// field, which numbers form a column, what each column is per, and the serving.
// Anything it notices and cannot settle goes into warnings, never into a guess.

import type { Basis, FieldKey, OcrPage, PanelColumn, ParsedPanel, ReadValue, Regime } from "./types";
import { labelDistance, matchLabel, type LabelMatch } from "./parse/label";
import { labelKey, lexRow, type Lexeme } from "./parse/lexer";
import { CHILDREN, ORDER, detectRegime } from "./parse/lexicon";
import { buildRows, xSpan, type Row } from "./parse/rows";

const NAME: Record<FieldKey, string> = {
  kcal: "Calories",
  kj: "Energy (kJ)",
  fat: "Fat",
  sat: "Saturated fat",
  trans: "Trans fat",
  chol: "Cholesterol",
  sodium: "Sodium",
  salt: "Salt",
  carb: "Carbohydrate",
  fiber: "Fiber",
  sugar: "Sugars",
  added: "Added sugars",
  prot: "Protein",
};

const MG_FIELDS = new Set<FieldKey>(["chol", "sodium"]);
const ENERGY_FIELDS = new Set<FieldKey>(["kcal", "kj"]);

type RowField = FieldKey | "energy";

interface Line {
  row: Row;
  lx: Lexeme[];
  match: LabelMatch | null;
  field?: RowField;
  /** Numbers taken from a fragment line that split off this row (see attachFragments). */
  borrowed?: Lexeme[];
  /** Where each borrowed lexeme's characters live, for geometry. */
  borrowedFrom?: Map<Lexeme, Row>;
  /** This line's numbers were given to a neighbouring row. */
  attached?: boolean;
}

interface Header {
  kind: "per100g" | "per100ml" | "portion" | "usServing" | "usContainer";
  x: number;
  grams?: Lexeme;
  text: string;
}

const quote = (row: Row) => `"${row.raw.length > 60 ? row.raw.slice(0, 57) + "..." : row.raw}"`;

const isNumber = (l: Lexeme) => l.kind === "amount" && Number.isFinite(l.value);

export function parseLabel(page: OcrPage): ParsedPanel | null {
  const rows = buildRows(page);
  if (!rows.length) return null;
  const guess = detectRegime(rows);
  if (!guess) return null;
  const regime = guess.regime;
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };

  const lines: Line[] = rows.map((row) => {
    const lx = lexRow(row, regime);
    return { row, lx, match: matchLabel(regime, lx) };
  });

  const fieldRows = assignFields(page, lines, regime, warn);
  // Without a title, only a label that reads like a panel AND has panel rows counts:
  // a cereal box front says "140 CALORIES" and "0g TRANS FAT" in big type.
  if (!guess.titled && (guess.score < 5 || fieldRows.length < 3)) return null;
  if (!fieldRows.length) {
    return {
      regime,
      regimeEvidence: guess.evidence,
      columns: [],
      warnings: ["Found a nutrition panel heading but could not read any of its rows."],
    };
  }

  const serving = readServing(page, lines, regime, fieldRows[0], warn);
  const columns = buildColumns(page, lines, regime, fieldRows, serving.grams, warn);

  const panel: ParsedPanel = { regime, regimeEvidence: guess.evidence, columns, warnings };
  if (serving.value) panel.serving = serving.value;
  if (serving.text) panel.servingText = serving.text;
  if (serving.perContainer) panel.servingsPerContainer = serving.perContainer;
  return panel;
}

// ── rows → fields ─────────────────────────────────────────────────────────────

function tokenHeight(page: OcrPage, row: Row): number {
  return Math.max(...row.tokens.map((t) => page.tokens[t].h));
}

/**
 * A line holding only numbers, sitting closer to a field row than a line pitch,
 * is usually a piece of that row that the grouping split off: the %DV at the far
 * right edge of a curved or skewed panel drifts a few pixels, and the big Calories
 * number sits on its own baseline. Give it to the neighbour that is missing exactly
 * what it holds. When both neighbours qualify at similar distances, it is not
 * guessed at — the gap-fill pass below reports it.
 */
function attachFragments(page: OcrPage, lines: Line[], warn: (w: string) => void) {
  lines.forEach((line, r) => {
    if (line.field || line.match || line.lx.some((l) => l.kind === "word" || l.kind === "cjk")) return;
    const nums = line.lx.filter(isNumber);
    const pcts = line.lx.filter((l) => l.kind === "pct" && Number.isFinite(l.value));
    if (!nums.length && !pcts.length) return;
    const reach = tokenHeight(page, line.row);
    const lacks = (t: Line) => {
      if (!t.field || t.attached) return false;
      const own = [...t.lx, ...(t.borrowed ?? [])];
      return nums.length ? !own.some(isNumber) : !own.some((l) => l.kind === "pct");
    };
    const near = [lines[r - 1], lines[r + 1]]
      .filter((t): t is Line => !!t)
      .map((t) => ({ t, d: Math.abs(t.row.yc - line.row.yc) }))
      .sort((a, b) => a.d - b.d);
    // The closest line owns it, even when that line is not a field (a vitamin row's own %).
    if (!near.length || !lacks(near[0].t)) return;
    const cands = near.filter((c) => lacks(c.t) && c.d < reach);
    if (!cands.length) return;
    if (cands.length === 2 && cands[1].d < 1.5 * cands[0].d) {
      warn(`Numbers ${quote(line.row)} sit between two rows that could both own them; not used.`);
      line.attached = true;
      return;
    }
    const target = cands[0].t;
    target.borrowed = [...(target.borrowed ?? []), ...nums, ...pcts];
    target.borrowedFrom ??= new Map();
    for (const l of [...nums, ...pcts]) target.borrowedFrom.set(l, line.row);
    line.attached = true;
  });
}

function assignFields(page: OcrPage, lines: Line[], regime: Regime, warn: (w: string) => void): number[] {
  const filled = new Set<FieldKey>();
  const children = CHILDREN[regime];
  let parent: FieldKey | null = null;
  let prevField = -1;

  const childOf = (p: FieldKey | null): FieldKey | null => (p ? (children[p] ?? []).find((c) => !filled.has(c)) ?? null : null);

  lines.forEach((line, r) => {
    const m = line.match;
    if (!m) {
      // EU energy often wraps: "Energy 1046 kJ" then a line holding only "250 kcal".
      const prev = lines[r - 1];
      const bare = !line.lx.some((l) => l.kind === "word" || l.kind === "cjk");
      const nums = line.lx.filter(isNumber);
      if (
        r > 0 &&
        prevField === r - 1 &&
        prev.field === "energy" &&
        bare &&
        nums.length &&
        nums.every((n) => n.unit === "kj" || n.unit === "kcal")
      ) {
        line.field = "energy";
        prevField = r;
      }
      return;
    }
    if (m.key === "ignore" || m.key === "servingSize" || m.key === "servingsPer") return;
    if (m.conflict) warn(`Row ${quote(line.row)}: ${m.conflict}.`);

    let field: RowField | null = null;
    if (m.key === "energy") {
      field = "energy";
    } else if (m.key === "ofwhich") {
      field = childOf(parent);
      if (field) warn(`Row ${quote(line.row)} names no nutrient; read as ${NAME[field]}, the sub-row that follows ${NAME[parent!]}.`);
      else warn(`Row ${quote(line.row)} names no nutrient and no parent row fits; not used.`);
    } else if (!filled.has(m.key)) {
      field = m.key;
    } else if (m.syn.generic) {
      // US "Saturated Fat" read as just "Fat" under "Total Fat": the regulation's
      // order says the indented fat row after the total is saturated, then trans.
      field = childOf(m.key);
      if (field) warn(`Row ${quote(line.row)} reads as a second ${NAME[m.key]} row; read as ${NAME[field]} by its position under ${NAME[m.key]}.`);
      else warn(`Row ${quote(line.row)} repeats ${NAME[m.key]}; not used.`);
    } else {
      warn(`Row ${quote(line.row)} repeats ${NAME[m.key]}; the first ${NAME[m.key]} row was used.`);
    }
    if (!field) return;
    line.field = field;
    prevField = r;
    if (field !== "energy") {
      filled.add(field);
      if (children[field]) parent = field;
    }
  });

  let fieldRows = lines.flatMap((l, r) => (l.field ? [r] : []));
  if (!fieldRows.length) return fieldRows;
  attachFragments(page, lines, warn);

  // Rows inside the panel that carry numbers but matched nothing. The regulation's
  // row order is a prior: if exactly one unfilled field fits between the rows
  // above and below, and the label does not plainly say something else, it is
  // that field — reported, because it is an inference.
  const order = ORDER[regime];
  const slotOf = (f: RowField) => order.indexOf(f === "energy" ? "kcal" : f);
  const first = fieldRows[0];
  const last = fieldRows[fieldRows.length - 1];
  for (let r = first + 1; r < last; r++) {
    const line = lines[r];
    if (line.field || line.match || line.attached) continue;
    if (!line.lx.some((l) => isNumber(l) || l.kind === "pct")) continue;
    let above = r - 1;
    while (!lines[above].field) above--;
    let below = r + 1;
    while (!lines[below].field) below++;
    const slots = order
      .slice(slotOf(lines[above].field!) + 1, slotOf(lines[below].field!))
      .filter((f) => !filled.has(f) && !ENERGY_FIELDS.has(f));
    if (slots.length === 1 && labelDistance(regime, line.lx, slots[0]) <= 0.5) {
      line.field = slots[0];
      filled.add(slots[0]);
      warn(`Row ${quote(line.row)}: label not recognised; read as ${NAME[slots[0]]} because that is the row the regulation prints here.`);
    } else {
      warn(`Row ${quote(line.row)} has numbers but no recognised label; not used.`);
    }
  }
  fieldRows = lines.flatMap((l, r) => (l.field ? [r] : []));
  return fieldRows;
}

// ── serving ───────────────────────────────────────────────────────────────────

interface Serving {
  value?: ReadValue;
  grams?: number;
  text?: string;
  perContainer?: ReadValue;
}

const toRead = (l: Lexeme): ReadValue => {
  const v: ReadValue = { value: l.value!, raw: l.raw! };
  if (l.lessThan) v.lessThan = true;
  if (l.token !== undefined && l.token >= 0) v.token = l.token;
  return v;
};

const isMass = (l: Lexeme) => isNumber(l) && (l.unit === "g" || l.unit === "ml");

/**
 * The unlabelled line directly above or below `r` that split off it, if one does:
 * within a text height, and closer to `r` than to its own other neighbour.
 */
function splitPiece(page: OcrPage, lines: Line[], r: number, has: (l: Lexeme) => boolean): Line | null {
  const d = (a: number, b: number) => (lines[a] && lines[b] ? Math.abs(lines[a].row.yc - lines[b].row.yc) : Infinity);
  for (const k of [r + 1, r - 1].sort((a, b) => d(r, a) - d(r, b))) {
    const c = lines[k];
    if (!c || c.field || c.match || c.attached || !c.lx.some(has)) continue;
    const other = k > r ? k + 1 : k - 1;
    if (d(r, k) < tokenHeight(page, c.row) && d(r, k) < d(k, other)) return c;
  }
  return null;
}

function readServing(page: OcrPage, lines: Line[], regime: Regime, firstField: number, warn: (w: string) => void): Serving {
  const out: Serving = {};
  for (const [r, line] of lines.entries()) {
    const m = line.match;
    if (m?.key === "servingSize" && !out.value) {
      let after = line.lx.filter((l) => l.start >= m.end);
      let source = line.row;
      if (!after.some(isMass)) {
        // "Serving size" and its right-aligned "1 cup (28g)" drifted onto separate lines.
        const piece = splitPiece(page, lines, r, isMass);
        if (piece) {
          after = piece.lx;
          source = piece.row;
          piece.attached = true;
        }
      }
      // "2/3 cup (55g)": the grams in parentheses are the serving; the cup is for people.
      const inParens = after.find((l, k) => isMass(l) && k > 0 && after[k - 1].text === "(");
      const grams = inParens ?? [...after].reverse().find(isMass);
      if (after.length) out.text = source.raw.slice(after[0].start).trim();
      if (grams) {
        out.value = toRead(grams);
        out.grams = grams.value;
        notesToWarnings(grams, "Serving size", warn);
      } else {
        warn(`Serving size ${quote(line.row)} prints no grams or millilitres; enter the serving by hand.`);
      }
    }
    if (m?.key === "servingsPer" && !out.perContainer) {
      const count = (l: Lexeme) => isNumber(l) && !l.unit;
      let n = line.lx.find(count);
      if (!n) {
        const piece = splitPiece(page, lines, r, count);
        n = piece?.lx.find(count);
        if (piece) piece.attached = true;
      }
      if (n) {
        out.perContainer = toRead(n);
        notesToWarnings(n, "Servings per container", warn);
      } else warn(`Servings per container ${quote(line.row)}: no count could be read.`);
    }
  }
  if (!out.value && regime !== "us") {
    const portion = lines
      .slice(0, firstField)
      .flatMap((l) => scanHeaders(page, l, regime))
      .find((h) => h.kind === "portion" && h.grams);
    if (portion?.grams) {
      out.value = toRead(portion.grams);
      out.grams = portion.grams.value;
      out.text = portion.text;
    }
  }
  if (!out.value && regime === "us") warn("No serving size in grams was found.");
  return out;
}

// ── column headers ────────────────────────────────────────────────────────────

function scanHeaders(page: OcrPage, line: Line, regime: Regime): Header[] {
  if (line.field || line.match?.key === "servingSize" || line.match?.key === "servingsPer") return [];
  const L = line.lx;
  const out: Header[] = [];
  const used = new Set<Lexeme>();
  const key = (l: Lexeme | undefined) => (!l ? "" : l.kind === "word" ? labelKey(l.text) : l.text);
  const hundred = (l: Lexeme | undefined) => !!l && isMass(l) && l.value === 100;
  const push = (kind: Header["kind"], from: number, to: number, grams?: Lexeme) => {
    const [x0, x1] = xSpan(page, line.row, from, to);
    out.push({ kind, x: (x0 + x1) / 2, grams, text: line.row.raw.slice(from, to).trim() });
    if (grams) used.add(grams);
  };
  // "(30 g)" right after a heading word: returns the grams and where the parenthesis closes.
  const parenGrams = (k: number): { grams: Lexeme; end: number } | null => {
    let i = k;
    if (L[i]?.text === "(") i++;
    if (!L[i] || !isMass(L[i]) || hundred(L[i])) return null;
    const close = L[i + 1]?.text === ")" ? L[i + 1].end : L[i].end;
    return { grams: L[i], end: close };
  };

  for (let k = 0; k < L.length; k++) {
    const a = L[k];
    const w = key(a);
    const per = w === "per" || w === "pro" || (a.kind === "cjk" && a.text.endsWith("每"));
    const perStart = a.kind === "cjk" ? a.end - 1 : a.start;
    if (per) {
      const n = L[k + 1];
      if (hundred(n)) {
        push(n.unit === "ml" ? "per100ml" : "per100g", perStart, n.end);
        used.add(n);
        k++;
        continue;
      }
      if (n && isMass(n) && ["portion", "serving"].includes(key(L[k + 2]))) {
        push(regime === "us" ? "usServing" : "portion", perStart, L[k + 2].end, n);
        k += 2;
        continue;
      }
      if (["serving", "portion"].includes(key(n))) {
        const g = parenGrams(k + 2);
        push(regime === "us" ? "usServing" : "portion", perStart, g ? g.end : n.end, g?.grams);
        continue;
      }
      if (["container", "package", "pack"].includes(key(n))) {
        const g = parenGrams(k + 2);
        push("usContainer", perStart, g ? g.end : n.end, g?.grams);
        continue;
      }
    }
    if (regime !== "us" && ["portion", "serving"].includes(w) && L[k + 1]?.text === "(") {
      const g = parenGrams(k + 1);
      if (g) {
        push("portion", a.start, g.end, g.grams);
        continue;
      }
    }
    if (a.kind === "cjk" && a.text.includes("每份")) {
      const from = a.start + a.text.indexOf("每份");
      const g = parenGrams(k + 1);
      push("portion", from, g ? g.end : from + 2, g?.grams);
      continue;
    }
    // A bare "100 g" over a column (common on EU packs) is a heading too.
    if (regime !== "us" && hundred(a) && !used.has(a)) {
      push(a.unit === "ml" ? "per100ml" : "per100g", a.start, a.end);
    }
  }
  return out;
}

// ── columns ───────────────────────────────────────────────────────────────────

/** Units a field may be printed in. undefined = no unit printed, which is kept (and noted) rather than guessed. */
function unitFits(field: FieldKey, unit: Lexeme["unit"]): boolean {
  if (unit === undefined) return true;
  if (field === "kcal") return unit === "kcal";
  if (field === "kj") return unit === "kj";
  return unit === "g" || unit === "mg" || unit === "mcg";
}

function notesToWarnings(l: Lexeme, what: string, warn: (w: string) => void) {
  for (const n of l.notes ?? []) warn(`${what}: ${n}.`);
}

/** Decimal shift by exponent, done on the decimal text so 0.35 g → 350 mg exactly, not 349.99999999999994. */
function shift(value: number, exp: number): number {
  const t = String(value);
  return t.includes("e") ? value * 10 ** exp : Number(`${t}e${exp}`);
}

function amountValue(l: Lexeme, field: FieldKey, row: Row, warn: (w: string) => void): ReadValue {
  const v = toRead(l);
  notesToWarnings(l, NAME[field], warn);
  if (l.unit === undefined) {
    if (field !== "kcal") warn(`${NAME[field]}: "${l.raw}" has no unit printed beside it (row ${quote(row)}).`);
    return v;
  }
  if (ENERGY_FIELDS.has(field)) return v;
  const target = MG_FIELDS.has(field) ? "mg" : "g";
  const exp: Record<string, number> = { "g>mg": 3, "mcg>mg": -3, "mg>g": -3, "mcg>g": -6 };
  const e = exp[`${l.unit}>${target}`];
  if (e !== undefined) {
    v.value = shift(v.value, e);
    warn(`${NAME[field]} is printed in ${l.unit} ("${l.raw} ${l.unit}"); converted to ${v.value} ${target}.`);
  }
  return v;
}

function buildColumns(
  page: OcrPage,
  lines: Line[],
  regime: Regime,
  fieldRows: number[],
  servingGrams: number | undefined,
  warn: (w: string) => void,
): PanelColumn[] {
  const xOf = (row: Row, l: Lexeme) => {
    const [a, b] = xSpan(page, row, l.numStart ?? l.start, l.numEnd ?? l.end);
    return (a + b) / 2;
  };

  // Each field row's amounts, split into groups that fill columns independently.
  // A normal row is one group. An energy row is one group per unit, because
  // "1046 kJ / 250 kcal   523 kJ / 125 kcal" is two columns of each.
  interface Group {
    field: FieldKey;
    amounts: Array<{ l: Lexeme; x: number }>;
  }
  interface RowCells {
    r: number;
    field: RowField;
    groups: Group[];
    pcts: Array<{ l: Lexeme; x: number }>;
    all: Array<{ l: Lexeme; x: number; field: FieldKey }>;
  }
  const cells: RowCells[] = [];
  for (const r of fieldRows) {
    const line = lines[r];
    const xc = (l: Lexeme) => xOf(line.borrowedFrom?.get(l) ?? line.row, l);
    const field = line.field!;
    const lexemes = [...line.lx, ...(line.borrowed ?? [])];
    const nums = lexemes.filter((l) => l.kind === "amount");
    for (const n of nums.filter((n) => !Number.isFinite(n.value))) {
      warn(`Row ${quote(line.row)}: could not read "${n.raw}" as a number; not used.`);
    }
    const good = nums.filter(isNumber);
    const groups: Group[] = [];
    if (field === "energy") {
      const wordUnit = line.lx.map((l) => (l.kind === "word" ? labelKey(l.text) : "")).find((k) => k === "kj" || k === "kcal");
      const byField = new Map<FieldKey, Lexeme[]>();
      for (const n of good) {
        let f: FieldKey | null = n.unit === "kj" ? "kj" : n.unit === "kcal" ? "kcal" : null;
        if (!f && !n.unit) {
          if (wordUnit === "kj" || wordUnit === "kcal") f = wordUnit;
          else if (regime === "cn") {
            f = "kj";
            warn(`Energy "${n.raw}" has no unit printed; read as kJ, the unit GB 28050 requires.`);
          } else {
            warn(`Energy "${n.raw}" has no kJ or kcal beside it; not used.`);
          }
        } else if (!f) {
          warn(`Energy "${n.raw} ${n.unit}" is not in kJ or kcal; not used.`);
        }
        if (f) byField.set(f, [...(byField.get(f) ?? []), n]);
      }
      for (const [f, ls] of byField) groups.push({ field: f, amounts: ls.map((l) => ({ l, x: xc(l) })) });
    } else {
      const fits = good.filter((n) => unitFits(field, n.unit));
      for (const n of good.filter((n) => !unitFits(field, n.unit))) {
        warn(`${NAME[field]}: "${n.raw} ${n.unit}" is not a unit this row can be printed in; not used.`);
      }
      groups.push({ field, amounts: fits.map((l) => ({ l, x: xc(l) })) });
    }
    // Borrowed fragments arrive out of order; columns are ordinal, so sort by position.
    for (const g of groups) g.amounts.sort((a, b) => a.x - b.x);
    const pcts = lexemes
      .filter((l) => l.kind === "pct" && Number.isFinite(l.value))
      .map((l) => ({ l, x: xc(l) }))
      .sort((a, b) => a.x - b.x);
    const all = groups.flatMap((g) => g.amounts.map((a) => ({ ...a, field: g.field }))).sort((a, b) => a.x - b.x);
    if (!all.length) warn(`Found the ${field === "energy" ? "Energy" : NAME[field]} row ${quote(line.row)} but no amount on it.`);
    cells.push({ r, field, groups, pcts, all });
  }

  // How many amount columns: the most common count of amounts per row. Energy
  // groups vote too, so an energy-only fragment still has a column.
  const counts = new Map<number, number>();
  for (const c of cells) for (const g of c.groups) if (g.amounts.length) counts.set(g.amounts.length, (counts.get(g.amounts.length) ?? 0) + 1);
  let K = 0;
  let votes = 0;
  for (const [n, v] of counts) if (v > votes || (v === votes && n > K)) [K, votes] = [n, v];
  if (K === 0) K = 1;

  const centers: number[] = new Array(K).fill(0);
  let full = 0;
  for (const c of cells) {
    for (const g of c.groups) {
      if (g.amounts.length !== K) continue;
      full++;
      g.amounts.forEach((a, i) => (centers[i] += a.x));
    }
  }
  for (let i = 0; i < K; i++) centers[i] = full ? centers[i] / full : i;

  const columns: Array<Pick<PanelColumn, "fields" | "refPct">> = Array.from({ length: K }, () => ({ fields: {}, refPct: {} }));

  for (const c of cells) {
    const row = lines[c.r].row;
    const placed = new Map<Lexeme, number>();
    for (const g of c.groups) {
      const n = g.amounts.length;
      if (!n) continue;
      let cols: Array<number | null>;
      if (n === K) {
        cols = g.amounts.map((_, i) => i);
      } else if (K === 1) {
        // Single column, extra numbers on the row: the amount is the first one after the label.
        cols = g.amounts.map((_, i) => (i === 0 ? 0 : null));
        warn(`Row ${quote(row)}: ${n} amounts for one column; used "${g.amounts[0].l.raw}".`);
      } else {
        cols = new Array(n).fill(null);
        const pairs = g.amounts.flatMap((a, i) => centers.map((cx, col) => ({ i, col, d: Math.abs(a.x - cx) })));
        pairs.sort((p, q) => p.d - q.d);
        const takenCol = new Set<number>();
        for (const p of pairs) {
          if (cols[p.i] !== null || takenCol.has(p.col)) continue;
          cols[p.i] = p.col;
          takenCol.add(p.col);
        }
        warn(`Row ${quote(row)}: ${n} amount${n === 1 ? "" : "s"} where the panel has ${K} columns; placed by position.`);
      }
      g.amounts.forEach((a, i) => {
        const col = cols[i];
        if (col === null) {
          warn(`Row ${quote(row)}: "${a.l.raw}" fits no column; not used.`);
          return;
        }
        if (columns[col].fields[g.field]) {
          warn(`Row ${quote(row)}: two amounts for ${NAME[g.field]} in one column; kept the first.`);
          return;
        }
        columns[col].fields[g.field] = amountValue(a.l, g.field, row, warn);
        placed.set(a.l, col);
      });
    }

    // A percentage restates the amount printed just before it on the same row.
    for (const p of c.pcts) {
      const left = c.all.filter((a) => placed.has(a.l) && a.x < p.x).pop();
      let col: number | null = left ? placed.get(left.l)! : null;
      if (col === null) {
        if (K === 1) col = 0;
        else {
          const d = centers.map((cx) => Math.abs(p.x - cx));
          col = d.indexOf(Math.min(...d));
          warn(`Row ${quote(row)}: "${p.l.raw}%" has no amount before it; placed by position.`);
        }
      }
      const targets: FieldKey[] =
        c.field === "energy"
          ? c.all.filter((a) => placed.get(a.l) === col).map((a) => a.field)
          : [c.field];
      if (!targets.length) {
        warn(`Row ${quote(row)}: "${p.l.raw}%" has no energy amount in its column; not used.`);
        continue;
      }
      for (const f of new Set(targets)) {
        if (columns[col].refPct[f]) {
          warn(`Row ${quote(row)}: a second percentage "${p.l.raw}%" for ${NAME[f]}; kept the first.`);
          continue;
        }
        columns[col].refPct[f] = toRead(p.l);
        notesToWarnings(p.l, `${NAME[f]} %`, warn);
      }
    }
  }

  // What each column is per.
  const headers = lines.slice(0, fieldRows[0]).flatMap((l) => scanHeaders(page, l, regime));
  const kindOf: Array<Header | null> = new Array(K).fill(null);
  if (K === 1) {
    const pick =
      regime === "us"
        ? headers.find((h) => h.kind === "usServing") ?? null
        : headers.find((h) => h.kind === "per100g" || h.kind === "per100ml") ?? headers.find((h) => h.kind === "portion") ?? null;
    kindOf[0] = pick;
  } else {
    const kinds = [...new Set(headers.map((h) => h.kind))].map((kind) => {
      const hs = headers.filter((h) => h.kind === kind);
      return { ...hs[0], x: hs.reduce((a, h) => a + h.x, 0) / hs.length, grams: hs.find((h) => h.grams)?.grams };
    });
    const pairs = kinds.flatMap((h) => centers.map((cx, col) => ({ h, col, d: Math.abs(h.x - cx) })));
    pairs.sort((p, q) => p.d - q.d);
    const usedKind = new Set<string>();
    for (const p of pairs) {
      if (kindOf[p.col] || usedKind.has(p.h.kind)) continue;
      kindOf[p.col] = p.h;
      usedKind.add(p.h.kind);
    }
  }

  const fallback: Array<Header["kind"]> = regime === "us" ? ["usServing", "usContainer"] : ["per100g", "portion"];
  const out: Array<PanelColumn & { rank: number; col: number }> = columns.map((col, i) => {
    let h = kindOf[i];
    if (!h) {
      const kind = fallback[Math.min(i, fallback.length - 1)];
      if (regime !== "us" || K > 1) {
        warn(
          K === 1
            ? `No "per 100 g" or "per serving" heading was found; assumed ${kind === "per100g" ? "per 100 g" : "per serving"}.`
            : `Column ${i + 1} has no heading; assumed ${kind === "per100g" ? "per 100 g" : kind === "usContainer" ? "per container" : "per serving"} from its position.`,
        );
      }
      h = { kind, x: centers[i], text: "" };
    }
    const basis: Basis = h.kind === "per100g" ? "100g" : h.kind === "per100ml" ? "100ml" : "serving";
    const panelCol: PanelColumn & { rank: number; col: number } = { basis, fields: col.fields, refPct: col.refPct, rank: 0, col: i };
    const grams = h.grams?.value ?? (h.kind === "portion" || h.kind === "usServing" ? servingGrams : undefined);
    if (basis === "serving" && grams !== undefined) panelCol.servingGrams = grams;
    if (basis === "serving" && grams === undefined && regime !== "us") {
      warn(`The per-portion column states no portion weight; its amounts cannot be scaled until one is entered.`);
    }
    // Most useful first: the US per-serving column; per 100 g on EU and Chinese labels.
    panelCol.rank = regime === "us" ? (h.kind === "usContainer" ? 1 : 0) : basis === "serving" ? 1 : 0;
    return panelCol;
  });
  out.sort((a, b) => a.rank - b.rank || a.col - b.col);

  const seen = new Set(out.flatMap((c) => Object.keys(c.fields)));
  for (const c of out) {
    for (const f of seen) {
      if (!c.fields[f as FieldKey]) warn(`${NAME[f as FieldKey]} was read in one column but not in another.`);
    }
  }
  return out.map(({ basis, servingGrams: sg, fields, refPct }) => (sg === undefined ? { basis, fields, refPct } : { basis, servingGrams: sg, fields, refPct }));
}
