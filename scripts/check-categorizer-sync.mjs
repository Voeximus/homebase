// Guards against the two categorizer copies silently drifting apart.
//
// The live Plaid feed classifies transactions with the Deno EDGE copy
// (supabase/functions/_shared/*), while CSV import + the in-app UI use the
// CLIENT copy (src/lib/*). They must stay logically identical — a past drift
// left the edge copy mapping spend to a deleted `health` category in
// production. This runs in `npm run build`, so CI fails before such a drift
// can ship. The ONLY allowed difference is the Deno `.ts` import extension.
import { readFileSync } from "node:fs";

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
