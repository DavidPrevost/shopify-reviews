import { Hono } from 'hono';
import {
  upsertCustomer,
  upsertPurchase,
  markOrderFulfilled,
  findCustomerByEmail,
  findCustomerByShopifyId,
  anonymizeCustomer,
  logEmailEvent,
  getSettingNumber,
} from '../db/queries.js';
import { getDb } from '../db/client.js';
import { log } from '../lib/logger.js';
import { nowSec, daysToSec } from '../lib/time.js';
import { verifyShopifyWebhook } from '../shopify/webhook-verify.js';

// Shape of the orders/* webhook payload we actually consume. Shopify sends much
// more — we only type the fields we touch. Anything else is ignored.
interface OrderPayloadCustomer {
  id?: number;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}
interface OrderPayloadLineItem {
  product_id?: number | null;
  variant_id?: number | null;
  quantity?: number;
}
interface OrderPaidPayload {
  id: number;
  email?: string | null;
  customer?: OrderPayloadCustomer | null;
  line_items?: OrderPayloadLineItem[];
}
interface OrderFulfilledPayload {
  id: number;
}
interface CustomerRedactPayload {
  customer?: { id?: number; email?: string };
}

const webhooks = new Hono();

// Middleware-like helper: verify HMAC and return the parsed JSON body, or null
// if verification fails. The route handler turns null into a 401.
const verifyAndParse = async <T>(c: import('hono').Context): Promise<T | null> => {
  const sig = c.req.header('x-shopify-hmac-sha256');
  const raw = await c.req.text();
  if (!verifyShopifyWebhook(raw, sig)) {
    log('warn', 'webhook hmac verification failed', { topic: c.req.path });
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    log('warn', 'webhook body not valid JSON', { topic: c.req.path });
    return null;
  }
};

webhooks.post('/orders/paid', async (c) => {
  const body = await verifyAndParse<OrderPaidPayload>(c);
  if (!body) return c.text('Unauthorized', 401);

  const orderId = String(body.id);
  const email = body.customer?.email ?? body.email ?? null;
  const shopifyCustomerId = body.customer?.id ? String(body.customer.id) : null;
  const lineItems = body.line_items ?? [];

  if (!email) {
    log('info', 'orders/paid skipped: no email on order', { orderId });
    return c.json({ ok: true, skipped: 'no_email' });
  }

  const customer = upsertCustomer({
    shopifyCustomerId,
    email,
    firstName: body.customer?.first_name ?? null,
    lastName: body.customer?.last_name ?? null,
  });

  let inserted = 0;
  for (const item of lineItems) {
    if (!item.product_id) continue;
    upsertPurchase({
      customerId: customer.id,
      shopifyOrderId: orderId,
      shopifyProductId: String(item.product_id),
      shopifyVariantId: item.variant_id ? String(item.variant_id) : null,
      fulfilledAt: null,
      dueAt: null,
    });
    inserted += 1;
  }

  log('info', 'orders/paid processed', { orderId, customerEmail: email, lines: inserted });
  return c.json({ ok: true });
});

webhooks.post('/orders/fulfilled', async (c) => {
  const body = await verifyAndParse<OrderFulfilledPayload>(c);
  if (!body) return c.text('Unauthorized', 401);

  const orderId = String(body.id);
  const fulfilledAt = nowSec();
  const delayDays = getSettingNumber('request_delay_days', 7);
  const dueAt = fulfilledAt + daysToSec(delayDays);

  const updated = markOrderFulfilled({
    shopifyOrderId: orderId,
    fulfilledAt,
    dueAt,
  });

  log('info', 'orders/fulfilled processed', { orderId, purchasesUpdated: updated });
  return c.json({ ok: true, updated });
});

// --- GDPR webhooks ---
// Shopify mandates these three. They must respond 200 with a valid HMAC even
// when there is nothing to do; otherwise Shopify will eventually disable the app.

webhooks.post('/customers/data_request', async (c) => {
  const body = await verifyAndParse<CustomerRedactPayload>(c);
  if (!body) return c.text('Unauthorized', 401);

  // We don't auto-export. The owner handles data requests manually for a single store.
  log('info', 'customers/data_request received', {
    shopifyCustomerId: body.customer?.id ? String(body.customer.id) : null,
    email: body.customer?.email ?? null,
  });
  return c.json({ ok: true });
});

webhooks.post('/customers/redact', async (c) => {
  const body = await verifyAndParse<CustomerRedactPayload>(c);
  if (!body) return c.text('Unauthorized', 401);

  const shopifyCustomerId = body.customer?.id ? String(body.customer.id) : null;
  const email = body.customer?.email ?? null;

  let customer = null;
  if (shopifyCustomerId) customer = findCustomerByShopifyId(shopifyCustomerId);
  if (!customer && email) customer = findCustomerByEmail(email);

  if (customer) {
    anonymizeCustomer(customer.id);
    logEmailEvent({ customerId: customer.id, purchaseId: null, kind: 'redacted' });
    log('info', 'customers/redact applied', { customerId: customer.id });
  } else {
    log('info', 'customers/redact: no matching customer', { shopifyCustomerId, email });
  }

  return c.json({ ok: true });
});

webhooks.post('/shop/redact', async (c) => {
  const body = await verifyAndParse<unknown>(c);
  if (body === null) return c.text('Unauthorized', 401);

  // Shop redact fires 48h after app uninstall. For our single-store self-hosted
  // setup, the brand controls the only install — wiping the DB is acceptable.
  const db = getDb();
  db.transaction(() => {
    db.exec(`
      DELETE FROM email_events;
      DELETE FROM review_media;
      DELETE FROM reviews;
      DELETE FROM questions;
      DELETE FROM purchases;
      DELETE FROM customers;
      DELETE FROM products_cache;
    `);
  })();

  log('warn', 'shop/redact processed — all data wiped', {});
  return c.json({ ok: true });
});

export default webhooks;
export { verifyAndParse };
