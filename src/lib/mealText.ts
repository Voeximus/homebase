// Turn a logged day — or one meal out of it — into text you can paste into a
// chat and have the other side actually understand.
//
// The point is a HANDOFF. "I ate about 2,000 calories" is not something an AI can
// reason with; the same day as a list of foods, weights, per-item macros, the
// target they were aimed at and what is left of it is something it can. So the
// format carries the whole chain of custody — what was eaten, how much of it, and
// against what — rather than a total that has already thrown the detail away.
//
// Plain text on purpose. Not JSON (nobody wants to paste braces into a chat, and
// a model reads prose at least as well), and not a Markdown table (they survive
// the trip badly and reflow into noise on a phone). Labelled lines survive
// everything.

import type { DayLog, LoggedItem, Macros, Meal, Person } from "./mealLog";
import { amountLabel, contribution, dayTotals, mealTotals, remaining, sumMacros } from "./mealLog";
import type { MacroTarget } from "./nutrition";

const r0 = (n: number) => Math.round(n);
const PERSON_LABEL: Record<Person, string> = { gino: "Gino", xinyan: "Xinyan" };

/** "Wed 10 Sep 2026" — written out, because "2026-09-10" invites a model to
 *  guess at a timezone and an ambiguous DD/MM ordering. */
function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "2145 kcal · 118P / 302C / 58F" — one macro line, spelled the same way
 *  everywhere so the reader learns the shape once. */
export function macroLine(m: Macros): string {
  return `${r0(m.kcal)} kcal · ${r0(m.p)}P / ${r0(m.c)}C / ${r0(m.f)}F`;
}

function itemLine(it: LoggedItem): string {
  const c = contribution(it);
  // The amount AS ENTERED plus the grams it resolved to. Both, because "3 eggs"
  // is what he did and 150 g is what the macros were computed from — and a
  // reader who only gets one of them cannot check the other.
  const amount = amountLabel(it);
  const grams = `${r0(it.grams)} g`;
  const qty = amount === grams ? grams : `${amount} (${grams})`;
  return `  - ${it.name} — ${qty} — ${macroLine(c)}`;
}

function mealBlock(meal: Meal, index: number): string {
  const name = meal.name?.trim() || `Meal ${index + 1}`;
  const lines = [`${name} — ${macroLine(mealTotals(meal))}`];
  for (const it of meal.items) lines.push(itemLine(it));
  return lines.join("\n");
}

/** One meal on its own, for the copy button on a meal card. */
export function mealToText(meal: Meal, index: number, person: Person, date: string): string {
  const head = `${PERSON_LABEL[person]} — ${longDate(date)}`;
  return [head, "", mealBlock(meal, index), "", FOOTER].join("\n");
}

const FOOTER =
  "(Macros are computed from per-100g values scaled by the gram weight, so the " +
  "gram figures are the source of truth. Cooked weights where it matters.)";

/**
 * A whole day: target, what was eaten, what is left, then every meal in full.
 *
 * Target and remaining are included deliberately. Without them a model has the
 * numbers but not the question — it can tell you what you ate and cannot tell
 * you whether it was enough, which is the only thing anyone asks.
 */
export function dayToText(log: DayLog, target: MacroTarget): string {
  const eaten = dayTotals(log);
  const left = remaining(target, eaten);
  const pct = target.kcal > 0 ? Math.round((eaten.kcal / target.kcal) * 100) : 0;

  const out: string[] = [];
  out.push(`${PERSON_LABEL[log.person]} — ${longDate(log.date)}`);
  out.push(`Target: ${macroLine(target)}`);
  out.push(`Eaten:  ${macroLine(eaten)}  (${pct}% of the calorie target)`);
  // "Left" goes negative when over, and saying OVER in words beats a minus sign
  // that a reader can skim past.
  out.push(
    left.kcal >= 0
      ? `Left:   ${macroLine(left)}`
      : `OVER by: ${macroLine({ kcal: -left.kcal, p: -left.p, c: -left.c, f: -left.f })}`,
  );

  if (log.status === "skipped") {
    out.push("", "This day was marked as skipped — no meals were logged.");
    return out.join("\n");
  }
  if (log.status === "estimated") {
    out.push("", `Estimated day (not itemised)${log.note ? `: ${log.note}` : "."}`);
    if (!log.meals.length) return out.join("\n");
  }

  if (!log.meals.length) {
    out.push("", "No meals logged.");
    return out.join("\n");
  }

  const itemCount = log.meals.reduce((n, m) => n + m.items.length, 0);
  out.push("", `${log.meals.length} meal${log.meals.length === 1 ? "" : "s"}, ${itemCount} item${itemCount === 1 ? "" : "s"}:`);
  for (const [i, meal] of log.meals.entries()) {
    out.push("");
    out.push(mealBlock(meal, i));
  }
  out.push("", FOOTER);
  return out.join("\n");
}

/**
 * Several days at once — for "here's my week, what should I change?".
 *
 * Per-day totals plus an average, without the item detail, because a week of
 * fully itemised meals is thousands of words and the question at that scale is
 * about the pattern, not about Tuesday's yoghurt.
 */
export function daysToText(logs: DayLog[], target: MacroTarget, person: Person): string {
  const kept = logs.filter((l) => l.meals.length || l.status);
  if (!kept.length) return `${PERSON_LABEL[person]} — nothing logged in this range.`;
  const out = [`${PERSON_LABEL[person]} — ${kept.length} day${kept.length === 1 ? "" : "s"}`];
  out.push(`Daily target: ${macroLine(target)}`, "");
  const totals: Macros[] = [];
  for (const l of kept) {
    const m = dayTotals(l);
    totals.push(m);
    const tag = l.status === "skipped" ? " (skipped)" : l.status === "estimated" ? " (estimated)" : "";
    out.push(`${longDate(l.date)}${tag} — ${macroLine(m)}`);
  }
  const sum = sumMacros(totals);
  const n = totals.length;
  out.push(
    "",
    `Average: ${macroLine({ kcal: sum.kcal / n, p: sum.p / n, c: sum.c / n, f: sum.f / n })}`,
  );
  return out.join("\n");
}

/**
 * Put text on the clipboard, and say whether it worked.
 *
 * The async Clipboard API needs a secure context and a real user gesture, and
 * silently rejects otherwise — so the older selection-based path stays as a
 * fallback rather than letting the button do nothing and look broken. Callers
 * must only show "Copied" when this resolves true.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but still focusable — `display:none` cannot be selected, and
    // a visible textarea would flash.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS needs the explicit range
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
