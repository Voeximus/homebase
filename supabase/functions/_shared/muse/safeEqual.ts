// One comparison for every secret in the bridge.
//
// WHY IT IS ITS OWN FILE. `safeEqual` in supabase/functions/_shared/callerAuth.ts
// is the original, and it cannot be imported: that module reads Deno's environment
// as it loads, so importing it from a test or from a non-Deno runtime takes the
// whole thing down. So the doors each grew a private copy — auth.ts had one and
// muse-write/handler.ts had another — and cron-reminders compared its token with
// `!==` instead, which returns as soon as two characters differ.
//
// A comparison that returns early leaks, in timing, how much of a guess was right.
// Over the internet that signal is small and noisy, so this is hardening rather
// than a live hole — but supabase/config.toml now tells the reader that these
// functions compare their secrets in constant time, and a sentence like that has
// to be true of every one of them. One file, no environment read, three importers.

/** Length-independent comparison, so a wrong secret cannot be recovered by timing.
 *  Different lengths still return immediately: a length is not a secret, and
 *  padding one out would compare a guess against whatever the padding was. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
