import { shopifyAdmin } from './admin-client.js';
import { findProductCache, upsertProductCache, listAllProductCacheRows, type ProductCacheRow } from '../db/queries.js';
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
      variants(first: 100) { nodes { id title } }
    }
  }
`;

// Shopify variant ids come back as gids (gid://shopify/ProductVariant/123).
// Reviews store the bare numeric id, so key the cache map by that.
const numericId = (gid: string): string => gid.split('/').pop() ?? gid;

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
      variants: { nodes: Array<{ id: string; title: string }> };
    } | null;
  }>(fetchQuery, { id: gid });

  if (!data.product) return null;

  const variantHandlingRaw = data.product.variantHandling?.value ?? null;

  const variantMap: Record<string, string> = {};
  for (const v of data.product.variants.nodes) {
    variantMap[numericId(v.id)] = v.title;
  }

  upsertProductCache({
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
    variantHandling: variantHandlingRaw,
    variantsJson: JSON.stringify(variantMap),
  });

  return {
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
    variantHandling: normalizeVariantHandling(variantHandlingRaw),
  };
};

// Full-catalog sync — paginates through every product in the shop and
// upserts each into products_cache. Used by the campaign product picker's
// "Refresh from Shopify" button so a brand new admin sees every product
// without each one needing a prior cache miss. Returns the count of products
// upserted. Single API call costs ~1 query unit per 50 products; a typical
// small-brand catalog of <500 is well under the rate limit.
const listAllQuery = `
  query ($cursor: String) {
    products(first: 50, after: $cursor) {
      edges {
        cursor
        node {
          id
          handle
          title
          featuredImage { url }
          variantHandling: metafield(namespace: "reviews", key: "variant_handling") { value }
          variants(first: 100) { nodes { id title } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface AllProductsResponse {
  products: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        handle: string;
        title: string;
        featuredImage: { url: string } | null;
        variantHandling: { value: string } | null;
        variants: { nodes: Array<{ id: string; title: string }> };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export const syncAllProductsToCache = async (): Promise<number> => {
  let cursor: string | null = null;
  let count = 0;
  // Defensive cap so a bug in the loop can't run forever — 100 pages × 50 =
  // 5000 products, far above any reasonable small-brand catalog.
  for (let page = 0; page < 100; page += 1) {
    const data: AllProductsResponse = await shopifyAdmin<AllProductsResponse>(
      listAllQuery,
      { cursor },
    );
    for (const edge of data.products.edges) {
      const productId = numericId(edge.node.id);
      const variantMap: Record<string, string> = {};
      for (const v of edge.node.variants.nodes) {
        variantMap[numericId(v.id)] = v.title;
      }
      upsertProductCache({
        shopifyProductId: productId,
        handle: edge.node.handle,
        title: edge.node.title,
        featuredImageUrl: edge.node.featuredImage?.url ?? null,
        variantHandling: edge.node.variantHandling?.value ?? null,
        variantsJson: JSON.stringify(variantMap),
      });
      count += 1;
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return count;
};

// All cached products, used by the campaign product picker so the merchant
// sees real product names and can pick from a checklist instead of pasting
// raw product ids. Ordered alphabetically by title for consistent display.
export const listCachedProducts = (): Array<{
  shopifyProductId: string;
  title: string;
  handle: string;
  featuredImageUrl: string | null;
}> => listAllProductCacheRows();
