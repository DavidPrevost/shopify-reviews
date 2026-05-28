-- Multi-tenancy foundation (Part A). See multi-tenancy-foundation.md for the
-- full rationale and the settled decisions.
--
-- Goal: add the *shape* of multi-tenancy now while the dev DB is disposable —
-- a `shops` table, a `shop_id` key on every domain table whose UNIQUE/PK
-- constraint would be painful to alter on live data, and the composite
-- constraints to match. With one seeded shop and `shop_id DEFAULT 1`, every
-- existing query and upsert keeps working as-is. Only the inline UNIQUE/PK
-- constraints become composite.
--
-- Deliberately NOT done here (per the doc):
--   - settings stays global (Decision #2) — reconstructable config, and making
--     it per-shop would drag shop-awareness into every settings read for no
--     present benefit.
--   - child/ops tables (review_media, email_events, moderation_events,
--     panic_events, review_reports) get no shop_id — they reach their shop via
--     a parent FK, and a denormalized column is a cheap ADD COLUMN later.
--   - shop_id is NOT yet threaded into query bodies — same cost later, would
--     just add bug surface now.
--
-- Rebuild mechanic: the migration runner wraps each .sql file in a
-- transaction with foreign_keys = ON (see src/db/client.ts). PRAGMA
-- foreign_keys is ignored inside a transaction, so the classic 12-step
-- (which sets foreign_keys=OFF) won't work — we use defer_foreign_keys=ON
-- instead, which IS settable mid-transaction and defers FK enforcement until
-- COMMIT. We preserve every `id` value in the rebuilt tables so child FK
-- references stay valid at the deferred check.

PRAGMA defer_foreign_keys = ON;

-- =========================================================================
-- 1. shops table + placeholder row.
-- The migration can't read env vars, so it inserts a placeholder. The boot-
-- time ensureCurrentShop() in src/lib/tenant.ts upserts the real values
-- (shop_domain, storefront_origin, brand_name, api_version) from config.
-- =========================================================================

CREATE TABLE shops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain       TEXT NOT NULL UNIQUE,
  storefront_origin TEXT,
  brand_name        TEXT,
  api_version       TEXT,
  installed_at      INTEGER,
  created_at        INTEGER NOT NULL
);

INSERT INTO shops (id, shop_domain, created_at)
  VALUES (1, 'placeholder.myshopify.com', unixepoch());

-- =========================================================================
-- 2. Reviews: index-only changes. No table rebuild — reviews has no inline
-- UNIQUE on a column, only an index-based partial unique. ADD COLUMN +
-- DROP/CREATE its two indexes with shop_id prepended.
-- =========================================================================

ALTER TABLE reviews ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_reviews_product;
CREATE INDEX idx_reviews_product ON reviews(shop_id, shopify_product_id, status);

DROP INDEX IF EXISTS idx_reviews_customer_product;
CREATE UNIQUE INDEX idx_reviews_customer_product
  ON reviews(shop_id, customer_id, shopify_product_id)
  WHERE customer_id IS NOT NULL AND status <> 'rejected';

-- =========================================================================
-- 3. customers: rebuild to change email UNIQUE → UNIQUE(shop_id, email).
-- Has FK children (purchases, reviews, email_events). Preserves ids.
-- =========================================================================

CREATE TABLE customers_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id                  INTEGER NOT NULL DEFAULT 1,
  shopify_customer_id      TEXT,
  email                    TEXT NOT NULL,
  first_name               TEXT,
  last_name                TEXT,
  global_opt_out           INTEGER NOT NULL DEFAULT 0,
  unanswered_request_count INTEGER NOT NULL DEFAULT 0,
  last_request_sent_at     INTEGER,
  created_at               INTEGER NOT NULL,
  UNIQUE(shop_id, email)
);

INSERT INTO customers_new
  (id, shop_id, shopify_customer_id, email, first_name, last_name,
   global_opt_out, unanswered_request_count, last_request_sent_at, created_at)
  SELECT id, 1, shopify_customer_id, email, first_name, last_name,
         global_opt_out, unanswered_request_count, last_request_sent_at, created_at
    FROM customers;

DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;

-- =========================================================================
-- 4. purchases: rebuild to change UNIQUE(order_id, product_id) →
-- UNIQUE(shop_id, order_id, product_id). Has FK children (email_events).
-- Preserves ids. Recreate idx_purchases_due with shop_id.
-- =========================================================================

CREATE TABLE purchases_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id             INTEGER NOT NULL DEFAULT 1,
  customer_id         INTEGER NOT NULL REFERENCES customers(id),
  shopify_order_id    TEXT NOT NULL,
  shopify_product_id  TEXT NOT NULL,
  shopify_variant_id  TEXT,
  fulfilled_at        INTEGER,
  due_at              INTEGER,
  request_count       INTEGER NOT NULL DEFAULT 0,
  last_request_at     INTEGER,
  reviewed_at         INTEGER,
  product_opt_out     INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  UNIQUE(shop_id, shopify_order_id, shopify_product_id)
);

INSERT INTO purchases_new
  (id, shop_id, customer_id, shopify_order_id, shopify_product_id,
   shopify_variant_id, fulfilled_at, due_at, request_count, last_request_at,
   reviewed_at, product_opt_out, created_at)
  SELECT id, 1, customer_id, shopify_order_id, shopify_product_id,
         shopify_variant_id, fulfilled_at, due_at, request_count, last_request_at,
         reviewed_at, product_opt_out, created_at
    FROM purchases;

DROP TABLE purchases;
ALTER TABLE purchases_new RENAME TO purchases;

CREATE INDEX idx_purchases_due ON purchases(shop_id, due_at)
  WHERE reviewed_at IS NULL AND product_opt_out = 0;

-- =========================================================================
-- 5. products_cache: rebuild for UNIQUE(shop_id, shopify_product_id).
-- FK-free; trivial rebuild.
-- =========================================================================

CREATE TABLE products_cache_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id             INTEGER NOT NULL DEFAULT 1,
  shopify_product_id  TEXT NOT NULL,
  handle              TEXT NOT NULL,
  title               TEXT NOT NULL,
  featured_image_url  TEXT,
  updated_at          INTEGER NOT NULL,
  variant_handling    TEXT,
  variants_json       TEXT,
  UNIQUE(shop_id, shopify_product_id)
);

INSERT INTO products_cache_new
  (id, shop_id, shopify_product_id, handle, title, featured_image_url,
   updated_at, variant_handling, variants_json)
  SELECT id, 1, shopify_product_id, handle, title, featured_image_url,
         updated_at, variant_handling, variants_json
    FROM products_cache;

DROP TABLE products_cache;
ALTER TABLE products_cache_new RENAME TO products_cache;

-- =========================================================================
-- 6. email_templates: rebuild for UNIQUE(shop_id, template_key).
-- FK-free; trivial rebuild.
-- =========================================================================

CREATE TABLE email_templates_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL DEFAULT 1,
  template_key   TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  subject        TEXT NOT NULL,
  body_html      TEXT NOT NULL,
  cta_enabled    INTEGER NOT NULL DEFAULT 1,
  cta_label      TEXT NOT NULL DEFAULT 'Write a review',
  trigger_event  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(shop_id, template_key)
);

INSERT INTO email_templates_new
  (id, shop_id, template_key, display_name, is_active, subject, body_html,
   cta_enabled, cta_label, trigger_event, created_at, updated_at)
  SELECT id, 1, template_key, display_name, is_active, subject, body_html,
         cta_enabled, cta_label, trigger_event, created_at, updated_at
    FROM email_templates;

DROP TABLE email_templates;
ALTER TABLE email_templates_new RENAME TO email_templates;

-- =========================================================================
-- 7. banned_reporters: rebuild to change PK(email) → PK(shop_id, email).
-- FK-free; trivial rebuild. The "ban this reporter" check is a single read
-- site, so the seam coupling is minimal.
-- =========================================================================

CREATE TABLE banned_reporters_new (
  shop_id    INTEGER NOT NULL DEFAULT 1,
  email      TEXT NOT NULL,
  banned_by  TEXT NOT NULL,
  banned_at  INTEGER NOT NULL,
  PRIMARY KEY(shop_id, email)
);

INSERT INTO banned_reporters_new (shop_id, email, banned_by, banned_at)
  SELECT 1, email, banned_by, banned_at FROM banned_reporters;

DROP TABLE banned_reporters;
ALTER TABLE banned_reporters_new RENAME TO banned_reporters;

-- =========================================================================
-- 8. sample_invitations + questions: ADD COLUMN only (no UNIQUE to change).
-- =========================================================================

ALTER TABLE sample_invitations ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE questions          ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 1;
