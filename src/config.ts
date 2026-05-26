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
