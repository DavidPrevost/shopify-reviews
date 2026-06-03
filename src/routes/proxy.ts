// Customer-authenticated routes hit via Shopify's App Proxy.
//
// Path: storefront → <store>.myshopify.com/apps/reviews/* → Shopify edge →
//       our backend at /proxy/*  (with HMAC-signed query params)
//
// Every route here verifies the App Proxy signature before doing anything,
// so we can trust the `logged_in_customer_id` query parameter. Public reads
// (review lists, aggregates) stay on the existing /api/* router with CORS —
// they don't need authentication and we don't need to pay the Shopify-edge
// round trip for them.

import crypto from 'node:crypto';
import { Hono } from 'hono';
import {
  findCustomerByShopifyId,
  findReviewByCustomerAndProduct,
  findReviewById,
  insertReview,
  updateReviewContent,
  customerHasPurchasedProduct,
  upsertCustomer,
  getSetting,
  setSetting,
  type ReviewRow,
} from '../db/queries.js';
import {
  findCampaignBySlug,
  getActiveTermsVersion,
  findTermsVersion,
  findCampaignMemberByEmail,
  insertCampaignMember,
  parseProductSet,
  checkCapacityAndAutoClose,
} from '../db/campaigns.js';
import {
  findFeedbackFormByAccessKey,
  listFeedbackQuestionsForForm,
  parseQuestionOptions,
  submitFeedbackResponse,
  isFeedbackQuestionType,
  type FeedbackQuestionRow,
} from '../db/feedback.js';
import { notifyOnCampaignCapacity } from '../email/notify-campaign-capacity.js';
import { verifyAppProxySignature } from '../shopify/app-proxy-verify.js';
import { fetchShopifyCustomer } from '../shopify/customer-info.js';
import { sanitizeReviewText } from '../lib/profanity.js';
import { isReviewsPaused } from '../lib/panic.js';
import { notifyOnNewReview } from '../email/notify-new-review.js';
import { sendTemplateEmailByTriggerForCampaign } from '../email/send-template.js';
import { escapeHtml } from '../email/render.js';
import { take as rateLimitTake } from '../lib/rate-limit.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { nowSec } from '../lib/time.js';

const proxy = new Hono();

const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 4000;
const MAX_NAME_LEN = 80;

const trimOrNull = (s: unknown, maxLen: number): string | null => {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().slice(0, maxLen);
  return trimmed.length === 0 ? null : trimmed;
};

// Shape the storefront widget receives. Mirrors the public review-to-public
// shape used in /api/*, plus an `editable` flag so the widget knows whether
// the current review is the requesting customer's own (and therefore can
// surface an "Edit" affordance).
const reviewToProxyResponse = (r: ReviewRow) => ({
  id: r.id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  reviewerName: r.reviewer_name,
  verifiedKind: r.verified_kind,
  verifiedPurchase: r.verified_purchase === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Mounted middleware: verify every proxy request before route handlers run.
// Stash the verified customer ID on c.set('customerShopifyId', ...) for routes.
proxy.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const verified = verifyAppProxySignature(url.searchParams);
  if (!verified.valid) {
    log('warn', 'app proxy verification failed', { path: url.pathname });
    return c.json({ error: 'invalid_signature' }, 401);
  }
  // Stash the customer id when present. Routes that need a logged-in customer
  // enforce it via the /customer/* middleware below; shop-level routes (the
  // brand relay) work for any verified storefront visitor, logged in or not.
  if (verified.loggedInCustomerId) {
    c.set('customerShopifyId' as never, verified.loggedInCustomerId as never);
  }
  // App Proxy responses must not be cached by Shopify's edge — per-customer
  // data and write responses are dynamic.
  c.header('Cache-Control', 'no-store');
  await next();
});

// Customer-scoped routes require an actual logged-in customer. Anonymous
// visitors are shown a "log in to review" affordance by the widget, not the
// form, so a 401 here is the expected signal.
proxy.use('/customer/*', async (c, next) => {
  if (!c.get('customerShopifyId' as never)) {
    return c.json({ error: 'not_logged_in' }, 401);
  }
  await next();
});

// Brand relay: the theme passes the store's Liquid-rendered brand colors + logo
// as data attributes on the widget div; the widget posts them here. This is how
// brand assets reach our backend without Storefront API access — the storefront
// already has them via Liquid, and this endpoint is HMAC-verified (above) as
// genuinely from the shop. Writes shop_brand_json (the same blob the dormant
// Shopify sync would have), so the widget, emails, and dashboard share one
// source. Skips when the store has no brand data (manual entry stays the
// fallback) and no-ops when nothing changed (avoids churn from page views).
proxy.post('/brand', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    primaryBg?: string; primaryFg?: string; secondaryBg?: string; secondaryFg?: string; logo?: string;
  };
  const hex = (v: unknown): string | null =>
    typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null;
  const primaryBg = hex(body.primaryBg);
  const primaryFg = hex(body.primaryFg);
  const secondaryBg = hex(body.secondaryBg);
  const secondaryFg = hex(body.secondaryFg);
  // Logo becomes an <img src> in emails, so only accept a Shopify CDN URL —
  // defense in depth on top of the HMAC verification.
  const rawLogo = typeof body.logo === 'string' ? body.logo.trim() : '';
  const logo = /^https:\/\/[a-z0-9.-]*shopify(?:cdn)?\.(?:com|net)\//i.test(rawLogo) ? rawLogo : null;

  if (!primaryBg && !secondaryBg && !logo) {
    return c.json({ ok: true, skipped: 'no_brand_data' });
  }

  let current: {
    colors?: { primary?: { background?: string | null; foreground?: string | null }; secondary?: { background?: string | null; foreground?: string | null } };
    logoUrl?: string | null;
  } = {};
  try { current = JSON.parse(getSetting('shop_brand_json') ?? '{}'); } catch { current = {}; }

  const nextLogo = logo ?? current.logoUrl ?? null;
  const unchanged =
    (current.colors?.primary?.background ?? null) === primaryBg &&
    (current.colors?.primary?.foreground ?? null) === primaryFg &&
    (current.colors?.secondary?.background ?? null) === secondaryBg &&
    (current.colors?.secondary?.foreground ?? null) === secondaryFg &&
    (current.logoUrl ?? null) === nextLogo;
  if (unchanged) return c.json({ ok: true, changed: false });

  const blob = {
    ...current,
    colors: {
      primary: { background: primaryBg, foreground: primaryFg },
      secondary: { background: secondaryBg, foreground: secondaryFg },
    },
    logoUrl: nextLogo,
    syncedAt: nowSec(),
    source: 'liquid',
  };
  setSetting('shop_brand_json', JSON.stringify(blob, null, 2));
  log('info', 'brand relay updated shop_brand_json', { hasLogo: !!logo });
  return c.json({ ok: true, changed: true });
});

// Returns the logged-in customer's existing review for a product, or null.
// The widget calls this at load time to decide whether to render "Write a
// review" or "Edit your review" CTAs.
proxy.get('/customer/review', (c) => {
  const customerShopifyId = c.get('customerShopifyId' as never) as string;
  const productId = c.req.query('product_id');
  if (!productId) return c.json({ error: 'missing_product_id' }, 400);

  const customer = findCustomerByShopifyId(customerShopifyId);
  if (!customer) {
    // No local customer record (they haven't purchased anything yet) → no
    // existing review possible. Return null without doing a Shopify roundtrip
    // — only create the local record when they actually submit a review.
    return c.json({ review: null });
  }

  const review = findReviewByCustomerAndProduct(customer.id, productId);
  return c.json({ review: review ? reviewToProxyResponse(review) : null });
});

// Submit a new review. Verified status depends on whether the customer has
// previously purchased this product on the same Shopify store (verified_kind
// = 'purchase' if yes, null if not — no "Verified Buyer" badge for the
// no-purchase case).
proxy.post('/customer/review', async (c) => {
  if (isReviewsPaused()) return c.json({ error: 'reviews_paused' }, 503);
  const customerShopifyId = c.get('customerShopifyId' as never) as string;

  const body = await c.req.json().catch(() => ({})) as {
    product_id?: string;
    variant_id?: string;
    rating?: number;
    title?: string;
    body?: string;
    reviewer_name?: string;
  };

  const productId = trimOrNull(body.product_id, 64);
  const variantId = trimOrNull(body.variant_id, 64);
  const rating = Number(body.rating);
  const title = trimOrNull(body.title, MAX_TITLE_LEN);
  const reviewBody = trimOrNull(body.body, MAX_BODY_LEN);
  const submittedName = trimOrNull(body.reviewer_name, MAX_NAME_LEN);

  if (!productId) return c.json({ error: 'missing_product_id' }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: 'invalid_rating' }, 400);
  }
  if (!reviewBody) return c.json({ error: 'missing_body' }, 400);

  // Find or create the local customer record. Customer might be logged in to
  // Shopify but have never purchased — in that case no row exists yet, so we
  // fetch their details from Shopify Admin API and create one with no
  // shopify_customer_id collision since upsertCustomer dedupes by email.
  let customer = findCustomerByShopifyId(customerShopifyId);
  if (!customer) {
    const shopifyCustomer = await fetchShopifyCustomer(customerShopifyId);
    if (!shopifyCustomer) {
      return c.json({ error: 'customer_not_found' }, 404);
    }
    customer = upsertCustomer({
      shopifyCustomerId: shopifyCustomer.shopifyCustomerId,
      email: shopifyCustomer.email,
      firstName: shopifyCustomer.firstName,
      lastName: shopifyCustomer.lastName,
    });
  }

  // Reject if they already have a review for this product — they should be
  // taking the edit path instead. The widget should never submit when an
  // existing review is present, but enforce server-side too.
  const existing = findReviewByCustomerAndProduct(customer.id, productId);
  if (existing) {
    return c.json(
      { error: 'already_reviewed', existing_review_id: existing.id },
      409,
    );
  }

  const isPurchaser = customerHasPurchasedProduct(customer.id, productId);
  const displayName = submittedName ?? (customer.first_name?.trim() || null);

  const censored = sanitizeReviewText({ title, body: reviewBody });

  const reviewId = insertReview({
    shopifyProductId: productId,
    shopifyVariantId: variantId,
    customerId: customer.id,
    reviewerEmail: customer.email,
    reviewerName: displayName,
    rating,
    title: censored.title,
    body: censored.body,
    titleOriginal: title,
    bodyOriginal: reviewBody,
    verifiedKind: isPurchaser ? 'purchase' : null,
    status: 'published',
  });

  log('info', 'storefront customer submitted review', {
    reviewId,
    customerId: customer.id,
    productId,
    variantId,
    verified: isPurchaser ? 'purchase' : 'none',
  });

  void notifyOnNewReview({ reviewId, rating });

  return c.json({ ok: true, reviewId });
});

// Edit an existing review. Only the rating, title, body, and reviewer_name
// are updateable; the customer can't change verified status, the linked
// product/variant, or the customer association.
proxy.post('/customer/review/:id', async (c) => {
  if (isReviewsPaused()) return c.json({ error: 'reviews_paused' }, 503);
  const customerShopifyId = c.get('customerShopifyId' as never) as string;
  const reviewId = Number(c.req.param('id'));
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    return c.json({ error: 'invalid_review_id' }, 400);
  }

  const customer = findCustomerByShopifyId(customerShopifyId);
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);

  const review = findReviewById(reviewId);
  if (!review) return c.json({ error: 'review_not_found' }, 404);
  if (review.customer_id !== customer.id) {
    log('warn', 'storefront customer attempted to edit another customer\'s review', {
      reviewId,
      ownerCustomerId: review.customer_id,
      requestingCustomerId: customer.id,
    });
    return c.json({ error: 'not_yours' }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as {
    rating?: number;
    title?: string;
    body?: string;
    reviewer_name?: string;
  };

  const rating = Number(body.rating);
  const title = trimOrNull(body.title, MAX_TITLE_LEN);
  const reviewBody = trimOrNull(body.body, MAX_BODY_LEN);
  const submittedName = trimOrNull(body.reviewer_name, MAX_NAME_LEN);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: 'invalid_rating' }, 400);
  }
  if (!reviewBody) return c.json({ error: 'missing_body' }, 400);

  const displayName = submittedName ?? (customer.first_name?.trim() || null);

  const censored = sanitizeReviewText({ title, body: reviewBody });

  updateReviewContent({
    id: reviewId,
    rating,
    title: censored.title,
    body: censored.body,
    titleOriginal: title,
    bodyOriginal: reviewBody,
    reviewerName: displayName,
  });

  log('info', 'storefront customer edited review', {
    reviewId,
    customerId: customer.id,
  });

  return c.json({ ok: true, reviewId });
});

// =========================================================================
// Campaigns — public application form
//
// The storefront-side widget hits these via /apps/reviews/campaigns/:slug/* ;
// Shopify forwards as /proxy/campaigns/:slug/* with HMAC params (verified by
// the proxy.use('*', ...) middleware above). No customer login required —
// applications are open to any storefront visitor.
// =========================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APPLY_RATE_LIMIT = 10;      // requests per IP
const APPLY_RATE_WINDOW_SEC = 60; // per minute

const hashIp = (ip: string): string =>
  crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);

const getClientIp = (c: import('hono').Context): string => {
  // The relay chain (Shopify edge → GCP Caddy → Mercury) may set any of these.
  // We prefer the most-specific. If everything fails, fall back to a literal
  // so rate-limit buckets still apply globally.
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '') ??
    'unknown'
  ) || 'unknown';
};

// GET /proxy/campaigns/:slug/config — returns the data the widget needs to
// render the application form. 404 unless the campaign is currently
// recruiting; that way a paused/completed campaign's form url just shows
// "applications closed" instead of leaking the campaign config.
proxy.get('/campaigns/:slug/config', (c) => {
  const slug = c.req.param('slug');
  const camp = findCampaignBySlug(slug);
  if (!camp) return c.json({ error: 'not_found' }, 404);

  if (camp.status !== 'recruiting') {
    return c.json({
      state: 'closed',
      campaignName: camp.name,
    });
  }

  const terms = getActiveTermsVersion(camp.id);
  if (!terms) return c.json({ error: 'no_terms' }, 500);

  return c.json({
    state: 'open',
    campaignName: camp.name,
    slug: camp.slug,
    productCount: parseProductSet(camp).length,
    terms: {
      versionId: terms.id,
      versionNumber: terms.version_number,
      body: terms.body_text,
      summary: terms.summary_text ?? null,
    },
  });
});

// POST /proxy/campaigns/:slug/apply — submit application. Idempotent at the
// email level: a duplicate email returns a friendly 200 with `already_applied`
// rather than creating a second row.
proxy.post('/campaigns/:slug/apply', async (c) => {
  const slug = c.req.param('slug');

  const ip = getClientIp(c);
  if (!rateLimitTake(`campaign-apply:${ip}`, APPLY_RATE_LIMIT, APPLY_RATE_WINDOW_SEC)) {
    log('warn', 'campaign apply rate-limited', { slug, ip });
    return c.json({ error: 'rate_limited' }, 429);
  }

  const camp = findCampaignBySlug(slug);
  if (!camp) return c.json({ error: 'not_found' }, 404);
  if (camp.status !== 'recruiting') {
    return c.json({ error: 'applications_closed' }, 409);
  }

  const body = await c.req.json().catch(() => null) as {
    firstName?: string;
    lastName?: string;
    email?: string;
    shipping?: {
      name?: string;
      street1?: string;
      street2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    };
    message?: string;
    termsVersionId?: number;
  } | null;
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const firstName = String(body.firstName ?? '').trim().slice(0, 80);
  const lastName = String(body.lastName ?? '').trim().slice(0, 80);
  const email = String(body.email ?? '').trim().toLowerCase().slice(0, 254);
  const message = String(body.message ?? '').trim().slice(0, 2000);
  const termsVersionId = Number(body.termsVersionId);

  if (!firstName) return c.json({ error: 'missing_first_name' }, 400);
  if (!lastName) return c.json({ error: 'missing_last_name' }, 400);
  if (!email || !EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);

  // Terms-version check: the form must submit a version that matches the
  // currently-active one. If the merchant publishes a new version while the
  // form is open in someone's browser, the submission is rejected and the
  // applicant has to reload. Tradeoff: tiny inconvenience for occasional
  // edits in exchange for a clean accepted-version audit trail.
  const activeTerms = getActiveTermsVersion(camp.id);
  if (!activeTerms || !Number.isInteger(termsVersionId)) {
    return c.json({ error: 'missing_terms_version' }, 400);
  }
  if (activeTerms.id !== termsVersionId) {
    return c.json({ error: 'terms_changed', detail: 'Please reload the form — the terms have been updated.' }, 409);
  }
  const termsVersion = findTermsVersion(termsVersionId);
  if (!termsVersion || termsVersion.campaign_id !== camp.id) {
    return c.json({ error: 'invalid_terms_version' }, 400);
  }

  // Shipping address — required (these are physical sample packs). We capture
  // every field that's present; only address1, city, postal_code, country are
  // hard-required at this layer.
  const shipping = body.shipping ?? {};
  const shippingName = String(shipping.name ?? '').trim().slice(0, 160) || `${firstName} ${lastName}`.trim();
  const street1 = String(shipping.street1 ?? '').trim().slice(0, 200);
  const street2 = String(shipping.street2 ?? '').trim().slice(0, 200);
  const city = String(shipping.city ?? '').trim().slice(0, 100);
  const state = String(shipping.state ?? '').trim().slice(0, 100);
  const postalCode = String(shipping.postalCode ?? '').trim().slice(0, 24);
  const country = String(shipping.country ?? '').trim().slice(0, 100);

  if (!street1 || !city || !state || !postalCode || !country) {
    return c.json({ error: 'incomplete_shipping_address' }, 400);
  }
  // US ZIP format: 5 digits, optionally followed by -4. We're USA-only at
  // launch, so a tighter check here saves a downstream "we couldn't ship to
  // this address" round-trip. If we ever broaden to other countries, gate
  // this on `country === 'United States'` instead of always running it.
  if (!/^\d{5}(-\d{4})?$/.test(postalCode)) {
    return c.json({ error: 'invalid_postal_code' }, 400);
  }

  // Dedupe by email within the campaign. Friendly 200 — the applicant doesn't
  // get a clear signal whether they already applied (which would be a small
  // enumeration surface), but the second submission is a no-op.
  if (findCampaignMemberByEmail(camp.id, email)) {
    log('info', 'campaign duplicate application ignored', { campaignId: camp.id, email });
    return c.json({ ok: true, already_applied: true });
  }

  const applicationData = {
    firstName,
    lastName,
    email,
    message: message || null,
  };
  const shippingAddress = {
    name: shippingName,
    street1,
    street2: street2 || null,
    city,
    state: state || null,
    postalCode,
    country,
  };

  const memberId = insertCampaignMember({
    campaignId: camp.id,
    applicationDataJson: JSON.stringify(applicationData),
    shippingAddressJson: JSON.stringify(shippingAddress),
    termsVersionId: activeTerms.id,
    ipHash: hashIp(ip),
    userAgent: (c.req.header('user-agent') ?? '').slice(0, 500) || null,
  });

  log('info', 'campaign application accepted', { campaignId: camp.id, memberId, email });

  // Fire-and-forget confirmation email. Failures are logged inside the send
  // path; we don't surface them to the applicant since the application IS
  // accepted regardless of whether the email arrives.
  void sendTemplateEmailByTriggerForCampaign({
    trigger: 'campaign_application_confirmation',
    campaignId: camp.id,
    to: email,
    context: {
      firstName: escapeHtml(firstName),
      campaignName: escapeHtml(camp.name),
      brandName: config.email.brandName,
    },
  }).catch((err) => {
    log('warn', 'campaign confirmation email send failed', {
      campaignId: camp.id,
      memberId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Capacity check: atomically auto-closes the campaign if target_size has
  // been reached, and arms a one-shot capacity warning when the threshold is
  // crossed. The warning email is sent fire-and-forget; the auto-close is
  // already persisted by this point.
  const capacity = checkCapacityAndAutoClose(camp.id);
  if (capacity.autoClosed) {
    log('info', 'campaign auto-closed on target reached', {
      campaignId: camp.id,
      activeCount: capacity.activeCount,
      targetSize: camp.target_size,
    });
  }
  if (capacity.thresholdCrossed && camp.capacity_warning_threshold !== null) {
    void notifyOnCampaignCapacity({
      campaignId: camp.id,
      campaignName: camp.name,
      activeCount: capacity.activeCount,
      targetSize: camp.target_size,
      threshold: camp.capacity_warning_threshold,
    }).catch((err) => {
      log('warn', 'campaign capacity notification failed', {
        campaignId: camp.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return c.json({ ok: true });
});

// =========================================================================
// Campaign feedback forms — public read + submit
//
// Access via shared key in the URL. No customer login required (anonymous by
// design); optional name/email on submission.
// =========================================================================

const FEEDBACK_RATE_LIMIT = 20;       // per IP
const FEEDBACK_RATE_WINDOW_SEC = 60;

interface PublicFeedbackQuestion {
  id: number;
  type: FeedbackQuestionRow['type'];
  prompt: string;
  required: boolean;
  options: string[];
}

const publicQuestion = (q: FeedbackQuestionRow): PublicFeedbackQuestion => ({
  id: q.id,
  type: q.type,
  prompt: q.prompt,
  required: q.required === 1,
  options: parseQuestionOptions(q),
});

// GET /proxy/feedback/:key — returns the form schema. Used by the widget-
// embed-in-Shopify-Page path (the hosted landing at /feedback/:key uses its
// own server-rendered HTML, no widget JS).
proxy.get('/feedback/:key', (c) => {
  const key = c.req.param('key');
  const form = findFeedbackFormByAccessKey(key);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const questions = listFeedbackQuestionsForForm(form.id);
  return c.json({
    title: form.title,
    introText: form.intro_text,
    questions: questions.map(publicQuestion),
  });
});

// POST /proxy/feedback/:key — accepts a submitted response from the widget-
// embedded form (JSON body). The server-rendered landing at /feedback/:key
// has its own POST handler that accepts form-urlencoded.
proxy.post('/feedback/:key', async (c) => {
  const key = c.req.param('key');
  const ip = getClientIp(c);
  if (!rateLimitTake(`feedback-submit:${ip}`, FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_SEC)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const form = findFeedbackFormByAccessKey(key);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => null) as {
    optionalName?: string;
    optionalEmail?: string;
    answers?: Array<{ questionId?: number; value?: unknown }>;
  } | null;
  if (!body || typeof body !== 'object' || !Array.isArray(body.answers)) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  // Load questions once and key by id so we can validate per-answer.
  const questions = listFeedbackQuestionsForForm(form.id);
  const byId = new Map<number, FeedbackQuestionRow>();
  for (const q of questions) byId.set(q.id, q);

  const answers: Array<{
    questionId: number;
    valueText?: string | null;
    valueNumber?: number | null;
    valueJson?: string | null;
  }> = [];
  const answered = new Set<number>();

  for (const a of body.answers) {
    if (!a || typeof a !== 'object') continue;
    const qid = Number(a.questionId);
    const question = byId.get(qid);
    if (!question || !isFeedbackQuestionType(question.type)) continue;

    if (question.type === 'rating_1_5') {
      const n = Number(a.value);
      if (!Number.isFinite(n) || n < 1 || n > 5) {
        if (question.required === 1) return c.json({ error: 'invalid_rating', questionId: qid }, 400);
        continue;
      }
      answers.push({ questionId: qid, valueNumber: Math.round(n) });
      answered.add(qid);
    } else if (question.type === 'single_choice') {
      const v = typeof a.value === 'string' ? a.value : '';
      const valid = parseQuestionOptions(question).includes(v);
      if (!valid) {
        if (question.required === 1) return c.json({ error: 'invalid_choice', questionId: qid }, 400);
        continue;
      }
      answers.push({ questionId: qid, valueText: v });
      answered.add(qid);
    } else if (question.type === 'multi_choice') {
      const arr = Array.isArray(a.value) ? a.value.filter((x): x is string => typeof x === 'string') : [];
      const opts = new Set(parseQuestionOptions(question));
      const filtered = arr.filter((v) => opts.has(v));
      if (filtered.length === 0) {
        if (question.required === 1) return c.json({ error: 'missing_required', questionId: qid }, 400);
        continue;
      }
      answers.push({ questionId: qid, valueJson: JSON.stringify(filtered) });
      answered.add(qid);
    } else {
      // text types
      const s = typeof a.value === 'string' ? a.value.trim().slice(0, 5000) : '';
      if (!s) {
        if (question.required === 1) return c.json({ error: 'missing_required', questionId: qid }, 400);
        continue;
      }
      answers.push({ questionId: qid, valueText: s });
      answered.add(qid);
    }
  }

  // Final required-field check covers questions the body never mentioned at all.
  for (const q of questions) {
    if (q.required === 1 && !answered.has(q.id)) {
      return c.json({ error: 'missing_required', questionId: q.id }, 400);
    }
  }

  const optionalName = typeof body.optionalName === 'string' ? body.optionalName.trim().slice(0, 160) || null : null;
  const optionalEmail = typeof body.optionalEmail === 'string' ? body.optionalEmail.trim().toLowerCase().slice(0, 254) || null : null;

  const responseId = submitFeedbackResponse({
    formId: form.id,
    optionalName,
    optionalEmail,
    ipHash: hashIp(ip),
    answers,
  });

  log('info', 'feedback response submitted', { formId: form.id, responseId, answerCount: answers.length });
  return c.json({ ok: true });
});

export default proxy;
