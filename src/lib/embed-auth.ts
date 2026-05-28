// Embedded-admin authentication helpers — used by /admin/* once we move to
// App Bridge. Three layers:
//
//   1. Shopify session token (JWT) verification — App Bridge issues these per
//      embedded admin request. Signed with the app's client secret; carries
//      the shop (`dest`) and the user (`sub`). Lifetime ~1 minute.
//
//   2. Embedded session cookie — a longer-lived (24h) signed cookie we set
//      after a successful session-token exchange. Because session tokens
//      expire on the minute and aren't carried on plain GET navigation,
//      server-rendered admin page loads and `<form>` POSTs would otherwise
//      have nothing to authenticate against. The cookie bridges the gap: set
//      it once per session via /admin/exchange-session, and every subsequent
//      same-origin request inside the iframe carries it automatically.
//
//      The cookie is SameSite=None; Secure so it's sent on requests made from
//      inside the Shopify-admin iframe (which the browser treats as a cross-
//      site context relative to admin.shopify.com). Modern Chrome/Edge honor
//      this for first-party origins; Safari with strict ITP requires the
//      Storage Access API — a Safari-readiness pass is deferred.
//
//   3. Bootstrap HTML — what /admin/* serves when there is no valid cookie.
//      A tiny page that loads App Bridge, calls `shopify.idToken()` to get a
//      fresh session token, posts it to /admin/exchange-session to mint the
//      cookie, then reloads. The reload now carries the cookie and renders
//      the real admin page.

import { config } from '../config.js';
import {
  hmacSha256,
  constantTimeEqual,
  signToken,
  verifyToken,
} from './hmac.js';

// --- 1. Session token (JWT) verification ---

// The claims Shopify packs into the session token. Documented at
// shopify.dev/docs/apps/build/authentication-authorization/session-tokens.
export interface SessionTokenClaims {
  iss: string;   // issuer — the shop admin URL
  dest: string;  // destination — `https://<shop>.myshopify.com`
  aud: string;   // audience — our app's client id
  sub: string;   // subject — the Shopify user id
  exp: number;   // expiry (unix seconds)
  nbf: number;   // not-before
  iat: number;   // issued-at
  jti: string;   // jwt id
  sid: string;   // shopify session id
}

export type SessionTokenVerifyResult =
  | { ok: true; claims: SessionTokenClaims; shopDomain: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'bad_audience' | 'bad_dest' };

const base64UrlDecode = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
};

const base64UrlEncode = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const verifySessionToken = (jwt: string): SessionTokenVerifyResult => {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Signature over `<header>.<payload>` with the app's client secret.
  const expectedSig = base64UrlEncode(hmacSha256(config.shopify.webhookSecret, `${headerB64}.${payloadB64}`));
  if (!constantTimeEqual(expectedSig, sigB64)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: SessionTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as SessionTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const now = Math.floor(Date.now() / 1000);
  // A small leeway (5s) so a token issued right before a clock-skew tick
  // doesn't get rejected for nbf.
  if (typeof claims.exp !== 'number' || claims.exp < now) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf > now + 5) return { ok: false, reason: 'not_yet_valid' };

  if (claims.aud !== config.shopify.apiKey) return { ok: false, reason: 'bad_audience' };

  // `dest` is `https://<shop>.myshopify.com` — pull just the domain part out.
  let shopDomain: string;
  try {
    const u = new URL(claims.dest);
    shopDomain = u.hostname;
  } catch {
    return { ok: false, reason: 'bad_dest' };
  }
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain)) {
    return { ok: false, reason: 'bad_dest' };
  }

  return { ok: true, claims, shopDomain };
};

// --- 2. Embedded session cookie ---

export const EMBED_SESSION_COOKIE = 'reviews_embed_session';
const EMBED_SESSION_TTL_SEC = 24 * 60 * 60; // 24 hours

interface EmbedSessionPayload {
  shop: string;
  exp: number;
}

export const signEmbedSession = (shopDomain: string): string => {
  const payload: EmbedSessionPayload = {
    shop: shopDomain,
    exp: Math.floor(Date.now() / 1000) + EMBED_SESSION_TTL_SEC,
  };
  return signToken(config.shopify.webhookSecret, payload);
};

// Returns the verified shop domain, or null if the cookie is missing/invalid/expired.
export const verifyEmbedSession = (cookieValue: string | undefined): string | null => {
  if (!cookieValue) return null;
  const result = verifyToken<EmbedSessionPayload>(config.shopify.webhookSecret, cookieValue);
  if (!result.ok) return null;
  return result.payload.shop ?? null;
};

// --- 3. Bootstrap HTML ---

// Served when an admin request has no valid embedded session cookie. Loads
// App Bridge (which auto-initializes from the `shopify-api-key` meta tag),
// gets a session token, exchanges it for our cookie, then reloads — at which
// point the cookie is present and the real admin page renders.
export const bootstrapHtml = (): string => {
  const apiKey = config.shopify.apiKey;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="${apiKey}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Loading Reviews admin…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #444; }
  .err { background:#fee; border:1px solid #fcc; color:#933; padding:12px; border-radius:4px; margin-top:16px; }
</style>
</head>
<body>
<p>Loading Reviews admin…</p>
<div id="err" class="err" style="display:none;"></div>
<script>
(async function () {
  try {
    if (!window.shopify || typeof window.shopify.idToken !== 'function') {
      throw new Error('App Bridge did not initialize. Open this app from inside Shopify admin.');
    }
    var token = await window.shopify.idToken();
    var res = await fetch('/admin/exchange-session', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error('Session exchange failed (' + res.status + ').');
    // Cookie is now set; reload the original URL so the admin page renders.
    location.reload();
  } catch (err) {
    var msg = (err && err.message) ? err.message : String(err);
    var el = document.getElementById('err');
    el.style.display = 'block';
    el.textContent = msg;
  }
})();
</script>
</body>
</html>`;
};
