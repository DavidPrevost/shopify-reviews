import crypto from 'node:crypto';
import { config } from '../config.js';

// Verifies that a request was forwarded through Shopify's App Proxy and that
// the query parameters haven't been tampered with. Returns true iff:
//   1. The `signature` query param is present
//   2. HMAC-SHA256(sorted other params, client_secret) matches `signature`
//
// Shopify's signing format (per their App Proxy docs):
//   - Remove `signature` from the query
//   - Sort remaining params alphabetically by key
//   - Concatenate as `key=value` with NO separator between pairs
//   - HMAC-SHA256 with the app's client secret as key
//   - Hex-encode
//   - Constant-time compare to the `signature` value
//
// For array params Shopify joins values with commas (no quoting). We don't
// expect arrays in our use cases but handle them for correctness.

export interface AppProxyVerifyResult {
  valid: boolean;
  loggedInCustomerId: string | null;
  shop: string | null;
}

export const verifyAppProxySignature = (queryParams: URLSearchParams): AppProxyVerifyResult => {
  const signature = queryParams.get('signature');
  if (!signature) return { valid: false, loggedInCustomerId: null, shop: null };

  const secret = config.shopify.webhookSecret;
  if (!secret) return { valid: false, loggedInCustomerId: null, shop: null };

  // Build sorted "key=value..." string excluding `signature`.
  const entries: Array<[string, string]> = [];
  for (const [key, value] of queryParams.entries()) {
    if (key === 'signature') continue;
    entries.push([key, value]);
  }
  // Group multi-valued params (Shopify joins with commas).
  const grouped = new Map<string, string[]>();
  for (const [key, value] of entries) {
    const list = grouped.get(key) ?? [];
    list.push(value);
    grouped.set(key, list);
  }
  const sortedKeys = [...grouped.keys()].sort();
  const signedPayload = sortedKeys
    .map((k) => `${k}=${(grouped.get(k) ?? []).join(',')}`)
    .join('');

  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time compare to avoid timing leaks. Throws on length mismatch, so
  // wrap in a length pre-check.
  let valid = false;
  if (expected.length === signature.length) {
    try {
      valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      valid = false;
    }
  }

  return {
    valid,
    loggedInCustomerId: queryParams.get('logged_in_customer_id') || null,
    shop: queryParams.get('shop') || null,
  };
};
