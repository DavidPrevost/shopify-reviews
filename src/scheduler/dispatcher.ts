import { config, assertRequired } from '../config.js';
import {
  findEligiblePurchases,
  customerHasAnyReviews,
  recordRequestSentBatch,
  logEmailFailure,
  getSetting,
  getSettingNumber,
  type EligibleRow,
} from '../db/queries.js';
import { renderTemplate, escapeHtml } from '../email/render.js';
import { sendMail } from '../email/smtp-client.js';
import { signReviewToken, signUnsubscribeToken } from '../email/tokens.js';
import { log } from '../lib/logger.js';
import { resolveBrandColors, type ResolvedBrandColors } from '../shopify/brand-info.js';
import { getOrFetchProduct, type ProductInfo } from '../shopify/product-info.js';

export interface DispatchResult {
  considered: number;          // total purchase rows considered eligible
  groupsConsidered: number;    // count of (customer, order) groups
  sent: number;                // emails actually sent
  failed: number;              // emails that errored during send
  skipped: number;             // groups skipped (e.g. all products missing)
}

interface GroupItem {
  purchaseId: number;
  shopifyProductId: string;
  product: ProductInfo;
  reviewToken: string;
  unsubProductToken: string;
}

const trimUrl = (s: string) => s.replace(/\/+$/, '');

const buildReviewUrl = (token: string): string =>
  `${trimUrl(config.publicUrl)}/r/${encodeURIComponent(token)}`;

const buildUnsubGlobalUrl = (token: string): string =>
  `${trimUrl(config.publicUrl)}/unsubscribe?token=${encodeURIComponent(token)}`;

const buildUnsubProductUrl = (token: string): string =>
  `${trimUrl(config.publicUrl)}/unsubscribe/product?token=${encodeURIComponent(token)}`;

const buildSubject = (groupSize: number, sampleTitle: string, isRepeat: boolean): string => {
  if (groupSize === 1) {
    return isRepeat ? `One more review for ${sampleTitle}?` : `How was your ${sampleTitle}?`;
  }
  return isRepeat
    ? `Tell us about your recent order from ${config.email.brandName}`
    : `How was your recent order from ${config.email.brandName}?`;
};

// HTML for a single product card inside the multi-product email body.
const renderProductCard = (item: GroupItem, colors: ResolvedBrandColors): string => {
  const reviewUrl = buildReviewUrl(item.reviewToken);
  const unsubProductUrl = buildUnsubProductUrl(item.unsubProductToken);
  const imageBlock = item.product.featuredImageUrl
    ? `<img src="${item.product.featuredImageUrl}" alt="" width="80" height="80" style="display:block;border-radius:6px;object-fit:cover;">`
    : '';

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px;">
      <tr>
        <td width="96" style="padding-right:16px;vertical-align:top;">
          ${imageBlock}
        </td>
        <td style="vertical-align:top;">
          <div style="font-size:16px;font-weight:600;margin-bottom:6px;">${escapeHtml(item.product.title)}</div>
          <a href="${reviewUrl}"
             style="display:inline-block;background:${colors.ctaBackground};color:${colors.ctaForeground};text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
            Write a review
          </a>
          <div style="margin-top:6px;font-size:12px;">
            <a href="${unsubProductUrl}" style="color:#888;text-decoration:underline;">Don't ask about this one</a>
          </div>
        </td>
      </tr>
    </table>
  `;
};

// Plain-text mirror of the product list (for the text/plain MIME part).
const renderProductTextLines = (items: GroupItem[]): string =>
  items
    .map((item) => {
      const reviewUrl = buildReviewUrl(item.reviewToken);
      const unsubProductUrl = buildUnsubProductUrl(item.unsubProductToken);
      return [
        `- ${item.product.title}`,
        `    Write a review: ${reviewUrl}`,
        `    Don't ask about this one: ${unsubProductUrl}`,
      ].join('\n');
    })
    .join('\n\n');

const renderPlainText = (input: {
  firstName: string;
  brandName: string;
  items: GroupItem[];
  unsubGlobalUrl: string;
  isRepeat: boolean;
}): string => {
  const opening = input.isRepeat
    ? `Thanks again for being a returning customer of ${input.brandName}.`
    : `Thanks for your recent order from ${input.brandName}.`;
  const productPhrase = input.items.length === 1
    ? `Now that you've had some time with your ${input.items[0]!.product.title}, would you share a quick review?`
    : `Now that you've had some time with the items from your order, would you share a review for any that you enjoyed?`;
  return [
    `Hi ${input.firstName},`,
    '',
    opening,
    '',
    productPhrase,
    '',
    renderProductTextLines(input.items),
    '',
    '---',
    `Unsubscribe from all review requests: ${input.unsubGlobalUrl}`,
  ].join('\n');
};

// Group eligible rows by (customer_id, shopify_order_id) — that's the unit of
// "one email." A customer with two separate orders still gets two emails,
// spaced by the customer-level cadence rule.
const groupByCustomerOrder = (rows: EligibleRow[]): EligibleRow[][] => {
  const groups = new Map<string, EligibleRow[]>();
  for (const row of rows) {
    const key = `${row.c_id}:${row.p_shopify_order_id}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(row);
  }
  return [...groups.values()];
};

const dispatchGroup = async (
  rows: EligibleRow[],
): Promise<'sent' | 'failed' | 'skipped'> => {
  const first = rows[0]!;
  const customerId = first.c_id;
  const email = first.c_email;
  const firstName = first.c_first_name?.trim() || 'there';
  const isRepeat = customerHasAnyReviews(customerId);

  // Look up each purchase's product. Drop any that can't be resolved on the
  // Shopify side; if all of them are missing, skip the group entirely.
  const items: GroupItem[] = [];
  for (const row of rows) {
    const product = await getOrFetchProduct(row.p_shopify_product_id);
    if (!product) {
      log('warn', 'dispatch: product not found, skipping line', {
        purchaseId: row.p_id,
        shopifyProductId: row.p_shopify_product_id,
      });
      continue;
    }
    items.push({
      purchaseId: row.p_id,
      shopifyProductId: row.p_shopify_product_id,
      product,
      reviewToken: signReviewToken({ purchaseId: row.p_id, customerId }),
      unsubProductToken: signUnsubscribeToken({
        customerId,
        kind: 'product',
        purchaseId: row.p_id,
      }),
    });
  }

  if (items.length === 0) {
    return 'skipped';
  }

  const unsubGlobalToken = signUnsubscribeToken({ customerId, kind: 'global' });
  const unsubGlobalUrl = buildUnsubGlobalUrl(unsubGlobalToken);

  const colors = resolveBrandColors(getSetting('shop_brand_json'));
  const productsHtml = items.map((item) => renderProductCard(item, colors)).join('');

  const ctx = {
    firstName: escapeHtml(firstName),
    brandName: escapeHtml(config.email.brandName),
    productsHtml,
    unsubGlobalUrl,
  };

  const html = renderTemplate(isRepeat ? 'request-repeat.html' : 'request-first.html', ctx);
  const text = renderPlainText({
    firstName,
    brandName: config.email.brandName,
    items,
    unsubGlobalUrl,
    isRepeat,
  });
  const subject = buildSubject(items.length, items[0]!.product.title, isRepeat);

  try {
    await sendMail({
      to: email,
      subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<${unsubGlobalUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'dispatch send failed', {
      customerId,
      orderId: first.p_shopify_order_id,
      itemCount: items.length,
      error: message,
    });
    for (const item of items) {
      logEmailFailure({ customerId, purchaseId: item.purchaseId, error: message });
    }
    return 'failed';
  }

  recordRequestSentBatch({
    purchaseIds: items.map((i) => i.purchaseId),
    customerId,
    metadata: {
      template: isRepeat ? 'repeat' : 'first',
      orderId: first.p_shopify_order_id,
      productCount: items.length,
    },
  });

  log('info', 'dispatch sent', {
    customerId,
    orderId: first.p_shopify_order_id,
    template: isRepeat ? 'repeat' : 'first',
    purchaseIds: items.map((i) => i.purchaseId),
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
  const groups = groupByCustomerOrder(rows);

  log('info', 'dispatcher run starting', {
    batchSize,
    considered: rows.length,
    groupsConsidered: groups.length,
  });

  const result: DispatchResult = {
    considered: rows.length,
    groupsConsidered: groups.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  for (const group of groups) {
    const outcome = await dispatchGroup(group);
    result[outcome] += 1;
  }

  log('info', 'dispatcher run complete', { ...result });
  return result;
};
