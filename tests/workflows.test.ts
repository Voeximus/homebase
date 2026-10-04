// The deploy workflow has to be a file GitHub can read.
//
// WHAT HAPPENED. A `find -printf '%f\n'` was written into .github/workflows/deploy.yml
// with a REAL newline inside the quotes where the two-character escape was meant.
// Inside a YAML block scalar that newline ends the line, the quote never closes, and
// the whole file stops parsing. GitHub's answer to that is a run that fails in 0
// seconds with "This run likely failed because of a workflow file issue" and NO LOG —
// so nothing reported a broken build, because there was no build.
//
// It went unnoticed from 15 September to 4 October. In that window the app on GitHub
// Pages was never rebuilt and no edge function was ever deployed by CI; the doors are
// only current because they were deployed by hand. Three weeks of pushes went green
// in the terminal and nowhere else.
//
// WHY A HAND-ROLLED CHECK AND NOT A YAML LIBRARY. The repo has no YAML parser and this
// is not worth a dependency: the failure is specific and has a shape. A workflow is
// YAML whose `run:` blocks are shell, and the one way this file has ever broken is a
// quote opened on a line that does not close before the line ends. That is checkable
// with the string functions already here, and a check nobody has to install is a check
// that still runs in a year.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = ".github/workflows";
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

/** Quotes outside a comment, counted per line. Shell inside a block scalar is still
 *  one YAML line, and a line that ends mid-quote is the bug. */
function unbalanced(line: string): string | null {
  // A whole-line comment is prose; apostrophes in it are fine ("doesn't").
  if (/^\s*#/.test(line)) return null;
  let single = 0;
  let double = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++; // an escaped character is never a delimiter
      continue;
    }
    if (c === "'" && double % 2 === 0) single++;
    else if (c === '"' && single % 2 === 0) double++;
    // Once both are closed, a `#` starts a trailing comment and the rest is prose.
    else if (c === "#" && single % 2 === 0 && double % 2 === 0) break;
  }
  if (single % 2 !== 0) return "single";
  if (double % 2 !== 0) return "double";
  return null;
}

describe("the workflow files are readable by GitHub", () => {
  it("there are some, so this cannot pass by finding nothing", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} closes every quote on the line that opens it`, () => {
      const lines = readFileSync(`${DIR}/${f}`, "utf8").split(/\r?\n/);
      const bad = lines
        .map((l, i) => ({ n: i + 1, l, kind: unbalanced(l) }))
        .filter((r) => r.kind !== null)
        .map((r) => `line ${r.n} opens a ${r.kind} quote and never closes it: ${r.l.trim().slice(0, 72)}`);
      expect(bad).toEqual([]);
    });

    it(`${f} has no tab characters`, () => {
      // YAML forbids tabs for indentation outright, and an editor that inserts one
      // produces the same silent 0-second failure.
      const lines = readFileSync(`${DIR}/${f}`, "utf8").split(/\r?\n/);
      const tabs = lines.map((l, i) => (l.includes("\t") ? i + 1 : 0)).filter(Boolean);
      expect(tabs).toEqual([]);
    });
  }

  it("deploy.yml still derives the function list rather than naming them", () => {
    // The list was seven hand-typed names while twelve functions existed on disk, and
    // the four it skipped were the bank feed and both of Muse's doors. The derivation
    // is the fix; this is here so a future edit cannot quietly type the names back.
    const yml = readFileSync(`${DIR}/deploy.yml`, "utf8");
    expect(yml).toMatch(/find supabase\/functions .*-printf '%f\\n'/);
    expect(yml).toMatch(/refusing to report success/);
  });
});
