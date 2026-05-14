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

import { Hono } from 'hono';
import {
  findCustomerByShopifyId,
  findReviewByCustomerAndProduct,
  findReviewById,
  insertReview,
  updateReviewContent,
  customerHasPurchasedProduct,
  upsertCustomer,
  type ReviewRow,
} from '../db/queries.js';
import { verifyAppProxySignature } from '../shopify/app-proxy-verify.js';
import { fetchShopifyCustomer } from '../shopify/customer-info.js';
import { log } from '../lib/logger.js';

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
  // App Proxy still forwards requests for non-logged-in storefront visitors.
  // We require an actual customer for every endpoint in this file, so reject
  // here with a clear-enough signal for the widget to handle (anonymous
  // visitors are shown a "log in to review" affordance, not the form).
  if (!verified.loggedInCustomerId) {
    return c.json({ error: 'not_logged_in' }, 401);
  }
  c.set('customerShopifyId' as never, verified.loggedInCustomerId as never);
  // App Proxy responses must not be cached by Shopify's edge — per-customer
  // data and write responses are dynamic.
  c.header('Cache-Control', 'no-store');
  await next();
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

  const reviewId = insertReview({
    shopifyProductId: productId,
    shopifyVariantId: variantId,
    customerId: customer.id,
    reviewerEmail: customer.email,
    reviewerName: displayName,
    rating,
    title,
    body: reviewBody,
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

  return c.json({ ok: true, reviewId });
});

// Edit an existing review. Only the rating, title, body, and reviewer_name
// are updateable; the customer can't change verified status, the linked
// product/variant, or the customer association.
proxy.post('/customer/review/:id', async (c) => {
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

  updateReviewContent({
    id: reviewId,
    rating,
    title,
    body: reviewBody,
    reviewerName: displayName,
  });

  log('info', 'storefront customer edited review', {
    reviewId,
    customerId: customer.id,
  });

  return c.json({ ok: true, reviewId });
});

export default proxy;
