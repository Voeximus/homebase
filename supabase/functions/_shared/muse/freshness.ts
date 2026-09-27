// HOW OLD IS THE ANSWER — the one thing every number out of the read door was
// missing.
//
// WHY THIS FILE EXISTS
//
// Until now nothing in the app or in either door ever read `last_sync_at`. The
// bank feed was pulled in exactly two places, both of them a person opening a
// screen: `src/App.tsx` calls syncNow() on launch, and the finance tab's
// pull-to-refresh calls syncNow(true). That was fine while the screens WERE the
// product. It stops being fine the moment the screens are retired and Muse is the
// interface, because then nobody opens anything, nothing calls syncNow, and the
// doors go on answering — confidently, with the app's own arithmetic, off a
// database that last moved days ago. A wrong number is at least arguable. A right
// number about last Tuesday, spoken as though it were about today, is not.
//
// `finance.bank_status` already answers "is this current" — but only when somebody
// thinks to ask it, and its own note says the quiet part out loud: a connection
// sitting in `needs_reauth` "makes those numbers stale without making them look
// stale". So the age stops being a question you have to know to ask and becomes a
// line on every single reply. handler.ts stamps it in ONE place, the same place
// every successful tool answer leaves the door.
//
// NO CLOCK IN HERE. `now` is handed in, like everywhere else under _shared/muse.
// The build guard that forbids a clock in the door covers this file too.
//
// NO src/lib IMPORT, AND THAT IS A DECISION, NOT AN OVERSIGHT. Rule 1 says the door
// re-derives none of the household's FIGURES and imports the app's real modules for
// the ones it reports. An elapsed minute count is not one of the household's
// figures: it is not money, it is not a bill date, and — checked, not assumed —
// NOTHING in `src/` reads `last_sync_at` at all, so there is no screen for this to
// drift away from. Inventing a src/lib module for it would be inventing a source of
// truth nobody reads. The day a screen shows "synced 12 minutes ago", this moves to
// src/lib and comes back through scripts/gen-muse-shared.mjs like headline.ts did.
//
// NOTHING STORED IS INTERPOLATED INTO A SENTENCE. `says` below is built only from
// our own literals and from integers. No institution name, no status word, no
// `last_error` — all of those are written by the bank, and the tool that wants to
// repeat them (finance.bank_status) scrubs each one itself. A stamp that is on every
// reply is the worst possible place to hand a bank's own text back out, so it
// carries none.

import { minutesSince } from "./az.ts";

/**
 * How often the routine pull runs, in minutes.
 *
 * 15, and it is 15 for one reason: the `homebase-reminders` job already runs every
 * fifteen minutes, so the whole system has ONE unattended grain and one sentence
 * that explains it — the cron expression is spelled out in schema_v39. The
 * reminder tools already tell a caller a thing "arrives within about 15 minutes";
 * this tells it numbers are "within about 15 minutes" of the bank. Two different
 * grains would be two sentences to keep in step for no gain.
 *
 * The scheduled tick does NOT force a bank pull — see REFRESH_COOLDOWN_MIN.
 * `/transactions/sync` is a cursor delta and costs nothing to call often;
 * `/transactions/refresh`, the one that nudges the bank itself, is rate-limited by
 * Plaid and is reserved for somebody actually asking.
 */
export const REFRESH_TICK_MIN = 15;

/**
 * The shortest gap between two assistant-asked refreshes, in minutes.
 *
 * 10, for three reasons, in the order they mattered:
 *
 *   1. Plaid's forced refresh is ASYNCHRONOUS and rate-limited. src/lib/plaidClient
 *      already says it: "brand-new charges may land a few moments later". A second
 *      ask ten minutes after the first has nothing new to return — it does not
 *      produce fresher data, it produces a second call to the bank.
 *   2. It is deliberately SHORTER than REFRESH_TICK_MIN. The routine tick already
 *      covers everything; the asked-for one exists only to shorten a wait. If the
 *      cooldown were 15 or more, somebody who asked just after a tick would be told
 *      no by a window they could not see, which is the kind of refusal that reads
 *      as a broken tool.
 *   3. It is a cap on a loop. A prompt injection that says "refresh, refresh,
 *      refresh" gets six forced bank pulls an hour at worst, on top of the 60
 *      reads an hour the read door already counts.
 */
export const REFRESH_COOLDOWN_MIN = 10;

/**
 * When the door starts saying the feed is OLD rather than just stating its age.
 *
 * 90 minutes — six routine ticks. One missed tick is a hiccup and nothing worth
 * putting a warning in front of a number for; six in a row means the job, the
 * function or the connection has stopped, and that is worth a sentence.
 */
export const BANK_STALE_MIN = 90;

/**
 * The one field the COOLDOWN looks at, and it is worth its own name.
 *
 * The write door reads `bank_connections` narrow — two time columns and an id, no
 * status, no institution — so the cooldown cannot be given the full row and must not
 * need it. That is not just plumbing: the cooldown deliberately does NOT care whether
 * a connection is healthy. A pull on a broken connection still costs a call to the
 * bank, so it still has to count against the window.
 */
export interface RefreshWindow {
  refreshRequestedAt?: string | null;
}

/** Just the fields the stamp reads, so this file does not depend on the shape of
 *  the full BankConnection the finance loader builds. */
export interface FreshConnection extends RefreshWindow {
  status: string;
  lastSyncAt?: string | null;
}

/**
 * The stamp, as it goes onto a reply.
 *
 * A `type` and not an `interface`, and that is load-bearing rather than taste: the
 * reply body is typed `{ [k: string]: Json }`, and TypeScript gives an object type
 * declared with a type alias an implicit index signature while an interface gets
 * none. As an interface this would need a cast at the one place it is used, and a
 * cast there is how a field that is not JSON gets added later without anything
 * complaining.
 */
export type Freshness = {
  /** The newest good sync across every connection, as stored. Null when no
   *  connection has ever finished one. */
  bank_last_sync_at: string | null;
  /** Whole minutes since that sync, FLOORED — see `sayAge`. Null when there has
   *  never been one, and null when there is no bank feed at all. */
  bank_synced_minutes_ago: number | null;
  /** True when a refresh has been asked for and no sync has landed since. */
  refresh_pending: boolean;
  /** True when at least one connection cannot sync until he re-authorises it in
   *  the app. Every figure downstream of it is frozen until he does. */
  needs_reauth: boolean;
  /** One sentence, safe to repeat verbatim. Built from literals and integers only. */
  says: string;
}

/**
 * An age in words, ROUNDED TOWARDS OLDER, always.
 *
 * `Math.floor` on the unit below and never on the unit itself: 119 minutes is "1
 * hour ago", not "2 hours ago" and not "about 2 hours ago". The direction is the
 * whole point — a stamp that rounds 89 minutes up to "an hour and a half" is
 * annoying, and a stamp that rounds 91 minutes down to "just now" is the bug this
 * file exists to prevent. When in doubt it says the feed is older than it is.
 */
export function sayAge(minutes: number): string {
  if (minutes < 2) return "less than a minute ago";
  if (minutes < 90) return `${Math.floor(minutes)} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** Was this connection's refresh asked for more recently than its last good sync?
 *  That is the whole test for "still waiting" — no flag is ever cleared, so there
 *  is no write to race and no row that can be left pending by a crash. */
function pending(c: FreshConnection): boolean {
  if (!c.refreshRequestedAt) return false;
  const asked = Date.parse(c.refreshRequestedAt);
  if (!Number.isFinite(asked)) return false;
  const synced = c.lastSyncAt ? Date.parse(c.lastSyncAt) : NaN;
  return !Number.isFinite(synced) || asked > synced;
}

/**
 * The stamp for one reply.
 *
 * WHY IT TAKES THE WHOLE LIST AND REPORTS THE NEWEST. Every figure the door gives
 * is assembled across all the accounts at once, so the honest single number is the
 * newest sync — that is the moment the picture as a whole was last touched. The
 * per-connection detail is `finance.bank_status`, which exists and is named in the
 * sentence below whenever there is something specific to go and look at.
 */
export function freshnessOf(conns: readonly FreshConnection[], now: Date): Freshness {
  const needsReauth = conns.some((c) => c.status === "needs_reauth");
  const refreshPending = conns.some(pending);

  let newest: string | null = null;
  let ago: number | null = null;
  for (const c of conns) {
    const m = minutesSince(c.lastSyncAt, now);
    if (m === null) continue;
    if (ago === null || m < ago) {
      ago = m;
      newest = c.lastSyncAt ?? null;
    }
  }

  const waiting = refreshPending
    ? ` A refresh has been asked for and has not landed yet; it goes out within about ${REFRESH_TICK_MIN} minutes.`
    : "";

  let says: string;
  if (conns.length === 0) {
    // No bank feed at all. Nothing is going stale, because nothing arrives on its
    // own — every figure is what the two of them typed in.
    says =
      "There is no bank feed connected, so nothing here came from a bank: every figure is one of " +
      "theirs, as current as the last time they entered something.";
  } else if (needsReauth) {
    // Loudest case, and it goes FIRST even when a sync happens to be recent: a
    // connection in needs_reauth is frozen, and a fresh-looking age on the others
    // is exactly how that hides.
    says =
      "At least one bank connection needs re-authorising in the app, so anything it feeds is frozen " +
      "where it was — say so before giving a balance, and check finance.bank_status for which one." +
      waiting;
  } else if (ago === null) {
    says =
      "No bank connection has finished a sync yet, so treat any balance as unconfirmed." + waiting;
  } else if (ago >= BANK_STALE_MIN) {
    says =
      `The bank feed last synced ${sayAge(ago)}, which is older than it should be — the routine ` +
      `pull runs every ${REFRESH_TICK_MIN} minutes, so say these numbers are old and check ` +
      `finance.bank_status.` + waiting;
  } else {
    says = `Current as of the bank sync ${sayAge(ago)}.` + waiting;
  }

  return {
    bank_last_sync_at: newest,
    bank_synced_minutes_ago: ago,
    refresh_pending: refreshPending,
    needs_reauth: needsReauth,
    says,
  };
}

/**
 * The stamp when the freshness read itself failed.
 *
 * WHY THIS IS NOT A FAIL-CLOSED REFUSAL, and it is the one deliberate exception in
 * the file. Rule 5 is that every read is paged and fails closed, and it stays that
 * way for every figure: the numbers in the reply came through the paged loader, and
 * if THAT could not be read whole the tool has already refused before this is ever
 * reached. This is metadata ABOUT that answer. Failing closed here would throw away
 * a correct, complete answer because a one-row table about sync times would not
 * load — trading the thing he asked for to protect the footnote. So the footnote
 * says it does not know, which is both true and the safer thing to hear.
 */
export function freshnessUnknown(): Freshness {
  return {
    bank_last_sync_at: null,
    bank_synced_minutes_ago: null,
    refresh_pending: false,
    needs_reauth: false,
    says:
      "I could not check when the bank feed last synced, so I do not know how current this is — " +
      "the figures themselves were read whole, but say the age is unknown rather than guessing it.",
  };
}

/** What `system.refresh` decided, and the sentence that goes with it. */
export interface RefreshDecision {
  allowed: boolean;
  /** Whole minutes left on the cooldown. 0 when allowed. */
  wait_minutes: number;
  says: string;
}

/**
 * May an assistant ask for a bank pull right now?
 *
 * The cooldown is measured from the last REQUEST, not the last sync, and that is on
 * purpose: a request that Plaid answered with nothing still cost a call to the bank,
 * so it still has to count against the window. Measuring from `last_sync_at` would
 * let a failing connection be hammered forever, because a pull that never lands
 * never moves the thing the window is measured from.
 */
export function refreshDecision(conns: readonly RefreshWindow[], now: Date): RefreshDecision {
  if (conns.length === 0) {
    return {
      allowed: false,
      wait_minutes: 0,
      says:
        "There is no bank connected, so there is nothing to refresh. Everything in the ledger was " +
        "entered by hand and is already as current as it will get.",
    };
  }

  let newestAsk: number | null = null;
  for (const c of conns) {
    const m = minutesSince(c.refreshRequestedAt, now);
    if (m === null) continue;
    if (newestAsk === null || m < newestAsk) newestAsk = m;
  }

  if (newestAsk !== null && newestAsk < REFRESH_COOLDOWN_MIN) {
    // Round the wait UP, so the sentence never promises a moment that is still
    // inside the window.
    const wait = Math.max(1, Math.ceil(REFRESH_COOLDOWN_MIN - newestAsk));
    return {
      allowed: false,
      wait_minutes: wait,
      says:
        `A refresh was already asked for ${sayAge(newestAsk)}, and the bank will not have anything ` +
        `new this soon — asking again would just be a second call to it. Wait about ${wait} more ` +
        `minutes. The routine pull runs every ${REFRESH_TICK_MIN} minutes regardless.`,
    };
  }

  return {
    allowed: true,
    wait_minutes: 0,
    says:
      `Asked for a fresh pull from the bank. This is NOT instant and the ledger has not moved yet: ` +
      `the scheduled job carries it out on its next run, within about ${REFRESH_TICK_MIN} minutes, ` +
      `and the bank itself may take a few moments more. Say that plainly — do not report it as done ` +
      `— and read the numbers again afterwards rather than assuming they changed.`,
  };
}
