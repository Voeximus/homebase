import { ZH } from "./i18n_zh";

// Lightweight i18n. Components call t("English string"); when the language is
// Simplified Chinese, t() returns the ZH translation (falling back to English
// for anything not yet translated). The current language is a module-level var
// so t() needs no hook; LanguageProvider flips it and remounts the view tree
// (via a key) so every t() re-evaluates. See components/LanguageProvider.tsx.

export type Lang = "en" | "zh";

let current: Lang =
  (typeof localStorage !== "undefined" &&
    (localStorage.getItem("hb-lang") as Lang)) ||
  "en";

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
