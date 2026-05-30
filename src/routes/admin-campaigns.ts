// Admin routes for the Campaigns feature. Mounted at /admin/campaigns by
// admin.ts so the top-level admin guard (embed-session cookie) handles auth
// for everything here.
//
// Step 1 (this file): list, create, detail shell, edit settings, status
// transitions, terms editor. Members queue / batch sends / discount-code
// generation arrive in later steps.

import { Hono } from 'hono';
import { adminShell, formatTs } from './admin.js';
import { escapeHtml } from '../email/render.js';
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_MEMBER_STATUSES,
  CAMPAIGN_MEMBER_STATUS_LABELS,
  isCampaignStatus,
  listCampaigns,
  findCampaignById,
  findCampaignBySlug,
  createCampaign,
  updateCampaignSettings,
  updateCampaignStatus,
  saveTermsVersion,
  listTermsVersions,
  getActiveTermsVersion,
  findTermsVersion,
  countMembersByStatus,
  countActiveMembers,
  parseProductSet,
  listMembersByCampaign,
  findCampaignMemberById,
  updateMemberStatus,
  deleteCampaignMember,
  parseApplicationData,
  createCampaignInvitation,
  memberHasInvitations,
  countInvitationsForMember,
  resetCapacityWarning,
  setMemberDiscountCode,
  codeStats,
  listMembersForCodeCleanup,
  markMemberCodeDeleted,
  transitionCampaignStatus,
  listQuarantinedMembers,
  countQuarantinedMembers,
  confirmPurgeShippingAddresses,
  type CodeStats,
  type QuarantinedMemberRow,
  type CampaignRow,
  type CampaignStatus,
  type CampaignProduct,
  type CampaignMemberRow,
} from '../db/campaigns.js';
import { upsertCustomer } from '../db/queries.js';
import { daysToSec, nowSec } from '../lib/time.js';
import { log } from '../lib/logger.js';
import {
  sendCampaignBatch,
  countEligibleForTrigger,
  type CampaignBatchTrigger,
} from '../email/dispatch-campaign.js';
import { createCampaignDiscountCode, deleteCampaignDiscountCode } from '../shopify/discount-codes.js';
import crypto from 'node:crypto';
import {
  FEEDBACK_QUESTION_TYPES,
  FEEDBACK_QUESTION_TYPE_LABELS,
  isFeedbackQuestionType,
  listFeedbackFormsForCampaign,
  findFeedbackFormById,
  createFeedbackForm,
  deleteFeedbackForm,
  listFeedbackQuestionsForForm,
  addFeedbackQuestion,
  deleteFeedbackQuestion,
  parseQuestionOptions,
  countResponsesForForm,
  aggregateFeedbackQuestion,
  type FeedbackFormRow,
  type FeedbackQuestionRow,
  type QuestionAggregate,
} from '../db/feedback.js';

// Campaign-tagged sample invitations get a longer TTL than the default 90-day
// SAMPLE_INVITE_TTL_DAYS because the campaign's email sequence (shipped →
// reminder 2-3 weeks later → launch a few weeks after that) plus straggler
// reviews easily reaches months. 180 days leaves comfortable runway.
const CAMPAIGN_INVITATION_TTL_DAYS = 180;

const adminCampaigns = new Hono();

// --- Helpers ---

// Slug validator. Must be URL-safe — lowercase letters/digits/hyphens, no
// leading/trailing hyphens, length 1-64. Rejected at create time with a
// human-readable error.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isValidSlug = (s: string): boolean => s.length >= 1 && s.length <= 64 && SLUG_RE.test(s);

const parseIntOrNull = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

// Parse a textarea of product-id lines into [{shopifyProductId, shopifyVariantId}].
// One product per non-empty line; `productId|variantId` to pin a specific
// variant, plain `productId` for no variant. Trim every line.
const parseProductLines = (raw: string): CampaignProduct[] => {
  return raw.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('|').map((p) => p.trim());
      return {
        shopifyProductId: parts[0] ?? '',
        shopifyVariantId: parts[1] && parts[1].length > 0 ? parts[1] : null,
      };
    })
    .filter((p) => p.shopifyProductId.length > 0);
};

const formatProductLines = (products: CampaignProduct[]): string => {
  return products
    .map((p) => p.shopifyVariantId ? `${p.shopifyProductId}|${p.shopifyVariantId}` : p.shopifyProductId)
    .join('\n');
};

// Which status transitions are allowed from a given current state. Surfaced
// in the detail page as a list of action buttons; enforced server-side too.
// `cancelled` is always an option from anything except completed/cancelled.
const allowedTransitions = (from: CampaignStatus): CampaignStatus[] => {
  switch (from) {
    case 'draft':      return ['recruiting', 'cancelled'];
    case 'recruiting': return ['closed', 'cancelled'];
    case 'closed':     return ['recruiting', 'shipping', 'cancelled'];
    case 'shipping':   return ['active', 'cancelled'];
    case 'active':     return ['completed', 'cancelled'];
    case 'completed':  return [];
    case 'cancelled':  return [];
  }
};

const transitionLabel = (to: CampaignStatus): string => {
  switch (to) {
    case 'recruiting': return 'Publish (open applications)';
    case 'closed':     return 'Close applications';
    case 'shipping':   return 'Mark as shipping';
    case 'active':     return 'Mark as active';
    case 'completed':  return 'Mark as completed';
    case 'cancelled':  return 'Cancel campaign';
    default:           return CAMPAIGN_STATUS_LABELS[to];
  }
};

// --- List page ---

adminCampaigns.get('/', (c) => {
  const campaigns = listCampaigns();
  const pendingRetention = countQuarantinedMembers();

  const retentionBanner = pendingRetention > 0
    ? `<div class="card" style="background:#fff8e1; border:1px solid #f6c34d;">
        <strong>${pendingRetention}</strong> shipping address${pendingRetention === 1 ? ' is' : 'es are'} pending retention purge.
        <a href="/admin/campaigns/retention-queue" style="margin-left:8px;">Review retention queue →</a>
      </div>`
    : '';

  const rowsHtml = campaigns.length === 0
    ? '<p class="muted">No campaigns yet. <a href="/admin/campaigns/new">Create one</a> to get started.</p>'
    : `<table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Status</th>
            <th>Target</th>
            <th>Applications</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${campaigns.map((camp) => {
          const active = countActiveMembers(camp.id);
          return `<tr>
            <td><a href="/admin/campaigns/${camp.id}">${escapeHtml(camp.name)}</a></td>
            <td class="muted">${escapeHtml(camp.slug)}</td>
            <td><span class="pill pill-campaign-${camp.status}">${escapeHtml(CAMPAIGN_STATUS_LABELS[camp.status])}</span></td>
            <td>${camp.target_size}</td>
            <td>${active} of ${camp.target_size}</td>
            <td class="muted">${formatTs(camp.created_at)}</td>
            <td><a href="/admin/campaigns/${camp.id}">View</a></td>
          </tr>`;
        }).join('')}</tbody>
       </table>`;

  return c.html(adminShell('Campaigns', `
    ${retentionBanner}
    <div class="filter-row" style="justify-content:space-between;">
      <h2 style="margin:0;">Campaigns</h2>
      <a href="/admin/campaigns/new" class="filter-row" style="background:var(--accent); color:var(--accent-text); padding:8px 14px; border-radius:4px; text-decoration:none;">New campaign</a>
    </div>
    ${renderCampaignPillStyles()}
    ${rowsHtml}
  `, 'campaigns'));
});

// Inline-stylesheet for the campaign-status pills. Kept here rather than in
// adminShell so non-campaign pages don't ship the styles. One color family
// per status; chosen to read as muted (draft/cancelled), in-progress
// (recruiting/shipping/active), or final (completed).
const renderCampaignPillStyles = (): string => `
  <style>
    .pill-campaign-draft      { background:#eee; color:#555; }
    .pill-campaign-recruiting { background:#dfe9d9; color:#2d572c; }
    .pill-campaign-closed     { background:#fff3cd; color:#856404; }
    .pill-campaign-shipping   { background:#d6e6ff; color:#234c8c; }
    .pill-campaign-active     { background:#d4f1f9; color:#1c5b75; }
    .pill-campaign-completed  { background:#cfe9d2; color:#1d4d22; }
    .pill-campaign-cancelled  { background:#f8d7da; color:#721c24; }
  </style>
`;

// --- Create form ---

adminCampaigns.get('/new', (c) => {
  return c.html(adminShell('New campaign', `
    <p><a href="/admin/campaigns">← Campaigns</a></p>
    <h2>New campaign</h2>
    <form method="POST" action="/admin/campaigns" class="card">
      <label>Campaign name</label>
      <input type="text" name="name" required maxlength="120" placeholder="e.g., Summer 26 Sample Program" />
      <p class="muted">Shown to the merchant in the admin. Customers never see this directly.</p>

      <label>URL slug</label>
      <input type="text" name="slug" required maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="e.g., summer26" />
      <p class="muted">Lowercase letters, digits, and hyphens. Used in the public application URL.</p>

      <label>Target size (number of participants)</label>
      <input type="number" name="target_size" required min="1" max="100000" placeholder="80" />

      <label>Capacity-warning threshold (optional)</label>
      <input type="number" name="capacity_warning_threshold" min="0" placeholder="64" />
      <p class="muted">When active-applications count crosses this number, you get an email. Leave blank to disable. (You can re-arm it later from the detail page.)</p>

      <h3 style="margin-top:32px;">Product set</h3>
      <p class="muted">One product per line. Use <code>shopify_product_id</code> for any-variant, or <code>shopify_product_id|shopify_variant_id</code> to pin a specific variant.</p>
      <textarea name="product_set" rows="4" placeholder="123456789&#10;987654321|111222333"></textarea>

      <h3 style="margin-top:32px;">Discount terms (used by the launch email)</h3>
      <label>Percentage off (optional)</label>
      <input type="number" name="discount_percent" min="1" max="100" placeholder="40" />

      <label>Code expiry (days from issue)</label>
      <input type="number" name="discount_expires_days" min="1" max="3650" placeholder="60" />

      <label>Code prefix (optional)</label>
      <input type="text" name="discount_code_prefix" maxlength="16" placeholder="S26-" />
      <p class="muted">Each per-participant code is generated as <code>PREFIX</code> + a random suffix.</p>

      <h3 style="margin-top:32px;">Initial terms</h3>
      <p class="muted">The terms the applicant must accept. By submitting the application form, they consent to receive the four campaign emails (this is a condition of participation).</p>
      <textarea name="terms_body" rows="10" required placeholder="By submitting this application you agree to..."></textarea>

      <div style="margin-top:24px; display:flex; gap:12px;">
        <button type="submit" class="primary">Create campaign (draft)</button>
        <a href="/admin/campaigns" style="align-self:center;">Cancel</a>
      </div>
    </form>
  `, 'campaigns'));
});

// --- Create action ---

adminCampaigns.post('/', async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  const slug = String(form.slug ?? '').trim().toLowerCase();
  const targetSize = parseIntOrNull(form.target_size);
  const threshold = parseIntOrNull(form.capacity_warning_threshold);
  const productLines = String(form.product_set ?? '');
  const discountPercent = parseIntOrNull(form.discount_percent);
  const discountExpiresDays = parseIntOrNull(form.discount_expires_days);
  const discountCodePrefix = String(form.discount_code_prefix ?? '').trim() || null;
  const termsBody = String(form.terms_body ?? '').trim();

  const errors: string[] = [];
  if (!name) errors.push('Name is required.');
  if (!slug || !isValidSlug(slug)) errors.push('Slug must be lowercase letters, digits, and hyphens.');
  if (!targetSize || targetSize <= 0) errors.push('Target size must be a positive number.');
  if (threshold !== null && (threshold < 0 || threshold > (targetSize ?? 0))) {
    errors.push('Capacity-warning threshold must be between 0 and target size.');
  }
  if (discountPercent !== null && (discountPercent < 1 || discountPercent > 100)) {
    errors.push('Discount percentage must be 1-100.');
  }
  if (!termsBody) errors.push('Initial terms text is required.');

  if (findCampaignBySlug(slug)) errors.push(`Slug "${slug}" is already in use.`);

  if (errors.length > 0) {
    return c.html(adminShell('New campaign', `
      <p><a href="/admin/campaigns">← Campaigns</a></p>
      <h2>New campaign</h2>
      <div class="err">${errors.map(escapeHtml).join('<br />')}</div>
      <p>Please <a href="javascript:history.back()">go back</a> and correct the issues.</p>
    `, 'campaigns'), 400);
  }

  const { campaignId } = createCampaign({
    name,
    slug,
    targetSize: targetSize!,
    capacityWarningThreshold: threshold,
    productSet: parseProductLines(productLines),
    discountPercent,
    discountExpiresDays,
    discountCodePrefix,
    termsBodyText: termsBody,
  });

  log('info', 'campaign created', { campaignId, slug, name });
  return c.redirect(`/admin/campaigns/${campaignId}`);
});

// --- Detail page ---

adminCampaigns.get('/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const activeTerms = getActiveTermsVersion(camp.id);
  const termsVersions = listTermsVersions(camp.id);
  const memberCounts = countMembersByStatus(camp.id);
  const activeMembers = countActiveMembers(camp.id);
  const products = parseProductSet(camp);

  const productListHtml = products.length === 0
    ? '<p class="muted">No products configured yet. Edit the campaign to add them.</p>'
    : `<ul style="margin:8px 0 0; padding-left:20px;">${products
        .map((p) => `<li><code>${escapeHtml(p.shopifyProductId)}</code>${p.shopifyVariantId ? ` <span class="muted">(variant ${escapeHtml(p.shopifyVariantId)})</span>` : ''}</li>`)
        .join('')}</ul>`;

  const statusPillHtml = `<span class="pill pill-campaign-${camp.status}">${escapeHtml(CAMPAIGN_STATUS_LABELS[camp.status])}</span>`;

  // Status transition buttons. Each posts to /status with a target value;
  // the route validates the transition is allowed from the current state.
  const transitions = allowedTransitions(camp.status);
  const transitionsHtml = transitions.length === 0
    ? '<p class="muted">This campaign is in a final state. No further status changes.</p>'
    : transitions.map((to) => {
        const isDanger = to === 'cancelled';
        return `<form method="POST" action="/admin/campaigns/${camp.id}/status" class="inline" style="margin-right:8px;">
          <input type="hidden" name="status" value="${to}" />
          <button type="submit" class="${isDanger ? 'danger' : ''}">${escapeHtml(transitionLabel(to))}</button>
        </form>`;
      }).join('');

  const memberStatsHtml = `<div class="stats">${CAMPAIGN_MEMBER_STATUSES.map((s) => {
    const n = memberCounts[s];
    return `<div class="stat"><div class="num">${n}</div><div class="label">${escapeHtml(CAMPAIGN_MEMBER_STATUS_LABELS[s])}</div></div>`;
  }).join('')}</div>`;

  const termsHistoryHtml = termsVersions.length <= 1
    ? '<p class="muted">Only the original version exists.</p>'
    : `<ul style="margin:8px 0 0; padding-left:20px;">${termsVersions.map((v) => `
        <li>v${v.version_number} · ${formatTs(v.created_at)}${activeTerms && v.id === activeTerms.id ? ' <strong>(current)</strong>' : ''}</li>
      `).join('')}</ul>`;

  const discountTermsHtml = camp.discount_percent
    ? `${camp.discount_percent}% off, expires ${camp.discount_expires_days ?? '—'} days after issue${camp.discount_code_prefix ? `, code prefix "${escapeHtml(camp.discount_code_prefix)}"` : ''}`
    : 'Not configured.';

  return c.html(adminShell(camp.name, `
    ${renderCampaignPillStyles()}
    <p><a href="/admin/campaigns">← Campaigns</a></p>
    <h2>${escapeHtml(camp.name)} ${statusPillHtml}</h2>
    <p class="muted">Slug: <code>${escapeHtml(camp.slug)}</code> · Created ${formatTs(camp.created_at)} · ${activeMembers} of ${camp.target_size} active applications</p>

    <div class="card">
      <h3 style="margin-top:0;">Status</h3>
      ${transitionsHtml}
    </div>

    <h3>Applications</h3>
    ${memberStatsHtml}
    ${renderApplicationQueue(camp, parseProductSet(camp).length)}

    <div class="card">
      <h3 style="margin-top:0;">Batch emails</h3>
      ${renderBatchSendRow(camp, 'campaign_shipped_notification', 'Samples shipped')}
      ${renderBatchSendRow(camp, 'campaign_review_reminder', 'Review reminder')}
      ${renderBatchSendRow(camp, 'campaign_launch_thanks', 'Launch thanks')}
      <p class="muted" style="margin-top:16px;">Each button sends to every eligible member. "Shipped" requires approved members with generated invitations; "Reminder" requires members already in shipped; "Launch" requires members in shipped or reviewed who have a discount code.</p>
    </div>

    ${renderDiscountCard(camp)}

    ${renderFeedbackCard(camp)}

    <div class="card">
      <h3 style="margin-top:0;">Public application form</h3>
      <p>To collect applications, create a Page in Shopify admin (<em>Online Store → Pages → Add page</em>) and paste this line into the page body:</p>
      <pre style="background:var(--surface-alt); padding:12px; border-radius:4px; overflow-x:auto;">&lt;div data-campaign-form="${escapeHtml(camp.slug)}"&gt;&lt;/div&gt;</pre>
      <p class="muted">The widget JS (already loaded site-wide for reviews) will detect the div and render the application form. The form will only render while the campaign is in <strong>Recruiting</strong> status; in any other status it shows "applications are closed."</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Settings</h3>
      <p><strong>Target size:</strong> ${camp.target_size}</p>
      <p><strong>Capacity-warning threshold:</strong> ${renderCapacityWarningStatus(camp)}</p>
      <p><strong>Discount terms:</strong> ${discountTermsHtml}</p>
      <p><strong>Products:</strong></p>
      ${productListHtml}
      <p style="margin-top:16px;"><a href="/admin/campaigns/${camp.id}/edit">Edit settings</a></p>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Terms</h3>
      <p class="muted">Current version: ${activeTerms ? `v${activeTerms.version_number}, saved ${formatTs(activeTerms.created_at)}` : 'none'}</p>
      <form method="POST" action="/admin/campaigns/${camp.id}/terms">
        <textarea name="terms_body" rows="10" required>${escapeHtml(activeTerms?.body_text ?? '')}</textarea>
        <p class="muted">Saving creates a new version. Existing applicants keep pointing at the version they accepted.</p>
        <button type="submit" class="primary">Save new terms version</button>
      </form>
      <h4 style="margin-top:24px;">History</h4>
      ${termsHistoryHtml}
    </div>
  `, 'campaigns'));
});

// --- Edit settings (form) ---

adminCampaigns.get('/:id/edit', (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const products = parseProductSet(camp);
  const productLines = formatProductLines(products);

  return c.html(adminShell(`Edit ${camp.name}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Edit campaign</h2>
    <form method="POST" action="/admin/campaigns/${camp.id}/edit" class="card">
      <label>Campaign name</label>
      <input type="text" name="name" required maxlength="120" value="${escapeHtml(camp.name)}" />

      <label>Target size</label>
      <input type="number" name="target_size" required min="1" max="100000" value="${camp.target_size}" />

      <label>Capacity-warning threshold (optional)</label>
      <input type="number" name="capacity_warning_threshold" min="0" value="${camp.capacity_warning_threshold ?? ''}" />

      <h3 style="margin-top:32px;">Product set</h3>
      <p class="muted">One product per line. Use <code>shopify_product_id</code> or <code>shopify_product_id|shopify_variant_id</code>.</p>
      <textarea name="product_set" rows="4">${escapeHtml(productLines)}</textarea>

      <h3 style="margin-top:32px;">Discount terms</h3>
      <label>Percentage off</label>
      <input type="number" name="discount_percent" min="1" max="100" value="${camp.discount_percent ?? ''}" />

      <label>Code expiry (days from issue)</label>
      <input type="number" name="discount_expires_days" min="1" max="3650" value="${camp.discount_expires_days ?? ''}" />

      <label>Code prefix</label>
      <input type="text" name="discount_code_prefix" maxlength="16" value="${escapeHtml(camp.discount_code_prefix ?? '')}" />

      <div style="margin-top:24px; display:flex; gap:12px;">
        <button type="submit" class="primary">Save changes</button>
        <a href="/admin/campaigns/${camp.id}" style="align-self:center;">Cancel</a>
      </div>
    </form>
  `, 'campaigns'));
});

adminCampaigns.post('/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim();
  const targetSize = parseIntOrNull(form.target_size);
  const threshold = parseIntOrNull(form.capacity_warning_threshold);
  const productLines = String(form.product_set ?? '');
  const discountPercent = parseIntOrNull(form.discount_percent);
  const discountExpiresDays = parseIntOrNull(form.discount_expires_days);
  const discountCodePrefix = String(form.discount_code_prefix ?? '').trim() || null;

  if (!name || !targetSize || targetSize <= 0) {
    return c.html(adminShell('Edit campaign', `
      <div class="err">Name and a positive target size are required.</div>
      <p><a href="javascript:history.back()">Go back</a></p>
    `, 'campaigns'), 400);
  }
  if (threshold !== null && (threshold < 0 || threshold > targetSize)) {
    return c.html(adminShell('Edit campaign', `
      <div class="err">Capacity-warning threshold must be between 0 and target size.</div>
      <p><a href="javascript:history.back()">Go back</a></p>
    `, 'campaigns'), 400);
  }

  updateCampaignSettings({
    id: camp.id,
    name,
    targetSize,
    capacityWarningThreshold: threshold,
    productSet: parseProductLines(productLines),
    discountPercent,
    discountExpiresDays,
    discountCodePrefix,
  });

  log('info', 'campaign settings updated', { campaignId: camp.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Status transitions ---

adminCampaigns.post('/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody();
  const target = String(form.status ?? '');
  if (!isCampaignStatus(target)) {
    return c.json({ error: 'invalid_status' }, 400);
  }
  if (!allowedTransitions(camp.status).includes(target)) {
    return c.json({ error: 'invalid_transition', from: camp.status, to: target }, 400);
  }

  const { quarantined } = transitionCampaignStatus(camp.id, target);
  log('info', 'campaign status changed', {
    campaignId: camp.id,
    from: camp.status,
    to: target,
    quarantined,
  });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Save new terms version ---

adminCampaigns.post('/:id/terms', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody();
  const bodyText = String(form.terms_body ?? '').trim();
  if (!bodyText) {
    return c.html(adminShell('Save terms', `
      <div class="err">Terms text cannot be empty.</div>
      <p><a href="javascript:history.back()">Go back</a></p>
    `, 'campaigns'), 400);
  }

  // Skip the save if the text is unchanged from the active version — no point
  // versioning a no-op. Comparison is exact-string; whitespace edits do create
  // a new version, which the merchant probably wants for audit purposes.
  const active = getActiveTermsVersion(camp.id);
  if (active && active.body_text === bodyText) {
    log('info', 'campaign terms unchanged, skipping version', { campaignId: camp.id });
    return c.redirect(`/admin/campaigns/${camp.id}`);
  }

  const version = saveTermsVersion({ campaignId: camp.id, bodyText });
  log('info', 'campaign terms saved', { campaignId: camp.id, versionId: version.id, versionNumber: version.version_number });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Application queue (rendered into the detail page) ---

const memberRowHtml = (
  member: CampaignMemberRow,
  campaign: CampaignRow,
  productCount: number,
): string => {
  const data = parseApplicationData(member);
  const name = data ? `${data.firstName} ${data.lastName}`.trim() : '(unparseable)';
  const email = data?.email ?? '';
  const messageHtml = data?.message
    ? `<p class="muted" style="margin:6px 0 0;">${escapeHtml(data.message.slice(0, 240))}${data.message.length > 240 ? '…' : ''}</p>`
    : '';

  // Action buttons depend on status. Approve/reject only on "applied"; remove
  // is only available pre-ship (applied/approved). "Done" / "rejected" rows
  // are read-only.
  const actions: string[] = [];
  if (member.status === 'applied') {
    actions.push(`<form method="POST" action="/admin/campaigns/${campaign.id}/members/${member.id}/approve" class="inline">
      <button type="submit" class="primary">Approve</button>
    </form>`);
    actions.push(`<form method="POST" action="/admin/campaigns/${campaign.id}/members/${member.id}/reject" class="inline" onsubmit="return confirm('Reject this application?');">
      <button type="submit" class="danger">Reject</button>
    </form>`);
  }
  if (member.status === 'applied' || member.status === 'approved') {
    actions.push(`<form method="POST" action="/admin/campaigns/${campaign.id}/members/${member.id}/remove" class="inline" onsubmit="return confirm('Remove this applicant entirely? Their data will be deleted.');">
      <button type="submit" class="danger">Remove</button>
    </form>`);
  }

  const invitationCount = email ? countInvitationsForMember(campaign.id, email) : 0;
  const invitationCell = member.status === 'approved' || member.status === 'shipped' || member.status === 'reviewed' || member.status === 'done'
    ? (invitationCount > 0
        ? `<span class="muted">${invitationCount} of ${productCount}</span>`
        : `<span class="muted">—</span>`)
    : '';

  return `<tr>
    <td>${escapeHtml(name)}<br /><span class="muted">${escapeHtml(email)}</span>${messageHtml}</td>
    <td><span class="pill pill-campaign-member-${member.status}">${escapeHtml(CAMPAIGN_MEMBER_STATUS_LABELS[member.status])}</span></td>
    <td>${invitationCell}</td>
    <td class="muted">${formatTs(member.created_at)}</td>
    <td>${actions.join(' ')}</td>
  </tr>`;
};

const renderMemberPillStyles = (): string => `
  <style>
    .pill-campaign-member-applied  { background:#fff3cd; color:#856404; }
    .pill-campaign-member-approved { background:#dfe9d9; color:#2d572c; }
    .pill-campaign-member-rejected { background:#f8d7da; color:#721c24; }
    .pill-campaign-member-shipped  { background:#d6e6ff; color:#234c8c; }
    .pill-campaign-member-reviewed { background:#d4f1f9; color:#1c5b75; }
    .pill-campaign-member-done     { background:#cfe9d2; color:#1d4d22; }
  </style>
`;

const renderApplicationQueue = (camp: CampaignRow, productCount: number): string => {
  const members = listMembersByCampaign(camp.id);
  if (members.length === 0) {
    return `<p class="muted">No applications yet. Share the form URL once the campaign is in Recruiting status.</p>`;
  }

  // Approved-but-no-invitations count drives the "Generate invitations" CTA.
  // Skip entirely when the product set is empty — generating zero invitations
  // per member isn't useful.
  let approvedAwaitingInvitations = 0;
  if (productCount > 0) {
    for (const m of members) {
      if (m.status !== 'approved') continue;
      const data = parseApplicationData(m);
      if (!data || !data.email) continue;
      if (!memberHasInvitations(camp.id, data.email)) approvedAwaitingInvitations += 1;
    }
  }

  const generateCta = approvedAwaitingInvitations > 0
    ? `<div class="card" style="background:var(--surface-alt);">
        <p style="margin:0 0 12px;"><strong>${approvedAwaitingInvitations}</strong> approved ${approvedAwaitingInvitations === 1 ? 'applicant has' : 'applicants have'} no invitations yet.</p>
        <form method="POST" action="/admin/campaigns/${camp.id}/generate-invitations">
          <button type="submit" class="primary">Generate ${productCount} sample invitations per approved applicant</button>
        </form>
        <p class="muted" style="margin:12px 0 0;">Creates one invitation per product in the campaign's product set. Idempotent — re-running skips applicants who already have invitations.</p>
      </div>`
    : '';

  return `
    ${renderMemberPillStyles()}
    ${generateCta}
    <table>
      <thead>
        <tr>
          <th>Applicant</th>
          <th>Status</th>
          <th>Invitations</th>
          <th>Applied</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${members.map((m) => memberRowHtml(m, camp, productCount)).join('')}</tbody>
    </table>
  `;
};

// --- Member action routes ---

adminCampaigns.post('/:id/members/:memberId/approve', (c) => {
  const id = Number(c.req.param('id'));
  const memberId = Number(c.req.param('memberId'));
  const camp = findCampaignById(id);
  const member = findCampaignMemberById(memberId);
  if (!camp || !member || member.campaign_id !== camp.id) return c.notFound();
  if (member.status !== 'applied') {
    return c.json({ error: 'invalid_transition', from: member.status }, 400);
  }

  const data = parseApplicationData(member);
  if (!data || !data.email) {
    return c.json({ error: 'unparseable_application' }, 500);
  }

  // Upsert into customers so the customer record exists for the email
  // pipeline + future redemption tracking. shopifyCustomerId is null because
  // the applicant hasn't necessarily shopped before; if they have, the email
  // upsert dedupes against the existing row.
  const customer = upsertCustomer({
    shopifyCustomerId: null,
    email: data.email,
    firstName: data.firstName || null,
    lastName: data.lastName || null,
  });

  updateMemberStatus({
    id: member.id,
    status: 'approved',
    customerId: customer.id,
    decidedBy: 'admin',
  });
  log('info', 'campaign member approved', { campaignId: camp.id, memberId: member.id, customerId: customer.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

adminCampaigns.post('/:id/members/:memberId/reject', (c) => {
  const id = Number(c.req.param('id'));
  const memberId = Number(c.req.param('memberId'));
  const camp = findCampaignById(id);
  const member = findCampaignMemberById(memberId);
  if (!camp || !member || member.campaign_id !== camp.id) return c.notFound();
  if (member.status !== 'applied') {
    return c.json({ error: 'invalid_transition', from: member.status }, 400);
  }
  updateMemberStatus({ id: member.id, status: 'rejected', decidedBy: 'admin' });
  log('info', 'campaign member rejected', { campaignId: camp.id, memberId: member.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// Hard-delete a member pre-ship. Used when the applicant changes their mind
// or the merchant decides the application shouldn't have been collected.
// Allowed only for `applied` and `approved` statuses (anything later means
// downstream artifacts already exist — invitations, codes, shipped emails).
adminCampaigns.post('/:id/members/:memberId/remove', (c) => {
  const id = Number(c.req.param('id'));
  const memberId = Number(c.req.param('memberId'));
  const camp = findCampaignById(id);
  const member = findCampaignMemberById(memberId);
  if (!camp || !member || member.campaign_id !== camp.id) return c.notFound();
  if (member.status !== 'applied' && member.status !== 'approved') {
    return c.json({ error: 'remove_too_late', from: member.status }, 400);
  }
  deleteCampaignMember(member.id);
  log('info', 'campaign member removed', { campaignId: camp.id, memberId: member.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Bulk: generate sample invitations for approved members ---

adminCampaigns.post('/:id/generate-invitations', (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const products = parseProductSet(camp);
  if (products.length === 0) {
    return c.html(adminShell('Generate invitations', `
      <div class="err">The campaign has no products configured. Edit the campaign to add products before generating invitations.</div>
      <p><a href="/admin/campaigns/${camp.id}">Back</a></p>
    `, 'campaigns'), 400);
  }

  const expiresAt = nowSec() + daysToSec(CAMPAIGN_INVITATION_TTL_DAYS);
  const notes = `Campaign: ${camp.name}`;

  const members = listMembersByCampaign(camp.id);
  let membersProcessed = 0;
  let invitationsCreated = 0;
  let membersSkipped = 0;

  for (const m of members) {
    if (m.status !== 'approved') continue;
    const data = parseApplicationData(m);
    if (!data || !data.email) continue;

    if (memberHasInvitations(camp.id, data.email)) {
      membersSkipped += 1;
      continue;
    }

    const intendedName = [data.firstName, data.lastName].filter(Boolean).join(' ').trim() || null;
    for (const p of products) {
      createCampaignInvitation({
        campaignId: camp.id,
        shopifyProductId: p.shopifyProductId,
        intendedEmail: data.email,
        intendedName,
        notes,
        expiresAt,
      });
      invitationsCreated += 1;
    }
    membersProcessed += 1;
  }

  log('info', 'campaign invitations generated', {
    campaignId: camp.id,
    membersProcessed,
    membersSkipped,
    invitationsCreated,
  });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Batch-send UI + routes ---

const renderBatchSendRow = (
  camp: CampaignRow,
  trigger: CampaignBatchTrigger,
  label: string,
): string => {
  const eligible = countEligibleForTrigger(camp.id, trigger);
  const disabled = eligible === 0 ? 'disabled' : '';
  const confirmMsg = `Send "${label}" to ${eligible} eligible member${eligible === 1 ? '' : 's'}? This cannot be undone.`;
  return `
    <form method="POST" action="/admin/campaigns/${camp.id}/send/${trigger}"
          onsubmit="return confirm(${JSON.stringify(confirmMsg)});"
          style="display:flex; gap:12px; align-items:center; margin:8px 0;">
      <button type="submit" class="primary" ${disabled}>Send "${escapeHtml(label)}"</button>
      <span class="muted">${eligible} eligible</span>
    </form>
  `;
};

adminCampaigns.post('/:id/send/:trigger', async (c) => {
  const id = Number(c.req.param('id'));
  const triggerParam = c.req.param('trigger');
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const validTriggers: CampaignBatchTrigger[] = [
    'campaign_shipped_notification',
    'campaign_review_reminder',
    'campaign_launch_thanks',
  ];
  if (!validTriggers.includes(triggerParam as CampaignBatchTrigger)) {
    return c.json({ error: 'invalid_trigger' }, 400);
  }
  const trigger = triggerParam as CampaignBatchTrigger;

  const result = await sendCampaignBatch({ campaignId: camp.id, trigger });

  // Bare-bones result page. The admin can click back to the campaign to see
  // status changes reflected in the queue.
  return c.html(adminShell(`Batch send — ${camp.name}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Batch complete</h2>
    <div class="card">
      <p><strong>Trigger:</strong> ${escapeHtml(trigger)}</p>
      <p><strong>Eligible:</strong> ${result.total}</p>
      <p><strong>Sent:</strong> ${result.sent}</p>
      <p><strong>Failed:</strong> ${result.failed}</p>
      ${result.skipped > 0 ? `<p><strong>Skipped:</strong> ${result.skipped}</p>` : ''}
      <p style="margin-top:16px;"><a href="/admin/campaigns/${camp.id}">Back to campaign</a></p>
    </div>
  `, 'campaigns'));
});

// --- Discount-code generation + render ---

// Generates a per-member code string. Combines the optional campaign prefix
// with a short random suffix (8 uppercase alphanumerics, 36^8 = ~2.8 trillion
// distinct values — collision probability over a campaign of 75 is effectively
// zero). The full string is stored on the member row and sent to Shopify as
// the code attribute, so the customer types it verbatim at checkout.
const generateCodeString = (prefix: string | null): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // skip O/0/I/1 for legibility
  const bytes = crypto.randomBytes(8);
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[bytes[i]! % alphabet.length];
  }
  return `${prefix ?? ''}${suffix}`;
};

const countMembersNeedingCodes = (camp: CampaignRow): number => {
  const members = listMembersByCampaign(camp.id);
  let n = 0;
  for (const m of members) {
    if (m.discount_code) continue;
    if (m.status !== 'shipped' && m.status !== 'reviewed' && m.status !== 'approved') continue;
    n += 1;
  }
  return n;
};

const renderDiscountCard = (camp: CampaignRow): string => {
  const stats: CodeStats = codeStats(camp.id);
  const missing = countMembersNeedingCodes(camp);
  const configured = camp.discount_percent !== null && camp.discount_expires_days !== null;

  const statsHtml = `
    <div class="stats" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
      <div class="stat"><div class="num">${stats.active}</div><div class="label">Active</div></div>
      <div class="stat"><div class="num">${stats.redeemed}</div><div class="label">Redeemed</div></div>
      <div class="stat"><div class="num">${stats.expired}</div><div class="label">Expired</div></div>
      <div class="stat"><div class="num">${stats.deleted_from_shopify}</div><div class="label">Deleted</div></div>
    </div>
  `;
  const revenueHtml = stats.unredeemed_revenue > 0
    ? `<p><strong>Tracked revenue from redeemed codes:</strong> $${stats.unredeemed_revenue.toFixed(2)}</p>`
    : '';

  let actionHtml = '';
  if (!configured) {
    actionHtml = `<p class="muted">Discount terms aren't configured. <a href="/admin/campaigns/${camp.id}/edit">Edit the campaign</a> to set a percentage and expiry.</p>`;
  } else if (missing === 0) {
    actionHtml = `<p class="muted">All eligible members already have codes.</p>`;
  } else {
    const confirmMsg = `Generate Shopify discount codes for ${missing} member${missing === 1 ? '' : 's'}? Each code is ${camp.discount_percent}% off, single-use, expires in ${camp.discount_expires_days} days.`;
    actionHtml = `
      <form method="POST" action="/admin/campaigns/${camp.id}/generate-discount-codes"
            onsubmit="return confirm(${JSON.stringify(confirmMsg)});">
        <button type="submit" class="primary">Generate ${missing} discount code${missing === 1 ? '' : 's'}</button>
      </form>
    `;
  }

  const cleanupHtml = renderCleanupButtons(camp, stats);

  return `
    <div class="card">
      <h3 style="margin-top:0;">Discount codes</h3>
      ${statsHtml}
      ${revenueHtml}
      ${actionHtml}
      ${cleanupHtml}
      <p class="muted" style="margin-top:12px;">Codes are single-use, per-member, expire ${camp.discount_expires_days ?? '—'} days after issue. They appear in Shopify admin → Discounts. Redemption is tracked automatically via the orders/paid webhook.</p>
    </div>
  `;
};

// Cleanup buttons surface only when there's something to delete and the
// campaign is in a terminal state — premature cleanup would remove codes the
// merchant still wants alive. Always offered post-completion.
const renderCleanupButtons = (camp: CampaignRow, stats: CodeStats): string => {
  const terminal = camp.status === 'completed' || camp.status === 'cancelled';
  if (!terminal) return '';

  const deletableTotal = stats.active + stats.redeemed + stats.expired;
  const deletableUnredeemed = stats.active + stats.expired;
  if (deletableTotal === 0) return '';

  const unredeemedBtn = deletableUnredeemed > 0
    ? `<form method="POST" action="/admin/campaigns/${camp.id}/cleanup-codes" class="inline" style="margin-right:8px;"
            onsubmit="return confirm(${JSON.stringify(`Delete ${deletableUnredeemed} unredeemed code${deletableUnredeemed === 1 ? '' : 's'} from Shopify? The codes will disappear from Shopify's Discounts list; redeemed codes will be kept for visibility.`)});">
        <input type="hidden" name="mode" value="unredeemed" />
        <button type="submit">Delete unredeemed (${deletableUnredeemed})</button>
      </form>`
    : '';

  const allBtn = `<form method="POST" action="/admin/campaigns/${camp.id}/cleanup-codes" class="inline"
        onsubmit="return confirm(${JSON.stringify(`Delete ALL ${deletableTotal} campaign codes from Shopify? Redemption history will still show on the orders themselves; only the per-code rows in Shopify's Discounts list are removed.`)});">
      <input type="hidden" name="mode" value="all" />
      <button type="submit" class="danger">Delete all (${deletableTotal})</button>
    </form>`;

  return `
    <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border);">
      <p style="margin:0 0 8px;"><strong>Clean up Shopify discount list</strong></p>
      ${unredeemedBtn}${allBtn}
    </div>
  `;
};

adminCampaigns.post('/:id/cleanup-codes', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody();
  const mode = String(form.mode ?? '');
  if (mode !== 'unredeemed' && mode !== 'all') {
    return c.json({ error: 'invalid_mode' }, 400);
  }

  const members = listMembersForCodeCleanup(camp.id, mode);
  if (members.length === 0) {
    return c.redirect(`/admin/campaigns/${camp.id}`);
  }

  let deleted = 0;
  let failed = 0;

  for (const m of members) {
    if (!m.discount_code_id) continue;
    const ok = await deleteCampaignDiscountCode(m.discount_code_id);
    if (ok) {
      markMemberCodeDeleted(m.id);
      deleted += 1;
    } else {
      failed += 1;
    }
  }

  log('info', 'campaign code cleanup complete', {
    campaignId: camp.id,
    mode,
    deleted,
    failed,
  });

  return c.html(adminShell(`Code cleanup — ${camp.name}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Cleanup complete</h2>
    <div class="card">
      <p><strong>Mode:</strong> ${escapeHtml(mode)}</p>
      <p><strong>Deleted from Shopify:</strong> ${deleted}</p>
      <p><strong>Failed:</strong> ${failed}</p>
      <p style="margin-top:16px;"><a href="/admin/campaigns/${camp.id}">Back to campaign</a></p>
    </div>
  `, 'campaigns'));
});

adminCampaigns.post('/:id/generate-discount-codes', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  if (camp.discount_percent === null || camp.discount_expires_days === null) {
    return c.html(adminShell('Generate discount codes', `
      <div class="err">Discount percentage and expiry are required. Edit the campaign to set them.</div>
      <p><a href="/admin/campaigns/${camp.id}">Back</a></p>
    `, 'campaigns'), 400);
  }

  // Eligibility: members past approved status (so they've been physically
  // shipped to or have already engaged), without an existing code. Approved-
  // but-not-yet-shipped members are also accepted so a merchant can pre-
  // generate codes if they want — the code's start time is "now" and the
  // expiry counts from there.
  const members = listMembersByCampaign(camp.id);
  const eligible = members.filter((m) =>
    !m.discount_code &&
    (m.status === 'approved' || m.status === 'shipped' || m.status === 'reviewed')
  );

  if (eligible.length === 0) {
    return c.redirect(`/admin/campaigns/${camp.id}`);
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + camp.discount_expires_days * 86400 * 1000);
  const startsAtIso = startsAt.toISOString();
  const endsAtIso = endsAt.toISOString();

  let created = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const m of eligible) {
    const code = generateCodeString(camp.discount_code_prefix);
    try {
      const result = await createCampaignDiscountCode({
        code,
        title: `${camp.name} — Member ${m.id}`,
        percentageOff: camp.discount_percent,
        startsAtIso,
        endsAtIso,
      });
      setMemberDiscountCode({ memberId: m.id, code, discountId: result.discountId });
      created += 1;
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Member ${m.id}: ${msg}`);
      log('error', 'campaign discount code create failed', {
        campaignId: camp.id,
        memberId: m.id,
        error: msg,
      });
      // Stop the batch if too many fail in a row — Shopify rate limits or
      // a missing scope would otherwise burn through every member. Three
      // consecutive failures is a reasonable canary.
      if (failed >= 3 && created === 0) break;
    }
  }

  log('info', 'campaign discount codes generated', {
    campaignId: camp.id,
    created,
    failed,
  });

  const errorList = errors.length > 0
    ? `<div class="err" style="margin-top:16px;">
        <strong>${errors.length} error${errors.length === 1 ? '' : 's'}:</strong>
        <ul>${errors.slice(0, 10).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
        ${errors.length > 10 ? `<p>… and ${errors.length - 10} more (see logs).</p>` : ''}
      </div>`
    : '';

  return c.html(adminShell(`Discount codes — ${camp.name}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Discount code generation complete</h2>
    <div class="card">
      <p><strong>Created:</strong> ${created}</p>
      <p><strong>Failed:</strong> ${failed}</p>
      ${errorList}
      <p style="margin-top:16px;"><a href="/admin/campaigns/${camp.id}">Back to campaign</a></p>
    </div>
  `, 'campaigns'));
});

// --- Capacity-warning UI helpers ---

const renderCapacityWarningStatus = (camp: CampaignRow): string => {
  if (camp.capacity_warning_threshold === null) {
    return '<span class="muted">disabled</span>';
  }
  if (camp.capacity_warning_fired_at !== null) {
    return `${camp.capacity_warning_threshold} (fired ${formatTs(camp.capacity_warning_fired_at)})
      <form method="POST" action="/admin/campaigns/${camp.id}/reset-capacity-warning" class="inline" style="margin-left:8px;">
        <button type="submit">Reset capacity warning</button>
      </form>`;
  }
  return `${camp.capacity_warning_threshold} <span class="muted">(armed)</span>`;
};

adminCampaigns.post('/:id/reset-capacity-warning', (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();
  resetCapacityWarning(camp.id);
  log('info', 'campaign capacity warning reset', { campaignId: camp.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Feedback forms ---

const renderFeedbackCard = (camp: CampaignRow): string => {
  const forms = listFeedbackFormsForCampaign(camp.id);
  const list = forms.length === 0
    ? '<p class="muted">No feedback forms yet.</p>'
    : `<ul style="margin:0; padding-left:20px;">${forms.map((f) => {
        const responses = countResponsesForForm(f.id);
        const scope = f.shopify_product_id
          ? `product ${escapeHtml(f.shopify_product_id)}`
          : 'campaign-wide';
        return `<li>
          <a href="/admin/campaigns/${camp.id}/feedback/${f.id}">${escapeHtml(f.title)}</a>
          <span class="muted">— ${scope}, ${responses} response${responses === 1 ? '' : 's'}</span>
        </li>`;
      }).join('')}</ul>`;

  return `
    <div class="card">
      <h3 style="margin-top:0;">Feedback forms</h3>
      ${list}
      <form method="POST" action="/admin/campaigns/${camp.id}/feedback" style="margin-top:16px;">
        <label>New form title</label>
        <input type="text" name="title" required maxlength="160" placeholder="e.g., How did you like Product A?" />
        <label>Tied to a specific product? (optional Shopify product id)</label>
        <input type="text" name="shopify_product_id" maxlength="64" placeholder="leave blank for campaign-wide feedback" />
        <label>Intro text (optional)</label>
        <textarea name="intro_text" rows="2" placeholder="Tell respondents what this feedback will be used for."></textarea>
        <div style="margin-top:12px;">
          <button type="submit">Create feedback form</button>
        </div>
      </form>
      <p class="muted" style="margin-top:12px;">Forms get a shared URL — anonymous by design. Embed in a Shopify Page with <code>&lt;div data-campaign-feedback-form="&lt;key&gt;"&gt;&lt;/div&gt;</code>.</p>
    </div>
  `;
};

adminCampaigns.post('/:id/feedback', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody();
  const title = String(form.title ?? '').trim().slice(0, 160);
  const productId = String(form.shopify_product_id ?? '').trim() || null;
  const introText = String(form.intro_text ?? '').trim() || null;
  if (!title) {
    return c.json({ error: 'missing_title' }, 400);
  }

  const created = createFeedbackForm({
    campaignId: camp.id,
    shopifyProductId: productId,
    title,
    introText,
  });
  log('info', 'feedback form created', { campaignId: camp.id, formId: created.id });
  return c.redirect(`/admin/campaigns/${camp.id}/feedback/${created.id}`);
});

adminCampaigns.get('/:id/feedback/:formId', (c) => {
  const id = Number(c.req.param('id'));
  const formId = Number(c.req.param('formId'));
  const camp = findCampaignById(id);
  const form = findFeedbackFormById(formId);
  if (!camp || !form || form.campaign_id !== camp.id) return c.notFound();

  const questions = listFeedbackQuestionsForForm(form.id);
  const responseCount = countResponsesForForm(form.id);

  const questionsHtml = questions.length === 0
    ? '<p class="muted">No questions yet. Add one below.</p>'
    : `<ol>${questions.map((q) => {
        const opts = parseQuestionOptions(q);
        const optsHtml = opts.length > 0
          ? `<ul class="muted" style="margin:4px 0 0;">${opts.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
          : '';
        return `<li style="margin-bottom:12px;">
          <strong>${escapeHtml(q.prompt)}</strong>
          <span class="muted">— ${escapeHtml(FEEDBACK_QUESTION_TYPE_LABELS[q.type])}${q.required ? ', required' : ''}</span>
          ${optsHtml}
          <form method="POST" action="/admin/campaigns/${camp.id}/feedback/${form.id}/questions/${q.id}/delete" class="inline" style="margin-left:8px;"
                onsubmit="return confirm('Delete this question? Existing responses will keep their answers but they will no longer show in the form.');">
            <button type="submit" class="danger">Delete</button>
          </form>
        </li>`;
      }).join('')}</ol>`;

  const embedSnippet = `<div data-campaign-feedback-form="${form.access_key}"></div>`;

  return c.html(adminShell(`Feedback — ${form.title}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>${escapeHtml(form.title)}</h2>
    <p class="muted">${responseCount} response${responseCount === 1 ? '' : 's'}${form.shopify_product_id ? ` · tied to product ${escapeHtml(form.shopify_product_id)}` : ' · campaign-wide'}</p>
    ${responseCount > 0 ? `<p><a href="/admin/campaigns/${camp.id}/feedback/${form.id}/report">View report →</a></p>` : ''}

    <div class="card">
      <h3 style="margin-top:0;">Questions</h3>
      ${questionsHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Add question</h3>
      <form method="POST" action="/admin/campaigns/${camp.id}/feedback/${form.id}/questions">
        <label>Question prompt</label>
        <input type="text" name="prompt" required maxlength="500" />

        <label>Type</label>
        <select name="type" required>
          ${FEEDBACK_QUESTION_TYPES.map((t) => `<option value="${t}">${escapeHtml(FEEDBACK_QUESTION_TYPE_LABELS[t])}</option>`).join('')}
        </select>

        <label>Options (for choice questions; one per line)</label>
        <textarea name="options" rows="4" placeholder="Leave blank for non-choice questions"></textarea>

        <label style="display:flex; gap:8px; align-items:center; font-weight:normal;">
          <input type="checkbox" name="required" />
          <span>Required</span>
        </label>

        <div style="margin-top:12px;">
          <button type="submit" class="primary">Add question</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Public form</h3>
      <p>To collect responses, create a Page in Shopify admin and paste:</p>
      <pre style="background:var(--surface-alt); padding:12px; border-radius:4px; overflow-x:auto;">${escapeHtml(embedSnippet)}</pre>
      <p class="muted">Send the URL of the resulting Shopify Page to your campaign participants — typically as part of the shipped-notification or review-reminder emails.</p>
    </div>

    <div class="card" style="background:var(--surface-alt);">
      <form method="POST" action="/admin/campaigns/${camp.id}/feedback/${form.id}/delete"
            onsubmit="return confirm('Delete this feedback form and ALL its responses? This cannot be undone.');">
        <button type="submit" class="danger">Delete this feedback form</button>
      </form>
    </div>
  `, 'campaigns'));
});

adminCampaigns.post('/:id/feedback/:formId/questions', async (c) => {
  const id = Number(c.req.param('id'));
  const formId = Number(c.req.param('formId'));
  const camp = findCampaignById(id);
  const form = findFeedbackFormById(formId);
  if (!camp || !form || form.campaign_id !== camp.id) return c.notFound();

  const body = await c.req.parseBody();
  const prompt = String(body.prompt ?? '').trim().slice(0, 500);
  const type = String(body.type ?? '');
  const required = body.required === 'on';
  const optionsRaw = String(body.options ?? '');

  if (!prompt) return c.json({ error: 'missing_prompt' }, 400);
  if (!isFeedbackQuestionType(type)) return c.json({ error: 'invalid_type' }, 400);

  let options: string[] | null = null;
  if (type === 'single_choice' || type === 'multi_choice') {
    const lines = optionsRaw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) {
      return c.json({ error: 'missing_options' }, 400);
    }
    options = lines;
  }

  addFeedbackQuestion({ formId: form.id, type, prompt, required, options });
  log('info', 'feedback question added', { formId: form.id, type });
  return c.redirect(`/admin/campaigns/${camp.id}/feedback/${form.id}`);
});

adminCampaigns.post('/:id/feedback/:formId/questions/:questionId/delete', (c) => {
  const id = Number(c.req.param('id'));
  const formId = Number(c.req.param('formId'));
  const questionId = Number(c.req.param('questionId'));
  const camp = findCampaignById(id);
  const form = findFeedbackFormById(formId);
  if (!camp || !form || form.campaign_id !== camp.id) return c.notFound();

  deleteFeedbackQuestion(questionId);
  return c.redirect(`/admin/campaigns/${camp.id}/feedback/${form.id}`);
});

adminCampaigns.post('/:id/feedback/:formId/delete', (c) => {
  const id = Number(c.req.param('id'));
  const formId = Number(c.req.param('formId'));
  const camp = findCampaignById(id);
  const form = findFeedbackFormById(formId);
  if (!camp || !form || form.campaign_id !== camp.id) return c.notFound();

  deleteFeedbackForm(form.id);
  log('info', 'feedback form deleted', { formId: form.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Feedback reporting ---

const renderAggregateBlock = (q: FeedbackQuestionRow, agg: QuestionAggregate): string => {
  if (agg.type === 'rating_1_5') {
    const max = Math.max(1, ...agg.distribution);
    const bars = agg.distribution.map((count, i) => {
      const width = Math.round((count / max) * 100);
      return `<div style="display:flex; align-items:center; gap:8px; margin:4px 0;">
        <span style="width:32px; text-align:right;">${i + 1}★</span>
        <div style="flex:1; background:#eee; border-radius:3px; height:14px; position:relative;">
          <div style="background:var(--accent); width:${width}%; height:100%; border-radius:3px;"></div>
        </div>
        <span class="muted" style="width:40px;">${count}</span>
      </div>`;
    }).join('');
    const avgLabel = agg.average !== null ? agg.average.toFixed(2) : 'n/a';
    return `<p class="muted" style="margin:0 0 4px;">Average: ${avgLabel} · ${agg.total} response${agg.total === 1 ? '' : 's'}</p>${bars}`;
  }
  if (agg.type === 'single_choice' || agg.type === 'multi_choice') {
    const entries = Object.entries(agg.counts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, n]) => n));
    if (entries.length === 0) return '<p class="muted">No responses yet.</p>';
    const bars = entries.map(([opt, n]) => {
      const width = Math.round((n / max) * 100);
      return `<div style="display:flex; align-items:center; gap:8px; margin:4px 0;">
        <span style="min-width:120px;">${escapeHtml(opt)}</span>
        <div style="flex:1; background:#eee; border-radius:3px; height:14px;">
          <div style="background:var(--accent); width:${width}%; height:100%; border-radius:3px;"></div>
        </div>
        <span class="muted" style="width:40px;">${n}</span>
      </div>`;
    }).join('');
    return `<p class="muted" style="margin:0 0 4px;">${agg.total} response${agg.total === 1 ? '' : 's'}</p>${bars}`;
  }
  // text type
  if (agg.responses.length === 0) return '<p class="muted">No responses yet.</p>';
  const items = agg.responses.map((r) => `
    <li style="margin-bottom:8px;">
      <div style="white-space:pre-wrap;">${escapeHtml(r.text)}</div>
      <div class="muted" style="font-size:12px;">${r.name ? escapeHtml(r.name) + ' · ' : ''}${formatTs(r.submittedAt)}</div>
    </li>
  `).join('');
  void q;
  return `<p class="muted" style="margin:0 0 4px;">${agg.total} response${agg.total === 1 ? '' : 's'}</p><ul style="list-style:none; padding-left:0;">${items}</ul>`;
};

adminCampaigns.get('/:id/feedback/:formId/report', (c) => {
  const id = Number(c.req.param('id'));
  const formId = Number(c.req.param('formId'));
  const camp = findCampaignById(id);
  const form = findFeedbackFormById(formId);
  if (!camp || !form || form.campaign_id !== camp.id) return c.notFound();

  const questions = listFeedbackQuestionsForForm(form.id);
  const responseCount = countResponsesForForm(form.id);

  const blocksHtml = questions.length === 0
    ? '<p class="muted">No questions configured.</p>'
    : questions.map((q) => {
        const agg = aggregateFeedbackQuestion(q);
        return `<div class="card">
          <h3 style="margin-top:0;">${escapeHtml(q.prompt)}</h3>
          ${renderAggregateBlock(q, agg)}
        </div>`;
      }).join('');

  return c.html(adminShell(`Report — ${form.title}`, `
    <p><a href="/admin/campaigns/${camp.id}/feedback/${form.id}">← ${escapeHtml(form.title)}</a></p>
    <h2>${escapeHtml(form.title)} — Report</h2>
    <p class="muted">${responseCount} total response${responseCount === 1 ? '' : 's'}</p>
    ${blocksHtml}
  `, 'campaigns'));
});

// --- Retention queue ---

const renderQuarantinedRow = (m: QuarantinedMemberRow): string => {
  const data = parseApplicationData(m);
  const name = data ? `${data.firstName} ${data.lastName}`.trim() : '(unparseable)';
  const email = data?.email ?? '';
  return `<tr>
    <td><input type="checkbox" name="member_id" value="${m.id}" /></td>
    <td><a href="/admin/campaigns/${m.campaign_id}">${escapeHtml(m.campaign_name)}</a></td>
    <td>${escapeHtml(name)}<br /><span class="muted">${escapeHtml(email)}</span></td>
    <td class="muted">${formatTs(m.created_at)}</td>
  </tr>`;
};

adminCampaigns.get('/retention-queue', (c) => {
  const rows = listQuarantinedMembers();
  if (rows.length === 0) {
    return c.html(adminShell('Retention queue', `
      <p><a href="/admin/campaigns">← Campaigns</a></p>
      <h2>Retention queue</h2>
      <p class="muted">No shipping addresses are pending purge.</p>
      <p>Shipping addresses are quarantined automatically when a campaign moves to Completed or Cancelled. They land here for review and confirmation before the actual deletion.</p>
    `, 'campaigns'));
  }

  const tableHtml = `
    <form method="POST" action="/admin/campaigns/retention-queue/purge"
          onsubmit="return confirm('Permanently delete the selected shipping addresses? This cannot be undone.');">
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" onclick="document.querySelectorAll('input[name=member_id]').forEach(cb=>cb.checked=this.checked)" /></th>
            <th>Campaign</th>
            <th>Applicant</th>
            <th>Quarantined since</th>
          </tr>
        </thead>
        <tbody>${rows.map(renderQuarantinedRow).join('')}</tbody>
      </table>
      <p style="margin-top:16px;">
        <button type="submit" class="primary">Permanently delete selected shipping addresses</button>
      </p>
    </form>
  `;

  return c.html(adminShell('Retention queue', `
    <p><a href="/admin/campaigns">← Campaigns</a></p>
    <h2>Retention queue <span class="muted" style="font-size:14px;font-weight:normal;">· ${rows.length} pending</span></h2>
    <p>These shipping addresses are quarantined — the rest of the app no longer reads them. Confirm to hard-delete the JSON column. Name and email stay on the application record.</p>
    ${renderMemberPillStyles()}
    ${tableHtml}
  `, 'campaigns'));
});

adminCampaigns.post('/retention-queue/purge', async (c) => {
  const form = await c.req.parseBody({ all: true });
  const raw = form.member_id;
  const ids: number[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const n = Number(v);
      if (Number.isInteger(n)) ids.push(n);
    }
  } else if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n)) ids.push(n);
  }

  if (ids.length === 0) {
    return c.redirect('/admin/campaigns/retention-queue');
  }

  const purged = confirmPurgeShippingAddresses(ids);
  log('info', 'campaign retention purge confirmed', { requested: ids.length, purged });
  return c.redirect('/admin/campaigns/retention-queue');
});

// --- Suppress unused-import warnings for symbols later steps will use ---
void findTermsVersion;
void CAMPAIGN_STATUSES;

export default adminCampaigns;
