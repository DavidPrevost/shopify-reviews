// Optional admin notification email fired when a new review is submitted.
// Configured via three settings on the admin Settings page:
//
//   new_review_notify_enabled    — '1' / '0' master toggle
//   new_review_notify_email      — recipient address (typically the merchant)
//   new_review_notify_ratings    — CSV of star ratings that trigger (e.g.
//                                  '1,2,3' to only get notified about 1-3
//                                  star reviews, or '1,2,3,4,5' for all)
//
// Failures are logged and swallowed — the notification is operational, not
// load-bearing. A bad email config shouldn't block a customer's review from
// being recorded.

import { getSetting, setSetting, findReviewById } from '../db/queries.js';
import { sendMail } from './smtp-client.js';
import { getOrFetchProduct } from '../shopify/product-info.js';
import { config } from '../config.js';
import { escapeHtml } from './render.js';
import { log } from '../lib/logger.js';

const SETTING_ENABLED = 'new_review_notify_enabled';
const SETTING_EMAIL = 'new_review_notify_email';
const SETTING_RATINGS = 'new_review_notify_ratings';

export interface NotifyConfig {
  enabled: boolean;
  email: string;
  ratings: number[];
}

const parseRatings = (raw: string | null): number[] => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
};

export const getNewReviewNotifyConfig = (): NotifyConfig => ({
  enabled: getSetting(SETTING_ENABLED) === '1',
  email: getSetting(SETTING_EMAIL) ?? '',
  ratings: parseRatings(getSetting(SETTING_RATINGS)),
});

export const setNewReviewNotifyConfig = (input: NotifyConfig): void => {
  setSetting(SETTING_ENABLED, input.enabled ? '1' : '0');
  setSetting(SETTING_EMAIL, input.email.trim());
  // Dedupe + sort so the stored value is canonical regardless of input order.
  const ratings = Array.from(new Set(input.ratings.filter((n) => n >= 1 && n <= 5))).sort();
  setSetting(SETTING_RATINGS, ratings.join(','));
};

export const notifyOnNewReview = async (input: {
  reviewId: number;
  rating: number;
}): Promise<void> => {
  const cfg = getNewReviewNotifyConfig();
  if (!cfg.enabled || !cfg.email || cfg.ratings.length === 0) return;
  if (!cfg.ratings.includes(input.rating)) return;

  const review = findReviewById(input.reviewId);
  if (!review) {
    log('warn', 'notifyOnNewReview: review not found', { reviewId: input.reviewId });
    return;
  }

  let productTitle = review.shopify_product_id;
  try {
    const product = await getOrFetchProduct(review.shopify_product_id);
    if (product?.title) productTitle = product.title;
  } catch (err) {
    // Product lookup failing isn't fatal — fall back to the bare product id.
    log('warn', 'notifyOnNewReview: product lookup failed', {
      reviewId: input.reviewId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const subject = `[${config.email.brandName}] New ${input.rating}-star review on ${productTitle}`;
  const adminUrl = `${config.publicUrl.replace(/\/+$/, '')}/admin/reviews/${review.id}`;
  const reviewerLabel = review.reviewer_name?.trim()
    ? `${review.reviewer_name} (${review.reviewer_email})`
    : review.reviewer_email;
  const verifiedTag = review.verified_kind === 'purchase' ? ' [Verified Buyer]'
    : review.verified_kind === 'sample' ? ' [Verified Reviewer]'
    : '';

  const textBody = [
    `New review on ${productTitle}`,
    '',
    `Rating: ${'★'.repeat(input.rating)}${'☆'.repeat(5 - input.rating)} (${input.rating}/5)`,
    `Reviewer: ${reviewerLabel}${verifiedTag}`,
    '',
    review.title ? `Title: ${review.title}` : '',
    '',
    review.body,
    '',
    '---',
    `Open in admin: ${adminUrl}`,
  ].filter(Boolean).join('\n');

  const html = `
<p><strong>New review on ${escapeHtml(productTitle)}</strong></p>
<p>Rating: ${'★'.repeat(input.rating)}${'☆'.repeat(5 - input.rating)} (${input.rating}/5)<br>
Reviewer: ${escapeHtml(reviewerLabel)}${escapeHtml(verifiedTag)}</p>
${review.title ? `<p><strong>${escapeHtml(review.title)}</strong></p>` : ''}
<p style="white-space:pre-wrap;background:#f6f6f6;padding:12px;border-radius:4px;">${escapeHtml(review.body)}</p>
<p><a href="${adminUrl}">Open in admin</a></p>
  `.trim();

  try {
    await sendMail({ to: cfg.email, subject, html, text: textBody });
    log('info', 'new-review notification sent', { reviewId: review.id, rating: input.rating, to: cfg.email });
  } catch (err) {
    log('error', 'new-review notification failed', {
      reviewId: review.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

