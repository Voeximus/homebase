// Copies the app's real maths modules into the Muse doors' Deno folder.
//
// WHY A GENERATOR AND NOT A COPY
//
// The doors must answer with the SAME numbers the screens show. The repo already
// knows what happens when an edge function re-implements the app's maths by hand:
// cron-notify's own comments record a push that said "Electric $85" while every
// screen in the app said $100, a semiannual bill pinging the phones every month,
// and three bills announced as due tonight that were not due at all. Every one of
// those was a hand-written mirror drifting from the real function.
//
// So the doors import the real modules. A Deno edge function cannot reach into
// `src/`, so the files are copied — and a copy anybody can edit is the same
// drift with an extra step. This script is the only writer. `--check` runs in
// `npm run build` (via scripts/check-categorizer-sync.mjs) and fails the build if
// a generated file on disk differs from its source by so much as a space.
//
// The existing drift guard (check-categorizer-sync.mjs PAIRS) could not take
// these files: it normalises exactly one difference, a same-folder `./name.ts`
// import, and twelve of these modules import `"../types"` — a parent path that
// has to be spelled differently in a flat edge folder. Adding them to PAIRS would
// fail the build on the first commit, forever. Hence a separate folder, a separate
// script, and the seven existing pairs left exactly as they are.
//
//   npm run build            → checks (via check-categorizer-sync.mjs)
//   node scripts/gen-muse-shared.mjs          → writes
//   node scripts/gen-muse-shared.mjs --check  → verifies, exit 1 on drift
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const OUT_DIR = "supabase/functions/_shared/muse/lib";

// The closure, walked import by import from the tools the read door serves.
// NOTHING here is chosen by hand: if a module on this list imports another
// module, that one is on the list too, or the door will not start.
//
// The three surprises, kept as comments because nobody would guess them:
//   · the Chinese translations drag the whole EXERCISE LIBRARY into the finance
//     door — ledgerReview needs i18n, i18n needs i18n_zh, i18n_zh needs
//     muscleRegions, muscleRegions needs exerciseData;
//   · workoutLog and trainingMath import each other, so neither can be dropped;
//   · categorize already has an edge copy under _shared/, and this folder still
//     generates its own. One rule, no exceptions: both copies are chained to the
//     same source file, so they cannot drift from it or from each other.
const MODULES = [
  // the ground every module stands on
  "src/types.ts",
  "src/lib/format.ts",
  // the category list the app hands every module, so the door hands over the same
  // one rather than an empty array that happens not to be read today
  "src/lib/seed.ts",
  // finance maths
  "src/lib/household.ts",
  "src/lib/recurring.ts",
  "src/lib/plan.ts",
  // Rule 3: the sequences a SCREEN assembles, in one place both the screen and the
  // door call. Without it the door held its own copy of the five steps behind the
  // budget envelope, which is a copy of the arithmetic with the arithmetic hidden
  // in the order of the calls.
  "src/lib/headline.ts",
  "src/lib/schedule.ts",
  "src/lib/forecast.ts",
  "src/lib/selfAudit.ts",
  // the "worth a look" judgement rules and their closure
  "src/lib/categorize.ts",
  "src/lib/categorizeData.ts",
  "src/lib/i18n.ts",
  "src/lib/i18n_zh.ts",
  "src/lib/i18n_zh_auto.ts",
  "src/lib/muscleRegions.ts",
  "src/lib/exerciseData.ts",
  "src/lib/ledgerReview.ts",
  // health
  "src/lib/nutrition.ts",
  "src/lib/mealLog.ts",
  "src/lib/weightLog.ts",
  "src/lib/workoutLog.ts",
  "src/lib/trainingMath.ts",
];

/** Deno needs the file extension, and this folder is FLAT, so every relative
 *  import becomes a sibling with a `.ts` on the end — whatever shape the source
 *  spelled it in. All four shapes occur: `./plan`, `../types`, `./lib/nutrition`
 *  (from src/types.ts) and `./labelScan/types`. Only the last segment survives,
 *  because that is the file's name in the generated folder. */
function rewriteImports(src) {
  return src.replace(
    /(\bfrom\s+")(\.{1,2}\/[A-Za-z0-9_/]+)(")/g,
    (_m, head, spec, tail) => {
      const base = spec.split("/").pop();
      return `${head}./${base}.ts${tail}`;
    },
  );
}

function render(srcPath) {
  const body = rewriteImports(readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n"));
  const header =
    `// GENERATED — DO NOT EDIT. Source: ${srcPath}\n` +
    `// Run: node scripts/gen-muse-shared.mjs   (checked by npm run build)\n` +
    `//\n` +
    `// Hand-editing this file is the drift the Muse doors exist to prevent: the\n` +
    `// door would answer with one number while every screen in the app showed\n` +
    `// another, in a chat, with no screen beside it to notice. Change ${srcPath}\n` +
    `// and re-run the generator.\n`;
  return header + body;
}

const outName = (srcPath) => srcPath.split("/").pop();

const check = process.argv.includes("--check");
const files = new Map(MODULES.map((m) => [outName(m), render(m)]));

if (check) {
  const problems = [];
  for (const [name, want] of files) {
    const path = join(OUT_DIR, name);
    if (!existsSync(path)) {
      problems.push(`${path} is missing`);
      continue;
    }
    const got = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    if (got === want) continue;
    const a = want.split("\n");
    const b = got.split("\n");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    problems.push(
      `${path} differs from its source at line ${i + 1}\n` +
        `      source: ${JSON.stringify(a[i] ?? "<eof>")}\n` +
        `      ondisk: ${JSON.stringify(b[i] ?? "<eof>")}`,
    );
  }
  // A leftover file is drift too: a module dropped from MODULES but left on disk
  // keeps compiling and keeps answering, from a copy nothing checks any more.
  if (existsSync(OUT_DIR)) {
    for (const name of readdirSync(OUT_DIR)) {
      if (!files.has(name)) problems.push(`${join(OUT_DIR, name)} is not generated by this script`);
    }
  }
  if (problems.length) {
    console.error("\n✗ Muse shared copies are out of sync:");
    for (const p of problems) console.error(`    ${p}`);
    console.error("\n  → run: node scripts/gen-muse-shared.mjs\n");
    process.exit(1);
  }
  console.log(`✓ muse shared copies in sync (${files.size} files)`);
} else {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, text] of files) {
    writeFileSync(join(OUT_DIR, name), text, "utf8");
  }
  console.log(`✓ wrote ${files.size} files to ${relative(".", OUT_DIR)}`);
}
