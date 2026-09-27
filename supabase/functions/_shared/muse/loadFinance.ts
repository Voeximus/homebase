// The tables the finance parity tools need beyond the ledger bundle.
//
// load.ts owns `appData()` — the seven tables the app's maths modules take. Three
// more tables are read by Phase 2's tools and by nothing else, so they live here:
// the bank's in-flight charges, the bank connections' health, and the change log.
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
// three tables have no app-side type: `pending_preview` and `bank_connections` are
// read straight into JSX in src/views, and `muse_undo` is the door's own table. So
// their shapes are declared next to their mappers, where a reader can see both at
// once.

import type { Db } from "./paging.ts";
import { readAll } from "./paging.ts";
import type { Person } from "./auth.ts";
import { checkSteps, type UndoRecord, type UndoState, type UndoStep } from "./undo.ts";

const STATES: readonly UndoState[] = ["pending", "undoable", "abandoned", "undone"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => Number(v ?? 0);

/** One in-flight bank charge. Display-only: it never reaches the ledger, which is
 *  what stops it being counted twice when it posts. */
export interface PendingCharge {
  date: string;
  /** SIGNED as the bank reports it — negative is money going out. Not flipped
   *  here: the app reads the sign, and a door that normalised it would be the door
   *  doing arithmetic on the one figure whose direction is the whole point. */
  amount: number;
  description: string;
  categoryId: string | null;
  owner: string | null;
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
}

export interface FinanceExtras {
  /** The bank's in-flight charges, newest first. */
  pendingCharges(): Promise<PendingCharge[]>;
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
}

/** Memoise one promise per key, so a repeated read is the same read. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= make());
}

export function createFinanceExtras(db: Db): FinanceExtras {
  const pendingCharges = once(async () => {
    const rows = await readAll(db, { table: "pending_preview", orderBy: "id" });
    return rows
      .map(
        (r): PendingCharge => ({
          date: str(r.date),
          amount: num(r.amount),
          description: str(r.description),
          categoryId: optStr(r.category_id),
          owner: optStr(r.owner),
          accountId: optStr(r.account_id),
        }),
      )
      .sort((a, b) => b.date.localeCompare(a.date));
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
      }),
    );
  });

  const changeCache = new Map<Person, Promise<UndoRecord[]>>();

  return {
    pendingCharges,
    bankConnections,
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
