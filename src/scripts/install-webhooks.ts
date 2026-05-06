// One-shot script to register or refresh Shopify webhook subscriptions.
// Run via: npm run install-webhooks
//
// Idempotent: lists existing subscriptions and only creates ones that don't
// already point at the right callbackUrl. Safe to re-run.

import { config, assertRequired } from '../config.js';
import { shopifyAdmin } from '../shopify/admin-client.js';

interface ExistingSubscription {
  id: string;
  topic: string;
  endpoint: { callbackUrl?: string };
}

const desired: Array<{ topic: string; path: string }> = [
  { topic: 'ORDERS_PAID',             path: '/webhooks/orders/paid' },
  { topic: 'ORDERS_FULFILLED',        path: '/webhooks/orders/fulfilled' },
  { topic: 'CUSTOMERS_DATA_REQUEST',  path: '/webhooks/customers/data_request' },
  { topic: 'CUSTOMERS_REDACT',        path: '/webhooks/customers/redact' },
  { topic: 'SHOP_REDACT',             path: '/webhooks/shop/redact' },
];

const listQuery = `
  query listSubs($cursor: String) {
    webhookSubscriptions(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        topic
        endpoint { ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
`;

const createMutation = `
  mutation createSub($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(
      topic: $topic,
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      webhookSubscription { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } }
      userErrors { field message }
    }
  }
`;

const main = async (): Promise<void> => {
  assertRequired(
    ['SHOPIFY_SHOP_DOMAIN',  config.shopify.shopDomain],
    ['SHOPIFY_ADMIN_TOKEN',  config.shopify.adminToken],
    ['PUBLIC_URL',           config.publicUrl],
  );

  interface ListResponse {
    webhookSubscriptions: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ExistingSubscription[];
    };
  }

  const existing: ExistingSubscription[] = [];
  let cursor: string | null = null;
  do {
    const data: ListResponse = await shopifyAdmin<ListResponse>(listQuery, { cursor });
    existing.push(...data.webhookSubscriptions.nodes);
    cursor = data.webhookSubscriptions.pageInfo.hasNextPage
      ? data.webhookSubscriptions.pageInfo.endCursor
      : null;
  } while (cursor);

  for (const { topic, path } of desired) {
    const url = `${config.publicUrl.replace(/\/+$/, '')}${path}`;
    const already = existing.find(
      (s) => s.topic === topic && s.endpoint?.callbackUrl === url,
    );
    if (already) {
      console.log(`✓ ${topic} → ${url} (already installed: ${already.id})`);
      continue;
    }

    const result = await shopifyAdmin<{
      webhookSubscriptionCreate: {
        webhookSubscription: { id: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }>(createMutation, { topic, url });

    const errs = result.webhookSubscriptionCreate.userErrors;
    if (errs.length > 0) {
      console.error(`✗ ${topic} → ${url} FAILED: ${errs.map((e) => e.message).join('; ')}`);
      process.exitCode = 1;
      continue;
    }
    const id = result.webhookSubscriptionCreate.webhookSubscription?.id ?? '?';
    console.log(`+ ${topic} → ${url} (created: ${id})`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
