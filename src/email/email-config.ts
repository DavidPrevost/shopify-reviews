// Resolves the shared visual and copy elements that wrap every email template
// (logo, footer text, sender name, reply-to). Same Shopify-default + override
// pattern as the widget visual config: per-field override → Shopify default →
// hardcoded fallback. The per-template content (subject, body, CTA) lives in
// the email_templates table, not here.

import { getSetting, setSetting, listEmailTemplates, upsertEmailTemplate } from '../db/queries.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export interface ResolvedEmailBranding {
  logoUrl: string | null;
  footerText: string;
  senderName: string;
  replyTo: string | null;
}

export interface EmailBrandingOverrides {
  logoUrl: string | null;
  footerText: string | null;
  senderName: string | null;
  replyTo: string | null;
}

const parseJson = <T>(raw: string | null): Partial<T> | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return null;
  }
};

interface BrandJson {
  logoUrl?: string | null;
  shortDescription?: string | null;
}

export const getEmailBrandingOverrides = (): EmailBrandingOverrides => {
  const raw = parseJson<EmailBrandingOverrides>(getSetting('email_branding_json'));
  return {
    logoUrl: raw?.logoUrl ?? null,
    footerText: raw?.footerText ?? null,
    senderName: raw?.senderName ?? null,
    replyTo: raw?.replyTo ?? null,
  };
};

export interface EmailBrandingDefaults {
  shopifyLogoUrl: string | null;
  defaultFooterText: string;
  defaultSenderName: string;
}

export const getEmailBrandingDefaults = (brandName: string): EmailBrandingDefaults => {
  const brand = parseJson<BrandJson>(getSetting('shop_brand_json'));
  return {
    shopifyLogoUrl: brand?.logoUrl ?? null,
    defaultFooterText: `You're receiving this because you bought from ${brandName}.`,
    defaultSenderName: brandName,
  };
};

export const resolveEmailBranding = (): ResolvedEmailBranding => {
  const overrides = getEmailBrandingOverrides();
  const defaults = getEmailBrandingDefaults(config.email.brandName);
  return {
    logoUrl: overrides.logoUrl ?? defaults.shopifyLogoUrl,
    footerText: overrides.footerText ?? defaults.defaultFooterText,
    senderName: overrides.senderName ?? defaults.defaultSenderName,
    replyTo: overrides.replyTo,
  };
};

// --- Default-template seed ---
//
// Seeds the email_templates table with the original first-request and
// repeat-request bodies if they don't already exist. Runs once after
// migrations on first boot of each stack. If a template_key is already in
// the table (because the merchant has edited it, or it was seeded previously)
// we leave it alone. Future template additions: add another entry to
// DEFAULT_TEMPLATES below and they'll seed on the next deploy.

interface SeedTemplate {
  templateKey: string;
  displayName: string;
  triggerEvent: string;
  subject: string;
  bodyHtml: string;
  ctaEnabled: boolean;
  ctaLabel: string;
}

const DEFAULT_TEMPLATES: SeedTemplate[] = [
  {
    templateKey: 'request_first',
    displayName: 'Review Request',
    triggerEvent: 'review_request',
    subject: 'How was your recent order from {{ brandName }}?',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Thanks for your recent order from {{ brandName }}. We hope you're enjoying everything.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  We'd love to hear what you think — your honest feedback helps us improve and helps other customers decide.
</p>
{{ productsHtml }}
<p style="margin:16px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Each review takes about a minute. Thank you for being part of our story.
</p>`,
    ctaEnabled: true,
    ctaLabel: 'Write a review',
  },
  {
    templateKey: 'request_followup',
    displayName: 'Review Request Followup',
    triggerEvent: 'review_request_followup',
    subject: 'A quick reminder — share your thoughts with {{ brandName }}?',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  A little while ago we asked what you thought of your order from {{ brandName }}. If you have a spare minute, we'd still love to hear from you.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  Your review helps other customers decide — and helps us keep improving.
</p>
{{ productsHtml }}
<p style="margin:16px 0 0; font-size:14px; color:#666; line-height:1.55;">
  No pressure — if now isn't a good time, you can ignore this email.
</p>`,
    ctaEnabled: true,
    ctaLabel: 'Write a review',
  },
  {
    templateKey: 'request_repeat',
    displayName: 'Repeat Customer Review',
    triggerEvent: 'repeat_customer_review',
    subject: 'One more review for your recent order from {{ brandName }}?',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Thanks again for being a returning customer of {{ brandName }} — it means a lot.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  Now that you've had some time with the items from your recent order, would you share a quick review for any you enjoyed? Other customers always appreciate hearing from someone who's bought more than once.
</p>
{{ productsHtml }}`,
    ctaEnabled: true,
    ctaLabel: 'Share another review',
  },
  {
    templateKey: 'review_retracted',
    displayName: 'Review Removed',
    triggerEvent: 'review_removed',
    subject: 'Your review of {{ productName }} was removed',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  We're writing to let you know that your review of <strong>{{ productName }}</strong> on {{ brandName }} has been removed.
</p>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Reason: your review {{ retractionReason }}.
</p>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  If you believe this was a mistake, please reply to this email and we'll take another look. You're welcome to submit a new review at any time.
</p>
<p style="margin:24px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks for being a customer of {{ brandName }}.
</p>`,
    ctaEnabled: false,
    ctaLabel: 'Write a new review',
  },
  {
    templateKey: 'review_restored',
    displayName: 'Review Restored',
    triggerEvent: 'review_restored',
    subject: 'Your review of {{ productName }} is back online',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Good news — your review of <strong>{{ productName }}</strong> on {{ brandName }} has been restored and is visible to other customers again.
</p>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Apologies for any inconvenience caused by the earlier removal.
</p>
<p style="margin:24px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks for sharing your experience with {{ brandName }}.
</p>`,
    ctaEnabled: false,
    ctaLabel: 'View your review',
  },
  {
    templateKey: 'campaign_application_confirmation',
    displayName: 'Campaign — Application Received',
    triggerEvent: 'campaign_application_confirmation',
    subject: 'We received your application — {{ campaignName }}',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Thanks for applying, {{ firstName }}!</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  We've received your application for <strong>{{ campaignName }}</strong>. We'll review every application and let you know whether you've been selected to receive a sample pack.
</p>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  By submitting your application you agreed to receive a small number of campaign-related emails from {{ brandName }} (an application confirmation, a shipped notification, a review reminder, and a launch announcement). These emails are part of the campaign — your application stands as your consent to receive them.
</p>
<p style="margin:24px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks for your interest in {{ brandName }}.
</p>`,
    ctaEnabled: false,
    ctaLabel: '',
  },
  {
    templateKey: 'campaign_shipped_notification',
    displayName: 'Campaign — Samples Shipped',
    triggerEvent: 'campaign_shipped_notification',
    subject: 'Your {{ campaignName }} samples are on the way',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  Your sample pack for <strong>{{ campaignName }}</strong> is on its way. Watch your mailbox over the next several days.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  Once you've had some time to try each item, we'd love your honest review. Use the buttons below to leave a review for each product — your feedback is what makes this program work.
</p>
{{ reviewLinksHtml }}
<p style="margin:16px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks for being part of {{ brandName }}.
</p>`,
    ctaEnabled: false,
    ctaLabel: '',
  },
  {
    templateKey: 'campaign_review_reminder',
    displayName: 'Campaign — Review Reminder',
    triggerEvent: 'campaign_review_reminder',
    subject: 'A reminder from {{ brandName }} — {{ campaignName }}',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  We hope you've had a chance to try the samples from <strong>{{ campaignName }}</strong>. If you've already reviewed some or all of them — thank you, your feedback means a lot.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  If you haven't yet, here are your review links again. Each takes about a minute. If you're a Shopify customer, you can also sign in to leave a review directly on the product page if that's easier.
</p>
{{ reviewLinksHtml }}
<p style="margin:16px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks for being part of {{ brandName }}.
</p>`,
    ctaEnabled: false,
    ctaLabel: '',
  },
  {
    templateKey: 'campaign_launch_thanks',
    displayName: 'Campaign — Launch Thanks',
    triggerEvent: 'campaign_launch_thanks',
    subject: 'We just launched — thank you for being part of it',
    bodyHtml: `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; line-height:1.3;">Hi {{ firstName }},</h1>
<p style="margin:0 0 16px; font-size:16px; line-height:1.55;">
  We're officially live — and we wanted to say thank you. As one of our early supporters through <strong>{{ campaignName }}</strong>, you helped shape what we're sharing with the world today.
</p>
<p style="margin:0 0 24px; font-size:16px; line-height:1.55;">
  As a small thank-you, here's a personal discount code for your first order with {{ brandName }}:
</p>
<p style="margin:0 0 24px; font-size:20px; font-weight:600; text-align:center; padding:12px; background:#f6f6f6; border-radius:4px; letter-spacing:1px;">
  {{ discountCode }}
</p>
<p style="margin:16px 0 0; font-size:14px; color:#666; line-height:1.55;">
  Thanks again — none of this would have happened without you.
</p>`,
    ctaEnabled: false,
    ctaLabel: '',
  },
];

// Seeds default templates once each. We track which default keys have been
// seeded in a setting so that *deleting* a default sticks (it won't reappear on
// the next boot) while a genuinely new default added in a later version still
// seeds on existing installs. On the first run after this was introduced, any
// pre-existing default is marked seeded (without re-inserting) so future
// deletes of it also stick.
export const seedDefaultEmailTemplates = (): void => {
  const seededRaw = getSetting('seeded_template_keys');
  let seeded: Set<string>;
  try {
    seeded = new Set<string>(seededRaw ? (JSON.parse(seededRaw) as string[]) : []);
  } catch {
    seeded = new Set<string>();
  }
  const existingKeys = new Set(listEmailTemplates().map((t) => t.template_key));

  for (const t of DEFAULT_TEMPLATES) {
    if (seeded.has(t.templateKey)) continue; // already seeded once — respect deletes
    if (!existingKeys.has(t.templateKey)) {
      upsertEmailTemplate({
        templateKey: t.templateKey,
        displayName: t.displayName,
        triggerEvent: t.triggerEvent,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        ctaEnabled: t.ctaEnabled,
        ctaLabel: t.ctaLabel,
        isActive: true,
      });
      log('info', 'seeded default email template', { templateKey: t.templateKey, trigger: t.triggerEvent });
    }
    seeded.add(t.templateKey);
  }
  setSetting('seeded_template_keys', JSON.stringify([...seeded]));
};
