// Guards against the two categorizer copies silently drifting apart.
//
// The live Plaid feed classifies transactions with the Deno EDGE copy
// (supabase/functions/_shared/*), while CSV import + the in-app UI use the
// CLIENT copy (src/lib/*). They must stay logically identical — a past drift
// left the edge copy mapping spend to a deleted `health` category in
// production. This runs in `npm run build`, so CI fails before such a drift
// can ship. The ONLY allowed difference is the Deno `.ts` import extension.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PAIRS = [
  ["src/lib/categorize.ts", "supabase/functions/_shared/categorize.ts"],
  ["src/lib/categorizeData.ts", "supabase/functions/_shared/categorizeData.ts"],
  // The GTIN maths decides WHICH numbers a scanned barcode is looked up under.
  // The client validates the check digit before it accepts a read; the edge
  // function walks the same variant list across every food source. A drift here
  // means the app accepts a code the server will not find.
  ["src/lib/gtin.ts", "supabase/functions/_shared/gtin.ts"],
  // The label verifier runs TWICE: on the phone to decide what a person must
  // look at, and again inside food-label-save before a camera read is shared
  // into the household food cache. The server must never trust the phone's
  // verdict — but it only means something if it is the SAME verdict code.
  ["src/lib/labelScan/types.ts", "supabase/functions/_shared/labelScan/types.ts"],
  ["src/lib/labelScan/rules.ts", "supabase/functions/_shared/labelScan/rules.ts"],
  ["src/lib/labelScan/verify.ts", "supabase/functions/_shared/labelScan/verify.ts"],
  ["src/lib/labelScan/food.ts", "supabase/functions/_shared/labelScan/food.ts"],
];

// Normalize away the legitimate, runtime-only differences before comparing:
// line endings, and Deno's `.ts` extension on relative imports.
const norm = (s) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/(from\s+"\.\/[A-Za-z0-9_]+)\.ts"/g, '$1"')
    .trimEnd();

let drift = false;
for (const [client, edge] of PAIRS) {
  const a = norm(readFileSync(client, "utf8"));
  const b = norm(readFileSync(edge, "utf8"));
  if (a === b) continue;
  drift = true;
  const al = a.split("\n");
  const bl = b.split("\n");
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  console.error(`\n✗ categorizer drift between:\n    ${client}\n    ${edge}`);
  console.error(`  first difference at line ${i + 1}:`);
  console.error(`    client: ${JSON.stringify(al[i] ?? "<eof>")}`);
  console.error(`    edge:   ${JSON.stringify(bl[i] ?? "<eof>")}`);
  console.error(`  → keep them identical (only the './categorizeData' import may differ by a .ts extension).`);
}

if (drift) {
  console.error("\nCategorizer copies are out of sync. Fix before building.\n");
  process.exit(1);
}
console.log("✓ categorizer copies in sync");

// ── the Muse doors ───────────────────────────────────────────────────────────
// Two more guards, run from here so `npm run build` covers them without the build
// script growing a third step.

// 1. The generated shared copies. The PAIRS list above cannot hold them: it
//    normalises exactly one difference — a same-folder `./name.ts` import — and a
//    dozen of those modules import `"../types"`, a parent path that has to be
//    spelled differently in a flat edge folder. So they get their own generator,
//    and this runs it in --check mode.
try {
  execFileSync(process.execPath, ["scripts/gen-muse-shared.mjs", "--check"], { stdio: "inherit" });
} catch {
  process.exit(1);
}

// 2. THE DOORS MUST NOT READ A CLOCK. The app's shared modules default to the
//    machine's own calendar date when you do not hand them one, and an edge
//    function runs in UTC — so from 5 PM Arizona onward a fired default answers
//    about TOMORROW: a different pay cycle, different bills due, and on the last
//    evening of a month, the next month. He works nights, so that is most of his
//    waking day. The only clock reading allowed in either door is inside
//    _shared/muse/az.ts, which builds the date from the IANA zone.
//
//    Comments are stripped before scanning, so the rule can be explained in the
//    files it applies to.
const CLOCK_DIRS = ["supabase/functions/muse-read", "supabase/functions/muse-write"];
const CLOCK_EXEMPT = new Set(["supabase/functions/_shared/muse/az.ts"]);
const CLOCK_PATTERNS = [/new Date\(/, /Date\.now\(/, /todayISO\(/, /todayStr\(/, /currentMonthKey\(/];

// The doors' own hand-written files: their function folders, plus the top level of
// _shared/muse. NOT _shared/muse/lib, which is the generated copy of the app's own
// modules — those read the clock by design, which is exactly why every entry point
// is handed one explicitly instead.
function doorFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // the write door does not exist yet
    }
    for (const name of entries) {
      const path = join(dir, name).replace(/\\/g, "/");
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.push(path);
    }
  };
  for (const dir of CLOCK_DIRS) walk(dir);
  try {
    for (const name of readdirSync("supabase/functions/_shared/muse")) {
      const path = `supabase/functions/_shared/muse/${name}`;
      if (name.endsWith(".ts") && !statSync(path).isDirectory()) out.push(path);
    }
  } catch {
    /* the doors do not exist yet */
  }
  return out.filter((p) => !CLOCK_EXEMPT.has(p));
}

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

let clockDrift = false;
for (const path of doorFiles()) {
  const code = stripComments(readFileSync(path, "utf8"));
  const lines = code.split("\n");
  lines.forEach((line, i) => {
    for (const rx of CLOCK_PATTERNS) {
      if (!rx.test(line)) continue;
      clockDrift = true;
      console.error(`\n✗ ${path}:${i + 1} reads a clock:`);
      console.error(`    ${line.trim()}`);
    }
  });
}
if (clockDrift) {
  console.error(
    "\n  → build the Arizona `now` once with nowAZ() and pass it in. The only clock\n" +
      "    reading allowed in a door is inside _shared/muse/az.ts.\n",
  );
  process.exit(1);
}
console.log("✓ muse doors read no clock");

// 3. THE DOORS TYPE-CHECK. `tsconfig.app.json` ends with `"include": ["src"]`, so
//    nothing in the repo has ever type-checked supabase/functions — every edge
//    function has shipped unchecked. For a door that speaks numbers into a chat
//    that is the wrong place to have no compiler: a dropped optional field in a
//    row mapper is not a crash, it is a quietly different number. The door has its
//    own tsconfig, and it is run from here so `npm run build` covers it.
const MUSE_TSCONFIG = "supabase/functions/_shared/muse/tsconfig.json";
try {
  const require = createRequire(import.meta.url);
  // typescript's package root, then its own bin — resolved rather than assumed,
  // because node_modules is hoisted and a git worktree does not have its own.
  const tsc = join(dirname(dirname(require.resolve("typescript"))), "bin", "tsc");
  execFileSync(process.execPath, [tsc, "--noEmit", "-p", MUSE_TSCONFIG], { stdio: "inherit" });
  console.log("✓ muse doors type-check");
} catch {
  console.error(`\n✗ ${MUSE_TSCONFIG} did not type-check.\n`);
  process.exit(1);
}
