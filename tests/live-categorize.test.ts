import { describe, it, expect } from "vitest";
import { classify, type LearnedRules } from "../src/lib/categorize";

// Run the categorizer over EVERY descriptor pair actually in the ledger, with
// the household's real learned rules loaded, and report what changed.
//
// This exists because a unit test can only check the descriptors someone thought
// to type, and the defects in this module have all been the opposite shape: a
// rule written for a descriptor the bank does not send. The ALEKS bill rule was
// written against "MHE*ALEKS" and shipped green — Plaid reports that charge as
// the bare publisher code "MHE", so the rule matched nothing at all. Only the
// live corpus says so.
//
//   SUPABASE_PAT=<token> npx vitest run tests/live-categorize.test.ts
//
// Skipped without a PAT so `npm test` stays offline.

const PAT = process.env.SUPABASE_PAT;
const REF = "ganzefaciiyibselizqi";

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T[]>;
}

describe.skipIf(!PAT)("the categorizer against the LIVE descriptor corpus", () => {
  it("every modeled bill is reachable from a descriptor the bank really sends", async () => {
    const [rules, recs, txs] = await Promise.all([
      q<{ pattern: string; kind: string; category_id: string | null; bill_name: string | null }>(
        "select pattern, kind, category_id, bill_name from merchant_rules",
      ),
      q<{ id: string; name: string; active: boolean }>(
        "select id, name, active from recurring where direction = 'out'",
      ),
      q<{ description: string; raw_description: string | null; amount: string; category_id: string; applies_to: unknown }>(
        `select description, raw_description, amount, category_id, applies_to
           from transactions
          where type = 'expense' and date >= '2026-04-01'
          order by date desc`,
      ),
    ]);

    const learned: LearnedRules = {};
    for (const r of rules) {
      learned[r.pattern] = {
        kind: r.kind as LearnedRules[string]["kind"],
        categoryId: r.category_id ?? undefined,
        billName: r.bill_name ?? undefined,
      };
    }
    const recNames = new Set(recs.map((r) => r.name));

    // 1) Every bill the categorizer can NAME must resolve to a modeled row.
    //    A name that matches nothing settles nothing, silently.
    const namedBills = new Set<string>();
    const orphanNames = new Set<string>();
    // 2) Which modeled bills the live corpus can actually reach.
    const reached = new Set<string>();

    for (const t of txs) {
      const c = classify(t.description, -Number(t.amount), learned, t.raw_description ?? undefined);
      if (c.kind === "bill" && c.billName) {
        namedBills.add(c.billName);
        if (recNames.has(c.billName)) reached.add(c.billName);
      }
    }
    for (const n of namedBills) {
      // "Car insurance" is a deliberate PREFIX — the importer resolves it against
      // whichever of the two term rows is live on the payment date, so it is not
      // expected to equal a row name.
      if (!recNames.has(n) && n !== "Car insurance") orphanNames.add(n);
    }

    const unreached = recs
      .filter((r) => r.active && !reached.has(r.name) && r.name !== "Mom")
      .map((r) => r.name);

    console.log(`  ${txs.length} live expense rows, ${rules.length} learned rules`);
    console.log(`  bills reached from the corpus: ${[...reached].sort().join(", ")}`);
    console.log(`  active bills NOT reached:      ${unreached.join(", ") || "(none)"}`);
    console.log(`  names matching no modeled row: ${[...orphanNames].join(", ") || "(none)"}`);

    // A rule naming a bill that does not exist is always a defect: it takes the
    // charge off the variable-spend path and then settles nothing.
    expect([...orphanNames]).toEqual([]);
  });

  it("reports every row the fixed categorizer would now label differently", async () => {
    const [rules, txs] = await Promise.all([
      q<{ pattern: string; kind: string; category_id: string | null; bill_name: string | null }>(
        "select pattern, kind, category_id, bill_name from merchant_rules",
      ),
      q<{ date: string; description: string; raw_description: string | null; amount: string; category_id: string; user_categorized: boolean; applies_to: unknown }>(
        `select date, description, raw_description, amount, category_id, user_categorized, applies_to
           from transactions
          where type = 'expense' and date >= '2026-07-01' and applies_to is null
          order by date desc`,
      ),
    ]);
    const learned: LearnedRules = {};
    for (const r of rules)
      learned[r.pattern] = {
        kind: r.kind as LearnedRules[string]["kind"],
        categoryId: r.category_id ?? undefined,
        billName: r.bill_name ?? undefined,
      };

    let moved = 0;
    let dollars = 0;
    for (const t of txs) {
      const c = classify(t.description, -Number(t.amount), learned, t.raw_description ?? undefined);
      const now = c.kind === "variable" ? c.appCategory : c.kind === "bill" ? `BILL:${c.billName}` : "SKIP";
      if (now && now !== t.category_id) {
        moved++;
        dollars += Number(t.amount);
        console.log(
          `  ${t.date} $${Number(t.amount).toFixed(2).padStart(8)}  ${t.category_id.padEnd(13)} -> ${String(now).padEnd(24)} ${t.user_categorized ? "[user-set]" : ""} ${t.description}`,
        );
      }
    }
    console.log(`  ${moved} of ${txs.length} rows would label differently ($${dollars.toFixed(2)})`);
    // Reporting only — a difference here is usually the fix working. It is here
    // so a change to the categorizer shows its real blast radius before it ships.
    expect(txs.length).toBeGreaterThan(0);
  });
});
