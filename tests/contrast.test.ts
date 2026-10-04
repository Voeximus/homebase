// Every colour that carries text has to be readable on the surface it sits on.
//
// WHY THIS IS A TEST AND NOT A ONE-OFF CHECK. The Apple palette went in on
// 2026-10-04 with ratios written into the comments from memory, and four of the
// seven inks were wrong when actually computed — including two that FAILED:
// systemOrange at 2.20:1 on white and Apple's own secondaryLabel at 3.44:1. The
// numbers looked plausible, which is the whole problem with writing them by hand.
//
// So the ratios are computed from the stylesheet itself, every run. If someone
// swaps a hue back to Apple's published value because it looks more correct — and
// Apple's published value is exactly what a reasonable person would reach for —
// this fails and says by how much.
//
// THE TWO SURFACES MATTER SEPARATELY. Each theme has a ground and a tile, and a
// colour can pass on one and fail on the other: #007AFF is 4.70:1 on the white
// tile and 4.21:1 on the #F2F2F7 ground, and the tab bar sits on the ground. Both
// are checked, and the worse one is the one that counts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/index.css", "utf8");

type RGB = [number, number, number];

const srgb = (c: number): number => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const luminance = ([r, g, b]: RGB): number => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
/** An rgba ink composited over an opaque surface — what the eye actually gets. */
const over = (fg: RGB, alpha: number, bg: RGB): RGB =>
  fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as RGB;

/** Read a token's value out of a named block in the stylesheet. */
function tokenIn(block: string, name: string): string {
  const start = css.indexOf(block);
  expect(start, `the block ${JSON.stringify(block)} is not in index.css any more`).toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  const body = css.slice(start, end);
  const m = body.match(new RegExp(`--color-${name}:\\s*([^;]+);`));
  expect(m, `--color-${name} is not defined in ${block}`).not.toBeNull();
  return m![1].trim();
}

/** Resolve a token to a concrete colour on a given surface. */
function inkOn(value: string, surface: RGB): RGB {
  const rgba = value.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  if (rgba) {
    return over([Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], Number(rgba[4]), surface);
  }
  const h = value.match(/#[0-9a-f]{6}/i);
  expect(h, `cannot read a colour out of ${JSON.stringify(value)}`).not.toBeNull();
  return hex(h![0]);
}

/** WCAG AA for normal-size text. Every one of these carries 13–17px copy. */
const AA = 4.5;

/** Inks that carry real text. `bone` is the label, `faint` the quietest hint, and
 *  the three status colours all appear as small coloured text, never as a fill
 *  behind white. */
const INKS = ["bone", "taupe", "faint", "accent", "mint", "gold", "ember"];

const THEMES: { name: string; block: string; ground: string; tile: string }[] = [
  { name: "dark", block: "@theme {", ground: "bg", tile: "tile" },
  { name: "light", block: ':root[data-theme="light"] {', ground: "bg", tile: "tile" },
];

describe("every ink reads on both of its theme's surfaces", () => {
  for (const theme of THEMES) {
    const ground = inkOn(tokenIn(theme.block, theme.ground), [0, 0, 0]);
    const tile = inkOn(tokenIn(theme.block, theme.tile), ground);

    for (const ink of INKS) {
      it(`${theme.name}: ${ink}`, () => {
        const value = tokenIn(theme.block, ink);
        const onTile = contrast(inkOn(value, tile), tile);
        const onGround = contrast(inkOn(value, ground), ground);
        const worst = Math.min(onTile, onGround);
        expect(
          worst,
          `--color-${ink} (${value}) in ${theme.name} is ${worst.toFixed(2)}:1 — ` +
            `${onTile.toFixed(2)} on the tile, ${onGround.toFixed(2)} on the ground`,
        ).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it("the light theme is defined twice and the two copies agree", () => {
    // The palette lives in a [data-theme="light"] block AND inside the
    // prefers-color-scheme media query, because the un-stamped viewer is the
    // common case and a media query cannot be re-used as a selector. Two copies
    // is two places to drift, so they are compared rather than trusted.
    const explicit = ':root[data-theme="light"] {';
    const auto = ':root:not([data-theme="dark"]) {';
    for (const ink of [...INKS, "bg", "tile", "raised", "edge"]) {
      expect(tokenIn(auto, ink), `--color-${ink} differs between the two light blocks`).toBe(
        tokenIn(explicit, ink),
      );
    }
  });

  it("dark stays the base, so a viewer with no preference gets it", () => {
    // :root is dark; light only arrives via the media query or an explicit stamp.
    // If this inverts, every un-stamped phone flips overnight.
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*dark/);
  });
});
