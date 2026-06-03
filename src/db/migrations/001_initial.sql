-- Initial schema for shopify-reviews app.
-- Single-tenant; multi-tenant retrofit would add a shop_id column to every row.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_customer_id TEXT,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  global_opt_out INTEGER NOT NULL DEFAULT 0,
  unanswered_request_count INTEGER NOT NULL DEFAULT 0,
  last_request_sent_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE products_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  featured_image_url TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  shopify_order_id TEXT NOT NULL,
  shopify_product_id TEXT NOT NULL,
  fulfilled_at INTEGER,
  due_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER,
  reviewed_at INTEGER,
  product_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(shopify_order_id, shopify_product_id)
);
CREATE INDEX idx_purchases_due ON purchases(due_at)
  WHERE reviewed_at IS NULL AND product_opt_out = 0;

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  reviewer_email TEXT NOT NULL,
  reviewer_name TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT NOT NULL,
  verified_purchase INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  -- Merchant replies: admin can store a reply, but the storefront widget does
  -- not surface them yet. Future-feature columns (forward-compat).
  merchant_reply TEXT,
  merchant_reply_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_product ON reviews(shopify_product_id, status);

-- Reserved for a future photo/video reviews feature. Schema only: no app code
-- reads or writes this table yet (touched solely by the GDPR redact wipe).
-- Kept per the "pour the schema now" forward-compat decision.
CREATE TABLE review_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'image',
  storage_key TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  purchase_id INTEGER REFERENCES purchases(id),
  kind TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_events_customer ON email_events(customer_id, kind);

-- Reserved for a future product Q&A feature. Schema only: no app code reads or
-- writes this table yet (touched solely by the GDPR redact wipe). NOTE: this is
-- NOT the campaign feedback questions table — those are campaign_feedback_*
-- (migration 019) and are fully built.
CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  asker_email TEXT,
  body TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('cadence_max_requests',       '3'),
  ('cadence_min_days_between',   '7'),
  ('request_delay_days',         '7'),
  ('cadence_dispatcher_batch',   '100'),
  ('shop_brand_json',            '{}');
