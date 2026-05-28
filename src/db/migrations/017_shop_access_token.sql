-- Per-shop OAuth access token storage, in preparation for the embedded admin
-- sprint. The OAuth callback (/auth/callback) writes the offline access token
-- it gets back from Shopify into this column; the Admin API client reads it
-- from here at request time.
--
-- This replaces the static SHOPIFY_ADMIN_TOKEN env var as the source of the
-- access token. We keep the env var around briefly as a fallback for the
-- transition (the existing static-token install on the dev store keeps working
-- while the embedded code is being built); once the OAuth install lands and
-- writes the token here, the env var becomes ignored.
--
-- Nullable: a shops row exists from boot (ensureCurrentShop seeds it), but
-- access_token is NULL until the OAuth flow has run. See
-- multi-tenancy-foundation.md "Next sprint — embedded admin."
ALTER TABLE shops ADD COLUMN access_token TEXT;

-- Scopes granted by the most recent OAuth install. Used to detect when the
-- merchant needs to re-approve after we add a scope (Shopify re-prompts on
-- scope changes; we compare against the expected set at startup to log a
-- warning if the install is behind).
ALTER TABLE shops ADD COLUMN access_scopes TEXT;
