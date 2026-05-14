-- Sample invitations: brand-issued single-use links that let someone leave
-- a verified review without going through a Shopify purchase. Used for free
-- sample campaigns, influencer outreach, etc. Each invitation is consumed
-- exactly once and produces a review tagged with verified_kind = 'sample'.

ALTER TABLE reviews ADD COLUMN verified_kind TEXT;
UPDATE reviews SET verified_kind = 'purchase' WHERE verified_purchase = 1;

CREATE TABLE sample_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  intended_email TEXT,
  intended_name TEXT,
  notes TEXT,
  consumed_at INTEGER,
  consumed_review_id INTEGER REFERENCES reviews(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_invitations_consumed ON sample_invitations(consumed_at);
CREATE INDEX idx_invitations_product ON sample_invitations(shopify_product_id);
