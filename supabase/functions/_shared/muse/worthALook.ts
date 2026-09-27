// "Worth a look", with the merchants and the charge dates taken out.
//
// WHY THIS LAYER EXISTS AT ALL
//
// The engine's own sentences interpolate single charges — "{amount} at {merchant}
// on {date}", "{count} charges of {amount} on {date} in the same account", "The
// last charge, on {date}, was {actual}" — where {merchant} is
// `merchantKey(tx.description)`, i.e. the bank descriptor or something one of them
// typed. Each suggestion also carries `evidence` (the rows themselves) and a `fix`
// descriptor holding raw transaction ids. Handed over as-is, this one READ tool is
// a per-charge feed of merchant, amount and date — which is exactly what
// `finance.search_transactions` is forbidden for. A rule that bans a tool and then
// ships its contents under another name is not a rule.
//
// So NOTHING is passed through. Every field below is built from scratch:
//
//   rule      the engine's own W-code
//   kind      the engine's own kind
//   amount    rounded to the dollar
//   month     the bill CYCLE, never a charge date
//   bill      the recurring row's id — an id, not a name
//   sentence  written HERE, from a fixed template, naming at most a bill row
//
// Never `detail`, never `title`, never `evidence`, never `fix`, never `key` (the
// key carries a merchant for W3 and transaction ids for W5), never a charge date,
// never a merchant string.
//
// TWO RULES CANNOT BE SAID AT ALL. W5a ("two charges of the same amount on the
// same day in the same account") and W7 ("this charge looks like your X bill")
// are both statements about one charge on one day. Stripped of the merchant and
// the date there is no sentence left that identifies anything, so those two come
// back as a rule, a count, and "open the app to see which charge" — which is the
// honest shape, and the same answer the self-audit already gives for the checks
// whose offenders it cannot name.

import type { Suggestion, SuggestionRule } from "./lib/ledgerReview.ts";
import type { AppData } from "./lib/types.ts";
import { monthLabel } from "./lib/format.ts";
import { dollars, scrub } from "./scrub.ts";

/** One thing worth a look, with nothing in it he did not already own. */
export interface RedactedSuggestion {
  rule: SuggestionRule;
  kind: Suggestion["kind"];
  sentence: string;
  /** Rounded to the dollar. Absent on the two rules that come back as a count. */
  amount?: number;
  /** "YYYY-MM" — a bill cycle, never the date of a charge. */
  month?: string;
  /** The recurring row's id. */
  bill?: string;
  /** How many charges the rule fired on, for the two rules that cannot be said. */
  count?: number;
}

/** The two rules whose whole content is one charge on one day. */
const UNSAYABLE: ReadonlySet<SuggestionRule> = new Set<SuggestionRule>(["W5a", "W7"]);

/**
 * How many suggestions go out at most.
 *
 * Every read is capped: it is a privacy control and the only defence available
 * against usage limits Meta has not published. The door does NOT re-order the list
 * to choose which ones survive — the app's sheet sorts biggest-money-first and
 * that ordering belongs to the surface, so this keeps the engine's own order and
 * says how many it left out.
 */
export const MAX_SUGGESTIONS = 24;

/** A sentence per rule, with and without a bill name, because the name is the one
 *  hole in it and a name someone typed does not always survive the scrubber. */
function sentenceFor(rule: SuggestionRule, name: string | null, month: string | null, amount: number | null): string {
  const about = amount == null ? "" : ` — about $${amount}`;
  const inMonth = month ? ` for ${monthLabel(month)}` : "";
  const who = name ?? "A bill";
  switch (rule) {
    case "W1":
      return name
        ? `${name} is set to a different amount than it is really costing${about} a month.`
        : `A bill is set to a different amount than it is really costing${about} a month.`;
    case "W2":
      return `${who} is planned every month, but nothing has been charged for three cycles${about} a month.`;
    case "W3":
      return `Something charged every month${about} is not in your bills at all.`;
    case "W4":
      return `${who} was charged every cycle before this one, and${inMonth} there is nothing${about}.`;
    case "W5b":
      return `${who} may be recorded twice${inMonth}${about}.`;
    case "W6":
      return name
        ? `${name} is set to repeat, but it looks like it only arrived once${about} a month.`
        : `Some income is set to repeat, but it looks like it only arrived once${about} a month.`;
    // The two that cannot be said. Reached only through the grouped path below,
    // which supplies its own sentence — this arm exists so the switch is
    // exhaustive and adding a rule to the engine stops the compiler here.
    case "W5a":
    case "W7":
      return "Open the app to see which charge.";
  }
}

function groupSentence(rule: SuggestionRule, count: number): string {
  const many = count !== 1;
  if (rule === "W5a") {
    return `${count} charge${many ? "s" : ""} may be in the ledger twice. Open the app to see which.`;
  }
  return `${count} charge${many ? "s" : ""} look like bills you already model. Open the app to see which.`;
}

/**
 * The engine's suggestions, redacted.
 *
 * `data` is only read for one thing: the name of a bill row whose id a suggestion
 * already carries. No other field of it reaches the reply.
 */
export function redactSuggestions(
  suggestions: readonly Suggestion[],
  data: AppData,
): { suggestions: RedactedSuggestion[]; total: number; left_out: number } {
  const nameOf = new Map(data.recurring.map((r) => [r.id, r.name]));

  const out: RedactedSuggestion[] = [];
  const grouped = new Map<SuggestionRule, { kind: Suggestion["kind"]; count: number }>();

  for (const s of suggestions) {
    if (UNSAYABLE.has(s.rule)) {
      const g = grouped.get(s.rule) ?? { kind: s.kind, count: 0 };
      g.count += 1;
      grouped.set(s.rule, g);
      continue;
    }
    const billId = s.recurringId ?? s.evidence.recurringId;
    // A name typed in the app. Scrubbed, and dropped rather than sliced when it
    // does not survive — there is a nameless sentence for every rule.
    const name = billId ? scrub(nameOf.get(billId)) : null;
    const month = s.evidence.monthKey ?? null;
    const amount = dollars(s.amount);
    const entry: RedactedSuggestion = {
      rule: s.rule,
      kind: s.kind,
      sentence: sentenceFor(s.rule, name, month, amount),
    };
    if (amount != null) entry.amount = amount;
    if (month) entry.month = month;
    if (billId) entry.bill = billId;
    out.push(entry);
  }

  for (const [rule, g] of grouped) {
    out.push({ rule, kind: g.kind, count: g.count, sentence: groupSentence(rule, g.count) });
  }

  const total = out.length;
  return { suggestions: out.slice(0, MAX_SUGGESTIONS), total, left_out: Math.max(0, total - MAX_SUGGESTIONS) };
}
