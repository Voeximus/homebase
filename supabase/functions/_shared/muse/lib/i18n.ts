// GENERATED — DO NOT EDIT. Source: src/lib/i18n.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/i18n.ts
// and re-run the generator.
import { ZH } from "./i18n_zh.ts";

// Lightweight i18n. Components call t("English string"); when the language is
// Simplified Chinese, t() returns the ZH translation (falling back to English
// for anything not yet translated). The current language is a module-level var
// so t() needs no hook; LanguageProvider flips it and remounts the view tree
// (via a key) so every t() re-evaluates. See components/LanguageProvider.tsx.

export type Lang = "en" | "zh";

// Wrapped because reading storage can THROW, not just come back empty, and this
// one runs at import time — so a throw here takes down whatever imported the
// module rather than losing a preference. Two places it throws:
//   · a private window, blocked site data, or a thumbnail capture (the same
//     reason doctorDismissals.ts wraps every read and write);
//   · Deno, where `localStorage` is a global getter that raises "Location URL not
//     set" unless the runtime was given one. The Muse doors import this module
//     through ledgerReview, so an unguarded read here means the whole edge
//     function fails to start — not one tool, the door.
// English is the right fallback: it is what every source string already is.
let current: Lang = "en";
try {
  if (typeof localStorage !== "undefined") {
    current = (localStorage.getItem("hb-lang") as Lang) || "en";
  }
} catch {
  /* storage unavailable — English, and nothing breaks */
}

export function getLang(): Lang {
  return current;
}
export function setLangVar(l: Lang): void {
  current = l;
}

/**
 * Translate a source English string to the current language (English fallback).
 * Supports {placeholders}: t("send {amount} on {date}", { amount, date }).
 */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = current === "zh" ? ZH[s] ?? s : s;
  if (vars) {
    for (const k in vars) out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

/**
 * t() for an English word that means different things in different places —
 * "Back" the button, the back of the body, the body area; "Set" the finance
 * button (设置) and a set in the gym (组). The Chinese entry is keyed
 * "English|context"; English, and any context without an entry, is t(s).
 */
export function tc(s: string, context: string, vars?: Record<string, string | number>): string {
  const key = `${s}|${context}`;
  return current === "zh" && key in ZH ? t(key, vars) : t(s, vars);
}
