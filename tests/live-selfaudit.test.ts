import { describe, it, expect } from "vitest";
import { selfAudit } from "../src/lib/selfAudit";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData } from "../src/types";

// Runs the self-audit against the REAL household data.
//
// Skipped unless a Supabase PAT is present, so `npm test` stays offline and CI
// never depends on the network:
//
//   SUPABASE_PAT=<token> npx vitest run tests/live-selfaudit.test.ts
//
// This is the one check that can catch a defect nobody has thought to write a
// unit test for, because it runs the invariants against whatever is actually in
// the database today rather than against a fixture someone imagined.

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

const num = (v: unknown) => Number(v ?? 0);

describe.skipIf(!PAT)("self-audit against LIVE data", () => {
  it("the live household passes every invariant", async () => {
    // Deliberately mirrors the store's mappers rather than importing them —
    // FinanceStore.tsx is a React module and cannot be loaded headlessly. Keep
    // these field lists in step with mapTxn / mapRecurring.
    const [rec, txs, debts, accts] = await Promise.all([
      q("select * from recurring"),
      q("select * from transactions order by date desc limit 2000"),
      q("select * from debts"),
      q("select * from accounts"),
    ]);

    const data: AppData = {
      categories: DEFAULT_CATEGORIES,
      goals: [],
      paidBills: [],
      merchantRules: [],
      foods: [],
      accounts: accts.map((a) => ({
        id: a.id as string,
        name: a.name as string,
        owner: a.owner as AppData["accounts"][number]["owner"],
        type: a.type as string,
        balance: num(a.balance),
        sortOrder: num(a.sort_order),
        createdAt: a.created_at as string,
      })),
      debts: debts.map((d) => ({
        id: d.id as string,
        name: d.name as string,
        balance: num(d.balance),
        originalBalance: num(d.original_balance),
        apr: d.apr == null ? undefined : num(d.apr),
        color: (d.color as string) ?? "#000",
        providerAccountId: (d.provider_account_id as string) ?? undefined,
        trackPattern: (d.track_pattern as string) ?? undefined,
        createdAt: d.created_at as string,
      })),
      recurring: rec.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        amount: num(r.amount),
        direction: r.direction as AppData["recurring"][number]["direction"],
        cadence: r.cadence as AppData["recurring"][number]["cadence"],
        active: !!r.active,
        variable: !!r.variable,
        categoryId: (r.category_id as string) ?? undefined,
        dueDays: (r.due_days as number[]) ?? undefined,
        anchorDate: (r.anchor_date as string) ?? undefined,
        startsOn: (r.starts_on as string) ?? undefined,
        endsOn: (r.ends_on as string) ?? undefined,
        knownAmount: r.known_amount == null ? undefined : num(r.known_amount),
        linkedDebtId: (r.linked_debt_id as string) ?? undefined,
        createdAt: r.created_at as string,
      })),
      transactions: txs.map((t) => ({
        id: t.id as string,
        date: t.date as string,
        amount: num(t.amount),
        type: t.type as "income" | "expense",
        categoryId: t.category_id as string,
        description: (t.description as string) ?? "",
        accountId: (t.account_id as string) ?? undefined,
        appliesTo: (t.applies_to as AppData["transactions"][number]["appliesTo"]) ?? undefined,
        splits: Array.isArray(t.splits) && t.splits.length ? (t.splits as AppData["transactions"][number]["splits"]) : undefined,
        pending: t.status === "pending",
        provider: (t.provider as string) ?? undefined,
        recordOnly: !!t.record_only,
        createdAt: t.created_at as string,
      })),
    };

    const r = selfAudit(data);

    // Print every check so a failure reads as a diagnosis, not just a red X.
    for (const c of r.checks) {
      console.log(`  [${c.status.toUpperCase()}] ${c.question}\n         ${c.detail}`);
    }
    console.log(
      `\n  live data: ${data.transactions.length} transactions · ${data.recurring.length} recurring · ${data.debts.length} debts · ${data.accounts.length} accounts`,
    );

    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.failures, r.checks.filter((c) => c.status === "fail").map((c) => c.detail).join(" | ")).toBe(0);
  }, 60_000);
});
