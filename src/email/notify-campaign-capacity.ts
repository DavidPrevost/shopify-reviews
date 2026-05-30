// Operational notification fired when a campaign's active-application count
// crosses its configured capacity-warning threshold. One warning per crossing
// — the admin re-arms it via the "Reset capacity warning" button after
// rejecting ineligible applications, which clears capacity_warning_fired_at.
//
// Recipient resolution: prefer the merchant-configured new-review notify
// email (typically set up during onboarding), fall back to the dev/operator
// email. If neither is set, log and skip — capacity warnings are useful but
// not load-bearing.

import { getSetting } from '../db/queries.js';
import { sendMail } from './smtp-client.js';
import { escapeHtml } from './render.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const NEW_REVIEW_NOTIFY_EMAIL = 'new_review_notify_email';

const resolveRecipient = (): string | null => {
  const merchantEmail = (getSetting(NEW_REVIEW_NOTIFY_EMAIL) ?? '').trim();
  if (merchantEmail) return merchantEmail;
  const devEmail = config.email.devNotificationEmail.trim();
  if (devEmail) return devEmail;
  return null;
};

export const notifyOnCampaignCapacity = async (input: {
  campaignId: number;
  campaignName: string;
  activeCount: number;
  targetSize: number;
  threshold: number;
}): Promise<void> => {
  const to = resolveRecipient();
  if (!to) {
    log('info', 'capacity warning skipped — no recipient configured', { campaignId: input.campaignId });
    return;
  }

  const remaining = Math.max(0, input.targetSize - input.activeCount);
  const adminUrl = `${config.publicUrl.replace(/\/+$/, '')}/admin/campaigns/${input.campaignId}`;
  const subject = `[${config.email.brandName}] Capacity warning — ${input.campaignName}`;

  const lines = [
    `Your campaign "${input.campaignName}" has reached ${input.activeCount} active applications (threshold: ${input.threshold}, target: ${input.targetSize}).`,
    '',
    `${remaining} slot${remaining === 1 ? '' : 's'} remaining.`,
    '',
    'Review the queue and reject any ineligible applications to keep slots open for qualified applicants.',
    '',
    '---',
    `Open in admin: ${adminUrl}`,
    '',
    'You\'ll only be warned once per crossing. To get another warning after rejecting applications, click "Reset capacity warning" on the campaign detail page.',
  ];

  const html = `
<p>Your campaign <strong>${escapeHtml(input.campaignName)}</strong> has reached <strong>${input.activeCount}</strong> active applications.</p>
<ul>
  <li>Threshold: ${input.threshold}</li>
  <li>Target: ${input.targetSize}</li>
  <li>Remaining: ${remaining}</li>
</ul>
<p>Review the queue and reject any ineligible applications to keep slots open for qualified applicants.</p>
<p><a href="${adminUrl}">Open in admin</a></p>
<p style="font-size:12px;color:#888;">You'll only be warned once per crossing. To get another warning after rejecting applications, click "Reset capacity warning" on the campaign detail page.</p>
  `.trim();

  try {
    await sendMail({ to, subject, html, text: lines.join('\n') });
    log('info', 'campaign capacity warning sent', {
      campaignId: input.campaignId,
      to,
      activeCount: input.activeCount,
      threshold: input.threshold,
    });
  } catch (err) {
    log('error', 'campaign capacity warning failed', {
      campaignId: input.campaignId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
