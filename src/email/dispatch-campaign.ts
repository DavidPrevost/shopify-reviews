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

import crypto from 'node:crypto';
import { config } from '../config.js';
import {
  findCampaignById,
  listMembersByCampaign,
  parseApplicationData,
  parseProductSet,
  updateMemberStatus,
  listInvitationsByCampaign,
  transitionCampaignStatus,
  setMemberDiscountCode,
  type CampaignRow,
  type CampaignMemberRow,
  type CampaignMemberStatus,
  type CampaignInvitationRow,
} from '../db/campaigns.js';
import { listFeedbackFormsForCampaign, type FeedbackFormRow } from '../db/feedback.js';
import { findActiveTemplateForTriggerCampaignAware } from '../db/queries.js';
import { createCampaignDiscountCode } from '../shopify/discount-codes.js';
import { renderString, renderTemplate, escapeHtml } from './render.js';
import { resolveEmailBranding } from './email-config.js';
import { sendMail } from './smtp-client.js';
import { signSampleInviteToken } from './tokens.js';
import { resolveWidgetConfig, type ResolvedWidgetConfig } from '../shopify/widget-config.js';
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
  // launch_thanks only: how many codes were generated as part of this send,
  // and any errors from the generation phase. If aborted=true, no emails were
  // sent — the whole batch was abandoned because of generation failure.
  codesCreated?: number;
  codeErrors?: string[];
  aborted?: boolean;
}

// Eligibility per trigger. Centralized so the admin counter ("X members ready
// to receive this email") matches the dispatcher exactly.
//
// shipped_notification: members in `approved` status who have invitations.
// review_reminder:      members in `shipped` status (they got the shipped
//                       email; reminder follows). Members already in
//                       `reminded` or `reviewed` are excluded so a re-fired
//                       reminder batch doesn't spam them.
// launch_thanks:        members in `shipped`, `reminded`, or `reviewed`
//                       status. `shipped` is included as a fallback for
//                       merchants who skip the reminder; `reminded` is the
//                       normal path; `reviewed` is for members who reviewed
//                       before the reminder went out. Discount codes are
//                       generated inline as part of this send (not a
//                       separate admin step) so we don't pre-filter on
//                       discount_code presence.
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
      return member.status === 'shipped'
          || member.status === 'reminded'
          || member.status === 'reviewed';
  }
};

// Generates a per-member discount code string. Same alphabet and length as
// the previous standalone "Generate codes" action — kept here in the
// dispatcher because code generation is now part of the launch send rather
// than a separate admin step.
const generateCodeString = (prefix: string | null): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip O/0/I/1 for legibility
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[bytes[i]! % alphabet.length];
  }
  return `${prefix ?? ''}${suffix}`;
};

// First phase of a launch_thanks send. Generates a Shopify discount code for
// every eligible member who doesn't already have one. Returns ok=true only
// if every required generation succeeded; on any failure, callers abort the
// batch before any email goes out. The "all-or-nothing" semantics are by
// design — partial generation followed by partial send leaves recipients
// without codes, which is worse than nothing.
const generateCodesForLaunch = async (
  camp: CampaignRow,
  eligibleMembers: CampaignMemberRow[],
): Promise<{ ok: true; created: number } | { ok: false; created: number; errors: string[] }> => {
  if (camp.discount_percent === null || camp.discount_expires_days === null) {
    return { ok: false, created: 0, errors: ['Campaign has no discount terms configured.'] };
  }
  const needCodes = eligibleMembers.filter((m) => !m.discount_code);
  if (needCodes.length === 0) {
    return { ok: true, created: 0 };
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + camp.discount_expires_days * 86400 * 1000);
  const startsAtIso = startsAt.toISOString();
  const endsAtIso = endsAt.toISOString();

  let created = 0;
  const errors: string[] = [];

  for (const m of needCodes) {
    const code = generateCodeString(camp.discount_code_prefix);
    try {
      const result = await createCampaignDiscountCode({
        code,
        title: `${camp.name} — Member ${m.id}`,
        percentageOff: camp.discount_percent,
        startsAtIso,
        endsAtIso,
        usageLimit: camp.discount_usage_limit,
      });
      setMemberDiscountCode({ memberId: m.id, code, discountId: result.discountId });
      created += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Member ${m.id}: ${msg}`);
      log('error', 'launch-batch code generation failed', {
        campaignId: camp.id,
        memberId: m.id,
        error: msg,
      });
      // Abort early if every attempt is failing — three strikes is a sign of
      // a systemic problem (rate limit, missing scope) rather than a one-off.
      if (errors.length >= 3 && created === 0) break;
    }
  }

  if (errors.length > 0) {
    return { ok: false, created, errors };
  }
  return { ok: true, created };
};

// Successful-send member-status transition. Every email advances state so
// the merchant can see what's happened from the campaign detail page and so
// a re-fired batch naturally skips members who already got it.
const postSendStatus = (trigger: CampaignBatchTrigger): CampaignMemberStatus | null => {
  switch (trigger) {
    case 'campaign_shipped_notification': return 'shipped';
    case 'campaign_review_reminder':      return 'reminded';
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
  widget: ResolvedWidgetConfig,
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
               style="display:inline-block;background:${widget.ctaBackground};color:${widget.ctaForeground};text-decoration:none;padding:10px 18px;border-radius:${widget.borderRadius}px;font-size:14px;font-weight:600;">
              ${escapeHtml(widget.ctaLabel)}
            </a>
          </td>
        </tr>
      </table>
    `;
  });
  return cards.join('');
};

// Builds the {{ feedbackUrlsHtml }} block — one button per feedback form
// attached to the campaign. Each link points at our app-hosted landing
// (/feedback/:key), which serves a server-rendered form directly — no
// merchant setup, no Shopify Page required. The merchant can still embed
// the widget version in a custom storefront page if they want; the email
// uses the hosted landing as the always-works default.
const buildFeedbackUrlsHtml = (
  forms: FeedbackFormRow[],
  widget: ResolvedWidgetConfig,
): string => {
  if (forms.length === 0) return '';
  const publicBase = config.publicUrl.replace(/\/+$/, '');
  const cards = forms.map((f) => {
    const url = `${publicBase}/feedback/${encodeURIComponent(f.access_key)}`;
    return `
      <div style="margin: 0 0 12px;">
        <a href="${url}"
           style="display:inline-block;background:${widget.ctaBackground};color:${widget.ctaForeground};text-decoration:none;padding:8px 14px;border-radius:${widget.borderRadius}px;font-size:14px;font-weight:600;">
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

  // Campaign-aware lookup: a per-campaign template override beats the default.
  const template = findActiveTemplateForTriggerCampaignAware(input.trigger, camp.id);
  if (!template) {
    log('warn', 'campaign batch: no active template', { trigger: input.trigger, campaignId: camp.id });
    return { total: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const allMembers = listMembersByCampaign(camp.id);
  const allInvitations = listInvitationsByCampaign(camp.id);
  const invitationsByEmail = groupInvitationsByEmail(allInvitations);
  const productInfoById = await fetchProductsForInvitations(allInvitations);
  const feedbackForms = listFeedbackFormsForCampaign(camp.id);

  const widget = resolveWidgetConfig();
  const branding = resolveEmailBranding();

  // Note: button colors / border-radius / label all come from widget config now
  // (Branding → Widget), so the email button matches the storefront widget
  // button exactly. The per-template cta_label is no longer consulted.
  const feedbackUrlsHtml = buildFeedbackUrlsHtml(feedbackForms, widget);

  const eligible: Array<{ member: CampaignMemberRow; data: { firstName: string; email: string }; invitations: CampaignInvitationRow[] }> = [];
  for (const m of allMembers) {
    const data = parseApplicationData(m);
    if (!data || !data.email) continue;
    const invitations = invitationsByEmail.get(data.email.toLowerCase()) ?? [];
    if (!isEligible(input.trigger, m, invitations.length > 0)) continue;
    eligible.push({ member: m, data: { firstName: data.firstName, email: data.email }, invitations });
  }

  // launch_thanks: generate discount codes first, abort the batch on failure.
  // This makes "code creation" and "email send" feel like one atomic action
  // to the merchant — they click Send and either everyone gets the email
  // with a fresh code, or no one does.
  let codesCreated = 0;
  if (input.trigger === 'campaign_launch_thanks') {
    const codeResult = await generateCodesForLaunch(camp, eligible.map((e) => e.member));
    if (!codeResult.ok) {
      log('error', 'launch batch aborted — code generation failed', {
        campaignId: camp.id,
        created: codeResult.created,
        errors: codeResult.errors,
      });
      return {
        total: eligible.length,
        sent: 0,
        failed: 0,
        skipped: 0,
        codesCreated: codeResult.created,
        codeErrors: codeResult.errors,
        aborted: true,
      };
    }
    codesCreated = codeResult.created;
    // Re-fetch the members whose codes we just created, so the loop below
    // sees the freshly-set discount_code field. The eligible list still has
    // the pre-generation rows; refresh them in place.
    if (codesCreated > 0) {
      const refreshed = new Map<number, CampaignMemberRow>();
      for (const m of listMembersByCampaign(camp.id)) refreshed.set(m.id, m);
      for (const e of eligible) {
        const fresh = refreshed.get(e.member.id);
        if (fresh) e.member = fresh;
      }
    }
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const nextStatus = postSendStatus(input.trigger);

  for (const row of eligible) {
    const reviewLinksHtml = buildReviewLinksHtml(row.invitations, productInfoById, widget);

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

    const footerHtml = `<p style="margin:0; font-size:12px; color:#888; line-height:1.5;">${renderedFooterText}</p>`;

    // No auto-prepended logo header — see dispatcher.ts for rationale.
    const html = renderTemplate('_shell.html', {
      subject: renderedSubject,
      body: renderedBody,
      footerHtml,
      cardBackground: branding.cardBackground,
    });

    const text = renderedBody
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    try {
      await sendMail({
        to: row.data.email,
        subject: renderedSubject,
        html,
        text,
        senderName: branding.senderName,
        replyTo: branding.replyTo ?? undefined,
      });
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
    codesCreated,
  });
  return {
    total: eligible.length,
    sent,
    failed,
    skipped,
    codesCreated: input.trigger === 'campaign_launch_thanks' ? codesCreated : undefined,
  };
};
