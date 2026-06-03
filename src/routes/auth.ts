// OAuth install routes for the embedded admin.
//
// Flow:
//   1. Merchant clicks "Install" (or opens the app for the first time) and lands
//      at GET /auth?shop=<handle>.myshopify.com.
//   2. We validate the shop domain, generate a random nonce, sign it into a
//      short-lived cookie (the "state cookie"), and 302 the browser to Shopify's
//      OAuth authorize page. The state appears in the URL too — Shopify echoes
//      it back on the callback for CSRF protection.
//   3. The merchant approves the scopes.
//   4. Shopify 302s back to GET /auth/callback?code=&hmac=&shop=&state=&timestamp=.
//   5. We verify the HMAC (signed with the app's client secret), verify the
//      state matches the cookie (CSRF), exchange the code for an OFFLINE access
//      token, and persist it on the shops row.
//   6. Finally we 302 the merchant into Shopify admin's embedded-app entry
//      (`admin.shopify.com/store/<handle>/apps/<client-id>`), which opens our
//      app embedded inside the Shopify admin chrome.
//
// Everything is stateless on our side except the signed state cookie — no
// in-memory or DB store of pending installs. The cookie carries everything we
// need to verify on the callback.

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.js';
import { signToken, verifyToken } from '../lib/hmac.js';
import { nowSec } from '../lib/time.js';
import { log } from '../lib/logger.js';
import { setShopAccessToken } from '../lib/tenant.js';
import {
  isValidShopDomain,
  shopHandle,
  getAuthorizeUrl,
  verifyCallbackHmac,
  exchangeCodeForToken,
  generateNonce,
} from '../shopify/oauth.js';
import { OAUTH_SCOPES } from '../shopify/scopes.js';

const STATE_COOKIE = 'reviews_oauth_state';
const STATE_TTL_SECONDS = 600; // 10 minutes is generous for a merchant to approve

interface StateCookiePayload {
  shop: string;
  nonce: string;
  exp: number;
}

const trimUrl = (s: string) => s.replace(/\/+$/, '');
const redirectUri = (): string => `${trimUrl(config.publicUrl)}/auth/callback`;

const auth = new Hono();

// GET /auth?shop=<handle>.myshopify.com — start the install. The ?shop= param
// is provided by Shopify when the merchant clicks Install from the dashboard,
// or by the embedded admin's auth bounce when the shop has no access_token yet.
auth.get('/', (c) => {
  if (!config.shopify.apiKey || !config.shopify.webhookSecret) {
    log('error', 'OAuth start failed: missing SHOPIFY_CLIENT_ID or SHOPIFY_WEBHOOK_SECRET');
    return c.text('App not configured for OAuth (missing client id or secret).', 500);
  }

  const shop = c.req.query('shop');
  if (!shop || !isValidShopDomain(shop)) {
    return c.text('Missing or invalid shop parameter. Expected <handle>.myshopify.com.', 400);
  }

  const nonce = generateNonce();
  const exp = nowSec() + STATE_TTL_SECONDS;
  const payload: StateCookiePayload = { shop, nonce, exp };
  const cookieValue = signToken(config.shopify.webhookSecret, payload);

  // The OAuth state param Shopify echoes back. We compare it against the cookie
  // on the callback — and we put the nonce, not the whole signed cookie, in the
  // URL so the URL stays short and doesn't leak the cookie's signed payload.
  setCookie(c, STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: STATE_TTL_SECONDS,
  });

  const url = getAuthorizeUrl({
    shopDomain: shop,
    clientId: config.shopify.apiKey,
    scopes: OAUTH_SCOPES,
    redirectUri: redirectUri(),
    state: nonce,
  });

  log('info', 'OAuth install: redirecting to authorize', { shop });
  return c.redirect(url);
});

// GET /auth/callback — Shopify hits this after the merchant approves.
auth.get('/callback', async (c) => {
  if (!config.shopify.apiKey || !config.shopify.webhookSecret) {
    return c.text('App not configured for OAuth.', 500);
  }

  const url = new URL(c.req.url);
  const params = url.searchParams;
  const code = params.get('code');
  const shop = params.get('shop');
  const state = params.get('state');

  if (!code || !shop || !state) {
    return c.text('Callback missing required parameters.', 400);
  }
  if (!isValidShopDomain(shop)) {
    return c.text('Callback shop parameter is invalid.', 400);
  }

  // HMAC first — if this fails, the callback is forged and nothing else matters.
  if (!verifyCallbackHmac(params, config.shopify.webhookSecret)) {
    log('warn', 'OAuth callback HMAC verification failed', { shop });
    return c.text('Callback signature invalid.', 401);
  }

  // State cookie — CSRF protection. The nonce in ?state must match the nonce
  // signed into the cookie we set at /auth, and the cookie's shop must match.
  const cookie = getCookie(c, STATE_COOKIE);
  if (!cookie) {
    log('warn', 'OAuth callback missing state cookie', { shop });
    return c.text('Install state expired or missing. Start over at /auth?shop=...', 400);
  }
  const stateVerify = verifyToken<StateCookiePayload>(config.shopify.webhookSecret, cookie);
  if (!stateVerify.ok) {
    log('warn', 'OAuth callback state cookie invalid', { shop, reason: stateVerify.reason });
    return c.text('Install state invalid. Start over at /auth?shop=...', 400);
  }
  if (stateVerify.payload.shop !== shop || stateVerify.payload.nonce !== state) {
    log('warn', 'OAuth callback state mismatch', { shop, expectedShop: stateVerify.payload.shop });
    return c.text('Install state mismatch. Start over at /auth?shop=...', 400);
  }

  // Exchange the code for an offline access token, then persist on the shop row.
  let token;
  try {
    token = await exchangeCodeForToken({
      shopDomain: shop,
      code,
      clientId: config.shopify.apiKey,
      clientSecret: config.shopify.webhookSecret,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'OAuth token exchange failed', { shop, error: message });
    return c.text(`Token exchange failed: ${message}`, 500);
  }

  setShopAccessToken({ shopDomain: shop, accessToken: token.accessToken, scopes: token.scopes });
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });

  // Land the merchant in the embedded admin entry inside Shopify admin. From
  // here on, the app loads in an iframe and App Bridge provides session tokens
  // for every request — the standalone /auth flow only runs again on uninstall+
  // reinstall or scope change.
  const embeddedUrl = `https://admin.shopify.com/store/${shopHandle(shop)}/apps/${config.shopify.apiKey}`;
  log('info', 'OAuth install complete, redirecting to embedded admin', { shop });
  return c.redirect(embeddedUrl);
});

export default auth;
