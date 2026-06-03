import { Hono } from 'hono';
import {
  upsertCustomer,
  upsertPurchase,
  markOrderFulfilled,
  findCustomerByEmail,
  findCustomerByShopifyId,
  anonymizeCustomer,
  logEmailEvent,
  getSetting,
  getSettingNumber,
} from '../db/queries.js';
import {
  findMemberByDiscountCode,
  markMemberCodeRedeemed,
} from '../db/campaigns.js';
import { getDb } from '../db/client.js';
import { log } from '../lib/logger.js';
import { nowSec, daysToSec } from '../lib/time.js';
import { runDispatcher } from '../scheduler/dispatcher.js';
import { verifyShopifyWebhook } from '../shopify/webhook-verify.js';
import { findShopIdByDomain } from '../lib/tenant.js';

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
interface OrderDiscountCode {
  code?: string;
  amount?: string;
  type?: string;
}
interface OrderPaidPayload {
  id: number;
  email?: string | null;
  customer?: OrderPayloadCustomer | null;
  line_items?: OrderPayloadLineItem[];
  discount_codes?: OrderDiscountCode[];
  total_price?: string;
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

// Resolve the webhook's shop from the X-Shopify-Shop-Domain header (set by
// Shopify on every delivery). Returns null if the header is missing or the
// domain doesn't match any shop in our shops table — callers 200-noop on
// null (the HMAC was valid, the webhook just isn't for a shop we know about,
// which on a public app would be the wrong tenant; on our single-shop dev
// install it'd be a misconfigured test). Defense in depth on top of HMAC.
const resolveWebhookShop = (c: import('hono').Context): number | null => {
  const domain = c.req.header('x-shopify-shop-domain');
  const shopId = findShopIdByDomain(domain);
  if (shopId === null) {
    log('warn', 'webhook for unknown shop domain, ignoring', { topic: c.req.path, domain });
  }
  return shopId;
};

webhooks.post('/orders/paid', async (c) => {
  const body = await verifyAndParse<OrderPaidPayload>(c);
  if (!body) return c.text('Unauthorized', 401);
  if (resolveWebhookShop(c) === null) return c.json({ ok: true, ignored: 'unknown_shop' });

  const orderId = String(body.id);
  const email = body.customer?.email ?? body.email ?? null;
  const shopifyCustomerId = body.customer?.id ? String(body.customer.id) : null;
  const lineItems = body.line_items ?? [];

  // Campaign discount-code redemption detection. Runs BEFORE the email gate
  // because admin-created test orders (Bogus Gateway, etc.) often have no
  // customer email but they DO carry the applied discount codes — and we
  // still need to mark the campaign member's code as redeemed so the
  // dashboard reflects reality. The lookup is a cheap indexed read per
  // code on the order; most orders won't carry a campaign code at all.
  // Idempotent: a re-delivered webhook with an already-redeemed code is
  // a no-op (we check the member's current code_status before updating).
  const discountCodes = body.discount_codes ?? [];
  if (discountCodes.length > 0) {
    const totalPrice = Number(body.total_price ?? '0') || 0;
    for (const dc of discountCodes) {
      const code = (dc.code ?? '').trim();
      if (!code) continue;
      const member = findMemberByDiscountCode(code);
      if (!member) continue;
      if (member.code_status === 'redeemed') continue;
      markMemberCodeRedeemed({
        memberId: member.id,
        orderId,
        orderTotal: totalPrice,
      });
      log('info', 'campaign discount code redeemed', {
        memberId: member.id,
        campaignId: member.campaign_id,
        code,
        orderId,
        orderTotal: totalPrice,
      });
    }
  }

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
  if (resolveWebhookShop(c) === null) return c.json({ ok: true, ignored: 'unknown_shop' });

  const orderId = String(body.id);
  const fulfilledAt = nowSec();
  const immediate = getSetting('dispatch_immediately_on_fulfillment') === '1';
  const delayDays = immediate ? 0 : getSettingNumber('request_delay_days', 7);
  const dueAt = fulfilledAt + daysToSec(delayDays);

  const updated = markOrderFulfilled({
    shopifyOrderId: orderId,
    fulfilledAt,
    dueAt,
  });

  log('info', 'orders/fulfilled processed', { orderId, purchasesUpdated: updated, immediate });

  if (immediate) {
    // Fire-and-forget: don't block the webhook response. Shopify expects a
    // fast 200 here; the dispatcher's own logs capture the email outcome.
    runDispatcher().catch((err) => {
      log('error', 'immediate dispatcher run failed', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return c.json({ ok: true, updated });
});

// --- GDPR webhooks ---
// Shopify mandates these three. They must respond 200 with a valid HMAC even
// when there is nothing to do; otherwise Shopify will eventually disable the app.

webhooks.post('/customers/data_request', async (c) => {
  const body = await verifyAndParse<CustomerRedactPayload>(c);
  if (!body) return c.text('Unauthorized', 401);
  if (resolveWebhookShop(c) === null) return c.json({ ok: true, ignored: 'unknown_shop' });

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
  if (resolveWebhookShop(c) === null) return c.json({ ok: true, ignored: 'unknown_shop' });

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

  // Shop redact fires 48h after app uninstall. Previously this wiped the entire
  // database — a foot-gun the moment a stray test redact arrived for a domain
  // that wasn't ours. Now we scope deletes to the redacting shop (resolved
  // from X-Shopify-Shop-Domain). For unknown shops we no-op (200), per the
  // same logic as every other webhook above.
  const shopId = resolveWebhookShop(c);
  if (shopId === null) return c.json({ ok: true, ignored: 'unknown_shop' });

  const db = getDb();
  db.transaction(() => {
    // Child/ops tables: no shop_id yet (deferred B2), scope via the parent FK.
    db.prepare(`DELETE FROM email_events
                WHERE customer_id IN (SELECT id FROM customers WHERE shop_id = ?)
                   OR purchase_id IN (SELECT id FROM purchases WHERE shop_id = ?)`).run(shopId, shopId);
    db.prepare(`DELETE FROM review_media
                WHERE review_id IN (SELECT id FROM reviews WHERE shop_id = ?)`).run(shopId);
    db.prepare(`DELETE FROM moderation_events
                WHERE review_id IN (SELECT id FROM reviews WHERE shop_id = ?)`).run(shopId);
    db.prepare(`DELETE FROM review_reports
                WHERE review_id IN (SELECT id FROM reviews WHERE shop_id = ?)`).run(shopId);
    // Shop-scoped tables (have shop_id since migration 016).
    db.prepare('DELETE FROM reviews WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM purchases WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM customers WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM questions WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM sample_invitations WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM products_cache WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM email_templates WHERE shop_id = ?').run(shopId);
    db.prepare('DELETE FROM banned_reporters WHERE shop_id = ?').run(shopId);
    // The shops row itself — the install is gone. ensureCurrentShop() will
    // re-seed it from env on next boot if this app is reinstalled.
    db.prepare('DELETE FROM shops WHERE id = ?').run(shopId);
    // panic_events and settings are not yet shop-scoped (B1/B2 deferred);
    // they stay untouched. shop_brand_json in settings is operationally
    // per-shop but a setting key — overwritten on the next brand relay.
  })();

  log('warn', 'shop/redact processed — shop data wiped', { shopId });
  return c.json({ ok: true });
});

export default webhooks;
export { verifyAndParse };
