// Client-side helpers for the Plaid Link flow. The browser only ever talks to
// our edge function (which holds the secrets); it never sees a Plaid secret or
// a bank token.

import { supabase } from "./supabase";

const LINK_TOKEN_KEY = "hb-plaid-link-token";
// The connection a Link session is REPAIRING, when it is one (2026-10-26). Stashed
// beside the token for the same reason the token is: an OAuth bank reloads the page
// halfway through Link, and the return has to know whether to exchange a new login or
// finish repairing an old one.
const LINK_CONN_KEY = "hb-plaid-link-conn";

/** Which person this device belongs to (set on first launch). */
export function ownerOfDevice(): string {
  const o = localStorage.getItem("hb-owner");
  return o === "gino" ? "Gino" : o === "xinyan" ? "Xinyan" : "Joint";
}

// ── repair, not a duplicate (2026-10-26) ─────────────────────────────────────
//
// WHY. "Connect a bank" was the app's only bank-link path, and it always made a NEW
// Plaid login — so when a bank login lapsed, the one button that looked like the fix
// linked the same bank a second time, and every account on it arrived twice (the sync's
// dedup guard exists because of exactly that). The server has always supported Plaid's
// UPDATE mode, which repairs the existing login in place: a link token made with the
// connection's id (linkToken in supabase/functions/plaid/index.ts). Nothing asked for it.
//
// So the same button, with the same words, now asks first whether THIS DEVICE'S bank
// login needs signing in again — and if it does, it repairs that one. Otherwise a new
// bank is linked, exactly as before.

/** One bank login, in the columns the repair decision reads. No secret: the table holds
 *  none, and only these columns are read. */
export interface ConnectionHealth {
  id: string;
  owner: string | null;
  status: string | null;
  last_error: string | null;
  created_at?: string | null;
}

/** Plaid's codes for a login only its owner can fix by signing in again. The same list
 *  the server reads (supabase/functions/_shared/itemHealth.ts LOGIN_ERROR_CODES). */
const LOGIN_ERRORS =
  /ITEM_LOGIN_REQUIRED|INVALID_CREDENTIALS|INVALID_MFA|INSUFFICIENT_CREDENTIALS|ITEM_LOCKED|USER_SETUP_REQUIRED|ACCESS_NOT_GRANTED/;

/** Does this login need signing in again? Marked so ('needs_reauth', which the bank's own
 *  warnings set), or a failed sync from before that mark existed whose error is a login
 *  error. */
export function needsRepair(c: ConnectionHealth): boolean {
  return c.status === "needs_reauth" || (c.status === "error" && LOGIN_ERRORS.test(c.last_error ?? ""));
}

/**
 * The login "Connect a bank" should repair, or null to link a new bank.
 *
 * ONLY THIS DEVICE'S OWN LOGIN (changed 2026-10-26 in review). The person holding the
 * phone is the one who can sign in to it, and nothing on the screen says whose login a
 * tap is repairing (its words were not to change). The first version also repaired
 * someone else's — the only one flagged, or the oldest — so Gino's tap while Xinyan's
 * login was flagged opened a bank sign-in for HER login, which his own username cannot
 * repair, and while any login was flagged the button could not link a new bank at all.
 * Now another person's flagged login is theirs to repair from their own phone, and this
 * button links a new bank as it always did (the sync's dedup guard stands behind that).
 *
 * The one exception is a device with no owner of its own ("Joint" — ownerOfDevice):
 * it repairs the flagged login when exactly one is flagged, and links a new bank when
 * none or several are. Several of this device's own: the oldest, so the same tap gives
 * the same answer every time. Pure.
 */
export function repairTarget(conns: readonly ConnectionHealth[], owner: string): string | null {
  const broken = conns
    .filter(needsRepair)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  const mine = broken.find((c) => c.owner === owner);
  if (mine) return mine.id;
  if (owner === "Joint" && broken.length === 1) return broken[0].id;
  return null;
}

/** Ask the database which login to repair. A read that fails answers null — a new link,
 *  which is what this button did before, and the sync's dedup guard still stands behind
 *  it. */
export async function findRepairTarget(): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("bank_connections").select("id, owner, status, last_error, created_at");
    if (error || !data) return null;
    return repairTarget(data as ConnectionHealth[], ownerOfDevice());
  } catch {
    return null;
  }
}

/** Ask the edge function for a Link token. Stashed in localStorage so an OAuth
 *  redirect (which reloads the page) can resume the same Link session.
 *
 *  With `connectionId` the token is for UPDATE mode — Plaid repairs that login rather
 *  than making a new one — and the id is stashed with it. */
export async function createLinkToken(connectionId?: string): Promise<{ token?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke("plaid", {
    body: connectionId
      ? { action: "link_token", owner: ownerOfDevice(), connection_id: connectionId }
      : { action: "link_token", owner: ownerOfDevice() },
  });
  if (error || !data?.link_token) return { error: error?.message ?? "no link token" };
  localStorage.setItem(LINK_TOKEN_KEY, data.link_token);
  if (connectionId) localStorage.setItem(LINK_CONN_KEY, connectionId);
  else localStorage.removeItem(LINK_CONN_KEY);
  return { token: data.link_token };
}

export function storedLinkToken(): string | null {
  return localStorage.getItem(LINK_TOKEN_KEY);
}

/** The login the stored Link session is repairing, or null for a new link. */
export function storedLinkConnection(): string | null {
  return localStorage.getItem(LINK_CONN_KEY);
}

/** Hand the public_token back to the function, which stores the access token in
 *  Vault, discovers accounts, and runs the first sync. */
export async function exchangePublicToken(public_token: string, institution?: string) {
  const res = await supabase.functions.invoke("plaid", {
    body: { action: "exchange", public_token, owner: ownerOfDevice(), institution: institution ?? "Bank" },
  });
  localStorage.removeItem(LINK_TOKEN_KEY);
  localStorage.removeItem(LINK_CONN_KEY);
  return res;
}

/** Finish an UPDATE-mode Link: there is nothing to exchange (the login keeps its access
 *  token), so the function clears the "needs signing in again" mark and syncs. Answers
 *  `{ accounts }` like an exchange, so the screen says the same thing either way. */
export async function finishRepair(connectionId: string) {
  const res = await supabase.functions.invoke("plaid", {
    body: { action: "repaired", connection_id: connectionId },
  });
  localStorage.removeItem(LINK_TOKEN_KEY);
  localStorage.removeItem(LINK_CONN_KEY);
  return res;
}

/** Pull the latest from the bank. `force` nudges Plaid to re-check the bank now
 *  (rate-limited + async — brand-new charges may land a few moments later). */
export async function syncNow(force = false) {
  return supabase.functions.invoke("plaid", { body: { action: "sync", force } });
}

/** True when a bank's OAuth flow has just redirected back to us. */
export const isOAuthRedirect =
  typeof window !== "undefined" && window.location.search.includes("oauth_state_id=");
