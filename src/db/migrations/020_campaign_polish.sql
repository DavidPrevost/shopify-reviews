-- Second-pass polish on the Campaigns feature:
--   1. Campaign terms get a separate `summary_text` column for the plain-
--      language summary shown prominently above the full legal terms. The
--      summary is required and snapshotted into each version alongside the
--      full body, so historical audit captures both.
--   2. Email templates gain a `campaign_id` column for the per-campaign
--      override pattern. NULL = shop default (existing behavior). Non-NULL =
--      a campaign-specific clone of the default, edited from inside the
--      campaign view. Dispatcher prefers campaign-specific over default.
--      Requires constraint rebuild because (shop_id, template_key) → must
--      become (shop_id, campaign_id, template_key) so a default + a
--      per-campaign clone of the same trigger can coexist.

PRAGMA defer_foreign_keys = ON;

-- =========================================================================
-- 1. campaign_terms_versions: add summary_text. Nullable for back-compat with
--    rows seeded by migration 018 (those had no summary); the admin UI nudges
--    a merchant to add one when they next save a version.
-- =========================================================================

ALTER TABLE campaign_terms_versions ADD COLUMN summary_text TEXT;

-- =========================================================================
-- 2. email_templates: add campaign_id + rebuild UNIQUE constraint. The
--    existing UNIQUE(shop_id, template_key) is too narrow now that the same
--    template_key can have a default row (campaign_id NULL) and N campaign-
--    specific clones. SQLite treats NULLs as distinct in UNIQUE constraints,
--    so the new (shop_id, campaign_id, template_key) tuple correctly allows
--    one default + multiple campaign-specific rows for the same key.
-- =========================================================================

CREATE TABLE email_templates_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL DEFAULT 1,
  campaign_id    INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  template_key   TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  subject        TEXT NOT NULL,
  body_html      TEXT NOT NULL,
  cta_enabled    INTEGER NOT NULL DEFAULT 1,
  cta_label      TEXT NOT NULL DEFAULT 'Write a review',
  trigger_event  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

INSERT INTO email_templates_new
  (id, shop_id, campaign_id, template_key, display_name, is_active, subject, body_html,
   cta_enabled, cta_label, trigger_event, created_at, updated_at)
  SELECT id, shop_id, NULL, template_key, display_name, is_active, subject, body_html,
         cta_enabled, cta_label, trigger_event, created_at, updated_at
    FROM email_templates;

DROP TABLE email_templates;
ALTER TABLE email_templates_new RENAME TO email_templates;

-- Two partial unique indexes instead of one composite UNIQUE: SQLite treats
-- multiple NULLs as distinct in a UNIQUE column, so a composite (shop_id,
-- campaign_id, template_key) would silently allow duplicate default rows
-- (where campaign_id IS NULL). Splitting the constraint by NULL-ness of
-- campaign_id enforces "one default per shop+key" AND "one override per
-- shop+campaign+key" independently.
CREATE UNIQUE INDEX uniq_default_template
  ON email_templates(shop_id, template_key)
  WHERE campaign_id IS NULL;

CREATE UNIQUE INDEX uniq_campaign_template
  ON email_templates(shop_id, campaign_id, template_key)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX idx_email_templates_campaign
  ON email_templates(campaign_id) WHERE campaign_id IS NOT NULL;
