import crypto from 'node:crypto';
import { getDb } from './client.js';
import { nowSec } from '../lib/time.js';

// --- Settings (key/value config in DB) ---

export const getSetting = (key: string): string | null => {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setSetting = (key: string, value: string): void => {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
};

export const getSettingNumber = (key: string, fallback: number): number => {
  const v = getSetting(key);
  return v === null ? fallback : Number(v);
};

// --- Customers ---

export interface CustomerRow {
  id: number;
  shopify_customer_id: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  global_opt_out: number;
  unanswered_request_count: number;
  last_request_sent_at: number | null;
  created_at: number;
}

export const upsertCustomer = (input: {
  shopifyCustomerId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): CustomerRow => {
  const now = nowSec();
  const db = getDb();

  db.prepare(`
    INSERT INTO customers (shopify_customer_id, email, first_name, last_name, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      shopify_customer_id = COALESCE(excluded.shopify_customer_id, customers.shopify_customer_id),
      first_name = COALESCE(excluded.first_name, customers.first_name),
      last_name = COALESCE(excluded.last_name, customers.last_name)
  `).run(
    input.shopifyCustomerId,
    input.email.toLowerCase(),
    input.firstName,
    input.lastName,
    now,
  );

  return db.prepare('SELECT * FROM customers WHERE email = ?').get(input.email.toLowerCase()) as CustomerRow;
};

export const findCustomerByEmail = (email: string): CustomerRow | null => {
  return (getDb()
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(email.toLowerCase()) as CustomerRow | undefined) ?? null;
};

export const findCustomerById = (id: number): CustomerRow | null => {
  return (getDb()
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(id) as CustomerRow | undefined) ?? null;
};

// --- Purchases ---

export interface PurchaseRow {
  id: number;
  customer_id: number;
  shopify_order_id: string;
  shopify_product_id: string;
  shopify_variant_id: string | null;
  fulfilled_at: number | null;
  due_at: number | null;
  request_count: number;
  last_request_at: number | null;
  reviewed_at: number | null;
  product_opt_out: number;
  created_at: number;
}

export const upsertPurchase = (input: {
  customerId: number;
  shopifyOrderId: string;
  shopifyProductId: string;
  shopifyVariantId: string | null;
  fulfilledAt: number | null;
  dueAt: number | null;
}): void => {
  getDb().prepare(`
    INSERT INTO purchases
      (customer_id, shopify_order_id, shopify_product_id, shopify_variant_id,
       fulfilled_at, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shopify_order_id, shopify_product_id) DO UPDATE SET
      shopify_variant_id = COALESCE(excluded.shopify_variant_id, purchases.shopify_variant_id),
      fulfilled_at = COALESCE(excluded.fulfilled_at, purchases.fulfilled_at),
      due_at = COALESCE(excluded.due_at, purchases.due_at)
  `).run(
    input.customerId,
    input.shopifyOrderId,
    input.shopifyProductId,
    input.shopifyVariantId,
    input.fulfilledAt,
    input.dueAt,
    nowSec(),
  );
};

export const markPurchaseFulfilled = (input: {
  shopifyOrderId: string;
  shopifyProductId: string;
  fulfilledAt: number;
  dueAt: number;
}): void => {
  getDb().prepare(`
    UPDATE purchases
       SET fulfilled_at = ?, due_at = ?
     WHERE shopify_order_id = ? AND shopify_product_id = ?
  `).run(input.fulfilledAt, input.dueAt, input.shopifyOrderId, input.shopifyProductId);
};

// Mark every purchase line for the order as fulfilled in one shot.
// Only updates rows that are not already fulfilled, so re-deliveries of the
// orders/fulfilled webhook don't reset due_at and inflate the cadence.
export const markOrderFulfilled = (input: {
  shopifyOrderId: string;
  fulfilledAt: number;
  dueAt: number;
}): number => {
  const result = getDb().prepare(`
    UPDATE purchases
       SET fulfilled_at = ?, due_at = ?
     WHERE shopify_order_id = ?
       AND fulfilled_at IS NULL
  `).run(input.fulfilledAt, input.dueAt, input.shopifyOrderId);
  return result.changes;
};

export const findPurchasesByOrder = (shopifyOrderId: string): PurchaseRow[] => {
  return getDb()
    .prepare('SELECT * FROM purchases WHERE shopify_order_id = ?')
    .all(shopifyOrderId) as PurchaseRow[];
};

export const findPurchaseById = (id: number): PurchaseRow | null => {
  return (getDb()
    .prepare('SELECT * FROM purchases WHERE id = ?')
    .get(id) as PurchaseRow | undefined) ?? null;
};

// --- Customer redaction (GDPR) ---

export const anonymizeCustomer = (customerId: number): void => {
  const db = getDb();
  const row = db.prepare('SELECT email FROM customers WHERE id = ?').get(customerId) as { email: string } | undefined;
  if (!row) return;
  // Deterministic redaction: keep the row keyed by a hash so the unique-email constraint stays satisfied.
  const hash = crypto.createHash('sha256').update(row.email).digest('hex').slice(0, 16);
  const redactedEmail = `redacted-${hash}@invalid.local`;

  db.transaction(() => {
    db.prepare(`
      UPDATE customers
         SET email = ?, first_name = NULL, last_name = NULL,
             shopify_customer_id = NULL, global_opt_out = 1
       WHERE id = ?
    `).run(redactedEmail, customerId);
    db.prepare(`
      UPDATE reviews
         SET reviewer_email = ?, reviewer_name = NULL
       WHERE customer_id = ?
    `).run(redactedEmail, customerId);
  })();
};

export const findCustomerByShopifyId = (shopifyCustomerId: string): CustomerRow | null => {
  return (getDb()
    .prepare('SELECT * FROM customers WHERE shopify_customer_id = ?')
    .get(shopifyCustomerId) as CustomerRow | undefined) ?? null;
};

// --- Dispatcher: eligibility + recording ---

export interface EligibleRow {
  // purchase fields
  p_id: number;
  p_shopify_order_id: string;
  p_shopify_product_id: string;
  p_shopify_variant_id: string | null;
  p_request_count: number;
  p_due_at: number | null;
  // customer fields
  c_id: number;
  c_email: string;
  c_first_name: string | null;
  c_last_name: string | null;
}

// Canonical eligibility query — every suppression rule is an AND clause here.
// Adding new suppression rules: add another AND, do not filter in TypeScript.
// Returns at most `batchSize` rows; orders by oldest due_at first so the
// longest-waited purchases get attention first.
export const findEligiblePurchases = (batchSize: number): EligibleRow[] => {
  return getDb().prepare(`
    SELECT
      p.id                  AS p_id,
      p.shopify_order_id    AS p_shopify_order_id,
      p.shopify_product_id  AS p_shopify_product_id,
      p.shopify_variant_id  AS p_shopify_variant_id,
      p.request_count       AS p_request_count,
      p.due_at              AS p_due_at,
      c.id                  AS c_id,
      c.email               AS c_email,
      c.first_name          AS c_first_name,
      c.last_name           AS c_last_name
    FROM purchases p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.due_at IS NOT NULL
      AND p.due_at <= unixepoch()
      AND p.reviewed_at IS NULL
      AND p.product_opt_out = 0
      AND c.global_opt_out = 0
      AND p.request_count < CAST((SELECT value FROM settings WHERE key='cadence_max_requests') AS INTEGER)
      AND (c.last_request_sent_at IS NULL
           OR c.last_request_sent_at < unixepoch()
              - CAST((SELECT value FROM settings WHERE key='cadence_min_days_between') AS INTEGER) * 86400)
      AND NOT EXISTS (
        SELECT 1 FROM reviews r
         WHERE r.customer_id = c.id
           AND r.shopify_product_id = p.shopify_product_id
      )
    ORDER BY p.due_at ASC
    LIMIT ?
  `).all(batchSize) as EligibleRow[];
};

export interface SuppressionAudit {
  globalOptOut: number;
  productOptOut: number;
  maxRequestsHit: number;
  cadenceTooSoon: number;
  alreadyReviewed: number;
}

// Counts purchases that would otherwise be eligible (due, unreviewed) but
// were excluded from the dispatcher's eligibility set by each suppression
// rule. Each purchase is counted in exactly one bucket using the priority
// order: globalOptOut → productOptOut → maxRequestsHit → cadenceTooSoon →
// alreadyReviewed. Purpose: observability for "why didn't X get an email?"
// without changing the canonical eligibility query.
export const auditSuppressions = (): SuppressionAudit => {
  const row = getDb().prepare(`
    SELECT
      SUM(CASE WHEN c.global_opt_out = 1 THEN 1 ELSE 0 END) AS global_opt_out,
      SUM(CASE WHEN c.global_opt_out = 0 AND p.product_opt_out = 1 THEN 1 ELSE 0 END) AS product_opt_out,
      SUM(CASE
        WHEN c.global_opt_out = 0 AND p.product_opt_out = 0
         AND p.request_count >= CAST((SELECT value FROM settings WHERE key='cadence_max_requests') AS INTEGER)
        THEN 1 ELSE 0 END) AS max_requests_hit,
      SUM(CASE
        WHEN c.global_opt_out = 0 AND p.product_opt_out = 0
         AND p.request_count < CAST((SELECT value FROM settings WHERE key='cadence_max_requests') AS INTEGER)
         AND c.last_request_sent_at IS NOT NULL
         AND c.last_request_sent_at >= unixepoch() - CAST((SELECT value FROM settings WHERE key='cadence_min_days_between') AS INTEGER) * 86400
        THEN 1 ELSE 0 END) AS cadence_too_soon,
      SUM(CASE
        WHEN c.global_opt_out = 0 AND p.product_opt_out = 0
         AND p.request_count < CAST((SELECT value FROM settings WHERE key='cadence_max_requests') AS INTEGER)
         AND (c.last_request_sent_at IS NULL
              OR c.last_request_sent_at < unixepoch() - CAST((SELECT value FROM settings WHERE key='cadence_min_days_between') AS INTEGER) * 86400)
         AND EXISTS (SELECT 1 FROM reviews r WHERE r.customer_id = c.id AND r.shopify_product_id = p.shopify_product_id)
        THEN 1 ELSE 0 END) AS already_reviewed
    FROM purchases p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.due_at IS NOT NULL
      AND p.due_at <= unixepoch()
      AND p.reviewed_at IS NULL
  `).get() as {
    global_opt_out: number | null;
    product_opt_out: number | null;
    max_requests_hit: number | null;
    cadence_too_soon: number | null;
    already_reviewed: number | null;
  };
  return {
    globalOptOut: row.global_opt_out ?? 0,
    productOptOut: row.product_opt_out ?? 0,
    maxRequestsHit: row.max_requests_hit ?? 0,
    cadenceTooSoon: row.cadence_too_soon ?? 0,
    alreadyReviewed: row.already_reviewed ?? 0,
  };
};

export const customerHasAnyReviews = (customerId: number): boolean => {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM reviews WHERE customer_id = ? LIMIT 1')
    .get(customerId) as { x: 1 } | undefined;
  return row !== undefined;
};

// Transactional: bump counters for one or more purchases that were sent in a
// single email, advance or null each purchase's due_at independently, and log
// one event per purchase. The customer-level counters bump just once
// regardless of how many purchases were in the email.
export const recordRequestSentBatch = (input: {
  purchaseIds: number[];
  customerId: number;
  metadata?: Record<string, unknown>;
}): void => {
  if (input.purchaseIds.length === 0) return;

  const db = getDb();
  const now = nowSec();
  const minBetweenDays = getSettingNumber('cadence_min_days_between', 7);
  const maxRequests = getSettingNumber('cadence_max_requests', 3);

  const updatePurchase = db.prepare(`
    UPDATE purchases
       SET request_count = request_count + 1,
           last_request_at = ?,
           due_at = CASE
             WHEN request_count + 1 >= ? THEN NULL
             ELSE ? + ? * 86400
           END
     WHERE id = ?
  `);

  const insertEvent = db.prepare(`
    INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
    VALUES (?, ?, 'request_sent', ?, ?)
  `);

  db.transaction(() => {
    for (const pid of input.purchaseIds) {
      updatePurchase.run(now, maxRequests, now, minBetweenDays, pid);
      insertEvent.run(
        input.customerId,
        pid,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
      );
    }

    db.prepare(`
      UPDATE customers
         SET unanswered_request_count = unanswered_request_count + 1,
             last_request_sent_at = ?
       WHERE id = ?
    `).run(now, input.customerId);
  })();
};

// --- Reviews ---

export type VerifiedKind = 'purchase' | 'sample' | null;

export interface ReviewRow {
  id: number;
  shopify_product_id: string;
  shopify_variant_id: string | null;
  customer_id: number | null;
  reviewer_email: string;
  reviewer_name: string | null;
  rating: number;
  title: string | null;
  body: string;
  verified_purchase: number;
  verified_kind: VerifiedKind;
  status: string;
  merchant_reply: string | null;
  merchant_reply_at: number | null;
  created_at: number;
  updated_at: number;
}

export const insertReview = (input: {
  shopifyProductId: string;
  shopifyVariantId: string | null;
  customerId: number | null;
  reviewerEmail: string;
  reviewerName: string | null;
  rating: number;
  title: string | null;
  body: string;
  verifiedKind: VerifiedKind;
  status: 'pending' | 'published' | 'rejected';
}): number => {
  const now = nowSec();
  const verifiedPurchase = input.verifiedKind === 'purchase' ? 1 : 0;
  const result = getDb().prepare(`
    INSERT INTO reviews
      (shopify_product_id, shopify_variant_id, customer_id, reviewer_email, reviewer_name,
       rating, title, body, verified_purchase, verified_kind, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.shopifyProductId,
    input.shopifyVariantId,
    input.customerId,
    input.reviewerEmail.toLowerCase(),
    input.reviewerName,
    input.rating,
    input.title,
    input.body,
    verifiedPurchase,
    input.verifiedKind,
    input.status,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
};

// Used by the submission flow to detect a duplicate: a customer who already
// reviewed this product (across any order). If this returns a row, we silently
// mark the new purchase as reviewed without inserting a duplicate review.
export const findReviewByCustomerAndProduct = (
  customerId: number,
  shopifyProductId: string,
): ReviewRow | null => {
  return (getDb()
    .prepare(`
      SELECT * FROM reviews
       WHERE customer_id = ?
         AND shopify_product_id = ?
       ORDER BY created_at DESC
       LIMIT 1
    `)
    .get(customerId, shopifyProductId) as ReviewRow | undefined) ?? null;
};

// On review submission: stop further requests for this purchase and reset the
// customer's unanswered counter (they engaged).
export const recordReviewSubmitted = (input: { purchaseId: number; customerId: number | null }): void => {
  const db = getDb();
  const now = nowSec();
  db.transaction(() => {
    db.prepare(`
      UPDATE purchases
         SET reviewed_at = ?, due_at = NULL
       WHERE id = ?
    `).run(now, input.purchaseId);
    if (input.customerId !== null) {
      db.prepare(`
        UPDATE customers
           SET unanswered_request_count = 0
         WHERE id = ?
      `).run(input.customerId);
    }
    db.prepare(`
      INSERT INTO email_events (customer_id, purchase_id, kind, created_at)
      VALUES (?, ?, 'review_submitted', ?)
    `).run(input.customerId, input.purchaseId, now);
  })();
};

export interface VariantFilter {
  // When set, restricts results to reviews tagged with this variant.
  variantId?: string;
  // When set, excludes reviews tagged with this variant (for "related variant"
  // sections on a variant-distinct product page). Takes precedence over
  // variantId if both are passed (caller shouldn't do that).
  excludeVariantId?: string;
}

export const listPublishedReviewsForProduct = (
  shopifyProductId: string,
  page: number,
  size: number,
  filter: VariantFilter = {},
): ReviewRow[] => {
  const offset = Math.max(0, (page - 1) * size);
  const params: Array<string | number> = [shopifyProductId];
  let variantClause = '';
  if (filter.excludeVariantId) {
    variantClause = ' AND (shopify_variant_id IS NULL OR shopify_variant_id <> ?)';
    params.push(filter.excludeVariantId);
  } else if (filter.variantId) {
    variantClause = ' AND shopify_variant_id = ?';
    params.push(filter.variantId);
  }
  params.push(size, offset);
  return getDb().prepare(`
    SELECT * FROM reviews
     WHERE shopify_product_id = ?
       AND status = 'published'
       ${variantClause}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?
  `).all(...params) as ReviewRow[];
};

export const getProductAggregate = (
  shopifyProductId: string,
  filter: VariantFilter = {},
): { avg: number | null; count: number } => {
  const params: Array<string> = [shopifyProductId];
  let variantClause = '';
  if (filter.excludeVariantId) {
    variantClause = ' AND (shopify_variant_id IS NULL OR shopify_variant_id <> ?)';
    params.push(filter.excludeVariantId);
  } else if (filter.variantId) {
    variantClause = ' AND shopify_variant_id = ?';
    params.push(filter.variantId);
  }
  const row = getDb().prepare(`
    SELECT AVG(rating) AS avg, COUNT(*) AS count
      FROM reviews
     WHERE shopify_product_id = ?
       AND status = 'published'
       ${variantClause}
  `).get(...params) as { avg: number | null; count: number };
  return { avg: row.avg, count: row.count };
};

// --- Opt-outs ---

export const setGlobalOptOut = (customerId: number): void => {
  const now = nowSec();
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE customers SET global_opt_out = 1 WHERE id = ?').run(customerId);
    db.prepare(`
      INSERT INTO email_events (customer_id, purchase_id, kind, created_at)
      VALUES (?, NULL, 'unsubscribed', ?)
    `).run(customerId, now);
  })();
};

// Flips global_opt_out back to 0 AND clears due_at on the customer's
// unreviewed purchases so they don't get a backlog of review-request emails
// covering everything they bought while opted out. Future purchases go
// through normal cadence; only purchases sitting in the queue with the
// original due_at get wiped. Returns the number of purchases cleared.
export const clearGlobalOptOut = (customerId: number): { purchasesCleared: number } => {
  const now = nowSec();
  const db = getDb();
  let purchasesCleared = 0;
  db.transaction(() => {
    db.prepare('UPDATE customers SET global_opt_out = 0 WHERE id = ?').run(customerId);
    const res = db.prepare(`
      UPDATE purchases
         SET due_at = NULL
       WHERE customer_id = ?
         AND reviewed_at IS NULL
         AND due_at IS NOT NULL
    `).run(customerId);
    purchasesCleared = res.changes;
    db.prepare(`
      INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
      VALUES (?, NULL, 'resubscribed', ?, ?)
    `).run(customerId, JSON.stringify({ purchasesCleared }), now);
  })();
  return { purchasesCleared };
};

export const setProductOptOut = (purchaseId: number, customerId: number | null): void => {
  const now = nowSec();
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE purchases SET product_opt_out = 1, due_at = NULL WHERE id = ?').run(purchaseId);
    db.prepare(`
      INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
      VALUES (?, ?, 'unsubscribed', '{"scope":"product"}', ?)
    `).run(customerId, purchaseId, now);
  })();
};

// --- Sample invitations ---

export interface SampleInvitationRow {
  id: number;
  shopify_product_id: string;
  intended_email: string | null;
  intended_name: string | null;
  notes: string | null;
  consumed_at: number | null;
  consumed_review_id: number | null;
  created_at: number;
  expires_at: number;
}

export const createSampleInvitation = (input: {
  shopifyProductId: string;
  intendedEmail: string | null;
  intendedName: string | null;
  notes: string | null;
  expiresAt: number;
}): SampleInvitationRow => {
  const now = nowSec();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO sample_invitations
      (shopify_product_id, intended_email, intended_name, notes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.shopifyProductId,
    input.intendedEmail?.toLowerCase() ?? null,
    input.intendedName,
    input.notes,
    now,
    input.expiresAt,
  );
  return db.prepare('SELECT * FROM sample_invitations WHERE id = ?').get(result.lastInsertRowid) as SampleInvitationRow;
};

export const findSampleInvitationById = (id: number): SampleInvitationRow | null => {
  return (getDb()
    .prepare('SELECT * FROM sample_invitations WHERE id = ?')
    .get(id) as SampleInvitationRow | undefined) ?? null;
};

// Returns invitations in three buckets for the admin UI: pending (not yet
// consumed, not yet expired), consumed (have a linked review), and expired
// (passed expires_at without being consumed). Most-recently-created first.
export const listSampleInvitations = (): {
  pending: SampleInvitationRow[];
  consumed: SampleInvitationRow[];
  expired: SampleInvitationRow[];
} => {
  const all = getDb()
    .prepare('SELECT * FROM sample_invitations ORDER BY id DESC')
    .all() as SampleInvitationRow[];
  const now = nowSec();
  const pending: SampleInvitationRow[] = [];
  const consumed: SampleInvitationRow[] = [];
  const expired: SampleInvitationRow[] = [];
  for (const inv of all) {
    if (inv.consumed_at !== null) consumed.push(inv);
    else if (inv.expires_at <= now) expired.push(inv);
    else pending.push(inv);
  }
  return { pending, consumed, expired };
};

export const consumeSampleInvitation = (input: {
  invitationId: number;
  reviewId: number;
}): void => {
  const now = nowSec();
  getDb()
    .prepare(`
      UPDATE sample_invitations
         SET consumed_at = ?, consumed_review_id = ?
       WHERE id = ? AND consumed_at IS NULL
    `)
    .run(now, input.reviewId, input.invitationId);
};

// --- Email-event recording for failures ---

export const logEmailFailure = (input: {
  customerId: number;
  purchaseId: number;
  error: string;
}): void => {
  getDb().prepare(`
    INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
    VALUES (?, ?, 'send_failed', ?, ?)
  `).run(
    input.customerId,
    input.purchaseId,
    JSON.stringify({ error: input.error.slice(0, 500) }),
    nowSec(),
  );
};

// --- Admin moderation ---

export const listReviews = (input: { status?: string; limit: number; offset: number }): ReviewRow[] => {
  if (input.status) {
    return getDb().prepare(`
      SELECT * FROM reviews
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?
    `).all(input.status, input.limit, input.offset) as ReviewRow[];
  }
  return getDb().prepare(`
    SELECT * FROM reviews
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?
  `).all(input.limit, input.offset) as ReviewRow[];
};

export const countReviewsByStatus = (): Record<string, number> => {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) AS n FROM reviews GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
};

export const findReviewById = (id: number): ReviewRow | null => {
  return (getDb()
    .prepare('SELECT * FROM reviews WHERE id = ?')
    .get(id) as ReviewRow | undefined) ?? null;
};

export const updateReviewStatus = (id: number, status: 'published' | 'pending' | 'rejected'): void => {
  getDb().prepare(`
    UPDATE reviews SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, nowSec(), id);
};

export const setMerchantReply = (id: number, reply: string | null): void => {
  getDb().prepare(`
    UPDATE reviews
       SET merchant_reply = ?, merchant_reply_at = ?, updated_at = ?
     WHERE id = ?
  `).run(reply, reply ? nowSec() : null, nowSec(), id);
};

export interface CustomerWithPurchases extends CustomerRow {
  purchases: PurchaseRow[];
}

export const getCustomerDetail = (email: string): CustomerWithPurchases | null => {
  const customer = findCustomerByEmail(email);
  if (!customer) return null;
  const purchases = getDb()
    .prepare('SELECT * FROM purchases WHERE customer_id = ? ORDER BY created_at DESC')
    .all(customer.id) as PurchaseRow[];
  return { ...customer, purchases };
};

// Send-rate stats: counts of email_events grouped by kind in last N days.
export const emailEventStats = (sinceSec: number): Record<string, number> => {
  const rows = getDb().prepare(`
    SELECT kind, COUNT(*) AS n FROM email_events
     WHERE created_at >= ?
     GROUP BY kind
  `).all(sinceSec) as Array<{ kind: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
};

// --- Product cache (for email rendering and storefront fallbacks) ---

export interface ProductCacheRow {
  id: number;
  shopify_product_id: string;
  handle: string;
  title: string;
  featured_image_url: string | null;
  variant_handling: string | null;
  updated_at: number;
}

export const upsertProductCache = (input: {
  shopifyProductId: string;
  handle: string;
  title: string;
  featuredImageUrl: string | null;
  variantHandling: string | null;
}): void => {
  getDb().prepare(`
    INSERT INTO products_cache (shopify_product_id, handle, title, featured_image_url, variant_handling, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(shopify_product_id) DO UPDATE SET
      handle = excluded.handle,
      title = excluded.title,
      featured_image_url = excluded.featured_image_url,
      variant_handling = excluded.variant_handling,
      updated_at = excluded.updated_at
  `).run(
    input.shopifyProductId,
    input.handle,
    input.title,
    input.featuredImageUrl,
    input.variantHandling,
    nowSec(),
  );
};

export const findProductCache = (shopifyProductId: string): ProductCacheRow | null => {
  return (getDb()
    .prepare('SELECT * FROM products_cache WHERE shopify_product_id = ?')
    .get(shopifyProductId) as ProductCacheRow | undefined) ?? null;
};

// Clears the products cache so the next getOrFetchProduct call re-pulls from
// Shopify (picking up any newly-set or changed metafields, title edits, etc.).
// Used by the "refresh product cache" admin action.
export const clearProductCache = (): number => {
  const res = getDb().prepare('DELETE FROM products_cache').run();
  return res.changes;
};

// --- Email events ---

export const logEmailEvent = (input: {
  customerId: number | null;
  purchaseId: number | null;
  kind: string;
  metadata?: Record<string, unknown>;
}): void => {
  getDb().prepare(`
    INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.customerId,
    input.purchaseId,
    input.kind,
    input.metadata ? JSON.stringify(input.metadata) : null,
    nowSec(),
  );
};
