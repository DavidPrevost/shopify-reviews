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
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
};

const renderReviewItem = (r: ReviewItem): string => {
  const displayName = firstNameOnly(r.reviewerName);
  return `
    <li class="rv-review">
      <div class="rv-review-head">
        ${renderStars(r.rating)}
        ${r.title ? `<strong class="rv-review-title">${escapeHtml(r.title)}</strong>` : ''}
      </div>
      <div class="rv-review-meta">
        ${displayName ? `<span class="rv-review-author">${escapeHtml(displayName)}</span>` : ''}
        <span class="rv-review-date">${formatDate(r.createdAt)}</span>
        ${r.verifiedPurchase ? `<span class="rv-review-verified">Verified Buyer</span>` : ''}
      </div>
      <div class="rv-review-body">${escapeHtml(r.body).replace(/\n/g, '<br>')}</div>
    </li>
  `;
};

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
  el.innerHTML = '<div class="rv-widget rv-widget-full"><div class="rv-loading">Loading reviews…</div></div>';
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
          <div class="rv-header">${renderAggregateInline(data.aggregate, 'full')} ${writeLink}</div>
          <p class="rv-empty">Be the first to review this product.</p>
        </div>
      `;
      return;
    }

    const label = data.reviews.length === 1 ? 'Show review' : `Show reviews`;
    el.innerHTML = `
      <div class="rv-widget rv-widget-full">
        <div class="rv-header">${renderAggregateInline(data.aggregate, 'full')} ${writeLink}</div>
        <details class="rv-details">
          <summary class="rv-toggle">${label}</summary>
          <ul class="rv-list">
            ${data.reviews.map(renderReviewItem).join('')}
          </ul>
        </details>
      </div>
    `;
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

const init = (): void => {
  injectStylesOnce();
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
