// Every row of a table through the Management API's SQL endpoint — a page at a
// time, in a total order — or a thrown error.
//
// The SQL twin of src/lib/pagedRead.ts, for the two readers that go through the
// Management API instead of the app's client: scripts/snapshot.mjs and
// tests/live-selfaudit.test.ts.
//
// FOUND 2026-10-09, alongside the app's own 1,000-row cut: both of them read a
// WINDOW of the ledger and were trusted as if it were the whole thing. The live
// self-audit took the newest 2,000 rows; the snapshot took the newest 500 while
// the accountant brief describes it as dumping every finance table, and both
// DoctorLab's Worth a look and the self-audit in tests/museSnapshot.test.ts run
// over what it wrote. The links-point-somewhere check behind both reads
// whole-table sets — a payback credit older than the window looks DELETED — so a
// window does not give a smaller answer, it gives a wrong one. With 835 rows
// that day, the 500-row window was already cutting the ledger short.
//
// The same three rules as the app's reader, for the same reasons:
//   · the order always ends on `id`, so no two rows tie and LIMIT/OFFSET cannot
//     hand one row back twice or step over another;
//   · pages are read until one comes back short;
//   · `q` throws on any failed request, and nothing is returned after a failure.
// And the same guard against a write landing between two pages: a row already
// held is not taken again.

/** Rows per statement. Small enough that one page is never a large response. */
export const SQL_PAGE_ROWS = 500;

/**
 * @param {(sql: string) => Promise<unknown>} q  runs ONE statement; throws on failure
 * @param {{ table: string, orderBy?: string, columns?: string, pageSize?: number }} spec
 *   `orderBy` is the order the caller wants ("date desc, created_at desc"); `id`
 *   is appended as the final tiebreak. `columns` must include `id`.
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function readEveryRowSql(q, { table, orderBy = "", columns = "*", pageSize = SQL_PAGE_ROWS }) {
  const order = orderBy.trim() ? `${orderBy.trim()}, id` : "id";
  const rows = [];
  const held = new Set();
  for (let offset = 0; ; ) {
    const page = await q(`select ${columns} from ${table} order by ${order} limit ${pageSize} offset ${offset}`);
    if (!Array.isArray(page)) {
      throw new Error(`${table}: the page at offset ${offset} came back as something that is not rows`);
    }
    if (page.length > pageSize) {
      throw new Error(`${table}: the page at offset ${offset} held ${page.length} rows where ${pageSize} were asked for`);
    }
    let fresh = 0;
    for (const row of page) {
      const id = row?.id;
      if (id === undefined || id === null) {
        throw new Error(`${table}: a row at offset ${offset} came back without an id`);
      }
      if (held.has(id)) continue;
      held.add(id);
      rows.push(row);
      fresh++;
    }
    if (page.length < pageSize) return rows;
    if (fresh === 0) throw new Error(`${table}: the page at offset ${offset} repeated rows already read`);
    offset += page.length;
  }
}
