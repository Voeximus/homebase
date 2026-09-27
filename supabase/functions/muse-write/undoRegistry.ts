// THE ONE REGISTRY OF NAMED INVERSES, merged at module load.
//
// WHY THIS FILE EXISTS, and it is the last seam of phase 2 to close.
//
// Phase 2 arrived as three branches, and each of them answered "how do we undo this?"
// on its own:
//
//   · the finance half built the real core — supabase/schema_v38_muse_undo.sql, the
//     `muse_undo` table, four DATA step kinds over an allowlist of tables AND columns,
//     `system.undo` and `system.changes`. Its safety property is the good one: the door
//     can only write a column it can also put back;
//   · the health half wrote `undoContract.ts` — the shape it coded against — plus 18
//     named handlers in `HEALTH_UNDO`, because a day's meals are one JSON document and
//     taking back the one meal the door added, while keeping the one the phone added a
//     second later, is not a column write;
//   · the memory store gave itself domain-level inverses instead: `memory.forget` and
//     `memory.restore` are tools he can ask for by name, with the previous wording kept
//     in a column, so it needs no token at all.
//
// At the merge, the first two did not meet. `HEALTH_UNDO` was registered nowhere,
// `mergeUndo` was never called, and every health write handed back a token of the shape
// `tool~idemKey` while `system.undo` accepts `u-4k7m9qt2` and looks it up in a table the
// health writes never wrote to. So the door was telling an assistant "if he says undo,
// send the token back" for 22 tools whose tokens nothing could act on — the worst shape
// a bug can have here, because the failure is a promise, and the person only finds out
// at the moment they want the change reversed.
//
// SO THERE IS ONE CORE, and this is the join: the health handlers became a fifth step
// kind, `run_handler`, recorded in the same `muse_undo` row under the same minted token
// as every other change. One table, one token shape, one `system.undo`, and
// `system.changes` lists a logged meal beside a categorised charge.
//
// WHAT mergeUndo BUYS. It throws when two registries claim one `kind`, at module load,
// which takes the door down at deploy rather than resolving it by whichever import came
// second. That matters more than it looks: a `kind` is a NAME IN A DATABASE ROW, so two
// handlers under one name would take different before-states, and the wrong one would be
// handed a shape it would either reject or — worse — half understand.

import { mergeUndo, type UndoRegistry } from "./undoContract.ts";
import { HEALTH_UNDO } from "./healthTools.ts";

/**
 * Every named inverse the write door can run.
 *
 * Only the health half is here today, and that is not an oversight: the finance writes
 * are all expressible as data steps, which is stricter and therefore preferred — reach
 * for a handler only when the row is a document rather than columns. The memory writes
 * need neither, because forgetting is a soft delete and `memory.restore` is a tool.
 */
export const UNDO_REGISTRY: UndoRegistry = mergeUndo(HEALTH_UNDO);

/** The names, so a test can prove no tool returns an inverse nothing knows how to run. */
export const UNDO_KINDS: readonly string[] = Object.keys(UNDO_REGISTRY);
