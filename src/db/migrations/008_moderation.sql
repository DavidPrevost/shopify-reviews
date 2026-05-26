-- Retract-with-reason + moderation audit log.
--
-- Two changes:
--   1. Add moderation_reason and moderation_note columns to reviews. These
--      hold the *current* reason/note (the latest retract). Full history of
--      retract/restore actions lives in moderation_events.
--   2. New moderation_events table records every moderation action with the
--      from→to status transition, reason, free-text note, actor, and whether
--      the customer was notified. Append-only; never updated or deleted.
--
-- moderation_reason is one of the enum values defined in MODERATION_REASONS
-- in queries.ts. We deliberately don't constrain it at the DB level — the
-- enum may grow, and pinning it to a CHECK constraint forces a migration
-- every time a value is added.

ALTER TABLE reviews ADD COLUMN moderation_reason TEXT;
ALTER TABLE reviews ADD COLUMN moderation_note TEXT;

CREATE TABLE moderation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- retract|restore (extend as needed)
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,                        -- nullable for restore events
  note TEXT,                          -- internal-only free text
  actor TEXT NOT NULL,                -- admin identifier; 'admin' until multi-user
  customer_notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_moderation_events_review ON moderation_events(review_id, created_at);
