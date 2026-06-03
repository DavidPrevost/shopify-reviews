-- Adds a per-code usage limit to the campaigns schema. Each campaign-issued
-- discount code is unique to one participant; this column controls how many
-- times THAT participant's code can be redeemed before it's exhausted.
--
-- Default 1 preserves prior behavior (each code is single-use). Existing
-- rows from before this migration get 1 via DEFAULT. Merchants can raise it
-- per campaign at create/edit time.
--
-- A future enhancement — log in development-plan.md §15 — is the option to
-- issue a SINGLE shared code used by every participant instead of one
-- unique-per-user code. That's a different data model (no per-member
-- discount_code column), so this column is unaffected by that future change.

ALTER TABLE campaigns
  ADD COLUMN discount_usage_limit INTEGER NOT NULL DEFAULT 1;
