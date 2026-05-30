-- Campaign feedback forms — per (campaign, product) anonymous response
-- collection. Participants reach a form via a shared URL key (no per-user
-- tracking links); responses can optionally carry name + email but the form
-- never requires them.
--
-- Four tables, all under campaigns:
--   campaign_feedback_forms     - one row per (campaign, optional product)
--   campaign_feedback_questions - ordered question list per form
--   campaign_feedback_responses - one row per submission
--   campaign_feedback_answers   - per-question values per response

PRAGMA defer_foreign_keys = ON;

CREATE TABLE campaign_feedback_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  shopify_product_id TEXT,             -- NULL = campaign-wide feedback form
  title TEXT NOT NULL,
  intro_text TEXT,
  access_key TEXT NOT NULL,            -- shared URL token, gates form access
  created_at INTEGER NOT NULL,
  UNIQUE(shop_id, access_key)
);
CREATE INDEX idx_feedback_forms_campaign ON campaign_feedback_forms(campaign_id);

CREATE TABLE campaign_feedback_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  form_id INTEGER NOT NULL REFERENCES campaign_feedback_forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- rating_1_5|single_choice|multi_choice|short_text|long_text
  prompt TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,                   -- choice options for single_choice/multi_choice
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_questions_form ON campaign_feedback_questions(form_id, position);

CREATE TABLE campaign_feedback_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL DEFAULT 1,
  form_id INTEGER NOT NULL REFERENCES campaign_feedback_forms(id) ON DELETE CASCADE,
  submitted_at INTEGER NOT NULL,
  optional_name TEXT,
  optional_email TEXT,
  ip_hash TEXT
);
CREATE INDEX idx_feedback_responses_form ON campaign_feedback_responses(form_id, submitted_at);

CREATE TABLE campaign_feedback_answers (
  response_id INTEGER NOT NULL REFERENCES campaign_feedback_responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES campaign_feedback_questions(id) ON DELETE CASCADE,
  value_text TEXT,
  value_number REAL,
  value_json TEXT,
  PRIMARY KEY (response_id, question_id)
);
