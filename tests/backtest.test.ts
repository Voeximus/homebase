import { describe, it, expect } from "vitest";
import { monthlySchedule } from "../src/lib/schedule";
import { DEFAULT_CATEGORIES } from "../src/lib/seed";
import type { AppData } from "../src/types";

// ── Backtest ─────────────────────────────────────────────────────────────────
//
// The forecast is only worth what its ability to reproduce the PAST is worth.
// This runs the app's own scheduling engine over months that already happened and
// compares what it says SHOULD have left the account against what actually did,
// bill by bill, from the bank feed.
//
// It exists because a projection stated confidently is worthless without this:
// nobody, human or otherwise, should be believed about September until they can
// account for July.
//
// Skipped unless SUPABASE_PAT is set, so CI stays offline.
//
//   SUPABASE_PAT=<token> npx vitest run tests/backtest.test.ts

const PAT = process.env.SUPABASE_PAT;
const REF = "ganzefaciiyibselizqi";

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T[]>;
}
const num = (v: unknown) => Number(v ?? 0);
const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);

describe.skipIf(!PAT)("backtest — can the model reproduce months that already happened?", () => {
  it("compares predicted bills and income against what actually hit the bank", async () => {
    const [rec, txs, debts, accts] = await Promise.all([
      q("select * from recurring"),
      q("select * from transactions order by date"),
      q("select * from debts"),
      q("select * from accounts"),
    ]);

    const data: AppData = {
      categories: DEFAULT_CATEGORIES, goals: [], paidBills: [], merchantRules: [], foods: [],
      accounts: accts.map((a) => ({ id: a.id as string, name: a.name as string, owner: a.owner as never, type: a.type as string, balance: num(a.balance), sortOrder: num(a.sort_order), createdAt: a.created_at as string })),
      debts: debts.map((d) => ({ id: d.id as string, name: d.name as string, balance: num(d.balance), originalBalance: num(d.original_balance), color: "#000", createdAt: d.created_at as string })),
      recurring: rec.map((r) => ({ id: r.id as string, name: r.name as string, amount: num(r.amount), direction: r.direction as never, cadence: r.cadence as never, active: !!r.active, variable: !!r.variable, dueDays: (r.due_days as number[]) ?? undefined, anchorDate: (r.anchor_date as string) ?? undefined, startsOn: (r.starts_on as string) ?? undefined, endsOn: (r.ends_on as string) ?? undefined, knownAmount: r.known_amount == null ? undefined : num(r.known_amount), linkedDebtId: (r.linked_debt_id as string) ?? undefined, createdAt: r.created_at as string })),
      transactions: txs.map((t) => ({ id: t.id as string, date: t.date as string, amount: num(t.amount), type: t.type as never, categoryId: t.category_id as string, description: (t.description as string) ?? "", accountId: (t.account_id as string) ?? undefined, appliesTo: (t.applies_to as never) ?? undefined, pending: t.status === "pending", createdAt: t.created_at as string })),
    };

    const MONTHS = ["2026-05", "2026-06", "2026-07"];
    let totalPredicted = 0;
    let totalActual = 0;

    for (const mk of MONTHS) {
      const sched = monthlySchedule(data.recurring, mk, data.transactions, data.debts);

      // What the model says should go OUT this month, per bill.
      const predicted = new Map<string, number>();
      let predIncome = 0;
      for (const e of sched.entries) {
        if (e.direction === "transfer") continue;
        if (e.direction === "in") { predIncome += e.amount; continue; }
        predicted.set(e.label, (predicted.get(e.label) ?? 0) + e.amount);
      }

      // What ACTUALLY left the account against a bill, from the ledger.
      const actual = new Map<string, number>();
      let actIncome = 0;
      for (const t of data.transactions) {
        if (t.date.slice(0, 7) !== mk) continue;
        if (t.type === "income") { actIncome += t.amount; continue; }
        const at = t.appliesTo as { kind?: string; recurringId?: string } | undefined;
        if (at?.kind !== "bill" || !at.recurringId) continue;
        const name = data.recurring.find((r) => r.id === at.recurringId)?.name ?? at.recurringId;
        actual.set(name, (actual.get(name) ?? 0) + t.amount);
      }

      const names = [...new Set([...predicted.keys(), ...actual.keys()])].sort();
      const pSum = [...predicted.values()].reduce((s, x) => s + x, 0);
      const aSum = [...actual.values()].reduce((s, x) => s + x, 0);
      totalPredicted += pSum;
      totalActual += aSum;

      console.log(`\n${"=".repeat(74)}\n${mk}   predicted bills ${usd(pSum)}   ·   actually paid ${usd(aSum)}   ·   gap ${usd(aSum - pSum)}`);
      console.log(`${"-".repeat(74)}`);
      console.log(`  ${"BILL".padEnd(34)}${"MODEL".padStart(11)}${"ACTUAL".padStart(12)}${"GAP".padStart(12)}`);
      for (const nme of names) {
        const p = predicted.get(nme) ?? 0;
        const a = actual.get(nme) ?? 0;
        if (Math.abs(p - a) < 0.005) continue; // agrees exactly
        const note = a === 0 ? "  never posted" : p === 0 ? "  not modelled" : "";
        console.log(`  ${nme.slice(0, 33).padEnd(34)}${usd(p).padStart(11)}${usd(a).padStart(12)}${usd(a - p).padStart(12)}${note}`);
      }
      const agree = names.filter((nme) => Math.abs((predicted.get(nme) ?? 0) - (actual.get(nme) ?? 0)) < 0.005);
      console.log(`  (${agree.length} of ${names.length} bills matched to the cent and are not listed)`);
      console.log(`\n  INCOME   model ${usd(predIncome)}   ·   actually received ${usd(actIncome)}   ·   gap ${usd(actIncome - predIncome)}`);
    }

    console.log(`\n${"=".repeat(74)}`);
    console.log(`THREE-MONTH TOTAL   model ${usd(totalPredicted)}   ·   actual ${usd(totalActual)}   ·   gap ${usd(totalActual - totalPredicted)}`);
    console.log(`${"=".repeat(74)}\n`);

    expect(MONTHS.length).toBe(3);
  }, 90_000);
});
