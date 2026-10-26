// "Connect a bank" repairs a login that needs signing in again; it does not link it twice.
//
// FOUND 2026-10-26. The app's only bank-link path always made a NEW Plaid login, so the
// one button that looked like the fix for a lapsed login linked the same bank a second
// time and every account on it arrived twice. The server has always supported Plaid's
// update mode (a link token made with the connection's id); nothing asked for it. Now the
// same button, with the same words, repairs this phone's own login when it needs it —
// and otherwise links a new bank, as before. A repair is finished with the plaid function's `repaired`
// action, never an exchange, which would store the login a second time.
//
// And the server's `disconnect` — a hard delete of a login's accounts and history — now
// needs the connection id repeated as `confirm`, so a stray request deletes nothing.
//
// Every id below is invented.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const invoked: { fn: string; body: Record<string, unknown> }[] = [];
let connections: Record<string, unknown>[] | null = [];
vi.mock("../src/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: async (fn: string, opts: { body: Record<string, unknown> }) => {
        invoked.push({ fn, body: opts.body });
        if (opts.body.action === "link_token") return { data: { link_token: "link-sandbox-token" }, error: null };
        return { data: { accounts: 3 }, error: null };
      },
    },
    from: () => ({
      select: async () => (connections ? { data: connections, error: null } : { data: null, error: { message: "offline" } }),
    }),
  },
}));

const client = await import("../src/lib/plaidClient");
const { needsRepair, repairTarget } = client;

beforeEach(() => {
  store.clear();
  invoked.length = 0;
  connections = [];
});

const conn = (over: Record<string, unknown>) => ({ id: "c", owner: "Gino", status: "ok", last_error: null, created_at: "2026-06-01", ...over });

describe("which login 'Connect a bank' repairs", () => {
  it("none needs it: a new bank, as before", () => {
    expect(repairTarget([conn({ id: "a" }), conn({ id: "b", owner: "Xinyan" })], "Gino")).toBeNull();
  });

  it("a login marked needs_reauth is repaired — this device's own first", () => {
    const list = [conn({ id: "theirs", owner: "Xinyan", status: "needs_reauth" }), conn({ id: "mine", status: "needs_reauth" })];
    expect(repairTarget(list, "Gino")).toBe("mine");
    expect(repairTarget(list, "Xinyan")).toBe("theirs");
  });

  // CHANGED 2026-10-26 in review: the first version repaired someone else's login too
  // (the only one flagged, or the oldest), so a tap on one phone opened a bank sign-in for
  // the other person's login with nothing on screen saying whose — and while any login
  // was flagged, no phone could link a new bank. Only this device's own login now.
  it("someone else's flagged login is theirs to repair: this phone links a new bank, as before", () => {
    expect(repairTarget([conn({ id: "a" }), conn({ id: "b", owner: "Xinyan", status: "needs_reauth" })], "Gino")).toBeNull();
    expect(repairTarget([conn({ id: "b", owner: "Xinyan", status: "needs_reauth" })], "Gino")).toBeNull();
  });

  it("a device with no owner of its own repairs the one flagged login — and only when there is exactly one", () => {
    expect(repairTarget([conn({ id: "a" }), conn({ id: "b", owner: "Xinyan", status: "needs_reauth" })], "Joint")).toBe("b");
    const two = [
      conn({ id: "newer", owner: "Xinyan", status: "needs_reauth", created_at: "2026-07-01" }),
      conn({ id: "older", owner: "Gino", status: "needs_reauth", created_at: "2026-06-01" }),
    ];
    expect(repairTarget(two, "Joint")).toBeNull();
  });

  it("several of this device's own: the oldest, the same every time", () => {
    const list = [
      conn({ id: "newer", status: "needs_reauth", created_at: "2026-07-01" }),
      conn({ id: "older", status: "needs_reauth", created_at: "2026-06-01" }),
    ];
    expect(repairTarget(list, "Gino")).toBe("older");
    expect(repairTarget([...list].reverse(), "Gino")).toBe("older");
  });

  it("a failed sync from before the mark existed counts only when its error is a login error", () => {
    expect(needsRepair(conn({ status: "error", last_error: 'plaid /accounts/get 400: {"error_code":"ITEM_LOGIN_REQUIRED"}' }))).toBe(true);
    expect(needsRepair(conn({ status: "error", last_error: "fetch failed: network down" }))).toBe(false);
    expect(needsRepair(conn({ status: "ok" }))).toBe(false);
  });
});

describe("the link token, and how a Link session finishes", () => {
  it("a repair asks for an update-mode token with the connection's id, and remembers it across an OAuth reload", async () => {
    store.set("hb-owner", "gino");
    connections = [conn({ id: "conn-9", status: "needs_reauth" })];
    const target = await client.findRepairTarget();
    expect(target).toBe("conn-9");
    await client.createLinkToken(target ?? undefined);
    expect(invoked[0].body).toMatchObject({ action: "link_token", connection_id: "conn-9" });
    expect(client.storedLinkConnection()).toBe("conn-9");
  });

  it("on the other person's phone, their flagged login is left to them: a plain token for a new bank", async () => {
    store.set("hb-owner", "xinyan");
    connections = [conn({ id: "conn-9", status: "needs_reauth" })];
    expect(await client.findRepairTarget()).toBeNull();
  });

  it("a new bank asks for a plain token, and forgets any earlier repair", async () => {
    store.set("hb-plaid-link-conn", "stale");
    await client.createLinkToken();
    expect(invoked[0].body).not.toHaveProperty("connection_id");
    expect(client.storedLinkConnection()).toBeNull();
  });

  it("a connections read that fails links a new bank, as the button always did", async () => {
    connections = null;
    expect(await client.findRepairTarget()).toBeNull();
  });

  it("a repair finishes with `repaired`, never an exchange, and clears what it stashed", async () => {
    await client.createLinkToken("conn-9");
    const res = await client.finishRepair("conn-9");
    expect(invoked.at(-1)!.body).toEqual({ action: "repaired", connection_id: "conn-9" });
    expect(invoked.some((c) => c.body.action === "exchange")).toBe(false);
    expect(res.data).toEqual({ accounts: 3 });
    expect(client.storedLinkToken()).toBeNull();
    expect(client.storedLinkConnection()).toBeNull();
  });
});

describe("the screens use it — with no new words", () => {
  const sheets = readFileSync("src/views/sheets.tsx", "utf8");
  const connect = sheets.slice(sheets.indexOf("function ConnectBank()"), sheets.indexOf("function CreditCardLinks()"));
  const oauth = readFileSync("src/components/PlaidOAuthReturn.tsx", "utf8");

  it("Connect a bank asks which login to repair before it asks for a token", () => {
    expect(connect).toMatch(/const target = await findRepairTarget\(\);\s*const \{ token, error \} = await createLinkToken\(target \?\? undefined\);/);
  });

  it("both ways Link can finish turn a repair into `repaired`, and only a new bank into an exchange", () => {
    for (const src of [connect, oauth]) {
      expect(src).toContain("storedLinkConnection()");
      expect(src).toContain("finishRepair(repairing)");
      expect(src).toContain("exchangePublicToken(public_token, metadata?.institution?.name)");
    }
  });

  it("the button and its words are unchanged", () => {
    expect(connect).toContain('t("Connect a bank")');
    expect(connect).toContain('t("Connecting…")');
    expect(connect).toContain('t("Linking your accounts…")');
    expect(connect).toContain('t("Linked {n} accounts — transactions are syncing.", { n: data?.accounts ?? 0 })');
    // Nothing new is put through t(): the translation files need no new line.
    const said = [...connect.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]).sort();
    expect(said).toEqual(["Connect a bank", "Connecting…", "Linked {n} accounts — transactions are syncing.", "Linking your accounts…"]);
  });
});

describe("the plaid function", () => {
  const src = readFileSync("supabase/functions/plaid/index.ts", "utf8");

  it("repairs in update mode: a link token made with the connection's access token", () => {
    expect(src).toMatch(/if \(p\.connection_id\) \{[\s\S]{0,300}body\.access_token = token; \/\/ update mode/);
  });

  it("`repaired` clears only a needs_reauth mark, then syncs — a repair that did not take is marked again by that sync", () => {
    const fn = src.slice(src.indexOf("async function repaired("), src.indexOf("async function disconnect("));
    expect(fn).toContain('.eq("status", "needs_reauth")');
    expect(fn).toContain("await syncConnection(conn)");
    expect(src).toContain('case "repaired": return await repaired(payload);');
  });

  it("`disconnect` deletes nothing unless the connection id is repeated as confirm", () => {
    const fn = src.slice(src.indexOf("async function disconnect("), src.indexOf("Deno.serve("));
    const guard = fn.indexOf("p.confirm !== conn");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fn.indexOf(".delete()"));
  });
});
