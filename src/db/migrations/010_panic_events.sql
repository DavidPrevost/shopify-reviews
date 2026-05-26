-- Emergency "pause reviews" audit trail. Every pause / extend / resume
-- action creates one row here. Current pause state itself lives in the
-- settings table (panic_paused_until, panic_paused_reason, panic_paused_at)
-- so the "is the system paused right now?" check is a single setting read
-- — but the audit log is the canonical history of who paused what and why.
--
-- paused_until on a 'pause' or 'extend' event records what the new expiration
-- was set to. On a 'resume' event it's NULL (the resume cleared the lock
-- early). Pause events without an early resume just lapse silently when
-- paused_until passes — no event row marks the expiration; the dashboard
-- detects it on read.

CREATE TABLE panic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,            -- pause | extend | resume
  reason TEXT,                         -- required on pause; carried on extend; null on resume
  actor TEXT NOT NULL,                 -- admin identifier; 'admin' until multi-user
  paused_until INTEGER,                -- unix sec; NULL on resume
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_panic_events_created ON panic_events(created_at DESC);
