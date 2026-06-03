// Validation helper coverage: input parsers and predicates that gate user
// input throughout the system. A subtle bug here usually shows up as an
// error 400 the user can't make sense of, or worse — as accepting bad input
// that breaks invariants downstream.

import path from 'node:path';
import os from 'node:os';
import { TestRun, assertEqual } from './_harness.js';

process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.DATA_DIR = path.join(os.tmpdir(), `reviews-validation-${Date.now()}`);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';

const { isValidHexColor } = await import('../src/shopify/widget-config.js');
const { isValidShopDomain, shopHandle } = await import('../src/shopify/oauth.js');
const { parseProductId } = await import('../src/shopify/parse-product-id.js');
const { isModerationReason, isReportReason } = await import('../src/db/queries.js');
const { isEmailTrigger } = await import('../src/email/triggers.js');
const { isFeedbackQuestionType } = await import('../src/db/feedback.js');
const { isCampaignStatus, isCampaignMemberStatus } = await import('../src/db/campaigns.js');

const run = new TestRun('08-validation');

// --- isValidHexColor ---

await run.test('isValidHexColor accepts canonical #RRGGBB', () => {
  assertEqual(isValidHexColor('#000000'), true, 'Lowercase zeros');
  assertEqual(isValidHexColor('#ffffff'), true, 'Lowercase ffs');
  assertEqual(isValidHexColor('#AaBbCc'), true, 'Mixed case');
  assertEqual(isValidHexColor('#123456'), true, 'Digits');
});

await run.test('isValidHexColor rejects malformed', () => {
  assertEqual(isValidHexColor('000000'), false, 'Missing #');
  assertEqual(isValidHexColor('#abc'), false, 'Short form');
  assertEqual(isValidHexColor('#abcdefg'), false, 'Too long');
  assertEqual(isValidHexColor('#xyzxyz'), false, 'Non-hex chars');
  assertEqual(isValidHexColor(''), false, 'Empty');
  assertEqual(isValidHexColor(123 as unknown as string), false, 'Non-string');
  assertEqual(isValidHexColor(null as unknown as string), false, 'Null');
});

// --- isValidShopDomain ---

await run.test('isValidShopDomain accepts canonical <handle>.myshopify.com', () => {
  assertEqual(isValidShopDomain('teraclay.myshopify.com'), true, 'Basic case');
  assertEqual(isValidShopDomain('my-store-123.myshopify.com'), true, 'Hyphens + digits');
});

await run.test('isValidShopDomain rejects non-myshopify domains', () => {
  assertEqual(isValidShopDomain('evil.com'), false, 'Plain domain');
  assertEqual(isValidShopDomain('myshopify.com'), false, 'No handle prefix');
  assertEqual(isValidShopDomain('test.MYSHOPIFY.COM'), true, 'Case-insensitive accept (regex /i)');
  assertEqual(isValidShopDomain(''), false, 'Empty');
  assertEqual(isValidShopDomain('-leadinghyphen.myshopify.com'), false, 'Leading hyphen not allowed');
});

// --- shopHandle ---

await run.test('shopHandle strips .myshopify.com', () => {
  assertEqual(shopHandle('teraclay.myshopify.com'), 'teraclay', 'Basic strip');
  assertEqual(shopHandle('my-shop.myshopify.com'), 'my-shop', 'Hyphenated');
});

// --- parseProductId ---

await run.test('parseProductId accepts numeric ID', () => {
  assertEqual(parseProductId('9218705883386'), '9218705883386', 'Plain numeric');
  assertEqual(parseProductId('  123  '), '123', 'Whitespace trimmed');
});

await run.test('parseProductId accepts gid://shopify/Product/<id>', () => {
  assertEqual(
    parseProductId('gid://shopify/Product/9218705883386'),
    '9218705883386',
    'GID form',
  );
});

await run.test('parseProductId accepts admin URLs', () => {
  assertEqual(
    parseProductId('https://admin.shopify.com/store/teraclay/products/9218705883386'),
    '9218705883386',
    'Admin URL',
  );
  assertEqual(
    parseProductId('https://admin.shopify.com/store/teraclay/products/9218705883386/variants/123'),
    '9218705883386',
    'Admin URL with variants suffix',
  );
});

await run.test('parseProductId rejects storefront URLs (handle, not ID)', () => {
  assertEqual(
    parseProductId('https://teraclay.com/products/face-cream-1'),
    null,
    'Storefront URL with handle should NOT be accepted (could not resolve to ID without API call)',
  );
});

await run.test('parseProductId rejects garbage', () => {
  assertEqual(parseProductId(''), null, 'Empty');
  assertEqual(parseProductId('not a product'), null, 'Garbage text');
  assertEqual(parseProductId('abc123'), null, 'Mixed alphanumeric');
});

// --- isModerationReason ---

await run.test('isModerationReason: accepts known values', () => {
  for (const r of ['profanity', 'spam', 'off-topic', 'not-a-customer', 'harassment', 'contains-pii', 'legal-takedown', 'duplicate', 'other']) {
    assertEqual(isModerationReason(r), true, `Should accept "${r}"`);
  }
});

await run.test('isModerationReason: rejects unknown', () => {
  assertEqual(isModerationReason('not-a-reason'), false, 'Unknown reason');
  assertEqual(isModerationReason(''), false, 'Empty');
  assertEqual(isModerationReason(null), false, 'Null');
  assertEqual(isModerationReason(123), false, 'Number');
});

// --- isReportReason ---

await run.test('isReportReason: rejects unknown', () => {
  assertEqual(isReportReason('not-a-reason'), false, 'Unknown reason');
  assertEqual(isReportReason(''), false, 'Empty');
});

// --- isEmailTrigger ---

await run.test('isEmailTrigger: accepts the registry values', () => {
  for (const t of ['review_request', 'review_request_followup', 'repeat_customer_review', 'review_removed', 'review_restored', 'review_submitted_thankyou', 'campaign_application_confirmation', 'campaign_shipped_notification', 'campaign_review_reminder', 'campaign_launch_thanks']) {
    assertEqual(isEmailTrigger(t), true, `Should accept "${t}"`);
  }
});

await run.test('isEmailTrigger: rejects unknown', () => {
  assertEqual(isEmailTrigger('not_a_trigger'), false, 'Unknown trigger');
  assertEqual(isEmailTrigger(''), false, 'Empty');
  assertEqual(isEmailTrigger(null), false, 'Null');
});

// --- isFeedbackQuestionType ---

await run.test('isFeedbackQuestionType: accepts the 5 known types', () => {
  for (const t of ['rating_1_5', 'single_choice', 'multi_choice', 'short_text', 'long_text']) {
    assertEqual(isFeedbackQuestionType(t), true, `Should accept "${t}"`);
  }
});

await run.test('isFeedbackQuestionType: rejects unknown', () => {
  assertEqual(isFeedbackQuestionType('rating_1_10'), false, 'Unknown rating scale');
  assertEqual(isFeedbackQuestionType('multiple_choice'), false, 'Slightly wrong key');
});

// --- isCampaignStatus / isCampaignMemberStatus ---

await run.test('isCampaignStatus: accepts the 7 known states', () => {
  for (const s of ['draft', 'recruiting', 'closed', 'shipping', 'active', 'completed', 'cancelled']) {
    assertEqual(isCampaignStatus(s), true, `Should accept "${s}"`);
  }
  assertEqual(isCampaignStatus('paused'), false, 'Unknown state');
});

await run.test('isCampaignMemberStatus: accepts the 7 known states', () => {
  for (const s of ['applied', 'approved', 'rejected', 'shipped', 'reminded', 'reviewed', 'done']) {
    assertEqual(isCampaignMemberStatus(s), true, `Should accept "${s}"`);
  }
});

process.exit(run.finish() ? 0 : 1);
