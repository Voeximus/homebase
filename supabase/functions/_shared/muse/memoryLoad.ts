// Reading the memory table, paged and fail-closed like every other read.
//
// It is its own file rather than three more lines inside load.ts for one reason:
// load.ts is where the finance and health loaders live and where the next of them
// will be added, and a memory read has nothing to do with either. load.ts extends
// its `Loader` with this one and spreads it in — two lines there, everything else
// here.
//
// WHY THE WHOLE TABLE. Rule 5 is "every table read is paged and fails closed", and
// `eq` filters are equality only, so there is no way to ask Postgres for "not
// forgotten". This reads all of one person's rows and filters in code, which is
// cheap — LIVE_MAX caps a person at 200 live memories, and forgotten rows are the
// only other thing in there. It also buys something: a recall of a key he told the
// assistant to forget can say WHEN it was forgotten, instead of answering as if it
// had never existed, which is what makes the undo discoverable.

import { readAll, type Db } from "./paging.ts";
import { toMemoryRow, type MemoryRow } from "./memory.ts";
import type { Person } from "./auth.ts";

export interface MemoryLoader {
  /** Every memory row for one person, forgotten ones included. Memoised for the
   *  life of one request, so two tools in one reply cannot disagree. */
  memories(person: Person): Promise<MemoryRow[]>;
}

export function createMemoryLoader(db: Db): MemoryLoader {
  const cache = new Map<Person, Promise<MemoryRow[]>>();
  return {
    memories(person: Person) {
      const hit = cache.get(person);
      if (hit) return hit;
      const p = (async () => {
        // Ordered by `id`, which is the paging key — a total order, so a page
        // cannot skip or repeat a row. The order a person would read them in
        // (kind, then key) is applied in code by liveMemories(), because that is a
        // presentation choice and this is a correctness one.
        const rows = await readAll(db, { table: "muse_memory", orderBy: "id", eq: { person } });
        return rows.map(toMemoryRow);
      })();
      cache.set(person, p);
      return p;
    },
  };
}
