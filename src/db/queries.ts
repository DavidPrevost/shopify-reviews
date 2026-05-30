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
    ON CONFLICT(shop_id, email) DO UPDATE SET
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
    ON CONFLICT(shop_id, shopify_order_id, shopify_product_id) DO UPDATE SET
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
  dueAt: number | null;
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
      AND p.fulfilled_at >= CAST((SELECT value FROM settings WHERE key='request_cutoff_at') AS INTEGER)
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
      AND p.fulfilled_at >= CAST((SELECT value FROM settings WHERE key='request_cutoff_at') AS INTEGER)
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
  // Raw reviewer text, pre-censoring. NULL for reviews created before this was
  // added. `title`/`body` above are the censored display copy read publicly.
  title_original: string | null;
  body_original: string | null;
  verified_purchase: number;
  verified_kind: VerifiedKind;
  status: string;
  merchant_reply: string | null;
  merchant_reply_at: number | null;
  moderation_reason: ModerationReason | null;
  moderation_note: string | null;
  created_at: number;
  updated_at: number;
}

// --- Moderation ---
//
// Reasons surfaced in the admin retract modal. Each maps to (a) the friendly
// label shown to the merchant in the dropdown and (b) the phrase used in the
// customer notification email ("We removed your review because it ..."). The
// free-text note attached at retract time is INTERNAL ONLY — never shown to
// the customer.
//
// Adding a new reason: extend MODERATION_REASONS, MODERATION_REASON_LABELS,
// and MODERATION_REASON_CUSTOMER_PHRASES below. No migration needed —
// the column is unconstrained TEXT.

export const MODERATION_REASONS = [
  'profanity',
  'spam',
  'off-topic',
  'not-a-customer',
  'harassment',
  'contains-pii',
  'legal-takedown',
  'duplicate',
  'other',
] as const;
export type ModerationReason = typeof MODERATION_REASONS[number];

export const isModerationReason = (v: unknown): v is ModerationReason =>
  typeof v === 'string' && (MODERATION_REASONS as readonly string[]).includes(v);

export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  'profanity':       'Profanity / inappropriate language',
  'spam':            'Spam',
  'off-topic':       'Off-topic (not about the product)',
  'not-a-customer':  'Reviewer was not a customer',
  'harassment':      'Harassment or personal attack',
  'contains-pii':    'Contains personal information',
  'legal-takedown':  'Legal takedown request',
  'duplicate':       'Duplicate review',
  'other':           'Other (use note for detail)',
};

// Customer-facing phrasing — appears in the retract email after "We removed
// your review because it ...". Tone: matter-of-fact, no blame language for
// the sensitive categories. "legal-takedown" is intentionally vague.
export const MODERATION_REASON_CUSTOMER_PHRASES: Record<ModerationReason, string> = {
  'profanity':       'contained language that violates our review guidelines',
  'spam':            'appeared to be promotional or spam content',
  'off-topic':       'was not about the product',
  'not-a-customer':  'could not be verified as a genuine purchase',
  'harassment':      'contained content directed at another person',
  'contains-pii':    'contained personal information (yours or someone else\'s)',
  'legal-takedown':  'needed to be removed at the request of a third party',
  'duplicate':       'duplicated another review you had submitted',
  'other':           'did not meet our review guidelines',
};

export type ModerationEventType = 'retract' | 'restore';

export interface ModerationEventRow {
  id: number;
  review_id: number;
  event_type: ModerationEventType;
  from_status: string;
  to_status: string;
  reason: ModerationReason | null;
  note: string | null;
  actor: string;
  customer_notified: number;
  created_at: number;
}

// Transactional retract: flips status to 'rejected', writes the latest
// reason/note onto the review row, and appends an audit event. customer_notified
// records *intent* (whether the admin asked to notify) — the actual email is
// sent by the route handler after this commits.
export const retractReview = (input: {
  reviewId: number;
  fromStatus: string;
  reason: ModerationReason;
  note: string | null;
  actor: string;
  customerNotified: boolean;
}): void => {
  const db = getDb();
  const now = nowSec();
  db.transaction(() => {
    db.prepare(`
      UPDATE reviews
         SET status = 'rejected',
             moderation_reason = ?,
             moderation_note = ?,
             updated_at = ?
       WHERE id = ?
    `).run(input.reason, input.note, now, input.reviewId);
    db.prepare(`
      INSERT INTO moderation_events
        (review_id, event_type, from_status, to_status, reason, note, actor, customer_notified, created_at)
      VALUES (?, 'retract', ?, 'rejected', ?, ?, ?, ?, ?)
    `).run(
      input.reviewId,
      input.fromStatus,
      input.reason,
      input.note,
      input.actor,
      input.customerNotified ? 1 : 0,
      now,
    );
  })();
};

// Transactional restore: flips status back to 'published' and clears the
// reason/note on the review. The audit log retains the original retract event
// (and this restore event), so the history is preserved.
export const restoreReview = (input: {
  reviewId: number;
  fromStatus: string;
  note: string | null;
  actor: string;
  customerNotified: boolean;
}): void => {
  const db = getDb();
  const now = nowSec();
  db.transaction(() => {
    db.prepare(`
      UPDATE reviews
         SET status = 'published',
             moderation_reason = NULL,
             moderation_note = NULL,
             updated_at = ?
       WHERE id = ?
    `).run(now, input.reviewId);
    db.prepare(`
      INSERT INTO moderation_events
        (review_id, event_type, from_status, to_status, reason, note, actor, customer_notified, created_at)
      VALUES (?, 'restore', ?, 'published', NULL, ?, ?, ?, ?)
    `).run(
      input.reviewId,
      input.fromStatus,
      input.note,
      input.actor,
      input.customerNotified ? 1 : 0,
      now,
    );
  })();
};

export const listModerationEvents = (reviewId: number): ModerationEventRow[] => {
  return getDb()
    .prepare('SELECT * FROM moderation_events WHERE review_id = ? ORDER BY created_at DESC, id DESC')
    .all(reviewId) as ModerationEventRow[];
};

// --- Review reports (storefront-driven flag-this-review flow) ---
//
// Storefront-visible reason values are deliberately fewer/simpler than the
// admin's moderation_reason enum. The reporter doesn't know our internal
// taxonomy; "this is bad" + an optional message is enough to get something
// in the admin queue.

export const REPORT_REASONS = [
  'inappropriate',  // profanity / harassment / etc
  'spam-or-fake',
  'off-topic',
  'pii',            // contains personal info
  'other',
] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export const isReportReason = (v: unknown): v is ReportReason =>
  typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  'inappropriate':  'Inappropriate / offensive content',
  'spam-or-fake':   'Spam or fake review',
  'off-topic':      'Not about the product',
  'pii':            'Contains personal information',
  'other':          'Something else',
};

export type ReportStatus = 'open' | 'dismissed' | 'retracted';

export interface ReviewReportRow {
  id: number;
  review_id: number;
  reason: ReportReason;
  message: string | null;
  reporter_email: string | null;
  reporter_ip: string | null;
  status: ReportStatus;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
}

export const isReporterBanned = (email: string): boolean => {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM banned_reporters WHERE email = ?')
    .get(email.toLowerCase()) as { x: 1 } | undefined;
  return row !== undefined;
};

export const banReporter = (input: { email: string; bannedBy: string }): void => {
  getDb().prepare(`
    INSERT INTO banned_reporters (email, banned_by, banned_at)
    VALUES (?, ?, ?)
    ON CONFLICT(shop_id, email) DO NOTHING
  `).run(input.email.toLowerCase(), input.bannedBy, nowSec());
};

export const unbanReporter = (email: string): void => {
  getDb().prepare('DELETE FROM banned_reporters WHERE email = ?').run(email.toLowerCase());
};

export const listBannedReporters = (): Array<{ email: string; banned_by: string; banned_at: number }> => {
  return getDb()
    .prepare('SELECT email, banned_by, banned_at FROM banned_reporters ORDER BY banned_at DESC')
    .all() as Array<{ email: string; banned_by: string; banned_at: number }>;
};

// Returns the inserted report id, or null if the insert was deduped (same IP
// already has an open report on the same review). Callers should treat null
// as success too — the user shouldn't get a different response for trying
// twice.
export const insertReviewReport = (input: {
  reviewId: number;
  reason: ReportReason;
  message: string | null;
  reporterEmail: string | null;
  reporterIp: string | null;
}): number | null => {
  try {
    const result = getDb().prepare(`
      INSERT INTO review_reports
        (review_id, reason, message, reporter_email, reporter_ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.reviewId,
      input.reason,
      input.message,
      input.reporterEmail?.toLowerCase() ?? null,
      input.reporterIp,
      nowSec(),
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    // Unique-index violation on (review_id, reporter_ip) where status='open'.
    // Treat as a no-op success — caller doesn't need to know.
    if (err instanceof Error && err.message.includes('UNIQUE')) return null;
    throw err;
  }
};

export const findReviewReportById = (id: number): ReviewReportRow | null => {
  return (getDb()
    .prepare('SELECT * FROM review_reports WHERE id = ?')
    .get(id) as ReviewReportRow | undefined) ?? null;
};

// Groups all open reports together with each review's current state for the
// admin "Reports" page. The same review can have many reports; the UI
// collapses them per-review. Ordered most-recently-reported first.
export interface ReportedReviewGroup {
  review: ReviewRow;
  reports: ReviewReportRow[];
  productTitle: string | null;
}

export const listOpenReportsGroupedByReview = (): ReportedReviewGroup[] => {
  const reports = getDb()
    .prepare(`
      SELECT * FROM review_reports
       WHERE status = 'open'
       ORDER BY created_at DESC, id DESC
    `)
    .all() as ReviewReportRow[];
  if (reports.length === 0) return [];

  const byReviewId = new Map<number, ReviewReportRow[]>();
  for (const r of reports) {
    let arr = byReviewId.get(r.review_id);
    if (!arr) { arr = []; byReviewId.set(r.review_id, arr); }
    arr.push(r);
  }

  const groups: ReportedReviewGroup[] = [];
  for (const [reviewId, reps] of byReviewId) {
    const review = findReviewById(reviewId);
    if (!review) continue;
    groups.push({ review, reports: reps, productTitle: null });
  }
  // Most-recently-reported-review first.
  groups.sort((a, b) => (b.reports[0]?.created_at ?? 0) - (a.reports[0]?.created_at ?? 0));
  return groups;
};

export const countOpenReports = (): number => {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM review_reports WHERE status = 'open'")
    .get() as { n: number };
  return row.n;
};

export const listReportsForReview = (reviewId: number, limit = 100): ReviewReportRow[] => {
  return getDb()
    .prepare('SELECT * FROM review_reports WHERE review_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(reviewId, limit) as ReviewReportRow[];
};

// Resolves one or more reports as a group. Used by both "dismiss this report"
// (single id) and "retract the review" (closes all open reports for that
// review at once with newStatus='retracted').
export const resolveReports = (input: {
  reportIds: number[];
  newStatus: 'dismissed' | 'retracted';
  resolvedBy: string;
}): number => {
  if (input.reportIds.length === 0) return 0;
  const now = nowSec();
  const placeholders = input.reportIds.map(() => '?').join(',');
  const result = getDb().prepare(`
    UPDATE review_reports
       SET status = ?, resolved_at = ?, resolved_by = ?
     WHERE id IN (${placeholders}) AND status = 'open'
  `).run(input.newStatus, now, input.resolvedBy, ...input.reportIds);
  return result.changes;
};

export const resolveAllOpenReportsForReview = (input: {
  reviewId: number;
  newStatus: 'dismissed' | 'retracted';
  resolvedBy: string;
}): number => {
  const result = getDb().prepare(`
    UPDATE review_reports
       SET status = ?, resolved_at = ?, resolved_by = ?
     WHERE review_id = ? AND status = 'open'
  `).run(input.newStatus, nowSec(), input.resolvedBy, input.reviewId);
  return result.changes;
};

export const insertReview = (input: {
  shopifyProductId: string;
  shopifyVariantId: string | null;
  customerId: number | null;
  reviewerEmail: string;
  reviewerName: string | null;
  rating: number;
  // title/body are the censored display copy (read publicly). titleOriginal/
  // bodyOriginal are the raw reviewer text the caller censored from.
  title: string | null;
  body: string;
  titleOriginal: string | null;
  bodyOriginal: string;
  verifiedKind: VerifiedKind;
  status: 'pending' | 'published' | 'rejected';
}): number => {
  const now = nowSec();
  const verifiedPurchase = input.verifiedKind === 'purchase' ? 1 : 0;
  const result = getDb().prepare(`
    INSERT INTO reviews
      (shopify_product_id, shopify_variant_id, customer_id, reviewer_email, reviewer_name,
       rating, title, body, title_original, body_original, verified_purchase, verified_kind, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.shopifyProductId,
    input.shopifyVariantId,
    input.customerId,
    input.reviewerEmail.toLowerCase(),
    input.reviewerName,
    input.rating,
    input.title,
    input.body,
    input.titleOriginal,
    input.bodyOriginal,
    verifiedPurchase,
    input.verifiedKind,
    input.status,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
};

// Used by the submission flow to detect a duplicate: a customer who already
// has an ACTIVE review for this product (across any order). Rejected
// (retracted) reviews are excluded — the customer was invited to resubmit
// and shouldn't be blocked by their own retracted history. If this returns a
// row, we silently mark the new purchase as reviewed without inserting a
// duplicate review.
export const findReviewByCustomerAndProduct = (
  customerId: number,
  shopifyProductId: string,
): ReviewRow | null => {
  return (getDb()
    .prepare(`
      SELECT * FROM reviews
       WHERE customer_id = ?
         AND shopify_product_id = ?
         AND status <> 'rejected'
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

// --- Email templates ---

export interface EmailTemplateRow {
  id: number;
  // NULL = the shop-wide default template for this key/trigger. Non-NULL =
  // a campaign-specific clone, edited from inside the campaign view. The
  // dispatcher prefers a campaign-specific row when sending for that
  // campaign; falls back to the default. See migration 020.
  campaign_id: number | null;
  template_key: string;
  display_name: string;
  is_active: number;
  subject: string;
  body_html: string;
  cta_enabled: number;
  cta_label: string;
  trigger_event: string | null;
  created_at: number;
  updated_at: number;
}

// Defaults-only lookup — never returns campaign-specific override rows.
// Used by the Branding template editor and the email seed. Campaign-specific
// rows live in their own routes via findCampaignTemplateRow.
export const findEmailTemplate = (templateKey: string): EmailTemplateRow | null => {
  return (getDb()
    .prepare('SELECT * FROM email_templates WHERE template_key = ? AND campaign_id IS NULL')
    .get(templateKey) as EmailTemplateRow | undefined) ?? null;
};

// Defaults-only listing (same scope as findEmailTemplate). The Branding tab
// shows only these — campaign-specific clones surface inside the campaign
// detail view, not here.
export const listEmailTemplates = (): EmailTemplateRow[] => {
  return getDb()
    .prepare('SELECT * FROM email_templates WHERE campaign_id IS NULL ORDER BY id ASC')
    .all() as EmailTemplateRow[];
};

// First active template bound to a trigger, or null. The dispatcher and
// moderation flows select templates this way (not by hardcoded key). If a
// merchant marks two templates with the same trigger active, the lowest id
// wins — deterministic and good enough; the UI nudges toward one-per-trigger.
//
// Defaults-only lookup — no campaign context. Use
// findActiveTemplateForTriggerCampaignAware when sending for a campaign so
// per-campaign template overrides (migration 020) take precedence.
export const findActiveTemplateForTrigger = (trigger: string): EmailTemplateRow | null => {
  return (getDb()
    .prepare(`SELECT * FROM email_templates WHERE trigger_event = ? AND is_active = 1 AND campaign_id IS NULL ORDER BY id ASC LIMIT 1`)
    .get(trigger) as EmailTemplateRow | undefined) ?? null;
};

// Campaign-aware template lookup: prefers a campaign-specific row, falls back
// to the shop default. Used by the campaign batch dispatcher and the campaign
// application-confirmation send so per-campaign template edits land in the
// right email. Passing a null campaignId reproduces the default-only path.
export const findActiveTemplateForTriggerCampaignAware = (
  trigger: string,
  campaignId: number | null,
): EmailTemplateRow | null => {
  if (campaignId !== null) {
    const override = getDb()
      .prepare(`
        SELECT * FROM email_templates
         WHERE trigger_event = ?
           AND is_active = 1
           AND campaign_id = ?
         ORDER BY id ASC LIMIT 1
      `)
      .get(trigger, campaignId) as EmailTemplateRow | undefined;
    if (override) return override;
  }
  return findActiveTemplateForTrigger(trigger);
};

// Looks up a campaign-specific template row by (campaign, trigger). Used to
// decide whether the "Edit template" link in the campaign view opens an
// existing clone or has to create one first via cloneTemplateForCampaign.
export const findCampaignTemplateRow = (
  campaignId: number,
  trigger: string,
): EmailTemplateRow | null => {
  return (getDb()
    .prepare(`
      SELECT * FROM email_templates
       WHERE trigger_event = ?
         AND campaign_id = ?
       ORDER BY id ASC LIMIT 1
    `)
    .get(trigger, campaignId) as EmailTemplateRow | undefined) ?? null;
};

// Clones the active default template for a trigger into a new row scoped to
// the given campaign. Idempotent at the caller's request — if a campaign-
// specific row already exists, returns that instead of creating a duplicate.
// Returns the row the merchant should be editing.
export const cloneTemplateForCampaign = (input: {
  campaignId: number;
  trigger: string;
}): EmailTemplateRow | null => {
  const existing = findCampaignTemplateRow(input.campaignId, input.trigger);
  if (existing) return existing;
  const source = findActiveTemplateForTrigger(input.trigger);
  if (!source) return null;
  const db = getDb();
  const now = nowSec();
  // template_key on the clone is the same as the default — the new
  // UNIQUE(shop_id, campaign_id, template_key) tolerates this because the
  // tuple differs in campaign_id.
  const result = db.prepare(`
    INSERT INTO email_templates
      (campaign_id, template_key, display_name, is_active, subject, body_html,
       cta_enabled, cta_label, trigger_event, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.campaignId,
    source.template_key,
    `${source.display_name} (campaign override)`,
    source.is_active,
    source.subject,
    source.body_html,
    source.cta_enabled,
    source.cta_label,
    source.trigger_event,
    now,
    now,
  );
  const id = Number(result.lastInsertRowid);
  return (db
    .prepare('SELECT * FROM email_templates WHERE id = ?')
    .get(id) as EmailTemplateRow | undefined) ?? null;
};

// Upsert a DEFAULT template by key (campaign_id IS NULL). Used by the seed
// and by the Branding-tab content editor. The ON CONFLICT target matches the
// `uniq_default_template` partial index — SQLite needs the WHERE clause
// repeated here so the conflict-resolution path picks the right index.
// Campaign-specific overrides are written through updateEmailTemplateById
// instead (the editor for those loads by id, not by key).
export const upsertEmailTemplate = (input: {
  templateKey: string;
  displayName: string;
  subject: string;
  bodyHtml: string;
  ctaEnabled: boolean;
  ctaLabel: string;
  isActive: boolean;
  triggerEvent?: string | null;
}): EmailTemplateRow => {
  const now = nowSec();
  const db = getDb();
  db.prepare(`
    INSERT INTO email_templates
      (template_key, display_name, is_active, subject, body_html, cta_enabled, cta_label, trigger_event, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, template_key) WHERE campaign_id IS NULL DO UPDATE SET
      display_name  = excluded.display_name,
      is_active     = excluded.is_active,
      subject       = excluded.subject,
      body_html     = excluded.body_html,
      cta_enabled   = excluded.cta_enabled,
      cta_label     = excluded.cta_label,
      trigger_event = COALESCE(excluded.trigger_event, email_templates.trigger_event),
      updated_at    = excluded.updated_at
  `).run(
    input.templateKey,
    input.displayName,
    input.isActive ? 1 : 0,
    input.subject,
    input.bodyHtml,
    input.ctaEnabled ? 1 : 0,
    input.ctaLabel,
    input.triggerEvent ?? null,
    now,
    now,
  );
  return findEmailTemplate(input.templateKey)!;
};

// Edit-by-id, used by the campaign-specific template editor (which loads by
// id since template_key isn't unique across the campaign-clone rows). Same
// editable fields as upsertEmailTemplate.
export const updateEmailTemplateById = (input: {
  id: number;
  displayName: string;
  subject: string;
  bodyHtml: string;
  ctaEnabled: boolean;
  ctaLabel: string;
  isActive: boolean;
}): void => {
  getDb().prepare(`
    UPDATE email_templates
       SET display_name = ?,
           subject = ?,
           body_html = ?,
           cta_enabled = ?,
           cta_label = ?,
           is_active = ?,
           updated_at = ?
     WHERE id = ?
  `).run(
    input.displayName,
    input.subject,
    input.bodyHtml,
    input.ctaEnabled ? 1 : 0,
    input.ctaLabel,
    input.isActive ? 1 : 0,
    nowSec(),
    input.id,
  );
};

export const findEmailTemplateById = (id: number): EmailTemplateRow | null => {
  return (getDb()
    .prepare('SELECT * FROM email_templates WHERE id = ?')
    .get(id) as EmailTemplateRow | undefined) ?? null;
};

// Creates a brand-new merchant-authored template with a generated unique key.
// Returns the new row.
export const createEmailTemplate = (input: {
  displayName: string;
  triggerEvent: string | null;
  subject: string;
  bodyHtml: string;
  ctaEnabled: boolean;
  ctaLabel: string;
  isActive: boolean;
}): EmailTemplateRow => {
  const slug = input.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'template';
  const key = `custom-${slug}-${crypto.randomBytes(3).toString('hex')}`;
  return upsertEmailTemplate({ ...input, templateKey: key });
};

// Deletes a default template by key. Campaign-specific clones aren't touched
// (they're scoped to a campaign and managed from inside that campaign view).
// The seed re-creates the four defaults on next boot if they're missing, so
// deleting a default is not permanent across a restart unless the merchant
// also recreates it; merchant-authored templates (custom-*) stay deleted.
export const deleteEmailTemplate = (templateKey: string): void => {
  getDb().prepare('DELETE FROM email_templates WHERE template_key = ? AND campaign_id IS NULL')
    .run(templateKey);
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

// --- Filtered/sorted reviews list (admin Reviews tab) ---

export interface ReviewFilter {
  status?: string;     // published | pending | rejected
  rating?: number;     // 1-5
  productId?: string;  // exact shopify_product_id
  reviewer?: string;   // substring match on email or name
  dateFrom?: number;   // unix sec, inclusive
  dateTo?: number;     // unix sec, inclusive
}

export type ReviewSortKey = 'created_at' | 'rating' | 'product' | 'reviewer' | 'status';

export interface ReviewListRow extends ReviewRow {
  product_title: string | null;
  variants_json: string | null;
}

// Sort keys map to a fixed whitelist of expressions — never interpolate a
// caller-supplied column name into SQL.
const REVIEW_SORT_COLUMNS: Record<ReviewSortKey, string> = {
  created_at: 'r.created_at',
  rating: 'r.rating',
  product: 'COALESCE(pc.title, r.shopify_product_id)',
  reviewer: 'COALESCE(r.reviewer_name, r.reviewer_email)',
  status: 'r.status',
};

const buildReviewWhere = (f: ReviewFilter): { clause: string; params: Array<string | number> } => {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (f.status) { where.push('r.status = ?'); params.push(f.status); }
  if (f.rating) { where.push('r.rating = ?'); params.push(f.rating); }
  if (f.productId) { where.push('r.shopify_product_id = ?'); params.push(f.productId); }
  if (f.reviewer) {
    where.push('(r.reviewer_email LIKE ? OR r.reviewer_name LIKE ?)');
    const like = `%${f.reviewer}%`;
    params.push(like, like);
  }
  if (f.dateFrom) { where.push('r.created_at >= ?'); params.push(f.dateFrom); }
  if (f.dateTo) { where.push('r.created_at <= ?'); params.push(f.dateTo); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
};

export const listReviewsFiltered = (input: {
  filter: ReviewFilter;
  sort: ReviewSortKey;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}): ReviewListRow[] => {
  const { clause, params } = buildReviewWhere(input.filter);
  const col = REVIEW_SORT_COLUMNS[input.sort] ?? REVIEW_SORT_COLUMNS.created_at;
  const dir = input.dir === 'asc' ? 'ASC' : 'DESC';
  return getDb().prepare(`
    SELECT r.*, pc.title AS product_title, pc.variants_json AS variants_json
      FROM reviews r
      LEFT JOIN products_cache pc ON pc.shopify_product_id = r.shopify_product_id
      ${clause}
     ORDER BY ${col} ${dir}, r.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as ReviewListRow[];
};

export const countReviewsFiltered = (filter: ReviewFilter): number => {
  const { clause, params } = buildReviewWhere(filter);
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM reviews r ${clause}
  `).get(...params) as { n: number };
  return row.n;
};

// Distinct products that have at least one review, with cached title if known.
// Drives the product filter dropdown on the Reviews tab.
export const listReviewProductOptions = (): Array<{ shopify_product_id: string; title: string | null }> => {
  return getDb().prepare(`
    SELECT DISTINCT r.shopify_product_id AS shopify_product_id, pc.title AS title
      FROM reviews r
      LEFT JOIN products_cache pc ON pc.shopify_product_id = r.shopify_product_id
     ORDER BY COALESCE(pc.title, r.shopify_product_id)
  `).all() as Array<{ shopify_product_id: string; title: string | null }>;
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

// Used by the storefront-customer edit flow. Only fields the customer can
// change are updateable; status, customer_id, product/variant ids, verified
// state and merchant reply are NOT touched here.
export const updateReviewContent = (input: {
  id: number;
  rating: number;
  title: string | null;
  body: string;
  titleOriginal: string | null;
  bodyOriginal: string;
  reviewerName: string | null;
}): void => {
  getDb().prepare(`
    UPDATE reviews
       SET rating = ?, title = ?, body = ?, title_original = ?, body_original = ?, reviewer_name = ?, updated_at = ?
     WHERE id = ?
  `).run(
    input.rating,
    input.title,
    input.body,
    input.titleOriginal,
    input.bodyOriginal,
    input.reviewerName,
    nowSec(),
    input.id,
  );
};

// --- Profanity re-scan support ---
// Reviews that have a captured original (raw) text, so their censored display
// copy can be re-derived when the wordlist changes. Reviews predating the
// original-text columns (NULL original) are skipped — nothing to re-derive.
export const listReviewsForRecensor = (): Array<{ id: number; title_original: string | null; body_original: string }> => {
  return getDb().prepare(`
    SELECT id, title_original, body_original
      FROM reviews
     WHERE body_original IS NOT NULL
  `).all() as Array<{ id: number; title_original: string | null; body_original: string }>;
};

// Rewrites only the censored display columns (never the originals).
export const updateReviewCensored = (id: number, title: string | null, body: string): void => {
  getDb().prepare(`
    UPDATE reviews SET title = ?, body = ?, updated_at = ? WHERE id = ?
  `).run(title, body, nowSec(), id);
};

// True if this customer has at least one fulfilled purchase of this product.
// Determines whether their storefront review gets verified_kind='purchase' or
// null (unverified). Includes purchases regardless of reviewed_at / due_at —
// any prior purchase confers verified status.
export const customerHasPurchasedProduct = (
  customerId: number,
  shopifyProductId: string,
): boolean => {
  const row = getDb()
    .prepare(`
      SELECT 1 AS x FROM purchases
       WHERE customer_id = ? AND shopify_product_id = ?
       LIMIT 1
    `)
    .get(customerId, shopifyProductId) as { x: 1 } | undefined;
  return row !== undefined;
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

export interface EmailEventDetail {
  id: number;
  kind: string;
  created_at: number;
  customer_id: number | null;
  customer_email: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  metadata_json: string | null;
  product_title: string | null;
  shopify_product_id: string | null;
}

// Lists email_events of one kind since a cutoff, joined to the customer (so the
// dashboard activity drill-downs show people) and, via the event's purchase, to
// the product (so they show what was involved). Most recent first.
export const listEmailEventsByKind = (
  kind: string,
  sinceSec: number,
  limit: number,
): EmailEventDetail[] => {
  return getDb().prepare(`
    SELECT e.id, e.kind, e.created_at, e.customer_id, e.metadata_json,
           c.email      AS customer_email,
           c.first_name AS customer_first_name,
           c.last_name  AS customer_last_name,
           p.shopify_product_id AS shopify_product_id,
           pc.title             AS product_title
      FROM email_events e
      LEFT JOIN customers c ON c.id = e.customer_id
      LEFT JOIN purchases p ON p.id = e.purchase_id
      LEFT JOIN products_cache pc ON pc.shopify_product_id = p.shopify_product_id
     WHERE e.kind = ? AND e.created_at >= ?
     ORDER BY e.created_at DESC
     LIMIT ?
  `).all(kind, sinceSec, limit) as EmailEventDetail[];
};

// --- Product cache (for email rendering and storefront fallbacks) ---

export interface ProductCacheRow {
  id: number;
  shopify_product_id: string;
  handle: string;
  title: string;
  featured_image_url: string | null;
  variant_handling: string | null;
  variants_json: string | null;
  updated_at: number;
}

export const upsertProductCache = (input: {
  shopifyProductId: string;
  handle: string;
  title: string;
  featuredImageUrl: string | null;
  variantHandling: string | null;
  variantsJson?: string | null;
}): void => {
  getDb().prepare(`
    INSERT INTO products_cache (shopify_product_id, handle, title, featured_image_url, variant_handling, variants_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, shopify_product_id) DO UPDATE SET
      handle = excluded.handle,
      title = excluded.title,
      featured_image_url = excluded.featured_image_url,
      variant_handling = excluded.variant_handling,
      variants_json = excluded.variants_json,
      updated_at = excluded.updated_at
  `).run(
    input.shopifyProductId,
    input.handle,
    input.title,
    input.featuredImageUrl,
    input.variantHandling,
    input.variantsJson ?? null,
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

// All cached product rows for picker UIs. Ordered alphabetically by title so
// the merchant can scan a long list quickly. Featured image URL included so
// the picker can render thumbnails next to names.
export const listAllProductCacheRows = (): Array<{
  shopifyProductId: string;
  title: string;
  handle: string;
  featuredImageUrl: string | null;
}> => {
  const rows = getDb().prepare(`
    SELECT shopify_product_id, title, handle, featured_image_url
      FROM products_cache
     ORDER BY title COLLATE NOCASE ASC
  `).all() as Array<{
    shopify_product_id: string;
    title: string;
    handle: string;
    featured_image_url: string | null;
  }>;
  return rows.map((r) => ({
    shopifyProductId: r.shopify_product_id,
    title: r.title,
    handle: r.handle,
    featuredImageUrl: r.featured_image_url,
  }));
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
