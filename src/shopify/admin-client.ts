import { config } from '../config.js';

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

export const shopifyAdmin = async <T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  if (!config.shopify.shopDomain || !config.shopify.adminToken) {
    throw new ShopifyAdminError('Shopify config missing: SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN must be set');
  }

  const url = `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopify.adminToken,
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
