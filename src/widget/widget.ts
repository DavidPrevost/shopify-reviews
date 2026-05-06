// Storefront widget — vanilla TypeScript, no framework. Bundled by esbuild
// into public/widget.js as a single IIFE. Loaded from the storefront via:
//   <script src="https://reviews.brandname.com/widget.js" defer></script>
//
// Renders into placeholder <div>s with `data-reviews-widget` and `data-product-id`.
// Two modes:
//   data-reviews-widget="full"      → aggregate + reviews list (product page)
//   data-reviews-widget="aggregate" → stars + count only (collection cards)

interface ReviewItem {
  id: number;
  rating: number;
  title: string | null;
  body: string;
  reviewerName: string | null;
  verifiedPurchase: boolean;
  createdAt: number;
}

interface Aggregate {
  avg: number | null;
  count: number;
}

interface ReviewsResponse {
  reviews: ReviewItem[];
  aggregate: Aggregate;
  page: number;
  size: number;
}

declare const __REVIEWS_API_BASE__: string;
const API_BASE = __REVIEWS_API_BASE__;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderStars = (rating: number, max = 5): string => {
  let html = '<span class="rv-stars" aria-hidden="true">';
  for (let i = 1; i <= max; i++) {
    html += `<span class="rv-star${i <= rating ? ' rv-star-on' : ''}">★</span>`;
  }
  html += '</span>';
  return html;
};

const renderAggregateInline = (agg: Aggregate): string => {
  if (agg.count === 0) {
    return `<span class="rv-aggregate rv-aggregate-empty">No reviews yet</span>`;
  }
  const avg = agg.avg ?? 0;
  return `
    <span class="rv-aggregate">
      ${renderStars(Math.round(avg))}
      <span class="rv-aggregate-text">${avg.toFixed(1)} (${agg.count} review${agg.count === 1 ? '' : 's'})</span>
    </span>
  `;
};

const formatDate = (unixSec: number): string => {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const renderReviewItem = (r: ReviewItem): string => `
  <li class="rv-review">
    <div class="rv-review-head">
      ${renderStars(r.rating)}
      ${r.title ? `<strong class="rv-review-title">${escapeHtml(r.title)}</strong>` : ''}
    </div>
    <div class="rv-review-meta">
      ${r.reviewerName ? `<span class="rv-review-author">${escapeHtml(r.reviewerName)}</span>` : ''}
      ${r.verifiedPurchase ? `<span class="rv-review-verified">Verified buyer</span>` : ''}
      <span class="rv-review-date">${formatDate(r.createdAt)}</span>
    </div>
    <div class="rv-review-body">${escapeHtml(r.body).replace(/\n/g, '<br>')}</div>
  </li>
`;

const fetchReviews = async (productId: string): Promise<ReviewsResponse> => {
  const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(productId)}/reviews`, {
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

const renderFull = async (el: HTMLElement, productId: string): Promise<void> => {
  el.innerHTML = '<div class="rv-loading">Loading reviews…</div>';
  try {
    const data = await fetchReviews(productId);
    const writeLink = (() => {
      const m = window.location.hash.match(/reviews-token=([^&]+)/);
      if (!m) return '';
      const token = decodeURIComponent(m[1] ?? '');
      const url = `${API_BASE}/r/${encodeURIComponent(token)}`;
      return `<a class="rv-write-link" href="${url}">Write a review</a>`;
    })();

    if (data.reviews.length === 0) {
      el.innerHTML = `
        <div class="rv-widget rv-widget-full">
          <div class="rv-header">${renderAggregateInline(data.aggregate)} ${writeLink}</div>
          <p class="rv-empty">Be the first to review this product.</p>
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="rv-widget rv-widget-full">
        <div class="rv-header">${renderAggregateInline(data.aggregate)} ${writeLink}</div>
        <ul class="rv-list">
          ${data.reviews.map(renderReviewItem).join('')}
        </ul>
      </div>
    `;
  } catch (err) {
    el.innerHTML = '<div class="rv-error">Reviews unavailable</div>';
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
    el.innerHTML = `<div class="rv-widget rv-widget-aggregate">${renderAggregateInline(agg)}</div>`;
  } catch (err) {
    el.innerHTML = '';
    console.warn('reviews widget aggregate error', err);
  }
};

const init = (): void => {
  const nodes = document.querySelectorAll<HTMLElement>('[data-reviews-widget]');
  nodes.forEach((el) => {
    const mode = el.getAttribute('data-reviews-widget');
    const productId = el.getAttribute('data-product-id');
    if (!productId) return;
    if (mode === 'full') void renderFull(el, productId);
    else if (mode === 'aggregate') void renderAggregate(el, productId);
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
