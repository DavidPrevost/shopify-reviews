// Sends a single templated email to one recipient. Use this for one-off
// transactional emails (retract notification, future confirmation emails,
// etc.) that don't need the dispatcher's batching, token-signing, or
// suppression-rule logic.
//
// Loads the named template from the email_templates table (so the merchant
// can edit it via the Branding/Email tab the same way they edit review-
// request templates), renders subject + body + footer with the provided
// context, wraps in the shared shell, and sends via Gmail SMTP.
//
// Returns whether the send happened. Skips silently (returns false) when
// the template is missing or inactive — caller decides whether that's an
// error or just a "no-op, the merchant disabled this notification."

import {
  findEmailTemplate,
  findActiveTemplateForTrigger,
  findActiveTemplateForTriggerCampaignAware,
  type EmailTemplateRow,
} from '../db/queries.js';
import { renderString, renderTemplate, escapeHtml } from './render.js';
import { sendMail } from './smtp-client.js';
import { resolveEmailBranding } from './email-config.js';
import { log } from '../lib/logger.js';

export interface SendTemplateInput {
  templateKey: string;
  to: string;
  // Substitution context for {{ variable }} placeholders in the template's
  // subject and body. Caller is responsible for HTML-escaping any user-supplied
  // values before passing them here.
  context: Record<string, string | number>;
}

export const sendTemplateEmail = async (
  input: SendTemplateInput,
): Promise<{ sent: boolean; reason?: string }> => {
  const template = findEmailTemplate(input.templateKey);
  if (!template) {
    log('warn', 'sendTemplateEmail: template not found', { templateKey: input.templateKey });
    return { sent: false, reason: 'template-not-found' };
  }
  if (template.is_active === 0) {
    log('info', 'sendTemplateEmail: template inactive, skipping', { templateKey: input.templateKey });
    return { sent: false, reason: 'template-inactive' };
  }
  return sendFromTemplate(template, input.to, input.context);
};

// Sends the active template bound to a trigger (the trigger-based equivalent of
// sendTemplateEmail). Used by the moderation flows so merchant-created
// templates for review_removed / review_restored are honored.
export const sendTemplateEmailByTrigger = async (input: {
  trigger: string;
  to: string;
  context: Record<string, string | number>;
}): Promise<{ sent: boolean; reason?: string }> => {
  const template = findActiveTemplateForTrigger(input.trigger);
  if (!template) {
    log('info', 'sendTemplateEmailByTrigger: no active template for trigger', { trigger: input.trigger });
    return { sent: false, reason: 'no-active-template' };
  }
  return sendFromTemplate(template, input.to, input.context);
};

// Campaign-aware variant: prefers a campaign-specific template clone over
// the shop default. Used by the application-confirmation send path so per-
// campaign template edits land in the right email.
export const sendTemplateEmailByTriggerForCampaign = async (input: {
  trigger: string;
  campaignId: number | null;
  to: string;
  context: Record<string, string | number>;
}): Promise<{ sent: boolean; reason?: string }> => {
  const template = findActiveTemplateForTriggerCampaignAware(input.trigger, input.campaignId);
  if (!template) {
    log('info', 'sendTemplateEmailByTriggerForCampaign: no active template', {
      trigger: input.trigger,
      campaignId: input.campaignId,
    });
    return { sent: false, reason: 'no-active-template' };
  }
  return sendFromTemplate(template, input.to, input.context);
};

const sendFromTemplate = async (
  template: EmailTemplateRow,
  to: string,
  context: Record<string, string | number>,
): Promise<{ sent: boolean; reason?: string }> => {
  const input = { to, context };
  const branding = resolveEmailBranding();

  const renderedSubject = renderString(template.subject, input.context);
  const renderedBody = renderString(template.body_html, input.context);
  const renderedFooterText = renderString(branding.footerText, input.context);

  const logoHeader = branding.logoUrl
    ? `<tr><td align="center" style="padding:24px 32px 0;">
         <img src="${branding.logoUrl}" alt="${escapeHtml(branding.senderName)}" style="max-width:140px; height:auto;" />
       </td></tr>`
    : '';

  const footerHtml = `
    <p style="margin:0; font-size:12px; color:#888; line-height:1.5;">
      ${renderedFooterText}
    </p>
  `;

  const html = renderTemplate('_shell.html', {
    subject: renderedSubject,
    body: renderedBody,
    logoHeader,
    footerHtml,
  });

  // Crude text fallback: strip HTML tags from the body. Good enough for
  // transactional emails like the retract notification; if we ever want
  // hand-tuned plain-text mirrors per template, add a body_text column.
  const text = renderedBody
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  await sendMail({
    to: input.to,
    subject: renderedSubject,
    html,
    text,
    senderName: branding.senderName,
    replyTo: branding.replyTo ?? undefined,
  });

  return { sent: true };
};
