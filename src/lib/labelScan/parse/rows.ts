// Tokens arrive in whatever order the OCR engine emits them. This stage puts them
// back into printed lines: find how the page is turned (row slope and column
// lean), then group boxes that share a line, then order each line left → right and give it one string with a map from
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
  /** How far the page's columns lean: image x drifts by lean·y down a column. */
  lean: number;
}

// ── how the page is turned ────────────────────────────────────────────────────
//
// A phone held off level rotates the whole panel: rows slope AND columns lean,
// perpendicular to each other. Both have to be undone — rows, or a "%" token at
// the far right lands on the wrong line; columns, or a two-column panel's
// amounts drift across column centres down the page.
//
// Rows alone cannot be trusted to say how far the page is turned. The row slope
// is found by projection (below), and projection has an ALIAS: shear the page by
// one row pitch over the label-to-percentage distance (~0.07 on a US panel) and
// every label lines up with the percentage one row away just as well. That is
// exactly how the FDA sample label photographed at 3° failed: its %DV column
// slipped one row and every value still looked like a number. Widening the
// projection's search reached the right slope there but reached the alias on
// other pages (merge-heavy synthetic panels fell from 99.7% to 95.7%); a
// residual objective — "percentages sit close to their nearest row" — has the
// same alias by construction and measured worse still (49% on split tokens).
//
// Columns do not alias. Left-aligned labels share a left edge and right-aligned
// numbers share a right edge, many rows apart, so the lean of those edges is a
// long, well-conditioned baseline with no periodic structure to confuse it. The
// lean fixes where rows should be (perpendicular to it); projection then only
// refines within ±2° of that, which still absorbs a genuine shear (perspective on
// a curved pack) up to about 1.5° before the alias comes back into reach.
// Measured on the 192 real US panels, 5 seeds each: the 3°-rotated FDA photo
// fixed; ±4° and ±6° tilt on the standard damage mix 100% (a ±2° search: 77% and
// 54%); the untilted standard mix still 100%; the merge-heavy mix, whose extra
// ±2° SHEAR sits at the edge of that window, 99.7% (was 99.8%).

/** Half-width of the projection's search around the slope the columns imply. See the alias note above. */
const MAX_SHEAR = 0.035;

/**
 * Widest column lean considered, ±9°. Real photos run 2–6°; 0.12 and 0.16
 * measured identically on every mix, so the wider range is kept for headroom.
 */
const MAX_LEAN = 0.16;

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

/**
 * How well token centres line up into rows under slope s. Pairs are weighted by
 * horizontal distance: two tokens a word apart say almost nothing about slope,
 * while a label and its %DV at opposite edges of the panel say a lot.
 */
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

/**
 * The page's column lean c (image x = x0 + c·y down a column), by voting. Every
 * pair of boxes several rows apart proposes the lean that would put their left
 * edges (and, separately, their right edges) on one column; a pair's vote is
 * spread over the leans its edge noise allows. The winning lean is the one the
 * most edges agree on. Boxes on the same or neighbouring lines are skipped: a
 * short vertical baseline turns a pixel of box noise into degrees of lean.
 */
export function columnLean(boxes: Box[]): number {
  const e = Math.max(1.5, 0.15 * median(boxes.map((b) => b.h)));
  const STEP = 0.002;
  const N = Math.round((2 * MAX_LEAN) / STEP) + 1;
  const votes = new Float64Array(N);
  const edges: Array<(b: Box) => number> = [(b) => b.xc - b.w / 2, (b) => b.xc + b.w / 2];
  for (const edge of edges) {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const dy = boxes[j].yc - boxes[i].yc;
        const spread = e / Math.abs(dy);
        if (spread > 0.02) continue;
        const c = (edge(boxes[j]) - edge(boxes[i])) / dy;
        if (Math.abs(c) > MAX_LEAN + 2 * spread) continue;
        const k0 = Math.max(0, Math.ceil((c - 2 * spread + MAX_LEAN) / STEP));
        const k1 = Math.min(N - 1, Math.floor((c + 2 * spread + MAX_LEAN) / STEP));
        const inv = 1 / (2 * spread * spread);
        for (let k = k0; k <= k1; k++) {
          const d = -MAX_LEAN + k * STEP - c;
          votes[k] += Math.exp(-d * d * inv);
        }
      }
    }
  }
  let peak = Math.round(MAX_LEAN / STEP);
  for (let k = 0; k < N; k++) if (votes[k] > votes[peak]) peak = k;
  // Fewer than three agreeing edge pairs is not a column; assume the page is level.
  return votes[peak] < 3 ? 0 : -MAX_LEAN + peak * STEP;
}

export function estimateSlope(boxes: Box[]): { slope: number; lean: number } {
  if (boxes.length < 3) return { slope: 0, lean: 0 };
  const sigma = Math.max(1.5, 0.2 * median(boxes.map((b) => b.h)));
  const lean = columnLean(boxes);
  // Rotation turns columns by -slope, so rows perpendicular to the lean have slope -lean.
  const lo = -lean - MAX_SHEAR;
  const hi = -lean + MAX_SHEAR;
  let best = Math.min(Math.max(0, lo), hi);
  let bestScore = slopeScore(boxes, best, sigma);
  for (let s = lo; s <= hi + 1e-9; s += 0.002) {
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
  return { slope: best, lean };
}

export function buildRows(page: OcrPage): Row[] {
  const boxes: Box[] = [];
  page.tokens.forEach((t, i) => {
    if (!t.text || !t.text.trim()) return;
    boxes.push({ i, xc: t.x + t.w / 2, yc: t.y + t.h / 2, w: t.w, h: t.h });
  });
  if (!boxes.length) return [];
  const { slope, lean } = estimateSlope(boxes);

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
  type Placed = (typeof placed)[number];
  interface Group {
    members: Placed[];
    top: number;
    bottom: number;
  }
  const ratioTo = (top: number, bottom: number, p: Placed) =>
    (Math.min(bottom, p.bottom) - Math.max(top, p.top)) / Math.min(bottom - top, p.h);
  const refit = (G: Group) => {
    const n = G.members.length;
    G.top = G.members.reduce((a, m) => a + m.top, 0) / n;
    G.bottom = G.members.reduce((a, m) => a + m.bottom, 0) / n;
  };
  let groups: Group[] = [];
  for (const p of placed) {
    let bestG: Group | undefined;
    let bestRatio = 0;
    for (let g = groups.length - 1; g >= 0 && g >= groups.length - 4; g--) {
      const ratio = ratioTo(groups[g].top, groups[g].bottom, p);
      if (ratio >= 0.5 && ratio > bestRatio) {
        bestRatio = ratio;
        bestG = groups[g];
      }
    }
    if (bestG) {
      bestG.members.push(p);
      refit(bestG);
    } else {
      groups.push({ members: [p], top: p.top, bottom: p.bottom });
    }
  }

  // The pass above is greedy top to bottom, so a tall box is placed before the
  // line below it exists: on the 3°-rotated FDA photo the big "230" reached
  // "Amount per serving" first (overlap just over half) and never met
  // "Calories", which it overlaps completely. So judge each box once more against
  // every nearby line as it finally stands — its own line measured WITHOUT it —
  // and move it only when another line clearly wants it more.
  for (let g = 0; g < groups.length; g++) {
    for (const p of [...groups[g].members]) {
      const own = groups[g];
      if (own.members.length < 2) continue;
      const rest = own.members.filter((m) => m !== p);
      const ownTop = rest.reduce((a, m) => a + m.top, 0) / rest.length;
      const ownBottom = rest.reduce((a, m) => a + m.bottom, 0) / rest.length;
      const ownRatio = ratioTo(ownTop, ownBottom, p);
      let best: Group | undefined;
      let bestRatio = Math.max(0.5, ownRatio + 0.25);
      for (let k = Math.max(0, g - 3); k <= Math.min(groups.length - 1, g + 3); k++) {
        if (k === g) continue;
        const ratio = ratioTo(groups[k].top, groups[k].bottom, p);
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = groups[k];
        }
      }
      if (best) {
        own.members = rest;
        refit(own);
        best.members.push(p);
        refit(best);
      }
    }
  }
  groups = groups.filter((G) => G.members.length);

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
      lean,
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
    // Measured along the panel's own columns, not the image's: undo the lean.
    return t.x - row.lean * (t.y + t.h / 2) + (t.w * (row.charOff[ci] + (right ? 1 : 0))) / n;
  };
  if (s >= row.charTok.length || row.charTok[s] < 0) return [0, 0];
  return [edge(s, false), edge(e, true)];
}
