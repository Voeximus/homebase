// Tokens arrive in whatever order the OCR engine emits them. This stage puts them
// back into printed lines: find the page's skew, then group boxes that share a
// line, then order each line left → right and give it one string with a map from
// every character back to the token (and position in the token) it came from.

import type { OcrPage } from "../types";
import { foldChar } from "./text";

export interface Row {
  /** Page token indices, left → right. */
  tokens: number[];
  /** Token texts joined by one space, exactly as recognised. */
  raw: string;
  /** Same length as raw; each character compatibility-folded (full-width → ASCII). */
  norm: string;
  /** For every character: its page token index, or -1 for a joining space. */
  charTok: number[];
  /** For every character: its offset inside that token. */
  charOff: number[];
  /** Deskewed vertical centre, for ordering rows. */
  yc: number;
}

/**
 * The skew is found by projection: shear the token centres by each candidate
 * slope and keep the slope under which centres line up most tightly. Pairs are
 * weighted by their horizontal distance, because two tokens a word apart say
 * almost nothing about slope while a label and its %DV at opposite edges of the
 * panel say a lot. The search is limited to ±2°: beyond that, a label's left end
 * starts lining up with the PREVIOUS line's right end on a narrow panel (row pitch
 * over panel width is ~0.06), and the projection can prefer the wrong shear.
 * Measured on the 192 real panels: widening the search to ±3° raised recovery of
 * 3°-skewed pages from 98.9% to 99.9%, but dropped merge-heavy pages from 100% to
 * 99.6% and the combined worst case from 98.5% to 96.4% — merged tokens leave
 * fewer same-line pairs to outvote the wrong shear. A photo skewed more than 2°
 * should be straightened by capture, not guessed at here.
 */
const MAX_SLOPE = 0.035;

interface Box {
  i: number;
  xc: number;
  yc: number;
  w: number;
  h: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function slopeScore(boxes: Box[], s: number, sigma: number): number {
  const ys = boxes.map((b) => ({ y: b.yc - s * b.xc, x: b.xc })).sort((a, b) => a.y - b.y);
  const reach = 3 * sigma;
  const inv = 1 / (2 * sigma * sigma);
  let score = 0;
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      const dy = ys[j].y - ys[i].y;
      if (dy > reach) break;
      score += Math.abs(ys[j].x - ys[i].x) * Math.exp(-dy * dy * inv);
    }
  }
  return score;
}

export function estimateSlope(boxes: Box[]): number {
  if (boxes.length < 3) return 0;
  const sigma = Math.max(1.5, 0.2 * median(boxes.map((b) => b.h)));
  let best = 0;
  let bestScore = slopeScore(boxes, 0, sigma);
  for (let s = -MAX_SLOPE; s <= MAX_SLOPE + 1e-9; s += 0.002) {
    const sc = slopeScore(boxes, s, sigma);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  const coarse = best;
  for (let s = coarse - 0.002; s <= coarse + 0.002 + 1e-9; s += 0.0004) {
    const sc = slopeScore(boxes, s, sigma);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

export function buildRows(page: OcrPage): Row[] {
  const boxes: Box[] = [];
  page.tokens.forEach((t, i) => {
    if (!t.text || !t.text.trim()) return;
    boxes.push({ i, xc: t.x + t.w / 2, yc: t.y + t.h / 2, w: t.w, h: t.h });
  });
  if (!boxes.length) return [];
  const slope = estimateSlope(boxes);

  // A skewed line's axis-aligned box is taller than its text by w·|slope|. Undo
  // that before comparing heights, or long merged tokens look like two lines tall.
  const placed = boxes
    .map((b) => {
      const h = Math.max(b.h - b.w * Math.abs(slope), 0.5 * b.h);
      const yc = b.yc - slope * b.xc;
      return { ...b, h, top: yc - h / 2, bottom: yc + h / 2, y: yc };
    })
    .sort((a, b) => a.y - b.y);

  // Two boxes share a line when they overlap vertically by at least half the
  // smaller one. Overlap, not centre distance: the big "230" beside "Calories"
  // shares a baseline but not a centre, and a centre rule splits that line. A
  // centre-GAP rule was also tried and measured no better under jitter; what
  // this rule still splits (a %DV drifting off its row) is re-joined in parse.ts.
  interface Group {
    members: typeof placed;
    top: number;
    bottom: number;
  }
  const groups: Group[] = [];
  for (const p of placed) {
    let bestG: Group | undefined;
    let bestRatio = 0;
    for (let g = groups.length - 1; g >= 0 && g >= groups.length - 4; g--) {
      const G = groups[g];
      const overlap = Math.min(G.bottom, p.bottom) - Math.max(G.top, p.top);
      const ratio = overlap / Math.min(G.bottom - G.top, p.h);
      if (ratio >= 0.5 && ratio > bestRatio) {
        bestRatio = ratio;
        bestG = G;
      }
    }
    if (bestG) {
      bestG.members.push(p);
      const n = bestG.members.length;
      bestG.top = bestG.members.reduce((a, m) => a + m.top, 0) / n;
      bestG.bottom = bestG.members.reduce((a, m) => a + m.bottom, 0) / n;
    } else {
      groups.push({ members: [p], top: p.top, bottom: p.bottom });
    }
  }

  const rows = groups.map((G) => {
    const ms = [...G.members].sort((a, b) => a.xc - b.xc);
    let raw = "";
    const charTok: number[] = [];
    const charOff: number[] = [];
    ms.forEach((m, k) => {
      if (k > 0) {
        raw += " ";
        charTok.push(-1);
        charOff.push(-1);
      }
      const text = page.tokens[m.i].text;
      for (let c = 0; c < text.length; c++) {
        charTok.push(m.i);
        charOff.push(c);
      }
      raw += text;
    });
    let norm = "";
    for (const c of raw) {
      // for..of walks code points; a surrogate pair stays two units in raw, so keep it whole.
      norm += c.length === 1 ? foldChar(c) : c;
    }
    return {
      tokens: ms.map((m) => m.i),
      raw,
      norm,
      charTok,
      charOff,
      yc: ms.reduce((a, m) => a + m.y, 0) / ms.length,
    };
  });
  return rows.sort((a, b) => a.yc - b.yc);
}

/** Horizontal extent of characters [start, end) in page pixels, by proportional position inside their tokens. */
export function xSpan(page: OcrPage, row: Row, start: number, end: number): [number, number] {
  let s = start;
  while (s < end && row.charTok[s] < 0) s++;
  let e = end - 1;
  while (e > s && row.charTok[e] < 0) e--;
  const edge = (ci: number, right: boolean) => {
    const t = page.tokens[row.charTok[ci]];
    const n = Math.max(1, t.text.length);
    return t.x + (t.w * (row.charOff[ci] + (right ? 1 : 0))) / n;
  };
  if (s >= row.charTok.length || row.charTok[s] < 0) return [0, 0];
  return [edge(s, false), edge(e, true)];
}
