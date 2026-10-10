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
// a per-charge feed of merchant, amount and date — assembled by an engine that was
// never written to clean a string, because it was written for a screen.
//
// THIS USED TO SAY "which is exactly what `finance.search_transactions` is forbidden
// for", and that prohibition has since been lifted — he lifted it, deliberately; the
// note under ABSENT in tools.ts records it. So the reason is restated here, because
// the reason never was "charges are secret". A charge going out through
// `finance.search_transactions` goes through `sayCharge`, built key by key, with the
// description SCRUBBED and `raw_description` absent by construction. A charge going
// out through this engine's own sentences goes out as the engine wrote it:
// `merchantKey(tx.description)` is a bank-written string with the store number
// stripped and nothing else done to it, and `evidence` is the row itself.
//
// So this layer is not hiding what the search tool now shows. It is refusing to be a
// SECOND way out for the same data that skips the cleaning the first one does.
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
// Never `detail`, never `title`, never `evidence`, never `fix`, never a charge date,
// never a merchant string — outside `charges`, which has its own note below.
//
// `key` USED TO BE ON THAT LIST, AND CAME OFF IT ON 2026-10-10. The reason it was there
// ("the key carries a merchant for W3 and transaction ids for W5") stopped being a
// reason on 2026-10-02, when `charges` started carrying the cleaned merchant and the
// charge ids for exactly those rules. What it cost to keep it off: nothing could POINT
// at a suggestion. Dismissals lived only in each phone's own storage, the door had no
// way to wave one away, and once the Activity tab is retired nothing anywhere could —
// so every suggestion somebody had already decided about came back on every call.
//
// So each suggestion now carries `key`, and finance.dismiss_suggestion on the write door
// takes it back. It goes out through the same cleaner as everything else, and the rule
// is stricter than for a name: the key is only handed out if scrub() gives it back
// UNCHANGED, character for character, because a key that came back different would be
// stored as a dismissal that matches nothing. A key that would not survive — a merchant
// key with something link- or instruction-shaped in it — goes out as a fixed-shape
// stand-in instead ("h:" and sixteen hex digits, a hash of the real key), which says
// nothing about the charge and still names exactly one suggestion. See suggestionKey.
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
  /** What finance.dismiss_suggestion takes to wave this one away — see suggestionKey.
   *  Absent only on a grouped count, which stands for several suggestions at once. */
  key?: string;
  /** Rounded to the dollar. Absent on the two rules that come back as a count. */
  amount?: number;
  /** "YYYY-MM" — a bill cycle, never the date of a charge. */
  month?: string;
  /** The recurring row's id. */
  bill?: string;
  /** How many charges the rule fired on. */
  count?: number;
  /** The charges the rule is standing on, so the suggestion can be ACTED ON.
   *
   *  WHY THIS IS HERE NOW. These two rules used to come back as a bare count and a
   *  sentence ending "open the app to see which". There is no app — it is being
   *  retired, and Muse is the interface. A suggestion that can say something is
   *  wrong and never what is a dead end, and a dead end in the one rule that catches
   *  unlinked bills is how "what do I still owe" goes wrong again.
   *
   *  Gino's call, 2026-10-02: "Give muse the power."
   *
   *  The cleaned merchant name only, which already leaves this door through
   *  finance.transaction and finance.search_transactions — this makes those two
   *  rules consistent with the tools beside them rather than opening anything new.
   *  `raw_description`, the verbatim bank text, remains forbidden and is still read
   *  by no tool. */
  charges?: { id: string; date: string; amount: number; merchant: string }[];
}

/**
 * Rules held back entirely. Empty, and it stays declared rather than deleted so the
 * next rule that should be withheld has somewhere obvious to go.
 *
 * W5a (a charge that may be in twice) and W7 (a charge that looks like an unlinked
 * bill) used to be in here, because the whole content of each is one charge on one
 * day. They came back as a count and "open the app to see which". The app is being
 * retired, so that instruction now names something that will not exist — and both
 * rules exist to catch the class of error that cost the most this year.
 */
const UNSAYABLE: ReadonlySet<SuggestionRule> = new Set<SuggestionRule>();

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

// ── the key, and dismissing by it ─────────────────────────────────────────────

/** The longest key either door hands out or accepts. The engine's longest real key
 *  is two ids and a month (`unlinked:<bill>:<YYYY-MM>:<charge>`), well under this. */
export const SUGGESTION_KEY_MAX = 200;

/**
 * What a suggestion key looks like on the wire: one of the engine's own kinds and a
 * colon (src/lib/reviewTypes.ts lists the key shapes, spec §B.9), or the hashed
 * stand-in. The write door refuses anything else before it reads a row, so a guess
 * or a half-copied key is a refusal rather than a dismissal that silently matches
 * nothing.
 */
export const SUGGESTION_KEY =
  /^(?:(?:drift|phantom|unmodelled|missing|duplicate|income-landed|unlinked|dangling):\S.*|h:[0-9a-f]{16})$/;

/** FNV-1a, 64-bit, over the key's UTF-8 bytes. Not a secret and not meant to be one:
 *  it only has to name one key, the same way on every call, with no clock and no
 *  randomness — and to say nothing about the charge behind it. */
function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * The key this door hands out for one of the engine's keys.
 *
 * The engine's own key when the cleaner gives it back character for character and it
 * has a known shape — which is every key whose parts are ids, months, amounts and a
 * merchant key with nothing odd in it. Otherwise `h:` and a hash of it, so a merchant
 * key the cleaner would change never leaves the door, and the dismissal still names
 * exactly the suggestion it was handed for.
 */
export function suggestionKey(engineKey: string): string {
  const said = scrub(engineKey, SUGGESTION_KEY_MAX);
  return said === engineKey && SUGGESTION_KEY.test(engineKey) ? engineKey : `h:${fnv1a64(engineKey)}`;
}

/**
 * Has somebody waved this suggestion away? `dismissed` holds what review_dismissals
 * holds: keys exactly as this door handed them out, so either the engine's own key or
 * its stand-in. The engine already drops the first kind when it is handed the set
 * (reviewLedger's own `dismissedKeys`); this is the check for the second, which the
 * engine cannot see because it never made it.
 */
export function isDismissed(engineKey: string, dismissed: ReadonlySet<string>): boolean {
  return dismissed.has(engineKey) || dismissed.has(suggestionKey(engineKey));
}

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
  const byId = new Map(data.transactions.map((t) => [t.id, t]));

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
      key: suggestionKey(s.key),
    };
    if (amount != null) entry.amount = amount;
    if (month) entry.month = month;
    if (billId) entry.bill = billId;
    // The rows behind it, so the suggestion can be acted on rather than only read.
    // Dropped rather than sliced when a name will not scrub — half a merchant name
    // reads as a different merchant, which is Rule 4 and is why there is a fixed
    // sentence instead.
    const charges = s.evidence.txnIds
      .map((id) => byId.get(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({
        id: t.id,
        date: t.date,
        amount: Math.round(t.amount * 100) / 100,
        merchant: scrub(t.description) ?? "(a name I cannot say safely)",
      }));
    if (charges.length) entry.charges = charges;
    out.push(entry);
  }

  for (const [rule, g] of grouped) {
    out.push({ rule, kind: g.kind, count: g.count, sentence: groupSentence(rule, g.count) });
  }

  const total = out.length;
  return { suggestions: out.slice(0, MAX_SUGGESTIONS), total, left_out: Math.max(0, total - MAX_SUGGESTIONS) };
}
