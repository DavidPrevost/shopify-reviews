-- Campaigns: application-based sample distribution program. The data model is
-- general enough to serve both the brand's Summer 26 review-seeding push and
-- future use cases (ongoing free-sample acquisition, beta tester recruitment,
-- etc.). See campaigns-feature-plan.md for the full design rationale.
--
-- Three new tables:
--   - campaigns:                the campaign itself (name, slug, status,
--                               target_size, discount terms, product set).
--   - campaign_terms_versions:  versioned terms text. Each merchant save
--                               creates a new row; member rows point at the
--                               version they accepted so historical text
--                               stays reachable.
--   - campaign_members:         one row per application. customer_id is
--                               NULL until approval; shipping_address_json
--                               lives in its own nullable column so the
--                               retention pipe can NULL it surgically.
--
-- Plus a nullable campaign_id on sample_invitations so campaign-generated
-- invitations group with their campaign while the existing /sample-program
-- review flow keeps working unchanged.

PRAGMA defer_foreign_keys = ON;

-- =========================================================================
-- 1. campaigns
-- =========================================================================

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',     -- draft|recruiting|closed|shipping|active|completed|cancelled
  target_size INTEGER NOT NULL,
  capacity_warning_threshold INTEGER,       -- absolute count, NULL = no warning
  capacity_warning_fired_at INTEGER,        -- unix sec; reset by admin to re-arm
  product_set_json TEXT NOT NULL DEFAULT '[]',  -- [{shopify_product_id, shopify_variant_id}, ...]
  discount_percent INTEGER,
  discount_expires_days INTEGER,
  discount_code_prefix TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id, slug)
);
CREATE INDEX idx_campaigns_status ON campaigns(shop_id, status);

-- =========================================================================
-- 2. campaign_terms_versions
-- =========================================================================

CREATE TABLE campaign_terms_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(shop_id, campaign_id, version_number)
);

-- =========================================================================
-- 3. campaign_members
-- =========================================================================

CREATE TABLE campaign_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id),    -- NULL until approval upserts
  status TEXT NOT NULL DEFAULT 'applied',          -- applied|approved|rejected|shipped|reviewed|done
  application_data_json TEXT NOT NULL,
  shipping_address_json TEXT,                      -- nullable so retention purge is one column update
  retention_status TEXT NOT NULL DEFAULT 'active', -- active|pending_deletion|purged
  terms_version_id INTEGER NOT NULL REFERENCES campaign_terms_versions(id),
  terms_accepted_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  discount_code TEXT,
  discount_code_id TEXT,                           -- Shopify GID for delete API
  code_status TEXT,                                -- NULL|active|redeemed|expired|deleted_from_shopify
  code_redeemed_at INTEGER,
  code_redeemed_order_id TEXT,
  code_redeemed_order_total REAL,
  decided_at INTEGER,
  decided_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_campaign_members_status ON campaign_members(shop_id, campaign_id, status);
CREATE INDEX idx_campaign_members_code ON campaign_members(discount_code) WHERE discount_code IS NOT NULL;

-- =========================================================================
-- 4. sample_invitations: campaign_id link
-- =========================================================================

ALTER TABLE sample_invitations ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
CREATE INDEX idx_sample_invitations_campaign ON sample_invitations(campaign_id) WHERE campaign_id IS NOT NULL;
