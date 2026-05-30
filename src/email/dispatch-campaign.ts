// Per-campaign batch email dispatcher. Admin clicks "Send <trigger>" for a
// campaign; we iterate members in the right state, build per-recipient
// context (including the personalized review-link block), render the active
// template for the trigger, and send via Gmail SMTP one recipient at a time.
//
// Each member is independent: a single send failure logs the error and moves
// on rather than aborting the batch. After a successful send the member's
// status transitions (shipped notification → shipped, launch → done; the
// reminder is status-neutral). All transitions stamp decided_at so the audit
// trail captures when the send happened.

import { config } from '../config.js';
import {
  findCampaignById,
  listMembersByCampaign,
  parseApplicationData,
  parseProductSet,
  updateMemberStatus,
  listInvitationsByCampaign,
  transitionCampaignStatus,
  type CampaignRow,
  type CampaignMemberRow,
  type CampaignMemberStatus,
  type CampaignInvitationRow,
} from '../db/campaigns.js';
import { listFeedbackFormsForCampaign, type FeedbackFormRow } from '../db/feedback.js';
import { findActiveTemplateForTrigger, getSetting } from '../db/queries.js';
import { renderString, renderTemplate, escapeHtml } from './render.js';
import { resolveEmailBranding } from './email-config.js';
import { sendMail } from './smtp-client.js';
import { signSampleInviteToken } from './tokens.js';
import { resolveBrandColors, type ResolvedBrandColors } from '../shopify/brand-info.js';
import { getOrFetchProduct, type ProductInfo } from '../shopify/product-info.js';
import { log } from '../lib/logger.js';

export type CampaignBatchTrigger =
  | 'campaign_shipped_notification'
  | 'campaign_review_reminder'
  | 'campaign_launch_thanks';

export interface CampaignBatchResult {
  total: number;       // eligible members for this trigger
  sent: number;
  failed: number;
  skipped: number;     // e.g. missing invitations, missing discount code
}

// Eligibility per trigger. Centralized so the admin counter ("X members ready
// to receive this email") matches the dispatcher exactly.
//
// shipped_notification: members in `approved` status who have invitations.
// review_reminder:      members already in `shipped` status (they got the
//                       first email; reminder follows).
// launch_thanks:        members in `shipped` OR `reviewed` status who have a
//                       discount code on file. Members without a code are
//                       skipped — Step 6's "generate codes" admin action
//                       seeds them.
const isEligible = (
  trigger: CampaignBatchTrigger,
  member: CampaignMemberRow,
  hasInvitations: boolean,
): boolean => {
  switch (trigger) {
    case 'campaign_shipped_notification':
      return member.status === 'approved' && hasInvitations;
    case 'campaign_review_reminder':
      return member.status === 'shipped';
    case 'campaign_launch_thanks':
      return (member.status === 'shipped' || member.status === 'reviewed') && !!member.discount_code;
  }
};

// Successful-send member-status transition. Null = no transition (reminder
// doesn't move state forward).
const postSendStatus = (trigger: CampaignBatchTrigger): CampaignMemberStatus | null => {
  switch (trigger) {
    case 'campaign_shipped_notification': return 'shipped';
    case 'campaign_review_reminder':      return null;
    case 'campaign_launch_thanks':        return 'done';
  }
};

// Builds the per-recipient {{ reviewLinksHtml }} block. One card per
// invitation in the recipient's invitation set, each linking to the existing
// /r/invite/<token> review-submission flow. Falls back to a plain
// product-title-only card when Shopify can't resolve the product (so the
// recipient still gets a sense of what was in the pack).
const buildReviewLinksHtml = (
  invitations: CampaignInvitationRow[],
  productInfoById: Map<string, ProductInfo | null>,
  colors: ResolvedBrandColors,
  ctaLabel: string,
): string => {
  const base = config.publicUrl.replace(/\/+$/, '');
  const cards = invitations.map((inv) => {
    const product = productInfoById.get(inv.shopify_product_id) ?? null;
    const title = product?.title ?? inv.shopify_product_id;
    const imageBlock = product?.featuredImageUrl
      ? `<img src="${product.featuredImageUrl}" alt="" width="80" height="80" style="display:block;border-radius:6px;object-fit:cover;">`
      : '';
    const token = signSampleInviteToken({
      invitationId: inv.id,
      productId: inv.shopify_product_id,
      exp: inv.expires_at,
    });
    const reviewUrl = `${base}/r/invite/${encodeURIComponent(token)}`;

    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px;">
        <tr>
          <td width="96" style="padding-right:16px;vertical-align:top;">${imageBlock}</td>
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;margin-bottom:6px;">${escapeHtml(title)}</div>
            <a href="${reviewUrl}"
               style="display:inline-block;background:${colors.ctaBackground};color:${colors.ctaForeground};text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">
              ${escapeHtml(ctaLabel)}
            </a>
          </td>
        </tr>
      </table>
    `;
  });
  return cards.join('');
};

// Builds the {{ feedbackUrlsHtml }} block — one button per feedback form
// attached to the campaign. Each button links to the public Shopify Page the
// merchant set up for that form. NOTE: the URL we surface here is to the
// admin's storefront page at /pages/<slug>?key=<accessKey>; since we don't
// know the merchant's chosen page slug, we fall back to a copy-paste-ready
// proxy URL. Merchants can swap their actual page URL in by editing the
// template body if they prefer.
const buildFeedbackUrlsHtml = (
  forms: FeedbackFormRow[],
  colors: ResolvedBrandColors,
): string => {
  if (forms.length === 0) return '';
  const cards = forms.map((f) => {
    // No reliable way to know the merchant's storefront Page URL from the
    // backend, so link via the storefront origin's App Proxy. The recipient
    // hitting this URL hits the merchant's storefront, which 404s unless the
    // merchant has the form embedded in a Page. For day-one usage, the
    // merchant should edit the template to point to their actual Page URL.
    const url = `${config.storefrontOrigin.replace(/\/+$/, '')}/apps/reviews/campaigns/feedback/${encodeURIComponent(f.access_key)}/landing`;
    return `
      <div style="margin: 0 0 12px;">
        <a href="${url}"
           style="display:inline-block;background:${colors.ctaBackground};color:${colors.ctaForeground};text-decoration:none;padding:8px 14px;border-radius:6px;font-size:14px;font-weight:600;">
          ${escapeHtml(`Give feedback — ${f.title}`)}
        </a>
      </div>
    `;
  });
  return `<div style="margin:16px 0;"><p style="margin:0 0 8px;font-weight:600;">Optional anonymous feedback:</p>${cards.join('')}</div>`;
};

// Loads invitations for the campaign once, then groups them by recipient
// email. Used to (a) check eligibility and (b) build per-recipient context.
const groupInvitationsByEmail = (invitations: CampaignInvitationRow[]): Map<string, CampaignInvitationRow[]> => {
  const byEmail = new Map<string, CampaignInvitationRow[]>();
  for (const inv of invitations) {
    if (!inv.intended_email) continue;
    const key = inv.intended_email.toLowerCase();
    let arr = byEmail.get(key);
    if (!arr) { arr = []; byEmail.set(key, arr); }
    arr.push(inv);
  }
  return byEmail;
};

// Resolves every product referenced by the campaign's invitations exactly
// once, so a 75-recipient batch doesn't hit Shopify 225 times. Failed lookups
// are stored as null and the per-card renderer falls back to the product id.
const fetchProductsForInvitations = async (
  invitations: CampaignInvitationRow[],
): Promise<Map<string, ProductInfo | null>> => {
  const ids = new Set(invitations.map((i) => i.shopify_product_id));
  const out = new Map<string, ProductInfo | null>();
  for (const id of ids) {
    try {
      out.set(id, await getOrFetchProduct(id));
    } catch (err) {
      log('warn', 'campaign dispatch: product lookup failed', {
        productId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      out.set(id, null);
    }
  }
  return out;
};

// Picks the campaign-status side effect of a successful batch send. The
// campaign moves through its lifecycle as each trigger fires:
//   shipped_notification → status goes 'shipping' (if it was recruiting/closed)
//   review_reminder      → status goes 'active'   (if it was shipping)
//   launch_thanks        → status goes 'completed'
const campaignStatusAfterBatch = (
  trigger: CampaignBatchTrigger,
  current: CampaignRow['status'],
): CampaignRow['status'] | null => {
  switch (trigger) {
    case 'campaign_shipped_notification':
      return current === 'recruiting' || current === 'closed' ? 'shipping' : null;
    case 'campaign_review_reminder':
      return current === 'shipping' ? 'active' : null;
    case 'campaign_launch_thanks':
      return current === 'active' || current === 'shipping' ? 'completed' : null;
  }
};

// Counts how many members would be sent if the merchant clicked "Send now"
// right now. Drives the admin batch-send confirmation count.
export const countEligibleForTrigger = (
  campaignId: number,
  trigger: CampaignBatchTrigger,
): number => {
  const members = listMembersByCampaign(campaignId);
  const invitationsByEmail = groupInvitationsByEmail(listInvitationsByCampaign(campaignId));
  let n = 0;
  for (const m of members) {
    const data = parseApplicationData(m);
    if (!data || !data.email) continue;
    const hasInvitations = (invitationsByEmail.get(data.email.toLowerCase())?.length ?? 0) > 0;
    if (isEligible(trigger, m, hasInvitations)) n += 1;
  }
  return n;
};

export const sendCampaignBatch = async (input: {
  campaignId: number;
  trigger: CampaignBatchTrigger;
}): Promise<CampaignBatchResult> => {
  const camp = findCampaignById(input.campaignId);
  if (!camp) {
    return { total: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const template = findActiveTemplateForTrigger(input.trigger);
  if (!template) {
    log('warn', 'campaign batch: no active template', { trigger: input.trigger, campaignId: camp.id });
    return { total: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const allMembers = listMembersByCampaign(camp.id);
  const allInvitations = listInvitationsByCampaign(camp.id);
  const invitationsByEmail = groupInvitationsByEmail(allInvitations);
  const productInfoById = await fetchProductsForInvitations(allInvitations);
  const feedbackForms = listFeedbackFormsForCampaign(camp.id);

  const colors = resolveBrandColors(getSetting('shop_brand_json'));
  const branding = resolveEmailBranding();

  const ctaLabel = template.cta_label || 'Write a review';
  const feedbackUrlsHtml = buildFeedbackUrlsHtml(feedbackForms, colors);

  const eligible: Array<{ member: CampaignMemberRow; data: { firstName: string; email: string }; invitations: CampaignInvitationRow[] }> = [];
  for (const m of allMembers) {
    const data = parseApplicationData(m);
    if (!data || !data.email) continue;
    const invitations = invitationsByEmail.get(data.email.toLowerCase()) ?? [];
    if (!isEligible(input.trigger, m, invitations.length > 0)) continue;
    eligible.push({ member: m, data: { firstName: data.firstName, email: data.email }, invitations });
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const nextStatus = postSendStatus(input.trigger);

  for (const row of eligible) {
    const reviewLinksHtml = buildReviewLinksHtml(row.invitations, productInfoById, colors, ctaLabel);

    const ctx = {
      firstName: escapeHtml(row.data.firstName) || 'there',
      brandName: escapeHtml(config.email.brandName),
      campaignName: escapeHtml(camp.name),
      reviewLinksHtml,
      discountCode: row.member.discount_code ?? '',
      feedbackUrlsHtml,
    };

    const renderedSubject = renderString(template.subject, ctx);
    const renderedBody = renderString(template.body_html, ctx);
    const renderedFooterText = renderString(branding.footerText, ctx);

    const logoHeader = branding.logoUrl
      ? `<tr><td align="center" style="padding:24px 32px 0;">
           <img src="${branding.logoUrl}" alt="${escapeHtml(branding.senderName)}" style="max-width:140px; height:auto;" />
         </td></tr>`
      : '';
    const footerHtml = `<p style="margin:0; font-size:12px; color:#888; line-height:1.5;">${renderedFooterText}</p>`;

    const html = renderTemplate('_shell.html', {
      subject: renderedSubject,
      body: renderedBody,
      logoHeader,
      footerHtml,
    });

    const text = renderedBody
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    try {
      await sendMail({ to: row.data.email, subject: renderedSubject, html, text });
      sent += 1;
      if (nextStatus) {
        updateMemberStatus({ id: row.member.id, status: nextStatus, decidedBy: 'campaign-batch' });
      }
    } catch (err) {
      failed += 1;
      log('error', 'campaign batch send failed', {
        campaignId: camp.id,
        memberId: row.member.id,
        trigger: input.trigger,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Campaign-level status transition fires once at the end of the batch, only
  // if at least one send actually succeeded — otherwise the batch was a no-op
  // and the campaign state shouldn't advance.
  if (sent > 0) {
    const next = campaignStatusAfterBatch(input.trigger, camp.status);
    if (next) {
      // Use transitionCampaignStatus so a launch_thanks → completed
      // transition fires the retention-pipe quarantine in the same step.
      const { quarantined } = transitionCampaignStatus(camp.id, next);
      log('info', 'campaign status advanced by batch', {
        campaignId: camp.id,
        from: camp.status,
        to: next,
        trigger: input.trigger,
        quarantined,
      });
    }
  }

  log('info', 'campaign batch complete', {
    campaignId: camp.id,
    trigger: input.trigger,
    total: eligible.length,
    sent,
    failed,
    skipped,
  });
  return { total: eligible.length, sent, failed, skipped };
};
