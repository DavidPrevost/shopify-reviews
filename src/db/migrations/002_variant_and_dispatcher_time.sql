-- Forward-compat: variant tracking on purchases and reviews. Conflating
-- variants under a single product is correct today (size variants), but for
-- flavor/scent variants we'll want to filter reviews per variant. Adding the
-- column now so future code paths don't require a migration.
ALTER TABLE purchases ADD COLUMN shopify_variant_id TEXT;
ALTER TABLE reviews   ADD COLUMN shopify_variant_id TEXT;

-- Dispatcher schedule settings — stored as UTC integers; admin UI converts
-- to/from the operator's browser timezone for display + edit.
INSERT INTO settings (key, value) VALUES
  ('dispatcher_hour',   '20'),
  ('dispatcher_minute', '17')
ON CONFLICT(key) DO NOTHING;
