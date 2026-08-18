// Caller authorization for the JWT-verified edge functions.
//
// WHY THIS EXISTS — the trap it closes:
//
// Setting `verify_jwt = true` on an edge function does NOT mean "only a
// signed-in user can call this". It means "the request carries a valid project
// credential". The publishable key is a valid project credential, and it is
// compiled into the browser bundle by design — it is served to the whole
// internet at https://voeximus.github.io/homebase/assets/index-*.js.
//
// So `verify_jwt = true` was, in practice, no authorization at all. An audit
// reproduced it live: an anonymous request carrying nothing but the public
// publishable key reached the `plaid` function's action switch, where
// `disconnect` hard-deletes every transaction and account on a connection using
// a service-role client that RLS does not constrain. Hand-entered rows match
// that delete exactly as feed rows do. `sync` returned live bank descriptors and
// dollar amounts to the same unauthenticated caller. `notify` would push
// arbitrary text to both household phones.
//
// The fix is to check WHO is calling, which verify_jwt never did.
//
// Exactly two callers are legitimate:
//   1. A signed-in household user. The browser's supabase.functions.invoke()
//      sends that user's access token, which auth.getUser() resolves to a real
//      user. A publishable key resolves to nobody — that is the whole point.
//   2. Internal service-to-service calls: plaid-webhook -> plaid, and any
//      pg_cron/pg_net job. Those present SUPABASE_SERVICE_ROLE_KEY.
//
// Fails CLOSED: no bearer, an unrecognized bearer, or an auth lookup error all
// deny. A missing SUPABASE_SERVICE_ROLE_KEY disables only the service path, it
// never opens the function up.

const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Structural type only — avoids coupling this file to a supabase-js version.
type AuthCapable = {
  auth: {
    getUser(jwt: string): Promise<{ data: { user: unknown } | null; error: unknown }>;
  };
};

/** Length-independent comparison, so a wrong key can't be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearerOf(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

/** True when the caller is an internal service-role call (webhook / cron). */
export function isServiceCaller(req: Request): boolean {
  const bearer = bearerOf(req);
  return !!SERVICE && !!bearer && safeEqual(bearer, SERVICE);
}

/**
 * Returns a 401 Response when the caller is neither a signed-in user nor an
 * internal service call, or `null` when the caller is allowed. Call it as the
 * FIRST thing in the handler, before the request body is even read:
 *
 *   const denied = await denyUnlessCaller(req, admin, CORS);
 *   if (denied) return denied;
 */
export async function denyUnlessCaller(
  req: Request,
  admin: AuthCapable,
  cors: Record<string, string> = {},
): Promise<Response | null> {
  const deny = () =>
    new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  const bearer = bearerOf(req);
  if (!bearer) return deny();
  if (SERVICE && safeEqual(bearer, SERVICE)) return null;

  try {
    // A publishable key is not a user token, so this resolves to no user — which
    // is precisely the case verify_jwt waved through.
    const { data, error } = await admin.auth.getUser(bearer);
    if (error || !data || !data.user) return deny();
    return null;
  } catch {
    return deny(); // never fail open on a transport error
  }
}
