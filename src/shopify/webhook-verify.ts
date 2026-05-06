import { config } from '../config.js';
import { hmacSha256Base64, constantTimeEqual } from '../lib/hmac.js';

// Shopify signs the raw request body with the webhook secret using HMAC-SHA256
// and sends the base64-encoded result in the X-Shopify-Hmac-Sha256 header.
export const verifyShopifyWebhook = (rawBody: string | Buffer, headerSignature: string | undefined): boolean => {
  if (!headerSignature || !config.shopify.webhookSecret) return false;
  const expected = hmacSha256Base64(config.shopify.webhookSecret, rawBody);
  return constantTimeEqual(expected, headerSignature);
};
