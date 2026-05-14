import { shopifyAdmin } from './admin-client.js';
import { findProductCache, upsertProductCache, type ProductCacheRow } from '../db/queries.js';
import { nowSec } from '../lib/time.js';

export interface ProductInfo {
  shopifyProductId: string;
  handle: string;
  title: string;
  featuredImageUrl: string | null;
  // Sourced from the Shopify metafield namespace="reviews", key="variant_handling".
  // 'distinct' → each variant has its own review pool; anything else (NULL,
  // 'shared', or missing) → variants share a single review pool. The admin
  // setup-instructions surface explains how the merchant sets this.
  variantHandling: 'distinct' | 'shared';
}

// Cached metafield values can go stale if the merchant updates them on
// Shopify's side; TTL gives natural propagation without manual refresh.
// Admin also has a "refresh product cache" action that flushes immediately.
const PRODUCT_CACHE_TTL_SEC = 60 * 60; // 1 hour

const normalizeVariantHandling = (raw: string | null | undefined): 'distinct' | 'shared' =>
  raw === 'distinct' ? 'distinct' : 'shared';

const fromCache = (row: ProductCacheRow): ProductInfo => ({
  shopifyProductId: row.shopify_product_id,
  handle: row.handle,
  title: row.title,
  featuredImageUrl: row.featured_image_url,
  variantHandling: normalizeVariantHandling(row.variant_handling),
});

const fetchQuery = `
  query ($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      featuredImage { url }
      variantHandling: metafield(namespace: "reviews", key: "variant_handling") { value }
    }
  }
`;

// Get product info, preferring the local cache. Falls back to Shopify and
// updates the cache on miss or when the cached row is older than the TTL.
// Returns null only if the product no longer exists on the Shopify side.
export const getOrFetchProduct = async (shopifyProductId: string): Promise<ProductInfo | null> => {
  const cached = findProductCache(shopifyProductId);
  if (cached && cached.updated_at >= nowSec() - PRODUCT_CACHE_TTL_SEC) {
    return fromCache(cached);
  }

  const gid = `gid://shopify/Product/${shopifyProductId}`;
  const data = await shopifyAdmin<{
    product: {
      id: string;
      handle: string;
      title: string;
      featuredImage: { url: string } | null;
      variantHandling: { value: string } | null;
    } | null;
  }>(fetchQuery, { id: gid });

  if (!data.product) return null;

  const variantHandlingRaw = data.product.variantHandling?.value ?? null;

  upsertProductCache({
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
    variantHandling: variantHandlingRaw,
  });

  return {
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
    variantHandling: normalizeVariantHandling(variantHandlingRaw),
  };
};
