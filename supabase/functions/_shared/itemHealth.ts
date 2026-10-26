// Whether a bank login still works, from what Plaid says about it.
//
// WHY THIS FILE EXISTS, 2026-10-26. Plaid tells us, days ahead, when a bank login is
// about to stop working — PENDING_EXPIRATION (the bank's permission runs out on a date),
// PENDING_DISCONNECT (the bank is about to cut the login off) — and tells us the moment
// one has stopped (an ITEM ERROR such as ITEM_LOGIN_REQUIRED). plaid-webhook answered
// every one of those "ok" and did nothing with it, so the first anyone heard of a dead
// login was the feed going quiet — a balance that stopped moving, which looks exactly
// like a quiet week. The read door's freshness stamp and the heartbeat already have a
// loud branch for a connection in `needs_reauth` (schema_v8's word for it); nothing ever
// put a connection there.
//
// So these webhooks now set bank_connections.status to 'needs_reauth', with the reason
// in last_error, in plain words that say what to do: sign in again with Connect a bank
// in the app (which repairs the SAME login now — see linkToken's connection_id). And
// the sync stops washing the warning away:
//   · an ADVANCE warning (the login still works for now) survives a successful sync,
//     because a sync succeeding says nothing about a date that has not come yet;
//   · a login that has STOPPED is cleared by a successful sync, because that sync is the
//     proof it works again — and so is either kind by a repair through the app (the
//     plaid function's `repaired` action) or Plaid's own LOGIN_REPAIRED.
//
// Every reason is written here, from fixed words, Plaid's own code and at most a date —
// never Plaid's free text — because finance.bank_status repeats last_error to Muse.
//
// Pure: no database, no clock.

/** The words every reason starts with, so a reader of last_error sees the instruction
 *  first. */
export const REAUTH_SAYS = "Needs signing in again";

/** Where the sign-in happens. "Connect a bank" repairs only the login of the phone it is
 *  tapped on (repairTarget in src/lib/plaidClient.ts, 2026-10-26) — on anyone else's phone
 *  it links a new bank — so the instruction says whose phone. */
export const SIGN_IN_WHERE = "with Connect a bank in the app, on the phone of the person whose bank login this is";

/** Plaid error codes that only the person can fix, by signing in again (update mode). */
export const LOGIN_ERROR_CODES: readonly string[] = [
  "ITEM_LOGIN_REQUIRED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "INSUFFICIENT_CREDENTIALS",
  "ITEM_LOCKED",
  "USER_SETUP_REQUIRED",
  "ACCESS_NOT_GRANTED",
];

/** The two advance warnings: the login still works, and will not for long. */
const ADVANCE_CODES = ["PENDING_EXPIRATION", "PENDING_DISCONNECT"] as const;

export type ItemUpdate =
  /** The login needs signing in again. `warning`: it still works for now. */
  | { status: "needs_reauth"; reason: string; warning: boolean }
  /** Something else went wrong at the bank, which signing in again will not fix. */
  | { status: "error"; reason: string }
  /** The login works again — clear a needs_reauth. */
  | { status: "repaired" };

const CODE = /^[A-Z][A-Z_]{2,40}$/;
const code = (v: unknown): string | null => (typeof v === "string" && CODE.test(v) ? v : null);

/** "2026-11-02" from Plaid's timestamp, or null — never the raw string. */
function dayOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function stoppedReason(errorCode: string): string {
  return (
    `${REAUTH_SAYS}: the bank stopped accepting the saved login (${errorCode}), so nothing new ` +
    `arrives from it. Sign in again ${SIGN_IN_WHERE}.`
  );
}

/**
 * What one Plaid webhook says about a login, or null when it says nothing about one —
 * a TRANSACTIONS ping, an ITEM code that changes nothing here (NEW_ACCOUNTS_AVAILABLE,
 * WEBHOOK_UPDATE_ACKNOWLEDGED), or a body that is not a webhook at all.
 */
export function itemWebhookUpdate(body: Record<string, unknown> | null | undefined): ItemUpdate | null {
  if (!body || body.webhook_type !== "ITEM") return null;
  const wc = code(body.webhook_code);
  if (!wc) return null;

  if (wc === "LOGIN_REPAIRED") return { status: "repaired" };

  if (wc === "PENDING_EXPIRATION") {
    const day = dayOf(body.consent_expiration_time);
    return {
      status: "needs_reauth",
      warning: true,
      reason:
        `${REAUTH_SAYS}${day ? ` before ${day}` : " soon"}: the bank's permission for this connection ` +
        `runs out${day ? ` on ${day}` : ""} (PENDING_EXPIRATION). It still syncs until then. Sign in ` +
        `again ${SIGN_IN_WHERE}, before it stops.`,
    };
  }

  if (wc === "PENDING_DISCONNECT") {
    const why = code(body.reason);
    return {
      status: "needs_reauth",
      warning: true,
      reason:
        `${REAUTH_SAYS} within about a week: the bank is about to disconnect this login ` +
        `(PENDING_DISCONNECT${why ? `, ${why}` : ""}). It still syncs until then. Sign in again ` +
        `${SIGN_IN_WHERE}, before it stops.`,
    };
  }

  // Sent by some integrations as its own code rather than inside an ERROR.
  if (wc === "ITEM_LOGIN_REQUIRED" || wc === "LOGIN_REQUIRED") {
    return { status: "needs_reauth", warning: false, reason: stoppedReason("ITEM_LOGIN_REQUIRED") };
  }

  if (wc === "ERROR") {
    const err = body.error as Record<string, unknown> | null | undefined;
    const ec = code(err?.error_code);
    if (ec && LOGIN_ERROR_CODES.includes(ec)) {
      return { status: "needs_reauth", warning: false, reason: stoppedReason(ec) };
    }
    return {
      status: "error",
      reason: `The bank reported a problem with this connection${ec ? ` (${ec})` : ""}. It may clear by itself; if it does not, check the bank.`,
    };
  }

  return null;
}

/** Is this stored reason one of the advance warnings — the login still works for now? */
export function isAdvanceWarning(lastError: string | null | undefined): boolean {
  return typeof lastError === "string" && ADVANCE_CODES.some((c) => lastError.includes(`(${c}`));
}

/**
 * The Plaid login error inside a failed sync's message, or null. The sync's own error is
 * `plaid /path 400: {…"error_code":"ITEM_LOGIN_REQUIRED"…}` (the plaid() helper in
 * plaid/index.ts), so the code is read out of that JSON — only a code on the list
 * counts, never a word that happens to appear in a message.
 */
export function loginErrorIn(message: string | null | undefined): string | null {
  if (typeof message !== "string") return null;
  const m = message.match(/"error_code"\s*:\s*"([A-Z_]+)"/);
  return m && LOGIN_ERROR_CODES.includes(m[1]) ? m[1] : null;
}

/**
 * The health columns to write after a sync that SUCCEEDED, given what the row holds now.
 *
 * Healthy ("ok", and the sync's own pending-insert note or nothing) — unless the row
 * holds an advance warning, which a sync succeeding today does not answer: then it keeps
 * 'needs_reauth' and the reason, word for word.
 */
export function healthAfterSync(
  stored: { status?: string | null; last_error?: string | null } | null | undefined,
  syncNote: string | null,
): { status: string; last_error: string | null } {
  if (stored?.status === "needs_reauth" && isAdvanceWarning(stored.last_error)) {
    return { status: "needs_reauth", last_error: stored.last_error ?? null };
  }
  return { status: "ok", last_error: syncNote };
}

/**
 * The health columns to write after a sync that FAILED with `message`.
 *
 * A login error is 'needs_reauth' with the plain reason. Any other failure is 'error' with
 * the message, as before — except on a row already in 'needs_reauth', which keeps its
 * status and its reason: "sign in again" is the instruction that matters, and a passing
 * network error must not bury it.
 */
export function healthAfterFailure(
  stored: { status?: string | null; last_error?: string | null } | null | undefined,
  message: string,
): { status: string; last_error: string } {
  const login = loginErrorIn(message);
  if (login) return { status: "needs_reauth", last_error: stoppedReason(login) };
  if (stored?.status === "needs_reauth" && stored.last_error) {
    return { status: "needs_reauth", last_error: stored.last_error };
  }
  return { status: "error", last_error: message.slice(0, 400) };
}
