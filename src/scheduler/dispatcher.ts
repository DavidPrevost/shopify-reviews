import { config, assertRequired } from '../config.js';
import {
  findEligiblePurchases,
  customerHasAnyReviews,
  recordRequestSent,
  logEmailFailure,
  getSettingNumber,
  type EligibleRow,
} from '../db/queries.js';
import { renderTemplate, escapeHtml } from '../email/render.js';
import { sendMail } from '../email/smtp-client.js';
import { signReviewToken, signUnsubscribeToken } from '../email/tokens.js';
import { log } from '../lib/logger.js';
import { getOrFetchProduct } from '../shopify/product-info.js';

export interface DispatchResult {
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
}

const buildReviewUrl = (token: string): string =>
  `${config.publicUrl.replace(/\/+$/, '')}/r/${encodeURIComponent(token)}`;

const buildUnsubGlobalUrl = (token: string): string =>
  `${config.publicUrl.replace(/\/+$/, '')}/unsubscribe?token=${encodeURIComponent(token)}`;

const buildUnsubProductUrl = (token: string): string =>
  `${config.publicUrl.replace(/\/+$/, '')}/unsubscribe/product?token=${encodeURIComponent(token)}`;

const renderPlainText = (input: {
  firstName: string;
  brandName: string;
  productTitle: string;
  reviewUrl: string;
  unsubGlobalUrl: string;
  unsubProductUrl: string;
  isRepeat: boolean;
}): string => {
  const opening = input.isRepeat
    ? `Thanks again for being a returning customer of ${input.brandName}.`
    : `Thanks for your recent order from ${input.brandName}.`;
  return [
    `Hi ${input.firstName},`,
    '',
    opening,
    '',
    `Now that you've had some time with your ${input.productTitle}, would you share a quick review?`,
    '',
    `Leave a review: ${input.reviewUrl}`,
    '',
    '---',
    `Don't ask about this product: ${input.unsubProductUrl}`,
    `Unsubscribe from all review requests: ${input.unsubGlobalUrl}`,
  ].join('\n');
};

const buildSubject = (productTitle: string, isRepeat: boolean): string =>
  isRepeat
    ? `One more review for ${productTitle}?`
    : `How was your ${productTitle}?`;

// Process one row: lookup product info, sign tokens, render, send, and on
// success record state. Returns 'sent' | 'failed' | 'skipped'.
const dispatchOne = async (row: EligibleRow): Promise<'sent' | 'failed' | 'skipped'> => {
  const product = await getOrFetchProduct(row.p_shopify_product_id);
  if (!product) {
    log('warn', 'dispatch skipped: product not found on Shopify', {
      purchaseId: row.p_id,
      shopifyProductId: row.p_shopify_product_id,
    });
    return 'skipped';
  }

  const isRepeat = customerHasAnyReviews(row.c_id);
  const firstName = row.c_first_name?.trim() || 'there';

  const reviewToken = signReviewToken({ purchaseId: row.p_id, customerId: row.c_id });
  const unsubGlobalToken = signUnsubscribeToken({ customerId: row.c_id, kind: 'global' });
  const unsubProductToken = signUnsubscribeToken({
    customerId: row.c_id,
    kind: 'product',
    purchaseId: row.p_id,
  });

  const reviewUrl = buildReviewUrl(reviewToken);
  const unsubGlobalUrl = buildUnsubGlobalUrl(unsubGlobalToken);
  const unsubProductUrl = buildUnsubProductUrl(unsubProductToken);

  const ctx = {
    firstName: escapeHtml(firstName),
    brandName: escapeHtml(config.email.brandName),
    productTitle: escapeHtml(product.title),
    reviewUrl,
    unsubGlobalUrl,
    unsubProductUrl,
  };

  const html = renderTemplate(isRepeat ? 'request-repeat.html' : 'request-first.html', ctx);
  const text = renderPlainText({
    firstName,
    brandName: config.email.brandName,
    productTitle: product.title,
    reviewUrl,
    unsubGlobalUrl,
    unsubProductUrl,
    isRepeat,
  });
  const subject = buildSubject(product.title, isRepeat);

  try {
    await sendMail({
      to: row.c_email,
      subject,
      html,
      text,
      headers: {
        // RFC 8058 one-click unsubscribe — gives mailbox providers a clean
        // signal and improves deliverability reputation.
        'List-Unsubscribe': `<${unsubGlobalUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'dispatch send failed', {
      purchaseId: row.p_id,
      customerId: row.c_id,
      error: message,
    });
    logEmailFailure({ customerId: row.c_id, purchaseId: row.p_id, error: message });
    return 'failed';
  }

  recordRequestSent({
    purchaseId: row.p_id,
    customerId: row.c_id,
    metadata: { template: isRepeat ? 'repeat' : 'first', productTitle: product.title },
  });
  log('info', 'dispatch sent', {
    purchaseId: row.p_id,
    customerId: row.c_id,
    template: isRepeat ? 'repeat' : 'first',
  });
  return 'sent';
};

export const runDispatcher = async (): Promise<DispatchResult> => {
  assertRequired(
    ['EMAIL_TOKEN_SECRET',  config.email.tokenSecret],
    ['SMTP_USER',           config.email.smtp.user],
    ['SMTP_PASS',           config.email.smtp.pass],
    ['SMTP_FROM',           config.email.smtp.from],
    ['PUBLIC_URL',          config.publicUrl],
  );

  const batchSize = getSettingNumber('cadence_dispatcher_batch', 100);
  const rows = findEligiblePurchases(batchSize);
  log('info', 'dispatcher run starting', { batchSize, considered: rows.length });

  const result: DispatchResult = { considered: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const outcome = await dispatchOne(row);
    result[outcome] += 1;
  }

  log('info', 'dispatcher run complete', { ...result });
  return result;
};
