// One row per call, reads included.
//
// The plan's §8 lists "a web-browsing agent holding a finance connector" as a risk
// it accepts rather than solves, and the audit log is one of the four things that
// makes accepting it reasonable — built in the first phase rather than promised for
// later, so that on any day he can open his phone and see everything either
// assistant asked for.
//
// WHAT IS NOT LOGGED, AND WHY
//
//   · No dollar amounts in the arguments. That is a Phase 1 gate ("no dollar
//     amounts in the logged arguments"), and it is free to honour on the read
//     door because no read tool takes an amount. `redactArgs` enforces it anyway,
//     because the next tool might.
//   · No reply body. `muse_audit.result` gets the reply's SIZE, not its contents.
//     The log is readable by any signed-in household session, and a second copy of
//     the ledger inside a log table is a second place for it to leak from. "How big
//     was the answer" is what a size question needs; "what was in it" is a
//     question the app itself answers better.
//
// WHEN THE LOG ITSELF FAILS. The row is written after the reply is computed, and a
// failed insert does NOT fail the read: it degrades loudly instead — `audit:
// "not recorded"` in the reply body and a console error. Refusing a harmless read
// because a log row did not land trades something that works for nothing.
//
// THE WRITE DOOR MUST NOT COPY THAT. A write whose audit row did not land is a
// change nobody can account for and an Idempotency-Key nobody can honour, so the
// write door should fail closed where this one degrades. Said here because the two
// doors share this file.

import { scrub } from "./scrub.ts";
import type { Person } from "./auth.ts";

export type Outcome = "ok" | "denied" | "rate_limited" | "error";

export interface AuditRow {
  person: Person | null;
  door: "read" | "write";
  tool: string;
  args: Record<string, unknown>;
  outcome: Outcome;
  /** Milliseconds the call took, for the CPU-budget measurement in Phase 2. */
  ms: number;
  /** Byte size of the reply that went out. */
  bytes: number;
}

export interface AuditSink {
  record(row: AuditRow): Promise<void>;
}

/** Keys whose VALUE is money by name. None exist on the read door today; the rule
 *  is here so adding one cannot quietly put an amount in the log. */
const MONEY_KEY = /amount|balance|price|total|cost|owed|pay/i;

/**
 * The arguments, safe to store.
 *
 * Strings are scrubbed like any other outbound string — an argument is a string
 * somebody typed, and it comes back out of the log onto a screen. Numbers survive
 * only as integers, and only under a key that is not money-shaped: a day count is
 * worth logging, a dollar figure is not. Anything else becomes its type name, so
 * the log records that an argument was passed without recording what was in it.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (MONEY_KEY.test(k)) {
      out[k] = "<redacted>";
      continue;
    }
    if (typeof v === "string") {
      out[k] = scrub(v) ?? "<unprintable>";
      continue;
    }
    if (typeof v === "number") {
      out[k] = Number.isInteger(v) ? v : "<redacted>";
      continue;
    }
    if (typeof v === "boolean" || v === null) {
      out[k] = v;
      continue;
    }
    out[k] = `<${typeof v}>`;
  }
  return out;
}

/** An audit sink over one table, using the same narrow insert seam the rest of the
 *  door uses — so nothing here has to import a Supabase client. */
export interface AuditInsert {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
}

export function createAuditSink(db: AuditInsert): AuditSink {
  return {
    async record(row: AuditRow) {
      await db.insert("muse_audit", {
        person: row.person,
        door: row.door,
        tool: row.tool,
        args: redactArgs(row.args),
        outcome: row.outcome,
        ms: Math.round(row.ms),
        // The table's `result` column is "what was returned, for a replay". For a
        // read, the honest answer is its size — see the note at the top.
        result: { bytes: row.bytes },
      });
    },
  };
}
