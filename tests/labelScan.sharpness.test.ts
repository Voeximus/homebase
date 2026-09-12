import { describe, it, expect } from "vitest";
import {
  frameMotion,
  grayscale,
  initialGate,
  laplacianVariance,
  MOTION_MAX,
  READY_STREAK,
  sampleSize,
  SAMPLE_LONG_SIDE,
  SHARPNESS_MIN,
  stepGate,
} from "../src/lib/labelScan/sharpness";

// The capture gate decides when the shutter fires by itself. If sharpness can't
// tell a focused frame from a soft one, auto-capture takes blurry photos and
// every downstream check starts from misreads; if motion can't see a still
// frame, it never fires at all. These tests pin both directions on synthetic
// frames whose answer is known without a camera.

const W = 96;
const H = 96;

/** Black/white checkerboard, `cell` px squares, as a grey image. */
function checkerboard(cell: number, w = W, h = H): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = ((x / cell) ^ (y / cell)) & 1 ? 255 : 0;
  return g;
}

/** Separable box blur of radius r, edges clamped — a stand-in for defocus. */
function boxBlur(src: Float32Array, r: number, w = W, h = H): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + clamp(x + k, w - 1)];
      tmp[y * w + x] = s / (2 * r + 1);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[clamp(y + k, h - 1) * w + x];
      out[y * w + x] = s / (2 * r + 1);
    }
  return out;
}

/** Shift an image right by dx px (wrapping), i.e. the camera drifted. */
function shift(src: Float32Array, dx: number, w = W, h = H): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + ((x + dx) % w)] = src[y * w + x];
  return out;
}

describe("sharpness — variance of the Laplacian", () => {
  it("scores a sharp checkerboard higher than its blurred copy", () => {
    const sharp = checkerboard(8);
    const soft = boxBlur(sharp, 2);
    const softer = boxBlur(sharp, 4);
    const s0 = laplacianVariance(sharp, W, H);
    const s1 = laplacianVariance(soft, W, H);
    const s2 = laplacianVariance(softer, W, H);
    expect(s0).toBeGreaterThan(s1);
    expect(s1).toBeGreaterThan(s2);
    // Not a marginal ordering: blur collapses the second derivative.
    expect(s0).toBeGreaterThan(5 * s1);
  });

  it("is zero for a flat frame — nothing to focus on", () => {
    expect(laplacianVariance(new Float32Array(W * H).fill(128), W, H)).toBe(0);
  });

  it("puts a sharp checkerboard above the floor and a heavily blurred one below it", () => {
    const sharp = checkerboard(8);
    expect(laplacianVariance(sharp, W, H)).toBeGreaterThan(SHARPNESS_MIN);
    expect(laplacianVariance(boxBlur(sharp, 6), W, H)).toBeLessThan(SHARPNESS_MIN);
  });
});

describe("motion — frame difference", () => {
  it("is exactly zero for identical frames", () => {
    const a = checkerboard(8);
    expect(frameMotion(a, a)).toBe(0);
    expect(frameMotion(a, Float32Array.from(a))).toBe(0);
  });

  it("grows with drift", () => {
    const a = boxBlur(checkerboard(8), 1);
    const m1 = frameMotion(a, shift(a, 1));
    const m4 = frameMotion(a, shift(a, 4));
    expect(m1).toBeGreaterThan(0);
    expect(m4).toBeGreaterThan(m1);
  });

  it("refuses to compare frames of different sizes", () => {
    expect(() => frameMotion(new Float32Array(4), new Float32Array(9))).toThrow();
  });
});

describe("grayscale", () => {
  it("uses BT.601 weights on RGBA input", () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const g = grayscale(px, 4, 1);
    expect(g[0]).toBeCloseTo(76.245, 3);
    expect(g[1]).toBeCloseTo(149.685, 3);
    expect(g[2]).toBeCloseTo(29.07, 3);
    expect(g[3]).toBeCloseTo(255, 3);
  });
});

describe("sampleSize", () => {
  it("caps the long side and keeps the aspect ratio", () => {
    expect(sampleSize(1080, 1920)).toEqual({ width: 360, height: SAMPLE_LONG_SIDE });
    expect(sampleSize(300, 200)).toEqual({ width: 300, height: 200 });
  });
});

describe("the gate — sharp AND still for a streak, then fire once", () => {
  it("fires after READY_STREAK still, sharp samples and not before", () => {
    const frame = checkerboard(8);
    let state = initialGate();
    const fired: boolean[] = [];
    for (let i = 0; i < READY_STREAK + 3; i++) {
      const r = stepGate(state, frame, W, H);
      state = r.state;
      fired.push(r.reading.fire);
    }
    // Sample 0 has no previous frame, so the streak starts at sample 1.
    const firstFire = fired.indexOf(true);
    expect(firstFire).toBe(READY_STREAK);
    expect(fired.filter(Boolean)).toHaveLength(1);
  });

  it("says 'aim' when there is nothing sharp in view", () => {
    const flat = new Float32Array(W * H).fill(90);
    let state = initialGate();
    for (let i = 0; i < 5; i++) {
      const r = stepGate(state, flat, W, H);
      state = r.state;
      expect(r.reading.readiness).toBe("aim");
      expect(r.reading.fire).toBe(false);
    }
  });

  it("holds ('steady') while the frame is moving, and a stop restarts the streak", () => {
    const base = checkerboard(8);
    let state = initialGate();
    // Drift every sample: sharp, but never still.
    for (let i = 0; i < 6; i++) {
      const r = stepGate(state, shift(base, (i * 5) % W), W, H);
      state = r.state;
      if (i > 0) {
        expect(r.reading.motion).toBeGreaterThan(MOTION_MAX);
        expect(r.reading.readiness).toBe("steady");
      }
      expect(r.reading.fire).toBe(false);
    }
    expect(state.streak).toBe(0);
  });

  it("won't take a soft frame right after a sharp one (autofocus hunting)", () => {
    const sharp = checkerboard(8);
    const soft = boxBlur(sharp, 2);
    // Soft is still above the absolute floor — the peak rule is what rejects it.
    expect(laplacianVariance(soft, W, H)).toBeGreaterThan(SHARPNESS_MIN);
    let state = initialGate();
    state = stepGate(state, sharp, W, H).state;
    state = stepGate(state, soft, W, H).state;
    // Second soft frame: zero motion, above the floor — only the peak rule can hold it.
    const r = stepGate(state, soft, W, H);
    expect(r.reading.motion).toBe(0);
    expect(r.reading.readiness).toBe("steady");
  });
});
