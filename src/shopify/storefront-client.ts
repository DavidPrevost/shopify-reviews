import { config } from '../config.js';
import { shopifyAdmin, ShopifyAdminError } from './admin-client.js';
import { getSetting, setSetting } from '../db/queries.js';
import { log } from '../lib/logger.js';

// Storefront API client. Separate from the Admin API client because a handful
// of fields we need — most notably `shop.brand` (logo, colors, slogan) — live
// only on the Storefront API, not the Admin API.
//
// Auth model: we mint a *public* Storefront access token via the Admin API's
// storefrontAccessTokenCreate mutation (using the Admin token we already have)
// and cache it in settings. The token is low-sensitivity by design — public
// Storefront tokens are meant to be exposed in storefront JS — so plaintext in
// the settings table is fine. If the app version doesn't have Storefront API
// access enabled, the mint call fails with a Shopify userError; we surface that
// message verbatim so the operator knows a reinstall (to add Storefront access)
// is required.

const TOKEN_SETTING_KEY = 'storefront_access_token';

export class ShopifyStorefrontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyStorefrontError';
  }
}

const CREATE_TOKEN_MUTATION = `
  mutation CreateStorefrontToken($input: StorefrontAccessTokenInput!) {
    storefrontAccessTokenCreate(input: $input) {
      storefrontAccessToken { accessToken }
      userErrors { field message }
    }
  }
`;

interface CreateTokenResponse {
  storefrontAccessTokenCreate: {
    storefrontAccessToken: { accessToken: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const createStorefrontToken = async (): Promise<string> => {
  let data: CreateTokenResponse;
  try {
    data = await shopifyAdmin<CreateTokenResponse>(CREATE_TOKEN_MUTATION, {
      input: { title: 'shopify-reviews brand sync' },
    });
  } catch (err) {
    // The most likely failure here is the app version not having Storefront API
    // access enabled. Re-wrap with a hint so the operator knows what to do.
    const base = err instanceof ShopifyAdminError ? err.message : String(err);
    throw new ShopifyStorefrontError(
      `Could not create a Storefront access token (${base}). If this mentions access or scope, the Reviews app version needs Storefront API access enabled in the Dev Dashboard, then a reinstall on this store.`,
    );
  }

  const payload = data.storefrontAccessTokenCreate;
  if (payload.userErrors.length > 0) {
    throw new ShopifyStorefrontError(
      `Storefront token creation rejected: ${payload.userErrors.map((e) => e.message).join('; ')}`,
    );
  }
  const token = payload.storefrontAccessToken?.accessToken;
  if (!token) {
    throw new ShopifyStorefrontError('Storefront token creation returned no token');
  }
  setSetting(TOKEN_SETTING_KEY, token);
  log('info', 'minted storefront access token');
  return token;
};

const getStorefrontToken = async (forceRefresh = false): Promise<string> => {
  if (!forceRefresh) {
    const existing = getSetting(TOKEN_SETTING_KEY);
    if (existing) return existing;
  }
  return createStorefrontToken();
};

interface StorefrontResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const post = async <T>(token: string, query: string, variables?: Record<string, unknown>): Promise<Response> => {
  const url = `https://${config.shopify.shopDomain}/api/${config.shopify.apiVersion}/graphql.json`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
};

export const shopifyStorefront = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  if (!config.shopify.shopDomain || !config.shopify.adminToken) {
    throw new ShopifyStorefrontError('Shopify config missing: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN must be set');
  }

  let token = await getStorefrontToken();
  let res = await post<T>(token, query, variables);

  // A cached token can be revoked out from under us (e.g. app reinstalled).
  // On an auth rejection, mint a fresh token once and retry.
  if (res.status === 401 || res.status === 403) {
    token = await getStorefrontToken(true);
    res = await post<T>(token, query, variables);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ShopifyStorefrontError(`Shopify Storefront API HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as StorefrontResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new ShopifyStorefrontError(
      `Shopify Storefront API errors: ${json.errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (!json.data) {
    throw new ShopifyStorefrontError('Shopify Storefront API returned no data and no errors');
  }
  return json.data;
};
