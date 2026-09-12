// ── The reader's arithmetic: pixels in, text + boxes out ─────────────────────
//
// Everything between "decoded pixels" and "tokens" lives here, as plain
// TypeScript with no DOM, no canvas and no ONNX import. That is deliberate and
// it is what rule 5 (determinism) actually rests on:
//
//   * Canvas resampling is implementation-defined. Chrome and Safari scale an
//     image differently, and a GPU-backed canvas can differ between drivers. So
//     every resize below is our own separable filter over integer pixels.
//   * The model runs on onnxruntime-web's WASM backend with fixed-width SIMD and
//     one thread. WASM floats are IEEE-exact on every CPU, so the same input
//     tensor gives the same output bits on a Pixel and on an iPhone.
//   * Box finding, cropping and CTC decoding are ordinary loops with a fixed
//     visiting order, so ties always break the same way.
//
// The one step that is NOT ours is decoding the JPEG/PNG itself (libjpeg-turbo in
// Chrome, ImageIO in Safari), which can differ by a level or two. Same photo on
// the same phone is bit-identical; the same file on two different browsers can
// differ only by what their decoders produced.
//
// The constants and the order of operations follow the reference PaddleOCR
// pipeline for PP-OCRv6 (the thresholds are the ones shipped in each model's
// inference.yml), so the numbers here can be held against the Python
// implementation rather than against memory.
//
// Because none of this touches a browser API, the same code runs in the Web
// Worker, on the main thread as a fallback, and in Node for tests.

/** Tight-packed 8-bit RGB. The working image format for every stage. */
export interface Rgb {
  data: Uint8Array;
  width: number;
  height: number;
}

/** A text region as four corners, clockwise from top-left, in working-image pixels. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** What the reader needs from an inference engine. Kept this narrow so the pipeline never imports onnxruntime. */
export type Infer = (
  model: "det" | "rec",
  input: Float32Array,
  dims: readonly number[],
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

export interface RawToken {
  text: string;
  quad: Quad;
  /** Mean of the per-character CTC probabilities. */
  conf: number;
}

// ── tuning, each with its reason ─────────────────────────────────────────────

/**
 * Longest side of the working image. Measured, not guessed: the FDA sample label
 * pasted into a 3024×4032 "phone photo" (2° tilt, 2 px blur, sensor noise, JPEG
 * q90) with the panel filling 90%, 50%, 35% and 25% of the frame height, read at
 * caps of 1280 / 1600 / 2000 / 2560 / 3200, scoring the 29 lines that carry a
 * number:
 *
 *   panel fills 35–90% of the frame   26–27/29 at every cap from 1280 to 2560 —
 *                                      the cap barely matters when it's framed
 *                                      (the two constant misses are "0g" read
 *                                      as "Og" at every size: a verifier job)
 *   panel fills 25% of the frame      14 · 12 · 16 · 22 · 17 of 29
 *   detection time (desktop, 1 thread) 0.5 · 1.0 · 1.5 · 2.2 · 3.1 s
 *
 * So resolution only buys anything when the panel is small in the frame, and
 * past ~2500 px it goes backwards: the big "Nutrition Facts" type outgrows the
 * detector and the header splits into two tokens. 2000 is the point that still
 * gains on a small panel without the 2560 cap's ~50% more detection time on a
 * phone and its extra garbage tokens. The framing guide in LabelScanner is the
 * real answer to a small panel. A 1080p camera frame is already under the cap;
 * 4K frames and 12 MP library photos get scaled down to it.
 */
export const MAX_SIDE = 2000;

/** Detection thresholds from PP-OCRv6_tiny_det/inference.yml (DBPostProcess). */
export const DET_THRESH = 0.2;
export const DET_BOX_THRESH = 0.4;
export const DET_UNCLIP_RATIO = 1.4;
const DET_MIN_SIZE = 3;
const DET_MAX_CANDIDATES = 3000;
/** ImageNet statistics, applied to a BGR image in this order — exactly as PaddleOCR's NormalizeImage does. */
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

/** Recognition input: PP-OCRv6_tiny_rec/inference.yml RecResizeImg [3, 48, 320]. */
export const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
/** The largest width the exported model declares in its dynamic shapes. */
const REC_MAX_WIDTH = 3200;

// ── resampling ───────────────────────────────────────────────────────────────

interface AxisTaps {
  start: Int32Array; // start[i]..start[i+1] index into idx/wt for destination i
  idx: Int32Array;
  wt: Float64Array;
}

/**
 * Filter taps for one axis. Shrinking uses exact area coverage (a box filter
 * with fractional edges) because bilinear sampling on a 2-6x shrink skips
 * pixels and aliases thin strokes — the "1" in "10g" is two pixels wide.
 * Enlarging uses bilinear with half-pixel centres, the OpenCV convention.
 */
function axisTaps(src: number, dst: number): AxisTaps {
  const start = new Int32Array(dst + 1);
  const idx: number[] = [];
  const wt: number[] = [];
  if (dst < src) {
    const scale = src / dst;
    for (let i = 0; i < dst; i++) {
      start[i] = idx.length;
      const a = i * scale;
      const b = (i + 1) * scale;
      const lo = Math.floor(a);
      const hi = Math.min(src, Math.ceil(b));
      for (let s = lo; s < hi; s++) {
        const cover = Math.min(b, s + 1) - Math.max(a, s);
        if (cover > 0) {
          idx.push(s);
          wt.push(cover / scale);
        }
      }
    }
  } else {
    const scale = src / dst;
    for (let i = 0; i < dst; i++) {
      start[i] = idx.length;
      let x = (i + 0.5) * scale - 0.5;
      if (x < 0) x = 0;
      if (x > src - 1) x = src - 1;
      const x0 = Math.floor(x);
      const f = x - x0;
      idx.push(x0);
      wt.push(1 - f);
      if (f > 0 && x0 + 1 < src) {
        idx.push(x0 + 1);
        wt.push(f);
      }
    }
  }
  start[dst] = idx.length;
  return { start, idx: Int32Array.from(idx), wt: Float64Array.from(wt) };
}

/**
 * Resize interleaved 8-bit pixels (`channels` per pixel) to exactly dw × dh.
 * Two separable passes; the intermediate is 8.8 fixed point in a Uint16Array,
 * which halves the memory of a float buffer — a 12 MP photo's intermediate is
 * 36 MB instead of 72, and that difference matters inside an iPhone tab.
 */
export function resample(
  src: Uint8Array | Uint8ClampedArray,
  sw: number,
  sh: number,
  channels: number,
  dw: number,
  dh: number,
  outChannels = channels,
): Uint8Array {
  const out = new Uint8Array(dw * dh * outChannels);
  const tx = axisTaps(sw, dw);
  const ty = axisTaps(sh, dh);
  const mid = new Uint16Array(dw * sh * outChannels);
  for (let y = 0; y < sh; y++) {
    const srow = y * sw;
    const mrow = y * dw;
    for (let x = 0; x < dw; x++) {
      const m = (mrow + x) * outChannels;
      for (let c = 0; c < outChannels; c++) {
        let acc = 0;
        for (let k = tx.start[x]; k < tx.start[x + 1]; k++) {
          acc += src[(srow + tx.idx[k]) * channels + c] * tx.wt[k];
        }
        mid[m + c] = Math.min(65535, Math.round(acc * 256));
      }
    }
  }
  for (let y = 0; y < dh; y++) {
    const orow = y * dw;
    for (let x = 0; x < dw; x++) {
      const o = (orow + x) * outChannels;
      for (let c = 0; c < outChannels; c++) {
        let acc = 0;
        for (let k = ty.start[y]; k < ty.start[y + 1]; k++) {
          acc += mid[(ty.idx[k] * dw + x) * outChannels + c] * ty.wt[k];
        }
        const v = Math.round(acc / 256);
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/** The size an image is scaled to so its long side is at most `maxSide`. Never enlarges. */
export function fitWithin(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxSide) return { width, height };
  const s = maxSide / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** RGBA (as a canvas or decoder hands it over) → the working RGB image, scaled to fit MAX_SIDE. Alpha is dropped, not composited: labels are photos, not transparent PNGs. */
export function toWorkingImage(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxSide = MAX_SIDE,
): Rgb {
  const fit = fitWithin(width, height, maxSide);
  if (fit.width === width && fit.height === height) {
    const data = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      data[i] = rgba[j];
      data[i + 1] = rgba[j + 1];
      data[i + 2] = rgba[j + 2];
    }
    return { data, width, height };
  }
  return { data: resample(rgba, width, height, 4, fit.width, fit.height, 3), width: fit.width, height: fit.height };
}

// ── detection ────────────────────────────────────────────────────────────────

/**
 * The detector's input size. Both sides are snapped to a multiple of 32 (the
 * network downsamples five times) and the image is STRETCHED to it, not padded —
 * PaddleOCR's DetResizeForTest does the same, and postprocessing undoes the
 * stretch per axis.
 */
export function detInputSize(width: number, height: number): { width: number; height: number } {
  // The reference limit is "min side at least 64" with a 4000 px ceiling; our
  // working image is already capped at MAX_SIDE, so only tiny images scale up.
  let ratio = 1;
  const min = Math.min(width, height);
  if (min < 64) ratio = 64 / min;
  const snap = (v: number) => Math.max(32, Math.round((v * ratio) / 32) * 32);
  return { width: snap(width), height: snap(height) };
}

export function detTensor(img: Rgb): { data: Float32Array; width: number; height: number } {
  const size = detInputSize(img.width, img.height);
  const px =
    size.width === img.width && size.height === img.height
      ? img.data
      : resample(img.data, img.width, img.height, 3, size.width, size.height);
  const plane = size.width * size.height;
  const data = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const r = px[p * 3];
    const g = px[p * 3 + 1];
    const b = px[p * 3 + 2];
    // BGR channel order, ImageNet stats in listed order — see DET_MEAN.
    data[p] = (b / 255 - DET_MEAN[0]) / DET_STD[0];
    data[plane + p] = (g / 255 - DET_MEAN[1]) / DET_STD[1];
    data[2 * plane + p] = (r / 255 - DET_MEAN[2]) / DET_STD[2];
  }
  return { data, width: size.width, height: size.height };
}

type Pt = [number, number];

/** Andrew's monotone chain. Input points are integers, so the cross products are exact. */
export function convexHull(points: Pt[]): Pt[] {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** A rotated rectangle: centre, unit "across" axis u (the more horizontal one), and side lengths along u and its normal. */
export interface RotRect {
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  w: number;
  h: number;
}

/**
 * Minimum-area enclosing rectangle by rotating calipers over the hull — the same
 * quantity as OpenCV's minAreaRect. The first minimum wins ties, and the axis is
 * then normalised so "w" always runs along the more horizontal side; that keeps
 * a horizontal line of text reading left-to-right instead of arriving rotated.
 */
export function minAreaRect(points: Pt[]): RotRect {
  const hull = convexHull(points);
  if (hull.length === 0) return { cx: 0, cy: 0, ux: 1, uy: 0, w: 0, h: 0 };
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], ux: 1, uy: 0, w: 0, h: 0 };
  let best: { area: number; ux: number; uy: number; a0: number; a1: number; b0: number; b1: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0) continue;
    const ux = (q[0] - p[0]) / len;
    const uy = (q[1] - p[1]) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of hull) {
      const a = r[0] * ux + r[1] * uy;
      const b = -r[0] * uy + r[1] * ux;
      if (a < a0) a0 = a;
      if (a > a1) a1 = a;
      if (b < b0) b0 = b;
      if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area - 1e-9) best = { area, ux, uy, a0, a1, b0, b1 };
  }
  if (!best) return { cx: hull[0][0], cy: hull[0][1], ux: 1, uy: 0, w: 0, h: 0 };
  const ca = (best.a0 + best.a1) / 2;
  const cb = (best.b0 + best.b1) / 2;
  const cx = ca * best.ux - cb * best.uy;
  const cy = ca * best.uy + cb * best.ux;
  let ux = best.ux, uy = best.uy, w = best.a1 - best.a0, h = best.b1 - best.b0;
  // Swap to the more horizontal axis, then point it rightwards.
  if (Math.abs(uy) > Math.abs(ux)) {
    [ux, uy] = [-uy, ux];
    [w, h] = [h, w];
  }
  if (ux < 0 || (ux === 0 && uy < 0)) {
    ux = -ux;
    uy = -uy;
  }
  return { cx, cy, ux, uy, w, h };
}

/** Corners of a rotated rect, clockwise from top-left (image y points down). */
export function rectCorners(r: RotRect): Quad {
  const hx = (r.ux * r.w) / 2, hy = (r.uy * r.w) / 2; // half across
  const vx = (-r.uy * r.h) / 2, vy = (r.ux * r.h) / 2; // half down
  return [
    [r.cx - hx - vx, r.cy - hy - vy],
    [r.cx + hx - vx, r.cy + hy - vy],
    [r.cx + hx + vx, r.cy + hy + vy],
    [r.cx - hx + vx, r.cy - hy + vy],
  ];
}

/**
 * DB post-processing: probability map → text quads in working-image pixels.
 * Mirrors PaddleOCR's DBPostProcess.boxes_from_bitmap:
 *   threshold → regions → min-area rect → mean probability ≥ box_thresh →
 *   unclip (grow by area·ratio/perimeter) → drop slivers → rescale.
 * Unclipping a rectangle with a round-join offset and taking the min-area rect
 * again is exactly "each side grows by d", so no polygon clipper is needed.
 */
export function dbPostprocess(
  prob: Float32Array,
  bw: number,
  bh: number,
  destW: number,
  destH: number,
): Array<{ quad: Quad; score: number }> {
  const n = bw * bh;
  const label = new Int32Array(n); // 0 = unvisited/background
  const stack = new Int32Array(n);
  const out: Array<{ quad: Quad; score: number }> = [];
  let comp = 0;
  for (let start = 0; start < n && comp < DET_MAX_CANDIDATES; start++) {
    if (label[start] !== 0 || !(prob[start] > DET_THRESH)) continue;
    comp++;
    // Flood fill (8-connected, as a contour tracer would see it), tracking each
    // row's leftmost and rightmost pixel — those are the only hull candidates.
    const rowMin = new Map<number, number>();
    const rowMax = new Map<number, number>();
    let sp = 0;
    stack[sp++] = start;
    label[start] = comp;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % bw;
      const y = (p - x) / bw;
      const mn = rowMin.get(y);
      if (mn === undefined || x < mn) rowMin.set(y, x);
      const mx = rowMax.get(y);
      if (mx === undefined || x > mx) rowMax.set(y, x);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= bw || (dx === 0 && dy === 0)) continue;
          const q = yy * bw + xx;
          if (label[q] === 0 && prob[q] > DET_THRESH) {
            label[q] = comp;
            stack[sp++] = q;
          }
        }
      }
    }
    const pts: Pt[] = [];
    const rows = [...rowMin.keys()].sort((a, b) => a - b);
    for (const y of rows) {
      pts.push([rowMin.get(y)!, y]);
      if (rowMax.get(y)! !== rowMin.get(y)!) pts.push([rowMax.get(y)!, y]);
    }
    const rect = minAreaRect(pts);
    if (Math.min(rect.w, rect.h) < DET_MIN_SIZE) continue;

    // Mean probability inside the rectangle (the "fast" box score).
    const corners = rectCorners(rect);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [cx, cy] of corners) {
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
    }
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(bw - 1, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(bh - 1, Math.ceil(y1));
    let sum = 0, cnt = 0;
    const hw = rect.w / 2 + 0.5, hh = rect.h / 2 + 0.5;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dx = x - rect.cx, dy = y - rect.cy;
        if (Math.abs(dx * rect.ux + dy * rect.uy) <= hw && Math.abs(-dx * rect.uy + dy * rect.ux) <= hh) {
          sum += prob[y * bw + x];
          cnt++;
        }
      }
    }
    const score = cnt ? sum / cnt : 0;
    if (score < DET_BOX_THRESH) continue;

    const d = (rect.w * rect.h * DET_UNCLIP_RATIO) / (2 * (rect.w + rect.h));
    const grown: RotRect = { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
    if (Math.min(grown.w, grown.h) < DET_MIN_SIZE + 2) continue;

    const sx = destW / bw, sy = destH / bh;
    const quad = rectCorners(grown).map(([x, y]) => [
      Math.min(destW, Math.max(0, Math.round(x * sx))),
      Math.min(destH, Math.max(0, Math.round(y * sy))),
    ]) as Quad;
    out.push({ quad, score });
  }
  return out;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * PaddleOCR's sorted_boxes: top-to-bottom by the top-left corner, then within
 * 10 px of the same height, left-to-right. The parser does its own row grouping;
 * this order only needs to be stable and roughly readable.
 */
export function sortQuads<T extends { quad: Quad }>(items: T[]): T[] {
  const s = items.slice().sort((a, b) => a.quad[0][1] - b.quad[0][1] || a.quad[0][0] - b.quad[0][0]);
  for (let i = 0; i < s.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      if (Math.abs(s[j + 1].quad[0][1] - s[j].quad[0][1]) < 10 && s[j + 1].quad[0][0] < s[j].quad[0][0]) {
        [s[j], s[j + 1]] = [s[j + 1], s[j]];
      } else break;
    }
  }
  return s;
}

// ── recognition ──────────────────────────────────────────────────────────────

/**
 * Cut a quad out of the image as an upright strip (PaddleOCR's
 * get_rotate_crop_image). Output pixel (i, j) samples the source at the
 * bilinear blend of the four corners with s = i/W, t = j/H — for the near-
 * rectangles the detector returns this is the perspective warp — with
 * bilinear interpolation and edge-replicating borders. Strips at least 1.5x
 * taller than wide are turned 90° counter-clockwise, as the reference does, so
 * vertical text reaches the recogniser lying down.
 */
export function cropQuad(img: Rgb, quad: Quad): Rgb {
  const [tl, tr, br, bl] = quad;
  const W = Math.max(1, Math.trunc(Math.max(dist(tl, tr), dist(bl, br))));
  const H = Math.max(1, Math.trunc(Math.max(dist(tl, bl), dist(tr, br))));
  const data = new Uint8Array(W * H * 3);
  const { width: iw, height: ih } = img;
  const src = img.data;
  for (let j = 0; j < H; j++) {
    const t = j / H;
    for (let i = 0; i < W; i++) {
      const s = i / W;
      const x = (1 - t) * ((1 - s) * tl[0] + s * tr[0]) + t * ((1 - s) * bl[0] + s * br[0]);
      const y = (1 - t) * ((1 - s) * tl[1] + s * tr[1]) + t * ((1 - s) * bl[1] + s * br[1]);
      const xc = Math.min(iw - 1, Math.max(0, x));
      const yc = Math.min(ih - 1, Math.max(0, y));
      const x0 = Math.floor(xc), y0 = Math.floor(yc);
      const x1 = Math.min(iw - 1, x0 + 1), y1 = Math.min(ih - 1, y0 + 1);
      const fx = xc - x0, fy = yc - y0;
      const o = (j * W + i) * 3;
      for (let c = 0; c < 3; c++) {
        const v00 = src[(y0 * iw + x0) * 3 + c], v10 = src[(y0 * iw + x1) * 3 + c];
        const v01 = src[(y1 * iw + x0) * 3 + c], v11 = src[(y1 * iw + x1) * 3 + c];
        const v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
        data[o + c] = Math.round(v);
      }
    }
  }
  if (H / W < 1.5) return { data, width: W, height: H };
  // rot90 counter-clockwise: new (r, c) = old (c, W-1-r); new size H × W.
  const rot = new Uint8Array(W * H * 3);
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < H; c++) {
      const from = (c * W + (W - 1 - r)) * 3;
      const to = (r * H + c) * 3;
      rot[to] = data[from];
      rot[to + 1] = data[from + 1];
      rot[to + 2] = data[from + 2];
    }
  }
  return { data: rot, width: H, height: W };
}

/**
 * Recognition input (RecResizeImg): height 48, width from the strip's own aspect
 * ratio, then zero-padded (mid-grey after normalising) to at least 320 px.
 * Each strip is recognised ALONE rather than batched with its neighbours:
 * batching pads every strip to the widest one in the batch, which would make a
 * token's reading depend on what else happened to be in the photo.
 */
export function recTensor(crop: Rgb): { data: Float32Array; width: number } {
  const ratio = crop.width / crop.height;
  const imgW = Math.min(REC_MAX_WIDTH, Math.max(REC_MIN_WIDTH, Math.floor(REC_HEIGHT * ratio)));
  const rw = Math.max(1, Math.min(imgW, Math.ceil(REC_HEIGHT * ratio)));
  const px = resample(crop.data, crop.width, crop.height, 3, rw, REC_HEIGHT);
  const plane = imgW * REC_HEIGHT;
  const data = new Float32Array(3 * plane);
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < rw; x++) {
      const s = (y * rw + x) * 3;
      const p = y * imgW + x;
      data[p] = (px[s + 2] / 255 - 0.5) / 0.5; // B
      data[plane + p] = (px[s + 1] / 255 - 0.5) / 0.5; // G
      data[2 * plane + p] = (px[s] / 255 - 0.5) / 0.5; // R
    }
  }
  return { data, width: imgW };
}

/**
 * Greedy CTC decoding (CTCLabelDecode): arg-max per time step, collapse repeats,
 * drop the blank. Class 0 is the blank, 1..N the dictionary, N+1 a space.
 * Confidence is the mean arg-max probability of the characters kept. No
 * dictionary, language model or spelling correction — rule 1 says a misread
 * must reach the verifier as it was read.
 */
export function ctcDecode(
  probs: Float32Array,
  steps: number,
  classes: number,
  dict: readonly string[],
): { text: string; conf: number } {
  let text = "";
  let sum = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < steps; t++) {
    const row = t * classes;
    let arg = 0;
    let best = probs[row];
    for (let c = 1; c < classes; c++) {
      const v = probs[row + c];
      if (v > best) {
        best = v;
        arg = c;
      }
    }
    if (arg !== 0 && arg !== prev) {
      text += arg - 1 < dict.length ? dict[arg - 1] : " ";
      sum += best;
      kept++;
    }
    prev = arg;
  }
  return { text, conf: kept ? sum / kept : 0 };
}

export interface PipelineTimings {
  detMs: number;
  recMs: number;
  boxes: number;
}

/** Detect and recognise every text line in a working image. Tokens come back in working-image pixels, in reading order. */
export async function readImage(
  img: Rgb,
  infer: Infer,
  dict: readonly string[],
  now: () => number = () => performance.now(),
): Promise<{ tokens: RawToken[]; timings: PipelineTimings }> {
  const t0 = now();
  const det = detTensor(img);
  const detOut = await infer("det", det.data, [1, 3, det.height, det.width]);
  const bh = detOut.dims[2];
  const bw = detOut.dims[3];
  const boxes = sortQuads(dbPostprocess(detOut.data, bw, bh, img.width, img.height));
  const t1 = now();

  const tokens: RawToken[] = [];
  for (const b of boxes) {
    const crop = cropQuad(img, b.quad);
    // A strip under 4 px either way carries no readable glyph; the reference
    // filter drops these too.
    if (crop.width <= 3 || crop.height <= 3) continue;
    const rec = recTensor(crop);
    const out = await infer("rec", rec.data, [1, 3, REC_HEIGHT, rec.width]);
    const { text, conf } = ctcDecode(out.data, out.dims[1], out.dims[2], dict);
    if (!text.trim()) continue;
    tokens.push({ text, quad: b.quad, conf });
  }
  const t2 = now();
  return { tokens, timings: { detMs: t1 - t0, recMs: t2 - t1, boxes: boxes.length } };
}
