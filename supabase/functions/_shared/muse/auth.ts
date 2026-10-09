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

/**
 * Everyone in the household, as the rest of the system spells them: the
 * push_subscriptions `owner` webpush.ts matches on, and the name a sentence uses.
 *
 * MOVED HERE 2026-10-09 from muse-write/kit.ts, which still re-exports it. The
 * heartbeat needed the household list — it must check EVERY person's devices, not
 * only the people who happen to have a row — and the one place the code already knew
 * the household was a constant inside the write door, which nothing in _shared may
 * import. One copy, below both doors, typed by Person so a third person cannot be
 * added to the house without being added here.
 */
export const DISPLAY: Readonly<Record<Person, string>> = { gino: "Gino", xinyan: "Xinyan" };

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
/**
 * Which person is calling, checked against SEVERAL sets of secrets.
 *
 * WHY MORE THAN ONE SET, and it is a platform constraint rather than a preference.
 * Muse's connector is an egress allowlist plus one stored bearer token, scoped to a
 * BARE HOSTNAME: `ganzefaciiyibselizqi.supabase.co`. Both doors are paths on that
 * one host, so the platform can hold exactly one token for both of them. A second
 * connector for the same host was refused six times — five under one name and once
 * under a name that had never existed, with a spec identical field for field to the
 * connector that saved on its first try, and with a key proved good by a 200 from
 * the door itself moments earlier.
 *
 * So the write door accepts a person's READ key as well as their write key. That is
 * a real loss and the file above describes what it was worth: read access can no
 * longer be handed out without also handing out writes. What is NOT lost is the part
 * that protects the household — no key here moves money, every write records what it
 * replaced and returns an undo token, and each person's keys still answer only about
 * that person. The alternative was a door nobody can write through, on a system whose
 * whole point is that there is no app to open.
 *
 * Still separate: the READ door does not accept write keys. The collapse is one-way,
 * so a write key leaking does not become a second way to read, and `finance.*` reads
 * keep working through the key that has always done them.
 *
 * Every candidate in every set is compared even after one matches, for the reason
 * callerOf gives below.
 */
export function callerOfAny(req: Request, sets: readonly ReadSecrets[]): Person | null {
  const presented = presentedSecret(req);
  if (!presented) return null;

  let found: Person | null = null;
  for (const secrets of sets) {
    for (const person of ["gino", "xinyan"] as const) {
      const configured = secrets?.[person];
      const usable = typeof configured === "string" && configured.length >= MIN_SECRET_LENGTH;
      const hit = usable && safeEqual(presented, configured);
      if (hit && found === null) found = person;
    }
  }
  return found;
}

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
