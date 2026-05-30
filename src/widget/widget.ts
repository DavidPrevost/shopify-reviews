// Storefront widget — vanilla TypeScript, no framework. Bundled by esbuild
// into public/widget.js as a single IIFE. Loaded from the storefront via:
//   <script src="https://reviews.brandname.com/widget.js" defer></script>
//
// Renders into placeholder <div>s with `data-reviews-widget` and `data-product-id`.
// Two modes:
//   data-reviews-widget="full"      → aggregate + collapsible reviews list (product page)
//   data-reviews-widget="aggregate" → stars + count only (collection cards)
//
// Styles are injected at runtime (see STYLES below) so the storefront only
// needs the one <script> tag — no separate stylesheet to link.

interface ReviewItem {
  id: number;
  rating: number;
  title: string | null;
  body: string;
  reviewerName: string | null;
  verifiedKind: 'purchase' | 'sample' | null;
  verifiedPurchase: boolean;  // kept for backward compat; widget prefers verifiedKind
  createdAt: number;
}

interface Aggregate {
  avg: number | null;
  count: number;
  paused?: boolean;
}

interface ReviewsResponse {
  reviews: ReviewItem[];
  aggregate: Aggregate;
  // Present when the product's variant_handling metafield is "distinct" AND
  // a variant id was passed. Contains reviews from sibling variants and
  // their aggregate, surfaced as a separate section below the main list.
  related: { reviews: ReviewItem[]; aggregate: Aggregate } | null;
  variantHandling: 'distinct' | 'shared';
  page: number;
  size: number;
  // Set when the merchant has activated the "pause reviews" panic button.
  // When true, reviews/aggregate are empty stubs and the widget renders a
  // "temporarily unavailable" notice instead of the normal UI.
  paused?: boolean;
}

// The widget calls back to whichever origin served widget.js, so the same
// bundle works for dev (reviews-dev.<brand>) and prod (reviews.<brand>) with
// no build-time configuration. document.currentScript is set during the
// synchronous IIFE execution; we capture it at module load before any async
// callbacks fire and would null it out.
const detectApiBase = (): string => {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement && current.src) {
    return new URL(current.src).origin;
  }
  const scripts = document.querySelectorAll('script[src]');
  for (const s of scripts) {
    const src = s.getAttribute('src');
    if (src && /\/widget\.js(\?|$)/.test(src)) {
      try {
        return new URL(src, document.baseURI).origin;
      } catch {
        // try next
      }
    }
  }
  return '';
};
const API_BASE = detectApiBase();

const STYLES = `
.rv-widget {
  font-family: inherit;
  /* color/background inherit from the theme by default; an admin override sets
     the --reviews-text / --reviews-bg custom properties to opt out. */
  color: var(--reviews-text, inherit);
  background: var(--reviews-bg, transparent);
  font-size: inherit;
  line-height: 1.5;
  margin: 2rem auto;
  max-width: 760px;
  width: 100%;
  padding: 0 1.5rem;
  box-sizing: border-box;
}
.rv-widget-aggregate {
  display: inline-flex;
  align-items: center;
  margin: 0;
  padding: 0;
  max-width: none;
  width: auto;
}
.rv-loading, .rv-empty, .rv-error {
  font-style: italic;
  opacity: 0.7;
}
.rv-paused {
  padding: 16px;
  background: rgba(0,0,0,0.04);
  border-radius: 6px;
  font-size: 14px;
  text-align: center;
  opacity: 0.85;
}
.rv-review-actions {
  margin-top: 6px;
  text-align: right;
}
.rv-report-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
  text-decoration: underline;
}
.rv-report-link:hover { opacity: 0.85; }
.rv-stars {
  display: inline-flex;
  gap: 1px;
  color: var(--reviews-star-color, #f5a623);
  letter-spacing: 1px;
  font-size: 1em;
}
.rv-star { opacity: 0.25; }
.rv-star-on { opacity: 1; }
.rv-aggregate {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.rv-aggregate-text {
  font-size: 0.9em;
  opacity: 0.85;
}
.rv-aggregate-empty {
  opacity: 0.6;
  font-size: 0.9em;
}
.rv-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid rgba(127, 127, 127, 0.25);
}
.rv-write-link {
  color: inherit;
  text-decoration: underline;
  font-size: 0.95em;
}
.rv-details {
  margin-top: 0.75rem;
}
.rv-toggle {
  cursor: pointer;
  padding: 0.5rem 0;
  font-size: 0.95em;
  user-select: none;
  list-style: none;
}
.rv-toggle::-webkit-details-marker { display: none; }
.rv-toggle::before {
  content: "▸";
  display: inline-block;
  margin-right: 0.4rem;
  transition: transform 0.15s ease;
}
.rv-details[open] .rv-toggle::before {
  transform: rotate(90deg);
}
.rv-list {
  list-style: none !important;
  padding: 0 !important;
  margin: 0 !important;
}
.rv-list li {
  list-style: none !important;
}
.rv-review {
  padding: 1rem 0;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}
.rv-review:last-child { border-bottom: none; }
.rv-review-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
}
.rv-review-title {
  font-size: 1em;
  font-weight: 600;
}
.rv-review-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.85em;
  opacity: 0.85;
  margin-bottom: 0.5rem;
}
.rv-review-author { font-weight: 500; }
.rv-review-verified {
  font-style: italic;
  font-weight: normal;
  opacity: 0.7;
  font-size: 0.95em;
}
.rv-review-body {
  font-size: 0.95em;
  line-height: 1.55;
  white-space: normal;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.rv-related-details {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px dashed rgba(127, 127, 127, 0.35);
}
.rv-related-toggle {
  font-style: italic;
  opacity: 0.85;
}
.rv-related-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0 0.75rem;
  font-size: 0.9em;
}
.rv-muted {
  opacity: 0.7;
  font-size: 0.9em;
}
.rv-cta-button {
  background: var(--reviews-cta-bg, #222);
  color: var(--reviews-cta-fg, #fff);
  border: none;
  border-radius: var(--reviews-border-radius, 6px);
  padding: 8px 16px;
  font-size: 0.9em;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.rv-cta-button:hover { opacity: 0.9; }
.rv-cta-link {
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.95em;
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
}
.rv-empty-cta {
  margin-top: 0.75rem;
}
.rv-your-review-tag {
  display: inline-block;
  background: rgba(127, 127, 127, 0.15);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.75em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 0.5rem;
}
.rv-dialog {
  border: none;
  border-radius: 8px;
  padding: 0;
  max-width: 520px;
  width: 90vw;
  max-height: 90vh;
  overflow: auto;
  background: #fff;
  color: #222;
  font-family: inherit;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.rv-dialog::backdrop {
  background: rgba(0, 0, 0, 0.55);
}
.rv-dialog-content { padding: 24px 28px; }
.rv-dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.rv-dialog-title {
  margin: 0;
  font-size: 1.15em;
  font-weight: 600;
}
.rv-dialog-close {
  background: none;
  border: none;
  font-size: 1.5em;
  cursor: pointer;
  color: #888;
  padding: 0;
  line-height: 1;
}
.rv-dialog-close:hover { color: #222; }
.rv-dialog label {
  display: block;
  margin-top: 14px;
  font-size: 0.85em;
  font-weight: 600;
}
.rv-dialog input[type="text"],
.rv-dialog textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  margin-top: 4px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 0.95em;
  font-family: inherit;
}
.rv-dialog textarea { min-height: 110px; resize: vertical; }
.rv-dialog-stars {
  display: inline-flex;
  flex-direction: row-reverse;
  font-size: 1.6em;
  margin-top: 4px;
  user-select: none;
}
.rv-dialog-stars input[type="radio"] { display: none; }
.rv-dialog-stars label {
  display: inline-block;
  cursor: pointer;
  color: #ddd;
  margin: 0;
  font-weight: normal;
  font-size: inherit;
}
.rv-dialog-stars label:hover,
.rv-dialog-stars label:hover ~ label,
.rv-dialog-stars input:checked ~ label { color: #f5a623; }
.rv-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
.rv-dialog-error {
  background: #fee;
  border: 1px solid #fcc;
  color: #933;
  padding: 8px 12px;
  border-radius: 4px;
  margin: 12px 0 0;
  font-size: 0.9em;
}
.rv-dialog-muted { color: #888; font-size: 0.8em; margin-top: 8px; }
@media (max-width: 480px) {
  .rv-dialog { width: 100vw; max-width: 100vw; max-height: 100vh; height: 100vh; border-radius: 0; }
}
`;

const injectStylesOnce = (): void => {
  if (document.getElementById('rv-widget-styles')) return;
  const style = document.createElement('style');
  style.id = 'rv-widget-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
};

// Admin-configurable label for the "Write a review" call-to-action. Unlike the
// colors (which ride on CSS custom properties and apply whenever they land),
// this is rendered as text, so init() awaits applyWidgetConfig() before the
// first render to make sure the configured label is in place.
let widgetCtaLabel = 'Write a review';

// Fetch admin-configured visual settings and apply them as CSS custom
// properties on :root so the inline STYLES above pick them up. Best-effort:
// any failure leaves widgets rendered with the default values baked into
// var(...) fallbacks. Cached by the server for 5 minutes, so changes from
// the admin Branding page propagate within that window.
const applyWidgetConfig = async (): Promise<void> => {
  try {
    const res = await fetch(`${API_BASE}/api/widget/config`, {
      method: 'GET',
      credentials: 'omit',
    });
    if (!res.ok) return;
    const cfg = await res.json() as {
      starColor?: string;
      ctaBackground?: string;
      ctaForeground?: string;
      borderRadius?: number;
      background?: string | null;
      text?: string | null;
      ctaLabel?: string;
    };
    const root = document.documentElement;
    if (cfg.starColor) root.style.setProperty('--reviews-star-color', cfg.starColor);
    if (cfg.ctaBackground) root.style.setProperty('--reviews-cta-bg', cfg.ctaBackground);
    if (cfg.ctaForeground) root.style.setProperty('--reviews-cta-fg', cfg.ctaForeground);
    if (typeof cfg.borderRadius === 'number') {
      root.style.setProperty('--reviews-border-radius', `${cfg.borderRadius}px`);
    }
    // background/text are null = inherit; only set the var when an explicit
    // override is present, so the default falls through to the theme.
    if (cfg.background) root.style.setProperty('--reviews-bg', cfg.background);
    if (cfg.text) root.style.setProperty('--reviews-text', cfg.text);
    if (typeof cfg.ctaLabel === 'string' && cfg.ctaLabel.trim()) {
      widgetCtaLabel = cfg.ctaLabel.trim();
    }
  } catch {
    // ignore — defaults stay in effect
  }
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Strip a name down to its first word — keeps reviews privacy-friendly by
// default even when the data layer has a fuller name stored.
const firstNameOnly = (name: string | null): string | null => {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] ?? null;
};

const renderStars = (rating: number, max = 5): string => {
  let html = '<span class="rv-stars" aria-hidden="true">';
  for (let i = 1; i <= max; i++) {
    html += `<span class="rv-star${i <= rating ? ' rv-star-on' : ''}">★</span>`;
  }
  html += '</span>';
  return html;
};

const renderAggregateInline = (agg: Aggregate, mode: 'full' | 'aggregate'): string => {
  if (agg.count === 0) {
    if (mode === 'aggregate') return '';
    return `<span class="rv-aggregate rv-aggregate-empty">No reviews yet</span>`;
  }
  const avg = agg.avg ?? 0;
  const stars = renderStars(Math.round(avg));
  if (mode === 'aggregate') {
    return `
      <span class="rv-aggregate">
        ${stars}
        <span class="rv-aggregate-text">(${agg.count})</span>
      </span>
    `;
  }
  return `
    <span class="rv-aggregate">
      ${stars}
      <span class="rv-aggregate-text">${avg.toFixed(1)} (${agg.count})</span>
    </span>
  `;
};

const formatDate = (unixSec: number): string => {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
};

const renderReviewItem = (r: ReviewItem, isOwn: boolean = false): string => {
  const displayName = firstNameOnly(r.reviewerName);
  // Different verification origins get different badge text so the storefront
  // is honest about provenance. Purchase reviews → "Verified Buyer"; sample/
  // influencer reviews → "Verified Reviewer". Unverified → no badge.
  const verifiedBadge = (() => {
    const kind = r.verifiedKind ?? (r.verifiedPurchase ? 'purchase' : null);
    if (kind === 'purchase') return `<span class="rv-review-verified">Verified Buyer</span>`;
    if (kind === 'sample') return `<span class="rv-review-verified">Verified Reviewer</span>`;
    return '';
  })();
  const ownTag = isOwn ? '<span class="rv-your-review-tag">Your review</span>' : '';
  // Customers can't report their own review — that's just a self-edit
  // scenario, and the storefront-customer edit modal already exists for it.
  const reportLink = isOwn
    ? ''
    : `<button type="button" class="rv-report-link" data-rv-report="${r.id}">Report</button>`;
  return `
    <li class="rv-review" data-rv-review-id="${r.id}">
      <div class="rv-review-head">
        ${renderStars(r.rating)}
        ${r.title ? `<strong class="rv-review-title">${escapeHtml(r.title)}</strong>` : ''}
        ${ownTag}
      </div>
      <div class="rv-review-meta">
        ${displayName ? `<span class="rv-review-author">${escapeHtml(displayName)}</span>` : ''}
        <span class="rv-review-date">${formatDate(r.createdAt)}</span>
        ${verifiedBadge}
      </div>
      <div class="rv-review-body">${escapeHtml(r.body).replace(/\n/g, '<br>')}</div>
      <div class="rv-review-actions">${reportLink}</div>
    </li>
  `;
};

const fetchReviews = async (productId: string, variantId: string | null): Promise<ReviewsResponse> => {
  const url = new URL(`${API_BASE}/api/products/${encodeURIComponent(productId)}/reviews`);
  if (variantId) url.searchParams.set('variant', variantId);
  const res = await fetch(url.toString(), {
    method: 'GET',
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ReviewsResponse;
};

const fetchAggregate = async (productId: string): Promise<Aggregate> => {
  const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(productId)}/aggregate`, {
    method: 'GET',
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Aggregate;
};

// App Proxy endpoint — hits the storefront's /apps/reviews/* prefix which
// Shopify forwards to our backend's /proxy/* with HMAC-signed query params.
// Same-origin so Shopify's session cookie is sent; that's what tells Shopify
// who's logged in.
const proxyUrl = (path: string): string =>
  `${window.location.origin}/apps/reviews${path}`;

const fetchMyReview = async (productId: string): Promise<ReviewItem | null> => {
  try {
    const res = await fetch(
      proxyUrl(`/customer/review?product_id=${encodeURIComponent(productId)}`),
      { method: 'GET', credentials: 'same-origin' },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.review ?? null;
  } catch {
    return null;
  }
};

interface ReviewFormData {
  rating: number;
  title: string | null;
  body: string;
  reviewerName: string | null;
}

const submitNewReview = (
  productId: string,
  variantId: string | null,
  data: ReviewFormData,
): Promise<Response> =>
  fetch(proxyUrl('/customer/review'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_id: productId,
      variant_id: variantId,
      rating: data.rating,
      title: data.title,
      body: data.body,
      reviewer_name: data.reviewerName,
    }),
  });

const submitEdit = (reviewId: number, data: ReviewFormData): Promise<Response> =>
  fetch(proxyUrl(`/customer/review/${reviewId}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rating: data.rating,
      title: data.title,
      body: data.body,
      reviewer_name: data.reviewerName,
    }),
  });

// Singleton modal element — created lazily on first open, reused thereafter.
// Lives on document.body so it sits above the storefront's z-index stacks.
let modalEl: HTMLDialogElement | null = null;

const ensureModal = (): HTMLDialogElement => {
  if (modalEl) return modalEl;
  const d = document.createElement('dialog');
  d.className = 'rv-dialog';
  document.body.appendChild(d);
  // Click on the backdrop (target is the dialog itself, not inner content)
  // closes — standard modal pattern.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  modalEl = d;
  return d;
};

interface OpenModalOptions {
  mode: 'create' | 'edit';
  productId: string;
  variantId: string | null;
  productTitle: string;
  existingReview?: ReviewItem;
  onSuccess: () => void;
}

const openReviewModal = (opts: OpenModalOptions): void => {
  const d = ensureModal();
  const r = opts.existingReview;
  const heading = opts.mode === 'edit'
    ? 'Edit your review'
    : `Review ${opts.productTitle || 'this product'}`;

  const starsHtml = [5, 4, 3, 2, 1]
    .map((n) => `
      <input type="radio" id="rv-rating-${n}" name="rating" value="${n}"${r?.rating === n ? ' checked' : ''}>
      <label for="rv-rating-${n}" title="${n} star${n === 1 ? '' : 's'}">★</label>
    `).join('');

  d.innerHTML = `
    <div class="rv-dialog-content">
      <div class="rv-dialog-header">
        <h2 class="rv-dialog-title">${escapeHtml(heading)}</h2>
        <button type="button" class="rv-dialog-close" aria-label="Close">×</button>
      </div>
      <form>
        <label>Rating</label>
        <div class="rv-dialog-stars">${starsHtml}</div>

        <label for="rv-form-title">Title <span style="font-weight:normal;opacity:0.6;">(optional)</span></label>
        <input type="text" id="rv-form-title" name="title" maxlength="120" value="${escapeHtml(r?.title ?? '')}">

        <label for="rv-form-body">Your review</label>
        <textarea id="rv-form-body" name="body" required maxlength="4000">${escapeHtml(r?.body ?? '')}</textarea>

        <label for="rv-form-name">Display name <span style="font-weight:normal;opacity:0.6;">(optional — only first word shown publicly)</span></label>
        <input type="text" id="rv-form-name" name="reviewerName" maxlength="80" value="${escapeHtml(r?.reviewerName ?? '')}">

        <div class="rv-dialog-error" hidden></div>
        <p class="rv-dialog-muted">Reviews may be lightly edited for clarity.</p>
        <div class="rv-dialog-actions">
          <button type="button" class="rv-cta-link" data-rv-cancel>Cancel</button>
          <button type="submit" class="rv-cta-button">${opts.mode === 'edit' ? 'Save changes' : 'Submit review'}</button>
        </div>
      </form>
    </div>
  `;

  const closeBtn = d.querySelector('.rv-dialog-close') as HTMLButtonElement;
  const cancelBtn = d.querySelector('[data-rv-cancel]') as HTMLButtonElement;
  const form = d.querySelector('form') as HTMLFormElement;
  const errBox = d.querySelector('.rv-dialog-error') as HTMLElement;
  const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  const originalLabel = submitBtn.textContent ?? 'Submit';

  const close = () => d.close();
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const rating = Number(fd.get('rating'));
    const titleVal = String(fd.get('title') ?? '').trim() || null;
    const bodyVal = String(fd.get('body') ?? '').trim();
    const nameVal = String(fd.get('reviewerName') ?? '').trim() || null;

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      errBox.textContent = 'Please pick a rating from 1 to 5 stars.';
      errBox.hidden = false;
      return;
    }
    if (!bodyVal) {
      errBox.textContent = 'Please write a few words about your experience.';
      errBox.hidden = false;
      return;
    }

    errBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const formData: ReviewFormData = { rating, title: titleVal, body: bodyVal, reviewerName: nameVal };
    let res: Response;
    try {
      res = opts.mode === 'edit' && r
        ? await submitEdit(r.id, formData)
        : await submitNewReview(opts.productId, opts.variantId, formData);
    } catch {
      errBox.textContent = 'Network error. Please try again.';
      errBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      return;
    }

    if (!res.ok) {
      let msg = 'Something went wrong. Please try again.';
      try {
        const data = await res.json();
        if (data.error === 'not_logged_in') msg = 'Please log in to leave a review.';
        else if (data.error === 'already_reviewed') msg = "You've already reviewed this product.";
        else if (data.error === 'not_yours') msg = 'You can only edit your own reviews.';
        else if (data.error === 'invalid_rating') msg = 'Please pick a valid rating.';
      } catch {
        // body wasn't JSON — fall through to generic message
      }
      errBox.textContent = msg;
      errBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      return;
    }

    close();
    opts.onSuccess();
  });

  d.showModal();
};

const REPORT_REASON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inappropriate', label: 'Inappropriate / offensive content' },
  { value: 'spam-or-fake',  label: 'Spam or fake review' },
  { value: 'off-topic',     label: 'Not about the product' },
  { value: 'pii',           label: 'Contains personal information' },
  { value: 'other',         label: 'Something else' },
];

const openReportModal = (reviewId: number): void => {
  const d = ensureModal();
  const optionsHtml = REPORT_REASON_OPTIONS
    .map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`)
    .join('');

  d.innerHTML = `
    <div class="rv-dialog-content">
      <div class="rv-dialog-header">
        <h2 class="rv-dialog-title">Report this review</h2>
        <button type="button" class="rv-dialog-close" aria-label="Close">×</button>
      </div>
      <form>
        <p class="rv-dialog-muted" style="margin-top:0;">Thanks for flagging this. The merchant will see your report and decide whether to remove the review.</p>

        <label for="rv-report-reason">Reason</label>
        <select id="rv-report-reason" name="reason" required>${optionsHtml}</select>

        <label for="rv-report-message">Additional context (optional)</label>
        <textarea id="rv-report-message" name="message" maxlength="1000" rows="3" placeholder="What's wrong with this review?"></textarea>

        <label for="rv-report-email">Your email (optional)</label>
        <input type="email" id="rv-report-email" name="email" maxlength="200" placeholder="So the merchant can follow up if needed">

        <div class="rv-dialog-error" hidden></div>
        <div class="rv-dialog-actions">
          <button type="button" class="rv-cta-link" data-rv-cancel>Cancel</button>
          <button type="submit" class="rv-cta-button">Submit report</button>
        </div>
      </form>
    </div>
  `;

  const closeBtn = d.querySelector('.rv-dialog-close') as HTMLButtonElement;
  const cancelBtn = d.querySelector('[data-rv-cancel]') as HTMLButtonElement;
  const form = d.querySelector('form') as HTMLFormElement;
  const errBox = d.querySelector('.rv-dialog-error') as HTMLElement;
  const submitBtn = form.querySelector('button[type="submit"]') as HTMLButtonElement;

  const close = () => d.close();
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const reason = String(fd.get('reason') ?? '');
    const message = String(fd.get('message') ?? '').trim() || null;
    const email = String(fd.get('email') ?? '').trim() || null;
    if (!reason) {
      errBox.textContent = 'Please pick a reason.';
      errBox.hidden = false;
      return;
    }
    errBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const res = await fetch(`${API_BASE}/api/reviews/${reviewId}/report`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, message, email }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      errBox.textContent = 'Network error. Please try again.';
      errBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit report';
      return;
    }

    // Replace the form contents with a confirmation; close on user dismiss.
    const content = d.querySelector('.rv-dialog-content') as HTMLElement;
    content.innerHTML = `
      <div class="rv-dialog-header">
        <h2 class="rv-dialog-title">Report received</h2>
        <button type="button" class="rv-dialog-close" aria-label="Close">×</button>
      </div>
      <p>Thanks — the merchant will take a look. You won't get a direct response, but the review may be removed if it doesn't meet their guidelines.</p>
      <div class="rv-dialog-actions">
        <button type="button" class="rv-cta-button" data-rv-cancel>Close</button>
      </div>
    `;
    (content.querySelector('.rv-dialog-close') as HTMLButtonElement).addEventListener('click', close);
    (content.querySelector('[data-rv-cancel]') as HTMLButtonElement).addEventListener('click', close);
  });

  d.showModal();
};

const renderFull = async (
  el: HTMLElement,
  productId: string,
  variantId: string | null,
  customerId: string | null,
): Promise<void> => {
  el.innerHTML = '<div class="rv-widget rv-widget-full"><div class="rv-loading">Loading reviews…</div></div>';
  try {
    // Public reviews come from the CORS API; the logged-in customer's own
    // review (if any) comes from the App-Proxy-gated endpoint. Run them in
    // parallel so we don't wait for two sequential round trips.
    const [data, myReview] = await Promise.all([
      fetchReviews(productId, variantId),
      customerId ? fetchMyReview(productId) : Promise.resolve(null),
    ]);

    // Pause overrides everything else — render a single non-alarming notice
    // and bail before any of the normal layout logic runs.
    if (data.paused) {
      el.innerHTML = `
        <div class="rv-widget rv-widget-full">
          <div class="rv-paused">Reviews are temporarily unavailable. Please check back soon.</div>
        </div>
      `;
      return;
    }

    // Legacy hash-token write link (kept for backward compat with deep-links
    // that arrive from an email but the customer isn't logged in to Shopify).
    const tokenLink = (() => {
      const m = window.location.hash.match(/reviews-token=([^&]+)/);
      if (!m) return '';
      const token = decodeURIComponent(m[1] ?? '');
      const url = `${API_BASE}/r/${encodeURIComponent(token)}`;
      return `<a class="rv-write-link" href="${url}">${escapeHtml(widgetCtaLabel)}</a>`;
    })();

    // Header CTA:
    //   - logged in + have a review → "Edit your review"
    //   - logged in + no review     → "Write a review"
    //   - not logged in             → "Log in to write a review"
    const headerCta = (() => {
      if (!customerId) {
        const returnUrl = window.location.pathname + window.location.search;
        return `<a class="rv-cta-link" href="/account/login?return_url=${encodeURIComponent(returnUrl)}">Log in to write a review</a>`;
      }
      if (myReview) return `<button type="button" class="rv-cta-link" data-rv-edit="${myReview.id}">Edit your review</button>`;
      return `<button type="button" class="rv-cta-button" data-rv-write="1">${escapeHtml(widgetCtaLabel)}</button>`;
    })();

    // The "related" section surfaces when the product is variant-distinct
    // and other variants of the same product have published reviews.
    const relatedBlock = (() => {
      if (!data.related || data.related.reviews.length === 0) return '';
      const label = data.related.reviews.length === 1
        ? 'Show review for other variants'
        : `Show reviews for other variants`;
      return `
        <details class="rv-related-details">
          <summary class="rv-toggle rv-related-toggle">${label}</summary>
          <div class="rv-related-header">
            ${renderAggregateInline(data.related.aggregate, 'full')}
            <span class="rv-muted">across other variants of this product</span>
          </div>
          <ul class="rv-list">
            ${data.related.reviews.map((rr) => renderReviewItem(rr, false)).join('')}
          </ul>
        </details>
      `;
    })();

    // Sort the customer's own review to the top of the list (if it exists
    // and is part of the publicly-returned set).
    const ownInList = !!(myReview && data.reviews.some((rv) => rv.id === myReview.id));
    const orderedReviews = ownInList && myReview
      ? [myReview, ...data.reviews.filter((rv) => rv.id !== myReview.id)]
      : data.reviews;

    if (orderedReviews.length === 0) {
      const emptyCta = customerId && !myReview
        ? `<div class="rv-empty-cta"><button type="button" class="rv-cta-button" data-rv-write="1">${escapeHtml(widgetCtaLabel)}</button></div>`
        : '';
      el.innerHTML = `
        <div class="rv-widget rv-widget-full">
          <div class="rv-header">${renderAggregateInline(data.aggregate, 'full')} ${headerCta || tokenLink}</div>
          <p class="rv-empty">Be the first to review this${data.variantHandling === 'distinct' ? ' variant' : ' product'}.</p>
          ${emptyCta}
          ${relatedBlock}
        </div>
      `;
    } else {
      const toggleLabel = orderedReviews.length === 1 ? 'Show review' : 'Show reviews';
      el.innerHTML = `
        <div class="rv-widget rv-widget-full">
          <div class="rv-header">${renderAggregateInline(data.aggregate, 'full')} ${headerCta || tokenLink}</div>
          <details class="rv-details">
            <summary class="rv-toggle">${toggleLabel}</summary>
            <ul class="rv-list">
              ${orderedReviews.map((rv) => renderReviewItem(rv, !!(myReview && rv.id === myReview.id))).join('')}
            </ul>
          </details>
          ${relatedBlock}
        </div>
      `;
    }

    // Wire CTA buttons. The renderFull call is re-invoked on successful
    // modal submission so the widget reflects the new state without a page
    // reload.
    el.querySelectorAll<HTMLButtonElement>('[data-rv-write]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openReviewModal({
          mode: 'create',
          productId,
          variantId,
          productTitle: '',
          onSuccess: () => renderFull(el, productId, variantId, customerId),
        });
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-rv-edit]').forEach((btn) => {
      const reviewId = Number(btn.getAttribute('data-rv-edit'));
      if (!myReview || myReview.id !== reviewId) return;
      btn.addEventListener('click', () => {
        openReviewModal({
          mode: 'edit',
          productId,
          variantId,
          productTitle: '',
          existingReview: myReview,
          onSuccess: () => renderFull(el, productId, variantId, customerId),
        });
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-rv-report]').forEach((btn) => {
      const reviewId = Number(btn.getAttribute('data-rv-report'));
      if (!Number.isFinite(reviewId) || reviewId <= 0) return;
      btn.addEventListener('click', () => openReportModal(reviewId));
    });
  } catch (err) {
    el.innerHTML = '<div class="rv-widget rv-widget-full"><div class="rv-error">Reviews unavailable</div></div>';
    console.warn('reviews widget error', err);
  }
};

const renderAggregate = async (el: HTMLElement, productId: string): Promise<void> => {
  try {
    const agg = await fetchAggregate(productId);
    // Hide aggregate entirely while paused — same rationale as the full widget:
    // "pause all review display."
    if (agg.paused || agg.count === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="rv-widget rv-widget-aggregate">${renderAggregateInline(agg, 'aggregate')}</div>`;
  } catch (err) {
    el.innerHTML = '';
    console.warn('reviews widget aggregate error', err);
  }
};

// Relay the store's brand assets to our backend, once per browser session.
// The theme renders the brand colors + logo (Liquid `shop.brand`) onto the
// widget div as data attributes; this hands them to the App-Proxy-verified
// /brand endpoint so the backend's shop_brand_json (widget/email/theme
// defaults) stays in sync with Shopify without Storefront API access. The
// endpoint no-ops when nothing changed, and the session guard keeps it to one
// POST per visit. Best-effort: any failure is silent.
const BRAND_RELAYED_KEY = 'rv-brand-relayed';
const relayBrand = (el: HTMLElement): void => {
  let already = false;
  try { already = !!sessionStorage.getItem(BRAND_RELAYED_KEY); } catch { return; }
  if (already) return;
  const payload = {
    primaryBg: el.getAttribute('data-brand-primary-bg') || '',
    primaryFg: el.getAttribute('data-brand-primary-fg') || '',
    secondaryBg: el.getAttribute('data-brand-secondary-bg') || '',
    secondaryFg: el.getAttribute('data-brand-secondary-fg') || '',
    logo: el.getAttribute('data-brand-logo') || '',
  };
  // Theme didn't pass any brand attributes → nothing to relay.
  if (!payload.primaryBg && !payload.secondaryBg && !payload.logo) return;
  try { sessionStorage.setItem(BRAND_RELAYED_KEY, '1'); } catch { /* ignore */ }
  void fetch(proxyUrl('/brand'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* best-effort */ });
};

// --- Campaign application form ---
//
// Activated by a `<div data-campaign-form="<slug>"></div>` element in a
// Shopify Page (or any storefront template). The widget fetches the campaign
// config from /apps/reviews/campaigns/:slug/config, renders the form, and
// submits to /apps/reviews/campaigns/:slug/apply on submit. Both calls go
// through Shopify App Proxy (HMAC-verified server-side).

const CAMPAIGN_STYLES = `
.rv-campaign {
  font-family: inherit;
  color: var(--reviews-text, inherit);
  background: var(--reviews-bg, transparent);
  max-width: 640px;
  margin: 2rem auto;
  padding: 0 1rem;
  box-sizing: border-box;
  line-height: 1.5;
}
.rv-campaign h2 { margin: 0 0 12px; font-size: 1.4em; font-weight: 600; }
.rv-campaign-intro { margin: 0 0 24px; opacity: 0.85; }
.rv-campaign-field { display: block; margin: 12px 0; }
.rv-campaign-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.rv-campaign-field input, .rv-campaign-field textarea {
  width: 100%; padding: 8px 10px; border: 1px solid #bbb; border-radius: 4px;
  font-size: 14px; font-family: inherit; box-sizing: border-box;
  background: transparent; color: inherit;
}
.rv-campaign-row { display: flex; gap: 12px; }
.rv-campaign-row .rv-campaign-field { flex: 1; }
.rv-campaign-terms {
  margin: 24px 0 12px; padding: 12px; border: 1px solid #ddd; border-radius: 4px;
  max-height: 180px; overflow-y: auto; font-size: 13px; white-space: pre-wrap;
  background: rgba(0,0,0,0.02);
}
.rv-campaign-accept { display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 24px; font-size: 14px; }
.rv-campaign-accept input { margin-top: 3px; }
.rv-campaign-submit {
  background: var(--reviews-cta-bg, #111); color: var(--reviews-cta-fg, #fff);
  border: none; padding: 10px 20px; font-size: 15px; font-weight: 600;
  border-radius: 4px; cursor: pointer; font-family: inherit;
}
.rv-campaign-submit:disabled { opacity: 0.6; cursor: wait; }
.rv-campaign-error { color: #b00; margin: 12px 0; font-size: 14px; }
.rv-campaign-success { padding: 16px; background: rgba(40, 120, 40, 0.08); border-radius: 4px; }
.rv-campaign-closed { padding: 16px; background: rgba(0,0,0,0.04); border-radius: 4px; text-align: center; }
`;

let campaignStylesInjected = false;
const injectCampaignStyles = (): void => {
  if (campaignStylesInjected) return;
  campaignStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = CAMPAIGN_STYLES;
  document.head.appendChild(style);
};

interface CampaignConfig {
  state: 'open' | 'closed';
  campaignName: string;
  slug?: string;
  productCount?: number;
  terms?: { versionId: number; versionNumber: number; body: string };
}

const renderCampaignForm = async (el: HTMLElement, slug: string): Promise<void> => {
  injectCampaignStyles();
  el.classList.add('rv-campaign');
  el.innerHTML = `<p class="rv-loading">Loading…</p>`;

  let cfg: CampaignConfig;
  try {
    const res = await fetch(proxyUrl(`/campaigns/${encodeURIComponent(slug)}/config`), {
      credentials: 'include',
    });
    if (!res.ok) {
      el.innerHTML = `<p class="rv-campaign-closed">This application form is not available.</p>`;
      return;
    }
    cfg = await res.json() as CampaignConfig;
  } catch {
    el.innerHTML = `<p class="rv-campaign-error">We couldn't load the form. Please reload the page.</p>`;
    return;
  }

  if (cfg.state !== 'open' || !cfg.terms) {
    el.innerHTML = `
      <h2>${escapeHtmlText(cfg.campaignName)}</h2>
      <p class="rv-campaign-closed">Applications are closed.</p>
    `;
    return;
  }

  const terms = cfg.terms;
  el.innerHTML = `
    <h2>${escapeHtmlText(cfg.campaignName)}</h2>
    <p class="rv-campaign-intro">Apply below to be considered for this sample program.</p>
    <form class="rv-campaign-form" novalidate>
      <div class="rv-campaign-row">
        <div class="rv-campaign-field">
          <label>First name</label>
          <input type="text" name="firstName" required maxlength="80" />
        </div>
        <div class="rv-campaign-field">
          <label>Last name</label>
          <input type="text" name="lastName" required maxlength="80" />
        </div>
      </div>
      <div class="rv-campaign-field">
        <label>Email</label>
        <input type="email" name="email" required maxlength="254" />
      </div>
      <h3 style="margin-top:24px; font-size:1em;">Shipping address</h3>
      <div class="rv-campaign-field">
        <label>Street address</label>
        <input type="text" name="street1" required maxlength="200" />
      </div>
      <div class="rv-campaign-field">
        <label>Apartment, suite, etc. (optional)</label>
        <input type="text" name="street2" maxlength="200" />
      </div>
      <div class="rv-campaign-row">
        <div class="rv-campaign-field">
          <label>City</label>
          <input type="text" name="city" required maxlength="100" />
        </div>
        <div class="rv-campaign-field">
          <label>State / Region</label>
          <input type="text" name="state" maxlength="100" />
        </div>
      </div>
      <div class="rv-campaign-row">
        <div class="rv-campaign-field">
          <label>Postal code</label>
          <input type="text" name="postalCode" required maxlength="24" />
        </div>
        <div class="rv-campaign-field">
          <label>Country</label>
          <input type="text" name="country" required maxlength="100" />
        </div>
      </div>
      <div class="rv-campaign-field">
        <label>Anything you'd like us to know? (optional)</label>
        <textarea name="message" rows="3" maxlength="2000"></textarea>
      </div>
      <div class="rv-campaign-terms" aria-label="Program terms">${escapeHtmlText(terms.body)}</div>
      <label class="rv-campaign-accept">
        <input type="checkbox" name="termsAccepted" required />
        <span>I have read and agree to the terms above.</span>
      </label>
      <div class="rv-campaign-error" data-error hidden></div>
      <button type="submit" class="rv-campaign-submit">Submit application</button>
    </form>
  `;

  const formEl = el.querySelector<HTMLFormElement>('.rv-campaign-form');
  const errorEl = el.querySelector<HTMLElement>('[data-error]');
  const submitEl = el.querySelector<HTMLButtonElement>('.rv-campaign-submit');
  if (!formEl || !errorEl || !submitEl) return;

  formEl.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    errorEl.textContent = '';

    const fd = new FormData(formEl);
    const accepted = (fd.get('termsAccepted') as string) === 'on';
    if (!accepted) {
      errorEl.hidden = false;
      errorEl.textContent = 'You must accept the terms to continue.';
      return;
    }

    submitEl.disabled = true;
    submitEl.textContent = 'Submitting…';

    const payload = {
      firstName: fd.get('firstName'),
      lastName: fd.get('lastName'),
      email: fd.get('email'),
      message: fd.get('message'),
      shipping: {
        street1: fd.get('street1'),
        street2: fd.get('street2'),
        city: fd.get('city'),
        state: fd.get('state'),
        postalCode: fd.get('postalCode'),
        country: fd.get('country'),
      },
      termsVersionId: terms.versionId,
    };

    try {
      const res = await fetch(proxyUrl(`/campaigns/${encodeURIComponent(slug)}/apply`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string; detail?: string };
        const msg = data.detail
          || campaignErrorMessage(data.error)
          || 'Something went wrong. Please try again.';
        errorEl.hidden = false;
        errorEl.textContent = msg;
        submitEl.disabled = false;
        submitEl.textContent = 'Submit application';
        return;
      }
      el.innerHTML = `
        <h2>${escapeHtmlText(cfg.campaignName)}</h2>
        <div class="rv-campaign-success">
          <strong>Thanks! We received your application.</strong>
          <p>We'll review every application and let you know whether you've been selected. Watch your email for a confirmation in the next few minutes.</p>
        </div>
      `;
    } catch {
      errorEl.hidden = false;
      errorEl.textContent = 'Network error — please try again.';
      submitEl.disabled = false;
      submitEl.textContent = 'Submit application';
    }
  });
};

const campaignErrorMessage = (code: string | undefined): string | null => {
  switch (code) {
    case 'invalid_email':              return 'Please enter a valid email address.';
    case 'missing_first_name':         return 'First name is required.';
    case 'missing_last_name':          return 'Last name is required.';
    case 'incomplete_shipping_address':return 'Please complete the shipping address.';
    case 'applications_closed':        return 'Applications for this program are closed.';
    case 'terms_changed':              return 'The program terms were updated while you were filling out the form. Please reload.';
    case 'rate_limited':               return 'Too many submissions from your network. Please try again in a minute.';
    default:                           return null;
  }
};

const escapeHtmlText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Campaign feedback form ---
//
// Activated by `<div data-campaign-feedback-form="<access_key>"></div>`.
// Fetches the form schema from /apps/reviews/campaigns/feedback/:key/config,
// renders the questions, and submits to /apps/reviews/campaigns/feedback/:key/submit.

interface FeedbackQuestion {
  id: number;
  type: 'rating_1_5' | 'single_choice' | 'multi_choice' | 'short_text' | 'long_text';
  prompt: string;
  required: boolean;
  options: string[];
}

interface FeedbackFormConfig {
  title: string;
  introText: string | null;
  questions: FeedbackQuestion[];
}

const renderFeedbackForm = async (el: HTMLElement, accessKey: string): Promise<void> => {
  injectCampaignStyles();
  el.classList.add('rv-campaign');
  el.innerHTML = `<p class="rv-loading">Loading…</p>`;

  let cfg: FeedbackFormConfig;
  try {
    const res = await fetch(proxyUrl(`/feedback/${encodeURIComponent(accessKey)}`), {
      credentials: 'include',
    });
    if (!res.ok) {
      el.innerHTML = `<p class="rv-campaign-closed">This feedback form is not available.</p>`;
      return;
    }
    cfg = await res.json() as FeedbackFormConfig;
  } catch {
    el.innerHTML = `<p class="rv-campaign-error">We couldn't load the form. Please reload the page.</p>`;
    return;
  }

  const questionsHtml = cfg.questions.map((q) => renderFeedbackQuestion(q)).join('');
  el.innerHTML = `
    <h2>${escapeHtmlText(cfg.title)}</h2>
    ${cfg.introText ? `<p class="rv-campaign-intro">${escapeHtmlText(cfg.introText)}</p>` : ''}
    <form class="rv-feedback-form" novalidate>
      ${questionsHtml}
      <div class="rv-campaign-row">
        <div class="rv-campaign-field">
          <label>Name (optional)</label>
          <input type="text" name="optionalName" maxlength="160" />
        </div>
        <div class="rv-campaign-field">
          <label>Email (optional)</label>
          <input type="email" name="optionalEmail" maxlength="254" />
        </div>
      </div>
      <p class="rv-campaign-intro" style="font-size:12px;">Responses are anonymous unless you provide name and email above.</p>
      <div class="rv-campaign-error" data-error hidden></div>
      <button type="submit" class="rv-campaign-submit">Submit feedback</button>
    </form>
  `;

  const formEl = el.querySelector<HTMLFormElement>('.rv-feedback-form');
  const errorEl = el.querySelector<HTMLElement>('[data-error]');
  const submitEl = el.querySelector<HTMLButtonElement>('.rv-campaign-submit');
  if (!formEl || !errorEl || !submitEl) return;

  formEl.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    errorEl.textContent = '';

    const fd = new FormData(formEl);
    const answers: Array<{ questionId: number; value: unknown }> = [];
    for (const q of cfg.questions) {
      if (q.type === 'rating_1_5') {
        const v = fd.get(`q_${q.id}`);
        if (typeof v === 'string' && v !== '') answers.push({ questionId: q.id, value: Number(v) });
      } else if (q.type === 'single_choice') {
        const v = fd.get(`q_${q.id}`);
        if (typeof v === 'string' && v !== '') answers.push({ questionId: q.id, value: v });
      } else if (q.type === 'multi_choice') {
        const all = fd.getAll(`q_${q.id}`);
        const arr = all.filter((v): v is string => typeof v === 'string');
        if (arr.length > 0) answers.push({ questionId: q.id, value: arr });
      } else {
        const v = fd.get(`q_${q.id}`);
        if (typeof v === 'string' && v.trim() !== '') answers.push({ questionId: q.id, value: v });
      }
    }

    const payload = {
      optionalName: fd.get('optionalName'),
      optionalEmail: fd.get('optionalEmail'),
      answers,
    };

    submitEl.disabled = true;
    submitEl.textContent = 'Submitting…';

    try {
      const res = await fetch(proxyUrl(`/feedback/${encodeURIComponent(accessKey)}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        errorEl.hidden = false;
        errorEl.textContent = data.error === 'missing_required'
          ? 'Please answer all required questions.'
          : 'Something went wrong. Please try again.';
        submitEl.disabled = false;
        submitEl.textContent = 'Submit feedback';
        return;
      }
      el.innerHTML = `
        <h2>${escapeHtmlText(cfg.title)}</h2>
        <div class="rv-campaign-success">
          <strong>Thanks for your feedback!</strong>
          <p>Your response has been recorded.</p>
        </div>
      `;
    } catch {
      errorEl.hidden = false;
      errorEl.textContent = 'Network error — please try again.';
      submitEl.disabled = false;
      submitEl.textContent = 'Submit feedback';
    }
  });
};

const renderFeedbackQuestion = (q: FeedbackQuestion): string => {
  const required = q.required ? ' <span style="color:#b00;">*</span>' : '';
  const name = `q_${q.id}`;
  switch (q.type) {
    case 'rating_1_5': {
      // Five radio buttons, big and tappable. Numbers only — labelling them
      // as "stars" is presumptuous (the merchant may be asking about
      // satisfaction, likelihood-to-recommend, etc., not a star rating).
      const radios = [1, 2, 3, 4, 5].map((n) => `
        <label style="display:inline-flex; align-items:center; gap:4px; margin-right:12px;">
          <input type="radio" name="${name}" value="${n}" ${q.required ? 'required' : ''} />
          <span>${n}</span>
        </label>
      `).join('');
      return `<div class="rv-campaign-field"><label>${escapeHtmlText(q.prompt)}${required}</label><div>${radios}</div></div>`;
    }
    case 'single_choice': {
      const radios = q.options.map((opt) => `
        <label style="display:block; margin:4px 0;">
          <input type="radio" name="${name}" value="${escapeHtmlText(opt)}" ${q.required ? 'required' : ''} />
          ${escapeHtmlText(opt)}
        </label>
      `).join('');
      return `<div class="rv-campaign-field"><label>${escapeHtmlText(q.prompt)}${required}</label>${radios}</div>`;
    }
    case 'multi_choice': {
      const boxes = q.options.map((opt) => `
        <label style="display:block; margin:4px 0;">
          <input type="checkbox" name="${name}" value="${escapeHtmlText(opt)}" />
          ${escapeHtmlText(opt)}
        </label>
      `).join('');
      return `<div class="rv-campaign-field"><label>${escapeHtmlText(q.prompt)}${required}</label>${boxes}</div>`;
    }
    case 'short_text':
      return `<div class="rv-campaign-field"><label>${escapeHtmlText(q.prompt)}${required}</label><input type="text" name="${name}" maxlength="500" ${q.required ? 'required' : ''} /></div>`;
    case 'long_text':
      return `<div class="rv-campaign-field"><label>${escapeHtmlText(q.prompt)}${required}</label><textarea name="${name}" rows="4" maxlength="5000" ${q.required ? 'required' : ''}></textarea></div>`;
  }
};

// Initialize a single widget element. Idempotent: a `data-rv-initialized`
// flag stops us from rendering twice if the element gets re-visited (e.g.
// the MutationObserver fires for a node we already handled in the initial
// scan).
const initializeElement = (el: HTMLElement): void => {
  if (el.hasAttribute('data-rv-initialized')) return;
  el.setAttribute('data-rv-initialized', 'true');

  // Brand relay reads attributes off the widget div; attempt it before the
  // product-id guard so an aggregate/collection card can carry brand data too.
  relayBrand(el);

  // Campaign-form mode: separate from review widgets, gated by a different
  // attribute. Slug-only — no product id required.
  const campaignSlug = el.getAttribute('data-campaign-form');
  if (campaignSlug) {
    void renderCampaignForm(el, campaignSlug);
    return;
  }

  // Campaign feedback form: gated by data-campaign-feedback-form="<accessKey>".
  const feedbackKey = el.getAttribute('data-campaign-feedback-form');
  if (feedbackKey) {
    void renderFeedbackForm(el, feedbackKey);
    return;
  }

  const mode = el.getAttribute('data-reviews-widget');
  const productId = el.getAttribute('data-product-id');
  if (!productId) return;
  // data-variant-id is optional; when omitted (e.g., collection-card
  // aggregate mode, or themes that haven't been updated yet), the API
  // treats the request as variant-unscoped and returns the full product
  // review pool regardless of variant_handling.
  const variantId = el.getAttribute('data-variant-id') || null;
  // data-customer-id (passed by the theme from {{ customer.id }}) signals
  // whether a Shopify customer is logged in. Empty string or missing means
  // anonymous — the widget shows a "Log in to write a review" affordance
  // instead of the form. Submission and edit always re-verify on the
  // server via the App Proxy signature; this attribute is only for UI.
  const rawCustomerId = el.getAttribute('data-customer-id');
  const customerId = rawCustomerId && rawCustomerId.trim() !== '' ? rawCustomerId.trim() : null;
  if (mode === 'full') void renderFull(el, productId, variantId, customerId);
  else if (mode === 'aggregate') void renderAggregate(el, productId);
};

const init = async (): Promise<void> => {
  injectStylesOnce();
  // Await config before the first render so the configured CTA label (text,
  // not a CSS var) is in place. Colors would apply either way via CSS vars.
  await applyWidgetConfig();

  // Initial scan — picks up widget elements that are in the DOM at
  // DOMContentLoaded. Review widgets, campaign-form divs, and campaign-
  // feedback-form divs all flow through initializeElement; the routing
  // inside picks the right renderer.
  const SELECTOR = '[data-reviews-widget], [data-campaign-form], [data-campaign-feedback-form]';
  document.querySelectorAll<HTMLElement>(SELECTOR).forEach(initializeElement);

  // Late-arriving widgets (Shopify's async product-recommendations,
  // variant-change section re-renders, infinite-scroll collection pages,
  // etc.) get caught by a MutationObserver that watches the whole body for
  // newly-inserted nodes. The callback is cheap when no widget elements are
  // involved (typical mutations), so leaving it running indefinitely is
  // fine.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (
          node.hasAttribute('data-reviews-widget') ||
          node.hasAttribute('data-campaign-form') ||
          node.hasAttribute('data-campaign-feedback-form')
        ) {
          initializeElement(node);
        }
        node.querySelectorAll<HTMLElement>(SELECTOR).forEach(initializeElement);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
  void init();
}
