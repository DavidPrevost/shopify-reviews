import { config } from '../config.js';
import { getShopByDomain } from '../lib/tenant.js';

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export interface GraphQLUserError {
  field: string[] | null;
  message: string;
  code?: string;
}

export class ShopifyAdminError extends Error {
  constructor(message: string, public readonly errors?: GraphQLError[]) {
    super(message);
    this.name = 'ShopifyAdminError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: { cost?: { actualQueryCost: number; throttleStatus: { currentlyAvailable: number } } };
}

// Resolve the access token to use for an API call. Prefers the per-shop
// OAuth token stored on the shops row (written by /auth/callback); falls back
// to the legacy SHOPIFY_ADMIN_TOKEN env var for the brief transition before
// the embedded OAuth install has run. Once OAuth has populated the DB column,
// the env var becomes ignored.
const resolveAdminToken = (shopDomain: string): string | null => {
  const shop = getShopByDomain(shopDomain);
  if (shop?.access_token) return shop.access_token;
  if (config.shopify.adminToken) return config.shopify.adminToken;
  return null;
};

export const shopifyAdmin = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  if (!config.shopify.shopDomain) {
    throw new ShopifyAdminError('Shopify config missing: SHOPIFY_SHOP_DOMAIN must be set');
  }
  const token = resolveAdminToken(config.shopify.shopDomain);
  if (!token) {
    throw new ShopifyAdminError('Shopify admin token missing: install the app via /auth or set SHOPIFY_ADMIN_TOKEN');
  }

  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ShopifyAdminError(`Shopify Admin API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyAdminError(
      `Shopify Admin API errors: ${json.errors.map((e) => e.message).join('; ')}`,
      json.errors,
    );
  }
  if (!json.data) {
    throw new ShopifyAdminError('Shopify Admin API returned no data and no errors');
  }
  return json.data;
};
