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
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { daysToSec, nowSec } from '../lib/time.js';
import { log } from '../lib/logger.js';
import {
  renderTextareaCursorFixScript,
  ADMIN_TEXTAREA_FIX_CSS,
} from '../lib/admin-textarea-fix.js';
import {
  sendCampaignBatch,
  countEligibleForTrigger,
  type CampaignBatchTrigger,
} from '../email/dispatch-campaign.js';
import { deleteCampaignDiscountCode } from '../shopify/discount-codes.js';
import { syncAllProductsToCache, listCachedProducts } from '../shopify/product-info.js';
import {
  cloneTemplateForCampaign,
  findEmailTemplateById,
  findCampaignTemplateRow,
  findActiveTemplateForTriggerCampaignAware,
  updateEmailTemplateById,
} from '../db/queries.js';
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
import { EMAIL_VARIABLES } from '../email/variables.js';

// Campaign-tagged sample invitations get a longer TTL than the default 90-day
// SAMPLE_INVITE_TTL_DAYS because the campaign's email sequence (shipped →
// reminder 2-3 weeks later → launch a few weeks after that) plus straggler
// reviews easily reaches months. 180 days leaves comfortable runway.
const CAMPAIGN_INVITATION_TTL_DAYS = 180;

const adminCampaigns = new Hono();

// --- Helpers ---

// Slug validator. Must be URL-safe — lowercase letters/digits/hyphens, no
// leading/trailing hyphens, length 1-64. Same regex is enforced client-side
// via the input's `pattern` attribute (see the slug field below).
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_PATTERN_HTML = '[a-z0-9]+(?:-[a-z0-9]+)*';
const isValidSlug = (s: string): boolean => s.length >= 1 && s.length <= 64 && SLUG_RE.test(s);

// Boilerplate text seeded into the New Campaign form. The merchant edits
// before launch; this is just a starting point so the form isn't empty.
// "We'll refine the language before we launch" — per the design conversation.
const DEFAULT_TERMS_SUMMARY = `\
- Submitting this application is your consent to receive four emails about this campaign (this confirmation, a shipped notification, a review reminder, and a launch announcement). These emails are part of participating.
- We'll use your shipping address only to mail your sample pack.
- There's no payment for participating beyond the sample pack and any launch-day discount we choose to send.
- Applications are reviewed manually — submitting doesn't guarantee selection.
- You can withdraw before we ship by replying to the confirmation email.`;

const DEFAULT_TERMS_BODY = `\
By submitting this application, you agree to the following terms:

1. Participation. Submission is an application, not a guarantee of selection. We review every application manually and select a subset of applicants to receive sample packs.

2. Communications. You consent to receive up to four emails directly tied to this campaign: an application confirmation, a shipped notification, a review reminder, and a launch announcement. These emails are a non-revocable condition of participation; standard transactional / marketing unsubscribe preferences do not apply.

3. Use of your information. We collect your name, email address, and shipping address solely to communicate with you about this campaign and to ship your sample pack. We do not sell or share this information with third parties for marketing purposes.

4. No compensation. You are not compensated for participating beyond the sample pack itself and any launch-day discount code we choose to send. There is no obligation to write a review, but we hope you will.

5. Reviews. If you choose to write a review using the links provided, your review will be published on our store under the "Verified Reviewer" badge. We may moderate reviews per our review policy but will not edit the substance of your opinion.

6. Withdrawal. You may withdraw before we ship your sample pack by replying to the confirmation email. After shipment, we cannot recall the pack, but you can stop receiving further campaign emails by replying with "stop."

7. Data retention. We retain your name and email for our records. Your shipping address is automatically purged shortly after the campaign ends.

8. Updates. These terms apply as of the date you submit the application; later edits to the terms do not retroactively change the agreement you accepted.`;

// Styles for the campaign forms. Distinguishes helper text from inputs so
// the merchant can scan a long form without confusing labels for placeholder
// values. Injected once per form-page render.
const renderCampaignFormStyles = (): string => `
  <style>
    .campaign-helper {
      font-size: 12px;
      font-style: italic;
      color: var(--muted);
      margin: 4px 0 12px 4px;
      line-height: 1.4;
    }
    .slug-preview {
      font-size: 12px;
      color: var(--muted);
      margin: 4px 0 0 4px;
    }
    .slug-preview code {
      font-style: normal;
      background: var(--surface-alt);
      padding: 1px 6px;
      border-radius: 3px;
    }
    .product-picker {
      /* Two-column grid (capped at 2). On narrow viewports a media query
         collapses to one column. Previously auto-fit could yield 3+ columns
         on wide screens, which the merchant didn't want. */
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 16px;
      max-height: 360px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      background: var(--surface);
    }
    @media (max-width: 620px) {
      .product-picker { grid-template-columns: 1fr; }
    }
    .product-picker label {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      font-weight: normal;
      cursor: pointer;
    }
    .product-picker label img {
      width: 32px; height: 32px; object-fit: cover; border-radius: 3px;
      background: var(--surface-alt);
    }
    .product-picker .product-title { flex: 1; }
    .product-picker .product-id {
      font-size: 11px; color: var(--muted); font-family: monospace;
    }
    /* Side-by-side rows (#4, #5): two field-blocks per row at wide widths,
       one per row on narrow. Auto-fit with min 240px breakpoint. */
    .form-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 0 24px;
      align-items: start;
    }
    .form-row .field-block { margin-top: 0; }
    .discount-section {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 16px;
      margin-top: 12px;
    }
    .discount-section.disabled { opacity: 0.55; }
    .discount-section.disabled input { background: var(--surface-alt); }
    .field-block { margin: 16px 0; }
    .field-block label { margin-top: 0; }
    /* Threshold preview: muted + italic like the surrounding helper text,
       but the "X of Y" count inside <strong> is upsized + bolded + uses the
       normal text color so it stands out. */
    .campaign-threshold-preview {
      display: none;  /* JS toggles to block when a preview is available */
      margin: 8px 0 0;
      font-size: 12px;
      font-style: italic;
      color: var(--muted);
      line-height: 1.4;
    }
    .campaign-threshold-preview strong {
      font-size: 18px;
      font-weight: 600;
      font-style: normal;
      color: var(--text);
    }
    /* Slug live-validation error (#2). */
    .campaign-validation-error {
      margin: 4px 0 0;
      font-size: 12px;
      color: #b00;
      font-weight: 500;
    }
    /* Defensive: terms textareas explicitly opt out of any transform/filter
       inherited from a parent so click coords match the underlying caret.
       Same family of issue as the profanity textarea — paranoia layer for
       campaign forms (#7). */
    .campaign-terms-input {
      filter: none !important;
      transform: none !important;
      position: relative;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }
  </style>
`;

// Renders the percentage-→-absolute-count helper line beneath the threshold
// input. Pure JS that recomputes on input; admin sees the live count.
const renderThresholdHelperScript = (): string => `
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const limit = document.getElementById('participant_limit');
      const pct   = document.getElementById('threshold_pct');
      const preview = document.getElementById('threshold_preview');
      const slugIn = document.getElementById('slug');
      const slugOut = document.getElementById('slug_preview_out');
      const slugErr = document.getElementById('slug_validation_msg');
      const codePrefix = document.getElementById('discount_code_prefix');
      const codePreview = document.getElementById('discount_code_preview');
      const discountToggle = document.getElementById('discount_enabled');
      const discountSection = document.getElementById('discount-section');

      // Threshold "Warning will fire at X of Y" — prominent (#3): the count is
      // wrapped in <strong> with bigger font (handled by CSS class). Hidden
      // entirely when there's nothing useful to show.
      const recalc = () => {
        if (!preview) return;
        const lim = parseInt(limit && limit.value, 10);
        const p = parseInt(pct && pct.value, 10);
        if (!lim || lim <= 0) {
          preview.style.display = 'block';
          preview.innerHTML = 'Unlimited campaign — capacity warning disabled.';
          return;
        }
        if (!p || isNaN(p)) { preview.style.display = 'none'; preview.innerHTML = ''; return; }
        const at = Math.round((p / 100) * lim);
        preview.style.display = 'block';
        preview.innerHTML = 'Warning will fire at <strong>' + at + ' of ' + lim + '</strong> applications.';
      };
      limit && limit.addEventListener('input', recalc);
      pct && pct.addEventListener('input', recalc);
      recalc();

      // URL slug: live preview + live validation (#2). Validates on input AND
      // blur so users see the error before they click Create. Empty string
      // hides the error (required-field validation handles that on submit).
      const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
      const recalcSlug = () => {
        if (!slugIn || !slugOut) return;
        const v = (slugIn.value || '').trim();
        slugOut.textContent = v ? v : 'your-slug';
        if (!slugErr) return;
        if (v === '') { slugErr.style.display = 'none'; return; }
        if (SLUG_RE.test(v)) {
          slugErr.style.display = 'none';
        } else {
          slugErr.style.display = 'block';
          slugErr.textContent = 'Slug must be lowercase letters, digits, and hyphens only — no spaces, no capitals, no special characters.';
        }
      };
      slugIn && slugIn.addEventListener('input', recalcSlug);
      slugIn && slugIn.addEventListener('blur', recalcSlug);
      recalcSlug();

      const recalcCode = () => {
        if (!codePrefix || !codePreview) return;
        const v = (codePrefix.value || '').trim();
        codePreview.textContent = v + 'XXXXXXXX';
      };
      codePrefix && codePrefix.addEventListener('input', recalcCode);
      recalcCode();

      const recalcDiscount = () => {
        if (!discountToggle || !discountSection) return;
        const on = discountToggle.checked;
        discountSection.classList.toggle('disabled', !on);
        discountSection.querySelectorAll('input').forEach((el) => {
          if (el === discountToggle) return;
          el.disabled = !on;
        });
      };
      discountToggle && discountToggle.addEventListener('change', recalcDiscount);
      recalcDiscount();

      // Defensive selection-sync for terms textareas.
      //
      // Symptom (Shopify embedded admin iframe, first interaction after page
      // load): visible cursor goes to the click position, but the underlying
      // selection state stays at (0,0). The FIRST keystroke gets inserted at
      // position 0 regardless of where the cursor visually appears. Subsequent
      // keystrokes work normally because the bad first input "warms up" the
      // textarea's internal model.
      //
      // The mouseup-based setSelectionRange fix from the previous round
      // didn't help — by the time 'input' fires, the selection state is
      // already wrong. So this version is more aggressive: catch the FIRST
      // input event, compare what actually landed in the textarea against
      // what should have landed if the insert respected the saved cursor
      // position, and if the bug pattern matches (char inserted at 0 instead
      // of the expected spot), splice it to the right position in-place.
      //
      // The detection is tight enough not to false-positive on legitimate
      // insert-at-home (which would mean the saved selection was already at
      // position 0 anyway, in which case we skip the correction).
      document.querySelectorAll('.campaign-terms-input').forEach((ta) => {
        // Belt-and-suspenders: turn off browser features that have been
        // observed to interfere with textarea selection state.
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('spellcheck', 'false');

        let firstInputDone = false;
        let savedSelection = null;
        let prevValue = ta.value;

        // Track the most recent intended cursor position across both mouse
        // and keyboard navigation. setTimeout(0) defers until after the
        // browser has finished its own selection update for this event.
        const saveSelection = () => {
          savedSelection = { start: ta.selectionStart, end: ta.selectionEnd };
        };
        ta.addEventListener('mouseup', () => { setTimeout(saveSelection, 0); });
        ta.addEventListener('keyup', () => { setTimeout(saveSelection, 0); });
        ta.addEventListener('focus', () => { setTimeout(saveSelection, 0); });

        ta.addEventListener('input', (e) => {
          const thisIsFirstInput = !firstInputDone;
          firstInputDone = true;

          if (thisIsFirstInput &&
              e.inputType === 'insertText' &&
              e.data &&
              savedSelection &&
              savedSelection.start > 0) {
            const expectedPos = savedSelection.start;
            const insertedChar = e.data;
            // What the value would be if the insert went to expectedPos:
            const expectedValue = prevValue.substring(0, expectedPos) + insertedChar + prevValue.substring(expectedPos);
            const actualValue = ta.value;
            // What the value would be if the bug fired (insert at position 0):
            const bugValue = insertedChar + prevValue;

            if (actualValue !== expectedValue && actualValue === bugValue) {
              // Bug pattern matched — repair in-place.
              ta.value = expectedValue;
              ta.setSelectionRange(expectedPos + 1, expectedPos + 1);
              savedSelection = { start: expectedPos + 1, end: expectedPos + 1 };
            }
          }

          prevValue = ta.value;
        });
      });
    });
  </script>
`;

// The product-picker checklist. Renders all cached products as checkboxes;
// selected ids are POSTed as repeated product_id values. Two-column responsive
// grid that collapses to one column on narrow viewports.
//
// IMPORTANT: this returns ONLY the picker list — no <form> inside. The
// "Refresh from Shopify" button is a SEPARATE form, rendered by the caller
// via renderRefreshProductsForm() and associated with the picker button
// via the HTML `form="..."` attribute. Previously the refresh button was a
// nested <form>, which silently closed the outer campaign form and caused
// the Create button to do nothing on click (real bug, 2026-06-02).
const renderProductPicker = (selectedIds: Set<string>, refreshFormId: string): string => {
  const products = listCachedProducts();
  const refreshButton = `<button type="submit" form="${escapeHtml(refreshFormId)}">Refresh from Shopify</button>`;
  if (products.length === 0) {
    return `
      <p class="campaign-helper">No products cached yet. Click the button to load every product in your Shopify store into the picker.</p>
      <div style="margin:8px 0;">${refreshButton}</div>
    `;
  }
  const items = products.map((p) => {
    const checked = selectedIds.has(p.shopifyProductId) ? 'checked' : '';
    const img = p.featuredImageUrl
      ? `<img src="${escapeHtml(p.featuredImageUrl)}" alt="" />`
      : `<span style="display:inline-block;width:32px;height:32px;background:var(--surface-alt);border-radius:3px;"></span>`;
    return `<label>
      <input type="checkbox" name="product_id" value="${escapeHtml(p.shopifyProductId)}" ${checked} />
      ${img}
      <span class="product-title">${escapeHtml(p.title)}</span>
      <span class="product-id">${escapeHtml(p.shopifyProductId)}</span>
    </label>`;
  }).join('');
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <span class="campaign-helper" style="margin:0;">${products.length} cached product${products.length === 1 ? '' : 's'}. Refresh after adding new products in Shopify. (Refreshing reloads the page; you'll lose unsaved form values.)</span>
      ${refreshButton}
    </div>
    <div class="product-picker" style="margin-top:8px;">${items}</div>
  `;
};

// Sibling form for the "Refresh from Shopify" button. Rendered OUTSIDE the
// main campaign form (no nesting); the picker's button is associated to it
// via form="<id>". Returns the form markup + the matching id so the caller
// can render the picker with the right id.
const renderRefreshProductsForm = (returnTo: string): { html: string; id: string } => {
  const id = 'refresh-products-form';
  const html = `
    <form id="${id}" method="POST" action="/admin/campaigns/refresh-product-cache" style="display:none;">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />
    </form>
  `;
  return { html, id };
};

// Existing-data shape passed into the shared form renderer. Both create
// (with null) and edit (with the row) use this.
interface CampaignFormData {
  name: string;
  slug: string;
  slugLocked: boolean;          // true on edit — we don't let merchants change slugs
  participantLimit: number;
  thresholdPct: number | null;  // percentage (1-100); null = disabled
  selectedProductIds: Set<string>;
  discountEnabled: boolean;
  discountPercent: number | null;
  discountExpiresDays: number | null;
  discountCodePrefix: string;
  // Per-recipient redemption count for the unique code each member receives.
  // null = unset (form renders blank with placeholder); 1+ = explicit value.
  discountUsageLimit: number | null;
  termsSummary: string;
  termsBody: string;
  termsLocked: boolean;         // true on edit — terms have their own editor
}

// Computes the suggested percentage from existing absolute count + limit, for
// pre-filling the threshold input on edit. Falls back to 80 if no value.
const inferThresholdPct = (threshold: number | null, limit: number): number | null => {
  if (threshold === null || limit <= 0) return null;
  return Math.round((threshold / limit) * 100);
};

const renderCampaignFormFields = (data: CampaignFormData, refreshFormId: string): string => {
  const slugInput = data.slugLocked
    ? `<input type="text" name="slug" value="${escapeHtml(data.slug)}" disabled />
       <p class="campaign-helper">Slug can't be changed after creation.</p>`
    : `<input type="text" id="slug" name="slug" required maxlength="64"
              pattern="${SLUG_PATTERN_HTML}"
              value="${escapeHtml(data.slug)}"
              placeholder="summer26" />
       <p id="slug_validation_msg" class="campaign-validation-error" style="display:none;"></p>
       <p class="campaign-helper">A short identifier you'll paste into your Shopify application Page so the widget knows which campaign to render — like <code>&lt;div data-campaign-form="<span id="slug_preview_out">${escapeHtml(data.slug || 'your-slug')}</span>"&gt;&lt;/div&gt;</code>. Customers don't see this; only used as the embed handle. Lowercase letters, digits, and hyphens only — no spaces.</p>`;

  return `
    <div class="field-block">
      <label>Campaign name</label>
      <input type="text" name="name" required maxlength="120"
             value="${escapeHtml(data.name)}"
             placeholder="e.g., Summer 26 Sample Program" />
      <p class="campaign-helper">Shown in the admin and used as the heading on the public application form. Customers will see this.</p>
    </div>

    <div class="field-block">
      <label>URL slug</label>
      ${slugInput}
    </div>

    <!-- Side-by-side layout (#4): participant limit + capacity threshold sit
         next to each other on wide screens, stack on narrow. The .form-row
         CSS handles the responsive switch. -->
    <div class="form-row">
      <div class="field-block">
        <label>Participant limit</label>
        <input type="number" id="participant_limit" name="participant_limit"
               required min="0" max="100000"
               value="${data.participantLimit}" />
        <p class="campaign-helper">Maximum number of approved participants. When the application count reaches this number, the form auto-closes. Enter <strong>0</strong> for no limit (also disables the capacity warning).</p>
      </div>

      <div class="field-block">
        <label>Capacity-warning threshold</label>
        <input type="number" id="threshold_pct" name="threshold_pct"
               min="1" max="100"
               value="${data.thresholdPct ?? ''}"
               placeholder="80" />
        <p class="campaign-helper">Send a warning email when the application count crosses this percentage of the participant limit. Leave blank to disable.</p>
        <p id="threshold_preview" class="campaign-threshold-preview"></p>
      </div>
    </div>

    <h3 style="margin-top:32px;">Products in this campaign</h3>
    ${renderProductPicker(data.selectedProductIds, refreshFormId)}
    <p class="campaign-helper">Approved applicants get a sample-invitation review link for each selected product. Variant selection is fixed per product for now — applicant choice of variants is a future feature.</p>

    <h3 style="margin-top:32px;">Launch discount</h3>
    <div class="field-block">
      <label style="display:flex; align-items:center; gap:8px; font-weight:normal;">
        <input type="checkbox" id="discount_enabled" name="discount_enabled"
               ${data.discountEnabled ? 'checked' : ''} />
        <span>Send a discount code with the launch-thanks email</span>
      </label>
    </div>
    <div id="discount-section" class="discount-section${data.discountEnabled ? '' : ' disabled'}">
      <!-- Side-by-side discount params: percentage off + expiry + usage limit.
           The form-row grid will give 3 columns at wide widths, 2 at medium,
           1 on narrow. -->
      <div class="form-row">
        <div class="field-block">
          <label>Percentage off</label>
          <input type="number" name="discount_percent" min="1" max="100"
                 value="${data.discountPercent ?? ''}" placeholder="Please enter a percentage (1-100)" />
          <p class="campaign-helper">Whole-number percentage off each order.</p>
        </div>
        <div class="field-block">
          <label>Code expiry (days from when sent)</label>
          <input type="number" name="discount_expires_days" min="1" max="3650"
                 value="${data.discountExpiresDays ?? ''}" placeholder="Please enter number of days" />
          <p class="campaign-helper">Each code's expiry counts from the moment the launch email is sent, not from when the campaign is created.</p>
        </div>
        <div class="field-block">
          <label>Uses per code</label>
          <input type="number" name="discount_usage_limit" min="1" max="1000"
                 value="${data.discountUsageLimit ?? ''}" placeholder="Please enter number of uses" />
          <p class="campaign-helper">Each participant receives a <strong>unique</strong> code; this is how many times that participant's code can be redeemed. <code>1</code> = single-use (default for one-shot launch thanks). Higher values let the same participant come back and redeem multiple times before the code expires.</p>
        </div>
      </div>
      <div class="field-block">
        <label>Code prefix (optional)</label>
        <input type="text" id="discount_code_prefix" name="discount_code_prefix"
               maxlength="16" value="${escapeHtml(data.discountCodePrefix)}"
               placeholder="S26-" />
        <p class="campaign-helper">Example code: <code><span id="discount_code_preview">${escapeHtml(data.discountCodePrefix)}XXXXXXXX</span></code> — the X's become an 8-character random suffix (no O/0/I/1 for legibility).</p>
      </div>
    </div>

    ${data.termsLocked ? '' : `
      <h3 style="margin-top:32px;">Initial terms</h3>
      <div class="field-block">
        <label>Plain-language summary</label>
        <textarea name="terms_summary" class="campaign-terms-input" rows="6" required>${escapeHtml(data.termsSummary)}</textarea>
        <p class="campaign-helper">A short summary of what the applicant is agreeing to. Shown prominently above the full terms on the application form. Use plain language — most readers won't scroll to the full terms.</p>
      </div>
      <div class="field-block">
        <label>Full terms</label>
        <textarea name="terms_body" class="campaign-terms-input" rows="14" required>${escapeHtml(data.termsBody)}</textarea>
        <p class="campaign-helper">The legal terms the applicant agrees to. The boilerplate is a starting point — refine the language before launch. Editing later creates a new version snapshot; existing applicants stay tied to the version they accepted.</p>
      </div>
    `}
  `;
};

const parseIntOrNull = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
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
  const data: CampaignFormData = {
    name: '',
    slug: '',
    slugLocked: false,
    participantLimit: 80,
    thresholdPct: 80,
    selectedProductIds: new Set<string>(),
    discountEnabled: true,
    // Defaults are null/blank so the merchant explicitly enters values and
    // doesn't get a pre-filled "40%" they didn't intend. Server-side
    // validation enforces non-null when discountEnabled.
    discountPercent: null,
    discountExpiresDays: null,
    discountCodePrefix: '',
    discountUsageLimit: null,
    termsSummary: DEFAULT_TERMS_SUMMARY,
    termsBody: DEFAULT_TERMS_BODY,
    termsLocked: false,
  };
  const refresh = renderRefreshProductsForm('/admin/campaigns/new');
  return c.html(adminShell('New campaign', `
    ${renderCampaignFormStyles()}
    <p><a href="/admin/campaigns">← Campaigns</a></p>
    <h2>New campaign</h2>
    ${refresh.html}
    <form method="POST" action="/admin/campaigns" class="card" id="campaign-create-form">
      ${renderCampaignFormFields(data, refresh.id)}
      <div style="margin-top:24px; display:flex; gap:12px;">
        <button type="submit" class="primary">Create campaign (draft)</button>
        <a href="/admin/campaigns" style="align-self:center;">Cancel</a>
      </div>
    </form>
    ${renderThresholdHelperScript()}
  `, 'campaigns'));
});

// --- Create action ---

adminCampaigns.post('/', async (c) => {
  const form = await c.req.parseBody({ all: true });
  const name = String(form.name ?? '').trim();
  const slug = String(form.slug ?? '').trim().toLowerCase();
  const participantLimit = parseIntOrNull(form.participant_limit);
  const thresholdPct = parseIntOrNull(form.threshold_pct);
  const discountEnabled = form.discount_enabled === 'on';
  const discountPercent = discountEnabled ? parseIntOrNull(form.discount_percent) : null;
  const discountExpiresDays = discountEnabled ? parseIntOrNull(form.discount_expires_days) : null;
  const discountCodePrefix = String(form.discount_code_prefix ?? '').trim() || null;
  const discountUsageLimit = discountEnabled ? parseIntOrNull(form.discount_usage_limit) : null;
  const termsSummary = String(form.terms_summary ?? '').trim();
  const termsBody = String(form.terms_body ?? '').trim();

  // Multi-valued product_id form fields → array of product ids.
  const productIdsRaw = form.product_id;
  const selectedIds: string[] = Array.isArray(productIdsRaw)
    ? productIdsRaw.filter((v): v is string => typeof v === 'string')
    : (typeof productIdsRaw === 'string' ? [productIdsRaw] : []);

  const errors: string[] = [];
  if (!name) errors.push('Name is required.');
  if (!slug || !isValidSlug(slug)) errors.push('Slug must be lowercase letters, digits, and hyphens.');
  if (participantLimit === null || participantLimit < 0) errors.push('Participant limit must be 0 or greater (0 = unlimited).');
  // Absolute threshold derived from percentage × limit. Capped at limit;
  // disabled entirely when limit is 0 (unlimited campaigns).
  let capacityThreshold: number | null = null;
  if (participantLimit !== null && participantLimit > 0 && thresholdPct !== null) {
    if (thresholdPct < 1 || thresholdPct > 100) errors.push('Threshold percentage must be 1-100.');
    else capacityThreshold = Math.round((thresholdPct / 100) * participantLimit);
  }
  if (discountEnabled) {
    if (discountPercent === null || discountPercent < 1 || discountPercent > 100) errors.push('Discount percentage must be 1-100.');
    if (discountExpiresDays === null || discountExpiresDays < 1) errors.push('Discount expiry must be at least 1 day.');
    if (discountUsageLimit === null || discountUsageLimit < 1) errors.push('Discount uses per code must be at least 1.');
  }
  if (!termsSummary) errors.push('Plain-language summary is required.');
  if (!termsBody) errors.push('Full terms text is required.');
  if (findCampaignBySlug(slug)) errors.push(`Slug "${slug}" is already in use.`);

  if (errors.length > 0) {
    return c.html(adminShell('New campaign', `
      <p><a href="/admin/campaigns">← Campaigns</a></p>
      <h2>New campaign</h2>
      <div class="err">${errors.map(escapeHtml).join('<br />')}</div>
      <p>Please <a href="javascript:history.back()">go back</a> and correct the issues.</p>
    `, 'campaigns'), 400);
  }

  const productSet: CampaignProduct[] = selectedIds.map((id) => ({
    shopifyProductId: id,
    shopifyVariantId: null,
  }));

  const { campaignId } = createCampaign({
    name,
    slug,
    targetSize: participantLimit!,
    capacityWarningThreshold: capacityThreshold,
    productSet,
    discountPercent,
    discountExpiresDays,
    discountCodePrefix,
    discountUsageLimit: discountUsageLimit ?? undefined,
    termsSummaryText: termsSummary,
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
  const memberCounts = countMembersByStatus(camp.id);
  const activeMembers = countActiveMembers(camp.id);
  const products = parseProductSet(camp);

  // Build a quick product-id → title lookup from the cache so the Settings
  // summary lists products by name instead of by 13-digit Shopify ID. Falls
  // back to the ID when the cache doesn't have the product (rare — usually
  // means the product was deleted in Shopify after the campaign was created).
  const productCache = new Map(
    listCachedProducts().map((p) => [p.shopifyProductId, p.title]),
  );
  const productListHtml = products.length === 0
    ? '<p class="muted">No products configured yet. Edit the campaign to add them.</p>'
    : `<ul style="margin:8px 0 0; padding-left:20px;">${products
        .map((p) => {
          const title = productCache.get(p.shopifyProductId);
          if (title) {
            // Name primary; tiny ID as muted secondary line (useful only for
            // debugging — merchant doesn't read it normally).
            return `<li>${escapeHtml(title)}${p.shopifyVariantId ? ` <span class="muted">(variant ${escapeHtml(p.shopifyVariantId)})</span>` : ''} <span class="muted" style="font-size:11px;font-family:monospace;">${escapeHtml(p.shopifyProductId)}</span></li>`;
          }
          // No cached title — fall back to the ID with a hint to refresh.
          return `<li><span class="muted">[uncached] </span><code>${escapeHtml(p.shopifyProductId)}</code>${p.shopifyVariantId ? ` <span class="muted">(variant ${escapeHtml(p.shopifyVariantId)})</span>` : ''}</li>`;
        })
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

  const discountTermsHtml = camp.discount_percent
    ? `${camp.discount_percent}% off, expires ${camp.discount_expires_days ?? '—'} days after issue${camp.discount_code_prefix ? `, code prefix "${escapeHtml(camp.discount_code_prefix)}"` : ''}, ${camp.discount_usage_limit} use${camp.discount_usage_limit === 1 ? '' : 's'} per code`
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

    ${renderApplicationsSummaryCard(camp, parseProductSet(camp).length, memberStatsHtml)}

    <div class="card">
      <h3 style="margin-top:0;">Emails</h3>
      <h4 style="margin:8px 0 4px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">Automated (fires on application)</h4>
      ${renderAutomatedTemplateRow(camp, 'campaign_application_confirmation', 'Application received')}
      <h4 style="margin:18px 0 4px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">Batch — manually sent</h4>
      ${renderBatchSendRow(camp, 'campaign_shipped_notification', 'Samples shipped')}
      ${renderBatchSendRow(camp, 'campaign_review_reminder', 'Review reminder')}
      ${renderBatchSendRow(camp, 'campaign_launch_thanks', 'Launch thanks')}
      <p class="muted" style="margin-top:16px;">Each Send button delivers the email to every eligible member. "Shipped" requires approved members with generated invitations; "Reminder" requires members already in shipped; "Launch" requires members in shipped or reviewed who have a discount code. The Application-received email fires automatically when someone submits the application form — there's no batch button for it because it sends one at a time, in real time.</p>
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
      <p class="muted">Current version: ${activeTerms ? `v${activeTerms.version_number}, saved ${formatTs(activeTerms.created_at)}` : 'none'}. Saving creates a new version snapshot — existing applicants stay tied to whatever version they originally accepted.</p>
      <form method="POST" action="/admin/campaigns/${camp.id}/terms">
        <label>Plain-language summary</label>
        <textarea name="terms_summary" class="campaign-terms-input" rows="6" required>${escapeHtml(activeTerms?.summary_text ?? '')}</textarea>
        <p class="muted" style="font-style:italic;">Short summary shown prominently above the full terms on the application form.</p>
        <label style="margin-top:16px;">Full terms</label>
        <textarea name="terms_body" class="campaign-terms-input" rows="14" required>${escapeHtml(activeTerms?.body_text ?? '')}</textarea>
        <button type="submit" class="primary" style="margin-top:8px;">Save new terms version</button>
      </form>
    </div>

    <!-- Inline styles + script for textarea selection-sync. Same fix that
         ships on the create form, applied to the detail page's terms editor. -->
    <style>
      .campaign-terms-input {
        filter: none !important;
        transform: none !important;
        position: relative;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        line-height: 1.5;
      }
    </style>
    ${renderTermsTextareaCursorFixScript()}
  `, 'campaigns'));
});

// Thin shim around the shared cursor-fix helper. Older call sites in this
// file still reference renderTermsTextareaCursorFixScript() — keep the name
// for them but route through the shared helper.
const renderTermsTextareaCursorFixScript = (): string =>
  renderTextareaCursorFixScript('.campaign-terms-input');

// --- Applicants management page (dedicated tab) ---
//
// The campaign detail page used to inline the full applicants queue plus the
// approve/reject/remove controls; once a campaign collects more than ~5
// applications the detail page got unwieldy. Moved to its own page so the
// detail page stays a scannable overview and applicants triage gets its own
// surface — with a status filter so the merchant can work one bucket at a
// time.

adminCampaigns.get('/:id/applicants', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.notFound();
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const products = parseProductSet(camp);
  const statusParam = c.req.query('status') ?? 'all';
  const statusFilter = statusParam === 'all'
    || (CAMPAIGN_MEMBER_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as CampaignMemberRow['status'] | 'all')
    : 'all';

  return c.html(adminShell(`Applicants — ${camp.name}`, `
    ${renderCampaignPillStyles()}
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Applicants — ${escapeHtml(camp.name)}</h2>
    <p class="muted">Approve, reject, or remove individual applications. Once approved members exist, use the Generate-invitations button below to create their sample-invitation review links (one per campaign product, idempotent).</p>
    ${renderApplicationQueue(camp, products.length, statusFilter)}
  `, 'campaigns'));
});

// --- Edit settings (form) ---

adminCampaigns.get('/:id/edit', (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const products = parseProductSet(camp);
  const data: CampaignFormData = {
    name: camp.name,
    slug: camp.slug,
    slugLocked: true,
    participantLimit: camp.target_size,
    thresholdPct: inferThresholdPct(camp.capacity_warning_threshold, camp.target_size),
    selectedProductIds: new Set(products.map((p) => p.shopifyProductId)),
    discountEnabled: camp.discount_percent !== null,
    discountPercent: camp.discount_percent,
    discountExpiresDays: camp.discount_expires_days,
    discountCodePrefix: camp.discount_code_prefix ?? '',
    discountUsageLimit: camp.discount_usage_limit,
    termsSummary: '',  // unused — termsLocked = true
    termsBody: '',
    termsLocked: true,
  };

  const refresh = renderRefreshProductsForm(`/admin/campaigns/${camp.id}/edit`);
  return c.html(adminShell(`Edit ${camp.name}`, `
    ${renderCampaignFormStyles()}
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Edit campaign</h2>
    ${refresh.html}
    <form method="POST" action="/admin/campaigns/${camp.id}/edit" class="card" id="campaign-edit-form">
      ${renderCampaignFormFields(data, refresh.id)}
      <p class="campaign-helper" style="margin-top:16px;">Terms are edited separately from the campaign detail page — they're versioned so historical applicants stay tied to the version they accepted.</p>
      <div style="margin-top:24px; display:flex; gap:12px;">
        <button type="submit" class="primary">Save changes</button>
        <a href="/admin/campaigns/${camp.id}" style="align-self:center;">Cancel</a>
      </div>
    </form>
    ${renderThresholdHelperScript()}
  `, 'campaigns'));
});

adminCampaigns.post('/:id/edit', async (c) => {
  const id = Number(c.req.param('id'));
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  const form = await c.req.parseBody({ all: true });
  const name = String(form.name ?? '').trim();
  const participantLimit = parseIntOrNull(form.participant_limit);
  const thresholdPct = parseIntOrNull(form.threshold_pct);
  const discountEnabled = form.discount_enabled === 'on';
  const discountPercent = discountEnabled ? parseIntOrNull(form.discount_percent) : null;
  const discountExpiresDays = discountEnabled ? parseIntOrNull(form.discount_expires_days) : null;
  const discountCodePrefix = String(form.discount_code_prefix ?? '').trim() || null;
  const discountUsageLimit = discountEnabled ? parseIntOrNull(form.discount_usage_limit) : null;

  const productIdsRaw = form.product_id;
  const selectedIds: string[] = Array.isArray(productIdsRaw)
    ? productIdsRaw.filter((v): v is string => typeof v === 'string')
    : (typeof productIdsRaw === 'string' ? [productIdsRaw] : []);

  if (!name) {
    return c.html(adminShell('Edit campaign', `<div class="err">Name is required.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
  }
  if (participantLimit === null || participantLimit < 0) {
    return c.html(adminShell('Edit campaign', `<div class="err">Participant limit must be 0 or greater.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
  }

  let capacityThreshold: number | null = null;
  if (participantLimit > 0 && thresholdPct !== null) {
    if (thresholdPct < 1 || thresholdPct > 100) {
      return c.html(adminShell('Edit campaign', `<div class="err">Threshold percentage must be 1-100.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
    }
    capacityThreshold = Math.round((thresholdPct / 100) * participantLimit);
  }

  if (discountEnabled) {
    if (discountPercent === null || discountPercent < 1 || discountPercent > 100) {
      return c.html(adminShell('Edit campaign', `<div class="err">Discount percentage must be 1-100 when discount is enabled.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
    }
    if (discountExpiresDays === null || discountExpiresDays < 1) {
      return c.html(adminShell('Edit campaign', `<div class="err">Discount expiry must be at least 1 day when discount is enabled.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
    }
    if (discountUsageLimit === null || discountUsageLimit < 1) {
      return c.html(adminShell('Edit campaign', `<div class="err">Discount uses per code must be at least 1 when discount is enabled.</div><p><a href="javascript:history.back()">Go back</a></p>`, 'campaigns'), 400);
    }
  }

  const productSet: CampaignProduct[] = selectedIds.map((pid) => ({
    shopifyProductId: pid,
    shopifyVariantId: null,
  }));

  updateCampaignSettings({
    id: camp.id,
    name,
    targetSize: participantLimit,
    capacityWarningThreshold: capacityThreshold,
    productSet,
    discountPercent,
    discountExpiresDays,
    discountCodePrefix,
    discountUsageLimit,
  });

  log('info', 'campaign settings updated', { campaignId: camp.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

// --- Full-catalog product cache refresh ---

adminCampaigns.post('/refresh-product-cache', async (c) => {
  const form = await c.req.parseBody();
  const returnTo = String(form.return_to ?? '/admin/campaigns/new');
  try {
    const count = await syncAllProductsToCache();
    log('info', 'admin synced full product catalog', { count });
  } catch (err) {
    log('error', 'product cache refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.redirect(returnTo);
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
  const summaryText = String(form.terms_summary ?? '').trim();
  const bodyText = String(form.terms_body ?? '').trim();
  if (!summaryText || !bodyText) {
    return c.html(adminShell('Save terms', `
      <div class="err">Both the plain-language summary and the full terms are required.</div>
      <p><a href="javascript:history.back()">Go back</a></p>
    `, 'campaigns'), 400);
  }

  // Skip the save if both fields are unchanged from the active version. We
  // count edits to either field as a real edit and version both together.
  const active = getActiveTermsVersion(camp.id);
  if (active && active.body_text === bodyText && (active.summary_text ?? '') === summaryText) {
    log('info', 'campaign terms unchanged, skipping version', { campaignId: camp.id });
    return c.redirect(`/admin/campaigns/${camp.id}`);
  }

  const version = saveTermsVersion({ campaignId: camp.id, summaryText, bodyText });
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
  const invitationCell =
    member.status === 'approved'
    || member.status === 'shipped'
    || member.status === 'reminded'
    || member.status === 'reviewed'
    || member.status === 'done'
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
    .pill-campaign-member-reminded { background:#e6dffa; color:#3d2c79; }
    .pill-campaign-member-reviewed { background:#d4f1f9; color:#1c5b75; }
    .pill-campaign-member-done     { background:#cfe9d2; color:#1d4d22; }
  </style>
`;

// Detail-page summary card. Shows the per-status counts + a single link
// across to the dedicated Applicants page where the merchant does the actual
// approve/reject/remove work. We surface the Generate-invitations CTA here
// too when it's actionable, since that's the most time-sensitive operation
// once approvals start landing.
const renderApplicationsSummaryCard = (
  camp: CampaignRow,
  productCount: number,
  memberStatsHtml: string,
): string => {
  const members = listMembersByCampaign(camp.id);

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
    ? `<div style="margin:16px 0 0; padding:12px 14px; background:var(--surface-alt); border-radius:4px;">
        <p style="margin:0 0 10px;"><strong>${approvedAwaitingInvitations}</strong> approved ${approvedAwaitingInvitations === 1 ? 'applicant has' : 'applicants have'} no invitations yet.</p>
        <form method="POST" action="/admin/campaigns/${camp.id}/generate-invitations">
          <button type="submit" class="primary">Generate ${productCount} sample invitations per approved applicant</button>
        </form>
        <p class="muted" style="margin:10px 0 0;">Creates one invitation per product in the campaign's product set. Idempotent — re-running skips applicants who already have invitations.</p>
      </div>`
    : '';

  const totalApplications = members.length;
  const summaryLine = totalApplications === 0
    ? '<p class="muted" style="margin:0;">No applications yet. Share the form URL once the campaign is in Recruiting status.</p>'
    : `<p class="muted" style="margin:0;">${totalApplications} ${totalApplications === 1 ? 'application' : 'applications'} total.</p>`;

  return `
    <div class="card">
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <h3 style="margin:0;">Applications</h3>
        <a href="/admin/campaigns/${camp.id}/applicants" class="primary" style="text-decoration:none; padding:6px 14px; background:var(--accent); color:var(--accent-fg, #fff); border-radius:4px; font-size:13px;">Manage applicants →</a>
      </div>
      ${memberStatsHtml}
      ${summaryLine}
      ${generateCta}
    </div>
  `;
};

// Full queue rendered on the dedicated /applicants page. Same data as the
// old inline card, just expanded with a status filter so the merchant can
// triage one bucket at a time once the list gets long.
const renderApplicationQueue = (
  camp: CampaignRow,
  productCount: number,
  statusFilter: CampaignMemberRow['status'] | 'all',
): string => {
  const all = listMembersByCampaign(camp.id);
  const filtered = statusFilter === 'all' ? all : all.filter((m) => m.status === statusFilter);

  let approvedAwaitingInvitations = 0;
  if (productCount > 0) {
    for (const m of all) {
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

  // Status filter row: All + each member status. Counts come from `all` so
  // the buckets reflect the full list (not whatever bucket is currently
  // selected).
  const counts: Record<string, number> = { all: all.length };
  for (const s of CAMPAIGN_MEMBER_STATUSES) counts[s] = 0;
  for (const m of all) counts[m.status] = (counts[m.status] ?? 0) + 1;

  const filterLink = (key: string, label: string): string => {
    const isActive = statusFilter === key;
    const href = key === 'all'
      ? `/admin/campaigns/${camp.id}/applicants`
      : `/admin/campaigns/${camp.id}/applicants?status=${encodeURIComponent(key)}`;
    return `<a href="${href}" class="${isActive ? 'tab-active' : ''}"
              style="padding:6px 12px; border-radius:4px; text-decoration:none; font-size:13px;
                     ${isActive ? 'background:var(--accent); color:var(--accent-fg, #fff);' : 'color:var(--text); background:var(--surface-alt);'}">
              ${escapeHtml(label)} <span class="muted" style="opacity:0.75;">${counts[key] ?? 0}</span>
            </a>`;
  };

  const filterRow = `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:16px 0;">
      ${filterLink('all', 'All')}
      ${CAMPAIGN_MEMBER_STATUSES.map((s) => filterLink(s, CAMPAIGN_MEMBER_STATUS_LABELS[s])).join('')}
    </div>
  `;

  const emptyMsg = all.length === 0
    ? `<p class="muted">No applications yet. Share the form URL once the campaign is in Recruiting status.</p>`
    : `<p class="muted">No applications matching <code>${escapeHtml(statusFilter)}</code>.</p>`;

  const tableHtml = filtered.length === 0
    ? emptyMsg
    : `<table>
        <thead>
          <tr>
            <th>Applicant</th>
            <th>Status</th>
            <th>Invitations</th>
            <th>Applied</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${filtered.map((m) => memberRowHtml(m, camp, productCount)).join('')}</tbody>
      </table>`;

  return `
    ${renderMemberPillStyles()}
    ${generateCta}
    ${filterRow}
    ${tableHtml}
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
  return c.redirect(`/admin/campaigns/${camp.id}/applicants`);
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
  return c.redirect(`/admin/campaigns/${camp.id}/applicants`);
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
  return c.redirect(`/admin/campaigns/${camp.id}/applicants`);
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
  return c.redirect(`/admin/campaigns/${camp.id}/applicants`);
});

// --- Batch-send UI + routes ---

// Editable-template button styled to look like the other action buttons.
// Same styling on the batch-send and the automated (signup-confirmation) row
// so the merchant has consistent visual treatment for "edit this template."
const renderEditTemplateButton = (camp: CampaignRow, trigger: string): string =>
  `<a href="/admin/campaigns/${camp.id}/templates/${trigger}/edit"
      style="display:inline-block;padding:6px 12px;border:1px solid var(--border-strong);border-radius:4px;text-decoration:none;color:var(--text);font-size:13px;background:var(--surface);">Preview / edit template</a>`;

const renderTemplateSubjectPreview = (camp: CampaignRow, trigger: string): string => {
  const activeTemplate = findActiveTemplateForTriggerCampaignAware(trigger, camp.id);
  const hasOverride = findCampaignTemplateRow(camp.id, trigger) !== null;
  return activeTemplate
    ? `<div class="campaign-helper" style="margin:4px 0 0; max-width:540px;">
         <strong>Subject:</strong> ${escapeHtml(activeTemplate.subject)} ${hasOverride ? '<em>(campaign-specific override)</em>' : '<em>(shop default)</em>'}
       </div>`
    : `<div class="campaign-helper" style="margin:4px 0 0;color:#b00;">No active template found for this trigger.</div>`;
};

const renderBatchSendRow = (
  camp: CampaignRow,
  trigger: CampaignBatchTrigger,
  label: string,
): string => {
  const eligible = countEligibleForTrigger(camp.id, trigger);
  const disabled = eligible === 0 ? 'disabled' : '';
  const confirmMsg = trigger === 'campaign_launch_thanks'
    ? `Send "${label}" to ${eligible} eligible member${eligible === 1 ? '' : 's'}? This will generate discount codes for everyone who doesn't have one yet, then send. Cannot be undone.`
    : `Send "${label}" to ${eligible} eligible member${eligible === 1 ? '' : 's'}? This cannot be undone.`;

  return `
    <div style="margin:12px 0; padding:8px 0; border-bottom:1px dashed var(--border);">
      <form method="POST" action="/admin/campaigns/${camp.id}/send/${trigger}"
            onsubmit="return confirm(${JSON.stringify(confirmMsg)});"
            style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <button type="submit" class="primary" ${disabled}>Send "${escapeHtml(label)}"</button>
        <span class="muted">${eligible} eligible</span>
        ${renderEditTemplateButton(camp, trigger)}
      </form>
      ${renderTemplateSubjectPreview(camp, trigger)}
    </div>
  `;
};

// Same shape as renderBatchSendRow but without a send button — the
// signup-confirmation email fires automatically when an applicant submits
// the public form (see proxy.ts), so no "Send" action belongs here. The
// merchant still needs to be able to preview and customize it, which is
// what this row exposes.
const renderAutomatedTemplateRow = (
  camp: CampaignRow,
  trigger: string,
  label: string,
): string => `
  <div style="margin:12px 0; padding:8px 0; border-bottom:1px dashed var(--border);">
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <strong style="min-width:180px;">${escapeHtml(label)}</strong>
      <span class="muted" style="font-size:13px;">Sent automatically on application submit</span>
      ${renderEditTemplateButton(camp, trigger)}
    </div>
    ${renderTemplateSubjectPreview(camp, trigger)}
  </div>
`;

// --- Per-campaign template editor ---
//
// Edit-template links from the batch-send rows hit /templates/:trigger/edit.
// If no campaign-specific override exists for that trigger yet, we clone the
// shop default first, then render the editor on the clone. The Branding-page
// editor (separate UI) still edits the default; this one edits the
// campaign's own copy.

const renderTemplateEditor = (camp: CampaignRow, template: ReturnType<typeof findEmailTemplateById>, trigger: string): string => {
  if (!template) {
    return `<div class="err">Template not found.</div>`;
  }
  // Variable-insert dropdown options sourced from the shared registry. Same
  // set the Branding > Email editor offers.
  const variableInsertOptions = EMAIL_VARIABLES
    .map((v) => `<option value="${v.key}">${escapeHtml(v.label)} — {{ ${v.key} }}${v.expands ? ' (expands)' : ''}</option>`)
    .join('');
  return `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Edit "${escapeHtml(template.display_name)}"</h2>
    <p class="muted">Campaign override for trigger <code>${escapeHtml(trigger)}</code>. Editing here does not change the shop default. Sends for this campaign use this version; sends for other campaigns fall back to the default.</p>

    <!-- Revert is a separate sibling form so it doesn't share the main form's
         submit handler — it has its own action + confirm prompt. -->
    <form method="POST" action="/admin/campaigns/${camp.id}/templates/${template.id}/revert"
          id="revert-form"
          onsubmit="return confirm('Revert to the shop default? This deletes the campaign-specific override; future sends use the default until you make a new override.');"
          style="display:none;"></form>

    <form method="POST" action="/admin/campaigns/${camp.id}/templates/${template.id}" class="card" id="campaign-template-form">
      <label>Subject line</label>
      <input type="text" name="subject" required maxlength="200" value="${escapeHtml(template.subject)}" data-dirty-watch />

      <label style="margin-top:16px;">Body (HTML)</label>
      <textarea name="body_html" id="campaign-template-body" class="admin-cursorfix-textarea" rows="20" required
                style="font-family:monospace; font-size:13px;"
                data-dirty-watch>${escapeHtml(template.body_html)}</textarea>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px;">
        <select id="campaign-insert-var" aria-label="Insert variable">
          <option value="">Insert variable…</option>${variableInsertOptions}
        </select>
        <span class="campaign-helper" style="margin:0;">Inserts a token at the cursor position in the body.</span>
      </div>

      <label style="margin-top:16px; display:flex; align-items:center; gap:8px; font-weight:normal;">
        <input type="checkbox" name="is_active" value="1" ${template.is_active === 1 ? 'checked' : ''} data-dirty-watch />
        <span>Active (used by the dispatcher)</span>
      </label>

      <div style="margin-top:24px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        <button type="submit" class="primary">Save changes</button>
        <button type="button" id="campaign-template-preview"
                style="padding:6px 12px;border:1px solid var(--border-strong);border-radius:4px;color:var(--text);font-size:13px;background:var(--surface);cursor:pointer;">Preview in new tab</button>
        <span id="campaign-template-dirty" style="font-size:12px;color:#a86b00;display:none;">● Unsaved changes</span>
        <a href="/admin/campaigns/${camp.id}" style="align-self:center;">Cancel</a>
        <button type="submit" form="revert-form" class="danger" style="margin-left:auto;">Revert to default</button>
      </div>
    </form>

    <script>
      (function () {
        var form = document.getElementById('campaign-template-form');
        var body = document.getElementById('campaign-template-body');
        var dirty = document.getElementById('campaign-template-dirty');
        var varSel = document.getElementById('campaign-insert-var');
        var previewBtn = document.getElementById('campaign-template-preview');

        var isDirty = false;
        function markDirty() {
          if (isDirty) return;
          isDirty = true;
          if (dirty) dirty.style.display = 'inline';
        }
        function markClean() {
          isDirty = false;
          if (dirty) dirty.style.display = 'none';
        }
        form.querySelectorAll('[data-dirty-watch]').forEach(function (el) {
          el.addEventListener('input', markDirty);
          el.addEventListener('change', markDirty);
        });
        form.addEventListener('submit', markClean);
        // beforeunload guard — same as the Branding > Email editor. Browser
        // shows its native "unsaved changes" prompt when the user tries to
        // navigate away with isDirty=true.
        window.addEventListener('beforeunload', function (e) {
          if (isDirty) { e.preventDefault(); e.returnValue = ''; return ''; }
        });

        // Insert-variable: drop the {{ key }} token at the current cursor
        // position in the body textarea. Same UX as Branding > Email.
        if (varSel) varSel.addEventListener('change', function () {
          var key = varSel.value; if (!key) return;
          var token = '{{ ' + key + ' }}';
          var start = body.selectionStart || 0, end = body.selectionEnd || 0;
          body.value = body.value.slice(0, start) + token + body.value.slice(end);
          body.selectionStart = body.selectionEnd = start + token.length;
          body.focus();
          markDirty();
          varSel.value = '';
        });

        // Preview-in-new-tab without saving: build a temporary form, POST the
        // current values to the unsaved-preview endpoint. The endpoint is
        // shared with the Branding > Email tab — same renderer behind it.
        if (previewBtn) previewBtn.addEventListener('click', function () {
          var subject = form.querySelector('[name="subject"]').value;
          var bodyHtml = body.value;
          var tmp = document.createElement('form');
          tmp.method = 'POST';
          tmp.action = '/admin/branding/email-template/preview';
          tmp.target = '_blank';
          function add(name, value) {
            var i = document.createElement('input');
            i.type = 'hidden'; i.name = name; i.value = value; tmp.appendChild(i);
          }
          add('subject', subject);
          add('body_html', bodyHtml);
          // Campaign templates render with cta_enabled determined by the
          // shop's default for that trigger; for preview, mirror the saved
          // template's cta_enabled (this template, not the default — close
          // enough for visual feedback).
          add('cta_enabled', ${template.cta_enabled === 1 ? "'1'" : "'0'"});
          document.body.appendChild(tmp);
          tmp.submit();
          document.body.removeChild(tmp);
        });
      })();
    </script>

    <style>
      .admin-cursorfix-textarea {
        ${ADMIN_TEXTAREA_FIX_CSS}
      }
    </style>
    ${renderTextareaCursorFixScript('.admin-cursorfix-textarea')}
  `;
};

adminCampaigns.get('/:id/templates/:trigger/edit', (c) => {
  const id = Number(c.req.param('id'));
  const trigger = c.req.param('trigger');
  const camp = findCampaignById(id);
  if (!camp) return c.notFound();

  // Clone-on-first-edit: if the merchant has never edited this template for
  // this campaign, we copy the current default into a new campaign-scoped row
  // and open the editor on the clone. Subsequent edits hit the same row.
  let template = findCampaignTemplateRow(camp.id, trigger);
  if (!template) {
    template = cloneTemplateForCampaign({ campaignId: camp.id, trigger });
    if (!template) {
      return c.html(adminShell('Edit template', `<div class="err">No default template exists for this trigger. The seeded defaults should have landed at boot — check the logs.</div>`, 'campaigns'), 500);
    }
    log('info', 'campaign template cloned from default', {
      campaignId: camp.id,
      trigger,
      templateId: template.id,
    });
  }

  return c.html(adminShell(`Edit template — ${camp.name}`, renderTemplateEditor(camp, template, trigger), 'campaigns'));
});

adminCampaigns.post('/:id/templates/:templateId', async (c) => {
  const id = Number(c.req.param('id'));
  const templateId = Number(c.req.param('templateId'));
  const camp = findCampaignById(id);
  const template = findEmailTemplateById(templateId);
  if (!camp || !template) return c.notFound();
  if (template.campaign_id !== camp.id) {
    // Defense: a merchant shouldn't be editing a template that belongs to a
    // different campaign (or no campaign at all) via this route. 403 rather
    // than a silent edit.
    return c.json({ error: 'wrong_campaign' }, 403);
  }

  const form = await c.req.formData();
  const subject = String(form.get('subject') ?? '').trim();
  const bodyHtml = String(form.get('body_html') ?? '');
  const isActive = form.get('is_active') === '1';

  if (!subject) {
    return c.html(adminShell('Edit template', `<div class="err">Subject can't be empty.</div>`, 'campaigns'), 400);
  }
  if (!bodyHtml.trim()) {
    return c.html(adminShell('Edit template', `<div class="err">Body can't be empty.</div>`, 'campaigns'), 400);
  }

  updateEmailTemplateById({
    id: template.id,
    displayName: template.display_name,
    subject,
    bodyHtml,
    ctaEnabled: template.cta_enabled === 1,
    ctaLabel: template.cta_label,
    isActive,
  });
  log('info', 'campaign template saved', { campaignId: camp.id, templateId: template.id });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

adminCampaigns.post('/:id/templates/:templateId/revert', (c) => {
  const id = Number(c.req.param('id'));
  const templateId = Number(c.req.param('templateId'));
  const camp = findCampaignById(id);
  const template = findEmailTemplateById(templateId);
  if (!camp || !template) return c.notFound();
  if (template.campaign_id !== camp.id) {
    return c.json({ error: 'wrong_campaign' }, 403);
  }
  // Hard delete the campaign-scoped row. The dispatcher's campaign-aware
  // lookup will fall through to the shop default on the next send.
  getDb().prepare('DELETE FROM email_templates WHERE id = ?').run(template.id);
  log('info', 'campaign template reverted to default', { campaignId: camp.id, templateId });
  return c.redirect(`/admin/campaigns/${camp.id}`);
});

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

  const codeErrorsHtml = result.codeErrors && result.codeErrors.length > 0
    ? `<div class="err" style="margin-top:16px;">
         <strong>Discount-code generation failed:</strong>
         <ul>${result.codeErrors.slice(0, 10).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
         ${result.codeErrors.length > 10 ? `<p>… and ${result.codeErrors.length - 10} more (see logs).</p>` : ''}
       </div>`
    : '';

  const abortedNotice = result.aborted
    ? `<div class="err"><strong>Batch aborted — no emails were sent.</strong> Fix the discount-code errors below and try again.</div>`
    : '';

  return c.html(adminShell(`Batch send — ${camp.name}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>Batch ${result.aborted ? 'aborted' : 'complete'}</h2>
    ${abortedNotice}
    <div class="card">
      <p><strong>Trigger:</strong> ${escapeHtml(trigger)}</p>
      <p><strong>Eligible:</strong> ${result.total}</p>
      <p><strong>Sent:</strong> ${result.sent}</p>
      <p><strong>Failed:</strong> ${result.failed}</p>
      ${result.skipped > 0 ? `<p><strong>Skipped:</strong> ${result.skipped}</p>` : ''}
      ${typeof result.codesCreated === 'number' ? `<p><strong>Discount codes generated:</strong> ${result.codesCreated}</p>` : ''}
      ${codeErrorsHtml}
      <p style="margin-top:16px;"><a href="/admin/campaigns/${camp.id}">Back to campaign</a></p>
    </div>
  `, 'campaigns'));
});

// --- Discount-code render ---
//
// Generation is no longer a separate admin action — codes are created
// automatically as part of the launch_thanks email send (see
// dispatch-campaign.ts). The card here just shows the stats and the
// post-launch cleanup buttons.

const renderDiscountCard = (camp: CampaignRow): string => {
  const stats: CodeStats = codeStats(camp.id);
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

  const configMsg = !configured
    ? `<p class="campaign-helper">Discount terms aren't configured. <a href="/admin/campaigns/${camp.id}/edit">Edit the campaign</a> to enable a launch discount.</p>`
    : `<p class="campaign-helper">Codes are ${camp.discount_percent}% off, single-use, scoped to one customer record each, and expire ${camp.discount_expires_days} days after they're issued. They're generated automatically when you send the "Launch thanks" email — no separate step. Redemptions are tracked via the orders/paid webhook.</p>`;

  const cleanupHtml = renderCleanupButtons(camp, stats);

  return `
    <div class="card">
      <h3 style="margin-top:0;">Discount codes</h3>
      ${statsHtml}
      ${revenueHtml}
      ${configMsg}
      ${cleanupHtml}
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
  const products = parseProductSet(camp);
  // Build a lookup so a form tied to a product can show that product's name
  // (or fall back to the bare id if the product isn't in the cache).
  const productNamesById = new Map<string, string>();
  for (const cached of listCachedProducts()) {
    productNamesById.set(cached.shopifyProductId, cached.title);
  }

  const list = forms.length === 0
    ? '<p class="campaign-helper" style="margin:0;">No feedback forms yet. Create one below — each form gets its own anonymous URL you can include in the shipped or reminder emails.</p>'
    : `<ul style="margin:0; padding-left:20px;">${forms.map((f) => {
        const responses = countResponsesForForm(f.id);
        const scope = f.shopify_product_id
          ? (productNamesById.get(f.shopify_product_id) ?? `product ${f.shopify_product_id}`)
          : 'campaign-wide';
        return `<li style="margin:4px 0;">
          <a href="/admin/campaigns/${camp.id}/feedback/${f.id}">${escapeHtml(f.title)}</a>
          <span class="muted">— ${escapeHtml(scope)}, ${responses} response${responses === 1 ? '' : 's'}</span>
        </li>`;
      }).join('')}</ul>`;

  // Product dropdown for the new-form action, populated from the campaign's
  // product set so the merchant picks from products already in this campaign
  // rather than typing raw ids.
  const productOptions = products.length === 0
    ? '<option value="">(no products in this campaign yet — add some in Edit settings)</option>'
    : products.map((p) => {
        const name = productNamesById.get(p.shopifyProductId) ?? `Product ${p.shopifyProductId}`;
        return `<option value="${escapeHtml(p.shopifyProductId)}">${escapeHtml(name)}</option>`;
      }).join('');

  return `
    <div class="card">
      <h3 style="margin-top:0;">Feedback forms</h3>
      ${list}
      <form method="POST" action="/admin/campaigns/${camp.id}/feedback" style="margin-top:16px;">
        <label>Form title</label>
        <input type="text" name="title" required maxlength="160" placeholder="e.g., How did you like Product A?" />
        <label style="margin-top:12px;">Scope</label>
        <select name="shopify_product_id">
          <option value="">Campaign-wide (not tied to a specific product)</option>
          ${productOptions}
        </select>
        <p class="campaign-helper">Pick a product to make a per-product feedback form, or leave on "Campaign-wide" for general feedback. Create one form per product for product-specific reporting.</p>
        <label>Intro text (optional)</label>
        <textarea name="intro_text" rows="2" placeholder="Tell respondents what this feedback will be used for."></textarea>
        <div style="margin-top:12px;">
          <button type="submit">Create feedback form</button>
        </div>
      </form>
      <p class="campaign-helper" style="margin-top:12px;">Each form gets a hosted URL on our app — no Shopify Page setup required. The shipped-notification and review-reminder emails include links to every form automatically.</p>
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
  const hostedPreviewUrl = `/feedback/${encodeURIComponent(form.access_key)}`;

  return c.html(adminShell(`Feedback — ${form.title}`, `
    <p><a href="/admin/campaigns/${camp.id}">← ${escapeHtml(camp.name)}</a></p>
    <h2>${escapeHtml(form.title)}</h2>
    <p class="muted">${responseCount} response${responseCount === 1 ? '' : 's'}${form.shopify_product_id ? ` · tied to product ${escapeHtml(form.shopify_product_id)}` : ' · campaign-wide'}</p>
    <p>
      <a href="${hostedPreviewUrl}" target="_blank" rel="noopener" style="margin-right:12px;">Preview public form ↗</a>
      ${responseCount > 0 ? `<a href="/admin/campaigns/${camp.id}/feedback/${form.id}/report">View report →</a>` : ''}
    </p>

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
      <h3 style="margin-top:0;">Public form URL</h3>
      <p>Share this URL with participants (it's already embedded in the shipped-notification and review-reminder emails for this campaign):</p>
      <pre style="background:var(--surface-alt); padding:12px; border-radius:4px; overflow-x:auto;">${escapeHtml(`${config.publicUrl.replace(/\/+$/, '')}${hostedPreviewUrl}`)}</pre>
      <p class="campaign-helper">Hosted on our app — works out of the box, no Shopify setup needed.</p>
      <details style="margin-top:12px;">
        <summary>Optional: embed in a Shopify Page instead</summary>
        <p>For merchants who want the feedback form inside their store, create a Page in Shopify admin and paste this snippet (requires the reviews widget script to be loaded site-wide):</p>
        <pre style="background:var(--surface-alt); padding:12px; border-radius:4px; overflow-x:auto;">${escapeHtml(embedSnippet)}</pre>
      </details>
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
        <span style="width:32px; text-align:right;">${i + 1}</span>
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
