// ── "Looks fine — dismiss", remembered on this phone ──────────────────────────
//
// A dismissed suggestion never renders again. Because the EVIDENCE is inside the
// key (spec §B.9 — `drift:<id>:2700` carries the amount that triggered it), a key
// re-surfaces on its own the moment the facts change, so there is no snooze, no
// expiry and no re-ask logic anywhere. Dismissing is one write and one read.
//
// WHY LOCAL STORAGE, AND WHAT IT IS NOT
// The spec (§B.9) puts dismissals in a household-wide Supabase table, so
// dismissing on one phone dismisses on both. That table belongs to spec piece 3.
// This file is the per-phone half, and it exists for two reasons that outlive the
// table: it works with no signal, and it works before the row is confirmed, so a
// tap always has an immediate visible consequence.
//
// The two are a UNION, not a choice. `mergeDismissed()` below folds this phone's
// keys together with whatever the household table returns, so:
//   · today, with no table, dismissals still work and stay on this phone;
//   · later, a dismissal from the other phone is honoured here too;
//   · neither half can resurrect something the other dismissed.
//
// Nothing in here throws. Storage is absent in a private window, blocked by site
// settings, and unavailable during a thumbnail capture — so every read and write
// is wrapped, and a failed read means "nothing dismissed yet", which renders a
// correct screen rather than an empty one.

const KEY = "hb-review-dismissed";

/**
 * How many keys this phone remembers. Keys churn by design — an amount changes,
 * a month closes, and the old key is dead weight — so the list is capped and the
 * oldest fall off. 300 is far more than a household generates in a year, and
 * small enough that the whole list is a single cheap read.
 */
const CAP = 300;

/** Newest first, so the cap drops the oldest. */
function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: anything that is not a non-empty string is not a key.
    return parsed.filter((k): k is string => typeof k === "string" && k.length > 0);
  } catch {
    return [];
  }
}

function write(keys: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(keys.slice(0, CAP)));
  } catch {
    /* storage unavailable — the dismissal still holds for this session */
  }
}

/** Every suggestion key dismissed on this phone. Never throws. */
export function loadDismissed(): ReadonlySet<string> {
  return new Set(read());
}

/**
 * Remember a dismissal and hand back the new set, so a caller can put it
 * straight into state without a second read.
 */
export function dismissLocally(key: string): ReadonlySet<string> {
  if (!key) return loadDismissed();
  const next = [key, ...read().filter((k) => k !== key)];
  write(next);
  return new Set(next);
}

/** Undo one dismissal. Nothing in the UI calls this; the dev harness does. */
export function undismissLocally(key: string): ReadonlySet<string> {
  const next = read().filter((k) => k !== key);
  write(next);
  return new Set(next);
}

/** Forget every dismissal on this phone. Dev harness only. */
export function clearDismissed(): ReadonlySet<string> {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return new Set<string>();
}

/**
 * This phone's dismissals plus the household's. A key dismissed anywhere stays
 * dismissed everywhere; neither side can bring one back.
 *
 * `household` is whatever the store has — absent today, since the table is spec
 * piece 3 — and is read defensively so a shape change cannot break the screen.
 */
export function mergeDismissed(
  local: ReadonlySet<string>,
  household: readonly { key?: unknown }[] | undefined,
): ReadonlySet<string> {
  if (!household || !household.length) return local;
  const out = new Set(local);
  for (const row of household) {
    if (row && typeof row.key === "string" && row.key) out.add(row.key);
  }
  return out;
}
