import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findPurchaseById,
  findCustomerById,
  insertReview,
  recordReviewSubmitted,
  setGlobalOptOut,
  setProductOptOut,
  findReviewByCustomerAndProduct,
  findSampleInvitationById,
  consumeSampleInvitation,
  upsertCustomer,
} from '../db/queries.js';
import { verifyReviewToken, verifyUnsubscribeToken, verifySampleInviteToken } from '../email/tokens.js';
import { nowSec } from '../lib/time.js';
import { escapeHtml } from '../email/render.js';
import { log } from '../lib/logger.js';
import { getOrFetchProduct } from '../shopify/product-info.js';
import { sanitizeReviewText } from '../lib/profanity.js';
import { isReviewsPaused } from '../lib/panic.js';
import { notifyOnNewReview } from '../email/notify-new-review.js';
import { readUpload } from '../lib/uploads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// public/ is at the repo root locally and copied to /app/public/ in the
// container. From dist/routes/widget.js that's ../../public/.
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const widget = new Hono();

const longCacheHeaders = (res: Response): Response => {
  res.headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  return res;
};

widget.get('/widget.js', async (c) => {
  const file = path.join(PUBLIC_DIR, 'widget.js');
  if (!fs.existsSync(file)) return c.text('not built', 500);
  const body = fs.readFileSync(file, 'utf8');
  c.header('Content-Type', 'application/javascript; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  return c.body(body);
});

// Self-hosted uploaded assets (currently just the branding logo). Public and
// unauthenticated — the logo is referenced by <img src> in emails opened by
// anyone. nosniff + a known image content-type; long cache since filenames are
// content-unique (a new upload gets a new name).
widget.get('/uploads/:name', (c) => {
  const file = readUpload(c.req.param('name'));
  if (!file) return c.text('not found', 404);
  c.header('Content-Type', file.contentType);
  c.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(file.body);
});

// /widget.css is no longer served — styles are inlined into widget.js and
// injected at runtime so the storefront only needs the one <script> tag.

// --- Page shell ---

const pageShell = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background:#f6f6f6; color:#222; margin:0; padding:32px 16px; }
    .card { max-width: 560px; margin: 0 auto; background:#fff; border-radius:8px; padding:32px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
    h1 { font-size: 22px; margin: 0 0 16px; }
    label { display:block; margin-top: 16px; font-size: 14px; font-weight:600; }
    input[type=text], textarea, input[type=email] { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 4px; border:1px solid #ccc; border-radius: 4px; font-size: 15px; font-family: inherit; }
    textarea { min-height: 140px; resize: vertical; }
    .stars { font-size: 28px; user-select: none; }
    .stars input[type=radio] { display: none; }
    .stars label { display: inline-block; cursor: pointer; color: #ddd; transition: color 0.1s; margin: 0; }
    .stars label:hover, .stars label:hover ~ label, .stars input:checked ~ label { color: #f5a623; }
    /* CSS-only star highlight: reverse the radios so :checked ~ label hits earlier siblings */
    .stars { display: inline-flex; flex-direction: row-reverse; }
    button { margin-top: 24px; background: #222; color: #fff; border: none; border-radius: 6px; padding: 12px 24px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #000; }
    .muted { color: #888; font-size: 13px; }
    .err { background:#fee; border:1px solid #fcc; color:#933; padding:12px; border-radius:4px; margin-bottom:16px; }
    .ok  { background:#efe; border:1px solid #cdc; color:#363; padding:12px; border-radius:4px; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`;

// Rendered when the panic button is active. Same shell as the other
// reviewer-facing pages; non-alarming copy. Used by both the email-link and
// sample-invitation flows.
const pausedPage = (c: import('hono').Context) =>
  c.html(pageShell('Reviews temporarily unavailable', `
    <h1>Reviews are temporarily unavailable</h1>
    <p>We've temporarily paused new reviews for this store. Please try again later — your link will still work once reviews are back.</p>
  `), 503);

// --- /r/:token  — review submission page ---

const renderForm = (input: {
  token: string;
  productTitle: string;
  reviewerName: string;
  errorMessage?: string;
  prefillRating?: number;
  prefillTitle?: string;
  prefillBody?: string;
  prefillName?: string;
}): string => {
  const errBlock = input.errorMessage
    ? `<div class="err">${escapeHtml(input.errorMessage)}</div>`
    : '';
  const checked = (n: number) => (input.prefillRating === n ? ' checked' : '');
  // Reversed order so the row-reverse flex+CSS sibling-select trick works.
  const stars = [5, 4, 3, 2, 1]
    .map(
      (n) => `
        <input type="radio" id="r${n}" name="rating" value="${n}" required${checked(n)}>
        <label for="r${n}" title="${n} star${n === 1 ? '' : 's'}">★</label>`,
    )
    .join('');

  return pageShell(`Review your ${input.productTitle}`, `
    <h1>Tell us about your ${escapeHtml(input.productTitle)}</h1>
    <p class="muted">Hi ${escapeHtml(input.reviewerName)} — thanks for taking a moment.</p>
    ${errBlock}
    <form method="POST" action="/r/${encodeURIComponent(input.token)}" novalidate>
      <input type="hidden" name="token" value="${escapeHtml(input.token)}">

      <label>Rating</label>
      <div class="stars">${stars}</div>

      <label for="title">Title (optional)</label>
      <input id="title" type="text" name="title" maxlength="120" value="${escapeHtml(input.prefillTitle ?? '')}">

      <label for="body">Your review</label>
      <textarea id="body" name="body" required maxlength="4000">${escapeHtml(input.prefillBody ?? '')}</textarea>

      <label for="reviewerName">Display name (optional — defaults to your first name)</label>
      <input id="reviewerName" type="text" name="reviewerName" maxlength="80" value="${escapeHtml(input.prefillName ?? '')}">

      <button type="submit">Submit review</button>
      <p class="muted" style="margin-top:24px;">Your email won't be shown publicly. Reviews may be lightly edited for clarity.</p>
    </form>
  `);
};

widget.get('/r/:token', async (c) => {
  if (isReviewsPaused()) return pausedPage(c);
  const token = c.req.param('token');
  const verified = verifyReviewToken(token);
  if (!verified.ok) {
    return c.html(pageShell('Invalid link', `<h1>This link is no longer valid</h1><p class="muted">It may have expired or been used already. If you still want to leave a review, you can do so from the product page.</p>`), 410);
  }

  const purchase = findPurchaseById(verified.payload.purchaseId);
  if (!purchase || purchase.customer_id !== verified.payload.customerId) {
    return c.html(pageShell('Not found', `<h1>We couldn't find that order</h1>`), 404);
  }
  if (purchase.reviewed_at !== null) {
    return c.html(pageShell('Already reviewed', `<h1>You've already reviewed this</h1><p class="muted">Thanks again for your feedback.</p>`));
  }

  const customer = findCustomerById(verified.payload.customerId);
  if (!customer) return c.html(pageShell('Not found', `<h1>We couldn't find that customer</h1>`), 404);

  const product = await getOrFetchProduct(purchase.shopify_product_id);
  const productTitle = product?.title ?? 'your purchase';

  const reviewerName = customer.first_name?.trim() || 'there';

  return c.html(renderForm({ token, productTitle, reviewerName }));
});

const trimOrNull = (s: unknown, maxLen: number): string | null => {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim().slice(0, maxLen);
  return trimmed.length === 0 ? null : trimmed;
};

widget.post('/r/:token', async (c) => {
  if (isReviewsPaused()) return pausedPage(c);
  const token = c.req.param('token');
  const verified = verifyReviewToken(token);
  if (!verified.ok) {
    return c.html(pageShell('Invalid link', `<h1>This link is no longer valid</h1>`), 410);
  }

  const purchase = findPurchaseById(verified.payload.purchaseId);
  if (!purchase || purchase.customer_id !== verified.payload.customerId) {
    return c.html(pageShell('Not found', `<h1>We couldn't find that order</h1>`), 404);
  }
  if (purchase.reviewed_at !== null) {
    return c.html(pageShell('Already reviewed', `<h1>You've already reviewed this</h1>`));
  }

  const customer = findCustomerById(verified.payload.customerId);
  if (!customer) return c.html(pageShell('Not found', `<h1>We couldn't find that customer</h1>`), 404);

  const formData = await c.req.formData();
  const rating = Number(formData.get('rating'));
  const title = trimOrNull(formData.get('title'), 120);
  const body = trimOrNull(formData.get('body'), 4000);
  const submittedName = trimOrNull(formData.get('reviewerName'), 80);

  const product = await getOrFetchProduct(purchase.shopify_product_id);
  const productTitle = product?.title ?? 'your purchase';
  const reviewerName = customer.first_name?.trim() || 'there';

  const renderError = (msg: string) =>
    c.html(renderForm({
      token,
      productTitle,
      reviewerName,
      errorMessage: msg,
      prefillRating: Number.isFinite(rating) ? rating : undefined,
      prefillTitle: title ?? '',
      prefillBody: body ?? '',
      prefillName: submittedName ?? '',
    }), 400);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return renderError('Please pick a rating from 1 to 5 stars.');
  }
  if (!body) {
    return renderError('Please write a few words about your experience.');
  }

  // If this customer has already reviewed this product (a different order's
  // purchase landed in their inbox before this one), don't insert a duplicate.
  // Mark this purchase as reviewed and show the normal thank-you page so the
  // customer experience stays clean.
  const existingReview = findReviewByCustomerAndProduct(customer.id, purchase.shopify_product_id);
  if (existingReview) {
    recordReviewSubmitted({ purchaseId: purchase.id, customerId: customer.id });
    log('info', 'duplicate review suppressed, purchase marked reviewed', {
      purchaseId: purchase.id,
      customerId: customer.id,
      existingReviewId: existingReview.id,
      productId: purchase.shopify_product_id,
    });
    return c.html(pageShell('Thank you', `
      <h1>Thank you</h1>
      <div class="ok">Your review for <strong>${escapeHtml(productTitle)}</strong> has been submitted.</div>
      <p class="muted" style="margin-top:24px;">It may take a moment to appear on the product page.</p>
    `));
  }

  // Default display name: first name only (privacy-friendly). If the customer
  // wants something different shown publicly, they fill in the "Display name"
  // field on the form and that submittedName overrides this fallback.
  const fallbackName = customer.first_name?.trim() || null;

  const censored = sanitizeReviewText({ title, body });

  const reviewId = insertReview({
    shopifyProductId: purchase.shopify_product_id,
    shopifyVariantId: purchase.shopify_variant_id,
    customerId: customer.id,
    reviewerEmail: customer.email,
    reviewerName: submittedName ?? fallbackName,
    rating,
    title: censored.title,
    body: censored.body,
    titleOriginal: title,
    bodyOriginal: body,
    verifiedKind: 'purchase',
    status: 'published',
  });

  recordReviewSubmitted({ purchaseId: purchase.id, customerId: customer.id });

  log('info', 'review submitted via /r/:token', {
    reviewId,
    purchaseId: purchase.id,
    customerId: customer.id,
    rating,
    productId: purchase.shopify_product_id,
  });

  void notifyOnNewReview({ reviewId, rating });

  return c.html(pageShell('Thank you', `
    <h1>Thank you</h1>
    <div class="ok">Your review for <strong>${escapeHtml(productTitle)}</strong> has been submitted.</div>
    <p class="muted" style="margin-top:24px;">It may take a moment to appear on the product page.</p>
  `));
});

// --- /r/invite/:token — sample-invitation review form ---

const renderInviteForm = (input: {
  token: string;
  productTitle: string;
  intendedName: string | null;
  intendedEmail: string | null;
  errorMessage?: string;
  prefillRating?: number;
  prefillTitle?: string;
  prefillBody?: string;
  prefillName?: string;
  prefillEmail?: string;
}): string => {
  const errBlock = input.errorMessage
    ? `<div class="err">${escapeHtml(input.errorMessage)}</div>`
    : '';
  const checked = (n: number) => (input.prefillRating === n ? ' checked' : '');
  const stars = [5, 4, 3, 2, 1]
    .map(
      (n) => `
        <input type="radio" id="r${n}" name="rating" value="${n}" required${checked(n)}>
        <label for="r${n}" title="${n} star${n === 1 ? '' : 's'}">★</label>`,
    )
    .join('');

  const greeting = input.intendedName
    ? `Hi ${escapeHtml(input.intendedName.split(/\s+/)[0] ?? input.intendedName)} — thanks for trying ${escapeHtml(input.productTitle)}.`
    : `Thanks for trying ${escapeHtml(input.productTitle)}.`;

  return pageShell(`Review your ${input.productTitle}`, `
    <h1>Tell us what you thought of ${escapeHtml(input.productTitle)}</h1>
    <p class="muted">${greeting}</p>
    ${errBlock}
    <form method="POST" action="/r/invite/${encodeURIComponent(input.token)}" novalidate>
      <input type="hidden" name="token" value="${escapeHtml(input.token)}">

      <label>Rating</label>
      <div class="stars">${stars}</div>

      <label for="title">Title (optional)</label>
      <input id="title" type="text" name="title" maxlength="120" value="${escapeHtml(input.prefillTitle ?? '')}">

      <label for="body">Your review</label>
      <textarea id="body" name="body" required maxlength="4000">${escapeHtml(input.prefillBody ?? '')}</textarea>

      <label for="reviewerName">Your name</label>
      <input id="reviewerName" type="text" name="reviewerName" required maxlength="80" value="${escapeHtml(input.prefillName ?? input.intendedName ?? '')}">

      <label for="reviewerEmail">Your email</label>
      <input id="reviewerEmail" type="email" name="reviewerEmail" required maxlength="200" value="${escapeHtml(input.prefillEmail ?? input.intendedEmail ?? '')}">

      <button type="submit">Submit review</button>
      <p class="muted" style="margin-top:24px;">Your email won't be shown publicly. Only your first name appears alongside your review. Reviews may be lightly edited for clarity.</p>
    </form>
  `);
};

// Centralizes the validation for both GET (display form) and POST (handle
// submission) of sample-invitation links. Returns either an error response
// to render directly or the resolved invitation/product context.
const resolveInvitation = async (
  c: import('hono').Context,
  token: string,
): Promise<
  | { ok: true; invitationId: number; productId: string; productTitle: string }
  | { ok: false; response: Response }
> => {
  const verified = verifySampleInviteToken(token);
  if (!verified.ok) {
    return {
      ok: false,
      response: c.html(pageShell('Invalid link', `<h1>This invitation link is no longer valid</h1><p class="muted">It may have expired, or the signature didn't match. If you think you should still be able to leave a review, get in touch with us.</p>`), 410),
    };
  }
  const invitation = findSampleInvitationById(verified.payload.invitationId);
  if (!invitation) {
    return {
      ok: false,
      response: c.html(pageShell('Not found', `<h1>We couldn't find that invitation</h1>`), 404),
    };
  }
  if (invitation.shopify_product_id !== verified.payload.productId) {
    return {
      ok: false,
      response: c.html(pageShell('Invalid link', `<h1>This link doesn't match a known product</h1>`), 400),
    };
  }
  if (invitation.consumed_at !== null) {
    return {
      ok: false,
      response: c.html(pageShell('Already used', `<h1>This invitation has already been used</h1><p class="muted">Thanks for your review.</p>`)),
    };
  }
  if (invitation.expires_at <= nowSec()) {
    return {
      ok: false,
      response: c.html(pageShell('Expired', `<h1>This invitation has expired</h1><p class="muted">Get in touch with us if you'd still like to leave a review.</p>`), 410),
    };
  }

  const product = await getOrFetchProduct(invitation.shopify_product_id);
  const productTitle = product?.title ?? 'the product you tried';
  return { ok: true, invitationId: invitation.id, productId: invitation.shopify_product_id, productTitle };
};

widget.get('/r/invite/:token', async (c) => {
  if (isReviewsPaused()) return pausedPage(c);
  const token = c.req.param('token');
  const resolved = await resolveInvitation(c, token);
  if (!resolved.ok) return resolved.response;

  const invitation = findSampleInvitationById(resolved.invitationId)!;
  return c.html(renderInviteForm({
    token,
    productTitle: resolved.productTitle,
    intendedName: invitation.intended_name,
    intendedEmail: invitation.intended_email,
  }));
});

widget.post('/r/invite/:token', async (c) => {
  if (isReviewsPaused()) return pausedPage(c);
  const token = c.req.param('token');
  const resolved = await resolveInvitation(c, token);
  if (!resolved.ok) return resolved.response;

  const invitation = findSampleInvitationById(resolved.invitationId)!;
  const formData = await c.req.formData();
  const rating = Number(formData.get('rating'));
  const title = trimOrNull(formData.get('title'), 120);
  const body = trimOrNull(formData.get('body'), 4000);
  const submittedName = trimOrNull(formData.get('reviewerName'), 80);
  const submittedEmail = trimOrNull(formData.get('reviewerEmail'), 200);

  const renderError = (msg: string) =>
    c.html(renderInviteForm({
      token,
      productTitle: resolved.productTitle,
      intendedName: invitation.intended_name,
      intendedEmail: invitation.intended_email,
      errorMessage: msg,
      prefillRating: Number.isFinite(rating) ? rating : undefined,
      prefillTitle: title ?? '',
      prefillBody: body ?? '',
      prefillName: submittedName ?? '',
      prefillEmail: submittedEmail ?? '',
    }), 400);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return renderError('Please pick a rating from 1 to 5 stars.');
  }
  if (!body) {
    return renderError('Please write a few words about your experience.');
  }
  if (!submittedName) {
    return renderError('Please tell us your name.');
  }
  if (!submittedEmail || !/^.+@.+\..+$/.test(submittedEmail)) {
    return renderError('Please provide a valid email address.');
  }

  // Upsert by email. If the reviewer later becomes a Shopify customer with
  // the same email, the webhook-driven upsertCustomer will fill in
  // shopify_customer_id on this same row — preserving the link from the
  // sample review to the eventual customer record.
  const customer = upsertCustomer({
    shopifyCustomerId: null,
    email: submittedEmail,
    firstName: submittedName.split(/\s+/)[0] ?? null,
    lastName: submittedName.split(/\s+/).slice(1).join(' ') || null,
  });

  // If this customer has already reviewed this product (e.g., the same
  // invitation was reused via a different link), don't insert a duplicate;
  // just mark the invitation consumed against the existing review.
  const existingReview = findReviewByCustomerAndProduct(customer.id, invitation.shopify_product_id);
  if (existingReview) {
    consumeSampleInvitation({ invitationId: invitation.id, reviewId: existingReview.id });
    log('info', 'sample invitation: duplicate review suppressed', {
      invitationId: invitation.id,
      customerId: customer.id,
      existingReviewId: existingReview.id,
    });
    return c.html(pageShell('Thank you', `
      <h1>Thank you</h1>
      <div class="ok">Your review for <strong>${escapeHtml(resolved.productTitle)}</strong> has been recorded.</div>
    `));
  }

  // First-name-only as the display name. Same rule as the email-link flow.
  const displayName = submittedName.split(/\s+/)[0] ?? submittedName;

  const censored = sanitizeReviewText({ title, body });

  const reviewId = insertReview({
    shopifyProductId: invitation.shopify_product_id,
    shopifyVariantId: null,
    customerId: customer.id,
    reviewerEmail: customer.email,
    reviewerName: displayName,
    rating,
    title: censored.title,
    body: censored.body,
    titleOriginal: title,
    bodyOriginal: body,
    verifiedKind: 'sample',
    status: 'published',
  });

  consumeSampleInvitation({ invitationId: invitation.id, reviewId });

  log('info', 'sample review submitted', {
    reviewId,
    invitationId: invitation.id,
    customerId: customer.id,
    rating,
    productId: invitation.shopify_product_id,
  });

  void notifyOnNewReview({ reviewId, rating });

  return c.html(pageShell('Thank you', `
    <h1>Thank you</h1>
    <div class="ok">Your review for <strong>${escapeHtml(resolved.productTitle)}</strong> has been submitted.</div>
    <p class="muted" style="margin-top:24px;">It may take a moment to appear on the product page.</p>
  `));
});

// --- Unsubscribe handlers ---

const handleUnsub = (c: import('hono').Context, scope: 'global' | 'product') => {
  const token = c.req.query('token');
  if (!token) return c.html(pageShell('Missing token', `<h1>Missing token</h1>`), 400);

  const verified = verifyUnsubscribeToken(token);
  if (!verified.ok) {
    return c.html(pageShell('Invalid link', `<h1>This unsubscribe link is no longer valid</h1>`), 410);
  }
  const payload = verified.payload;
  if (payload.kind !== scope) {
    return c.html(pageShell('Wrong link', `<h1>This link is for a different unsubscribe action</h1>`), 400);
  }

  if (scope === 'global') {
    setGlobalOptOut(payload.customerId);
    log('info', 'global unsubscribe applied', { customerId: payload.customerId });
    return c.html(pageShell('Unsubscribed', `
      <h1>You've been unsubscribed</h1>
      <p>We won't send you any more review requests. Thanks for letting us know.</p>
    `));
  }

  if (!payload.purchaseId) {
    return c.html(pageShell('Invalid link', `<h1>Missing purchase reference</h1>`), 400);
  }
  setProductOptOut(payload.purchaseId, payload.customerId);
  log('info', 'product unsubscribe applied', {
    customerId: payload.customerId,
    purchaseId: payload.purchaseId,
  });
  return c.html(pageShell('Unsubscribed from this product', `
    <h1>Got it</h1>
    <p>We won't ask you about this purchase again. You may still receive review requests for other products.</p>
  `));
};

widget.get('/unsubscribe', (c) => handleUnsub(c, 'global'));
widget.post('/unsubscribe', (c) => handleUnsub(c, 'global'));
widget.get('/unsubscribe/product', (c) => handleUnsub(c, 'product'));
widget.post('/unsubscribe/product', (c) => handleUnsub(c, 'product'));

// Long-cache helper kept available for any future static asset endpoints.
void longCacheHeaders;

export default widget;
