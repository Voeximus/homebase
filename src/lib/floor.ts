// The cash you refuse to count as spendable.
//
// The home screen used to lead with the envelope remainder — budget target
// minus what you had spent this cycle — and that number will happily read $531
// the day before $1,715 of rent leaves the account. It is now:
//
//     truly free = cash − everything due before the next payday − this floor
//
// The floor is the part that cannot be derived. It is a judgement about how
// close to zero you are willing to run, and it belongs to the person, not to
// the arithmetic. Kept per DEVICE (like the lens and the health theme) rather
// than in the household row, because it is a comfort setting rather than
// shared truth — Gino and Xinyan can hold different ones without either being
// wrong.
//
// NOTE the name collision, because it will bite someone: this is NOT the
// $1,400-a-check income floor in the recurring rows. That one is a deliberate
// under-statement of income and must never be raised. This one is a buffer
// held back out of cash.

const KEY = "hb-cash-floor";

/** The default is deliberately small — a floor you never hit teaches nothing. */
export const DEFAULT_FLOOR = 300;

export function getFloor(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_FLOOR;
    const n = Number(raw);
    // A stored NaN or a negative would silently make "truly free" larger than
    // the cash in the account, which is the one thing this number must never do.
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FLOOR;
  } catch {
    return DEFAULT_FLOOR;
  }
}

export function saveFloor(n: number): void {
  try {
    localStorage.setItem(KEY, String(Math.max(0, Math.round(n))));
  } catch {
    /* storage unavailable — the default still applies */
  }
}
