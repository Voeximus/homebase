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
 *  the status colours all appear as small coloured text.
 *
 *  `lime` is NOT here, and that is the point of it: on the light ground it is
 *  1.27:1 and can only ever be a fill. It is checked separately, below, in the
 *  two ways it is actually used. */
const INKS = ["bone", "taupe", "faint", "accent", "mint", "gold", "ember"];

/** LIGHT is the base now — the reference he picked is a light design — and dark
 *  is the override. This was the other way round until 2026-10-04; if it inverts
 *  again, the block names here are what has to move. */
const THEMES: { name: string; block: string; ground: string; tile: string }[] = [
  { name: "light", block: "@theme {", ground: "bg", tile: "tile" },
  { name: "dark", block: ':root[data-theme="dark"] {', ground: "bg", tile: "tile" },
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

  it("the dark theme is defined twice and the two copies agree", () => {
    // The dark palette lives in a [data-theme="dark"] block AND inside the
    // prefers-color-scheme media query, because the un-stamped viewer is the
    // common case and a media query cannot be re-used as a selector. Two copies
    // is two places to drift, so they are compared rather than trusted.
    const explicit = ':root[data-theme="dark"] {';
    const auto = ':root:not([data-theme="light"]) {';
    for (const ink of [...INKS, "bg", "tile", "raised", "edge", "hero", "heroink", "lime"]) {
      expect(tokenIn(auto, ink), `--color-${ink} differs between the two dark blocks`).toBe(
        tokenIn(explicit, ink),
      );
    }
  });

  it("light stays the base, so a viewer with no preference gets the reference", () => {
    // :root is light; dark only arrives via the media query or an explicit stamp.
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light/);
  });

  it("the hero card is legible, and is the opposite of its page in both themes", () => {
    // The whole move of this design: a black card on cream, a cream card on
    // black. If the two ever land on the same side of the page's lightness the
    // hero stops being a hero and becomes a slightly-off rectangle.
    for (const theme of THEMES) {
      const page = inkOn(tokenIn(theme.block, "bg"), [0, 0, 0]);
      const hero = inkOn(tokenIn(theme.block, "hero"), page);
      const heroInk = inkOn(tokenIn(theme.block, "heroink"), hero);
      expect(
        contrast(heroInk, hero),
        `${theme.name}: the hero card's own ink is unreadable on it`,
      ).toBeGreaterThanOrEqual(AA);
      expect(
        contrast(hero, page),
        `${theme.name}: the hero card does not separate from the page`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("lime is a fill on light and may be text on dark — and black always reads on it", () => {
    // It is the same hex in both themes with two different jobs, which looks like
    // an inconsistency and is the opposite: on cream it measures 1.27:1 and
    // CANNOT be a letterform, so the accent there is the ink; on black it
    // measures 14.82:1 and leads.
    const lightLime = inkOn(tokenIn("@theme {", "lime"), [255, 255, 255]);
    const lightTile = inkOn(tokenIn("@theme {", "tile"), [255, 255, 255]);
    const lightInk = inkOn(tokenIn("@theme {", "bone"), lightTile);
    expect(
      contrast(lightLime, lightTile),
      "the lime has become readable on the light card — if that is deliberate, this test is what stops it being an accident",
    ).toBeLessThan(AA);
    expect(contrast(lightInk, lightLime)).toBeGreaterThanOrEqual(AA);

    // And on light the accent must NOT be the lime, or it would be text.
    expect(tokenIn("@theme {", "accent")).not.toBe(tokenIn("@theme {", "lime"));
  });
});
