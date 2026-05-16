// Resolves the shared visual and copy elements that wrap every email template
// (logo, footer text, sender name, reply-to). Same Shopify-default + override
// pattern as the widget visual config: per-field override → Shopify default →
// hardcoded fallback. The per-template content (subject, body, CTA) lives in
// the email_templates table, not here.

import { getSetting, listEmailTemplates, upsertEmailTemplate } from '../db/queries.js';
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
  subject: string;
  bodyHtml: string;
  ctaEnabled: boolean;
  ctaLabel: string;
}

const DEFAULT_TEMPLATES: SeedTemplate[] = [
  {
    templateKey: 'request_first',
    displayName: 'First-time review request',
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
    templateKey: 'request_repeat',
    displayName: 'Repeat-customer review request',
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
];

export const seedDefaultEmailTemplates = (): void => {
  const existing = listEmailTemplates();
  const existingKeys = new Set(existing.map((t) => t.template_key));
  for (const t of DEFAULT_TEMPLATES) {
    if (existingKeys.has(t.templateKey)) continue;
    upsertEmailTemplate({
      templateKey: t.templateKey,
      displayName: t.displayName,
      subject: t.subject,
      bodyHtml: t.bodyHtml,
      ctaEnabled: t.ctaEnabled,
      ctaLabel: t.ctaLabel,
      isActive: true,
    });
    log('info', 'seeded default email template', { templateKey: t.templateKey });
  }
};
