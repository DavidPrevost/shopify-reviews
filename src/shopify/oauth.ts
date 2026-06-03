// Shopify OAuth helpers — primitives used by src/routes/auth.ts to install
// the app on a shop and capture the per-shop OFFLINE access token. We deliberately
// roll our own here rather than wire up @shopify/shopify-api's full session
// lifecycle, because the lib's session-storage abstraction is more machinery
// than we need for a Hono + SQLite single-tenant install. (Embedded-admin
// session-token (JWT) verification is likewise hand-rolled — see
// src/lib/embed-auth.ts.) Mirrors the patterns in
// src/scripts/install-shopify.ts (which does the same thing for the one-shot
// CLI flow) — they share concepts but not code, because the install script is
// deliberately self-contained.

import crypto from 'node:crypto';
import { hmacSha256Hex, constantTimeEqual } from '../lib/hmac.js';

// Scopes the app requests. Must match (or be a subset of) what's configured on
// the app in the Shopify Partner Dashboard — if these change, the merchant
// gets re-prompted on next install.
// write_discounts is needed for per-participant campaign discount codes
// (discountCodeBasicCreate / discountCodeDelete); see campaigns-feature-plan.md.
export const OAUTH_SCOPES = 'read_orders,read_customers,read_products,write_discounts';

// Accept '<handle>.myshopify.com' only. Anything else is rejected — defense
// against an attacker passing ?shop=evil.com and getting us to redirect users
// to a phishing authorize page.
export const isValidShopDomain = (shop: string): boolean => {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop);
};

// Extract the short handle from a *.myshopify.com domain (e.g.
// "brand.myshopify.com" → "brand"). Used to build admin.shopify.com URLs.
export const shopHandle = (shopDomain: string): string =>
  shopDomain.replace(/\.myshopify\.com$/i, '');

// Build the Shopify authorize URL the merchant is sent to. We hit
// admin.shopify.com/store/<handle>/oauth/authorize directly rather than the
// legacy <shop>.myshopify.com/admin/oauth/authorize, because the legacy URL's
// server-side redirect to the consolidated admin strips every query param
// except client_id, breaking the flow.
export const getAuthorizeUrl = (input: {
  shopDomain: string;
  clientId: string;
  scopes: string;
  redirectUri: string;
  state: string;
}): string => {
  const url = new URL(`https://admin.shopify.com/store/${shopHandle(input.shopDomain)}/oauth/authorize`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', input.scopes);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
};

// Verify the HMAC on a Shopify OAuth callback. Shopify signs every callback
// (and every webhook) with the app's client secret; if this check fails the
// "callback" is forged. Same algorithm as install-shopify.ts.
export const verifyCallbackHmac = (
  params: URLSearchParams,
  clientSecret: string,
): boolean => {
  const hmac = params.get('hmac');
  if (!hmac) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const expected = hmacSha256Hex(clientSecret, message);
  return constantTimeEqual(expected, hmac);
};

export interface TokenExchangeResult {
  accessToken: string;
  scopes: string;
}

// Exchange the OAuth code for a permanent OFFLINE access token. We refuse to
// accept ONLINE (per-user, expiring) tokens — the dispatcher runs in the
// background, so an expiring token would silently break it. install-shopify.ts
// makes the same call.
export const exchangeCodeForToken = async (input: {
  shopDomain: string;
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenExchangeResult> => {
  const res = await fetch(`https://${input.shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    expires_in?: number;
    associated_user_scope?: string;
    associated_user?: unknown;
  };
  if (!data.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(data)}`);
  }
  // Online tokens carry expires_in or associated_user; we want offline only.
  if (data.expires_in !== undefined || data.associated_user !== undefined) {
    throw new Error(
      'Shopify returned an ONLINE access token (per-user, expiring), but the ' +
      'background dispatcher requires an OFFLINE token. Re-check the OAuth ' +
      'request — access_mode should not be set.',
    );
  }
  return { accessToken: data.access_token, scopes: data.scope ?? '' };
};

// Generate a random nonce for OAuth state. Signed-and-cookied at /auth, then
// verified on the callback as CSRF protection.
export const generateNonce = (): string => crypto.randomBytes(16).toString('hex');
