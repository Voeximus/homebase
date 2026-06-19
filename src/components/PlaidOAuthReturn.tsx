import { useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { exchangePublicToken, isOAuthRedirect, storedLinkToken } from "../lib/plaidClient";

// Real banks (BofA, Chase, …) use OAuth: Link sends the user to the bank, which
// redirects back to our app URL with ?oauth_state_id=…. On that return we must
// re-open Link with the stored token + receivedRedirectUri so it resumes exactly
// where it left off. This sits at the top of the app (mounted on every load,
// above the welcome/mode screens) so it always catches the redirect.
export function PlaidOAuthReturn() {
  const [token] = useState<string | null>(isOAuthRedirect ? storedLinkToken() : null);

  const onSuccess = async (public_token: string, metadata: any) => {
    await exchangePublicToken(public_token, metadata?.institution?.name);
    // drop the oauth query and refresh so the freshly-linked accounts show up
    window.history.replaceState({}, "", window.location.pathname);
    window.location.reload();
  };

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    ...(isOAuthRedirect ? { receivedRedirectUri: window.location.href } : {}),
  });

  useEffect(() => {
    if (isOAuthRedirect && token && ready) open();
  }, [token, ready, open]);

  return null;
}
