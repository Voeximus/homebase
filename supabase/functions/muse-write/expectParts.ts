// How a compare-and-set expectation reaches PostgREST.
//
// WHY THIS IS ITS OWN FILE. It used to be a closure inside dbFinanceSupabase.ts, and
// that file imports `jsr:@supabase/…`, so it is excluded from both tsconfigs and no
// test has ever been able to import it. That is not a detail — it is the reason the
// bug below lived: the fake database the unit suite runs against compares the two
// values in JavaScript, where everything works, and the only code that ever spoke to
// Postgres was the code nothing could reach. Splitting eight lines out makes the one
// decision in them testable without a network and without a Supabase client.
//
// A NULL EXPECTED VALUE HAS TO BE `.is()`, NOT `.eq()`. PostgREST renders eq(null) as
// `=null`, which matches nothing in SQL — so an expectation of null spelled with eq
// would silently refuse every write, and every tool would report "something changed
// that row" about a row nothing had touched.
//
// AN OBJECT HAS TO BE HANDED OVER AS TEXT. A json value compared with eq() is compared
// as jsonb and is therefore key-order independent — that is what makes `applies_to`
// usable as an expectation at all, and it was written down here as settled fact. It was
// true about Postgres and false about how we reached it: an object passed to eq() goes
// into the query string through String(), so `{kind:"setaside",…}` arrived as
// `[object Object]` and Postgres answered `invalid input syntax for type json`.
//
// Every write that guards on `applies_to` — settling a reimbursable, re-opening one,
// unlinking a charge — returned a 500 for as long as that was true. What found it was
// an audit row from a real call: the door told the caller "something went wrong on my
// side", and the note underneath said exactly which statement and exactly why. The
// reasoning in the comment was right about the destination and never checked against
// the journey.

/** A value a write may expect to find, as the undo log stores it. */
export type ExpectValue = string | number | boolean | null | Record<string, unknown> | unknown[];

/**
 * Split an expectation into the two shapes PostgREST needs.
 *
 * `nulls` are columns to compare with `.is(col, null)`. `values` are `[column, value]`
 * pairs for `.eq(col, value)`, with objects and arrays already serialised — key order
 * still does not matter, because Postgres casts the literal to jsonb and compares
 * semantically.
 */
export function expectParts(
  expect: Record<string, ExpectValue>,
): { nulls: string[]; values: [string, string | number | boolean][] } {
  const nulls: string[] = [];
  const values: [string, string | number | boolean][] = [];
  for (const [col, want] of Object.entries(expect)) {
    if (want === null) nulls.push(col);
    else if (typeof want === "object") values.push([col, JSON.stringify(want)]);
    else values.push([col, want]);
  }
  return { nulls, values };
}
