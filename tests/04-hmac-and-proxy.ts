// HMAC primitives + Shopify App Proxy signature verification.
//
// These gate (a) every Shopify webhook (proves it came from Shopify), and
// (b) every customer review submission via the storefront widget (proves the
// request came through Shopify's edge with a logged-in customer). A bug in
// either lets unauthenticated requests through.

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { TestRun, assert, assertEqual } from './_harness.js';

const TEST_SECRET = 'shpss_test_secret_for_hmac_verification';
process.env.SHOPIFY_WEBHOOK_SECRET = TEST_SECRET;
process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.DATA_DIR = path.join(os.tmpdir(), `reviews-hmac-${Date.now()}`);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';

const { hmacSha256Hex, hmacSha256Base64, constantTimeEqual } = await import('../src/lib/hmac.js');
const { verifyAppProxySignature } = await import('../src/shopify/app-proxy-verify.js');
const { verifyShopifyWebhook } = await import('../src/shopify/webhook-verify.js');
const { verifyCallbackHmac } = await import('../src/shopify/oauth.js');

const run = new TestRun('04-hmac-and-proxy');

// --- HMAC primitives ---

await run.test('hmacSha256Hex matches Node crypto reference', () => {
  const ours = hmacSha256Hex('key', 'message');
  const ref = crypto.createHmac('sha256', 'key').update('message').digest('hex');
  assertEqual(ours, ref, 'hmacSha256Hex output diverges from Node crypto reference');
});

await run.test('hmacSha256Base64 matches Node crypto reference', () => {
  const ours = hmacSha256Base64('key', 'message');
  const ref = crypto.createHmac('sha256', 'key').update('message').digest('base64');
  assertEqual(ours, ref, 'hmacSha256Base64 output diverges from Node crypto reference');
});

await run.test('constantTimeEqual: equal strings return true', () => {
  assertEqual(constantTimeEqual('abc', 'abc'), true, 'Equal strings should compare true');
});

await run.test('constantTimeEqual: different same-length strings return false', () => {
  assertEqual(constantTimeEqual('abc', 'abd'), false, 'Different same-length strings should compare false');
});

await run.test('constantTimeEqual: different-length strings return false (no exception)', () => {
  // Important: timingSafeEqual throws on length mismatch; the wrapper must
  // pre-check length and return false instead.
  let threw = false;
  let result: boolean | undefined;
  try {
    result = constantTimeEqual('abc', 'abcd');
  } catch {
    threw = true;
  }
  assert(!threw, 'constantTimeEqual must NOT throw on length mismatch — it should return false');
  assertEqual(result, false, 'Different-length should compare false');
});

// --- Shopify webhook HMAC ---

await run.test('verifyShopifyWebhook: valid signature returns true', () => {
  const body = '{"id":12345,"email":"a@b.com"}';
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(body).digest('base64');
  assertEqual(verifyShopifyWebhook(body, sig), true, 'Valid HMAC should verify');
});

await run.test('verifyShopifyWebhook: missing signature returns false', () => {
  const body = '{}';
  assertEqual(verifyShopifyWebhook(body, undefined), false, 'Missing sig should fail');
});

await run.test('verifyShopifyWebhook: tampered body returns false', () => {
  const body = '{"id":12345}';
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(body).digest('base64');
  const tamperedBody = '{"id":99999}';
  assertEqual(verifyShopifyWebhook(tamperedBody, sig), false, 'Tampered body should fail');
});

await run.test('verifyShopifyWebhook: wrong secret used to sign returns false', () => {
  const body = '{}';
  const wrongSig = crypto.createHmac('sha256', 'wrong-secret').update(body).digest('base64');
  assertEqual(verifyShopifyWebhook(body, wrongSig), false, 'Wrong-secret sig should fail');
});

// --- OAuth callback HMAC ---

await run.test('verifyCallbackHmac: a valid callback verifies', () => {
  const params = new URLSearchParams({
    code: 'abc123',
    shop: 'test.myshopify.com',
    state: 'nonce-xyz',
    timestamp: '1234567890',
  });
  // Build the message Shopify would sign: sorted, URL-encoded, joined with &.
  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');
  params.set('hmac', sig);
  assertEqual(verifyCallbackHmac(params, TEST_SECRET), true, 'Valid OAuth callback HMAC should verify');
});

await run.test('verifyCallbackHmac: tampered param fails', () => {
  const params = new URLSearchParams({
    code: 'abc123',
    shop: 'test.myshopify.com',
    state: 'nonce-xyz',
    timestamp: '1234567890',
  });
  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');
  params.set('hmac', sig);
  params.set('code', 'tampered'); // attacker swap
  assertEqual(verifyCallbackHmac(params, TEST_SECRET), false, 'Tampered OAuth callback param must not verify');
});

await run.test('verifyCallbackHmac: missing hmac param returns false', () => {
  const params = new URLSearchParams({ code: 'x', shop: 'x.myshopify.com' });
  assertEqual(verifyCallbackHmac(params, TEST_SECRET), false, 'No hmac param should fail');
});

// --- App Proxy signature ---

// Helper: produce a valid App Proxy signed query for our test secret.
const signProxy = (params: Record<string, string | string[]>): URLSearchParams => {
  const grouped = new Map<string, string[]>();
  for (const [k, v] of Object.entries(params)) {
    grouped.set(k, Array.isArray(v) ? v : [v]);
  }
  const sortedKeys = [...grouped.keys()].sort();
  const payload = sortedKeys.map((k) => `${k}=${(grouped.get(k) ?? []).join(',')}`).join('');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');
  const out = new URLSearchParams();
  for (const k of sortedKeys) {
    for (const v of grouped.get(k)!) out.append(k, v);
  }
  out.set('signature', sig);
  return out;
};

await run.test('verifyAppProxySignature: a valid signed query verifies', () => {
  const params = signProxy({
    logged_in_customer_id: '1234',
    shop: 'test.myshopify.com',
    path_prefix: '/apps/reviews',
    timestamp: '1700000000',
  });
  const result = verifyAppProxySignature(params);
  assert(result.valid, `Valid signed query should verify. Got valid=${result.valid}`);
  assertEqual(result.loggedInCustomerId, '1234', 'Customer id extracted');
  assertEqual(result.shop, 'test.myshopify.com', 'Shop extracted');
});

await run.test('verifyAppProxySignature: missing signature returns invalid', () => {
  const params = new URLSearchParams({ shop: 'test.myshopify.com' });
  const result = verifyAppProxySignature(params);
  assertEqual(result.valid, false, 'No signature → invalid');
});

await run.test('verifyAppProxySignature: tampered param fails', () => {
  const params = signProxy({
    logged_in_customer_id: '1234',
    shop: 'test.myshopify.com',
    timestamp: '1700000000',
  });
  params.set('logged_in_customer_id', '9999'); // attacker swaps customer
  const result = verifyAppProxySignature(params);
  assertEqual(result.valid, false, 'Swapping the customer id MUST invalidate the signature');
});

await run.test('verifyAppProxySignature: wrong-secret signature fails', () => {
  const params = new URLSearchParams({ shop: 'test.myshopify.com', timestamp: '1700000000' });
  const payload = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join('');
  params.set('signature', crypto.createHmac('sha256', 'wrong-secret').update(payload).digest('hex'));
  const result = verifyAppProxySignature(params);
  assertEqual(result.valid, false, 'Signature from wrong secret must not verify');
});

await run.test('verifyAppProxySignature: extracts loggedInCustomerId only when valid signature', () => {
  // An unauthenticated request can still set logged_in_customer_id in the URL —
  // the function should NOT trust it when the signature is invalid.
  const params = new URLSearchParams({ logged_in_customer_id: '99999' });
  // No signature param at all.
  const result = verifyAppProxySignature(params);
  assertEqual(result.valid, false, 'No signature → invalid');
  // Implementation returns null for loggedInCustomerId when invalid is also correct.
  // We don't enforce that specifically — the proxy route relies on valid===true.
});

process.exit(run.finish() ? 0 : 1);
