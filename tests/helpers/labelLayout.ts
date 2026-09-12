// Renders a nutrition panel as the tokens an OCR engine would hand back, then
// damages them the ways real engines do: words split or merged unpredictably,
// boxes jittered, the photo sheared or rotated, token order shuffled, and
// unrelated text (brand, ingredients, barcode) on the same page.
//
// Every perturbation is driven by a seeded generator, so a failing seed is a
// reproducible layout rather than a flaky test.

import type { OcrPage, OcrToken } from "../../src/lib/labelScan/types";

export interface Cell {
  text: string;
  /** Left edge for "left", right edge for "right". */
  x: number;
  align?: "left" | "right";
  /** Font height in px; defaults to the line's size. */
  size?: number;
}

export interface Line {
  cells: Cell[];
  size?: number;
}

export interface PanelSpec {
  lines: Line[];
  /** Page position of the panel's top-left. */
  left?: number;
  top?: number;
}

export interface Perturb {
  seed: number;
  /** Probability a multi-word cell is emitted word by word (else as one token). */
  split?: number;
  /** Probability two neighbouring tokens on a line are merged into one. */
  merge?: number;
  /** Of those merges, the share that lose the space between them ("TotalFat"). */
  tight?: number;
  /** Probability an amount like "9g" is emitted as "9" and "g". */
  unitSplit?: number;
  /** Max vertical jitter per token, px. */
  jitter?: number;
  /**
   * Max shear, degrees (drawn from ±this): rows slope but columns stay vertical.
   * Not what a tilted phone does — that is `tilt` — but close to what perspective
   * does to part of a curved pack, so both are kept.
   */
  skew?: number;
  /**
   * Max rotation, degrees (drawn from ±this): the whole panel turns, so rows slope
   * AND columns lean, and every box grows to hold its rotated text — exactly what
   * the recogniser returns for a phone held off level. Real photos run 2–6°.
   */
  tilt?: number;
  shuffle?: boolean;
  noise?: boolean;
}

/** mulberry32: small, fast, and identical on every platform. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isWide = (c: string) => /[㐀-鿿＀-￯]/.test(c);
const charW = (c: string, size: number) => (isWide(c) ? size : c === " " ? 0.3 * size : 0.55 * size);
const textW = (t: string, size: number) => [...t].reduce((a, c) => a + charW(c, size), 0);

interface Box {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
}

const NOISE_ABOVE: Line[] = [
  { size: 22, cells: [{ text: "HONEY NUT CRUNCH", x: 0 }] },
  { size: 12, cells: [{ text: "NET WT 12 OZ (340g)", x: 0 }] },
];
const NOISE_BELOW: Line[] = [
  { size: 10, cells: [{ text: "INGREDIENTS: WHOLE GRAIN OATS, SUGAR, CORN STARCH, HONEY, BROWN", x: 0 }] },
  { size: 10, cells: [{ text: "SUGAR SYRUP, SALT, TRIPOTASSIUM PHOSPHATE, CONTAINS 2% OR LESS", x: 0 }] },
  { size: 10, cells: [{ text: "OF CANOLA OIL, NATURAL FLAVOR. VITAMIN E (MIXED TOCOPHEROLS).", x: 0 }] },
  { size: 14, cells: [{ text: "0 16000 27546 1", x: 60 }] },
];

function layLines(lines: Line[], left: number, top: number, lineIndex0: number): { boxes: Box[]; bottom: number } {
  const boxes: Box[] = [];
  let y = top;
  lines.forEach((line, li) => {
    const H = Math.max(line.size ?? 13, ...line.cells.map((c) => c.size ?? line.size ?? 13));
    for (const cell of line.cells) {
      const size = cell.size ?? line.size ?? 13;
      const w = textW(cell.text, size);
      const x0 = left + (cell.align === "right" ? cell.x - w : cell.x);
      // Cells share a baseline: a big "230" and a small "Calories" align at the bottom.
      boxes.push({ text: cell.text, x: x0, y: y + (H - size), w, h: size, line: lineIndex0 + li });
    }
    y += H * 1.55;
  });
  return { boxes, bottom: y };
}

function splitWords(b: Box, size: number): Box[] {
  const out: Box[] = [];
  let x = b.x;
  for (const [k, word] of b.text.split(" ").entries()) {
    if (k > 0) x += charW(" ", size);
    const w = textW(word, size);
    if (word) out.push({ ...b, text: word, x, w });
    x += w;
  }
  return out;
}

export function renderPanel(spec: PanelSpec, p: Perturb = { seed: 1 }): OcrPage {
  const r = rng(p.seed);
  const left = spec.left ?? 40;
  const top = spec.top ?? 120;
  const cells: Box[] = [];

  const panel = layLines(spec.lines, left, top, 0);
  cells.push(...panel.boxes);
  if (p.noise) {
    cells.push(...layLines(NOISE_ABOVE, left, top - 80, 1000).boxes);
    cells.push(...layLines(NOISE_BELOW, left, panel.bottom + 40, 2000).boxes);
  }

  // Tokenise: a cell is one token, or one token per word.
  let tokens: Box[] = [];
  for (const c of cells) {
    const size = c.h;
    const parts = c.text.includes(" ") && r() < (p.split ?? 0) ? splitWords(c, size) : [c];
    for (const part of parts) {
      const m = /^(<?\d[\d.,]*)(g|mg|kcal|kJ|%)$/.exec(part.text);
      if (m && r() < (p.unitSplit ?? 0)) {
        const w1 = textW(m[1], size);
        tokens.push({ ...part, text: m[1], w: w1 });
        tokens.push({ ...part, text: m[2], x: part.x + w1 + 0.15 * size, w: textW(m[2], size) });
      } else {
        tokens.push(part);
      }
    }
  }

  // Merge neighbours on a line, the way a text detector joins boxes that sit close.
  const byLine = new Map<number, Box[]>();
  for (const t of tokens) byLine.set(t.line, [...(byLine.get(t.line) ?? []), t]);
  tokens = [];
  for (const ts of byLine.values()) {
    ts.sort((a, b) => a.x - b.x);
    const merged: Box[] = [];
    for (const t of ts) {
      const prev = merged[merged.length - 1];
      const gap = prev ? t.x - (prev.x + prev.w) : Infinity;
      if (prev && gap < 2.5 * 0.55 * t.h && r() < (p.merge ?? 0)) {
        const tight = r() < (p.tight ?? 0);
        const x = Math.min(prev.x, t.x);
        const right = Math.max(prev.x + prev.w, t.x + t.w);
        const y = Math.min(prev.y, t.y);
        const bottom = Math.max(prev.y + prev.h, t.y + t.h);
        merged[merged.length - 1] = { text: prev.text + (tight ? "" : " ") + t.text, x, y, w: right - x, h: bottom - y, line: t.line };
      } else {
        merged.push({ ...t });
      }
    }
    tokens.push(...merged);
  }

  // Skew about the panel's left edge, then jitter.
  const tan = Math.tan((((r() * 2 - 1) * (p.skew ?? 0)) * Math.PI) / 180);
  const out: OcrToken[] = tokens.map((t) => {
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2 + (cx - left) * tan + (r() * 2 - 1) * (p.jitter ?? 0);
    const h = t.h + t.w * Math.abs(tan);
    return { text: t.text, x: t.x + (r() * 2 - 1) * 0.5 * (p.jitter ?? 0), y: cy - h / 2, w: t.w, h };
  });

  if (p.tilt) {
    // Rotate every box about the panel's centre and return the axis-aligned box
    // around the rotated text, as a detector does. The angle is drawn only when
    // tilt is set, so untilted seeds keep producing the exact same pages.
    const a = (((r() * 2 - 1) * p.tilt) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ox = left + 170;
    const oy = (top + panel.bottom) / 2;
    for (const t of out) {
      const cx = t.x + t.w / 2 - ox;
      const cy = t.y + t.h / 2 - oy;
      const nx = ox + cx * cos - cy * sin;
      const ny = oy + cx * sin + cy * cos;
      const w = t.w * Math.abs(cos) + t.h * Math.abs(sin);
      const h = t.w * Math.abs(sin) + t.h * Math.abs(cos);
      Object.assign(t, { x: nx - w / 2, y: ny - h / 2, w, h });
    }
    // Keep the page in positive coordinates, as an image would be.
    const dx = Math.max(0, 20 - Math.min(...out.map((t) => t.x)));
    const dy = Math.max(0, 20 - Math.min(...out.map((t) => t.y)));
    for (const t of out) {
      t.x += dx;
      t.y += dy;
    }
  }

  if (p.shuffle) {
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  }
  const maxX = Math.max(...out.map((t) => t.x + t.w));
  const maxY = Math.max(...out.map((t) => t.y + t.h));
  return { width: Math.ceil(maxX + 40), height: Math.ceil(maxY + 40), tokens: out, engine: "test-layout" };
}

/** The standard mix every round-trip seed runs under. */
export const HARSH = (seed: number): Perturb => ({
  seed,
  split: 0.6,
  merge: 0.35,
  tight: 0.3,
  unitSplit: 0.1,
  jitter: 2,
  skew: 1.5,
  shuffle: true,
  noise: true,
});

// ── US panels ─────────────────────────────────────────────────────────────────

export type UsField = "kcal" | "fat" | "sat" | "trans" | "chol" | "sodium" | "carb" | "fiber" | "sugar" | "added" | "prot";

/** 21 CFR 101.9(c)(9) Daily Reference Values, adults and children 4+. */
export const DRV: Partial<Record<UsField, number>> = { fat: 78, sat: 20, chol: 300, sodium: 2300, carb: 275, fiber: 28, added: 50 };

/** %DV from the declared amount, rounded half up — in integers, so 0.5/20 cannot land on 2.4999. */
export function percentDV(field: UsField, declared: number): number | undefined {
  const drv = DRV[field];
  if (drv === undefined) return undefined;
  const n = Math.round(declared * 10) * 100;
  const d = drv * 10;
  return Math.floor((2 * n + d) / (2 * d));
}

/** 1200 → "1,200"; 2.5 → "2.5". */
export function fmt(v: number): string {
  if (!Number.isInteger(v)) return String(v);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface UsPanelInput {
  servingGrams: number;
  declared: Partial<Record<UsField, number>>;
  servings?: number;
  household?: string;
  /** Replace the printed amount text of a field, e.g. { fat: "99" } or { sat: "less than 1g" }. */
  amountText?: Partial<Record<UsField, string>>;
}

const US_ROWS: Array<{ f: UsField; label: string; unit: string; indent: number }> = [
  { f: "fat", label: "Total Fat", unit: "g", indent: 0 },
  { f: "sat", label: "Saturated Fat", unit: "g", indent: 14 },
  { f: "trans", label: "Trans Fat", unit: "g", indent: 14 },
  { f: "chol", label: "Cholesterol", unit: "mg", indent: 0 },
  { f: "sodium", label: "Sodium", unit: "mg", indent: 0 },
  { f: "carb", label: "Total Carbohydrate", unit: "g", indent: 0 },
  { f: "fiber", label: "Dietary Fiber", unit: "g", indent: 14 },
  { f: "sugar", label: "Total Sugars", unit: "g", indent: 14 },
  { f: "added", label: "Added Sugars", unit: "g", indent: 28 },
  { f: "prot", label: "Protein", unit: "g", indent: 0 },
];

/** A single-column 2016-format US panel: the layout of the research report's figure. */
export function usPanelSpec(p: UsPanelInput): PanelSpec {
  const R = 340;
  const lines: Line[] = [
    { size: 26, cells: [{ text: "Nutrition Facts", x: 0 }] },
    { size: 12, cells: [{ text: `${p.servings ?? 8} servings per container`, x: 0 }] },
    {
      size: 14,
      cells: [
        { text: "Serving size", x: 0 },
        { text: `${p.household ?? "1 cup"} (${fmt(p.servingGrams)}g)`, x: R, align: "right" },
      ],
    },
    { size: 10, cells: [{ text: "Amount per serving", x: 0 }] },
  ];
  if (p.declared.kcal !== undefined) {
    lines.push({
      cells: [
        { text: "Calories", x: 0, size: 22 },
        { text: p.amountText?.kcal ?? fmt(p.declared.kcal), x: R, align: "right", size: 30 },
      ],
    });
  }
  lines.push({ size: 11, cells: [{ text: "% Daily Value*", x: R, align: "right" }] });
  for (const row of US_ROWS) {
    const v = p.declared[row.f];
    if (v === undefined) continue;
    const amount = p.amountText?.[row.f] ?? `${fmt(v)}${row.unit}`;
    const text = row.f === "added" ? `Includes ${amount} Added Sugars` : `${row.label} ${amount}`;
    const cells: Cell[] = [{ text, x: row.indent }];
    const pct = percentDV(row.f, v);
    if (pct !== undefined) cells.push({ text: `${pct}%`, x: R, align: "right" });
    lines.push({ size: 13, cells });
  }
  lines.push(
    { size: 13, cells: [{ text: "Vitamin D 0mcg", x: 0 }, { text: "0%", x: R, align: "right" }] },
    { size: 13, cells: [{ text: "Calcium 20mg", x: 0 }, { text: "2%", x: R, align: "right" }] },
    { size: 13, cells: [{ text: "Iron 1mg", x: 0 }, { text: "6%", x: R, align: "right" }] },
    { size: 9, cells: [{ text: "* The % Daily Value (DV) tells you how much a nutrient in", x: 0 }] },
    { size: 9, cells: [{ text: "a serving of food contributes to a daily diet. 2,000", x: 0 }] },
    { size: 9, cells: [{ text: "calories a day is used for general nutrition advice.", x: 0 }] },
  );
  return { lines };
}

/**
 * A plain table: optional title lines, then rows whose first cell is the label
 * (left-aligned, with an optional indent) and whose other cells are right-aligned
 * at the given column edges. `null` leaves a cell empty.
 */
export function tableSpec(opts: {
  title?: string[];
  header?: Array<string | null>;
  rows: Array<Array<string | null>>;
  columns: number[];
  indent?: Record<number, number>;
  size?: number;
}): PanelSpec {
  const size = opts.size ?? 13;
  const lines: Line[] = (opts.title ?? []).map((t) => ({ size: size + 6, cells: [{ text: t, x: 0 }] }));
  const row = (cells: Array<string | null>, indent = 0): Line => ({
    size,
    cells: cells.flatMap((text, i): Cell[] =>
      text === null ? [] : i === 0 ? [{ text, x: indent }] : [{ text, x: opts.columns[i - 1], align: "right" }],
    ),
  });
  if (opts.header) lines.push(row(opts.header));
  opts.rows.forEach((cells, i) => lines.push(row(cells, opts.indent?.[i] ?? 0)));
  return { lines };
}
