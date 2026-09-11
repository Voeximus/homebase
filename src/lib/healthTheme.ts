// Health-mode appearance themes. Each id maps to a `.htheme-<id>` class in
// index.css that overrides the semantic --color-* tokens (plus the health-only
// --h-* tokens) on the health root, so every surface reskins at once. The choice
// is a PER-DEVICE preference (localStorage) — a look, not shared household data —
// so Gino and Xinyan can each pick their own.
//
// The three differ by GROUND TEMPERATURE, TYPE and DENSITY — not by fighting
// over hue. The macro legend (protein / carbs / fat) is identical in all three,
// because a legend that moves between themes is not a legend; that constraint
// then forces every accent into the teal→lime arc, which is the only part of the
// wheel none of the three macros occupies. See the long note at the top of the
// health block in index.css for the derivation.

export type HealthTheme = "original" | "instrument" | "bold";

export const HEALTH_THEMES: {
  id: HealthTheme;
  label: string;
  /** The accent — the dot in the chooser, and the only thing that differs. */
  swatch: string;
  /** That theme's page ground, so the chip previews the real pairing. */
  ground: string;
  edge: string;
  blurb: string;
}[] = [
  { id: "original", label: "Calm", swatch: "#34d399", ground: "#101319", edge: "#262d3a", blurb: "Warm ground" },
  { id: "instrument", label: "Instrument", swatch: "#22d3ee", ground: "#080b0e", edge: "#1c2731", blurb: "Precise, mono" },
  { id: "bold", label: "Bold", swatch: "#a3e635", ground: "#0d0e12", edge: "#2c3340", blurb: "Big type" },
];

const KEY = "hb-health-theme";

export function loadHealthTheme(): HealthTheme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "instrument" || v === "bold" || v === "original") return v;
  } catch {
    /* storage unavailable — fall through to default */
  }
  return "original";
}

export function saveHealthTheme(theme: HealthTheme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* non-fatal */
  }
}
