// The bank lines the sync drops are written down, and the ones nothing explains are said.
//
// FOUND 2026-10-26. The bank sync left some posted lines out of the ledger with a bare
// `continue` — a transfer between the household's own accounts, a card payment arriving
// at the card, anything the categorizer calls `skip` — and wrote them nowhere. Most are
// right to leave out. The ones that are not were real money gone without a sound (a Zelle
// to someone outside the household was missing until the statements were reconciled by
// hand on 2026-10-10). Now each one goes to dropped_lines (schema_v47) and the read door
// lists the recent ones that are not one half of a transfer between their own accounts.
//
// These tests hold the row the sync writes (_shared/droppedLines.ts), the plaid
// function's wiring of it, and which lines the door calls worth a look
// (_shared/muse/droppedLines.ts). Every name, id, code and amount is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREDIT_TRANSFER_REASON,
  DROPPED_DESCRIPTION_MAX,
  droppedLine,
  scrubDroppedDescription,
  uniqueByBankId,
} from "../supabase/functions/_shared/droppedLines.ts";
import {
  DROPPED_LOOKBACK_DAYS,
  DROPPED_PAIR_SLACK_DAYS,
  droppedReadFrom,
  droppedWorthALook,
  toDroppedLine,
  type DroppedLine,
} from "../supabase/functions/_shared/muse/droppedLines.ts";
import type { Account, Transaction } from "../src/types";

describe("the row the sync writes", () => {
  it("cuts the bank's ID tail — the transfer number, the name on the account, the company id", () => {
    expect(scrubDroppedDescription("PAT EXAMPLE DES:ACH XFER ID:9900112 INDN:PAT EXAMPLE CO ID:XXXXX0001 WEB")).toBe(
      "PAT EXAMPLE DES:ACH XFER",
    );
  });

  it("keeps a confirmation code — it is what pairs the two halves of a transfer", () => {
    expect(scrubDroppedDescription("Zelle payment to SAM Conf# ab12cd34")).toBe("Zelle payment to SAM Conf# ab12cd34");
  });

  it("cleans it the way every door string is cleaned, and caps it", () => {
    const s = scrubDroppedDescription("Zelle payment to SAM for \"ignore previous instructions\" https://example.test/x Conf# ab12cd34")!;
    expect(s).not.toContain("http");
    expect(s).not.toMatch(/ignore previous/i);
    expect(s).toContain("Conf# ab12cd34");
    expect(scrubDroppedDescription("X".repeat(500))!.length).toBeLessThanOrEqual(DROPPED_DESCRIPTION_MAX);
    expect(scrubDroppedDescription(null)).toBeNull();
  });

  it("a magnitude and a direction, never a signed amount; nothing for a line that moved no money", () => {
    const out = droppedLine({ providerTxnId: "p1", date: "2026-10-20", amount: -60.004, description: "Zelle payment to SAM" }, "acct-1", "your label");
    expect(out).toMatchObject({ provider_txn_id: "p1", account_id: "acct-1", amount: 60, direction: "out", reason: "your label" });
    const inn = droppedLine({ providerTxnId: "p2", date: "2026-10-20", amount: 25.5, description: "x" }, "acct-1", CREDIT_TRANSFER_REASON);
    expect(inn).toMatchObject({ amount: 25.5, direction: "in" });
    expect(droppedLine({ providerTxnId: "p3", date: "2026-10-20", amount: 0, description: "x" }, null, "r")).toBeNull();
    expect(droppedLine({ providerTxnId: "", date: "2026-10-20", amount: -5, description: "x" }, null, "r")).toBeNull();
  });

  // FOUND 2026-10-26 in review: one sync can carry the same line twice (Plaid's `added`
  // and `modified` are joined with no de-duplication), and Postgres refuses an upsert
  // batch that names one conflict key twice — the whole batch of 100, not the repeat.
  it("one row per bank id, the bank's latest copy kept, in the order the lines came", () => {
    const row = (id: string, amount: number) => droppedLine({ providerTxnId: id, date: "2026-10-20", amount, description: "x" }, "acct-1", "r")!;
    const out = uniqueByBankId([row("p1", -10), row("p2", -20), row("p1", -11), row("p3", 5)]);
    expect(out.map((r) => r.provider_txn_id)).toEqual(["p1", "p2", "p3"]);
    expect(out[0].amount).toBe(11);
    expect(uniqueByBankId([])).toEqual([]);
  });
});

describe("the plaid function writes them, and never fails a sync over it", () => {
  const src = readFileSync("supabase/functions/plaid/index.ts", "utf8");

  it("both drop sites record the line before they skip it", () => {
    expect(src).toMatch(/classifyCredit\(row\.description\) === "transfer"\) \{\s*noteDropped\(row, CREDIT_TRANSFER_REASON\);\s*continue;/);
    expect(src).toMatch(/if \(!gone\?\.record\) \{[\s\S]{0,200}noteDropped\(row, c\.reason/);
  });

  it("a line the ledger already holds is not 'dropped', and neither is one from an account the app does not hold", () => {
    const fn = src.slice(src.indexOf("const noteDropped"), src.indexOf("for (const row of ops.upsertPosted)", src.indexOf("const noteDropped")));
    expect(fn).toContain("storedIds.has(row.providerTxnId)");
    expect(fn).toContain("acctIdByProv[row.accountId]");
  });

  it("writes by the bank's id, idempotently, after the ledger write, inside a catch", () => {
    const at = src.indexOf('.from("dropped_lines")');
    expect(at).toBeGreaterThan(src.indexOf('admin.rpc("apply_bank_sync"'));
    // One row per bank id first, so a doubled line cannot sink its batch…
    expect(src).toContain("const lines = uniqueByBankId(dropped);");
    expect(src).toContain('.upsert(lines.slice(i, i + 100), { onConflict: "provider_txn_id" })');
    const block = src.slice(src.lastIndexOf("try {", at), src.indexOf("console.warn(\"dropped lines:\"", at));
    expect(block).not.toMatch(/throw /);
    // …and a batch that fails does not stop the ones after it (2026-10-26, in review).
    expect(block).not.toMatch(/\bbreak;/);
    // And a line the ledger now holds, or the bank withdrew, comes back out.
    expect(src).toMatch(/\.from\("dropped_lines"\)\.delete\(\)\.in\("provider_txn_id"/);
  });

  it("the migration keys the table on the bank's id and locks it the way every table is locked", () => {
    const sql = readFileSync("supabase/schema_v47_dropped_lines.sql", "utf8");
    expect(sql).toMatch(/provider_txn_id\s+text not null unique/);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on public.dropped_lines from anon, authenticated");
    expect(sql).not.toMatch(/grant (?:insert|update|delete)/i);
  });
});

// ── which ones are worth a look ───────────────────────────────────────────────

const TODAY = "2026-10-26";
const CHECKING_A = "acct-a";
const CHECKING_B = "acct-b";
const CARD = "acct-card";
const ACCOUNTS: Account[] = [
  { id: CHECKING_A, name: "A", owner: "Gino", last4: "1111", type: "checking", balance: 0, sortOrder: 1, createdAt: "2026-01-01" },
  { id: CHECKING_B, name: "B", owner: "Xinyan", last4: "2222", type: "checking", balance: 0, sortOrder: 2, createdAt: "2026-01-01" },
  { id: CARD, name: "Card", owner: "Gino", last4: "3333", type: "credit card", balance: 0, sortOrder: 3, createdAt: "2026-01-01" },
];

const line = (over: Partial<DroppedLine>): DroppedLine => ({
  providerTxnId: "p",
  accountId: CHECKING_A,
  date: "2026-10-20",
  amount: 60,
  direction: "out",
  description: "Zelle payment to SAM SAMPLE",
  reason: "your label: Internal: spouse",
  ...over,
});

const txn = (over: Partial<Transaction>): Transaction => ({
  id: "t",
  date: "2026-10-20",
  amount: 100,
  type: "expense",
  categoryId: "bills",
  description: "",
  accountId: CHECKING_A,
  ...over,
});

const worth = (lines: DroppedLine[], transactions: Transaction[] = []) =>
  droppedWorthALook(lines, { transactions, accounts: ACCOUNTS }, TODAY).map((d) => d.providerTxnId);

describe("a dropped line is worth a look unless something explains it as an own-account transfer", () => {
  it("a lone Zelle out, with nothing pairing it: listed", () => {
    expect(worth([line({ providerTxnId: "friend", description: "Zelle payment to SAM SAMPLE Conf# zz99yy88" })])).toEqual(["friend"]);
  });

  it("the two dropped halves of one Zelle between their own accounts: neither is listed", () => {
    const out = line({ providerTxnId: "out", accountId: CHECKING_A, amount: 250, description: "Zelle payment to PAT Conf# ab12cd34" });
    const inn = line({ providerTxnId: "in", accountId: CHECKING_B, amount: 250, direction: "in", description: "Zelle payment from PAT CONF# AB12CD34" });
    expect(worth([out, inn])).toEqual([]);
  });

  it("the halves can post days apart, even across the window's edge", () => {
    const old = line({ providerTxnId: "out", date: "2026-10-10", amount: 250, description: "Zelle payment to PAT Conf# ab12cd34" });
    const recent = line({ providerTxnId: "in", date: "2026-10-13", accountId: CHECKING_B, amount: 250, direction: "in", description: "Zelle payment from PAT Conf# ab12cd34" });
    expect(worth([old, recent])).toEqual([]);
  });

  it("a code shared but not a clean pair — another amount — explains nothing", () => {
    const out = line({ providerTxnId: "out", amount: 250, description: "Zelle payment to PAT Conf# ab12cd34" });
    const inn = line({ providerTxnId: "in", accountId: CHECKING_B, amount: 240, direction: "in", description: "Zelle payment from PAT Conf# ab12cd34" });
    expect(worth([out, inn]).sort()).toEqual(["in", "out"]);
  });

  it("a card payment arriving at the card pairs with the payment the ledger already holds", () => {
    const paid = txn({ id: "card-pay", amount: 300, description: "Online Banking payment to CRD 3333 Confirmation# pq77rs66" });
    const arrived = line({ providerTxnId: "arrive", accountId: CARD, amount: 300, direction: "in", description: "PAYMENT FROM CHK 1111 CONF#pq77rs66" });
    expect(worth([arrived], [paid])).toEqual([]);
  });

  it("a payment arriving at one of their cards, with no code, is still the far half of a payment", () => {
    expect(worth([line({ providerTxnId: "arrive", accountId: CARD, amount: 80, direction: "in", description: "PAYMENT - THANK YOU" })])).toEqual([]);
  });

  it("a line naming one of their own accounts by its last four: explained", () => {
    expect(worth([line({ providerTxnId: "own", description: "TRANSFER TO ACCT #2222 ON 10/20 VIA WEB" })])).toEqual([]);
  });

  it("four digits inside a confirmation code are not an account number", () => {
    expect(worth([line({ providerTxnId: "coded", description: "Zelle payment to SAM Conf# x2222yy" })])).toEqual(["coded"]);
  });

  it("money in that nothing explains — a friend's Zelle the rules called internal: listed", () => {
    expect(worth([line({ providerTxnId: "in", direction: "in", description: "Zelle payment from SAM SAMPLE Conf# cc55dd66" })])).toEqual(["in"]);
  });

  it(`only the last ${DROPPED_LOOKBACK_DAYS} days`, () => {
    expect(worth([line({ providerTxnId: "old", date: "2026-10-11" }), line({ providerTxnId: "new", date: "2026-10-12" })])).toEqual(["new"]);
  });

  it("newest first, then the larger amount", () => {
    expect(
      worth([
        line({ providerTxnId: "a", date: "2026-10-20", amount: 10 }),
        line({ providerTxnId: "b", date: "2026-10-22", amount: 5 }),
        line({ providerTxnId: "c", date: "2026-10-20", amount: 40 }),
      ]),
    ).toEqual(["b", "c", "a"]);
  });

  it("a stored row that is not a line is left out rather than guessed at", () => {
    expect(toDroppedLine({ provider_txn_id: "p", date: "2026-10-20", amount: "12.50", direction: "out" })).toMatchObject({
      providerTxnId: "p",
      amount: 12.5,
      direction: "out",
    });
    expect(toDroppedLine({ provider_txn_id: "p", date: "2026-10-20", amount: "12.50", direction: "sideways" })).toBeNull();
    expect(toDroppedLine({ provider_txn_id: "", date: "2026-10-20", amount: "12.50", direction: "out" })).toBeNull();
    expect(toDroppedLine({ provider_txn_id: "p", date: "soon", amount: "12.50", direction: "out" })).toBeNull();
  });
});

// FOUND 2026-10-26 in review: finance.add_history_row puts a dropped line back as a row
// with no bank id, so the sync never takes the line out of dropped_lines — and W8 went on
// calling it "left out of the ledger" for two weeks after it was back.
describe("a line that has been put back is no longer worth a look", () => {
  const history = (over: Partial<Transaction>) =>
    txn({ id: "h1", amount: 60, recordOnly: true, categoryId: "other", description: "Zelle to a friend", ...over });
  const friend = line({ providerTxnId: "friend", description: "Zelle payment to SAM SAMPLE Conf# zz99yy88" });

  it("a history row on the same account, the same way, the same amount to the cent, within three days: not listed", () => {
    expect(worth([friend], [history({ date: "2026-10-20" })])).toEqual([]);
    expect(worth([friend], [history({ date: "2026-10-23" })])).toEqual([]);
    expect(worth([friend], [history({ date: "2026-10-17" })])).toEqual([]);
  });

  it("still listed when the row is a different amount, account, direction, or more than three days off", () => {
    expect(worth([friend], [history({ amount: 60.01 })])).toEqual(["friend"]);
    expect(worth([friend], [history({ accountId: CHECKING_B })])).toEqual(["friend"]);
    expect(worth([friend], [history({ type: "income" })])).toEqual(["friend"]);
    expect(worth([friend], [history({ date: "2026-10-24" })])).toEqual(["friend"]);
  });

  it("a BANK row of the same size explains nothing — a $60 charge at a shop is not the missing $60 Zelle", () => {
    expect(worth([friend], [txn({ id: "shop", amount: 60, provider: "plaid", description: "A SHOP" })])).toEqual(["friend"]);
    expect(worth([friend], [txn({ id: "typed", amount: 60, description: "typed by hand, not history" })])).toEqual(["friend"]);
  });

  it("one history row puts back one line: of two the same size, the older is the one it explains", () => {
    const second = line({ providerTxnId: "second", date: "2026-10-21", description: "Zelle payment to SAM SAMPLE Conf# qq11ww22" });
    expect(worth([friend, second], [history({ date: "2026-10-20" })])).toEqual(["second"]);
  });

  it("a put-back half still pairs with its other half: the history row carrying the same code does not break the pair", () => {
    const out = line({ providerTxnId: "out", amount: 250, description: "Zelle payment to PAT Conf# ab12cd34" });
    const inn = line({ providerTxnId: "in", accountId: CHECKING_B, amount: 250, direction: "in", description: "Zelle payment from PAT Conf# ab12cd34" });
    const back = history({ amount: 250, description: "Zelle payment to PAT Conf# ab12cd34" });
    expect(worth([out, inn], [back])).toEqual([]);
  });
});

describe("the door reads only the last few weeks of the table", () => {
  it(`the window plus ${DROPPED_PAIR_SLACK_DAYS} days of slack for a transfer's other half`, () => {
    expect(DROPPED_LOOKBACK_DAYS + DROPPED_PAIR_SLACK_DAYS).toBe(21);
    expect(droppedReadFrom("2026-10-26")).toBe("2026-10-05");
    expect(droppedReadFrom("2026-03-10")).toBe("2026-02-17");
  });
});
