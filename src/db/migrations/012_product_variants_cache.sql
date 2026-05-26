-- Cache variant id→title alongside the product cache so the admin Reviews list
-- can show "Large / Blue" instead of a bare numeric variant id. Stored as a
-- JSON object { "<variantId>": "<title>", ... } on the existing products_cache
-- row, populated by the same Shopify product fetch that fills the rest of the
-- row. Nullable: rows cached before this migration (or products fetched before
-- the fetch query was extended) simply have no variant titles, and the admin
-- falls back to product-name-only.
ALTER TABLE products_cache ADD COLUMN variants_json TEXT;
