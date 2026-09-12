// ── Is this frame worth reading? ─────────────────────────────────────────────
//
// The capture gate for LabelScanner, as pure functions over pixels so it can be
// tested without a camera. Two measurements per sample:
//
//   sharpness  variance of the Laplacian of the grey image. A focused edge is a
//              sharp second derivative; defocus and motion blur smear it, and
//              the variance falls fast (it goes roughly with 1/blur⁴).
//   motion     mean absolute difference from the previous sample. Zero for a
//              still scene, and it climbs steeply with even a pixel of drift.
//
// Both numbers depend on the scale they are measured at, so the thresholds
// below are only meaningful for a sample whose long side is SAMPLE_LONG_SIDE.
//
// Calibration (fixture tests/fixtures/labels/fda-label-1-photo-sim.jpg, the
// panel region box-downscaled to a 640 px long side, extra Gaussian blur added
// at frame scale, then read by the real OCR at MAX_SIDE 2000):
//
//   added blur σ (px)     0     1     1.5    2     3     4
//   Laplacian variance  2397  1194   608   312    94    39
//   number lines read   27/29 27/29 27/29 27/29 24/29 15/29
//
// Reading holds to σ = 2 and breaks by σ = 3, so the floor sits between them.
// Flat grey with σ = 4 sensor noise alone scores ~320 — noise looks like detail
// to a Laplacian — which is why the floor is not the only condition: a frame must
// also be close to the sharpest one seen recently, and still.
//
// Motion on the same sample: a 1 px shift of the whole frame scores 4.7, 2 px
// 11.5, 4 px 19.6; sensor noise alone ~3.4. At six samples a second a 2 px drift
// per sample is ~12 px/s, and at a 1/30 s indoor exposure that smears ~0.4 px —
// well inside the σ = 2 the reader tolerates.
//
// NOT yet measured on either phone: real sensor noise, real hand tremor, and how
// long continuous autofocus takes to settle. The manual shutter is always there.

/** Long side, in pixels, of the region the scanner samples. The thresholds are calibrated at this scale. */
export const SAMPLE_LONG_SIDE = 640;
/** Laplacian variance floor — between blur σ 2 (312, read fine) and σ 3 (94, misread). */
export const SHARPNESS_MIN = 150;
/** A frame must reach this fraction of the recent peak: autofocus hunting passes through soft frames that still clear the floor. */
export const PEAK_FRACTION = 0.6;
/** Per-sample decay of the remembered peak (≈ 3.8 s half-life at 6 Hz), so one lucky frame doesn't set an unreachable bar forever. */
export const PEAK_DECAY = 0.97;
/** Mean absolute grey-level difference allowed between consecutive samples (~2 px of drift). */
export const MOTION_MAX = 14;
/** Consecutive good samples before auto-capture — half a second at 6 Hz. */
export const READY_STREAK = 3;

/** ITU-R BT.601 luma, as integers-in-floats. Input is RGBA (canvas order). */
export function grayscale(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  const n = width * height;
  if (rgba.length < n * 4) throw new Error(`grayscale: expected ${n * 4} bytes, got ${rgba.length}`);
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return g;
}

/** Variance of the 4-neighbour Laplacian over the interior pixels. 0 for a flat image. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const l = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += l;
      sq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

/** Mean absolute difference between two same-sized grey samples. 0 for identical frames. */
export function frameMotion(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error("frameMotion: samples differ in size");
  if (a.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** The size to draw a region at so its long side is SAMPLE_LONG_SIDE (never enlarged). */
export function sampleSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const s = long > SAMPLE_LONG_SIDE ? SAMPLE_LONG_SIDE / long : 1;
  return { width: Math.max(3, Math.round(width * s)), height: Math.max(3, Math.round(height * s)) };
}

/**
 *  aim     not enough detail in the frame to be a label (or badly out of focus)
 *  steady  detail is there but the frame is moving or softer than it just was
 *  ready   sharp and still — READY_STREAK of these in a row fires the shutter
 */
export type Readiness = "aim" | "steady" | "ready";

export interface GateState {
  peak: number;
  streak: number;
  prev: Float32Array | null;
}

export const initialGate = (): GateState => ({ peak: 0, streak: 0, prev: null });

export interface GateReading {
  sharpness: number;
  motion: number;
  readiness: Readiness;
  /** True on the sample that completes the streak. */
  fire: boolean;
}

/**
 * Advance the gate by one grey sample. Pure: returns the next state rather than
 * mutating, so a test can walk a sequence of frames and see every decision.
 * The first sample after a reset has no motion reference and is never "ready".
 */
export function stepGate(state: GateState, gray: Float32Array, width: number, height: number): { state: GateState; reading: GateReading } {
  const sharpness = laplacianVariance(gray, width, height);
  const motion = state.prev && state.prev.length === gray.length ? frameMotion(state.prev, gray) : Infinity;
  const peak = Math.max(sharpness, state.peak * PEAK_DECAY);
  let readiness: Readiness;
  if (sharpness < SHARPNESS_MIN) readiness = "aim";
  else if (motion > MOTION_MAX || sharpness < PEAK_FRACTION * peak) readiness = "steady";
  else readiness = "ready";
  const streak = readiness === "ready" ? state.streak + 1 : 0;
  return {
    state: { peak, streak, prev: gray },
    reading: { sharpness, motion, readiness, fire: streak === READY_STREAK },
  };
}
