// GENERATED — DO NOT EDIT. Source: src/lib/ledgerReview.ts
// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)
//
// Hand-editing this file is the drift the Muse doors exist to prevent: the
// door would answer with one number while every screen in the app showed
// another, in a chat, with no screen beside it to notice. Change src/lib/ledgerReview.ts
// and re-run the generator.
import type { AppData, Cadence, Recurring, Transaction } from "./types.ts";
import { billKey, merchantKey } from "./categorize.ts";
import { formatDate, formatMoney, monthKeyOf, monthLabel } from "./format.ts";
import { addMonths } from "./forecast.ts";
import { getLang, t } from "./i18n.ts";
import { liveOn, monthlyAmount } from "./recurring.ts";
import { DUE_DAYS, billCycleFor, firesInMonth } from "./schedule.ts";
import { cycleKeyOf } from "./selfAudit.ts";

// ── Worth a look ──────────────────────────────────────────────────────────────
//
// THE LINE THIS FILE SITS ON. `selfAudit.ts` answers "does the app disagree with
// ITSELF?" — every check there is exact, must be precisely zero in a healthy app,
// and is therefore never a judgement call. That bar is what earns it the right to
// say "this did not add up."
//
// This file answers a different question: "has the app noticed something about
// your MONEY?" Every number can be self-consistent and the model still be out of
// date — a subscription whose price went up, a bill that quietly ended, a charge
// nobody connected to the bill it pays. None of that is a defect, none of it is
// certain, and every rule here CAN be wrong. So nothing in this file is ever
// called a failure, and nothing here may be rendered beside the self-check panel.
//
// Why it exists: a weekly audit by hand (2026-09-26) found six problems the seven
// exact checks could not see, because each one was a judgement call — a charge
// recorded twice under two different kinds, an expected income that had already
// landed, a real charge missing, bills planned for accounts at $0, amounts that
// had drifted, and a subscription never modelled at all. Gino: "the automatic
// ability of the app to be able to self organize the inputs is important across
// the entire finance mode."
//
// ONE ENGINE, NOT SIX HEURISTICS. Six separate rules would drift apart the way
// the five cycle-key implementations did. All six findings are the same
// operation: line the MODEL (active recurring rows, expanded into cycles) up
// against REALITY (posted ledger rows), then look at what did not pair up.
//
//   paired, amounts agree        -> nothing to say
//   paired, amounts disagree     -> W1  drift
//   left over on the MODEL side  -> W2  phantom  (nothing charged for 3 cycles)
//                                   W4  missing  (this cycle only, after paid ones)
//   left over on the REAL side   -> W3  unmodelled repeat
//                                   W7  a charge that matches a bill you model
//   two real rows, one obligation-> W5  possible duplicate
//   income that fired once only  -> W6  one-off income that landed
//
// TWO NUMBERS ARE BORROWED, NOT INVENTED:
//   · the amount band is the one the bank feed's own bill matcher already uses to
//     decide two amounts are "the same bill" (matchBillByDayAmount,
//     supabase/functions/plaid/index.ts). A charge the app's own matcher would
//     have called the same bill is by definition not worth mentioning.
//   · every date-to-cycle question goes through billCycleFor(), which carries the
//     seven-day grace the feed and the calendar already share.
// And cycle identity comes from cycleKeyOf() in selfAudit.ts — imported, never
// re-spelled. There were already five copies of that rule in this repo.
//
// PURE. No I/O, no React, no store, no Date.now(). The clock is the `now` you
// pass. Nothing here writes: a suggestion carries a machine-readable `fix`
// describing what WOULD change, and the write happens in a tap handler.

/** Which rule fired. `kind` is what the card looks like; this is which test it
 *  came from — useful for an icon, and for a test that names its own threshold. */
export type SuggestionRule = "W1" | "W2" | "W3" | "W4" | "W5a" | "W5b" | "W6" | "W7";

export type SuggestionKind =
  | "drift"
  | "phantom"
  | "unmodelled"
  | "missing"
  | "duplicate"
  | "income-landed"
  | "unlinked";

/** One ledger row the suggestion is standing on. */
export interface EvidenceRow {
  txnId?: string;
  date: string;
  description: string;
  amount: number;
}

/** What the suggestion is based on, in rows and dollars, so the card can show
 *  the user the same thing the engine looked at. */
export interface SuggestionEvidence {
  recurringId?: string;
  /** The bill cycle in question, when the suggestion is about one. */
  monthKey?: string;
  /** The ledger rows behind it — ids the UI can open. */
  txnIds: string[];
  rows: EvidenceRow[];
  /** What the app models, when this compares a model figure against reality. */
  modelled?: number;
  /** What reality shows, when there is a single such figure. */
  observed?: number;
}

/** The proposed change, machine-readable: which action, what field, from what, to
 *  what. Nothing in this file applies one. `label` is the button text, already
 *  through t(); `blockedReason`, when present, means the fix is not safe to offer
 *  yet and the card should say so instead of showing a button. */
export type SuggestionFix =
  | {
      action: "setRecurringAmount";
      recurringId: string;
      field: "amount" | "knownAmount";
      from: number;
      to: number;
      label: string;
      blockedReason?: string;
    }
  | {
      action: "setRecurringActive";
      recurringId: string;
      from: boolean;
      to: boolean;
      label: string;
      blockedReason?: string;
    }
  | {
      action: "setRecurringWindow";
      recurringId: string;
      field: "endsOn";
      from: string | null;
      to: string;
      label: string;
      blockedReason?: string;
    }
  | {
      action: "addRecurring";
      name: string;
      amount: number;
      dueDay: number;
      categoryId: string;
      cadence: "monthly";
      label: string;
      blockedReason?: string;
    }
  | {
      action: "deleteTransaction";
      txnId: string;
      label: string;
      blockedReason?: string;
    }
  | {
      action: "linkTransactionToBill";
      txnId: string;
      recurringId: string;
      monthKey: string;
      day: number;
      installmentIndex: number;
      label: string;
      blockedReason?: string;
    };

export interface Suggestion {
  /** Stable, and it CHANGES when the evidence changes. Dismissing writes this
   *  key; because the evidence is INSIDE the key, a suggestion re-surfaces on its
   *  own when the numbers move and needs no snooze or expiry logic. */
  key: string;
  rule: SuggestionRule;
  kind: SuggestionKind;
  /** The headline, one plain sentence, already through t(). */
  title: string;
  /** What the engine noticed, in dollars and dates, already through t(). It
   *  states what was SEEN and never how likely it is to matter — there is no
   *  confidence figure anywhere in this file, because a number like that would
   *  be invented. The user judges it from the evidence. */
  detail: string;
  /** Dollars this is about, for sorting biggest-first. Not a claim about cash:
   *  drift is the monthly gap, phantom and income-landed are the monthly figure
   *  wrongly planned, unmodelled is the monthly cost nothing plans for, missing
   *  and unlinked are the bill, duplicate is the amount counted twice. */
  amount: number;
  evidence: SuggestionEvidence;
  /** The one-tap fix, or null when only a person can decide. */
  fix: SuggestionFix | null;
  /** Mirrors of the two evidence fields the card needs most often. */
  txnIds?: string[];
  recurringId?: string;
}

// ── shared ground ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Pay up to a week late and it still belongs to that cycle — the same slack
 *  billCycleFor() and the feed use. A cycle is "closed" once even that is past. */
const GRACE_DAYS = 7;
/** W3 and W7 look back this far. The ledger holds about five months; a longer
 *  window would mostly be empty, and a shorter one cannot see three repeats. */
const LOOKBACK_MONTHS = 6;
/** W2 and W4 need three closed cycles, so a year of months is plenty of room. */
const CYCLE_LOOKBACK_MONTHS = 14;
/** Three consecutive silent cycles, for both W2 and W4. One missed cycle is a
 *  late bill; two is a coincidence a real household has (a two-month catch-up
 *  payment empties the cycle before it). Three is a quarter of silence. */
const SILENT_CYCLES = 3;
/** Cadences whose whole schedule lives in due_days, so a cycle can be placed.
 *  Three missed yearly cycles is three years, which is not a suggestion. */
const CYCLE_CADENCES: Cadence[] = ["weekly", "biweekly", "semimonthly", "monthly"];

/** The band inside which two amounts are "the same bill". Lifted verbatim from
 *  matchBillByDayAmount in supabase/functions/plaid/index.ts — the app's own
 *  matcher. Variable bills keep generous slack because their modelled figure is
 *  an estimate by design; a fixed $21.62 subscription cannot absorb $10.59. */
function band(r: Recurring, modelled: number): number {
  return r.variable ? Math.max(15, 0.15 * modelled) : Math.max(2, 0.03 * modelled);
}

/** What the app plans for this row. knownAmount beats the rolling average by
 *  design (see billExpected) and beats the contracted amount here too. */
function modelledOf(r: Recurring): number {
  return r.knownAmount != null ? r.knownAmount : r.amount;
}

/**
 * What the calendar plans for ONE payment of this row.
 *
 * A row with two due days is paid in installments: schedule.ts places
 * `monthly / dueDays.length` on each day, so the row's own figure is the MONTH's
 * total and not one payment. Mom is $300 a month on the 15th and the 30th, which
 * is $150 a payment. Comparing a single charge against the undivided figure is
 * comparing two different quantities.
 *
 * A biweekly row is the exception — it charges its full amount each time — and
 * it is the only exception among the cadences this is used for, because both
 * callers are already gated to CYCLE_CADENCES.
 */
function perChargeOf(r: Recurring, amount: number): number {
  if (r.cadence === "biweekly") return amount;
  const days = dueDaysOf(r).length;
  return days > 1 ? amount / days : amount;
}

const cents = (n: number) => Math.round(n * 100);
const money = (n: number) => formatMoney(n);

/** A posted row. A pending row can vanish or change amount when it posts, so it
 *  is never evidence for or against anything. */
const posted = (tx: Transaction) => !tx.pending;

const isFiniteAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Local midnight of an ISO date, so a cycle's due date compares against `now`
 *  in the same timezone every other window in the app is read in. */
function dayStart(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return NaN;
  return new Date(y, m - 1, d).getTime();
}

function lastDayOf(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  if (!y || !m) return 28;
  return new Date(y, m, 0).getDate();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The clock's own calendar date, LOCAL, the way every other window in the app
 *  reads a date. */
function todayOf(now: Date): string {
  return `${monthKeyOf(now)}-${pad2(now.getDate())}`;
}

/** "1st", "2nd", "17th" — bills are spoken about by their due day. */
function ordinal(day: number): string {
  // Chinese says the day as a bare number in front of its own marker, so both ZH
  // templates read "{day} 号" — an English suffix wedged in there is a typo on
  // Xinyan's phone: "每月 23rd 号到期".
  if (getLang() === "zh") return String(day);
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** The due day(s) the app keys this row's cycles on: the row's own, falling back
 *  to the legacy name map the calendar still falls back to. */
function dueDaysOf(r: Recurring): number[] {
  const days = r.dueDays && r.dueDays.length ? r.dueDays : DUE_DAYS[r.name];
  return days && days.length ? [...days].sort((a, b) => a - b) : [];
}

/** Which installment slot a due day is, in the row's sorted due days. Read back
 *  out of cycleKeyOf rather than re-derived, so this file cannot become a sixth
 *  spelling of the day-to-ordinal rule. */
function installmentIndexOf(r: Recurring, day: number): number {
  const key = cycleKeyOf({ recurringId: r.id, monthKey: "x", day }, dueDaysOf(r));
  return Number(key.split("|")[2]) || 0;
}

function cycleKeyFor(r: Recurring, monthKey: string, day: number): string {
  return cycleKeyOf({ recurringId: r.id, monthKey, day }, dueDaysOf(r));
}

interface Cycle {
  monthKey: string;
  day: number;
  /** ISO date the cycle is due, day clamped to the month's length. */
  due: string;
  key: string;
}

/**
 * The row's closed cycles, newest first. Three gates, all load-bearing:
 *   · the cycle must be inside the row's startsOn/endsOn window (liveOn);
 *   · it must be due before the row was CREATED plus nothing — a cycle that
 *     closed before createdAt is not evidence against the row. Without this
 *     gate, a subscription added today is accused of three missed cycles it
 *     could not have had;
 *   · it must be closed: due date plus the seven-day grace is in the past.
 */
function closedCycles(r: Recurring, now: Date): Cycle[] {
  const days = dueDaysOf(r);
  if (!days.length) return [];
  const createdDay = typeof r.createdAt === "string" ? r.createdAt.slice(0, 10) : "";
  const nowMs = now.getTime();
  const out: Cycle[] = [];
  const thisMonth = monthKeyOf(now);
  for (let back = 0; back <= CYCLE_LOOKBACK_MONTHS; back++) {
    const monthKey = addMonths(thisMonth, -back);
    if (!firesInMonth(r, monthKey)) continue;
    const dim = lastDayOf(monthKey);
    for (const raw of days) {
      const day = Math.min(raw, dim);
      const due = `${monthKey}-${pad2(day)}`;
      if (createdDay && due < createdDay) continue;
      if (!liveOn(r, due)) continue;
      const dueMs = dayStart(due);
      if (!Number.isFinite(dueMs)) continue;
      if (dueMs + GRACE_DAYS * DAY_MS >= nowMs) continue; // still open
      out.push({ monthKey, day, due, key: cycleKeyFor(r, monthKey, day) });
    }
  }
  out.sort((a, b) => (a.due < b.due ? 1 : a.due > b.due ? -1 : 0));
  return out;
}

/** Every posted charge that CLAIMS a bill cycle, grouped by cycle key. This is
 *  the app's own record of "this cycle is settled", read the way selfAudit reads
 *  it, so a suggestion and a check can never disagree about whether a cycle is
 *  paid. */
function chargesByCycle(data: AppData): Map<string, Transaction[]> {
  const byId = new Map(data.recurring.map((r) => [r.id, r]));
  const out = new Map<string, Transaction[]>();
  for (const tx of data.transactions) {
    const at = tx.appliesTo;
    if (tx.type !== "expense" || at?.kind !== "bill" || !at.recurringId) continue;
    if (!posted(tx)) continue;
    const rec = byId.get(at.recurringId);
    const key = cycleKeyOf(at, rec ? dueDaysOf(rec) : undefined);
    const list = out.get(key);
    if (list) list.push(tx);
    else out.set(key, [tx]);
  }
  return out;
}

/** Most recent first, with the same tiebreak billExpected uses so "the last
 *  charge" means the same thing on both paths. */
function newestFirst(rows: Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const am = a.appliesTo?.monthKey ?? "";
    const bm = b.appliesTo?.monthKey ?? "";
    if (am !== bm) return am < bm ? 1 : -1;
    const ad = a.appliesTo?.day ?? 0;
    const bd = b.appliesTo?.day ?? 0;
    if (ad !== bd) return bd - ad;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The most frequent value, ties broken by the first one seen, so the engine is
 *  deterministic on the same input. */
function mode<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function rowOf(tx: Transaction): EvidenceRow {
  return { txnId: tx.id, date: tx.date, description: tx.description, amount: tx.amount };
}

/** The month keys of the lookback window, oldest first. */
function windowMonths(now: Date): string[] {
  const thisMonth = monthKeyOf(now);
  const keys: string[] = [];
  for (let i = LOOKBACK_MONTHS - 1; i >= 0; i--) keys.push(addMonths(thisMonth, -i));
  return keys;
}

function monthList(keys: string[]): string {
  return keys.map((k) => monthLabel(k)).join(", ");
}

// ── the entry point ───────────────────────────────────────────────────────────

/**
 * Everything the app noticed about this ledger, biggest money first.
 *
 * Pure. Hand it the data, a clock, and the keys the user has already dismissed;
 * it returns text and `fix` descriptors and touches nothing. A ledger with no
 * history yields no suggestions rather than throwing — odd, missing and partial
 * data is the normal state of a household ledger mid-sync.
 */
export function reviewLedger(
  data: AppData,
  now: Date = new Date(),
  dismissedKeys: Iterable<string> = [],
): Suggestion[] {
  const safe: AppData = {
    ...data,
    transactions: Array.isArray(data?.transactions) ? data.transactions.filter(Boolean) : [],
    recurring: Array.isArray(data?.recurring) ? data.recurring.filter(Boolean) : [],
    debts: Array.isArray(data?.debts) ? data.debts.filter(Boolean) : [],
  };
  const clock = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();

  const cycles = chargesByCycle(safe);
  const out: Suggestion[] = [];

  // W7 runs first: a matching charge is the best explanation for a cycle that
  // looks unpaid, so W2 and W4 stand down where W7 has something to link. Two
  // cards about one cycle is noise, and the linkable one is strictly more useful.
  const unlinked = reviewUnlinked(safe, clock, cycles);
  out.push(...unlinked);
  const explained = new Set(
    unlinked.map((s) => `${s.evidence.recurringId}|${s.evidence.monthKey}`),
  );

  out.push(...reviewDrift(safe, clock));
  out.push(...reviewPhantomAndMissing(safe, clock, cycles, explained));
  out.push(...reviewUnmodelled(safe, clock));
  out.push(...reviewDuplicates(safe, cycles));
  out.push(...reviewIncomeLanded(safe, clock));

  const dismissed = new Set(dismissedKeys);
  return out
    .filter((s) => !dismissed.has(s.key))
    .sort((a, b) => (b.amount - a.amount) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Every English source string this file can emit, so the Chinese file can be
 *  checked for coverage and nothing ships untranslated by accident. */
export const REVIEW_STRINGS: string[] = [
  // W1
  "{name}'s last charge was more than the app expects",
  "{name}'s last charge was less than the app expects",
  "The app plans {modelled} a month. The last charge, on {date}, was {actual} — {gap} more.",
  "The app plans {modelled} a month. The last charge, on {date}, was {actual} — {gap} less.",
  "Use {amount} from now on",
  // W2
  "{name} may be finished",
  "The app still plans {monthly} a month for {name}, and nothing has been charged for it in {months}. That is {total} of planned money that is not leaving.",
  "Turn this bill off",
  // W3
  "{name} looks like a monthly subscription",
  "A repeat charge looks like a monthly subscription",
  "{amount} charged in {months}, always the same amount. It is not in your bills, so nothing plans for it.",
  "{amount} at {name}, charged in {months}, always the same amount. It is not in your bills, so nothing plans for it.",
  "Add it as a monthly bill",
  "Give it a category first",
  // W4
  "{name} has not been charged for {month}",
  "{name} is {amount}, due on the {day}. It was charged in {months}, and for {month} nothing matches it. Either it has not gone out yet or the charge is not in the app.",
  // W5a
  "This charge may be in twice",
  "This deposit may be in twice",
  "Two charges of {amount} on {date} in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra.",
  "Two deposits of {amount} on {date} in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra.",
  "{count} charges of {amount} on {date} in the same account — {bank} from the bank, {manual} entered by hand. If they are the same money, the hand-entered one is the extra.",
  "Remove the hand-entered one",
  // W5b
  "{name} may be recorded twice for {month}",
  "You marked {name} paid by hand for {month} at {manual}. The bank also shows a {bank} charge on {date} that went against the {debt} balance. If they are the same payment, {month} is counting {manual} twice.",
  // W6
  "{name} looks like it already came in",
  "The app expects {monthly} a month. One deposit of {actual} arrived on {date} and nothing like it before. If that was a one-off, the app is counting it every month from here.",
  "It was one-off — stop expecting it",
  // W7
  "This charge looks like your {name} bill for {month}",
  "{amount} at {merchant} on {date}. Your {name} bill is {modelled}, due on the {day}, and {month} is still showing as unpaid. Right now this is counted as ordinary spending as well as a bill still to come.",
  "Yes, that is the bill",
];

// ── W1 — amount drift ─────────────────────────────────────────────────────────
/**
 * The app thinks this bill is one amount; the last charge was another.
 *
 * THRESHOLD: band() and nothing else. In particular NO averaging — the
 * comparison is against the single most recent charge. The live data proves the
 * mean is wrong here: Spotify's last four charges were 14.04, 14.04, 14.04,
 * 27.00, so a mean of the last three ($18.36) would keep insisting the correct
 * $27.00 is wrong for two more months. The last charge is a fact about what the
 * biller now charges; the mean is a guess about the future.
 *
 * EXCLUDED, and each exclusion is load-bearing:
 *   · a debt-linked row — you CHOOSE a card payment, it is not billed to you. On
 *     the live ledger this exclusion alone is the difference between silence and
 *     a false "Card payment now charges more" (modelled $129, last paid $300).
 *   · a variable row with no knownAmount — that figure IS the average of actuals,
 *     so comparing it against an actual compares it against itself.
 *   · a row billed in INSTALLMENTS — see the gate below. The calendar divides the
 *     row's figure across its due days, so one charge and that figure are
 *     different quantities, and the rule was both false-positive and blind there.
 *
 * CAN BE WRONG: it fires on the first divergent charge, so a late fee rolled in,
 * or a two-month catch-up payment, reads as a new price. That is the deliberate
 * trade — the cost of being wrong is one dismissal, the cost of missing it is a
 * wrong forecast for months.
 */
function reviewDrift(data: AppData, now: Date): Suggestion[] {
  const today = todayOf(now);
  const out: Suggestion[] = [];
  for (const r of data.recurring) {
    if (!r.active || r.direction !== "out") continue;
    if (r.linkedDebtId) continue;
    if (r.variable && r.knownAmount == null) continue;
    if (!liveOn(r, today)) continue;
    // Billed in installments: the calendar divides this row's figure by its
    // due-day count (schedule.ts:187), so one charge is not comparable to it. A
    // perfectly correct $600-a-month Mom, paid $300 on the 15th and $300 on the
    // 30th, read as the price having HALVED — and the one-tap fix offered to write
    // the halved figure into the plan. Nothing models the per-payment price, so
    // there is nothing honest for this rule to compare against on such a row.
    if (dueDaysOf(r).length > 1) continue;
    const modelled = modelledOf(r);
    if (!isFiniteAmount(modelled) || modelled <= 0) continue;

    const linked = data.transactions.filter(
      (tx) =>
        tx.type === "expense" &&
        posted(tx) &&
        tx.appliesTo?.kind === "bill" &&
        tx.appliesTo.recurringId === r.id &&
        isFiniteAmount(tx.amount),
    );
    if (!linked.length) continue;
    const last = newestFirst(linked)[0];
    const gap = Math.abs(last.amount - modelled);
    if (gap <= band(r, modelled)) continue;

    const higher = last.amount > modelled;
    out.push({
      key: `drift:${r.id}:${cents(last.amount)}`,
      rule: "W1",
      kind: "drift",
      // What was SEEN, not a claim about the biller. This rule fires on the first
      // divergent charge, so a late fee rolled in or a two-month catch-up payment
      // reads as a new price — the detail line has always been careful about that
      // and the headline was not, and the headline is what he reads first.
      title: t(
        higher
          ? "{name}'s last charge was more than the app expects"
          : "{name}'s last charge was less than the app expects",
        { name: r.name },
      ),
      detail: t(
        higher
          ? "The app plans {modelled} a month. The last charge, on {date}, was {actual} — {gap} more."
          : "The app plans {modelled} a month. The last charge, on {date}, was {actual} — {gap} less.",
        {
          modelled: money(modelled),
          date: formatDate(last.date),
          actual: money(last.amount),
          gap: money(gap),
        },
      ),
      amount: gap,
      evidence: {
        recurringId: r.id,
        monthKey: last.appliesTo?.monthKey,
        txnIds: [last.id],
        rows: [rowOf(last)],
        modelled,
        observed: last.amount,
      },
      fix: {
        action: "setRecurringAmount",
        recurringId: r.id,
        field: r.variable ? "knownAmount" : "amount",
        from: modelled,
        to: last.amount,
        label: t("Use {amount} from now on", { amount: money(last.amount) }),
      },
      txnIds: [last.id],
      recurringId: r.id,
    });
  }
  return out;
}

// ── W2 / W4 — the model side of the pairing ───────────────────────────────────
/**
 * W2 (phantom): the app plans for this bill every cycle and nothing has been
 * charged for THREE closed cycles. W4 (missing): the newest closed cycle is
 * empty and the two before it were both paid.
 *
 * They share one cycle list and can never both fire on one row: W2 says the bill
 * is over, W4 says this one is late or its charge is not in the app.
 *
 * THRESHOLD: three MONTHS, for both. One missed month is a late bill; two is a
 * coincidence a household really has (a two-month catch-up payment empties the
 * month before it). Three consecutive misses is a quarter of silence — long enough
 * that "this bill no longer exists" is the better explanation, and short enough to
 * catch a cancelled subscription before it has distorted a full forecast cycle. W4
 * additionally needs two clean months behind the empty one, which is what
 * separates "reliable bill, this month broke the pattern" from "erratic bill".
 *
 * THE UNIT IS THE MONTH, not the cycle, and that is the whole reason the grouping
 * below exists. Both rules write their sentence and their dollar total in months —
 * "nothing has been charged in July, August and September, that is $900 of planned
 * money". On a row with two due days, three CYCLES span six weeks: the month list
 * named August twice and the total claimed three months of money for a month and a
 * half. Counting months is also what this threshold has always said it counted.
 *
 * A CLEARED debt-linked row is skipped: the calendar already drops a card payment
 * once its balance hits zero, and it brings the row back on its own when the card
 * is used again, so there is nothing to suggest and a card paid off is exactly
 * when a phantom warning would train the user to ignore the panel.
 *
 * CAN BE WRONG: a bill paid outside the app for three cycles, or a bill whose
 * real charges exist but were never LINKED. This looks at links, not at cash, so
 * an unlinked charge reads as no charge — which is why W7 runs first and silences
 * both of these wherever it found a charge to offer.
 */
function reviewPhantomAndMissing(
  data: AppData,
  now: Date,
  cycles: Map<string, Transaction[]>,
  explained: Set<string>,
): Suggestion[] {
  const today = todayOf(now);
  const out: Suggestion[] = [];
  for (const r of data.recurring) {
    if (!r.active || r.direction !== "out") continue;
    if (!CYCLE_CADENCES.includes(r.cadence)) continue;
    // A row whose endsOn has passed is planned for no future month, so there is
    // nothing to turn off and nothing missing. A bill that legitimately ended
    // must stay silent, or the panel nags about every finished subscription for
    // the rest of the ledger's life.
    if (!liveOn(r, today)) continue;
    if (r.linkedDebtId) {
      const debt = data.debts.find((d) => d.id === r.linkedDebtId);
      if (!debt || debt.balance <= 0) continue;
    }
    const monthly = monthlyAmount(r);
    if (!isFiniteAmount(monthly) || monthly <= 0) continue;

    // Closed cycles, folded into the months they fall in, newest month first. A
    // month counts as paid when any of its closed cycles was paid.
    const byMonth: { monthKey: string; cycles: Cycle[] }[] = [];
    for (const c of closedCycles(r, now)) {
      const held = byMonth[byMonth.length - 1];
      if (held && held.monthKey === c.monthKey) held.cycles.push(c);
      else byMonth.push({ monthKey: c.monthKey, cycles: [c] });
    }
    const list = byMonth.slice(0, SILENT_CYCLES);
    if (list.length < SILENT_CYCLES) continue;
    const paid = list.map((m) => m.cycles.some((c) => (cycles.get(c.key)?.length ?? 0) > 0));

    if (!paid.some(Boolean)) {
      if (list.some((m) => explained.has(`${r.id}|${m.monthKey}`))) continue;
      const months = [...list].reverse().map((m) => m.monthKey);
      const total = monthly * SILENT_CYCLES;
      out.push({
        key: `phantom:${r.id}:${list[0].monthKey}`,
        rule: "W2",
        kind: "phantom",
        title: t("{name} may be finished", { name: r.name }),
        detail: t(
          "The app still plans {monthly} a month for {name}, and nothing has been charged for it in {months}. That is {total} of planned money that is not leaving.",
          { monthly: money(monthly), name: r.name, months: monthList(months), total: money(total) },
        ),
        amount: monthly,
        evidence: {
          recurringId: r.id,
          monthKey: list[0].monthKey,
          txnIds: [],
          rows: [],
          modelled: monthly,
          observed: 0,
        },
        // Never a delete. Deleting a recurring row is what left $165 of charges
        // pointing at nothing on the live ledger; turning it off keeps the
        // history and lets the row be switched back on in one tap.
        fix: {
          action: "setRecurringActive",
          recurringId: r.id,
          from: true,
          to: false,
          label: t("Turn this bill off"),
        },
        txnIds: [],
        recurringId: r.id,
      });
      continue;
    }

    if (!paid[0] && paid[1] && paid[2]) {
      // The newest closed cycle of the silent month — the payment the sentence
      // names a due day and a price for.
      const newest = list[0].cycles[0];
      if (explained.has(`${r.id}|${newest.monthKey}`)) continue;
      // The price of THAT payment, not of the whole month. A row paid on the 15th
      // and the 30th is half its monthly figure each time, so naming the monthly
      // figure beside one due day states a price the app does not plan.
      const modelled = perChargeOf(r, modelledOf(r));
      const paidMonths = [list[2].monthKey, list[1].monthKey];
      out.push({
        key: `missing:${r.id}:${newest.monthKey}:${installmentIndexOf(r, newest.day)}`,
        rule: "W4",
        kind: "missing",
        title: t("{name} has not been charged for {month}", {
          name: r.name,
          month: monthLabel(newest.monthKey),
        }),
        detail: t(
          "{name} is {amount}, due on the {day}. It was charged in {months}, and for {month} nothing matches it. Either it has not gone out yet or the charge is not in the app.",
          {
            name: r.name,
            amount: money(modelled),
            day: ordinal(newest.day),
            months: monthList(paidMonths),
            month: monthLabel(newest.monthKey),
          },
        ),
        amount: isFiniteAmount(modelled) && modelled > 0 ? modelled : monthly,
        evidence: {
          recurringId: r.id,
          monthKey: newest.monthKey,
          txnIds: [],
          rows: [],
          modelled,
        },
        // No fix. The two possible repairs both write money — "record it as paid"
        // or "link a charge to it" — and neither may run without a person looking
        // at the bill. The card opens the bill instead.
        fix: null,
        txnIds: [],
        recurringId: r.id,
      });
    }
  }
  return out;
}

// ── W3 — unmodelled repeat ────────────────────────────────────────────────────
/**
 * The same charge has landed every month for three months and the app does not
 * know about it.
 *
 * THRESHOLDS, and the obvious rule is useless without them. "Same merchant in 3
 * of 6 months" fires on Safeway, Circle K, Chipotle, Sam's Club, QuikTrip and
 * Amazon on this ledger. The discriminating fact about a subscription is not how
 * often you buy there, it is that THE AMOUNT NEVER CHANGES. So:
 *   · three distinct months, because two is a coincidence;
 *   · at most months+1 charges — about one a month, which rejects a habit (38
 *     Sam's Club charges in four months);
 *   · every amount inside max($2, 3%) of the median, which rejects variety (14
 *     Chipotle charges, only 10 of them in band).
 * Six-month window because the ledger holds about five months.
 *
 * CAN BE WRONG, and a limitation worth stating plainly: any perfectly regular
 * non-subscription — the same $45 haircut on the same day each month — reads as a
 * subscription. And this rule would NOT have caught Grok, the case it was written
 * for: the three real charges were "Grok Xai $30.00", "Grok Xai $16.00" and
 * "Grok Ai $29.99" — two merchant keys and three amounts. No honest rule catches
 * that from history alone. W7 catches that shape from the other side, the moment
 * a row exists.
 */
function reviewUnmodelled(data: AppData, now: Date): Suggestion[] {
  const months = windowMonths(now);
  const from = `${months[0]}-01`;
  const groups = new Map<string, Transaction[]>();
  for (const tx of data.transactions) {
    if (tx.type !== "expense" || tx.appliesTo || tx.recordOnly) continue;
    if (!posted(tx) || !isFiniteAmount(tx.amount) || tx.amount <= 0) continue;
    if (!tx.date || tx.date < from) continue;
    const key = merchantKey(tx.description ?? "");
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(tx);
    else groups.set(key, [tx]);
  }

  const modelledKeys = new Set<string>();
  for (const r of data.recurring) {
    if (!r.active || r.direction !== "out") continue;
    modelledKeys.add(merchantKey(r.name));
    modelledKeys.add(billKey(r.name));
  }

  const out: Suggestion[] = [];
  for (const [key, rows] of groups) {
    const monthKeys = [...new Set(rows.map((tx) => tx.date.slice(0, 7)))].sort();
    if (monthKeys.length < 3) continue;
    if (rows.length > monthKeys.length + 1) continue; // a habit, not a subscription
    const med = median(rows.map((tx) => tx.amount));
    if (!(med > 0)) continue;
    const tol = Math.max(2, 0.03 * med);
    if (rows.some((tx) => Math.abs(tx.amount - med) > tol)) continue;
    if (modelledKeys.has(key) || modelledKeys.has(billKey(key))) continue;
    // merchantKey strips the trailing digits and the date, which collapses
    // "CHECKCARD 0921 TC @ TSMC ARIZONA 199 PHOENIX AZ" and
    // "PURCHASE 405 Howard St San Francisco CA ON 09/22" to one bare word — so
    // three unrelated merchants can land in one group and be reported as one
    // subscription. On the live ledger the key CHECKCARD holds a cafeteria charge,
    // a service charge and an MVD fee, in three different months. A subscription
    // bills under the same TEXT every month, so require that too.
    const shapes = new Set(
      rows.map((tx) => billKey((tx.description ?? "").replace(/[0-9]/g, ""))),
    );
    if (shapes.size > 1) continue;

    // The SHORTEST descriptor is the merchant; the long ones carry the terminal id
    // and the date. This name is both the headline AND what the fix writes into
    // recurring.name, and W7 matches on exact normalized name equality — so a
    // descriptor carrying digits that change every month would create a bill row no
    // future charge could ever match, and W2 would call it a phantom three months
    // later.
    const name =
      [...rows]
        .map((tx) => (tx.description ?? "").trim())
        .filter(Boolean)
        .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0] ?? key;
    // Even the shortest can be long. A headline that wraps to three lines on a
    // phone squeezes the amount off the end of the first, so a long name moves into
    // the evidence line — the same call reviewEngine.ts makes for a bank descriptor.
    const longName = name.length > 24;
    const dueDay = mode(rows.map((tx) => Number(tx.date.slice(8, 10)))) ?? 1;
    const categoryId = mode(rows.map((tx) => tx.categoryId || "other")) ?? "other";
    const ordered = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out.push({
      key: `unmodelled:${key}:${cents(med)}`,
      rule: "W3",
      kind: "unmodelled",
      title: longName
        ? t("A repeat charge looks like a monthly subscription")
        : t("{name} looks like a monthly subscription", { name }),
      detail: longName
        ? t(
            "{amount} at {name}, charged in {months}, always the same amount. It is not in your bills, so nothing plans for it.",
            { amount: money(med), name, months: monthList(monthKeys) },
          )
        : t(
            "{amount} charged in {months}, always the same amount. It is not in your bills, so nothing plans for it.",
            { amount: money(med), months: monthList(monthKeys) },
          ),
      amount: med,
      evidence: { txnIds: ordered.map((tx) => tx.id), rows: ordered.map(rowOf), observed: med },
      // The only fix that CREATES a model row, so it is the one that most needs
      // the tap: a wrong bill row silently distorts firepower. It writes no
      // merchant rule and links no charge — the existing charges come back as W7
      // suggestions, one cycle at a time.
      fix: {
        action: "addRecurring",
        name,
        amount: med,
        dueDay,
        categoryId,
        cadence: "monthly",
        label: t("Add it as a monthly bill"),
        // A bill row landing in an ungraded category is the `utilities` defect
        // the orphan-category check exists to catch, so it cannot be one tap.
        ...(categoryId === "other" ? { blockedReason: t("Give it a category first") } : {}),
      },
      txnIds: ordered.map((tx) => tx.id),
    });
  }
  return out;
}

// ── W5 — possible duplicate ───────────────────────────────────────────────────
/**
 * Two shapes. Both are the Cherry case from the hand audit; only the second one
 * would have caught it.
 *
 * W5a — the same charge entered twice. Same account, same date, same amount, same
 * type, and the group MIXES a hand-entered row with a bank row. Every one of
 * those conditions is load-bearing: drop the account or the mixed provenance and
 * six real repeated charges on this ledger turn up as false duplicates — an ATM
 * withdrawal twice on one day, the same $6 parking twice, a $9.99 credit
 * adjustment six times. Same day, same amount, same merchant is a normal thing
 * for a real bank feed to contain. No threshold: exact date, exact amount, exact
 * account. It is a suggestion rather than a check only because a person genuinely
 * can buy the same coffee twice in a day and also type one of them in.
 *
 * W5b — the same OBLIGATION claimed twice, which is the real Cherry shape. A
 * hand-written "already paid" marker means, in the type's own words, "already
 * paid, already in my anchored balance" — a stand-in for a bank row the app
 * cannot see. When the bank row arrives and claims the DEBT while the marker
 * claims the BILL, no rule is broken and the same money is in the ledger twice.
 * Two judgement-shaped pieces are what keep this out of selfAudit: the amount
 * match (two equal payments to one instalment loan in a cycle is unusual, not
 * impossible) and the seven-day cycle window. Both are said out loud in the
 * wording so the user can judge them.
 *
 * NEVER offers to delete the bank row. Plaid re-delivers it on the next cursor
 * page, and deleting real bank history is the one action here that destroys data
 * the app cannot rebuild.
 */
function reviewDuplicates(data: AppData, cycles: Map<string, Transaction[]>): Suggestion[] {
  const out: Suggestion[] = [];

  // W5a
  const sameCharge = new Map<string, Transaction[]>();
  for (const tx of data.transactions) {
    if (!posted(tx) || !tx.accountId || !tx.date || !isFiniteAmount(tx.amount)) continue;
    // An imported statement row carries an accountId and no provider, so it reads
    // as "entered by hand" — and applyFix refuses every record-only delete, so the
    // card's only button could never succeed. Import a statement for an account
    // that is also bank-linked and every row present in both produced a duplicate
    // card with a button that can only refuse. W3 and W7 skip these for the same
    // reason: money that moved outside the app is not the app's to undo.
    if (tx.recordOnly) continue;
    const key = `${tx.accountId}|${tx.date}|${cents(tx.amount)}|${tx.type}`;
    const list = sameCharge.get(key);
    if (list) list.push(tx);
    else sameCharge.set(key, [tx]);
  }
  for (const rows of sameCharge.values()) {
    if (rows.length < 2) continue;
    const bank = rows.filter((tx) => tx.provider);
    const manual = rows.filter((tx) => !tx.provider);
    if (!bank.length || !manual.length) continue;
    const ids = rows.map((tx) => tx.id).sort();
    const first = rows[0];
    // The group key carries the type, so every row here is the same kind of money.
    // A hand-entered deposit sitting beside the bank's copy of it — the
    // double-counted-income shape from the hand audit — must not be called a charge.
    const deposit = first.type === "income";
    // The pair is the only shape the fix ever fires on, so it gets the sentence a
    // person would say. Bare digits go back to counting only when there are more.
    const pair = rows.length === 2;
    out.push({
      key: `duplicate:${ids.join(":")}`,
      rule: "W5a",
      kind: "duplicate",
      title: deposit ? t("This deposit may be in twice") : t("This charge may be in twice"),
      detail: pair
        ? t(
            deposit
              ? "Two deposits of {amount} on {date} in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra."
              : "Two charges of {amount} on {date} in the same account — one from the bank, one entered by hand. If they are the same money, the hand-entered one is the extra.",
            { amount: money(first.amount), date: formatDate(first.date) },
          )
        : t(
            "{count} charges of {amount} on {date} in the same account — {bank} from the bank, {manual} entered by hand. If they are the same money, the hand-entered one is the extra.",
            {
              count: rows.length,
              amount: money(first.amount),
              date: formatDate(first.date),
              bank: bank.length,
              manual: manual.length,
            },
          ),
      amount: first.amount,
      evidence: { txnIds: ids, rows: rows.map(rowOf), observed: first.amount },
      // Only ever the hand-entered row, and only when there is exactly one of
      // them — two manual rows means the engine cannot tell which is the extra.
      fix:
        manual.length === 1
          ? {
              action: "deleteTransaction",
              txnId: manual[0].id,
              label: t("Remove the hand-entered one"),
            }
          : null,
      txnIds: ids,
    });
  }

  // W5b
  const byId = new Map(data.recurring.map((r) => [r.id, r]));
  for (const marker of data.transactions) {
    const at = marker.appliesTo;
    if (!posted(marker) || marker.provider || marker.accountId) continue;
    if (at?.kind !== "bill" || at.settled !== true || !at.recurringId) continue;
    const r = byId.get(at.recurringId);
    if (!r || !r.linkedDebtId) continue;
    if (!isFiniteAmount(marker.amount) || marker.amount <= 0) continue;
    const markerKey = cycleKeyOf(at, dueDaysOf(r));
    // More than one row on this cycle is already an exact CHECK failure
    // (one-payment-per-cycle). Not this file's business.
    if ((cycles.get(markerKey)?.length ?? 0) > 1) continue;
    const tol = band(r, modelledOf(r) > 0 ? modelledOf(r) : marker.amount);

    for (const bankRow of data.transactions) {
      if (!posted(bankRow) || !bankRow.provider) continue;
      if (bankRow.appliesTo?.debtId !== r.linkedDebtId) continue;
      if (!isFiniteAmount(bankRow.amount)) continue;
      if (Math.abs(bankRow.amount - marker.amount) > tol) continue;
      const cycle = billCycleFor(dueDaysOf(r), bankRow.date);
      if (cycleKeyFor(r, cycle.monthKey, cycle.day) !== markerKey) continue;

      const debt = data.debts.find((d) => d.id === r.linkedDebtId);
      const ids = [marker.id, bankRow.id].sort();
      const monthName = monthLabel(at.monthKey ?? cycle.monthKey);
      out.push({
        key: `duplicate:${ids.join(":")}`,
        rule: "W5b",
        kind: "duplicate",
        title: t("{name} may be recorded twice for {month}", { name: r.name, month: monthName }),
        detail: t(
          "You marked {name} paid by hand for {month} at {manual}. The bank also shows a {bank} charge on {date} that went against the {debt} balance. If they are the same payment, {month} is counting {manual} twice.",
          {
            name: r.name,
            month: monthName,
            manual: money(marker.amount),
            bank: money(bankRow.amount),
            date: formatDate(bankRow.date),
            debt: debt?.name ?? r.name,
          },
        ),
        amount: marker.amount,
        evidence: {
          recurringId: r.id,
          monthKey: at.monthKey ?? cycle.monthKey,
          txnIds: ids,
          rows: [rowOf(marker), rowOf(bankRow)],
          modelled: marker.amount,
          observed: bankRow.amount,
        },
        // Safe: a hand marker has no accountId, so reversing it moves no cash.
        fix: {
          action: "deleteTransaction",
          txnId: marker.id,
          label: t("Remove the hand-entered one"),
        },
        txnIds: ids,
        recurringId: r.id,
      });
      break;
    }
  }

  return out;
}

// ── W6 — one-off income that has landed ───────────────────────────────────────
/**
 * You told the app to expect this money every month. It looks like it arrived
 * once.
 *
 * THRESHOLDS. A recurring row's income `amount` is the PER-ARRIVAL figure (a
 * semimonthly $1,400 row models $2,800 a month), so it is compared straight
 * against deposits. The band is the variable one, 15%, because a check is never
 * the round number you were told — the real deposit for a "$1,100 a month"
 * expectation was $1,137.20, 3.4% out, and a real paycheck varies by hours.
 * Exactly one matching month is the whole discriminator: real recurring income
 * matches in many months, a one-off mislabelled as recurring matches in one. Two
 * months of age so a genuinely new paycheck is not accused in its first month.
 *
 * CAN BE WRONG: a new recurring income in its second month, or an income whose
 * amount changed enough that the older arrivals fall outside the band.
 */
function reviewIncomeLanded(data: AppData, now: Date): Suggestion[] {
  const out: Suggestion[] = [];
  const twoMonthsAgo = `${addMonths(monthKeyOf(now), -2)}-${pad2(now.getDate())}`;
  for (const r of data.recurring) {
    if (!r.active || r.direction !== "in") continue;
    // Only income that arrives at least monthly. The whole discriminator below is
    // "matched in exactly ONE month", and for a quarterly, semiannual or yearly row
    // that is the EXPECTED state, not evidence of a one-off: a correct yearly tax
    // refund read as an expectation to end, and the fix would have ended it. W2 and
    // W4 gate on the same list for the same reason.
    if (!CYCLE_CADENCES.includes(r.cadence)) continue;
    // An income row that already carries an end date has been judged — either by
    // the user or by this suggestion's own fix. Asking again would make the fix
    // look like it did nothing.
    if (r.endsOn) continue;
    if (!isFiniteAmount(r.amount) || r.amount <= 0) continue;
    const created = typeof r.createdAt === "string" ? r.createdAt.slice(0, 10) : "";
    if (!created || created > twoMonthsAgo) continue; // too new to judge

    const tol = Math.max(15, 0.15 * r.amount);
    const matches = data.transactions.filter(
      (tx) =>
        tx.type === "income" &&
        posted(tx) &&
        !tx.appliesTo &&
        isFiniteAmount(tx.amount) &&
        Math.abs(tx.amount - r.amount) <= tol,
    );
    const months = new Set(matches.map((tx) => tx.date.slice(0, 7)));
    if (months.size !== 1) continue;

    const landed = newestFirst(matches)[0];
    const monthly = monthlyAmount(r);
    const endsOn = `${landed.date.slice(0, 7)}-${pad2(lastDayOf(landed.date.slice(0, 7)))}`;
    out.push({
      key: `income-landed:${r.id}:${landed.id}`,
      rule: "W6",
      kind: "income-landed",
      title: t("{name} looks like it already came in", { name: r.name }),
      detail: t(
        "The app expects {monthly} a month. One deposit of {actual} arrived on {date} and nothing like it before. If that was a one-off, the app is counting it every month from here.",
        { monthly: money(monthly), actual: money(landed.amount), date: formatDate(landed.date) },
      ),
      amount: monthly,
      evidence: {
        recurringId: r.id,
        monthKey: landed.date.slice(0, 7),
        txnIds: matches.map((tx) => tx.id).sort(),
        rows: matches.map(rowOf),
        modelled: monthly,
        observed: landed.amount,
      },
      // endsOn, not active:false — the window keeps the history truthful, so past
      // months still show the income they really had.
      fix: {
        action: "setRecurringWindow",
        recurringId: r.id,
        field: "endsOn",
        from: r.endsOn ?? null,
        to: endsOn,
        label: t("It was one-off — stop expecting it"),
      },
      txnIds: matches.map((tx) => tx.id).sort(),
      recurringId: r.id,
    });
  }
  return out;
}

// ── W7 — a charge that matches a bill you already model ───────────────────────
/**
 * This charge looks like a bill you model, and nothing connected the two. It is
 * the suggestion the six findings did not name and the live ledger most needs,
 * and it explains W2 and W4 from the other side: a bill with "no charges" usually
 * has charges nobody linked.
 *
 * THRESHOLD: EXACT normalized name equality plus the amount band. No prefix
 * matching, and the live data is why. Reusing matchRecurringName's prefix arm
 * matches a $130 grocery run at SAM'S CLUB to a $16.22/yr Sam's Club membership,
 * and a $159 AMAZON order to Amazon Prime. Reusing the feed's day+amount arm on
 * unrestricted spending is worse: on this ledger it pairs Chipotle with Spotify,
 * Circle K with Grok AI and a Zelle transfer with Verizon — over a hundred false
 * matches in four months. That heuristic is only safe INSIDE the feed, where it
 * runs after the categorizer has already decided the charge is a bill.
 *
 * At most ONE suggestion per (bill, cycle): the charge nearest the due day wins,
 * so a second matching charge in the same cycle produces nothing rather than a
 * guess. Two charges, one cycle, is out of scope for v1 — better to say so than
 * to pick.
 *
 * CAN BE WRONG: a genuine one-off purchase at the same merchant for the same
 * amount as the subscription.
 */
function reviewUnlinked(
  data: AppData,
  now: Date,
  cycles: Map<string, Transaction[]>,
): Suggestion[] {
  const from = `${windowMonths(now)[0]}-01`;
  const bills = data.recurring.filter(
    (r) => r.active && r.direction === "out" && dueDaysOf(r).length > 0,
  );
  if (!bills.length) return [];

  // best candidate per (bill, cycle): nearest the due day, ties to the earlier
  // date then the lower id, so the same ledger always yields the same answer.
  interface Hit {
    tx: Transaction;
    r: Recurring;
    monthKey: string;
    day: number;
    distance: number;
  }
  const best = new Map<string, Hit>();

  for (const tx of data.transactions) {
    if (tx.type !== "expense" || tx.appliesTo || tx.recordOnly) continue;
    if (!posted(tx) || !isFiniteAmount(tx.amount) || tx.amount <= 0) continue;
    if (!tx.date || tx.date < from) continue;
    const key = billKey(merchantKey(tx.description ?? ""));
    if (!key) continue;

    for (const r of bills) {
      if (billKey(r.name) !== key) continue;
      if (!liveOn(r, tx.date)) continue;
      const modelled = modelledOf(r);
      if (!isFiniteAmount(modelled) || modelled <= 0) continue;
      if (Math.abs(tx.amount - modelled) > band(r, modelled)) continue;
      const cycle = billCycleFor(dueDaysOf(r), tx.date);
      if (!firesInMonth(r, cycle.monthKey)) continue;
      const cycleKey = cycleKeyFor(r, cycle.monthKey, cycle.day);
      if ((cycles.get(cycleKey)?.length ?? 0) > 0) continue; // already settled
      const due = `${cycle.monthKey}-${pad2(cycle.day)}`;
      const distance = Math.abs(dayStart(tx.date) - dayStart(due));
      const held = best.get(cycleKey);
      if (
        !held ||
        distance < held.distance ||
        (distance === held.distance &&
          (tx.date < held.tx.date || (tx.date === held.tx.date && tx.id < held.tx.id)))
      ) {
        best.set(cycleKey, { tx, r, monthKey: cycle.monthKey, day: cycle.day, distance });
      }
    }
  }

  const out: Suggestion[] = [];
  for (const hit of best.values()) {
    const { tx, r, monthKey, day } = hit;
    const modelled = modelledOf(r);
    out.push({
      key: `unlinked:${r.id}:${monthKey}:${tx.id}`,
      rule: "W7",
      kind: "unlinked",
      // The MONTH is in both sentences. One bill can produce several of these at
      // once — the live ledger has three Amazon Prime cycles — and without the
      // month they are the same title, the same amount and the same button three
      // times over, each settling a different month. "That cycle" also asked him to
      // learn a word for something the rest of the app calls a month.
      title: t("This charge looks like your {name} bill for {month}", {
        name: r.name,
        month: monthLabel(monthKey),
      }),
      detail: t(
        "{amount} at {merchant} on {date}. Your {name} bill is {modelled}, due on the {day}, and {month} is still showing as unpaid. Right now this is counted as ordinary spending as well as a bill still to come.",
        {
          amount: money(tx.amount),
          merchant: tx.description,
          date: formatDate(tx.date),
          name: r.name,
          modelled: money(modelled),
          day: ordinal(day),
          month: monthLabel(monthKey),
        },
      ),
      amount: tx.amount,
      evidence: {
        recurringId: r.id,
        monthKey,
        txnIds: [tx.id],
        rows: [rowOf(tx)],
        modelled,
        observed: tx.amount,
      },
      // The one fix that SETTLES a bill cycle, which is the mistake the feed's
      // relabel sweep refuses to make from a bulk pass on purpose. One tap, one
      // charge, one cycle, with both amounts on screen before the tap.
      fix: {
        action: "linkTransactionToBill",
        txnId: tx.id,
        recurringId: r.id,
        monthKey,
        day,
        installmentIndex: installmentIndexOf(r, day),
        label: t("Yes, that is the bill"),
      },
      txnIds: [tx.id],
      recurringId: r.id,
    });
  }
  return out;
}
