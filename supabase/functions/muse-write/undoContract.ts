// UNDO — the contract, not the core.
//
// READ THIS FIRST IF YOU ARE MERGING PHASE 2
//
// Phase 2 flips the rule the write door was built on. Phase 1 exposed what was
// safe and made everything risky wait for a tap in the app. His instruction for
// this phase is the opposite: "Muse has to have every functionality given in the
// app and the app must become a database for patterns and information storage."
// What makes that safe is not a smaller list of verbs — it is that every change
// writes down what was there before it, so "undo that" is a real answer.
//
// This file is the SEAM, written by the health/workout half of phase 2 so its
// tools had something to compile against. The undo CORE — where the before-state
// is stored, how a token is handed out and looked up, what stops a change being
// undone twice, and the `undo` / `what did you change` tools themselves — belongs
// to the phase's undo work and is NOT here. Four things the core owes this file,
// and nothing else:
//
//   1  STORE the UndoRecord a tool returns, against the call that made it. The
//      audit row already exists and is already keyed on (person, tool, idem_key),
//      so the natural home is muse_audit.result and the natural token is
//      undoToken(tool, idemKey) below. No new table is needed for that; a column
//      or a flag IS needed for item 3.
//   2  HAND the token back in the reply, with `undo.says`, so the assistant can
//      repeat the sentence and the person can say "undo that".
//   3  REFUSE A SECOND UNDO of the same change. Undoing twice is how a restore
//      becomes a new wrong write: `restore-weight` would put back a weight that
//      is already back, and `remove-meal` would find nothing and report success.
//      One flag on the audit row, checked before dispatch.
//   4  DISPATCH to the registry: look the record's `kind` up in the merged
//      registry and call apply(). HEALTH_UNDO in healthTools.ts is one half of it.
//
// If the core lands with a different shape, this file is the only thing the health
// tools need re-pointed: they return UndoRecord values and register handlers, and
// they never reach into the audit log themselves.

import type { Json } from "../_shared/muse/args.ts";
import type { Ctx, ToolOutcome } from "./kit.ts";

/**
 * What a change wrote down about the state it replaced.
 *
 * `before` is PLAIN JSON and that is load-bearing, not tidiness: it is stored in a
 * database row and read back in a later request, by a different invocation of the
 * function, possibly after a deploy. A closure could not survive that, so the
 * inverse cannot be a function captured at write time — it has to be a `kind` that
 * names code which still exists, plus the data that code needs.
 */
export interface UndoRecord {
  /** Which inverse to run. Keys the registry. */
  kind: string;
  /** Everything the inverse needs, and nothing it does not. */
  before: Json;
  /** What undoing will do, in one plain sentence, so it can be read back before it
   *  happens. Written at write time because that is when the before-state is
   *  known — a sentence derived later would be describing a guess. */
  says: string;
  /**
   * Set when the restore can be overwritten by something outside this door, and it
   * says by what. An account balance re-anchored by a bank sync is the finance
   * case; on the health side it is a day document or a session document that the
   * phone is also writing. The reply says this out loud rather than promising an
   * undo that holds for ever.
   */
  fragile?: string;
}

/**
 * The code that puts one kind of change back.
 *
 * It returns a ToolOutcome, so an undo that cannot be honoured is a REFUSAL with a
 * sentence rather than a silent no-op. That distinction is the whole point: "I put
 * it back" and "I could not, because the row has moved on since" are different
 * answers and an assistant must be able to say which.
 */
export interface UndoHandler {
  /** One line, for the description of the door. */
  does: string;
  apply(before: Json, ctx: Ctx): Promise<ToolOutcome>;
}

export type UndoRegistry = Readonly<Record<string, UndoHandler>>;

/** The separator. Not a character a tool name or an idempotency key can contain:
 *  tool names are `[a-z_.]`, and the handler's own check bounds a key to
 *  `[A-Za-z0-9._:-]`. So a token splits back apart exactly one way. */
const SEP = "~";

/**
 * The token an assistant repeats to undo a change.
 *
 * It is the tool that made the change and the idempotency key it was made under,
 * which is exactly what the audit log is already keyed on — so looking one up is a
 * read of a row that already exists, and there is no second place a change and its
 * inverse could disagree about which change is which.
 *
 * It is NOT a secret and must not be treated as one: the door already knows who is
 * asking from the key in the header, and an undo can only reach a change that same
 * person made. A guessed token belonging to the other person is refused by the
 * person check, not by the token being hard to guess.
 */
export function undoToken(tool: string, idemKey: string): string {
  return `${tool}${SEP}${idemKey}`;
}

export function parseUndoToken(token: unknown): { tool: string; idemKey: string } | null {
  if (typeof token !== "string") return null;
  const i = token.indexOf(SEP);
  if (i <= 0 || i === token.length - 1) return null;
  const tool = token.slice(0, i);
  const idemKey = token.slice(i + 1);
  if (!/^[a-z][a-z_.]{1,60}$/.test(tool)) return null;
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(idemKey)) return null;
  return { tool, idemKey };
}

/** Merge the registries the two halves of phase 2 define. A `kind` defined twice
 *  is a bug worth stopping at load rather than resolving by whichever import came
 *  second — the two handlers would take different before-states. */
export function mergeUndo(...parts: UndoRegistry[]): UndoRegistry {
  const out: Record<string, UndoHandler> = {};
  for (const part of parts) {
    for (const [kind, handler] of Object.entries(part)) {
      if (out[kind]) throw new Error(`two undo handlers claim "${kind}"`);
      out[kind] = handler;
    }
  }
  return out;
}
