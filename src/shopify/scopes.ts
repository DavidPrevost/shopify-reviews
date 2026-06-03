// Single source of truth for the OAuth access scopes the app requests.
//
// Imported by BOTH the embedded OAuth install (src/routes/auth.ts) and the
// one-shot CLI installer (src/scripts/install-shopify.ts), so the two can never
// drift. A past drift — the CLI requesting only the read scopes while the
// embedded path also requested write_discounts — meant a token captured via the
// CLI silently couldn't create campaign discount codes. Keeping the list here,
// with no imports of its own, prevents that and keeps the standalone install
// script light.
//
// read_discounts + write_discounts power per-participant campaign discount codes
// (create / delete, and reading redemption state). This string must match (or be
// a subset of) the scopes declared on the app version in the Shopify Dev
// Dashboard, or the merchant gets re-prompted and the captured token is
// insufficient.
export const OAUTH_SCOPES = 'read_orders,read_customers,read_products,read_discounts,write_discounts';
