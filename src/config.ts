import path from 'node:path';

const dataDir = process.env.DATA_DIR ?? './data';

export const config = {
  port: Number(process.env.PORT ?? 8080),
  dataDir,
  dbPath: path.join(dataDir, 'reviews.db'),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:8080',
  storefrontOrigin: process.env.STOREFRONT_ORIGIN ?? 'http://localhost',
  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
    adminToken: process.env.SHOPIFY_ADMIN_TOKEN ?? '',
    // The app's client ID (a.k.a. API key) from the Shopify Partner Dashboard.
    // Public; identifies the app in OAuth URLs and on App Bridge. Already set
    // in .env (the install-shopify helper reads it).
    apiKey: process.env.SHOPIFY_CLIENT_ID ?? '',
    // The app's client secret — used to verify webhook HMACs, sign OAuth
    // callbacks, and verify embedded-app session tokens (JWTs from App Bridge).
    // Stored under SHOPIFY_WEBHOOK_SECRET historically because the very first
    // use of it was webhook HMAC verification; same value as the dashboard's
    // "client secret" / "API secret key" field.
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET ?? '',
    apiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-01',
  },
  email: {
    tokenSecret: process.env.EMAIL_TOKEN_SECRET ?? '',
    smtp: {
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
      from: process.env.SMTP_FROM ?? '',
    },
    brandName: process.env.BRAND_NAME ?? 'the brand',
    // Operational notifications (panic-button activations, future ops alerts).
    // Sent to the developer/operator, not the merchant. Leave empty to skip.
    devNotificationEmail: process.env.DEV_NOTIFICATION_EMAIL ?? '',
  },
  admin: {
    passwordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET ?? '',
    sessionTtlDays: Number(process.env.ADMIN_SESSION_TTL_DAYS ?? 14),
  },
};

export const assertRequired = (...pairs: Array<readonly [string, string]>): void => {
  const missing = pairs.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
};
