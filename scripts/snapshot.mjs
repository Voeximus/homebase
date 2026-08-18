#!/usr/bin/env node
// Export the live finance state to a timestamped JSON file, and print a readable
// summary to the terminal.
//
// This exists so an incoming assistant can see the household's real numbers in
// one command, without holding credentials across sessions or clicking through
// the Supabase dashboard. It is READ-ONLY — every query is a select.
//
//   SUPABASE_PAT=<token> node scripts/snapshot.mjs
//
// The PAT comes from supabase.com -> Account -> Access Tokens. It is never read
// from a file and never written to one. Output lands in docs/snapshots/, which
// is gitignored because it contains real balances.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "ganzefaciiyibselizqi";
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const PAT = process.env.SUPABASE_PAT;
if (!PAT) {
  console.error(
    "\nMissing SUPABASE_PAT.\n\n" +
      "  SUPABASE_PAT=<token> node scripts/snapshot.mjs\n\n" +
      "Generate one at supabase.com -> Account -> Access Tokens.\n",
  );
  process.exit(1);
}

/** Run one SQL statement through the Management API. */
async function q(sql) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}\n${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response:\n${text}`);
  }
}

// Ordered so the summary below can read them by name. Transactions are capped —
// the full ledger is thousands of rows and the recent window is what gets used.
const TABLES = {
  accounts: "select * from accounts order by sort_order",
  recurring: "select * from recurring order by direction, name",
  debts: "select * from debts order by balance desc",
  savings_goals: "select * from savings_goals order by created_at",
  paid_bills: "select * from paid_bills order by month desc limit 200",
  merchant_rules: "select * from merchant_rules order by created_at desc",
  transactions:
    "select * from transactions order by date desc, created_at desc limit 500",
};

const money = (n) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// Mirrors CADENCE_TO_MONTHLY in src/lib/household.ts. biweekly is 2 ON PURPOSE,
// not 26/12 — the budget plans on two checks a month and treats the ~2 extra
// checks a year as upside. Do not "correct" this; see Rule 1 in the brief.
const CADENCE_TO_MONTHLY = {
  weekly: 52 / 12,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  yearly: 1 / 12,
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Is a recurring row alive today, per its starts_on / ends_on window? */
function liveToday(r) {
  const t = todayISO();
  if (r.starts_on && t < r.starts_on) return false;
  if (r.ends_on && t > r.ends_on) return false;
  return true;
}

async function main() {
  const data = {};
  for (const [name, sql] of Object.entries(TABLES)) {
    process.stdout.write(`  fetching ${name}... `);
    try {
      data[name] = await q(sql);
      console.log(`${data[name].length} rows`);
    } catch (err) {
      console.log("FAILED");
      console.error(`\n${err.message}\n`);
      data[name] = { error: String(err.message) };
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "snapshots");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `homebase-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify({ takenAt: new Date().toISOString(), projectRef: PROJECT_REF, ...data }, null, 2),
  );

  // ---- summary -------------------------------------------------------------
  const rec = Array.isArray(data.recurring) ? data.recurring : [];
  const active = rec.filter((r) => r.active);
  const monthly = (r) => Number(r.amount) * (CADENCE_TO_MONTHLY[r.cadence] ?? 1);

  const income = active.filter((r) => r.direction === "in" && liveToday(r));
  const bills = active.filter((r) => r.direction === "out" && liveToday(r));
  const dormant = active.filter((r) => !liveToday(r));

  const incomeTotal = income.reduce((s, r) => s + monthly(r), 0);
  const billsTotal = bills.reduce((s, r) => s + monthly(r), 0);

  const line = "-".repeat(64);
  console.log(`\n${line}\nHOMEBASE SNAPSHOT  ${new Date().toLocaleString()}\n${line}`);

  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const cash = accounts.filter((a) => !/credit/i.test(a.type ?? ""));
  console.log("\nCASH");
  for (const a of cash) console.log(`  ${(a.name ?? "").padEnd(24)} ${money(a.balance).padStart(12)}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${money(cash.reduce((s, a) => s + Number(a.balance || 0), 0)).padStart(12)}`);

  console.log("\nMONTHLY INCOME  (biweekly modeled x2 on purpose)");
  for (const r of income) console.log(`  ${(r.name ?? "").padEnd(24)} ${money(monthly(r)).padStart(12)}  ${r.cadence}`);
  console.log(`  ${"TOTAL".padEnd(24)} ${money(incomeTotal).padStart(12)}`);

  console.log("\nMONTHLY BILLS  (periodic bills shown at their monthly average)");
  for (const r of bills) {
    const flags = [
      r.variable ? "variable" : null,
      r.known_amount != null ? `known ${money(r.known_amount)}` : null,
      r.ends_on ? `ends ${r.ends_on}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  ${(r.name ?? "").padEnd(24)} ${money(monthly(r)).padStart(12)}  ${r.cadence}${flags ? "  [" + flags + "]" : ""}`);
  }
  console.log(`  ${"TOTAL".padEnd(24)} ${money(billsTotal).padStart(12)}`);

  if (dormant.length) {
    console.log("\nSCHEDULED BUT NOT YET LIVE  (starts_on in the future)");
    for (const r of dormant)
      console.log(`  ${(r.name ?? "").padEnd(24)} ${money(monthly(r)).padStart(12)}  starts ${r.starts_on ?? "?"}`);
  }

  const debts = Array.isArray(data.debts) ? data.debts : [];
  if (debts.length) {
    console.log("\nDEBTS");
    for (const d of debts)
      console.log(`  ${(d.name ?? "").padEnd(24)} ${money(d.balance).padStart(12)}  ${d.apr ? d.apr + "% APR" : ""}`);
    console.log(`  ${"TOTAL".padEnd(24)} ${money(debts.reduce((s, d) => s + Number(d.balance || 0), 0)).padStart(12)}`);
  }

  console.log(`\n${line}`);
  console.log(`FIXED NET (income - bills, before variable spending): ${money(incomeTotal - billsTotal)}`);
  console.log(`${line}`);
  console.log(`\nFull JSON written to:\n  ${outFile}\n`);
  console.log("Reminder: these are modeled monthly averages. For real due dates and");
  console.log("month-by-month totals, read the app's Forecast tab or src/lib/forecast.ts.\n");
}

main().catch((err) => {
  console.error(`\nSnapshot failed: ${err.message}\n`);
  process.exit(1);
});
