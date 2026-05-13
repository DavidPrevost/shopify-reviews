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
  type ReviewRow,
} from '../db/queries.js';
import { backfillRecentOrders } from '../shopify/sync.js';
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
    { href: '/admin/dashboard', label: 'Dashboard', key: 'dashboard' },
    { href: '/admin/reviews',   label: 'Reviews',   key: 'reviews' },
    { href: '/admin/settings',  label: 'Settings',  key: 'settings' },
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
    ? '<p>This customer has globally unsubscribed from review requests.</p>'
    : `<form method="POST" action="/admin/customers/${encodeURIComponent(email)}/global-opt-out">
         <button type="submit" class="danger">Apply global opt-out</button>
       </form>`;

  return c.html(adminShell(`Customer ${email}`, `
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

// --- Settings ---

admin.get('/settings', (c) => {
  const flash = c.req.query('saved') === '1' ? '<div class="ok">Settings saved.</div>' : '';
  const cadenceMax = getSettingNumber('cadence_max_requests', 3);
  const cadenceMin = getSettingNumber('cadence_min_days_between', 7);
  const requestDelay = getSettingNumber('request_delay_days', 7);
  const dispatcherBatch = getSettingNumber('cadence_dispatcher_batch', 100);
  const dispatcherHour = getSettingNumber('dispatcher_hour', 20);
  const dispatcherMinute = getSettingNumber('dispatcher_minute', 17);
  const brandJson = getSetting('shop_brand_json') ?? '{}';

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

        <label for="shop_brand_json">Brand colors (JSON, used in email templates)</label>
        <textarea id="shop_brand_json" name="shop_brand_json" rows="4">${escapeHtml(brandJson)}</textarea>

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

  if (scheduleChanged) {
    restartScheduler();
  }

  log('info', 'admin settings updated', { scheduleChanged });
  return c.redirect('/admin/settings?saved=1');
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
