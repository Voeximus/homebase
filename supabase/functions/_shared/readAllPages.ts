// Read EVERY row a `transactions` query matches, one page at a time, or throw.
//
// WRITTEN 2026-10-09 for the bank sync (plaid/index.ts), which had three reads of the
// ledger and three different levels of care about it:
//   · the dedup scan paged with .range() but no .order() — and without an order,
//     Postgres is free to return rows in a different sequence for each page, so one
//     row can come back twice and another never. A key that never came back is a
//     guard that was never armed, on a read that looked complete;
//   · the paid-cycles read (rows linked to a bill) had no paging, no order and no
//     error check at all — PostgREST would have capped it at 1,000 rows SILENTLY,
//     and a failed read came back as "nothing is paid";
//   · the new pending-corrections read needed the same treatment from day one.
// One helper, so the three cannot drift apart again.
//
// THE ORDER IS NOT THE CALLER'S TO FORGET. It is applied here, (date desc, id), and it
// ends in the primary key, so the sequence is total and fixed and a page boundary
// cannot drop or repeat a row. Every caller reads `transactions`, which has both.
//
// AN ERROR IS AN ERROR, never an empty list. Every caller decides something about money
// from what it reads — what is already in the ledger, which bill cycles are settled,
// what a person said about a charge — and "nothing there" is an answer, not a fallback.
//
// Pure apart from the query it is handed: no Deno, no client import. Tests drive it
// with a fake builder.

export const PAGE = 1000;

/**
 * `query` builds the filtered select afresh for each page (a supabase-js builder is
 * single-use). This applies the order and the range, and keeps reading until a page
 * comes back short.
 */
export async function readAllPages(
  label: string,
  // deno-lint-ignore no-explicit-any
  query: () => any,
  pageSize: number = PAGE,
  // deno-lint-ignore no-explicit-any
): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query()
      .order("date", { ascending: false })
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < pageSize) return out;
  }
}
