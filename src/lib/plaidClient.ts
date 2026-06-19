// Client-side helpers for the Plaid Link flow. The browser only ever talks to
// our edge function (which holds the secrets); it never sees a Plaid secret or
// a bank token.

import { supabase } from "./supabase";

const LINK_TOKEN_KEY = "hb-plaid-link-token";

/** Which person this device belongs to (set on first launch). */
export function ownerOfDevice(): string {
  const o = localStorage.getItem("hb-owner");
  return o === "gino" ? "Gino" : o === "xinyan" ? "Xinyan" : "Joint";
}

/** Ask the edge function for a Link token. Stashed in localStorage so an OAuth
 *  redirect (which reloads the page) can resume the same Link session. */
export async function createLinkToken(): Promise<{ token?: string; error?: string }> {
  const { data, error } = await supabase.functions.invoke("plaid", {
    body: { action: "link_token", owner: ownerOfDevice() },
  });
  if (error || !data?.link_token) return { error: error?.message ?? "no link token" };
  localStorage.setItem(LINK_TOKEN_KEY, data.link_token);
  return { token: data.link_token };
}

export function storedLinkToken(): string | null {
  return localStorage.getItem(LINK_TOKEN_KEY);
}

/** Hand the public_token back to the function, which stores the access token in
 *  Vault, discovers accounts, and runs the first sync. */
export async function exchangePublicToken(public_token: string, institution?: string) {
  const res = await supabase.functions.invoke("plaid", {
    body: { action: "exchange", public_token, owner: ownerOfDevice(), institution: institution ?? "Bank" },
  });
  localStorage.removeItem(LINK_TOKEN_KEY);
  return res;
}

/** True when a bank's OAuth flow has just redirected back to us. */
export const isOAuthRedirect =
  typeof window !== "undefined" && window.location.search.includes("oauth_state_id=");
