-- Email templates: per-template subject, body, and CTA settings live in the
-- database so the merchant can edit them via the admin Branding page. Shared
-- branding (logo, footer text, sender name) lives in the settings table as
-- `email_branding_json`, so it's consistent across every template.
--
-- Designed for scaling to N templates: each row is a single template keyed
-- by a short identifier the dispatcher picks based on context. Today the
-- dispatcher uses 'request_first' or 'request_repeat'; future templates
-- (review-thank-you, abandoned-review-followup, etc.) just add rows here.
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  cta_enabled INTEGER NOT NULL DEFAULT 1,
  cta_label TEXT NOT NULL DEFAULT 'Write a review',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
