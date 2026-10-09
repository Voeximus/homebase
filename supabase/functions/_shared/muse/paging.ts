// Rule 5 — every table read is paged, and fails closed.
//
// PostgREST caps a select at 1000 rows by default and truncates SILENTLY. This
// repo has already paid for that lesson and written it down, in
// supabase/functions/plaid/index.ts: "Page explicitly: PostgREST caps a select
// (1000 rows by default) and truncates SILENTLY, and a first sync can span 24
// months — a half-armed guard would look like it worked and still double part of
// the history."
//
// The doors have to load whole tables to hand the app's maths modules the data
// they expect. Today's ledger is small, so a bare select would work — and keep
// working until it quietly did not, at which point every number the assistant
// spoke (the audit's eight checks, the envelope, the debts) would be computed
// from a truncated ledger, in a chat, with no screen beside it. That is the exact
// failure this whole bridge exists to prevent.
//
// So: page explicitly, AND cross-check the number of rows returned against a
// count on the same filter. If they disagree, nothing is computed — the door says
// it could not read the ledger cleanly and stops.
//
// A NOTE ON THE FALSE ALARM, because it is real. The count and the pages are
// separate requests, so a write landing between them makes them disagree and the
// door refuses. That is the right direction to be wrong in: a refusal costs one
// retry, and a truncated ledger costs a wrong number he cannot check. The refusal
// says so in plain words rather than pretending to be an outage.

/** One row, as PostgREST hands it over. Column values are unknown until a mapper
 *  names them — which is the only place a column name should appear. */
export type DbRow = Record<string, unknown>;

/** A page size below PostgREST's own cap, so a page that comes back full is a
 *  page we asked to be full rather than one the server trimmed. */
export const PAGE = 500;

/**
 * The most rows any one table read will fetch.
 *
 * A Supabase edge function gets 2 seconds of CPU and 256 MB, and the ledger is a
 * few thousand rows. A table larger than this is not a bigger answer, it is a
 * different situation — so the door stops and says so rather than spending its
 * whole budget and timing out halfway through an answer.
 */
export const MAX_ROWS = 20_000;

/** The door could not read a table cleanly. Never caught inside a tool: it means
 *  no number goes out at all. */
export class LedgerUnreadable extends Error {
  readonly table: string;
  constructor(table: string, why: string) {
    super(`${table}: ${why}`);
    this.name = "LedgerUnreadable";
    this.table = table;
  }
}

/** One filtered, ordered view of a table. Implemented over supabase-js in the
 *  door's entry file, and faked in the tests — so nothing tested here has to
 *  import a Supabase client. */
export interface DbSelect {
  /** How many rows match, from a count query on the SAME filter. */
  count(): Promise<number>;
  /** Rows `from`..`to` inclusive, in the select's own stable order. */
  page(from: number, to: number): Promise<DbRow[]>;
}

export interface DbQuery {
  table: string;
  /** A column that totally orders the table, so paging cannot skip or repeat a
   *  row. Every table read here has a primary key; `macro_targets` is keyed on
   *  `person` rather than an id, which is why this is a parameter. */
  orderBy: string;
  /** Equality filters, applied to BOTH the count and the pages. */
  eq?: Record<string, string>;
}

export interface Db {
  select(query: DbQuery): DbSelect;
}

/** One page as supabase-js hands it back: rows, or an error — and an error is never
 *  the same thing as no rows. */
export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Every row of a query the CALLER builds — its own columns, its own filter, its own
 * total order — fetched `PAGE` rows at a time until a page comes back short.
 *
 * WHY THIS EXISTS BESIDE readAll. readAll takes equality filters only, and a scheduled
 * function sometimes needs a different one: cron-notify reads "every charge attached to
 * something" (`applies_to is not null`), five columns of it, and nothing else. It read
 * that with ONE bare select — no order, no range, and `{ data }` destructured with the
 * error thrown away. FOUND 2026-10-09: PostgREST caps that at 1,000 rows and says
 * nothing, so past the cap the bill payments it judged "already paid" were whichever
 * 1,000 the server happened to return; and a failed read was `data: null`, which the
 * code read as "nothing has been paid" and went on to ping bills that were.
 *
 * So this is the same two promises readAll makes, for a query it cannot express:
 *   · paged, below the server's own cap, so a short page is the real end and not a trim;
 *   · an error THROWS (as LedgerUnreadable, the same refusal the doors give), so a
 *     caller cannot mistake "could not read" for "there is nothing".
 *
 * The page function must apply a TOTAL order (a unique column last, e.g.
 * `.order("date", { ascending: false }).order("id")`), or offsets can skip or repeat a
 * row between pages. That is the caller's half, and it is said here because it cannot
 * be checked from here.
 */
export async function readPages<T>(
  table: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const from = rows.length;
    let got: PageResult<T>;
    try {
      got = await page(from, from + PAGE - 1);
    } catch (e) {
      throw new LedgerUnreadable(table, `page from ${from} failed (${String((e as Error)?.message ?? e)})`);
    }
    if (got.error) throw new LedgerUnreadable(table, `page from ${from} failed (${got.error.message})`);
    if (!Array.isArray(got.data)) {
      throw new LedgerUnreadable(table, `page from ${from} came back as something that is not rows`);
    }
    rows.push(...got.data);
    if (rows.length > MAX_ROWS) {
      throw new LedgerUnreadable(table, `more than ${MAX_ROWS} rows is more than this will read`);
    }
    if (got.data.length < PAGE) return rows;
  }
}

/**
 * Every row of a table, or nothing at all.
 *
 * Throws `LedgerUnreadable` when the count and the pages disagree, when the table
 * is bigger than `MAX_ROWS`, or when any request fails. It never returns a
 * partial set, and it never returns rows it did not prove it had all of.
 */
export async function readAll(db: Db, query: DbQuery): Promise<DbRow[]> {
  const sel = db.select(query);

  let expected: number;
  try {
    expected = await sel.count();
  } catch (e) {
    throw new LedgerUnreadable(query.table, `count failed (${String((e as Error)?.message ?? e)})`);
  }
  if (!Number.isInteger(expected) || expected < 0) {
    throw new LedgerUnreadable(query.table, "count came back as something that is not a row count");
  }
  if (expected > MAX_ROWS) {
    throw new LedgerUnreadable(query.table, `${expected} rows is more than this door will read (${MAX_ROWS})`);
  }

  // The offset is how many rows we actually hold, never a fixed stride. A stride
  // would step past whatever a short page failed to deliver and read the rest of
  // the table at the wrong offsets — the truncation, with a plausible row count.
  const rows: DbRow[] = [];
  while (rows.length < expected) {
    const from = rows.length;
    let batch: DbRow[];
    try {
      batch = await sel.page(from, from + PAGE - 1);
    } catch (e) {
      throw new LedgerUnreadable(query.table, `page from ${from} failed (${String((e as Error)?.message ?? e)})`);
    }
    if (!Array.isArray(batch)) {
      throw new LedgerUnreadable(query.table, `page from ${from} came back as something that is not rows`);
    }
    if (batch.length === 0) {
      throw new LedgerUnreadable(query.table, `ran out of rows at ${from} of ${expected}`);
    }
    rows.push(...batch);
    if (rows.length > expected) {
      throw new LedgerUnreadable(query.table, `read ${rows.length} rows where ${expected} were counted`);
    }
    // A SHORT page while rows are still owed is the silent truncation this whole
    // file exists for: it looks exactly like "that is all of them" and is not.
    if (batch.length < PAGE && rows.length < expected) {
      throw new LedgerUnreadable(
        query.table,
        `a page came back short (${batch.length} of ${PAGE}) with ${expected - rows.length} rows still owed`,
      );
    }
  }

  if (rows.length !== expected) {
    throw new LedgerUnreadable(query.table, `read ${rows.length} rows where ${expected} were counted`);
  }
  return rows;
}
