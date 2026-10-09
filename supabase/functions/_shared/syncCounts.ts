// What a bank sync moved, as numbers and nothing else — the `detail` a job_runs row
// records for every caller of the `plaid` sync.
//
// LIFTED OUT OF cron-bank-sync/index.ts on 2026-10-09, because a second caller
// arrived. FOUND 2026-10-09: a forced refresh's cron-bank-sync run recorded posted 0 /
// pending 0, and five rows landed two seconds later through plaid-webhook — which
// wrote no job_runs row at all. Across 715 runs the log summed posted 1 while 45 rows
// had arrived. The log was not wrong about what cron-bank-sync did; it was silent
// about the path that did most of the work, so anyone reading it to ask "is the bank
// feed moving?" was told no while it was. Now both callers record, and they reduce
// the sync's answer the same way, from this one file.
//
// NUMBERS ONLY. The sync's answer carries merchant names (newRows, for the phone
// notification) and, on failure, a bank's own error prose. Neither has any business
// in a table the heartbeat reads and an assistant can be asked about. Filtering by
// TYPE rather than by field name keeps that true even if the sync's shape changes
// underneath: a new text field is dropped without anyone having to remember to.
//
// Pure: no Deno, no DB. Tests import it directly.

/**
 * The numeric half of the sync's own answer, summed per connection.
 *
 * Two shapes arrive. A sync of every connection (cron-bank-sync) answers
 * `{ synced: [ {…per connection…} ] }`. A sync of ONE connection (plaid-webhook,
 * which names the connection the bank pinged about) answers that connection's
 * object directly, or `{ error }` when it failed. The second is counted as a list of
 * one, so the two callers' rows sum the same way.
 */
export function syncCounts(body: unknown): Record<string, number> {
  const per: unknown[] = Array.isArray((body as { synced?: unknown })?.synced)
    ? (body as { synced: unknown[] }).synced
    : body && typeof body === "object"
    ? [body]
    : [];
  const totals: Record<string, number> = { connections: per.length, failed: 0 };
  for (const one of per) {
    if (one && typeof one === "object") {
      if ("error" in one) totals.failed += 1;
      for (const [k, v] of Object.entries(one)) {
        if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
      }
    }
  }
  return totals;
}

/**
 * The same, read straight off the sync's HTTP response.
 *
 * Reading the body here is not a contradiction of "the body is not forwarded": it is
 * read, reduced to counts, and stored where only the service role can see it. What
 * never leaves is the text — descriptors, merchant names, a bank's error prose.
 */
export async function countsFrom(res: Response): Promise<Record<string, number>> {
  try {
    return syncCounts(await res.json());
  } catch {
    // A body that will not parse is not a reason to fail a sync that worked.
    return {};
  }
}
