// The two things every tool file on the read door needs: what a reply is made of,
// and how a tool refuses.
//
// WHY THEY LIVE HERE RATHER THAN IN tools.ts. They were in tools.ts, which was
// right while tools.ts was the only tool file. The memory store adds a second one,
// and a second tool file importing a class out of the first makes tools.ts import
// memoryTools.ts and memoryTools.ts import tools.ts — a cycle whose failure mode is
// not a compile error but an uninitialised binding at module load, depending on
// which file the process happened to reach first. That is the kind of bug that
// works in the tests and fails in the deployed function.
//
// So the two shared pieces moved down here, where both tool files can import them
// and neither imports the other. tools.ts re-exports both, so handler.ts and
// tests/museRead.test.ts keep importing them from where they always did.

/**
 * Anything a reply may be made of. A tool's `run` returns `{ [k: string]: Json }`,
 * so the compiler refuses a Date, a class instance or an undefined — each of which
 * JSON.stringify would quietly turn into something else on the way out.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A caller sent something the tool cannot answer. A 400, not a 500 — handler.ts
 *  catches this by identity, which is the whole reason there may only ever be one
 *  of it. */
export class BadArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArgs";
  }
}
