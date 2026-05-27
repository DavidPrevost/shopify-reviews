import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from '../config.js';
import {
  listPublishedReviewsForProduct,
  getProductAggregate,
  insertReview,
  recordReviewSubmitted,
  findPurchaseById,
  findCustomerById,
  findReviewByCustomerAndProduct,
  findReviewById,
  insertReviewReport,
  isReporterBanned,
  isReportReason,
  type ReviewRow,
} from '../db/queries.js';
import { verifyReviewToken } from '../email/tokens.js';
import { getOrFetchProduct } from '../shopify/product-info.js';
import { resolveWidgetConfig } from '../shopify/widget-config.js';
import { sanitizeReviewText } from '../lib/profanity.js';
import { isReviewsPaused } from '../lib/panic.js';
import { notifyOnNewReview } from '../email/notify-new-review.js';
import { log } from '../lib/logger.js';

const api = new Hono();

api.use('*', cors({
  origin: config.storefrontOrigin,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 600,
}));

const reviewToPublic = (r: ReviewRow) => ({
  id: r.id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  reviewerName: r.reviewer_name,
  // verifiedKind: 'purchase' → Verified Buyer; 'sample' → Verified Reviewer;
  // null → no badge. verifiedPurchase remains for backward-compat callers.
  verifiedKind: r.verified_kind,
  verifiedPurchase: r.verified_purchase === 1,
  createdAt: r.created_at,
});

api.get('/products/:productId/reviews', async (c) => {
  // When paused, return empty + a paused flag so the widget can render its
  // "temporarily unavailable" notice instead of reviews. Aggregate is also
  // suppressed — the spec is "pause all review display."
  if (isReviewsPaused()) {
    return c.json({
      reviews: [],
      aggregate: { avg: null, count: 0 },
      related: null,
      variantHandling: 'shared',
      page: 1,
      size: 0,
      paused: true,
    });
  }

  const productId = c.req.param('productId');
  const variantId = c.req.query('variant') || null;
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const size = Math.min(50, Math.max(1, Number(c.req.query('size') ?? '20')));

  // Resolve per-product variant handling from Shopify metafield (cached in
  // products_cache). When 'distinct' AND we have a variant in scope, the
  // main review list is filtered to that variant and a "related" section
  // surfaces reviews from sibling variants. Otherwise (shared, or no variant
  // context), behave exactly as before — one product-wide review pool.
  const product = await getOrFetchProduct(productId);
  const variantHandling = product?.variantHandling ?? 'shared';
  const useDistinct = variantHandling === 'distinct' && !!variantId;

  if (useDistinct) {
    const reviews = listPublishedReviewsForProduct(productId, page, size, {
      variantId: variantId!,
    }).map(reviewToPublic);
    const aggregate = getProductAggregate(productId, { variantId: variantId! });
    const relatedReviews = listPublishedReviewsForProduct(productId, 1, 5, {
      excludeVariantId: variantId!,
    }).map(reviewToPublic);
    const relatedAggregate = getProductAggregate(productId, {
      excludeVariantId: variantId!,
    });
    return c.json({
      reviews,
      aggregate,
      related: { reviews: relatedReviews, aggregate: relatedAggregate },
      variantHandling,
      page,
      size,
    });
  }

  const reviews = listPublishedReviewsForProduct(productId, page, size).map(reviewToPublic);
  const aggregate = getProductAggregate(productId);
  return c.json({ reviews, aggregate, related: null, variantHandling, page, size });
});

// Aggregate is always product-wide regardless of variant_handling — used by
// collection-card placeholders where the customer hasn't picked a variant
// yet and "this product overall" is the right framing.
api.get('/products/:productId/aggregate', (c) => {
  if (isReviewsPaused()) {
    return c.json({ avg: null, count: 0, paused: true });
  }
  const productId = c.req.param('productId');
  return c.json(getProductAggregate(productId));
});

// Visual config the widget applies on init. Fully resolved: each field is a
// concrete value (override → Shopify default → hardcoded fallback). Cached
// for 5 minutes — config changes propagate within that window. No customer
// data so safe to cache shared.
api.get('/widget/config', (c) => {
  c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  return c.json(resolveWidgetConfig());
});

interface SubmitBody {
  token?: string;
  rating?: number;
  title?: string;
  body?: string;
  reviewerName?: string;
}

const MAX_TITLE_LEN = 120;
const MAX_BODY_LEN = 4000;
const MAX_NAME_LEN = 80;

const trimOrNull = (s: unknown, maxLen: number): string | null => {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().slice(0, maxLen);
  return trimmed.length === 0 ? null : trimmed;
};

api.post('/reviews/submit', async (c) => {
  if (isReviewsPaused()) {
    return c.json({ error: 'reviews_paused' }, 503);
  }
  let body: SubmitBody;
  try {
    body = await c.req.json<SubmitBody>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.token) return c.json({ error: 'token_required' }, 400);
  const verified = verifyReviewToken(body.token);
  if (!verified.ok) return c.json({ error: `token_${verified.reason}` }, 401);

  const { purchaseId, customerId } = verified.payload;
  const purchase = findPurchaseById(purchaseId);
  if (!purchase || purchase.customer_id !== customerId) {
    return c.json({ error: 'purchase_not_found' }, 404);
  }
  if (purchase.reviewed_at !== null) {
    return c.json({ error: 'already_reviewed' }, 409);
  }

  const customer = findCustomerById(customerId);
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ error: 'rating_invalid' }, 400);
  }

  const reviewBody = trimOrNull(body.body, MAX_BODY_LEN);
  if (!reviewBody) return c.json({ error: 'body_required' }, 400);

  const title = trimOrNull(body.title, MAX_TITLE_LEN);
  const submittedName = trimOrNull(body.reviewerName, MAX_NAME_LEN);
  // Default display name: first name only (privacy-friendly). If the client
  // sent a reviewerName field, that overrides this fallback.
  const fallbackName = customer.first_name?.trim() || null;

  // If the customer already reviewed this product (any prior order), don't
  // insert a duplicate review row — mark this purchase as reviewed and return
  // the same success response so the experience is identical from the client's
  // perspective.
  const existingReview = findReviewByCustomerAndProduct(customerId, purchase.shopify_product_id);
  if (existingReview) {
    recordReviewSubmitted({ purchaseId, customerId });
    log('info', 'duplicate review suppressed, purchase marked reviewed', {
      purchaseId,
      customerId,
      existingReviewId: existingReview.id,
      productId: purchase.shopify_product_id,
    });
    return c.json({ ok: true, reviewId: existingReview.id, duplicate: true });
  }

  const censored = sanitizeReviewText({ title, body: reviewBody });

  const reviewId = insertReview({
    shopifyProductId: purchase.shopify_product_id,
    shopifyVariantId: purchase.shopify_variant_id,
    customerId,
    reviewerEmail: customer.email,
    reviewerName: submittedName ?? fallbackName,
    rating,
    title: censored.title,
    body: censored.body,
    titleOriginal: title,
    bodyOriginal: reviewBody,
    verifiedKind: 'purchase',
    status: 'published',
  });

  recordReviewSubmitted({ purchaseId, customerId });

  log('info', 'review submitted', {
    reviewId,
    purchaseId,
    customerId,
    rating,
    productId: purchase.shopify_product_id,
  });

  // Optional admin notification. Fire-and-forget — the response shouldn't
  // wait on SMTP, and the function logs its own errors.
  void notifyOnNewReview({ reviewId, rating });

  return c.json({ ok: true, reviewId });
});

// --- Report a review (storefront flag-this-review flow) ---
//
// Public + CORS-allowed. Captures IP for dedupe (one open report per IP per
// review). Reporter email is optional; when provided and the address is on
// the banned_reporters list, the request returns 200 with no DB write — the
// reporter shouldn't get a signal that they're banned.

const MAX_REPORT_MESSAGE = 1000;

api.post('/reviews/:id/report', async (c) => {
  const reviewId = Number(c.req.param('id'));
  if (!Number.isInteger(reviewId) || reviewId <= 0) {
    return c.json({ error: 'invalid_review_id' }, 400);
  }
  const review = findReviewById(reviewId);
  if (!review || review.status !== 'published') {
    // Don't reveal whether a non-published review exists. Silent success.
    return c.json({ ok: true });
  }

  let body: { reason?: string; message?: string; email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const reasonRaw = String(body.reason ?? '').trim();
  if (!isReportReason(reasonRaw)) {
    return c.json({ error: 'invalid_reason' }, 400);
  }
  const message = trimOrNull(body.message, MAX_REPORT_MESSAGE);
  const reporterEmail = trimOrNull(body.email, 200);

  if (reporterEmail && isReporterBanned(reporterEmail)) {
    // Silently accept. No DB write.
    log('info', 'report from banned reporter dropped', {
      reviewId,
      reporterEmail,
    });
    return c.json({ ok: true });
  }

  // Best-effort IP capture. Behind the Caddy/GCP relay we'll see the relay's
  // IP unless the X-Forwarded-For header is set; in the dev environment it'll
  // be a localhost address. Used for dedupe only, not for blocking, so an
  // imperfect value is fine.
  const reporterIp =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null;

  const reportId = insertReviewReport({
    reviewId,
    reason: reasonRaw,
    message,
    reporterEmail,
    reporterIp,
  });

  log('info', reportId ? 'review reported' : 'review report deduped', {
    reviewId,
    reportId,
    reason: reasonRaw,
    hasMessage: message !== null,
    hasReporterEmail: reporterEmail !== null,
  });

  return c.json({ ok: true });
});

export default api;
