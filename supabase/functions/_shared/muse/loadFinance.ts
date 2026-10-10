// The tables the finance parity tools need beyond the ledger bundle.
//
// load.ts owns `appData()` — the seven tables the app's maths modules take. Phase 2's
// tools need a few more reads that nothing else does, so they live here: the bank's
// in-flight charges (the pending rows of `transactions`, read on their own), the bank
// connections' health, the job log, the push devices, and the change log.
//
// SAME TWO RULES AS load.ts. Every read goes through readAll, so it is paged and
// fails closed (Rule 5): if the count and the pages disagree, the exception travels
// all the way out and the door answers with one sentence and no numbers. And every
// loader is memoised for the life of one request, so two numbers in one reply can
// never come from two different reads of the same table.
//
// THE MAPPERS ARE HERE AND NOT IN rows.ts on purpose. rows.ts maps into the APP'S
// OWN types (`Transaction`, `Account`, …), and a field the domain type requires and
// a mapper forgot is a compile error there — that is what keeps it honest. These
// shapes have no app-side type: `bank_connections` is read straight into JSX in
// src/views, `muse_undo` is the door's own table, and a pending charge is a narrower
// view of a transaction than `Transaction` — one with no room for the raw descriptor.
// So their shapes are declared next to their mappers, where a reader can see both at
// once.

import type { Db } from "./paging.ts";
import { isMissingTable, LedgerUnreadable, readAll } from "./paging.ts";
import type { Person } from "./auth.ts";
import { checkSteps, type UndoRecord, type UndoState, type UndoStep } from "./undo.ts";
import type { CycleBudget } from "./lib/types.ts";
import { toCycleBudget } from "./rows.ts";

const STATES: readonly UndoState[] = ["pending", "undoable", "abandoned", "undone"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => Number(v ?? 0);

/**
 * One charge the bank has taken and not posted yet: a `transactions` row whose
 * status is 'pending'.
 *
 * IT USED TO BE A ROW OF `pending_preview`, AND THAT TABLE IS DEAD. FOUND 2026-10-09:
 * finance.bank_pending answered "0 processing" while five charges were processing,
 * because nothing has written pending_preview since the bank sync started putting
 * in-flight charges straight into `transactions` with status 'pending'
 * (supabase/functions/plaid/index.ts — "Show charges the instant Plaid sees them"). The
 * table had 0 rows and the tool read it faithfully. finance.next_bills had already been moved off it
 * for the same reason (see the note there in tools.ts); this tool had not.
 *
 * MAPPED COLUMN BY COLUMN, and `raw_description` is not one of them. The bank's own
 * descriptor is the one string in a charge nothing in the app has ever cleaned, so
 * it is left in the row rather than carried into anything a tool could say.
 */
export interface PendingCharge {
  id: string;
  date: string;
  /** Always positive, the way the ledger stores every amount. The direction is in
   *  `kind`, exactly as finance.transaction reports it — flipping a sign here would be
   *  the door doing arithmetic on the one figure whose direction is the whole point. */
  amount: number;
  kind: "income" | "expense";
  /** The cleaned merchant name the sync wrote — never the raw descriptor. */
  description: string;
  categoryId: string | null;
  accountId: string | null;
}

/** One linked bank login. No secret, and nothing that names one. */
export interface BankConnection {
  owner: string;
  institution: string | null;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /**
   * When a fresh pull was last ASKED for, or null.
   *
   * It is a request, not a result: outstanding while it is newer than `lastSyncAt`,
   * and retired by a sync landing past it rather than by anything clearing it.
   * supabase/schema_v39_bank_refresh.sql is where that column and the job that
   * honours it are written down.
   *
   * WORKS BEFORE THE COLUMN EXISTS, deliberately. The read is `select("*")`, so on a
   * database where schema_v39 has not been run the key is simply not in the row,
   * `optStr` turns the missing value into null, and the freshness stamp reports
   * nothing outstanding — which is the truth there, because nothing can be asked for
   * yet. A door that needed a migration to answer at all would be a door that stops
   * answering the moment the code and the database get out of step.
   */
  refreshRequestedAt: string | null;
}

/** One recorded run of an unattended job, as job_runs stores it. */
export interface JobRunRow {
  job: string;
  finishedAt: string | null;
  ok: boolean | null;
  detail: Record<string, unknown> | null;
}

export interface FinanceExtras {
  /** The bank's in-flight charges — `transactions` whose status is 'pending' — newest
   *  first. */
  pendingCharges(): Promise<PendingCharge[]>;
  /** Every unattended run recorded in the last 30 days. */
  jobRuns(): Promise<JobRunRow[]>;
  /** Devices reachable per person, keyed by the push table's own owner spelling. */
  pushTargets(): Promise<Record<string, number>>;
  /** Every linked bank login and how its last sync went. */
  bankConnections(): Promise<BankConnection[]>;
  /**
   * This person's changes, newest first.
   *
   * WHY IT READS THE WHOLE TABLE. Rule 5 is "every table read is paged and fails
   * closed", and readAll is the one function that does that — it has no "give me
   * the newest ten" mode, because a bounded read cannot tell a short answer from a
   * truncated one, which is the exact failure the whole file exists for. So this
   * reads the person's rows, sorts, and slices in code. The table is one row per
   * assistant write, with a by-hand 180-day trim documented in
   * supabase/schema_v38_muse_undo.sql, so it stays in the low thousands. If it ever
   * does not, readAll refuses at MAX_ROWS rather than answering from part of it.
   *
   * A row whose steps are not a shape this door will run is DROPPED, not repaired
   * and not reported as undoable. That is the only sensible reading of it: if the
   * door would refuse to run the inverse, telling him it can undo that change is a
   * promise it cannot keep.
   */
  changes(person: Person): Promise<UndoRecord[]>;
  /**
   * Every "worth a look" key somebody has waved away, household-wide — or `known:
   * false` on a database where supabase/schema_v43_review_dismissals.sql has not been
   * run, so the tool can say it does not know rather than claim nothing was dismissed.
   *
   * Household-wide on purpose, not per person: the spec (§B.9) puts dismissals in one
   * table so a dismissal on one phone holds on both, and a suggestion is about the
   * household's ledger, not one person's view of it.
   */
  reviewDismissals(): Promise<{ known: boolean; keys: ReadonlySet<string> }>;
  /**
   * Every pay cycle's budget goal, household-wide — or `known: false` on a database where
   * supabase/schema_v45_cycle_budgets.sql has not been run, so finance.budget_status can
   * say "the standard budget, and the goal table is not set up yet" rather than claim
   * nobody set a goal. Added 2026-10-10 with finance.set_cycle_budget.
   *
   * The whole table, not one cycle: it is at most six rows a cycle, and the read door
   * wants the cycle in progress AND the ones a goal has already been set for ahead of
   * it. Which rows count for which cycle is cycleTargets()'s decision, not the loader's.
   */
  cycleBudgets(): Promise<{ known: boolean; rows: CycleBudget[] }>;
}

/** Memoise one promise per key, so a repeated read is the same read. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= make());
}

export function createFinanceExtras(db: Db): FinanceExtras {
  const pendingCharges = once(async () => {
    // Paged and fail-closed through readAll like every other read, filtered to the
    // pending rows ON THE SERVER (the count and every page carry the same filter), and
    // ordered by `id`, which totally orders the table so a page can neither skip nor
    // repeat a row. A sync swapping a pending row for its posted twin between the count
    // and a page makes them disagree, and the door then refuses rather than answering
    // from half a list — one retry, against a processing total that is quietly short.
    const rows = await readAll(db, { table: "transactions", orderBy: "id", eq: { status: "pending" } });
    return rows
      .map(
        (r): PendingCharge => ({
          id: str(r.id),
          date: str(r.date),
          amount: num(r.amount),
          kind: r.type === "income" ? "income" : "expense",
          description: str(r.description),
          categoryId: optStr(r.category_id),
          accountId: optStr(r.account_id),
        }),
      )
      // Newest first, then by id, so two charges on one day come back in the same
      // order on two identical calls — "the first one" must mean one charge.
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  });

  const bankConnections = once(async () => {
    const rows = await readAll(db, { table: "bank_connections", orderBy: "id" });
    return rows.map(
      (r): BankConnection => ({
        owner: str(r.owner),
        institution: optStr(r.institution),
        status: str(r.status) || "unknown",
        lastSyncAt: optStr(r.last_sync_at),
        lastError: optStr(r.last_error),
        consecutiveFailures: num(r.consecutive_failures),
        refreshRequestedAt: optStr(r.refresh_requested_at),
      }),
    );
  });

  /** Every unattended run recorded in the last while, newest first.
   *
   *  Read whole and fail closed like every other table, which is affordable because
   *  job_runs is pruned to 30 days by a scheduled job — four rows an hour from the
   *  two quarter-hour jobs is roughly 3,000 rows, well under readAll's ceiling. If it
   *  ever is not, the door refuses rather than answering from part of it, and a
   *  heartbeat that silently read half the runs would be the exact failure it exists
   *  to catch. */
  const jobRuns = once(async () => {
    const rows = await readAll(db, { table: "job_runs", orderBy: "id" });
    return rows.map(
      (r): JobRunRow => ({
        job: str(r.job),
        finishedAt: optStr(r.finished_at),
        ok: typeof r.ok === "boolean" ? r.ok : null,
        detail: (r.detail ?? null) as Record<string, unknown> | null,
      }),
    );
  });

  /** How many devices each person can actually be reached on.
   *
   *  The owner spelling is the table's own ("Gino", "Xinyan"), not the door's person
   *  key, and it is left as it is rather than mapped — webpush.ts matches on this
   *  string, so a mapping here would be a second opinion about who somebody is. */
  const pushTargets = once(async () => {
    const rows = await readAll(db, { table: "push_subscriptions", orderBy: "endpoint" });
    const out: Record<string, number> = {};
    for (const r of rows) {
      const owner = str(r.owner) || "unknown";
      out[owner] = (out[owner] ?? 0) + 1;
    }
    return out;
  });

  const changeCache = new Map<Person, Promise<UndoRecord[]>>();

  /** The dismissed keys. Added 2026-10-10 with finance.dismiss_suggestion.
   *
   *  THE PROBE FIRST, AND WHY IT IS NOT READING TWICE FOR NOTHING. On a database where
   *  schema_v43 has not been run, readAll alone would answer "nothing dismissed" — its
   *  count is a HEAD request, a HEAD gets an empty 404 for a table that is not there,
   *  and supabase-js reports that as success with no count, which the read adapter
   *  turns into zero rows (see isMissingTable in paging.ts). That would be the door
   *  saying `dismissals_known: true` about a table that does not exist. One GET of one
   *  row comes back with PostgREST's own sentence instead, and that sentence — and only
   *  that one — means "not set up yet". Any other failure of the probe is a table that
   *  cannot be read, and it fails closed like every other read here. */
  const reviewDismissals = once(async () => {
    const table = "review_dismissals";
    try {
      await db.select({ table, orderBy: "id" }).page(0, 0);
    } catch (e) {
      if (isMissingTable(e, table)) return { known: false, keys: new Set<string>() as ReadonlySet<string> };
      throw new LedgerUnreadable(table, `probe failed (${String((e as Error)?.message ?? e)})`);
    }
    const rows = await readAll(db, { table, orderBy: "id" });
    const keys = new Set<string>();
    for (const r of rows) {
      const k = str(r.key);
      if (k) keys.add(k);
    }
    return { known: true, keys: keys as ReadonlySet<string> };
  });

  /** Every cycle goal. Added 2026-10-10 with finance.set_cycle_budget.
   *
   *  THE SAME PROBE AS reviewDismissals, for the same reason: on a database where
   *  schema_v45 has not been run, readAll's HEAD count reads a missing table as an EMPTY
   *  one, and the door would say "no goal set" about a table that does not exist. One GET
   *  of one row carries PostgREST's own sentence for a missing table, and only that
   *  sentence means "not set up yet". Any other failure is a table that cannot be read,
   *  and it fails closed like every other read — a budget answered from half the goals
   *  would grade one line against the goal and the next against the standard budget,
   *  and nothing in the reply would say so. */
  const cycleBudgets = once(async () => {
    const table = "cycle_budgets";
    try {
      await db.select({ table, orderBy: "id" }).page(0, 0);
    } catch (e) {
      if (isMissingTable(e, table)) return { known: false, rows: [] as CycleBudget[] };
      throw new LedgerUnreadable(table, `probe failed (${String((e as Error)?.message ?? e)})`);
    }
    const rows = await readAll(db, { table, orderBy: "id" });
    return { known: true, rows: rows.map(toCycleBudget) };
  });

  return {
    pendingCharges,
    bankConnections,
    jobRuns,
    pushTargets,
    reviewDismissals,
    cycleBudgets,
    changes(person) {
      const hit = changeCache.get(person);
      if (hit) return hit;
      const p = (async () => {
        const rows = await readAll(db, { table: "muse_undo", orderBy: "token", eq: { person } });
        const out: UndoRecord[] = [];
        for (const r of rows) {
          let steps: UndoStep[];
          try {
            steps = checkSteps(r.steps);
          } catch {
            continue;
          }
          out.push({
            token: str(r.token),
            at: str(r.at),
            person: str(r.person),
            tool: str(r.tool),
            summary: str(r.summary),
            steps,
            // A state the door does not know is read as `pending`, which is the
            // cautious end: "I cannot prove what happened". Never as undoable —
            // that would offer to reverse a change on the strength of a value
            // nothing here wrote.
            state: STATES.includes(r.state as UndoState) ? (r.state as UndoState) : "pending",
            undoneAt: optStr(r.undone_at),
            undoneBy: optStr(r.undone_by),
          });
        }
        return out.sort((a, b) => b.at.localeCompare(a.at));
      })();
      changeCache.set(person, p);
      return p;
    },
  };
}
