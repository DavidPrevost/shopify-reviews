import { config, assertRequired } from '../config.js';
import {
  findEligiblePurchases,
  customerHasAnyReviews,
  recordRequestSentBatch,
  logEmailFailure,
  findActiveTemplateForTrigger,
  getSettingNumber,
  getCadenceBypassFlags,
  auditSuppressions,
  type EligibleRow,
  type SuppressionAudit,
  type CadenceBypassFlags,
} from '../db/queries.js';
import { renderTemplate, renderString, escapeHtml } from '../email/render.js';
import { sendMail } from '../email/smtp-client.js';
import { signReviewToken, signUnsubscribeToken } from '../email/tokens.js';
import { resolveEmailBranding } from '../email/email-config.js';
import { log } from '../lib/logger.js';
import { resolveWidgetConfig, type ResolvedWidgetConfig } from '../shopify/widget-config.js';
import { getOrFetchProduct, type ProductInfo } from '../shopify/product-info.js';
import { isReviewsPaused } from '../lib/panic.js';

export interface DispatchResult {
  considered: number;          // total purchase rows considered eligible
  groupsConsidered: number;    // count of (customer, order) groups
  sent: number;                // emails actually sent
  failed: number;              // emails that errored during send
  skipped: number;             // groups skipped (e.g. all products missing)
  suppressed: SuppressionAudit; // purchases excluded by each suppression rule
  // Which cadence bypass flags were in effect for this run. The audit numbers
  // above ALWAYS reflect what the rules would normally suppress — so an
  // operator can see "cadenceTooSoon: 1, sent: 1" alongside "bypassed.minDays: true"
  // and understand the rule fired but the bypass let the send through.
  bypassed: CadenceBypassFlags;
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

interface CtaConfig {
  enabled: boolean;        // per-template visibility — still controlled per template
}

// HTML for a single product card inside the multi-product email body.
// Button color, border-radius, and label all come from the widget config
// (Branding → Widget) so the email button matches the storefront widget
// button exactly — one place to configure, two surfaces in sync. Per-card
// unsubscribe link is always present so customers can opt out of a specific
// product without unsubscribing globally.
const renderProductCard = (
  item: GroupItem,
  widget: ResolvedWidgetConfig,
  cta: CtaConfig,
): string => {
  const reviewUrl = buildReviewUrl(item.reviewToken);
  const unsubProductUrl = buildUnsubProductUrl(item.unsubProductToken);
  const imageBlock = item.product.featuredImageUrl
    ? `<img src="${item.product.featuredImageUrl}" alt="" width="80" height="80" style="display:block;border-radius:6px;object-fit:cover;">`
    : '';

  const ctaHtml = cta.enabled
    ? `<a href="${reviewUrl}"
         style="display:inline-block;background:${widget.ctaBackground};color:${widget.ctaForeground};text-decoration:none;padding:10px 18px;border-radius:${widget.borderRadius}px;font-size:14px;font-weight:600;">
        ${escapeHtml(widget.ctaLabel)}
      </a>
      <div style="margin-top:6px;font-size:12px;">
        <a href="${unsubProductUrl}" style="color:#888;text-decoration:underline;">Don't ask about this one</a>
      </div>`
    : `<div style="margin-top:6px;font-size:12px;">
        <a href="${unsubProductUrl}" style="color:#888;text-decoration:underline;">Don't ask about this one</a>
      </div>`;

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px;">
      <tr>
        <td width="96" style="padding-right:16px;vertical-align:top;">
          ${imageBlock}
        </td>
        <td style="vertical-align:top;">
          <div style="font-size:16px;font-weight:600;margin-bottom:6px;">${escapeHtml(item.product.title)}</div>
          ${ctaHtml}
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

  const widget = resolveWidgetConfig();
  const branding = resolveEmailBranding();

  // Select the template by trigger. A purchase that's already been asked at
  // least once uses the follow-up template (if one is active); otherwise it's
  // the repeat-customer or first-time template based on review history. Each
  // step falls back to the plain review_request template so a send never fails
  // just because the merchant disabled a specific variant.
  const isFollowup = rows.some((r) => r.p_request_count >= 1);
  const template =
    (isFollowup ? findActiveTemplateForTrigger('review_request_followup') : null) ??
    findActiveTemplateForTrigger(isRepeat ? 'repeat_customer_review' : 'review_request') ??
    findActiveTemplateForTrigger('review_request');
  if (!template) {
    // No active request template at all — shouldn't happen post-seed. Log and
    // skip the group so we don't send a malformed email or crash the dispatcher.
    log('error', 'no active review-request template found, skipping group', {
      customerId,
      orderId: first.p_shopify_order_id,
    });
    return 'skipped';
  }

  const ctaConfig: CtaConfig = {
    enabled: template.cta_enabled === 1,
  };
  const productsHtml = items.map((item) => renderProductCard(item, widget, ctaConfig)).join('');

  // Pre-render context: the body, subject, footer text all use this. Variables
  // are inserted as-is (no nested re-substitution) since the rendered output
  // is HTML that may contain user-supplied content elsewhere.
  const ctx = {
    firstName: escapeHtml(firstName),
    brandName: escapeHtml(config.email.brandName),
    productName: items[0] ? escapeHtml(items[0].product.title) : '',
    productCount: items.length,
    productsHtml,
    unsubGlobalUrl,
    unsubscribeUrl: unsubGlobalUrl,
  };

  const renderedBody = renderString(template.body_html, ctx);
  const renderedSubject = renderString(template.subject, ctx);
  const renderedFooterText = renderString(branding.footerText, ctx);

  const footerHtml = `
    <p style="margin:0; font-size:12px; color:#888; line-height:1.5;">
      ${renderedFooterText}
      <a href="${unsubGlobalUrl}" style="color:#888; text-decoration:underline;">Unsubscribe from all review requests</a>
    </p>
  `;

  // No auto-prepended logo header — by design, the merchant places the logo
  // inside the template body via the Insert Logo button (or via the
  // {{ logoUrl }} variable) if they want one. The shell wraps body + footer
  // only; nothing is forced.
  const html = renderTemplate('_shell.html', {
    subject: renderedSubject,
    body: renderedBody,
    footerHtml,
    cardBackground: branding.cardBackground,
  });

  const text = renderPlainText({
    firstName,
    brandName: config.email.brandName,
    items,
    unsubGlobalUrl,
    isRepeat,
  });
  const subject = renderedSubject;

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
      senderName: branding.senderName,
      replyTo: branding.replyTo ?? undefined,
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
      template: template.template_key,
      orderId: first.p_shopify_order_id,
      productCount: items.length,
    },
  });

  log('info', 'dispatch sent', {
    customerId,
    orderId: first.p_shopify_order_id,
    template: template.template_key,
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

  const bypassed = getCadenceBypassFlags();

  // Panic-button gate: skip sending entirely while paused. Eligible purchases
  // simply wait until the pause lifts — their due_at is preserved, so they'll
  // be picked up on the next normal run.
  if (isReviewsPaused()) {
    log('warn', 'dispatcher skipped: reviews are paused');
    return {
      considered: 0,
      groupsConsidered: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      suppressed: { globalOptOut: 0, productOptOut: 0, maxRequestsHit: 0, cadenceTooSoon: 0, alreadyReviewed: 0 },
      bypassed,
    };
  }

  const batchSize = getSettingNumber('cadence_dispatcher_batch', 100);
  const rows = findEligiblePurchases(batchSize);
  const groups = groupByCustomerOrder(rows);
  const suppressed = auditSuppressions();

  log('info', 'dispatcher run starting', {
    batchSize,
    considered: rows.length,
    groupsConsidered: groups.length,
    suppressed,
    bypassed,
  });

  const result: DispatchResult = {
    considered: rows.length,
    groupsConsidered: groups.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    suppressed,
    bypassed,
  };

  for (const group of groups) {
    const outcome = await dispatchGroup(group);
    result[outcome] += 1;
  }

  log('info', 'dispatcher run complete', { ...result });
  return result;
};
