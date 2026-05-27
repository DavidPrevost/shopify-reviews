-- Go-live guard: automated review requests are only sent for orders whose
-- fulfillment happened at or after this unix timestamp. 0 = disabled (no
-- cutoff), which is the dev default — the whole imported order history is
-- eligible. On the live store this is set to the launch moment (Settings →
-- Cadence → "Go-live guard") so the store's pre-existing customers are never
-- auto-emailed; those are handled manually. The dispatcher's eligibility query
-- enforces this, and the backfill leaves pre-cutoff purchases un-armed
-- (due_at NULL) so they're captured for reference but never queued.
-- See development-plan.md §10 and §15.
INSERT INTO settings (key, value) VALUES
  ('request_cutoff_at', '0')
ON CONFLICT(key) DO NOTHING;
