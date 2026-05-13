-- Dev-mode setting: when '1', the orders/fulfilled webhook immediately runs a
-- dispatcher pass so the review request email goes out right away rather than
-- waiting for the normal request_delay_days cadence. Default off — must be
-- explicitly enabled per stack via the admin UI.
INSERT INTO settings (key, value) VALUES
  ('dispatch_immediately_on_fulfillment', '0')
ON CONFLICT(key) DO NOTHING;
