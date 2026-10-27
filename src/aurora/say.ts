// The logic (logic.ts) speaks English sentences, ported word for word from the
// design's reference so its tests pin them. Xinyan reads the app in Chinese, so the
// screens turn each sentence back into a translatable template here — one place,
// matched on the exact shapes logic.ts produces.

import { t } from "../lib/i18n";
import { money0, type Insight } from "./logic";

export function sayPill(text: string): string {
  let m = text.match(/^Under your cushion from (.+)$/);
  if (m) return t("Under your cushion from {date}", { date: m[1] });
  m = text.match(/^Steady until (.+) on (.+)$/);
  if (m) return t("Steady until {name} on {date}", { name: m[1], date: m[2] });
  return t(text);
}

export function sayChange(label: string | null): string | null {
  const m = label?.match(/^(\d+)% (less|more) than last week$/);
  if (!m) return label;
  return m[2] === "less" ? t("{pct}% less than last week", { pct: m[1] }) : t("{pct}% more than last week", { pct: m[1] });
}

/** The insight in words. Built from its numbers, not its English body, and in whole
 *  dollars: the budget lines carry cents, which the reference's sentence would print
 *  as "$44.37 left". */
export function sayInsight(i: Insight): { title: string; body: string } {
  const name = t(i.category);
  const n = i.body.match(/(\d+) days/)?.[1] ?? "";
  return i.left < 0
    ? { title: t("{name} is over plan", { name }), body: t("{amount} over, with {n} days to go.", { amount: money0(-i.left), n }) }
    : {
        title: t("{name} is running ahead", { name }),
        body: t("{amount} left for {n} days, about {per} a day.", { amount: money0(i.left), n, per: money0(i.perDay) }),
      };
}
