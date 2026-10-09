// Every row of a table, read through the app's own Supabase client — or an error.
//
// FOUND 2026-10-09: the app's ledger load stops at 1,000 rows. PostgREST cuts a
// select off at its max-rows setting (1,000 on this project) and says NOTHING —
// no error, no flag, just the first 1,000 rows standing in for the whole table.
// Both stores read every table with one bare `select *`. The ledger held 835 rows
// that day and grows by about 4.2 a day, so it would have crossed 1,000 around
// 2026-11-17, and from then on the app would have held only the newest 1,000.
// Three things break on that day and none of them says so: statement import
// dedups against the ledger in memory, so an old charge that had fallen off the
// end gets added a second time; the Profile self-check reads whole-table sets, so
// every link to an older row reports as broken; and the oldest months simply stop
// existing on every screen.
//
// The repo had already paid for this lesson twice — the Plaid dedup scan pages
// explicitly ("PostgREST caps a select (1000 rows by default) and truncates
// SILENTLY"), and the Muse doors made it Rule 5 (_shared/muse/paging.ts). This is
// the app's half of the same lesson, in one place both stores share.
//
// THREE RULES, each one a way the obvious loop goes wrong:
//
//   1. A TOTAL ORDER. Paging by offset over an order with ties can hand back one
//      row on two pages and skip another, because the database is free to break a
//      tie differently on every request. So the order always ENDS on `id`, the
//      primary key of every table read here, and no two rows can tie. The caller
//      says how it wants the rows sorted; this file adds the tiebreak itself, so no
//      caller can forget it.
//   2. PAGES SMALLER THAN THE CAP, read until one comes back short. A page of 500
//      that comes back full is a page we asked to be full, not one the server
//      trimmed — the same reasoning as PAGE in _shared/muse/paging.ts.
//   3. AN ERROR IS AN ERROR. The stores destructured `{ data }` and dropped
//      `error`, so a failed request read as `null`, `?? []` turned that into an
//      empty list, and one failed refetch wiped the whole ledger off the screen
//      until the next one happened to succeed. Here any failed page throws, and
//      nothing from the pages before it is returned: part of a ledger is worse than
//      the ledger already on screen, because it looks complete.
//
// A WRITE BETWEEN TWO PAGES is the one thing offset paging cannot see. A new
// newest-first row pushes every row down by one, so the last row of page 1 comes
// round again at the top of page 2 — and a ledger holding one charge twice
// double-counts it on every screen. Rows already held are dropped here by id, so
// that cannot happen. The opposite case (a delete pulling a row UP past the
// boundary) cannot be seen from inside the read, but it does not last: the same
// write fires a realtime event, and the refetch that follows claims a newer
// ticket in the store, so this read is replaced by one that started after it.

/** The slice of a supabase-js query that this file drives. Structural, so the
 *  real client fits it as it is and a test can hand in a fake without importing
 *  Supabase at all. */
export interface PagedQuery {
  order(column: string, options: { ascending: boolean }): PagedQuery;
  range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: unknown }>;
}
export interface PagedClient {
  from(table: string): { select(columns: string): PagedQuery };
}

/** One column of the order the caller wants. `id` is always appended after these. */
export interface SortKey {
  column: string;
  ascending: boolean;
}

/** Rows asked for per request — half PostgREST's 1,000-row cap, so a full page is
 *  never one the server cut. */
export const PAGE_ROWS = 500;

/** The table could not be read whole. Thrown, never returned as an empty list. */
export class TableUnreadable extends Error {
  readonly table: string;
  constructor(table: string, why: string) {
    super(`${table}: ${why}`);
    this.name = "TableUnreadable";
    this.table = table;
  }
}

const reason = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

/**
 * Every row of `table`, in `sort` order with `id` as the final tiebreak — or a
 * thrown `TableUnreadable`. Never a partial list, never an empty list standing in
 * for a failure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readEveryRow<Row extends object = Record<string, any>>(
  client: PagedClient,
  table: string,
  sort: readonly SortKey[] = [],
): Promise<Row[]> {
  const rows: Row[] = [];
  const held = new Set<unknown>();
  // The offset is how many rows the server has handed over, duplicates included —
  // it counts positions in the server's order, not rows we kept.
  for (let from = 0; ; ) {
    let q = client.from(table).select("*");
    for (const key of sort) q = q.order(key.column, { ascending: key.ascending });
    q = q.order("id", { ascending: true });

    let answer: { data: unknown[] | null; error: unknown };
    try {
      answer = await q.range(from, from + PAGE_ROWS - 1);
    } catch (e) {
      throw new TableUnreadable(table, `page from ${from} failed (${reason(e)})`);
    }
    if (answer.error) {
      throw new TableUnreadable(table, `page from ${from} failed (${reason(answer.error)})`);
    }
    const batch = answer.data;
    if (!Array.isArray(batch)) {
      throw new TableUnreadable(table, `page from ${from} came back as something that is not rows`);
    }
    if (batch.length > PAGE_ROWS) {
      // The server ignored the range. Reading on would loop on the same rows.
      throw new TableUnreadable(table, `page from ${from} held ${batch.length} rows where ${PAGE_ROWS} were asked for`);
    }

    let fresh = 0;
    for (const row of batch as Row[]) {
      const id = (row as { id?: unknown }).id;
      // Every table read here is keyed on `id`, and the order is built on it. A
      // row without one would also defeat the duplicate check below — every such
      // row would look like the first — so it stops the read instead.
      if (id === undefined || id === null) {
        throw new TableUnreadable(table, `a row from ${from} came back without an id`);
      }
      if (held.has(id)) continue;
      held.add(id);
      rows.push(row);
      fresh++;
    }
    if (batch.length < PAGE_ROWS) return rows;
    if (fresh === 0) {
      // A full page of rows we already hold: the server is not moving through the
      // table, and asking again would never end.
      throw new TableUnreadable(table, `page from ${from} repeated rows already read`);
    }
    from += batch.length;
  }
}
