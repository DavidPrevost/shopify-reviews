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
  color: inherit;
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
  border-radius: 6px;
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
  return `
    <li class="rv-review">
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

    // Legacy hash-token write link (kept for backward compat with deep-links
    // that arrive from an email but the customer isn't logged in to Shopify).
    const tokenLink = (() => {
      const m = window.location.hash.match(/reviews-token=([^&]+)/);
      if (!m) return '';
      const token = decodeURIComponent(m[1] ?? '');
      const url = `${API_BASE}/r/${encodeURIComponent(token)}`;
      return `<a class="rv-write-link" href="${url}">Write a review</a>`;
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
      return `<button type="button" class="rv-cta-button" data-rv-write="1">Write a review</button>`;
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
        ? `<div class="rv-empty-cta"><button type="button" class="rv-cta-button" data-rv-write="1">Write a review</button></div>`
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
  } catch (err) {
    el.innerHTML = '<div class="rv-widget rv-widget-full"><div class="rv-error">Reviews unavailable</div></div>';
    console.warn('reviews widget error', err);
  }
};

const renderAggregate = async (el: HTMLElement, productId: string): Promise<void> => {
  try {
    const agg = await fetchAggregate(productId);
    if (agg.count === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="rv-widget rv-widget-aggregate">${renderAggregateInline(agg, 'aggregate')}</div>`;
  } catch (err) {
    el.innerHTML = '';
    console.warn('reviews widget aggregate error', err);
  }
};

// Initialize a single widget element. Idempotent: a `data-rv-initialized`
// flag stops us from rendering twice if the element gets re-visited (e.g.
// the MutationObserver fires for a node we already handled in the initial
// scan).
const initializeElement = (el: HTMLElement): void => {
  if (el.hasAttribute('data-rv-initialized')) return;
  el.setAttribute('data-rv-initialized', 'true');

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

const init = (): void => {
  injectStylesOnce();

  // Initial scan — picks up widget elements that are in the DOM at
  // DOMContentLoaded.
  document.querySelectorAll<HTMLElement>('[data-reviews-widget]').forEach(initializeElement);

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
        if (node.hasAttribute('data-reviews-widget')) {
          initializeElement(node);
        }
        node.querySelectorAll<HTMLElement>('[data-reviews-widget]').forEach(initializeElement);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
