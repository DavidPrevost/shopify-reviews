// The single chokepoint for "which shop is this request for."
//
// Today we're single-tenant — getCurrentShopId() returns a constant. When
// the embedded admin lands (next sprint), this function becomes "read the
// shop from the Shopify session token / X-Shopify-Shop-Domain" — and every
// other place in the code that needs a shop id keeps calling this same
// function, unchanged. That's the whole point of the seam: one place to
// edit when we go multi-tenant, not a thousand.
//
// See multi-tenancy-foundation.md for the full plan + decisions.

import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { log } from './logger.js';
import { nowSec } from './time.js';

export const CURRENT_SHOP_ID = 1;

export const getCurrentShopId = (): number => CURRENT_SHOP_ID;

// Resolve a shop id from a Shopify shop domain (e.g. "brand.myshopify.com").
// Returns null when no shops row matches. Used by webhook handlers to verify
// an incoming webhook is for a shop we know about — defensive on top of HMAC.
export const findShopIdByDomain = (shopDomain: string | null | undefined): number | null => {
  if (!shopDomain) return null;
  const row = getDb()
    .prepare('SELECT id FROM shops WHERE shop_domain = ?')
    .get(shopDomain) as { id: number } | undefined;
  return row?.id ?? null;
};

// Persist the OAuth-issued offline access token (and the scopes granted) for
// a shop. Called from /auth/callback after a successful token exchange. The
// Admin API client reads this column at request time and uses it instead of
// SHOPIFY_ADMIN_TOKEN once it's populated.
export const setShopAccessToken = (input: {
  shopDomain: string;
  accessToken: string;
  scopes: string;
}): void => {
  const stmt = getDb().prepare(`
    UPDATE shops
       SET access_token  = ?,
           access_scopes = ?,
           installed_at  = COALESCE(installed_at, ?)
     WHERE shop_domain = ?
  `);
  const result = stmt.run(input.accessToken, input.scopes, nowSec(), input.shopDomain);
  if (result.changes === 0) {
    // The shop row didn't exist — happens during fresh installs before
    // ensureCurrentShop has run (or under a different shop domain than the
    // one ensureCurrentShop seeded). Insert it.
    getDb().prepare(`
      INSERT INTO shops (shop_domain, access_token, access_scopes, installed_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.shopDomain, input.accessToken, input.scopes, nowSec(), nowSec());
  }
  log('info', 'shop access token persisted', { shopDomain: input.shopDomain, scopes: input.scopes });
};

// Upsert the single shops row (id=1) from env config on every boot.
//
// Migration 016 inserts a placeholder row so shop_id=1 is a valid FK target
// during the migration itself. This fills in the real values from .env once
// the app starts. Same pattern as the curated profanity-wordlist seed.
export const ensureCurrentShop = (): void => {
  const shopDomain = config.shopify.shopDomain || 'placeholder.myshopify.com';
  const stmt = getDb().prepare(`
    INSERT INTO shops (id, shop_domain, storefront_origin, brand_name, api_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      shop_domain       = excluded.shop_domain,
      storefront_origin = excluded.storefront_origin,
      brand_name        = excluded.brand_name,
      api_version       = excluded.api_version
  `);
  stmt.run(
    CURRENT_SHOP_ID,
    shopDomain,
    config.storefrontOrigin || null,
    config.email.brandName || null,
    config.shopify.apiVersion || null,
    nowSec(),
  );
  log('info', 'ensureCurrentShop', { id: CURRENT_SHOP_ID, shopDomain });
};
