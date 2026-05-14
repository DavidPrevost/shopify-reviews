// Accepts the various forms a user might paste in when identifying a product
// and normalizes to the canonical numeric Shopify product ID. Returns null if
// no ID can be extracted. Designed for admin convenience — users can paste
// what they have from clipboard without manually digging out the ID.
//
// Supported inputs:
//   - Plain numeric ID:     "9218705883386"
//   - GraphQL Global ID:    "gid://shopify/Product/9218705883386"
//   - Admin URL:            "https://admin.shopify.com/store/<handle>/products/9218705883386"
//   - Admin URL with path:  ".../products/9218705883386/variants/678"
//
// Not supported (intentionally):
//   - Storefront URLs with product handles (e.g. ".../products/face-cream-1") —
//     the handle is not the ID; resolving it requires a Shopify API call.

export const parseProductId = (input: string): string | null => {
  const s = input.trim();
  if (!s) return null;

  // Plain numeric ID
  if (/^\d+$/.test(s)) return s;

  // GraphQL Global ID
  const gid = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(s);
  if (gid) return gid[1] ?? null;

  // Any URL containing /products/<numeric-id>. Works for admin.shopify.com,
  // legacy <shop>.myshopify.com/admin, and variant subpaths.
  const urlMatch = /\/products\/(\d+)(?:[\/?#]|$)/.exec(s);
  if (urlMatch) return urlMatch[1] ?? null;

  return null;
};
