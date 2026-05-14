import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  listReviews,
  countReviewsByStatus,
  findReviewById,
  updateReviewStatus,
  setMerchantReply,
  getCustomerDetail,
  emailEventStats,
  setSetting,
  getSetting,
  getSettingNumber,
  setGlobalOptOut,
  clearGlobalOptOut,
  createSampleInvitation,
  listSampleInvitations,
  type ReviewRow,
} from '../db/queries.js';
import { signSampleInviteToken, SAMPLE_INVITE_TTL_DAYS } from '../email/tokens.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { getOrFetchProduct } from '../shopify/product-info.js';
import { parseProductId } from '../shopify/parse-product-id.js';
import { backfillRecentOrders } from '../shopify/sync.js';
import { fetchShopifyBrand, resolveBrandColors } from '../shopify/brand-info.js';
import { runDispatcher } from '../scheduler/dispatcher.js';
import { restartScheduler } from '../scheduler/cron.js';
import {
  verifyAdminPassword,
  signSessionCookie,
  verifySessionCookie,
  SESSION_COOKIE_NAME,
} from '../lib/auth.js';
import { escapeHtml } from '../email/render.js';
import { log } from '../lib/logger.js';
import { config } from '../config.js';
import { nowSec, daysToSec } from '../lib/time.js';

const admin = new Hono();

const requireAuth = async (c: import('hono').Context): Promise<boolean> => {
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionCookie(cookie);
};

const adminShell = (title: string, body: string, navActive?: string): string => {
  const tabs = [
    { href: '/admin/dashboard',           label: 'Dashboard',   key: 'dashboard' },
    { href: '/admin/reviews',             label: 'Reviews',     key: 'reviews' },
    { href: '/admin/sample-invitations',  label: 'Invitations', key: 'invitations' },
    { href: '/admin/settings',            label: 'Settings',    key: 'settings' },
  ];
  const navHtml = tabs
    .map(
      (t) => `<a href="${t.href}" class="${t.key === navActive ? 'active' : ''}">${t.label}</a>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Reviews admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; margin: 0; background:#f6f6f6; color:#222; }
    header { background:#222; color:#fff; padding: 12px 24px; display:flex; align-items:center; justify-content:space-between; }
    header h1 { margin:0; font-size: 18px; font-weight: 600; }
    header nav a { color:#bbb; text-decoration:none; margin-right: 18px; font-size: 14px; }
    header nav a.active, header nav a:hover { color:#fff; }
    header .logout { color:#bbb; text-decoration:none; font-size:13px; }
    main { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
    h2 { margin-top: 0; }
    table { width:100%; border-collapse: collapse; background:#fff; border-radius:6px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.05); }
    th, td { padding: 10px 12px; text-align:left; border-bottom: 1px solid #eee; vertical-align: top; font-size: 14px; }
    th { background:#fafafa; font-weight: 600; font-size: 12px; text-transform: uppercase; color:#666; }
    tr:last-child td { border-bottom: none; }
    .stars { color: #f5a623; letter-spacing: 1px; }
    .pill { display:inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; text-transform: uppercase; font-weight: 600; }
    .pill-published { background: #dfe9d9; color: #2d572c; }
    .pill-pending { background: #fff3cd; color: #856404; }
    .pill-rejected { background: #f8d7da; color: #721c24; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background:#fff; padding: 16px; border-radius: 6px; box-shadow:0 1px 4px rgba(0,0,0,0.05); }
    .stat .num { font-size: 24px; font-weight: 600; }
    .stat .label { font-size: 12px; color:#888; text-transform: uppercase; }
    form.inline { display:inline; }
    button { padding: 6px 12px; font-size: 13px; border: 1px solid #ccc; background:#fff; border-radius:4px; cursor:pointer; }
    button.primary { background: #222; color: #fff; border-color: #222; }
    button.danger { color: #b00; border-color: #faa; }
    button:hover { opacity: 0.85; }
    label { display:block; font-size: 13px; font-weight: 600; margin-top: 12px; }
    input[type=text], input[type=number], input[type=password], textarea { width:100%; padding: 8px 10px; border:1px solid #ccc; border-radius: 4px; font-size: 14px; }
    .card { background:#fff; padding: 24px; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.05); margin-bottom: 24px; }
    .filter-row { margin-bottom: 16px; display:flex; gap: 8px; align-items: center; }
    .filter-row a { padding:6px 12px; border-radius:4px; text-decoration:none; color:#222; border:1px solid #ddd; background:#fff; font-size:13px; }
    .filter-row a.active { background:#222; color:#fff; border-color:#222; }
    .err { background:#fee; border:1px solid #fcc; color:#933; padding:12px; border-radius:4px; margin-bottom:16px; }
    .ok  { background:#efe; border:1px solid #cdc; color:#363; padding:12px; border-radius:4px; margin-bottom:16px; }
    .muted { color:#888; font-size: 13px; }
    .tabs { display:flex; border-bottom: 2px solid #ddd; margin-bottom: 24px; gap: 0; flex-wrap: wrap; }
    .tabs a { padding: 12px 20px; text-decoration: none; color: #666; border-bottom: 2px solid transparent; margin-bottom: -2px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .tabs a:hover { color: #222; }
    .tabs a.active { color: #222; border-bottom-color: #222; font-weight: 600; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>Reviews admin</h1>
    <nav>${navHtml}</nav>
    <a class="logout" href="/admin/logout">Sign out</a>
  </header>
  <main>${body}</main>
</body>
</html>`;
};

const loginShell = (errorMessage?: string): string => {
  const err = errorMessage ? `<div class="err">${escapeHtml(errorMessage)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in — Reviews admin</title>
<style>
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; background:#f6f6f6; color:#222; margin:0; padding:64px 16px; }
  .card { max-width: 360px; margin: 0 auto; background:#fff; padding: 32px; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,0.06); }
  h1 { font-size: 20px; margin: 0 0 24px; }
  label { display:block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 15px; box-sizing: border-box; margin-bottom: 16px; }
  button { width:100%; padding: 12px; background:#222; color:#fff; border:none; border-radius:4px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .err { background:#fee; border:1px solid #fcc; color:#933; padding:10px; border-radius:4px; margin-bottom: 16px; font-size: 13px; }
</style></head>
<body>
  <div class="card">
    <h1>Reviews admin</h1>
    ${err}
    <form method="POST" action="/admin/login">
      <label for="password">Password</label>
      <input id="password" type="password" name="password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body></html>`;
};

// --- Login / logout ---

admin.get('/', (c) => c.html(loginShell()));

admin.post('/login', async (c) => {
  const form = await c.req.formData();
  const password = String(form.get('password') ?? '');

  if (!(await verifyAdminPassword(password))) {
    log('warn', 'admin login failed', {});
    return c.html(loginShell('Incorrect password.'), 401);
  }

  const token = signSessionCookie();
  setCookie(c, SESSION_COOKIE_NAME, token, {
    path: '/admin',
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'Lax',
    maxAge: daysToSec(config.admin.sessionTtlDays),
  });
  log('info', 'admin login success', {});
  return c.redirect('/admin/dashboard');
});

admin.get('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/admin' });
  return c.redirect('/admin');
});

// --- Auth gate for everything below ---
admin.use('/dashboard', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/reviews', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/reviews/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/customers/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/settings', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/sync', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/dispatch', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/sample-invitations', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/sample-invitations/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});

// --- Dashboard ---

admin.get('/dashboard', (c) => {
  const counts = countReviewsByStatus();
  const since30d = nowSec() - daysToSec(30);
  const stats = emailEventStats(since30d);
  const recentReviews = listReviews({ limit: 10, offset: 0 });

  const statBlocks = [
    { label: 'Published', n: counts.published ?? 0 },
    { label: 'Pending',   n: counts.pending ?? 0 },
    { label: 'Rejected',  n: counts.rejected ?? 0 },
    { label: 'Sent (30d)',        n: stats.request_sent ?? 0 },
    { label: 'Submitted (30d)',   n: stats.review_submitted ?? 0 },
    { label: 'Unsubscribed (30d)', n: stats.unsubscribed ?? 0 },
    { label: 'Send failed (30d)', n: stats.send_failed ?? 0 },
  ];

  const statsHtml = `<div class="stats">${statBlocks
    .map((s) => `<div class="stat"><div class="num">${s.n}</div><div class="label">${s.label}</div></div>`)
    .join('')}</div>`;

  const recentHtml = recentReviews.length === 0
    ? '<p class="muted">No reviews yet.</p>'
    : `<table>
        <thead><tr><th>When</th><th>Rating</th><th>Product</th><th>Reviewer</th><th>Status</th><th></th></tr></thead>
        <tbody>${recentReviews.map(reviewRowHtml).join('')}</tbody>
       </table>`;

  return c.html(adminShell('Dashboard', `
    <h2>Overview</h2>
    ${statsHtml}
    <h2>Recent reviews</h2>
    ${recentHtml}
    <h2 style="margin-top:32px;">Operations</h2>
    <div class="card">
      <form class="inline" method="POST" action="/admin/sync">
        <button type="submit">Run Shopify backfill (last 90 days)</button>
      </form>
      <form class="inline" method="POST" action="/admin/dispatch" style="margin-left:8px;">
        <button type="submit">Run dispatcher now</button>
      </form>
      <p class="muted" style="margin-top:12px;">The dispatcher normally runs daily at 14:00 UTC. Use this to force a run for testing.</p>
    </div>
  `, 'dashboard'));
});

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
const formatTs = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
const statusPill = (status: string) =>
  `<span class="pill pill-${status}">${status}</span>`;

const reviewRowHtml = (r: ReviewRow): string => `
  <tr>
    <td class="muted">${formatTs(r.created_at)}</td>
    <td class="stars">${stars(r.rating)}</td>
    <td>${escapeHtml(r.shopify_product_id)}</td>
    <td>${escapeHtml(r.reviewer_name ?? r.reviewer_email)}</td>
    <td>${statusPill(r.status)}</td>
    <td><a href="/admin/reviews/${r.id}">View</a></td>
  </tr>
`;

// --- Reviews list ---

admin.get('/reviews', (c) => {
  const status = c.req.query('status');
  const page = Math.max(1, Number(c.req.query('page') ?? '1'));
  const size = 50;
  const reviews = listReviews({ status, limit: size, offset: (page - 1) * size });

  const filterTabs = ['all', 'published', 'pending', 'rejected']
    .map(
      (label) => {
        const href = label === 'all' ? '/admin/reviews' : `/admin/reviews?status=${label}`;
        const active = (status === label) || (label === 'all' && !status);
        return `<a href="${href}" class="${active ? 'active' : ''}">${label}</a>`;
      },
    )
    .join('');

  const tableHtml = reviews.length === 0
    ? '<p class="muted">No reviews matching this filter.</p>'
    : `<table>
        <thead><tr><th>When</th><th>Rating</th><th>Product</th><th>Reviewer</th><th>Status</th><th></th></tr></thead>
        <tbody>${reviews.map(reviewRowHtml).join('')}</tbody>
       </table>`;

  return c.html(adminShell('Reviews', `
    <h2>Reviews</h2>
    <div class="filter-row">${filterTabs}</div>
    ${tableHtml}
  `, 'reviews'));
});

// --- Review detail + moderation ---

admin.get('/reviews/:id', (c) => {
  const id = Number(c.req.param('id'));
  const review = findReviewById(id);
  if (!review) return c.html(adminShell('Not found', `<p>Review ${id} not found.</p>`), 404);

  return c.html(adminShell(`Review #${review.id}`, `
    <h2>Review #${review.id}</h2>
    <div class="card">
      <p><span class="stars">${stars(review.rating)}</span> &nbsp; ${statusPill(review.status)}</p>
      <p class="muted">${formatTs(review.created_at)} · Product ${escapeHtml(review.shopify_product_id)} · ${escapeHtml(review.reviewer_email)}</p>
      ${review.title ? `<h3>${escapeHtml(review.title)}</h3>` : ''}
      <p style="white-space: pre-wrap;">${escapeHtml(review.body)}</p>
    </div>

    <div class="card">
      <h3>Moderation</h3>
      <form class="inline" method="POST" action="/admin/reviews/${review.id}/status">
        <input type="hidden" name="status" value="published">
        <button type="submit" class="primary">Publish</button>
      </form>
      <form class="inline" method="POST" action="/admin/reviews/${review.id}/status" style="margin-left:8px;">
        <input type="hidden" name="status" value="pending">
        <button type="submit">Hold for review</button>
      </form>
      <form class="inline" method="POST" action="/admin/reviews/${review.id}/status" style="margin-left:8px;">
        <input type="hidden" name="status" value="rejected">
        <button type="submit" class="danger">Reject</button>
      </form>
    </div>

    <div class="card">
      <h3>Merchant reply</h3>
      <form method="POST" action="/admin/reviews/${review.id}/reply">
        <textarea name="reply" rows="4" placeholder="Optional public reply">${escapeHtml(review.merchant_reply ?? '')}</textarea>
        <div style="margin-top:12px;">
          <button type="submit" class="primary">Save reply</button>
        </div>
      </form>
      <p class="muted" style="margin-top:12px;">Replies are stored now; a future update will surface them on the storefront.</p>
    </div>
  `, 'reviews'));
});

admin.post('/reviews/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const next = String(form.get('status') ?? '');
  if (!['published', 'pending', 'rejected'].includes(next)) {
    return c.text('invalid status', 400);
  }
  updateReviewStatus(id, next as 'published' | 'pending' | 'rejected');
  log('info', 'admin review status changed', { id, status: next });
  return c.redirect(`/admin/reviews/${id}`);
});

admin.post('/reviews/:id/reply', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const replyRaw = String(form.get('reply') ?? '').trim();
  setMerchantReply(id, replyRaw === '' ? null : replyRaw);
  log('info', 'admin merchant reply saved', { id, hasReply: replyRaw !== '' });
  return c.redirect(`/admin/reviews/${id}`);
});

// --- Customer detail (manage opt-outs) ---

admin.get('/customers/:email', (c) => {
  const email = decodeURIComponent(c.req.param('email'));
  const detail = getCustomerDetail(email);
  if (!detail) return c.html(adminShell('Not found', `<p>No customer for ${escapeHtml(email)}</p>`), 404);

  const resubscribedCount = c.req.query('resubscribed');
  const flash = resubscribedCount
    ? `<div class="ok">Re-subscribed. Cleared ${escapeHtml(resubscribedCount)} pending review-request${resubscribedCount === '1' ? '' : 's'} so the customer won't be backfilled.</div>`
    : '';

  const purchasesHtml = detail.purchases.length === 0
    ? '<p class="muted">No purchases on record.</p>'
    : `<table>
        <thead><tr><th>Order</th><th>Product</th><th>Fulfilled</th><th>Reviewed</th><th>Requests sent</th><th>Opted out</th></tr></thead>
        <tbody>${detail.purchases
          .map((p) => `<tr>
            <td>${escapeHtml(p.shopify_order_id)}</td>
            <td>${escapeHtml(p.shopify_product_id)}</td>
            <td>${p.fulfilled_at ? formatTs(p.fulfilled_at) : '—'}</td>
            <td>${p.reviewed_at ? formatTs(p.reviewed_at) : '—'}</td>
            <td>${p.request_count}</td>
            <td>${p.product_opt_out ? 'yes' : 'no'}</td>
          </tr>`)
          .join('')}</tbody>
       </table>`;

  const optOutForm = detail.global_opt_out
    ? `<p>This customer has globally unsubscribed from review requests.</p>
       <form method="POST" action="/admin/customers/${encodeURIComponent(email)}/resubscribe" onsubmit="return confirm('Re-subscribe ${escapeHtml(email)}? This clears any pending review requests so they don\\'t get backfilled.');">
         <button type="submit">Re-subscribe customer</button>
       </form>
       <p class="muted" style="font-size:0.85em;margin-top:4px;">Re-subscribing also clears <code>due_at</code> on the customer's pending purchases so they don't receive a backlog of review-request emails from the period they were opted out.</p>`
    : `<form method="POST" action="/admin/customers/${encodeURIComponent(email)}/global-opt-out">
         <button type="submit" class="danger">Apply global opt-out</button>
       </form>`;

  return c.html(adminShell(`Customer ${email}`, `
    ${flash}
    <h2>${escapeHtml(email)}</h2>
    <div class="card">
      <p>${escapeHtml([detail.first_name, detail.last_name].filter(Boolean).join(' ') || '(no name)')}</p>
      <p class="muted">Unanswered request count: ${detail.unanswered_request_count} · Last request: ${detail.last_request_sent_at ? formatTs(detail.last_request_sent_at) : 'never'}</p>
      ${optOutForm}
    </div>
    <h3>Purchases</h3>
    ${purchasesHtml}
  `));
});

admin.post('/customers/:email/global-opt-out', (c) => {
  const email = decodeURIComponent(c.req.param('email'));
  const detail = getCustomerDetail(email);
  if (!detail) return c.text('not found', 404);
  setGlobalOptOut(detail.id);
  log('info', 'admin applied global opt-out', { customerId: detail.id });
  return c.redirect(`/admin/customers/${encodeURIComponent(email)}`);
});

admin.post('/customers/:email/resubscribe', (c) => {
  const email = decodeURIComponent(c.req.param('email'));
  const detail = getCustomerDetail(email);
  if (!detail) return c.text('not found', 404);
  const { purchasesCleared } = clearGlobalOptOut(detail.id);
  log('info', 'admin re-subscribed customer', { customerId: detail.id, purchasesCleared });
  return c.redirect(`/admin/customers/${encodeURIComponent(email)}?resubscribed=${purchasesCleared}`);
});

// --- Sample invitations ---

admin.get('/sample-invitations', (c) => {
  const { pending, consumed, expired } = listSampleInvitations();
  const flash = (() => {
    const created = c.req.query('created');
    if (!created) return '';
    const url = `${config.publicUrl}/r/invite/${encodeURIComponent(created)}`;
    return `<div class="ok" style="margin-bottom:16px;">
      <strong>Invitation created.</strong> Copy this link and send it to the recipient:
      <br><br>
      <input type="text" readonly value="${escapeHtml(url)}" style="width:100%;font-family:monospace;font-size:13px;padding:8px;" onclick="this.select();">
      <p class="muted" style="margin-top:8px;">Click the link box to select it. The recipient has ${SAMPLE_INVITE_TTL_DAYS} days to submit their review before this invitation expires. Each link is single-use.</p>
    </div>`;
  })();

  const renderRow = (inv: typeof pending[number], extraCell?: string) => `
    <tr>
      <td>${inv.id}</td>
      <td><code>${escapeHtml(inv.shopify_product_id)}</code></td>
      <td>${escapeHtml(inv.intended_name ?? '—')}</td>
      <td>${escapeHtml(inv.intended_email ?? '—')}</td>
      <td>${escapeHtml(inv.notes ?? '—')}</td>
      <td>${formatTs(inv.created_at)}</td>
      <td>${formatTs(inv.expires_at)}</td>
      ${extraCell ?? ''}
    </tr>`;

  const pendingTable = pending.length === 0
    ? '<p class="muted">No pending invitations.</p>'
    : `<table>
        <thead><tr><th>ID</th><th>Product ID</th><th>Name</th><th>Email</th><th>Notes</th><th>Created</th><th>Expires</th><th>Link</th></tr></thead>
        <tbody>${pending.map((inv) => renderRow(inv, `
          <td><a href="${escapeHtml(config.publicUrl)}/r/invite/${encodeURIComponent(signSampleInviteToken({ invitationId: inv.id, productId: inv.shopify_product_id, exp: inv.expires_at }))}" target="_blank">View link</a></td>
        `)).join('')}</tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:12px;">Note: clicking "View link" generates a fresh signed token for that invitation, all valid until the invitation's expiry date. The original token sent at creation time is also still valid as long as the invitation row is unconsumed and not expired.</p>`;

  const consumedTable = consumed.length === 0
    ? '<p class="muted">No consumed invitations yet.</p>'
    : `<table>
        <thead><tr><th>ID</th><th>Product ID</th><th>Name</th><th>Email</th><th>Notes</th><th>Created</th><th>Expires</th><th>Review</th></tr></thead>
        <tbody>${consumed.map((inv) => renderRow(inv, `
          <td>${inv.consumed_review_id ? `<a href="/admin/reviews/${inv.consumed_review_id}">#${inv.consumed_review_id}</a>` : '—'}</td>
        `)).join('')}</tbody>
      </table>`;

  const expiredTable = expired.length === 0
    ? '<p class="muted">No expired invitations.</p>'
    : `<table>
        <thead><tr><th>ID</th><th>Product ID</th><th>Name</th><th>Email</th><th>Notes</th><th>Created</th><th>Expires</th><th></th></tr></thead>
        <tbody>${expired.map((inv) => renderRow(inv, '<td>expired</td>')).join('')}</tbody>
      </table>`;

  return c.html(adminShell('Sample invitations', `
    <h2>Sample invitations</h2>
    <p class="muted">Create a single-use review link for someone who received a product outside the normal Shopify purchase flow (free samples, influencer outreach, etc.). The reviewer's submission is recorded with a "Verified Reviewer" badge on the storefront — distinct from the "Verified Buyer" badge used for purchase-based reviews.</p>

    <nav class="tabs" id="invitations-tabs">
      <a href="#individual" data-tab="individual">Individual</a>
      <a href="#batch"      data-tab="batch">Batch</a>
      <a href="#manage"     data-tab="manage">Manage <span class="muted" style="font-weight:normal;">(${pending.length + consumed.length + expired.length})</span></a>
    </nav>

    <section id="tab-individual" class="tab-panel" data-tab="individual">
      ${flash}
      <div class="card">
        <h3 style="margin-top:0;">Create new invitation</h3>
        <form method="POST" action="/admin/sample-invitations">
          <label for="shopify_product_id">Shopify product</label>
          <input id="shopify_product_id" name="shopify_product_id" type="text" required placeholder="e.g., 9218705883386 — or paste the admin URL">
          <p class="muted" style="font-size:12px;margin-top:4px;">Paste the numeric product ID, the admin URL (e.g., <code>https://admin.shopify.com/store/.../products/9218705883386</code>), or a <code>gid://shopify/Product/&lt;id&gt;</code> reference. Storefront URLs (which use product handles rather than IDs) aren't supported.</p>

          <label for="intended_name">Recipient name (optional, for your tracking)</label>
          <input id="intended_name" name="intended_name" type="text" maxlength="120">

          <label for="intended_email">Recipient email (optional, for your tracking)</label>
          <input id="intended_email" name="intended_email" type="text" maxlength="200">

          <label for="notes">Internal notes (optional)</label>
          <input id="notes" name="notes" type="text" maxlength="500" placeholder="e.g., Sample drop batch 1 / Instagram outreach / etc.">

          <div style="margin-top:24px;">
            <button type="submit" class="primary">Generate invitation link</button>
          </div>
        </form>
      </div>
    </section>

    <section id="tab-batch" class="tab-panel" data-tab="batch">
      <div class="card">
        <h3 style="margin-top:0;">Batch upload (CSV)</h3>
        <p class="muted">Upload a CSV to create many invitations at once. CSV must have a header row. Recognized columns (case-insensitive, all whitespace trimmed):</p>
        <ul class="muted" style="font-size:13px;">
          <li><code>product_id</code> — required; accepts a numeric ID, admin URL, or GID</li>
          <li><code>name</code> (or <code>intended_name</code>) — optional</li>
          <li><code>email</code> (or <code>intended_email</code>) — optional</li>
          <li><code>notes</code> — optional</li>
        </ul>
        <p class="muted" style="font-size:13px;">Extra columns are ignored. Rows with a missing or unrecognized <code>product_id</code> are skipped (you'll see the row numbers and reasons in the summary).</p>
        <p style="font-size:13px;"><a href="/admin/sample-invitations/template" download>Download blank template (CSV)</a></p>
        <form method="POST" action="/admin/sample-invitations/batch" enctype="multipart/form-data">
          <label for="batch_file">CSV file</label>
          <input id="batch_file" name="file" type="file" accept=".csv,text/csv" required>
          <div style="margin-top:24px;">
            <button type="submit">Upload and create</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h3 style="margin-top:0;">Export</h3>
        <p class="muted">Download every invitation (pending, consumed, and expired) as a CSV — including the shareable URL for each pending invitation. Suitable for mail-merge tools.</p>
        <p><a href="/admin/sample-invitations/export">Download all invitations as CSV</a></p>
      </div>
    </section>

    <section id="tab-manage" class="tab-panel" data-tab="manage">
      <h3>Pending (${pending.length})</h3>
      ${pendingTable}

      <h3 style="margin-top:32px;">Consumed (${consumed.length})</h3>
      ${consumedTable}

      <h3 style="margin-top:32px;">Expired without use (${expired.length})</h3>
      ${expiredTable}
    </section>

    <script>
      (function () {
        var tabs = document.querySelectorAll('#invitations-tabs a');
        var panels = document.querySelectorAll('.tab-panel');
        function show(name) {
          tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
          panels.forEach(function (p) { p.classList.toggle('active', p.dataset.tab === name); });
        }
        // Initial tab: from URL hash if present, otherwise "individual" — but
        // if the user just created an invitation (?created=... in the URL),
        // force Individual so the success flash with the copyable link is
        // visible regardless of any stale hash.
        var hash = (location.hash || '').replace('#', '');
        var hasCreated = location.search.indexOf('created=') !== -1;
        var initial = hasCreated ? 'individual' : (hash || 'individual');
        show(initial);
        // Tab clicks intercepted: preventDefault stops the native hash-jump,
        // replaceState swaps the URL hash without pushing a history entry.
        // Net effect: tab switches do not pollute browser back/forward — those
        // continue to navigate between pages rather than between tabs.
        tabs.forEach(function (a) {
          a.addEventListener('click', function (e) {
            e.preventDefault();
            var name = a.dataset.tab;
            history.replaceState(null, '', '#' + name);
            show(name);
          });
        });
      })();
    </script>
  `, 'invitations'));
});

// CSV column normalization — accepts a few common alias spellings so users
// don't have to remember our exact column names.
const pickField = (row: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[k] ?? row[k.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return '';
};

const csvEscape = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s === '') return '';
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

admin.post('/sample-invitations/batch', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return c.html(adminShell('Upload failed', '<div class="err">No CSV file uploaded.</div><p><a href="/admin/sample-invitations">Back</a></p>', 'invitations'), 400);
  }
  if (file.size > 1024 * 1024) {
    return c.html(adminShell('Upload failed', '<div class="err">CSV is too large (max 1 MB). Split into multiple smaller files if needed.</div><p><a href="/admin/sample-invitations">Back</a></p>', 'invitations'), 413);
  }

  const text = await file.text();

  let records: Array<Record<string, string>>;
  try {
    records = parseCsv(text, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Array<Record<string, string>>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(adminShell('Upload failed', `<div class="err">CSV could not be parsed: ${escapeHtml(msg)}</div><p><a href="/admin/sample-invitations">Back</a></p>`, 'invitations'), 400);
  }

  const expiresAt = nowSec() + daysToSec(SAMPLE_INVITE_TTL_DAYS);
  const created: number[] = [];
  const errors: Array<{ rowNumber: number; reason: string }> = [];

  records.forEach((row, idx) => {
    const csvRowNumber = idx + 2; // +1 for header, +1 for 1-indexing

    const rawProduct = pickField(row, 'product_id', 'productid', 'shopify_product_id');
    if (!rawProduct) {
      errors.push({ rowNumber: csvRowNumber, reason: 'missing product_id' });
      return;
    }
    const productId = parseProductId(rawProduct);
    if (!productId) {
      errors.push({ rowNumber: csvRowNumber, reason: `couldn't extract product ID from "${rawProduct}"` });
      return;
    }
    const intendedName = pickField(row, 'name', 'intended_name') || null;
    const intendedEmail = pickField(row, 'email', 'intended_email') || null;
    const notes = pickField(row, 'notes') || null;

    try {
      const invitation = createSampleInvitation({
        shopifyProductId: productId,
        intendedEmail,
        intendedName,
        notes,
        expiresAt,
      });
      created.push(invitation.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ rowNumber: csvRowNumber, reason: msg });
    }
  });

  log('info', 'admin batch-created sample invitations', {
    createdCount: created.length,
    errorCount: errors.length,
    fileName: file.name,
  });

  const errorList = errors.length === 0
    ? ''
    : `<div class="err" style="margin-top:16px;">${errors.length} row${errors.length === 1 ? '' : 's'} skipped:</div>
       <ul>${errors.map((e) => `<li>Row ${e.rowNumber}: ${escapeHtml(e.reason)}</li>`).join('')}</ul>`;

  if (created.length === 0) {
    return c.html(adminShell('Batch upload — no rows created', `
      <h2>Batch upload</h2>
      <div class="err">No invitations were created.</div>
      ${errorList}
      <p style="margin-top:24px;"><a href="/admin/sample-invitations">Back to invitations</a></p>
    `, 'invitations'), 400);
  }

  return c.html(adminShell('Batch upload complete', `
    <h2>Batch upload</h2>
    <div class="ok">Created ${created.length} invitation${created.length === 1 ? '' : 's'}.</div>
    ${errorList}
    <p style="margin-top:24px;">
      <a href="/admin/sample-invitations#manage">View the invitations list</a> ·
      <a href="/admin/sample-invitations/export">Download CSV with all invitation links</a>
    </p>
  `, 'invitations'));
});

admin.get('/sample-invitations/template', (c) => {
  // Header + one clearly-placeholder example row. If the user uploads it
  // unedited, the parser rejects "REPLACE_WITH_PRODUCT_ID" as an
  // unrecognized format and reports it in the skipped-rows summary.
  const body =
    'product_id,name,email,notes\r\n' +
    'REPLACE_WITH_PRODUCT_ID,Recipient name,recipient@example.com,Optional notes\r\n';
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', 'attachment; filename="sample-invitations-template.csv"');
  return c.body(body);
});

admin.get('/sample-invitations/export', async (c) => {
  const { pending, consumed, expired } = listSampleInvitations();
  const all = [...pending, ...consumed, ...expired];

  // Pre-fetch product titles in parallel; each call hits products_cache
  // first and only goes to Shopify on cache miss.
  const uniqueProductIds = [...new Set(all.map((i) => i.shopify_product_id))];
  const productTitleByid = new Map<string, string>();
  await Promise.all(
    uniqueProductIds.map(async (pid) => {
      try {
        const p = await getOrFetchProduct(pid);
        productTitleByid.set(pid, p?.title ?? '');
      } catch {
        productTitleByid.set(pid, '');
      }
    }),
  );

  const now = nowSec();
  const header = ['id', 'status', 'product_id', 'product_name', 'name', 'email', 'notes', 'created_iso', 'expires_iso', 'consumed_iso', 'invitation_url'];

  const lines = [header.join(',')];
  for (const inv of all) {
    const status =
      inv.consumed_at !== null ? 'consumed' :
      inv.expires_at <= now ? 'expired' :
      'pending';
    const token = signSampleInviteToken({
      invitationId: inv.id,
      productId: inv.shopify_product_id,
      exp: inv.expires_at,
    });
    const url = `${config.publicUrl}/r/invite/${token}`;
    const productName = productTitleByid.get(inv.shopify_product_id) ?? '';
    lines.push([
      inv.id,
      status,
      csvEscape(inv.shopify_product_id),
      csvEscape(productName),
      csvEscape(inv.intended_name),
      csvEscape(inv.intended_email),
      csvEscape(inv.notes),
      new Date(inv.created_at * 1000).toISOString(),
      new Date(inv.expires_at * 1000).toISOString(),
      inv.consumed_at !== null ? new Date(inv.consumed_at * 1000).toISOString() : '',
      csvEscape(url),
    ].join(','));
  }

  const body = lines.join('\r\n') + '\r\n';
  const today = new Date().toISOString().slice(0, 10);
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="sample-invitations-${today}.csv"`);
  return c.body(body);
});

admin.post('/sample-invitations', async (c) => {
  const form = await c.req.formData();
  const rawProduct = String(form.get('shopify_product_id') ?? '').trim();
  if (!rawProduct) {
    return c.html(adminShell('Invalid input', '<div class="err">Product ID is required.</div><p><a href="/admin/sample-invitations">Back</a></p>', 'invitations'), 400);
  }
  const productId = parseProductId(rawProduct);
  if (!productId) {
    return c.html(adminShell('Invalid input', `<div class="err">Couldn't recognize "${escapeHtml(rawProduct)}" as a product ID, admin URL, or GID. Paste a numeric ID, an admin URL ending in <code>/products/&lt;id&gt;</code>, or a <code>gid://shopify/Product/&lt;id&gt;</code> reference.</div><p><a href="/admin/sample-invitations">Back</a></p>`, 'invitations'), 400);
  }
  const intendedName = String(form.get('intended_name') ?? '').trim() || null;
  const intendedEmail = String(form.get('intended_email') ?? '').trim() || null;
  const notes = String(form.get('notes') ?? '').trim() || null;

  const expiresAt = nowSec() + daysToSec(SAMPLE_INVITE_TTL_DAYS);
  const invitation = createSampleInvitation({
    shopifyProductId: productId,
    intendedEmail,
    intendedName,
    notes,
    expiresAt,
  });

  const token = signSampleInviteToken({
    invitationId: invitation.id,
    productId: invitation.shopify_product_id,
    exp: invitation.expires_at,
  });

  log('info', 'admin created sample invitation', {
    invitationId: invitation.id,
    productId,
    intendedEmail: intendedEmail ? '[set]' : null,
  });

  return c.redirect(`/admin/sample-invitations?created=${encodeURIComponent(token)}`);
});

// --- Settings ---

admin.get('/settings', (c) => {
  const flash = c.req.query('saved') === '1' ? '<div class="ok">Settings saved.</div>' : '';
  const cadenceMax = getSettingNumber('cadence_max_requests', 3);
  const cadenceMin = getSettingNumber('cadence_min_days_between', 7);
  const requestDelay = getSettingNumber('request_delay_days', 7);
  const dispatcherBatch = getSettingNumber('cadence_dispatcher_batch', 100);
  const dispatcherHour = getSettingNumber('dispatcher_hour', 20);
  const dispatcherMinute = getSettingNumber('dispatcher_minute', 17);
  const immediateOnFulfillment = getSetting('dispatch_immediately_on_fulfillment') === '1';
  const brandJsonRaw = getSetting('shop_brand_json') ?? '{}';
  const resolvedColors = resolveBrandColors(brandJsonRaw);

  // Try to extract whether Shopify-side brand info is actually populated for
  // the preview block. If parsing fails, show no preview.
  let brandPreviewHtml = '';
  try {
    const parsed = JSON.parse(brandJsonRaw);
    const primary = parsed?.colors?.primary;
    const secondary = parsed?.colors?.secondary;
    const hasAny = !!(primary?.background || secondary?.background || parsed?.logoUrl);
    if (hasAny) {
      const swatch = (label: string, bg: string | null | undefined, fg: string | null | undefined) =>
        bg ? `<div style="display:inline-block;margin-right:12px;"><div style="display:inline-block;width:20px;height:20px;background:${escapeHtml(bg)};border:1px solid #ccc;border-radius:3px;vertical-align:middle;"></div> ${escapeHtml(label)} <code style="color:#666;">${escapeHtml(bg)}</code>${fg ? ` / <code style="color:#666;">${escapeHtml(fg)}</code>` : ''}</div>` : '';
      brandPreviewHtml = `
        <div style="margin: 8px 0 16px; padding: 12px; background:#f9f9f9; border-radius: 4px; font-size: 13px;">
          ${swatch('Primary', primary?.background, primary?.foreground)}
          ${swatch('Secondary', secondary?.background, secondary?.foreground)}
          ${parsed?.logoUrl ? `<div style="margin-top:8px;">Logo: <a href="${escapeHtml(parsed.logoUrl)}" target="_blank">${escapeHtml(parsed.logoUrl)}</a></div>` : ''}
          ${parsed?.syncedAt ? `<div class="muted" style="margin-top:4px;">Synced ${escapeHtml(formatTs(parsed.syncedAt))}</div>` : ''}
        </div>`;
    } else {
      brandPreviewHtml = `<p class="muted" style="margin: 8px 0 16px;">No brand info synced yet. Click below to fetch from Shopify, or set brand colors in your Shopify admin (Settings → Brand) first.</p>`;
    }
  } catch {
    brandPreviewHtml = '<p class="muted">(unparseable shop_brand_json — sync to overwrite, or fix the JSON below)</p>';
  }

  // Hour dropdown: 1-12
  const hourOptions = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((h) => `<option value="${h}">${h}</option>`)
    .join('');
  // Minute dropdown: 0-59, two-digit
  const minuteOptions = Array.from({ length: 60 }, (_, i) => i)
    .map((m) => `<option value="${m}">${m.toString().padStart(2, '0')}</option>`)
    .join('');

  return c.html(adminShell('Settings', `
    <h2>Cadence</h2>
    ${flash}
    <div class="card">
      <form method="POST" action="/admin/settings" id="settings-form">
        <label for="cadence_max_requests">Max requests per purchase</label>
        <input id="cadence_max_requests" name="cadence_max_requests" type="number" min="1" max="10" value="${cadenceMax}">

        <label for="cadence_min_days_between">Minimum days between requests to the same customer</label>
        <input id="cadence_min_days_between" name="cadence_min_days_between" type="number" min="1" max="365" value="${cadenceMin}">

        <label for="request_delay_days">Days after fulfillment before first request</label>
        <input id="request_delay_days" name="request_delay_days" type="number" min="0" max="180" value="${requestDelay}">

        <label for="cadence_dispatcher_batch">Per-run safety cap (max emails per dispatcher tick)</label>
        <input id="cadence_dispatcher_batch" name="cadence_dispatcher_batch" type="number" min="1" max="2000" value="${dispatcherBatch}">
        <p class="muted">Gmail's free-tier sending ceiling is ~500/day. Keep this comfortably below that.</p>

        <label>Daily dispatcher time</label>
        <div style="display:flex; gap:8px; align-items:center; margin-top:4px;">
          <select id="dispatcher_hour_local" style="width:auto;">${hourOptions}</select>
          <span>:</span>
          <select id="dispatcher_minute_local" style="width:auto;">${minuteOptions}</select>
          <select id="dispatcher_ampm" style="width:auto;">
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
          <span id="dispatcher_tz_label" class="muted" style="margin-left:8px;"></span>
        </div>
        <p class="muted">Time shown in your browser's local timezone. The dispatcher runs once daily at this time.</p>
        <input type="hidden" name="dispatcher_hour" id="dispatcher_hour" value="${dispatcherHour}">
        <input type="hidden" name="dispatcher_minute" id="dispatcher_minute" value="${dispatcherMinute}">

        <label>Brand info (synced from Shopify, applied to email button colors)</label>
        ${brandPreviewHtml}
        <p class="muted" style="margin: 4px 0 8px;">Resolved CTA color: <code>${escapeHtml(resolvedColors.ctaBackground)}</code> background, <code>${escapeHtml(resolvedColors.ctaForeground)}</code> text. Falls back to neutral defaults when Shopify has nothing configured.</p>

        <details style="margin: 8px 0 16px;">
          <summary style="cursor:pointer; font-size: 13px; color:#666;">Advanced: edit raw JSON</summary>
          <textarea id="shop_brand_json" name="shop_brand_json" rows="6" style="margin-top:8px;">${escapeHtml(brandJsonRaw)}</textarea>
        </details>

        <p>
          <button type="submit" formaction="/admin/settings/sync-brand" formnovalidate>Sync brand info from Shopify</button>
        </p>

        <div style="margin-top:24px; padding:16px; background:#fff8e1; border:1px solid #ffd54f; border-radius:6px;">
          <label style="font-weight:600; color:#7a4f01; display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="dispatch_immediately_on_fulfillment" value="1" ${immediateOnFulfillment ? 'checked' : ''} style="width:auto;">
            <span>Send review-request email immediately on fulfillment <em style="color:#a86b00;">— testing only</em></span>
          </label>
          <p class="muted" style="margin:8px 0 0; color:#7a4f01;">
            <strong>Leave OFF in production.</strong> When ON, every order's review email goes out within seconds of being marked fulfilled — bypassing the normal <code>request_delay_days</code> waiting period that prevents the system from feeling spammy. Useful for end-to-end testing where waiting 14 days isn't practical.
          </p>
        </div>

        <div style="margin-top:24px;">
          <button type="submit" class="primary">Save settings</button>
        </div>
      </form>
    </div>

    <script>
      (function() {
        // Stored values are UTC. Convert to/from local for the user-facing controls.
        var utcHour = ${dispatcherHour};
        var utcMinute = ${dispatcherMinute};

        var tz;
        try {
          tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch (e) {
          tz = 'UTC';
        }
        document.getElementById('dispatcher_tz_label').textContent = 'Timezone: ' + tz;

        function utcToLocal(h, m) {
          var d = new Date();
          d.setUTCHours(h, m, 0, 0);
          return { h: d.getHours(), m: d.getMinutes() };
        }
        function localToUtc(h, m) {
          var d = new Date();
          d.setHours(h, m, 0, 0);
          return { h: d.getUTCHours(), m: d.getUTCMinutes() };
        }
        function to12Hour(h) {
          var ampm = h >= 12 ? 'PM' : 'AM';
          var h12 = h % 12;
          if (h12 === 0) h12 = 12;
          return { h: h12, ampm: ampm };
        }
        function from12Hour(h12, ampm) {
          var h = h12 % 12;
          if (ampm === 'PM') h += 12;
          return h;
        }

        var local = utcToLocal(utcHour, utcMinute);
        var twelve = to12Hour(local.h);
        document.getElementById('dispatcher_hour_local').value = String(twelve.h);
        document.getElementById('dispatcher_minute_local').value = String(local.m);
        document.getElementById('dispatcher_ampm').value = twelve.ampm;

        document.getElementById('settings-form').addEventListener('submit', function() {
          var hLocal = parseInt(document.getElementById('dispatcher_hour_local').value, 10);
          var mLocal = parseInt(document.getElementById('dispatcher_minute_local').value, 10);
          var ampm = document.getElementById('dispatcher_ampm').value;
          var h24 = from12Hour(hLocal, ampm);
          var utc = localToUtc(h24, mLocal);
          document.getElementById('dispatcher_hour').value = String(utc.h);
          document.getElementById('dispatcher_minute').value = String(utc.m);
        });
      })();
    </script>
  `, 'settings'));
});

admin.post('/settings', async (c) => {
  const form = await c.req.formData();
  const numericKeys = [
    'cadence_max_requests',
    'cadence_min_days_between',
    'request_delay_days',
    'cadence_dispatcher_batch',
  ];
  for (const k of numericKeys) {
    const raw = String(form.get(k) ?? '');
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) continue;
    setSetting(k, String(Math.floor(n)));
  }

  // Dispatcher schedule fields are sent as UTC (the client-side JS handles the
  // timezone conversion). Clamp to valid ranges before saving.
  let scheduleChanged = false;
  const hourRaw = Number(form.get('dispatcher_hour') ?? '');
  const minuteRaw = Number(form.get('dispatcher_minute') ?? '');
  if (Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23) {
    setSetting('dispatcher_hour', String(Math.floor(hourRaw)));
    scheduleChanged = true;
  }
  if (Number.isFinite(minuteRaw) && minuteRaw >= 0 && minuteRaw <= 59) {
    setSetting('dispatcher_minute', String(Math.floor(minuteRaw)));
    scheduleChanged = true;
  }

  const brandJson = String(form.get('shop_brand_json') ?? '').trim();
  if (brandJson) {
    try {
      JSON.parse(brandJson);
      setSetting('shop_brand_json', brandJson);
    } catch {
      // Don't save malformed JSON; future improvement: surface this as an error to the user.
    }
  }

  // Checkbox: form.get returns '1' when checked, null when unchecked.
  const immediateChecked = form.get('dispatch_immediately_on_fulfillment') === '1';
  setSetting('dispatch_immediately_on_fulfillment', immediateChecked ? '1' : '0');

  if (scheduleChanged) {
    restartScheduler();
  }

  log('info', 'admin settings updated', { scheduleChanged, immediateOnFulfillment: immediateChecked });
  return c.redirect('/admin/settings?saved=1');
});

// --- Brand info sync from Shopify ---

admin.post('/settings/sync-brand', async (c) => {
  try {
    const brandInfo = await fetchShopifyBrand();
    setSetting('shop_brand_json', JSON.stringify(brandInfo, null, 2));
    log('info', 'admin synced brand info from Shopify', {
      hasPrimary: !!brandInfo.colors?.primary?.background,
      hasSecondary: !!brandInfo.colors?.secondary?.background,
      hasLogo: !!brandInfo.logoUrl,
    });
    return c.redirect('/admin/settings?saved=1');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'brand sync failed', { error: msg });
    return c.html(adminShell('Brand sync failed', `<div class="err">${escapeHtml(msg)}</div><p><a href="/admin/settings">Back to settings</a></p>`), 500);
  }
});

// --- Manual operations ---

admin.post('/sync', async (c) => {
  try {
    const result = await backfillRecentOrders(90);
    log('info', 'admin triggered backfill', { result });
    return c.html(adminShell('Sync', `
      <h2>Backfill complete</h2>
      <pre style="background:#fff;padding:16px;border-radius:6px;">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
      <p><a href="/admin/dashboard">Back to dashboard</a></p>
    `));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(adminShell('Sync failed', `<div class="err">${escapeHtml(msg)}</div><p><a href="/admin/dashboard">Back to dashboard</a></p>`), 500);
  }
});

admin.post('/dispatch', async (c) => {
  try {
    const result = await runDispatcher();
    return c.html(adminShell('Dispatcher', `
      <h2>Dispatcher run complete</h2>
      <pre style="background:#fff;padding:16px;border-radius:6px;">${escapeHtml(JSON.stringify(result, null, 2))}</pre>
      <p><a href="/admin/dashboard">Back to dashboard</a></p>
    `));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(adminShell('Dispatcher failed', `<div class="err">${escapeHtml(msg)}</div><p><a href="/admin/dashboard">Back to dashboard</a></p>`), 500);
  }
});

export default admin;
