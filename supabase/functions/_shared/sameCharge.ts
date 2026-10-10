// "Is this the same charge?" for a COPY of a bank line — one rule, two callers.
//
// WHY THIS FILE EXISTS, 2026-10-10. Two places have to recognise the same bank charge
// when it arrives a second time under slightly different clothes:
//
//   · finance.add_history_row (muse-write/historyRow.ts), which refuses to write a
//     statement line the ledger already has; and
//   · the bank sync's duplicate guard (dedupGuard.ts), which must absorb the bank's
//     own delivery of a charge that a statement copy already put in the ledger.
//
// They were written with two different rules. The door looked three days either side
// and compared merchant names with the bank's statement noise stripped; the sync only
// matched the exact date and the exact merchant key. So a row the door happily accepted
// as "not a duplicate" — dated by the card's TRANSACTION date while the bank posts the
// charge a day later, or worded the way the statement prints it ("CHECKCARD 0912
// SAMPLE DINER …") while the feed sends the clean name ("Sample Diner") — was invisible
// to the sync. A deliberate cursor reset (the tool already used for the v25/v26
// backfills) or a bank re-link re-sends up to 24 months, and every such row would have
// landed twice. A review of the first version found exactly that by probing it.
//
// So the rule lives here, once, and both import it. No imports of its own: the door
// and the sync each hold their own copy of the categorizer (the door's generated one
// under _shared/muse/lib, the sync's under _shared), and each passes in its own
// merchantKey / stripStatementNoise. The two copies are byte-identical by a build
// guard, so the answer is the same either way — but importing one of them here would
// drag a second categorizer into whichever function did not already carry it.

/** Either side of a copy's date the match looks. A statement can carry the date the
 *  card was swiped while the feed carries the date the bank posted it, and around a
 *  weekend those are two or three days apart. */
export const SAME_CHARGE_DAYS = 3;

/**
 * Two merchant stems are the same merchant when they are equal, or when the shorter —
 * at least six characters, so "QT" cannot swallow a neighbour — begins the longer.
 * That is the statement import's own rule (src/lib/importStatement.ts sameMerchant),
 * verified there against the 36 real feed-vs-statement collisions in the June backup:
 * it is what lets the feed's "SAFEWAY" meet a statement's "SAFEWAY MESA AZ".
 */
export const MIN_STEM_PREFIX = 6;
export function sameStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_STEM_PREFIX && long.startsWith(short);
}

/** The two halves of the categorizer this rule reads, passed in by the caller. */
export interface MerchantReaders {
  merchantKey: (desc: string) => string;
  stripStatementNoise: (desc: string) => string;
}

/**
 * Same merchant: the same merchantKey() — the key the import's dupeKey and the sync's
 * exact guard share — or the same merchant once the bank's statement noise is stripped
 * from both, by sameStem.
 */
export function sameMerchant(a: string, b: string, read: MerchantReaders): boolean {
  const ka = read.merchantKey(a);
  if (ka && ka === read.merchantKey(b)) return true;
  return sameStem(read.merchantKey(read.stripStatementNoise(a)), read.merchantKey(read.stripStatementNoise(b)));
}

/** Whole days from one YYYY-MM-DD to another, on the calendar (no clock, no zone). */
export function calendarDaysApart(a: string, b: string): number {
  const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
  return Math.abs(day(a) - day(b));
}

/** The date `days` calendar days from `iso` (negative goes back). */
export function shiftDate(iso: string, days: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days);
  return new Date(t).toISOString().slice(0, 10);
}
