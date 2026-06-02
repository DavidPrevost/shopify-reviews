// Dispatcher eligibility query + suppression audit.
//
// The single most important correctness surface in the system: which purchases
// get a review-request email and which don't. We seed a synthetic DB with one
// representative row for each rule and verify the eligibility query returns
// only the truly-eligible row, while auditSuppressions accounts for the rest
// in the right bucket.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TestRun, assert, assertEqual } from './_harness.js';

const tmpDir = path.join(os.tmpdir(), `reviews-dispatcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR = tmpDir;
process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';

const { migrate, getDb, closeDb } = await import('../src/db/client.js');
const { findEligiblePurchases, auditSuppressions, setSetting, upsertCustomer, upsertPurchase, insertReview, setGlobalOptOut, setProductOptOut, findPurchasesByOrder, getCadenceBypassFlags } = await import('../src/db/queries.js');

migrate();

const run = new TestRun('07-dispatcher-eligibility');

// Use settings that simplify the math.
setSetting('cadence_max_requests', '3');
setSetting('cadence_min_days_between', '7');
setSetting('request_delay_days', '7');
setSetting('cadence_dispatcher_batch', '100');
setSetting('request_cutoff_at', '0'); // no go-live guard for these tests

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

// Helper: create a customer + a fulfilled purchase that's due NOW. Caller can
// further mutate the row to put it into a specific suppression bucket.
let nextEmailSuffix = 0;
const createFulfilledDuePurchase = (label: string): { customerId: number; purchaseId: number; productId: string } => {
  nextEmailSuffix++;
  const email = `test+${label}-${nextEmailSuffix}@example.com`;
  const productId = `${1000 + nextEmailSuffix}`;
  const customer = upsertCustomer({
    shopifyCustomerId: String(nextEmailSuffix),
    email,
    firstName: 'Test',
    lastName: 'User',
  });
  const orderId = `order-${nextEmailSuffix}`;
  upsertPurchase({
    customerId: customer.id,
    shopifyOrderId: orderId,
    shopifyProductId: productId,
    shopifyVariantId: null,
    fulfilledAt: NOW - 10 * DAY, // fulfilled 10 days ago
    dueAt: NOW - 60, // due 1 minute ago
  });
  // upsertPurchase returns void; look up the purchase id by the unique order+product key.
  const rows = findPurchasesByOrder(orderId);
  const found = rows.find((p) => p.shopify_product_id === productId);
  if (!found) {
    throw new Error(`Test setup bug: just-inserted purchase not found by order ${orderId} + product ${productId}`);
  }
  return { customerId: customer.id, purchaseId: found.id, productId };
};

await run.test('Baseline: a single eligible purchase IS returned', () => {
  // Wipe synthetic state for this test.
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId } = createFulfilledDuePurchase('baseline');
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, `Expected 1 eligible row, got ${rows.length}`);
  assertEqual(rows[0]!.p_id, purchaseId, 'Eligible row matches the seeded purchase');
  assertEqual(rows[0]!.c_id, customerId, 'Eligible row matches the seeded customer');
});

await run.test('Suppression: globalOptOut excludes the purchase + accounted in audit', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId } = createFulfilledDuePurchase('global-opt-out');
  setGlobalOptOut(customerId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, `Globally-opted-out customer should yield 0 eligible; got ${rows.length}`);
  const audit = auditSuppressions();
  assertEqual(audit.globalOptOut, 1, `Audit globalOptOut should count 1; got ${audit.globalOptOut}`);
  assertEqual(audit.productOptOut, 0, 'Other audit buckets should be 0');
});

await run.test('Suppression: setProductOptOut excludes from eligibility (but ALSO clears due_at)', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId, customerId } = createFulfilledDuePurchase('product-opt-out');
  setProductOptOut(purchaseId, customerId);

  // Verify the side effect: due_at was nulled by setProductOptOut.
  const row = db.prepare('SELECT product_opt_out, due_at FROM purchases WHERE id = ?').get(purchaseId) as { product_opt_out: number; due_at: number | null };
  assertEqual(row.product_opt_out, 1, 'product_opt_out flag set');
  assertEqual(row.due_at, null, 'NOTE: setProductOptOut also nulls due_at as a side effect — see queries.ts:932');

  // Eligibility correctly excludes.
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Product-opted-out purchase yields 0 eligible');

  // FINDING: because due_at is now NULL, the audit query (which requires
  // due_at IS NOT NULL) does NOT count this in productOptOut. The audit's
  // productOptOut bucket effectively counts only "edge cases" where someone
  // set the flag but left due_at set — never the happy-path use.
  const audit = auditSuppressions();
  assertEqual(
    audit.productOptOut, 0,
    'productOptOut audit is 0 after setProductOptOut (due_at clearing pushes the row out of the audit candidate set).',
  );
});

await run.test('Suppression: productOptOut audit bucket DOES count when due_at is preserved (direct SQL)', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId } = createFulfilledDuePurchase('product-opt-out-preserved');
  // Set product_opt_out=1 directly without going through setProductOptOut, so
  // due_at stays populated. This is the scenario the audit query was designed for.
  db.prepare('UPDATE purchases SET product_opt_out = 1 WHERE id = ?').run(purchaseId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'product_opt_out=1 still excludes from eligibility');
  const audit = auditSuppressions();
  assertEqual(audit.productOptOut, 1, `With due_at preserved, audit productOptOut counts 1; got ${audit.productOptOut}`);
});

await run.test('Suppression: maxRequestsHit excludes + accounted', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId } = createFulfilledDuePurchase('max-requests');
  // request_count = 3 (>= cadence_max_requests of 3)
  db.prepare('UPDATE purchases SET request_count = 3 WHERE id = ?').run(purchaseId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Purchase at max request count should be excluded');
  const audit = auditSuppressions();
  assertEqual(audit.maxRequestsHit, 1, `Audit maxRequestsHit should be 1; got ${audit.maxRequestsHit}`);
});

await run.test('Suppression: cadenceTooSoon excludes + accounted', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId } = createFulfilledDuePurchase('cadence-too-soon');
  // Customer was emailed 3 days ago; cadence_min_days_between is 7 → too soon.
  db.prepare('UPDATE customers SET last_request_sent_at = ? WHERE id = ?').run(NOW - 3 * DAY, customerId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Purchase within cadence window should be excluded');
  const audit = auditSuppressions();
  assertEqual(audit.cadenceTooSoon, 1, `Audit cadenceTooSoon should be 1; got ${audit.cadenceTooSoon}`);
});

await run.test('Suppression: alreadyReviewed excludes + accounted', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId, productId } = createFulfilledDuePurchase('already-reviewed');
  insertReview({
    shopifyProductId: productId,
    shopifyVariantId: null,
    customerId,
    reviewerEmail: 'test@example.com',
    reviewerName: 'Test',
    rating: 5,
    title: 'ok',
    body: 'body',
    titleOriginal: 'ok',
    bodyOriginal: 'body',
    verifiedKind: 'purchase',
    status: 'published',
  });
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Purchase by customer who already reviewed this product should be excluded');
  const audit = auditSuppressions();
  assertEqual(audit.alreadyReviewed, 1, `Audit alreadyReviewed should be 1; got ${audit.alreadyReviewed}`);
});

await run.test('Suppression: go-live cutoff excludes orders fulfilled before cutoff', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  // Pre-cutoff purchase: fulfilled 30 days ago, cutoff was 14 days ago.
  const { purchaseId } = createFulfilledDuePurchase('pre-cutoff');
  db.prepare('UPDATE purchases SET fulfilled_at = ? WHERE id = ?').run(NOW - 30 * DAY, purchaseId);
  setSetting('request_cutoff_at', String(NOW - 14 * DAY));

  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Pre-cutoff purchase must NOT appear in eligibility');

  // Now add a post-cutoff purchase too, and confirm only IT is eligible.
  const { purchaseId: postId } = createFulfilledDuePurchase('post-cutoff');
  db.prepare('UPDATE purchases SET fulfilled_at = ? WHERE id = ?').run(NOW - 7 * DAY, postId);
  const rows2 = findEligiblePurchases(100);
  assertEqual(rows2.length, 1, `Only the post-cutoff purchase should be eligible; got ${rows2.length}`);
  assertEqual(rows2[0]!.p_id, postId, 'Eligible row should be the post-cutoff purchase');

  setSetting('request_cutoff_at', '0'); // reset
});

await run.test('Suppression: due_at in the future excludes', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId } = createFulfilledDuePurchase('future-due');
  db.prepare('UPDATE purchases SET due_at = ? WHERE id = ?').run(NOW + 3 * DAY, purchaseId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Purchases whose due_at is in the future must not be picked up yet');
});

await run.test('Suppression: due_at NULL (unfulfilled) excludes', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId } = createFulfilledDuePurchase('null-due');
  db.prepare('UPDATE purchases SET due_at = NULL WHERE id = ?').run(purchaseId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Purchases with null due_at (not fulfilled, or cleared) must be excluded');
});

await run.test('Suppression: customer that previously sent + now past cadence IS eligible again', () => {
  // The inverse of cadenceTooSoon: prove a customer becomes eligible once
  // enough days have passed. This is the follow-up email path.
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId } = createFulfilledDuePurchase('cadence-past');
  db.prepare('UPDATE customers SET last_request_sent_at = ? WHERE id = ?').run(NOW - 8 * DAY, customerId);
  db.prepare('UPDATE purchases SET request_count = 1, last_request_at = ? WHERE id = ?').run(NOW - 8 * DAY, purchaseId);
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, 'Customer past cadence window with unanswered prior request should be eligible for follow-up');
  assertEqual(rows[0]!.p_request_count, 1, 'request_count should be carried in the row so dispatcher picks follow-up template');
});

await run.test('Mixed scenario: 5 customers in different states → 1 eligible, audit accurate', () => {
  const db = getDb();
  // Wipe in FK order: children first.
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);

  // 1. Truly eligible
  const eligible = createFulfilledDuePurchase('mixed-eligible');
  // 2. Global opt-out
  const optedOut = createFulfilledDuePurchase('mixed-global');
  setGlobalOptOut(optedOut.customerId);
  // 3. Product opt-out — set the flag directly (so due_at is preserved and the
  //    audit query sees the row). Using setProductOptOut would clear due_at,
  //    pulling the row out of the audit candidate set (see prior test).
  const productOut = createFulfilledDuePurchase('mixed-product');
  db.prepare('UPDATE purchases SET product_opt_out = 1 WHERE id = ?').run(productOut.purchaseId);
  // 4. Max requests
  const maxed = createFulfilledDuePurchase('mixed-maxed');
  db.prepare('UPDATE purchases SET request_count = 3 WHERE id = ?').run(maxed.purchaseId);
  // 5. Already reviewed
  const reviewed = createFulfilledDuePurchase('mixed-reviewed');
  insertReview({
    shopifyProductId: reviewed.productId,
    shopifyVariantId: null,
    customerId: reviewed.customerId,
    reviewerEmail: 'r@example.com',
    reviewerName: 'r',
    rating: 5,
    title: null,
    body: 'good',
    titleOriginal: null,
    bodyOriginal: 'good',
    verifiedKind: 'purchase',
    status: 'published',
  });

  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, `Expected exactly 1 eligible in mixed scenario; got ${rows.length}`);
  assertEqual(rows[0]!.p_id, eligible.purchaseId, 'The single eligible row is the truly-eligible one');

  const audit = auditSuppressions();
  assertEqual(audit.globalOptOut, 1, 'Audit globalOptOut');
  assertEqual(audit.productOptOut, 1, 'Audit productOptOut');
  assertEqual(audit.maxRequestsHit, 1, 'Audit maxRequestsHit');
  assertEqual(audit.alreadyReviewed, 1, 'Audit alreadyReviewed');
  assertEqual(audit.cadenceTooSoon, 0, 'Audit cadenceTooSoon should be 0 in this scenario');
});

// --- Cadence bypass dev toggles ---
//
// Two settings (bypass_cadence_min_days, bypass_cadence_max_requests) loosen
// the corresponding cadence rule when set to '1'. Audit is unchanged — it
// always reports what the rules WOULD suppress under normal settings; the
// bypass flags travel separately in the dispatcher's result.

await run.test('getCadenceBypassFlags reads both settings (default off)', () => {
  // Defaults: setting rows don't exist → flags false.
  setSetting('bypass_cadence_min_days', '0');
  setSetting('bypass_cadence_max_requests', '0');
  const flags = getCadenceBypassFlags();
  assertEqual(flags.minDays, false, 'minDays off when setting is "0"');
  assertEqual(flags.maxRequests, false, 'maxRequests off when setting is "0"');
});

await run.test('getCadenceBypassFlags returns true when settings are "1"', () => {
  setSetting('bypass_cadence_min_days', '1');
  setSetting('bypass_cadence_max_requests', '1');
  const flags = getCadenceBypassFlags();
  assertEqual(flags.minDays, true, 'minDays on');
  assertEqual(flags.maxRequests, true, 'maxRequests on');
  // Reset for the eligibility tests below.
  setSetting('bypass_cadence_min_days', '0');
  setSetting('bypass_cadence_max_requests', '0');
});

await run.test('Bypass min-days: customer inside cadence window IS eligible when flag set', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId } = createFulfilledDuePurchase('bypass-min-days');
  // Recent email (3 days ago) within the default 7-day window → would normally suppress.
  db.prepare('UPDATE customers SET last_request_sent_at = ? WHERE id = ?').run(NOW - 3 * DAY, customerId);

  // Without bypass — normal behavior: suppressed.
  setSetting('bypass_cadence_min_days', '0');
  let rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Without bypass: cadence window suppresses (baseline)');
  let audit = auditSuppressions();
  assertEqual(audit.cadenceTooSoon, 1, 'Audit shows cadenceTooSoon=1 (baseline)');

  // With bypass — eligibility ignores the window. Audit STILL counts the rule firing.
  setSetting('bypass_cadence_min_days', '1');
  rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, 'With bypass on: purchase is eligible');
  assertEqual(rows[0]!.p_id, purchaseId, 'The bypass-eligible row is the seeded purchase');
  audit = auditSuppressions();
  assertEqual(audit.cadenceTooSoon, 1, 'Audit STILL reports cadenceTooSoon=1 — observability for what would normally fire');

  // Reset
  setSetting('bypass_cadence_min_days', '0');
});

await run.test('Bypass max-requests: purchase at cap IS eligible when flag set (with due_at preserved)', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { purchaseId } = createFulfilledDuePurchase('bypass-max');
  // request_count at the cap (3). NOTE: in normal operation
  // recordRequestSentBatch would have NULLed due_at when hitting the cap; this
  // test preserves due_at by setting the column directly, so we exercise the
  // SQL clause's bypass behavior in isolation. To simulate a "real" past-cap
  // re-arm in production, an operator would have to manually re-arm due_at —
  // see the testing checklist for the SQL recipe.
  db.prepare('UPDATE purchases SET request_count = 3 WHERE id = ?').run(purchaseId);

  // Without bypass — suppressed.
  setSetting('bypass_cadence_max_requests', '0');
  let rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Without bypass: at-cap purchase suppressed (baseline)');
  let audit = auditSuppressions();
  assertEqual(audit.maxRequestsHit, 1, 'Audit shows maxRequestsHit=1 (baseline)');

  // With bypass — eligibility allows.
  setSetting('bypass_cadence_max_requests', '1');
  rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, 'With bypass on: at-cap purchase is eligible');
  audit = auditSuppressions();
  assertEqual(audit.maxRequestsHit, 1, 'Audit STILL reports maxRequestsHit=1 — observability');

  // Reset
  setSetting('bypass_cadence_max_requests', '0');
});

await run.test('Bypasses do NOT loosen opt-outs or alreadyReviewed', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  // Globally opted-out customer with both bypasses on → still suppressed.
  const { customerId } = createFulfilledDuePurchase('bypass-doesnt-touch-optout');
  setGlobalOptOut(customerId);
  setSetting('bypass_cadence_min_days', '1');
  setSetting('bypass_cadence_max_requests', '1');
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 0, 'Bypass MUST NOT override globalOptOut — that is a respect rule, not policy');

  // Reset
  setSetting('bypass_cadence_min_days', '0');
  setSetting('bypass_cadence_max_requests', '0');
});

await run.test('Both bypasses on simultaneously: cadence-window AND at-cap purchase is eligible', () => {
  const db = getDb();
  db.exec(`
    DELETE FROM email_events;
    DELETE FROM review_media;
    DELETE FROM moderation_events;
    DELETE FROM review_reports;
    DELETE FROM reviews;
    DELETE FROM purchases;
    DELETE FROM customers;
  `);
  const { customerId, purchaseId } = createFulfilledDuePurchase('both-bypasses');
  db.prepare('UPDATE customers SET last_request_sent_at = ? WHERE id = ?').run(NOW - 3 * DAY, customerId);
  db.prepare('UPDATE purchases SET request_count = 3 WHERE id = ?').run(purchaseId);

  setSetting('bypass_cadence_min_days', '1');
  setSetting('bypass_cadence_max_requests', '1');
  const rows = findEligiblePurchases(100);
  assertEqual(rows.length, 1, 'Both bypasses lift both rules; the purchase is eligible');

  // The audit assigns each row to exactly ONE bucket using its documented
  // priority order: globalOptOut → productOptOut → maxRequestsHit → cadenceTooSoon
  // → alreadyReviewed. A row that's both at-cap AND in-cadence-window goes to
  // maxRequestsHit only. So cadenceTooSoon=0 here is correct.
  const audit = auditSuppressions();
  assertEqual(audit.maxRequestsHit, 1, 'maxRequestsHit reported (higher priority bucket)');
  assertEqual(audit.cadenceTooSoon, 0, 'cadenceTooSoon=0 — the row was already attributed to maxRequestsHit (priority order)');

  setSetting('bypass_cadence_min_days', '0');
  setSetting('bypass_cadence_max_requests', '0');
});

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(run.finish() ? 0 : 1);
