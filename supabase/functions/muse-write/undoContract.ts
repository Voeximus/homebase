// UNDO — what a NAMED inverse is, and how the registry of them is built.
//
// WHAT THIS FILE WAS, AND WHY IT SAYS SOMETHING ELSE NOW. It was written by the health
// half of phase 2 as a SEAM: the undo core did not exist on that branch, so this file
// described the shape its 22 tools coded against and listed four things the core would
// owe it. All four are paid now, and the file is the contract for the part that stayed —
// an inverse that is CODE rather than data.
//
// WHERE THE CORE IS. _shared/muse/undo.ts, backed by supabase/schema_v38_muse_undo.sql.
// It holds the token (minted, `u-4k7m9qt2`), the `muse_undo` row, the four states, and
// five step kinds. Four of those are DATA over an allowlist of tables AND columns, which
// is the stricter thing and the one to reach for: the door can only write a column it can
// also put back. The fifth, `run_handler`, names a handler in this file's registry, and it
// exists because a day's meals are one JSON document — taking back the one meal the door
// added, while keeping the one the phone added a second later, is not a column write.
//
// SO THE PIECES, IN ORDER, for a health write:
//   1  the tool captures its before-state and returns an `UndoRecord` (below);
//   2  handler.ts mints a token and writes ONE `run_handler` step into `muse_undo`;
//   3  `system.changes` lists it beside a categorised charge, off the same table;
//   4  `system.undo` looks the token up and dispatches through UNDO_REGISTRY
//      (undoRegistry.ts) back into `apply()` below.
//
// THE ONE THING THIS IS WEAKER ABOUT, said out loud. A finance tool writes its row BEFORE
// it changes anything, which is what lets `pending` mean "the door stopped mid-call and
// nobody knows whether it landed". A tool that returns a record afterwards cannot have
// that: the row is written after the change and goes straight to `undoable`, so a crash
// in between loses the record and keeps the change. It is the narrower of the two gaps
// that were available — the alternative was 22 tools with no undo at all.

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
