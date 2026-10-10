// Gino's pay floor — what it IS, said one way, for both doors.
//
// HIS STANDING RULE, in his terms: the amount on his paycheck row is a deliberate
// FLOOR. It is a planned paycheck amount set low on purpose; real checks usually come
// in above it, and anything above it is upside. It is never raised.
//
// FOUND 2026-10-10 THAT BOTH DOORS DESCRIBED IT WRONGLY, AND ONE COULD BREAK IT.
//
//   · The read door told the assistant the opposite of the truth. finance.firepower's
//     note said "the household's cash floor is not in it and this door does not know
//     it", and API.md and MUSE-SKILL.md read it as a cash RESERVE under the balance —
//     "a paycheque amount that is not to be dipped into". But the floor is not under
//     the cash at all: it is the INCOME the plan is built on. planMath() takes income
//     from the live direction-'in' rows, and forecast() lays those same rows down as
//     paychecks — so firepower and the forecast are both built on it, and the door
//     knew it all along, as one row of the bill list.
//   · finance.forecast said "bills and income are measured from the bank". Income is
//     the PLANNED paycheck amounts off those rows; only the opening cash is measured.
//     So the reply told the assistant the wrong half was measured — the half its own
//     instructions say to name.
//   · finance.set_bill_amount had no direction check at all, so "my check was bigger
//     this time, update it" would have RAISED the floor — undoably, but with no
//     refusal and nobody told the rule.
//
// So this file holds the one sentence of the rule and the one test for which row it
// is about, and both doors use them: the read door to report the figure beside the
// income it is part of, the write door to say the rule when it refuses.
//
// NO AMOUNT LIVES IN THIS FILE OR IN EITHER DOOR. The repository is public; the figure
// comes off the row at request time, which also means it is never stale.

/** The rule, in one plain sentence. Said by the write door when it refuses to raise,
 *  turn off or end the floor row, and the wording the read door's notes follow. */
export const PAY_FLOOR_RULE =
  "Gino's paycheck figure is his pay floor: a planned paycheck amount he set low on purpose, so anything a real check brings above it is upside, and it is never raised.";

/** The slice of a recurring row this needs — the shape the read door's Recurring and
 *  the write door's BillRow both have. */
export interface FloorLike {
  direction: string;
  owner?: string | null;
  categoryId?: string | null;
}

/**
 * Is this the row that carries Gino's pay floor?
 *
 * Recognised by what it IS — money coming in, his, filed as salary — and not by its
 * name, so renaming the row cannot quietly take the protection off. A row this misses
 * is still guarded: the write door refuses to raise, turn off or end ANY incoming row
 * without a confirmation. What this decides is only whether the refusal says the floor
 * rule by name.
 */
export function isPayFloorRow(r: FloorLike): boolean {
  return r.direction === "in" && (r.owner ?? "").trim().toLowerCase() === "gino" && r.categoryId === "salary";
}

/**
 * The floor's planned amount per check, read off the live data — or null when there
 * is not exactly one live row that carries it.
 *
 * Exactly one, because two rows that both claim to be his floor is a question to ask,
 * not a figure to pick between.
 */
export function payFloorOf(
  recurring: readonly (FloorLike & { active: boolean; amount: number })[],
): number | null {
  const rows = recurring.filter((r) => r.active && isPayFloorRow(r));
  return rows.length === 1 ? rows[0].amount : null;
}
