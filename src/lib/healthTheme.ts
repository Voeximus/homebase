// Health-mode appearance themes. Each id maps to a `.htheme-<id>` class in
// index.css that overrides the semantic --color-* tokens (plus a few health-only
// --h-* tokens) on the health root, so every surface reskins at once. The choice
// is a PER-DEVICE preference (localStorage) — a look, not shared household data —
// so Gino and Xinyan can each pick their own.

export type HealthTheme = "original" | "instrument" | "bold";

export const HEALTH_THEMES: {
  id: HealthTheme;
  label: string;
  swatch: string; // the chip background in the chooser
  blurb: string;
}[] = [
  { id: "original", label: "Original", swatch: "linear-gradient(150deg,#fb7185,#f43f5e)", blurb: "Warm & clean" },
  { id: "instrument", label: "Instrument", swatch: "#0d1318", blurb: "Precise & mono" },
  { id: "bold", label: "Bold", swatch: "linear-gradient(150deg,#fbbf24,#fb7185)", blurb: "Punchy & bright" },
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
