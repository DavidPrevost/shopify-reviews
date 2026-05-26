-- Storefront-driven "Report this review" flow + admin moderation queue.
--
-- review_reports: each row is one report from a storefront visitor. status
-- is 'open' until the admin acts on it; admin actions auto-flip it to
-- 'dismissed' (no problem, ignore) or 'retracted' (review was removed via
-- the existing retract flow). When a review is retracted, ALL open reports
-- for that review auto-flip to 'retracted' — they're considered handled by
-- the same action. resolver_email is the actor identifier ('admin' today,
-- future-proofed for multi-admin).
--
-- banned_reporters: once an email is in here, any further /report submissions
-- from that address are silently accepted but not persisted. Returns 200 to
-- the reporter so they get no signal. Banning is by-email only because IPs
-- aren't a reliable identity.
--
-- Anti-spam at the schema level: a UNIQUE constraint on (review_id,
-- reporter_ip) means the same IP can only file one open report per review.
-- Once closed, the constraint allows another report (in case the situation
-- recurs), via the partial WHERE clause on status='open'.

CREATE TABLE review_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  message TEXT,
  reporter_email TEXT,
  reporter_ip TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_review_reports_status ON review_reports(status, created_at DESC);
CREATE INDEX idx_review_reports_review ON review_reports(review_id, created_at DESC);
CREATE UNIQUE INDEX idx_review_reports_ip_open
  ON review_reports(review_id, reporter_ip)
  WHERE status = 'open' AND reporter_ip IS NOT NULL;

CREATE TABLE banned_reporters (
  email TEXT PRIMARY KEY,
  banned_by TEXT NOT NULL,
  banned_at INTEGER NOT NULL
);
