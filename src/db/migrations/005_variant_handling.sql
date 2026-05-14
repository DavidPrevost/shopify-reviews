-- Per-product config for whether variants share reviews or each variant has
-- its own review pool. Source of truth is a Shopify metafield (namespace
-- 'reviews', key 'variant_handling') that the merchant sets in Shopify admin;
-- we mirror it into products_cache so storefront API reads don't hit Shopify
-- on every request. NULL = unknown yet / treat as 'shared' (the safe default).
-- Values used: 'distinct' means each variant has its own review pool;
-- anything else (including NULL and 'shared') means all variants share.

ALTER TABLE products_cache ADD COLUMN variant_handling TEXT;
