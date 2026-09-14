import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BodyMap } from "../src/components/workout/BodyMap";
import { BODY_PATHS, shapesFor } from "../src/lib/bodyMapPaths";
import { REGIONS, isRegionId } from "../src/lib/muscleRegions";

// The body map is data plus one renderer. What can go wrong silently: a region the
// library marks as a main muscle has no shape, so the figure shows nothing lit and
// nobody notices; or the helper stripe is lost and main and helper look the same.
// vitest runs in node (no jsdom), so the component is checked as static markup.

const render = (primary: string[], secondary: string[]) =>
  renderToStaticMarkup(
    createElement(BodyMap, { primary: primary.filter(isRegionId), secondary: secondary.filter(isRegionId) }),
  );

// The <g> for one region on one figure, with its style attribute.
const regionGroups = (html: string, id: string) =>
  [...html.matchAll(new RegExp(`<g data-region="${id}" data-fill="(\\w+)" style="([^"]*)"`, "g"))].map((m) => ({
    fill: m[1],
    style: m[2],
  }));

describe("body map paths", () => {
  it("gives every drawn region at least one shape", () => {
    const missing = REGIONS.filter((r) => r.drawn && shapesFor(r.id).length === 0).map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it("never draws a region marked drawn: false", () => {
    expect(shapesFor("hip_flexors")).toEqual([]);
    for (const r of REGIONS.filter((x) => !x.drawn)) expect(shapesFor(r.id)).toEqual([]);
  });

  it("keys shapes only by real region ids", () => {
    const keys = [...Object.keys(BODY_PATHS.front), ...Object.keys(BODY_PATHS.back)];
    expect(keys.filter((k) => !isRegionId(k))).toEqual([]);
  });
});

describe("BodyMap", () => {
  it("paints main solid and helper striped", () => {
    const html = render(["glute_max"], ["hamstrings"]);

    const glute = regionGroups(html, "glute_max");
    expect(glute.length).toBeGreaterThan(0);
    for (const g of glute) {
      expect(g.fill).toBe("main");
      expect(g.style).toContain("fill:var(--color-bone)");
    }

    // The stripe is a <pattern> in this map, and the helper region fills from it.
    const patternId = html.match(/<pattern id="(hbHatch[^"]*)"/)?.[1];
    expect(patternId).toBeTruthy();
    const hams = regionGroups(html, "hamstrings");
    expect(hams.length).toBeGreaterThan(0);
    for (const g of hams) {
      expect(g.fill).toBe("help");
      expect(g.style).toContain(`fill:url(#${patternId})`);
      expect(g.style).toContain("stroke:var(--color-bone)");
    }

    // Everything else stays the quiet highlight tone.
    for (const g of regionGroups(html, "chest_upper")) expect(g.style).toContain("fill:var(--h-hl)");
  });

  it("gives two maps on one page their own stripe patterns", () => {
    const props = { primary: [], secondary: ["hamstrings" as const] };
    const html = renderToStaticMarkup(
      createElement("div", null, createElement(BodyMap, props), createElement(BodyMap, props)),
    );
    const ids = [...html.matchAll(/<pattern id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("keeps the picture out of the accessibility tree and labels the legend", () => {
    const html = render(["glute_max"], ["hamstrings"]);
    expect(html.startsWith('<div aria-hidden="true">')).toBe(true);
    expect(html).toContain("Main");
    expect(html).toContain("Helps");
  });
});
