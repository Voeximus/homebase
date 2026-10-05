// A column that is mapped but never selected reads as null, silently, forever.
//
// FOUND ON 2026-10-04. `readCharge` mapped `flowOverride: optStr(data.flow_override)`
// and its `.select(...)` never asked for `flow_override`. PostgREST returns only the
// columns you name, so `data.flow_override` was `undefined` on every row and every
// charge came back as "nobody has corrected this" — including the four that had just
// been corrected. Two things broke without a word:
//
//   1. `finance.set_flow { flow: "clear" }` could never work. Its guard compares the
//      stored value to the requested one, read null, and refused with "that charge has
//      no correction on it already" — about a charge whose correction was right there
//      in the table.
//   2. Every undo row recorded `was: null`. Undoing a correction that REPLACED an
//      earlier one would have wiped it rather than putting it back, which is the one
//      thing the undo contract exists to promise.
//
// WHY THIS IS A STATIC GUARD AND NOT A UNIT TEST. The fake db in the write-door tests
// hands back whole JavaScript objects, so every column is present whether the select
// asked for it or not — the bug is INVISIBLE to it by construction. That is not a
// hypothetical: `finance.settle_reimbursable` had also never worked against a real
// database for the same reason, and its tests were green. Only the source can say
// whether the select and the mapping agree, so only the source is read here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "supabase/functions/muse-write/dbFinanceSupabase.ts",
  "supabase/functions/muse-write/dbSupabase.ts",
  "supabase/functions/muse-write/dbMemory.ts",
];

/**
 * Columns a mapper reads off a PostgREST row, by the shapes this codebase uses:
 * `str(data.foo)`, `optStr(r.foo)`, `num(data.foo)`, `!!r.foo`, `data.foo ?? null`,
 * `r.foo === "income"`.
 *
 * Snake_case only. A camelCase property is a field on something the code built itself,
 * not a column it asked the database for, and demanding those appear in a select would
 * make this guard fire on correct code — which is how a guard gets switched off.
 *
 * `data` and `r` only, never `row`. The first version included `row` and reported
 * updateReminderIfUnchanged for "mapping due_at and canceled_at without selecting them"
 * — but `row` there is the PATCH the method assembles to send UP, so those two lines
 * are writes, not reads. A guard that cries wolf about correct code gets deleted, which
 * costs more than the bug it was built for.
 */
const COLUMN_READ = /\b(?:data|r)\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/** Every column named inside a `.select("…")`, including the `"a, b" + "c, d"` form. */
const SELECT_CALL = /\.select\(\s*((?:"[^"]*"|'[^']*'|\s|\+|\/\/[^\n]*|\n)*?)[,)]/g;

/**
 * Split a file into `async name(args) {` sections.
 *
 * Scoped per method on purpose. A file-wide check would pass as soon as ANY select in
 * the file happened to name the column, which is exactly the false negative here:
 * `flow_override` appears in this file's INSERT_COLUMNS list, so a file-wide check
 * would have called readCharge fine.
 */
function methodsOf(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/^\s*async (\w+)\(/gm)];
  return starts.map((m, i) => ({
    name: m[1],
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : src.length),
  }));
}

function selectedColumns(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(SELECT_CALL)) {
    // Strip the string quotes, the `+` joins and any interleaved comment lines, then
    // take what is left as a comma list. `count: "exact"` sits after a comma outside
    // the string, so the regex above stops before it.
    const inner = m[1]
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/["'+]/g, " ");
    for (const part of inner.split(",")) {
      const col = part.trim().split(/[\s(]/)[0];
      if (col) out.add(col);
    }
  }
  return out;
}

describe("every column a mapper reads is a column its select asked for", () => {
  for (const file of FILES) {
    const src = (() => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    })();
    if (src === null) continue;

    for (const { name, body } of methodsOf(src)) {
      const reads = new Set([...body.matchAll(COLUMN_READ)].map((m) => m[1]));
      if (reads.size === 0) continue;
      const selected = selectedColumns(body);
      // A method that reads columns but runs no select of its own is reading a row
      // somebody handed it. Nothing to check, and nothing to assume.
      if (selected.size === 0) continue;
      // `*` asks for everything, so every read is covered.
      if (selected.has("*")) continue;

      it(`${file.split("/").pop()} › ${name}`, () => {
        const missing = [...reads].filter((c) => !selected.has(c)).sort();
        expect(missing, `${name} maps ${missing.join(", ")} but never selects them`).toEqual([]);
      });
    }
  }
});

describe("the two columns this was written for", () => {
  const src = readFileSync("supabase/functions/muse-write/dbFinanceSupabase.ts", "utf8");
  const byName = new Map(methodsOf(src).map((m) => [m.name, m.body]));

  it("readCharge selects flow_override, so a correction can be read back and cleared", () => {
    expect(selectedColumns(byName.get("readCharge")!)).toContain("flow_override");
  });

  it("billPayments selects flow_override, which it also maps", () => {
    expect(selectedColumns(byName.get("billPayments")!)).toContain("flow_override");
  });
});
