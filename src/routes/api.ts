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
  type ReviewRow,
} from '../db/queries.js';
import { verifyReviewToken } from '../email/tokens.js';
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

api.get('/products/:productId/reviews', (c) => {
  const productId = c.req.param('productId');
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const size = Math.min(50, Math.max(1, Number(c.req.query('size') ?? '20')));

  const reviews = listPublishedReviewsForProduct(productId, page, size).map(reviewToPublic);
  const aggregate = getProductAggregate(productId);

  return c.json({ reviews, aggregate, page, size });
});

api.get('/products/:productId/aggregate', (c) => {
  const productId = c.req.param('productId');
  return c.json(getProductAggregate(productId));
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

  const reviewId = insertReview({
    shopifyProductId: purchase.shopify_product_id,
    shopifyVariantId: purchase.shopify_variant_id,
    customerId,
    reviewerEmail: customer.email,
    reviewerName: submittedName ?? fallbackName,
    rating,
    title,
    body: reviewBody,
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

  return c.json({ ok: true, reviewId });
});

export default api;
