// Light, dark, or whatever the phone says.
//
// His decision on 2026-10-04: "let's have light and dark be an option." Three
// states, not two — "follow the phone" is the default and the one most people
// never change, and it is a real state rather than the absence of a choice.
//
// HOW IT REACHES THE CSS. src/index.css defines the dark palette on :root, gives
// light to anyone whose OS asks for it UNLESS they explicitly chose dark, and lets
// an explicit choice win outright. So this only has to stamp one attribute:
//
//   "system" → no attribute at all, and the media query decides
//   "light"  → data-theme="light"
//   "dark"   → data-theme="dark"
//
// Writing data-theme="dark" for `system` would LOOK equivalent on a dark phone and
// then fail to follow the phone when it switches at sunset, which is the whole
// behaviour being asked for.

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "hb-theme";

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "Automatic",
  light: "Light",
  dark: "Dark",
};

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    // A phone with site data blocked still gets a working app on the system theme.
    return "system";
  }
}

/** Stamp the choice onto <html>. Safe to call before React mounts. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  // The browser UI — the status bar on an installed PWA, the scrollbars, form
  // controls — follows <meta name="theme-color">, which no CSS variable reaches.
  // Read it back off the computed ground so this cannot drift from the palette.
  const ground = getComputedStyle(root).getPropertyValue("--color-bg").trim();
  if (ground) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", ground);
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* the choice just will not survive a reload; the app still switches now */
  }
  applyTheme(choice);
}

/**
 * Keep `system` honest: when the phone flips at sunset, the page is already open.
 * Returns an unsubscribe. A no-op in a browser without matchMedia listeners.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      if (getTheme() === "system") onChange();
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  } catch {
    return () => {};
  }
}
