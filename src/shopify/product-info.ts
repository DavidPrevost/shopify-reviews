import { shopifyAdmin } from './admin-client.js';
import { findProductCache, upsertProductCache, type ProductCacheRow } from '../db/queries.js';

export interface ProductInfo {
  shopifyProductId: string;
  handle: string;
  title: string;
  featuredImageUrl: string | null;
}

const fromCache = (row: ProductCacheRow): ProductInfo => ({
  shopifyProductId: row.shopify_product_id,
  handle: row.handle,
  title: row.title,
  featuredImageUrl: row.featured_image_url,
});

const fetchQuery = `
  query ($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      featuredImage { url }
    }
  }
`;

// Get product info, preferring the local cache. Falls back to Shopify and
// updates the cache on miss. Returns null only if the product no longer exists
// on the Shopify side.
export const getOrFetchProduct = async (shopifyProductId: string): Promise<ProductInfo | null> => {
  const cached = findProductCache(shopifyProductId);
  if (cached) return fromCache(cached);

  const gid = `gid://shopify/Product/${shopifyProductId}`;
  const data = await shopifyAdmin<{
    product: { id: string; handle: string; title: string; featuredImage: { url: string } | null } | null;
  }>(fetchQuery, { id: gid });

  if (!data.product) return null;

  upsertProductCache({
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
  });

  return {
    shopifyProductId,
    handle: data.product.handle,
    title: data.product.title,
    featuredImageUrl: data.product.featuredImage?.url ?? null,
  };
};
