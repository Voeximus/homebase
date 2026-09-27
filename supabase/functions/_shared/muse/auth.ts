// Who is at the door.
//
// NOT A SUPABASE LOGIN, and the repo has already written down why. From
// _shared/callerAuth.ts: `verify_jwt = true` means "the request carries a valid
// project credential", and the publishable key is a valid project credential
// compiled into the browser bundle by design. A live audit reproduced an
// anonymous caller holding nothing but that public key reaching the `plaid`
// function's `disconnect` action, which hard-deletes every transaction and
// account on a connection. And 17 of the 18 tables carry the identical rule —
// any signed-in account may read and write every row — so a Supabase session
// handed to an assistant is not a door, it is the whole house.
//
// Instead: one long random secret per person per door, held as an edge-function
// secret. Four in total across both doors; this file knows the two READ ones.
// The write door's secrets are not in this table, so presenting one here is a
// 401 — which is the point of two doors rather than one.
//
// Revoking is: change the secret, redeploy this function. Under a minute, and it
// cannot half-work. Losing her phone revokes her two secrets and not his.
//
// WHICH HEADER. Undecided on purpose, and it is a measurement rather than a
// preference: nobody has published what a phone-built Muse connector will send,
// and the one Meta page that names an auth scheme for connectors names OAuth. So
// this accepts the secret in `Authorization: Bearer` (checked first) OR in
// `X-Muse-Token`, and Phone Test 2 decides which one stays. A secret in the query
// string is deliberately NOT accepted, even though the three existing public
// functions use one — query strings end up in logs.

// One comparison, in safeEqual.ts, for every secret in the bridge. It used to be
// spelled here and again in the write door, which is how the write door ended up
// without the length floor below.
import { safeEqual } from "./safeEqual.ts";

export type Person = "gino" | "xinyan";

/** The configured read secrets, one per person. An empty value means "that person
 *  has no read access", never "let anybody in". */
export interface ReadSecrets {
  gino: string;
  xinyan: string;
}

/**
 * Below this, a configured value is treated as unset.
 *
 * A secret pasted in half, or left as a placeholder like "changeme", would
 * otherwise be a working key. Refusing short ones means a misconfiguration
 * locks the door instead of opening it. 24 characters is far below what a real
 * random secret should be and far above any accident.
 */
export const MIN_SECRET_LENGTH = 24;

/**
 * The secret the caller presented, or "" when there is none.
 *
 * FOUR HEADER NAMES, and the reason is the measurement the comment above asked
 * for. Muse's connector screen refused these doors three times, each refusal
 * spelled "check your API key", and twice the key was fine: once the door would
 * not answer the browser's permission question, once it advertised its own
 * description at an address that 404s. The remaining candidate is the header
 * itself — a setup screen that sends `apikey` or `X-API-Key` against a door that
 * reads only two other names gets a 401 that looks exactly like a wrong secret.
 * Accepting the common spellings costs nothing: the secret is what opens the
 * door, and its name was never part of the guard.
 *
 * A secret in the QUERY STRING is still refused, and that is not laziness — query
 * strings end up in server logs, browser history and referrer headers.
 */
export function presentedSecret(req: Request): string {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  for (const name of ["X-Muse-Token", "X-API-Key", "apikey", "X-Api-Key"]) {
    const v = (req.headers.get(name) ?? "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * Which person is calling, or null.
 *
 * Fails CLOSED on every path: no secret presented, no secret configured, a
 * configured value too short to be real, or a value that matches neither person.
 *
 * Every candidate is compared even after one matches. Returning early on the
 * first hit would make "is this Gino's secret" measurably faster than "is this
 * Xinyan's", which tells an attacker which half of the keyspace to work on.
 */
export function callerOf(req: Request, secrets: ReadSecrets): Person | null {
  const presented = presentedSecret(req);
  if (!presented) return null;

  let found: Person | null = null;
  for (const person of ["gino", "xinyan"] as const) {
    const configured = secrets[person];
    const usable = typeof configured === "string" && configured.length >= MIN_SECRET_LENGTH;
    const hit = usable && safeEqual(presented, configured);
    if (hit && found === null) found = person;
  }
  return found;
}
