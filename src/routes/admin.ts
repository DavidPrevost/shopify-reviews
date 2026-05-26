import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  listReviews,
  listReviewsFiltered,
  countReviewsFiltered,
  listReviewProductOptions,
  countReviewsByStatus,
  type ReviewSortKey,
  type ReviewListRow,
  findReviewById,
  updateReviewStatus,
  setMerchantReply,
  getCustomerDetail,
  emailEventStats,
  listEmailEventsByKind,
  setSetting,
  getSetting,
  getSettingNumber,
  setGlobalOptOut,
  clearGlobalOptOut,
  createSampleInvitation,
  listSampleInvitations,
  clearProductCache,
  listEmailTemplates,
  findEmailTemplate,
  upsertEmailTemplate,
  retractReview,
  restoreReview,
  listModerationEvents,
  isModerationReason,
  MODERATION_REASONS,
  MODERATION_REASON_LABELS,
  MODERATION_REASON_CUSTOMER_PHRASES,
  listOpenReportsGroupedByReview,
  countOpenReports,
  listReportsForReview,
  findReviewReportById,
  resolveReports,
  resolveAllOpenReportsForReview,
  banReporter,
  unbanReporter,
  listBannedReporters,
  REPORT_REASON_LABELS,
  type ReviewRow,
  type ModerationEventRow,
  type ModerationReason,
  type ReviewReportRow,
  type ReportReason,
} from '../db/queries.js';
import { sendTemplateEmail } from '../email/send-template.js';
import { getProfanityWordlist, setProfanityWordlist } from '../lib/profanity.js';
import { getNewReviewNotifyConfig, setNewReviewNotifyConfig } from '../email/notify-new-review.js';
import {
  getPauseState,
  pauseReviews,
  extendPause,
  resumeReviews,
  listPanicEvents,
  PAUSE_DEFAULT_HOURS,
  PAUSE_MIN_HOURS,
  PAUSE_MAX_HOURS,
  type PanicEventRow,
} from '../lib/panic.js';
import { sendMail } from '../email/smtp-client.js';
import { signSampleInviteToken, SAMPLE_INVITE_TTL_DAYS } from '../email/tokens.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { getOrFetchProduct } from '../shopify/product-info.js';
import { parseProductId } from '../shopify/parse-product-id.js';
import {
  resolveWidgetConfig,
  getShopifyDefaults,
  getWidgetOverrides,
  isValidHexColor,
  PRESET_PALETTE,
  HARDCODED_DEFAULTS,
} from '../shopify/widget-config.js';
import {
  resolveEmailBranding,
  getEmailBrandingOverrides,
  getEmailBrandingDefaults,
} from '../email/email-config.js';
import { renderString } from '../email/render.js';
import { backfillRecentOrders } from '../shopify/sync.js';
import { fetchShopifyBrand } from '../shopify/brand-info.js';
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
import { getActiveAdminTheme, renderAdminThemeVars, ADMIN_THEMES, DEFAULT_ADMIN_THEME } from '../lib/admin-theme.js';

const admin = new Hono();

const requireAuth = async (c: import('hono').Context): Promise<boolean> => {
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionCookie(cookie);
};

const formatRemaining = (sec: number): string => {
  if (sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return `${d}d ${remH}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

// Global pause banner injected into adminShell. Surfaces at the top of every
// admin page when the panic button is active, with a one-click resume form
// and an at-a-glance countdown. Designed to be hard to ignore.
const renderPauseBannerHtml = (): string => {
  const state = getPauseState();
  if (!state.paused) return '';
  const reason = state.reason ?? '(no reason recorded)';
  const remaining = formatRemaining(state.secondsRemaining);
  return `
    <div class="pause-banner">
      <div class="pause-banner-text">
        <strong>REVIEWS ARE PAUSED</strong> — auto-resumes in ${escapeHtml(remaining)}. Reason: <em>${escapeHtml(reason)}</em>
      </div>
      <form method="POST" action="/admin/panic/resume" class="pause-banner-actions">
        <button type="submit" class="pause-resume-btn">Resume now</button>
      </form>
    </div>
  `;
};

const adminShell = (title: string, body: string, navActive?: string): string => {
  // Open-reports count drives the "Reports" tab badge. Cheap query — single
  // COUNT(*) on an indexed column — so we run it on every admin page.
  const openReportsCount = countOpenReports();
  const reportsBadge = openReportsCount > 0
    ? ` <span class="nav-badge">${openReportsCount}</span>`
    : '';

  const tabs = [
    { href: '/admin/dashboard',           label: 'Dashboard',   key: 'dashboard' },
    { href: '/admin/reviews',             label: 'Reviews',     key: 'reviews' },
    { href: '/admin/reports',             label: `Reports${reportsBadge}`, key: 'reports' },
    { href: '/admin/sample-invitations',  label: 'Invitations', key: 'invitations' },
    { href: '/admin/branding',            label: 'Branding',    key: 'branding' },
    { href: '/admin/settings',            label: 'Settings',    key: 'settings' },
  ];
  const navHtml = tabs
    .map(
      (t) => `<a href="${t.href}" class="${t.key === navActive ? 'active' : ''}">${t.label}</a>`,
    )
    .join('');

  const pauseBanner = renderPauseBannerHtml();
  const themeVars = renderAdminThemeVars(getActiveAdminTheme());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Reviews admin</title>
  <style>
    ${themeVars}
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; margin: 0; background:var(--bg); color:var(--text); }
    header { background:var(--header-bg); color:var(--header-text); padding: 12px 24px; display:flex; align-items:center; justify-content:space-between; }
    header h1 { margin:0; font-size: 18px; font-weight: 600; }
    header nav a { color:var(--header-nav); text-decoration:none; margin-right: 18px; font-size: 14px; }
    header nav a.active, header nav a:hover { color:var(--header-nav-active); }
    header .logout { color:var(--header-nav); text-decoration:none; font-size:13px; }
    main { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
    h2 { margin-top: 0; }
    table { width:100%; border-collapse: collapse; background:var(--surface); border-radius:6px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.05); }
    th, td { padding: 10px 12px; text-align:left; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 14px; }
    th { background:var(--surface-alt); font-weight: 600; font-size: 12px; text-transform: uppercase; color:var(--muted); }
    tr:last-child td { border-bottom: none; }
    .stars { color: #f5a623; letter-spacing: 1px; }
    .pill { display:inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; text-transform: uppercase; font-weight: 600; }
    .pill-published { background: #dfe9d9; color: #2d572c; }
    .pill-pending { background: #fff3cd; color: #856404; }
    .pill-rejected { background: #f8d7da; color: #721c24; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat { background:var(--surface); padding: 16px; border-radius: 6px; box-shadow:0 1px 4px rgba(0,0,0,0.05); }
    .stat .num { font-size: 24px; font-weight: 600; }
    .stat .label { font-size: 12px; color:var(--muted); text-transform: uppercase; }
    a.stat-link { display:block; text-decoration:none; color:inherit; transition: box-shadow .15s ease, transform .15s ease; }
    a.stat-link:hover { box-shadow:0 2px 10px rgba(0,0,0,0.12); transform: translateY(-1px); opacity:1; }
    form.inline { display:inline; }
    button { padding: 6px 12px; font-size: 13px; border: 1px solid var(--border-strong); background:var(--surface); color:var(--text); border-radius:4px; cursor:pointer; }
    button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
    button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); opacity: 1; }
    button.danger { color: #b00; border-color: #faa; }
    button:hover { opacity: 0.85; }
    label { display:block; font-size: 13px; font-weight: 600; margin-top: 12px; }
    input[type=text], input[type=number], input[type=password], textarea, select { width:100%; padding: 8px 10px; border:1px solid var(--border-strong); border-radius: 4px; font-size: 14px; background:var(--surface); color:var(--text); }
    .card { background:var(--surface); padding: 24px; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,0.05); margin-bottom: 24px; }
    .filter-row { margin-bottom: 16px; display:flex; gap: 8px; align-items: center; }
    .filter-row a { padding:6px 12px; border-radius:4px; text-decoration:none; color:var(--text); border:1px solid var(--border); background:var(--surface); font-size:13px; }
    .filter-row a.active { background:var(--accent); color:var(--accent-text); border-color:var(--accent); }
    .err { background:#fee; border:1px solid #fcc; color:#933; padding:12px; border-radius:4px; margin-bottom:16px; }
    .ok  { background:#efe; border:1px solid #cdc; color:#363; padding:12px; border-radius:4px; margin-bottom:16px; }
    .muted { color:var(--muted); font-size: 13px; }
    a { color: var(--accent); }
    .tabs { display:flex; border-bottom: 2px solid var(--border); margin-bottom: 24px; gap: 0; flex-wrap: wrap; }
    .tabs a { padding: 12px 20px; text-decoration: none; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -2px; font-size: 14px; font-weight: 500; cursor: pointer; }
    .tabs a:hover { color: var(--text); }
    .tabs a.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .nav-badge { display:inline-block; background:#b00; color:#fff; font-size:11px; padding:1px 6px; border-radius:8px; margin-left:4px; font-weight:600; }
    .pause-banner { background: #b00; color: #fff; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 14px; }
    .pause-banner-text strong { letter-spacing: 1px; margin-right: 8px; }
    .pause-banner-text em { font-style: italic; opacity: 0.95; }
    .pause-resume-btn { background:#fff; color:#b00; border: none; border-radius: 4px; padding: 6px 12px; font-weight: 600; font-size: 13px; cursor: pointer; }
    .pause-resume-btn:hover { background:#fde; }
    @media (max-width: 600px) { .pause-banner { flex-direction: column; align-items: stretch; text-align: center; } }
  </style>
</head>
<body>
  ${pauseBanner}
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
admin.use('/branding', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/branding/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/reports', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/reports/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/panic/*', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
});
admin.use('/settings/*', async (c, next) => {
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
    { label: 'Published', n: counts.published ?? 0, href: '/admin/reviews?status=published' },
    { label: 'Pending',   n: counts.pending ?? 0,   href: '/admin/reviews?status=pending' },
    { label: 'Rejected',  n: counts.rejected ?? 0,  href: '/admin/reviews?status=rejected' },
    { label: 'Sent (30d)',         n: stats.request_sent ?? 0,     href: '/admin/activity?kind=request_sent' },
    { label: 'Submitted (30d)',    n: stats.review_submitted ?? 0, href: '/admin/activity?kind=review_submitted' },
    { label: 'Unsubscribed (30d)', n: stats.unsubscribed ?? 0,     href: '/admin/activity?kind=unsubscribed' },
    { label: 'Send failed (30d)',  n: stats.send_failed ?? 0,      href: '/admin/activity?kind=send_failed' },
  ];

  const statsHtml = `<div class="stats">${statBlocks
    .map((s) => `<a class="stat stat-link" href="${s.href}"><div class="num">${s.n}</div><div class="label">${s.label}</div></a>`)
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

// Dashboard stat cards for email-event kinds link here to show the people
// behind the number (the review-status cards link to /admin/reviews instead).
const ACTIVITY_KINDS: Record<string, string> = {
  request_sent: 'Review requests sent',
  review_submitted: 'Reviews submitted',
  unsubscribed: 'Unsubscribed',
  send_failed: 'Send failures',
  resubscribed: 'Re-subscribed',
};

admin.get('/activity', async (c) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  const kind = c.req.query('kind') ?? '';
  const title = ACTIVITY_KINDS[kind];
  if (!title) {
    return c.html(adminShell('Activity', `<div class="err">Unknown activity type.</div><p><a href="/admin/dashboard">Back to dashboard</a></p>`, 'dashboard'), 400);
  }
  const since30d = nowSec() - daysToSec(30);
  const events = listEmailEventsByKind(kind, since30d, 500);
  const rowsHtml = events.length === 0
    ? '<p class="muted">Nothing in the last 30 days.</p>'
    : `<table>
        <thead><tr><th>When</th><th>Customer</th><th>Details</th></tr></thead>
        <tbody>${events.map((e) => {
          const name = [e.customer_first_name, e.customer_last_name].filter(Boolean).join(' ').trim();
          const who = e.customer_email
            ? `<a href="/admin/customers/${encodeURIComponent(e.customer_email)}">${escapeHtml(name || e.customer_email)}</a>`
            : '<span class="muted">—</span>';
          let detail = '';
          if (e.metadata_json) {
            try {
              const meta = JSON.parse(e.metadata_json) as Record<string, unknown>;
              if (meta.error) detail = escapeHtml(String(meta.error));
              else if (meta.scope) detail = `scope: ${escapeHtml(String(meta.scope))}`;
            } catch { /* leave detail blank on unparseable metadata */ }
          }
          return `<tr><td class="muted">${formatTs(e.created_at)}</td><td>${who}</td><td class="muted">${detail}</td></tr>`;
        }).join('')}</tbody>
       </table>`;
  return c.html(adminShell(title, `
    <p><a href="/admin/dashboard">← Dashboard</a></p>
    <h2>${escapeHtml(title)} <span class="muted" style="font-size:14px;font-weight:normal;">· last 30 days · ${events.length}</span></h2>
    ${rowsHtml}
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

// --- Panic-button UI helpers ---

const renderPanicCard = (
  state: ReturnType<typeof getPauseState>,
  events: PanicEventRow[],
): string => {
  const historyHtml = events.length === 0
    ? '<p class="muted">No pause history yet.</p>'
    : `<table>
        <thead><tr><th>When</th><th>Event</th><th>Reason</th><th>Until</th><th>Actor</th></tr></thead>
        <tbody>${events.map((ev) => `
          <tr>
            <td class="muted">${formatTs(ev.created_at)}</td>
            <td><span class="pill ${ev.event_type === 'resume' ? 'pill-published' : 'pill-rejected'}">${escapeHtml(ev.event_type)}</span></td>
            <td>${ev.reason ? escapeHtml(ev.reason) : '<span class="muted">—</span>'}</td>
            <td class="muted">${ev.paused_until ? formatTs(ev.paused_until) : '—'}</td>
            <td class="muted">${escapeHtml(ev.actor)}</td>
          </tr>
        `).join('')}</tbody>
       </table>`;

  if (state.paused) {
    const remaining = formatRemaining(state.secondsRemaining);
    const untilText = state.pausedUntil
      ? new Date(state.pausedUntil * 1000).toUTCString()
      : 'unknown';
    const pausedAtText = state.pausedAt
      ? formatTs(state.pausedAt)
      : 'unknown';
    return `
      <div class="card" id="panic-card" style="border:2px solid #b00;">
        <h3 style="margin-top:0;color:#b00;">⏸ Reviews are paused</h3>
        <p><strong>Auto-resumes in ${escapeHtml(remaining)}</strong> (at ${escapeHtml(untilText)}).</p>
        <p>Paused at ${escapeHtml(pausedAtText)} · Reason: <em>${escapeHtml(state.reason ?? '(none)')}</em></p>

        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:16px; align-items:flex-end;">
          <form method="POST" action="/admin/panic/extend" style="display:flex; gap:8px; align-items:flex-end;">
            <div>
              <label for="extend-hours">Extend by</label>
              <input id="extend-hours" name="hours" type="number" min="${PAUSE_MIN_HOURS}" max="${PAUSE_MAX_HOURS}" value="${PAUSE_DEFAULT_HOURS}" style="width:90px;"> hours
            </div>
            <button type="submit">Extend pause</button>
          </form>

          <form method="POST" action="/admin/panic/resume">
            <button type="submit" class="primary">Resume reviews now</button>
          </form>
        </div>

        <h4 style="margin-top:24px;">Pause history</h4>
        ${historyHtml}
      </div>
    `;
  }

  return `
    <div class="card" id="panic-card">
      <h3 style="margin-top:0;">Pause reviews (panic button)</h3>
      <p class="muted">One-click emergency stop. When activated:</p>
      <ul class="muted" style="margin:0 0 16px 24px; font-size:13px; line-height:1.7;">
        <li>The storefront widget shows "Reviews are temporarily unavailable" instead of reviews and aggregate stars.</li>
        <li>All review submission paths (email-link, sample invitation, App Proxy) return 503.</li>
        <li>The daily dispatcher skips its run so new request emails aren't sent.</li>
        <li>The developer is automatically notified by email${config.email.devNotificationEmail ? '' : ' (currently disabled — set <code>DEV_NOTIFICATION_EMAIL</code>)'}.</li>
        <li>Auto-expires after the duration you set (max ${PAUSE_MAX_HOURS}h). Reviews resume automatically with no further action.</li>
      </ul>
      <button type="button" data-open-dialog="#panic-dialog" class="danger">Pause reviews now</button>

      <h4 style="margin-top:24px;">Pause history</h4>
      ${historyHtml}

      <dialog class="retract-modal" id="panic-dialog">
        <form method="POST" action="/admin/panic/pause">
          <div class="modal-body">
            <h3 style="color:#b00;">Pause reviews</h3>
            <p class="muted" style="margin:0;font-size:13px;">This takes effect immediately and shows a non-alarming notice to storefront visitors. It will auto-resume after the duration you set unless you resume earlier.</p>

            <label for="panic-reason">Reason <span style="color:#b00;">(required)</span></label>
            <textarea id="panic-reason" name="reason" rows="3" maxlength="1000" required placeholder="e.g. Discovered coordinated fake reviews; pausing while we investigate."></textarea>

            <label for="panic-hours">Duration (hours)</label>
            <input id="panic-hours" name="hours" type="number" min="${PAUSE_MIN_HOURS}" max="${PAUSE_MAX_HOURS}" value="${PAUSE_DEFAULT_HOURS}" required style="width:120px;">
            <p class="muted" style="margin:4px 0 0;font-size:12px;">Default ${PAUSE_DEFAULT_HOURS}h, max ${PAUSE_MAX_HOURS}h. You can extend or resume early at any time.</p>

            <label for="panic-confirm">Type <code>${CONFIRM_PHRASE}</code> to confirm</label>
            <input id="panic-confirm" name="confirm" type="text" required placeholder="${CONFIRM_PHRASE}" style="font-family:monospace;letter-spacing:1px;">

            <div class="modal-actions">
              <button type="button" data-close-dialog>Cancel</button>
              <button type="submit" class="danger">Pause reviews</button>
            </div>
          </div>
        </form>
      </dialog>

      <script>
        (function () {
          // Reuse the same dialog-open/close handlers used on the review-detail page.
          document.querySelectorAll('[data-open-dialog]').forEach(function (btn) {
            if (btn.dataset.panicWired === '1') return;
            btn.dataset.panicWired = '1';
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              var target = document.querySelector(btn.getAttribute('data-open-dialog'));
              if (target && typeof target.showModal === 'function') target.showModal();
            });
          });
          document.querySelectorAll('[data-close-dialog]').forEach(function (btn) {
            if (btn.dataset.panicWired === '1') return;
            btn.dataset.panicWired = '1';
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              var dlg = btn.closest('dialog');
              if (dlg) dlg.close();
            });
          });
        })();
      </script>
    </div>
  `;
};

// --- Reviews list ---

admin.get('/reviews', (c) => {
  const q = c.req.query();
  const status = q.status ?? '';
  const ratingNum = q.rating ? Number(q.rating) : NaN;
  const rating = Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5 ? ratingNum : undefined;
  const productId = q.product ?? '';
  const reviewer = (q.reviewer ?? '').trim();
  const from = q.from ?? '';
  const to = q.to ?? '';
  const validSorts: ReviewSortKey[] = ['created_at', 'rating', 'product', 'reviewer', 'status'];
  const sort = (validSorts.includes(q.sort as ReviewSortKey) ? q.sort : 'created_at') as ReviewSortKey;
  const dir: 'asc' | 'desc' = q.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(q.page ?? '1'));
  const size = 50;

  // date inputs are YYYY-MM-DD; treat them as UTC day boundaries.
  const dfParsed = from ? Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) : NaN;
  const dtParsed = to ? Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000) : NaN;
  const filter = {
    status: status || undefined,
    rating,
    productId: productId || undefined,
    reviewer: reviewer || undefined,
    dateFrom: Number.isFinite(dfParsed) ? dfParsed : undefined,
    dateTo: Number.isFinite(dtParsed) ? dtParsed : undefined,
  };

  const total = countReviewsFiltered(filter);
  const reviews = listReviewsFiltered({ filter, sort, dir, limit: size, offset: (page - 1) * size });
  const productOptions = listReviewProductOptions();
  const totalPages = Math.max(1, Math.ceil(total / size));

  // Preserve active filters when building sort-header and pagination links.
  const baseParams = () => {
    const sp = new URLSearchParams();
    if (status) sp.set('status', status);
    if (rating) sp.set('rating', String(rating));
    if (productId) sp.set('product', productId);
    if (reviewer) sp.set('reviewer', reviewer);
    if (from) sp.set('from', from);
    if (to) sp.set('to', to);
    return sp;
  };
  const sortHeader = (key: ReviewSortKey, label: string) => {
    const nextDir = sort === key && dir === 'asc' ? 'desc' : 'asc';
    const sp = baseParams();
    sp.set('sort', key);
    sp.set('dir', nextDir);
    const arrow = sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th><a href="/admin/reviews?${sp.toString()}" style="color:inherit;text-decoration:none;">${label}${arrow}</a></th>`;
  };
  const pageLink = (p: number, label: string) => {
    const sp = baseParams();
    sp.set('sort', sort);
    sp.set('dir', dir);
    sp.set('page', String(p));
    return `<a href="/admin/reviews?${sp.toString()}">${label}</a>`;
  };

  const productOptionsHtml = productOptions
    .map((p) => `<option value="${escapeHtml(p.shopify_product_id)}"${p.shopify_product_id === productId ? ' selected' : ''}>${escapeHtml(p.title ?? p.shopify_product_id)}</option>`)
    .join('');
  const ratingOptionsHtml = [1, 2, 3, 4, 5]
    .map((n) => `<option value="${n}"${rating === n ? ' selected' : ''}>${n} star${n === 1 ? '' : 's'}</option>`)
    .join('');
  const statusOptionsHtml = ['published', 'pending', 'rejected']
    .map((s) => `<option value="${s}"${status === s ? ' selected' : ''}>${s}</option>`)
    .join('');

  const tableHtml = reviews.length === 0
    ? '<p class="muted">No reviews match these filters.</p>'
    : `<table>
        <thead><tr>
          ${sortHeader('created_at', 'When')}
          ${sortHeader('rating', 'Rating')}
          ${sortHeader('product', 'Product')}
          ${sortHeader('reviewer', 'Reviewer')}
          ${sortHeader('status', 'Status')}
          <th></th>
        </tr></thead>
        <tbody>${reviews.map(reviewListRowHtml).join('')}</tbody>
       </table>`;

  const pagerHtml = totalPages > 1
    ? `<div class="filter-row" style="justify-content:space-between;margin-top:16px;">
         <span class="muted">${total} review${total === 1 ? '' : 's'} · page ${page} of ${totalPages}</span>
         <span>${page > 1 ? pageLink(page - 1, '← Prev') : ''} ${page < totalPages ? pageLink(page + 1, 'Next →') : ''}</span>
       </div>`
    : `<p class="muted" style="margin-top:12px;">${total} review${total === 1 ? '' : 's'}.</p>`;

  return c.html(adminShell('Reviews', `
    <h2>Reviews</h2>
    <form method="GET" action="/admin/reviews" class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end;">
      <div>
        <label for="f-status">Status</label>
        <select id="f-status" name="status"><option value="">Any</option>${statusOptionsHtml}</select>
      </div>
      <div>
        <label for="f-rating">Rating</label>
        <select id="f-rating" name="rating"><option value="">Any</option>${ratingOptionsHtml}</select>
      </div>
      <div>
        <label for="f-product">Product</label>
        <select id="f-product" name="product"><option value="">Any</option>${productOptionsHtml}</select>
      </div>
      <div>
        <label for="f-reviewer">Reviewer</label>
        <input id="f-reviewer" name="reviewer" type="text" value="${escapeHtml(reviewer)}" placeholder="name or email">
      </div>
      <div>
        <label for="f-from">From</label>
        <input id="f-from" name="from" type="date" value="${escapeHtml(from)}">
      </div>
      <div>
        <label for="f-to">To</label>
        <input id="f-to" name="to" type="date" value="${escapeHtml(to)}">
      </div>
      <input type="hidden" name="sort" value="${sort}">
      <input type="hidden" name="dir" value="${dir}">
      <div style="display:flex;gap:8px;align-items:center;">
        <button type="submit" class="primary">Filter</button>
        <a href="/admin/reviews">Clear</a>
      </div>
    </form>
    ${tableHtml}
    ${pagerHtml}
  `, 'reviews'));
});

// Row for the filtered Reviews list. Shows the cached product title (falling
// back to the bare id when the product isn't cached yet) and the variant title
// resolved from the cached variant map when available.
const reviewListRowHtml = (r: ReviewListRow): string => {
  const productLabel = r.product_title
    ? escapeHtml(r.product_title)
    : `<span class="muted">${escapeHtml(r.shopify_product_id)}</span>`;
  let variantLabel = '';
  if (r.shopify_variant_id && r.variants_json) {
    try {
      const m = JSON.parse(r.variants_json) as Record<string, string>;
      const t = m[r.shopify_variant_id];
      if (t) variantLabel = `<div class="muted" style="font-size:12px;">${escapeHtml(t)}</div>`;
    } catch { /* unparseable variant cache — show product only */ }
  }
  return `
    <tr>
      <td class="muted">${formatTs(r.created_at)}</td>
      <td class="stars">${stars(r.rating)}</td>
      <td>${productLabel}${variantLabel}</td>
      <td>${escapeHtml(r.reviewer_name ?? r.reviewer_email)}</td>
      <td>${statusPill(r.status)}</td>
      <td><a href="/admin/reviews/${r.id}">View</a></td>
    </tr>
  `;
};

// --- Review detail + moderation ---

admin.get('/reviews/:id', (c) => {
  const id = Number(c.req.param('id'));
  const review = findReviewById(id);
  if (!review) return c.html(adminShell('Not found', `<p>Review ${id} not found.</p>`), 404);

  const events = listModerationEvents(id);

  // Flash banner reflecting query-string outcomes from the retract/restore
  // redirects. Lightweight and stateless — survives a reload, fades when the
  // user navigates away.
  const flashBanner = (() => {
    if (c.req.query('retracted') === '1') {
      return `<div class="flash flash-ok">Review retracted.${
        events[0]?.customer_notified ? ' Notification email sent to the reviewer.' : ''
      }</div>`;
    }
    if (c.req.query('restored') === '1') {
      return `<div class="flash flash-ok">Review restored.${
        events[0]?.customer_notified ? ' Notification email sent to the reviewer.' : ''
      }</div>`;
    }
    return '';
  })();

  const moderationCard = renderModerationCard(review);
  const auditCard = renderAuditCard(events);

  return c.html(adminShell(`Review #${review.id}`, `
    ${flashBanner}
    <h2>Review #${review.id}</h2>
    <div class="card">
      <p><span class="stars">${stars(review.rating)}</span> &nbsp; ${statusPill(review.status)}</p>
      <p class="muted">${formatTs(review.created_at)} · Product ${escapeHtml(review.shopify_product_id)} · ${escapeHtml(review.reviewer_email)}</p>
      ${review.title ? `<h3>${escapeHtml(review.title)}</h3>` : ''}
      <p style="white-space: pre-wrap;">${escapeHtml(review.body)}</p>
    </div>

    ${moderationCard}

    ${auditCard}

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

    <style>
      .flash { padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 14px; }
      .flash-ok { background: #dfe9d9; color: #2d572c; }
      .retract-banner { background: #fdecea; border:1px solid #f5c2c0; color:#7a1f1c; padding:12px 14px; border-radius:6px; margin-bottom:16px; }
      .retract-banner .retract-reason { font-weight: 600; margin-bottom: 4px; }
      .retract-banner .retract-note { white-space: pre-wrap; font-size: 13px; color: #5a1815; margin-top: 6px; }
      .audit-list { list-style: none; padding: 0; margin: 0; }
      .audit-list li { border-left: 3px solid #ddd; padding: 8px 12px; margin-bottom: 10px; background: #fafafa; border-radius: 0 4px 4px 0; }
      .audit-list li.event-retract { border-left-color: #b00; }
      .audit-list li.event-restore { border-left-color: #2d572c; }
      .audit-list .audit-ts { font-size: 12px; color: #888; }
      .audit-list .audit-headline { font-weight: 600; margin: 2px 0; }
      .audit-list .audit-note { white-space: pre-wrap; font-size: 13px; color: #444; margin-top: 4px; }
      dialog.retract-modal { border: none; border-radius: 8px; padding: 0; max-width: 520px; width: 90vw; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
      dialog.retract-modal::backdrop { background: rgba(0,0,0,0.4); }
      dialog.retract-modal .modal-body { padding: 24px; }
      dialog.retract-modal h3 { margin-top: 0; }
      dialog.retract-modal label { display: block; font-size: 13px; font-weight: 600; margin-top: 14px; margin-bottom: 6px; }
      dialog.retract-modal select, dialog.retract-modal textarea { width: 100%; padding: 8px; font-size: 14px; border: 1px solid #ccc; border-radius: 4px; font-family: inherit; }
      dialog.retract-modal .checkbox-row { display:flex; align-items:flex-start; gap:8px; margin-top: 16px; font-weight: normal; }
      dialog.retract-modal .checkbox-row input { width: auto; margin-top: 2px; }
      dialog.retract-modal .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
    </style>

    <script>
      (function () {
        document.querySelectorAll('[data-open-dialog]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            var target = document.querySelector(btn.getAttribute('data-open-dialog'));
            if (target && typeof target.showModal === 'function') target.showModal();
          });
        });
        document.querySelectorAll('[data-close-dialog]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            var dlg = btn.closest('dialog');
            if (dlg) dlg.close();
          });
        });
      })();
    </script>
  `, 'reviews'));
});

// --- Review-detail UI helpers ---

const renderModerationCard = (review: ReviewRow): string => {
  if (review.status === 'rejected') {
    const reasonLabel = review.moderation_reason
      ? MODERATION_REASON_LABELS[review.moderation_reason as ModerationReason]
        ?? review.moderation_reason
      : 'No reason recorded';
    const noteBlock = review.moderation_note
      ? `<div class="retract-note">${escapeHtml(review.moderation_note)}</div>`
      : '';
    return `
      <div class="card">
        <h3>Moderation</h3>
        <div class="retract-banner">
          <div class="retract-reason">Retracted — ${escapeHtml(reasonLabel)}</div>
          ${noteBlock || '<div class="muted" style="font-size:13px;">No internal note.</div>'}
        </div>
        <button type="button" data-open-dialog="#restore-dialog-${review.id}" class="primary">Restore review</button>
        <p class="muted" style="margin-top:10px;font-size:13px;">Restoring puts the review back on the storefront. The retract history (with reason and note) stays in the audit log below.</p>

        ${renderRestoreDialog(review)}
      </div>
    `;
  }

  // Published or pending: offer retract + the other workflow flip.
  const otherStatus = review.status === 'pending' ? 'published' : 'pending';
  const otherLabel  = review.status === 'pending' ? 'Publish'   : 'Hold for review';

  return `
    <div class="card">
      <h3>Moderation</h3>
      <button type="button" data-open-dialog="#retract-dialog-${review.id}" class="danger">Retract review</button>
      <form class="inline" method="POST" action="/admin/reviews/${review.id}/status" style="margin-left:8px;">
        <input type="hidden" name="status" value="${otherStatus}">
        <button type="submit">${otherLabel}</button>
      </form>
      <p class="muted" style="margin-top:10px;font-size:13px;">Retracting removes the review from the storefront. A reason is required; the optional note stays internal. You can notify the reviewer by email if you want.</p>

      ${renderRetractDialog(review)}
    </div>
  `;
};

const renderRetractDialog = (review: ReviewRow): string => {
  const reasonOptions = MODERATION_REASONS
    .map((key) => `<option value="${key}">${escapeHtml(MODERATION_REASON_LABELS[key])}</option>`)
    .join('');
  return `
    <dialog class="retract-modal" id="retract-dialog-${review.id}">
      <form method="POST" action="/admin/reviews/${review.id}/retract">
        <div class="modal-body">
          <h3>Retract review #${review.id}</h3>
          <p class="muted" style="margin:0;font-size:13px;">This removes the review from the storefront immediately. The action is logged and reversible — you can restore it later.</p>

          <label for="retract-reason-${review.id}">Reason</label>
          <select id="retract-reason-${review.id}" name="reason" required>
            ${reasonOptions}
          </select>

          <label for="retract-note-${review.id}">Internal note (optional)</label>
          <textarea id="retract-note-${review.id}" name="note" rows="3" maxlength="2000" placeholder="Context for the audit log. Never shown to the customer."></textarea>

          <label class="checkbox-row">
            <input type="checkbox" name="notify_customer" value="1" checked>
            <span>Email the reviewer to let them know (recommended; uncheck for legal-takedown or harassment cases where notification could escalate). The email uses the friendly version of the reason; the internal note is never sent.</span>
          </label>

          <div class="modal-actions">
            <button type="button" data-close-dialog>Cancel</button>
            <button type="submit" class="danger">Retract review</button>
          </div>
        </div>
      </form>
    </dialog>
  `;
};

const renderRestoreDialog = (review: ReviewRow): string => {
  return `
    <dialog class="retract-modal" id="restore-dialog-${review.id}">
      <form method="POST" action="/admin/reviews/${review.id}/restore">
        <div class="modal-body">
          <h3>Restore review #${review.id}</h3>
          <p class="muted" style="margin:0;font-size:13px;">This puts the review back on the storefront. The audit log keeps the original retract event and adds this restore.</p>

          <label for="restore-note-${review.id}">Internal note (optional)</label>
          <textarea id="restore-note-${review.id}" name="note" rows="3" maxlength="2000" placeholder="Why are you restoring? Stays internal."></textarea>

          <label class="checkbox-row">
            <input type="checkbox" name="notify_customer" value="1">
            <span>Email the reviewer to let them know their review is back. Off by default — most restores are routine and the email reads as noise.</span>
          </label>

          <div class="modal-actions">
            <button type="button" data-close-dialog>Cancel</button>
            <button type="submit" class="primary">Restore review</button>
          </div>
        </div>
      </form>
    </dialog>
  `;
};

const renderAuditCard = (events: ModerationEventRow[]): string => {
  if (events.length === 0) {
    return `
      <div class="card">
        <h3>Moderation history</h3>
        <p class="muted">No moderation actions yet.</p>
      </div>
    `;
  }
  const items = events.map((ev) => {
    const reasonText = ev.reason
      ? (MODERATION_REASON_LABELS[ev.reason as ModerationReason] ?? ev.reason)
      : null;
    const headline = ev.event_type === 'retract'
      ? `Retracted (${escapeHtml(ev.from_status)} → rejected)`
      : `Restored (${escapeHtml(ev.from_status)} → published)`;
    const reasonLine = reasonText
      ? `<div>Reason: ${escapeHtml(reasonText)}</div>`
      : '';
    const noteLine = ev.note
      ? `<div class="audit-note">${escapeHtml(ev.note)}</div>`
      : '';
    const notifyLine = ev.customer_notified
      ? '<div style="font-size:12px;color:#2d572c;margin-top:4px;">Customer notified by email</div>'
      : '<div style="font-size:12px;color:#888;margin-top:4px;">Customer not notified</div>';
    return `
      <li class="event-${escapeHtml(ev.event_type)}">
        <div class="audit-ts">${formatTs(ev.created_at)} · ${escapeHtml(ev.actor)}</div>
        <div class="audit-headline">${headline}</div>
        ${reasonLine}
        ${noteLine}
        ${notifyLine}
      </li>
    `;
  }).join('');
  return `
    <div class="card">
      <h3>Moderation history</h3>
      <ul class="audit-list">${items}</ul>
    </div>
  `;
};

// Light-touch status change: published ↔ pending only. Going to 'rejected'
// requires a reason and goes through /retract. Restoring from 'rejected'
// goes through /restore. This route doesn't touch the audit log because
// publish↔pending isn't a moderation decision (it's a workflow nudge).
admin.post('/reviews/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const next = String(form.get('status') ?? '');
  if (!['published', 'pending'].includes(next)) {
    return c.text('invalid status (use /retract or /restore for rejected transitions)', 400);
  }
  const existing = findReviewById(id);
  if (!existing) return c.text('review not found', 404);
  if (existing.status === 'rejected') {
    return c.text('use /restore to bring a rejected review back', 400);
  }
  updateReviewStatus(id, next as 'published' | 'pending');
  log('info', 'admin review status changed', { id, status: next });
  return c.redirect(`/admin/reviews/${id}`);
});

// Fire-and-log helper: send the retract/restore notification email. Failures
// are logged but do NOT roll back the moderation action — the moderation is
// the source of truth; the notification is a courtesy. If SMTP is down we
// still want the review off the storefront.
const sendModerationEmail = async (input: {
  templateKey: 'review_retracted' | 'review_restored';
  to: string;
  context: Record<string, string | number>;
  reviewId: number;
}): Promise<void> => {
  try {
    const result = await sendTemplateEmail({
      templateKey: input.templateKey,
      to: input.to,
      context: input.context,
    });
    log('info', 'moderation email dispatched', {
      reviewId: input.reviewId,
      templateKey: input.templateKey,
      to: input.to,
      sent: result.sent,
      reason: result.reason,
    });
  } catch (err) {
    log('error', 'moderation email send failed', {
      reviewId: input.reviewId,
      templateKey: input.templateKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

admin.post('/reviews/:id/retract', async (c) => {
  const id = Number(c.req.param('id'));
  const review = findReviewById(id);
  if (!review) return c.text('review not found', 404);
  if (review.status === 'rejected') {
    return c.redirect(`/admin/reviews/${id}?already=rejected`);
  }

  const form = await c.req.formData();
  const reasonRaw = String(form.get('reason') ?? '');
  if (!isModerationReason(reasonRaw)) {
    return c.text('invalid or missing reason', 400);
  }
  const noteRaw = String(form.get('note') ?? '').trim();
  const note = noteRaw === '' ? null : noteRaw.slice(0, 2000);
  const notifyCustomer = form.get('notify_customer') === '1';

  retractReview({
    reviewId: id,
    fromStatus: review.status,
    reason: reasonRaw,
    note,
    actor: 'admin',
    customerNotified: notifyCustomer,
  });

  log('info', 'admin retracted review', {
    id,
    fromStatus: review.status,
    reason: reasonRaw,
    hasNote: note !== null,
    notifyCustomer,
  });

  if (notifyCustomer && review.reviewer_email) {
    const product = await getOrFetchProduct(review.shopify_product_id);
    const productTitle = product?.title ?? 'your purchase';
    const firstName = review.reviewer_name?.trim().split(/\s+/)[0] || 'there';
    await sendModerationEmail({
      templateKey: 'review_retracted',
      to: review.reviewer_email,
      reviewId: id,
      context: {
        firstName: escapeHtml(firstName),
        brandName: escapeHtml(config.email.brandName),
        productName: escapeHtml(productTitle),
        reasonPhrase: escapeHtml(MODERATION_REASON_CUSTOMER_PHRASES[reasonRaw]),
      },
    });
  }

  return c.redirect(`/admin/reviews/${id}?retracted=1`);
});

admin.post('/reviews/:id/restore', async (c) => {
  const id = Number(c.req.param('id'));
  const review = findReviewById(id);
  if (!review) return c.text('review not found', 404);
  if (review.status !== 'rejected') {
    return c.redirect(`/admin/reviews/${id}?already=not-rejected`);
  }

  const form = await c.req.formData();
  const noteRaw = String(form.get('note') ?? '').trim();
  const note = noteRaw === '' ? null : noteRaw.slice(0, 2000);
  // Restore notifications are off by default — most restores are routine
  // (admin changed their mind, mistaken retract, false-positive on profanity
  // filter) and a "your review is back" email reads as noise. Merchant can
  // opt in per-restore.
  const notifyCustomer = form.get('notify_customer') === '1';

  restoreReview({
    reviewId: id,
    fromStatus: review.status,
    note,
    actor: 'admin',
    customerNotified: notifyCustomer,
  });

  log('info', 'admin restored review', { id, hasNote: note !== null, notifyCustomer });

  if (notifyCustomer && review.reviewer_email) {
    const product = await getOrFetchProduct(review.shopify_product_id);
    const productTitle = product?.title ?? 'your purchase';
    const firstName = review.reviewer_name?.trim().split(/\s+/)[0] || 'there';
    await sendModerationEmail({
      templateKey: 'review_restored',
      to: review.reviewer_email,
      reviewId: id,
      context: {
        firstName: escapeHtml(firstName),
        brandName: escapeHtml(config.email.brandName),
        productName: escapeHtml(productTitle),
      },
    });
  }

  return c.redirect(`/admin/reviews/${id}?restored=1`);
});

admin.post('/reviews/:id/reply', async (c) => {
  const id = Number(c.req.param('id'));
  const form = await c.req.formData();
  const replyRaw = String(form.get('reply') ?? '').trim();
  setMerchantReply(id, replyRaw === '' ? null : replyRaw);
  log('info', 'admin merchant reply saved', { id, hasReply: replyRaw !== '' });
  return c.redirect(`/admin/reviews/${id}`);
});

// --- Reports queue (storefront-flagged reviews) ---

const reportRowHtml = (r: ReviewReportRow): string => {
  const reasonLabel = REPORT_REASON_LABELS[r.reason as ReportReason] ?? r.reason;
  const msg = r.message
    ? `<div style="margin-top:6px;font-size:13px;white-space:pre-wrap;background:#fafafa;padding:8px;border-radius:4px;">${escapeHtml(r.message)}</div>`
    : '';
  const email = r.reporter_email ? escapeHtml(r.reporter_email) : '<span class="muted">anonymous</span>';
  const banForm = r.reporter_email
    ? `<form method="POST" action="/admin/reports/${r.id}/ban-reporter" class="inline" onsubmit="return confirm('Ban this email from filing future reports?');">
         <button type="submit" class="danger" style="font-size:12px;padding:3px 8px;">Ban reporter</button>
       </form>`
    : '';
  return `
    <div style="border-top:1px solid #eee;padding:10px 0;">
      <div style="font-size:13px;">
        <strong>${escapeHtml(reasonLabel)}</strong> ·
        <span class="muted">${formatTs(r.created_at)}</span> ·
        Reporter: ${email}
        ${banForm}
      </div>
      ${msg}
      <form method="POST" action="/admin/reports/${r.id}/dismiss" class="inline" style="margin-top:8px;">
        <button type="submit" style="font-size:12px;padding:3px 10px;">Dismiss this report</button>
      </form>
    </div>
  `;
};

admin.get('/reports', (c) => {
  const dismissedFlash = c.req.query('dismissed') === '1' ? '<div class="ok">Report dismissed.</div>' : '';
  const retractedFlash = c.req.query('retracted') === '1' ? '<div class="ok">Review retracted and reports cleared.</div>' : '';
  const bannedFlash = c.req.query('banned') ? `<div class="ok">Banned <code>${escapeHtml(c.req.query('banned') ?? '')}</code> from filing future reports.</div>` : '';
  const unbannedFlash = c.req.query('unbanned') ? `<div class="ok">Unbanned <code>${escapeHtml(c.req.query('unbanned') ?? '')}</code>.</div>` : '';
  const flash = dismissedFlash + retractedFlash + bannedFlash + unbannedFlash;

  const groups = listOpenReportsGroupedByReview();
  const banned = listBannedReporters();

  const groupsHtml = groups.length === 0
    ? '<div class="card"><p class="muted">No open reports. The storefront\'s "Report this review" links file new entries here.</p></div>'
    : groups.map((g) => {
        const reasonOptions = MODERATION_REASONS
          .map((key) => `<option value="${key}">${escapeHtml(MODERATION_REASON_LABELS[key])}</option>`)
          .join('');
        const reportsHtml = g.reports.map(reportRowHtml).join('');
        const reportCount = g.reports.length;
        return `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
              <div style="flex:1;">
                <p style="margin:0 0 6px;">
                  <span class="stars">${stars(g.review.rating)}</span>
                  ${statusPill(g.review.status)}
                  · <a href="/admin/reviews/${g.review.id}">Open review #${g.review.id}</a>
                  · <span class="muted">${reportCount} open report${reportCount === 1 ? '' : 's'}</span>
                </p>
                <p class="muted" style="margin:0 0 6px;font-size:13px;">Product ${escapeHtml(g.review.shopify_product_id)} · ${escapeHtml(g.review.reviewer_email)} · ${formatTs(g.review.created_at)}</p>
                ${g.review.title ? `<p style="margin:0 0 6px;font-weight:600;">${escapeHtml(g.review.title)}</p>` : ''}
                <p style="white-space:pre-wrap;font-size:14px;margin:0;background:#fafafa;padding:10px;border-radius:4px;">${escapeHtml(g.review.body)}</p>
              </div>

              <div style="min-width:260px;">
                <form method="POST" action="/admin/reports/by-review/${g.review.id}/retract">
                  <p style="font-size:13px;margin:0 0 6px;font-weight:600;">Retract this review</p>
                  <select name="reason" required style="margin-bottom:6px;">${reasonOptions}</select>
                  <textarea name="note" rows="2" maxlength="2000" placeholder="Internal note (optional)" style="margin-bottom:6px;font-size:13px;"></textarea>
                  <label style="display:flex;align-items:center;gap:6px;font-weight:normal;font-size:12px;margin:6px 0;">
                    <input type="checkbox" name="notify_customer" value="1" checked style="width:auto;">
                    <span>Email reviewer</span>
                  </label>
                  <button type="submit" class="danger" style="width:100%;font-size:13px;">Retract review</button>
                </form>
                <form method="POST" action="/admin/reports/by-review/${g.review.id}/dismiss-all" style="margin-top:8px;">
                  <button type="submit" style="width:100%;font-size:13px;">Dismiss all reports for this review</button>
                </form>
              </div>
            </div>

            <h4 style="margin:16px 0 4px;font-size:14px;">Individual reports</h4>
            ${reportsHtml}
          </div>
        `;
      }).join('');

  const bannedHtml = banned.length === 0
    ? '<p class="muted" style="font-size:13px;">No banned reporters.</p>'
    : `<table>
        <thead><tr><th>Email</th><th>Banned</th><th>By</th><th></th></tr></thead>
        <tbody>${banned.map((b) => `
          <tr>
            <td><code>${escapeHtml(b.email)}</code></td>
            <td class="muted">${formatTs(b.banned_at)}</td>
            <td class="muted">${escapeHtml(b.banned_by)}</td>
            <td><form method="POST" action="/admin/reports/unban-reporter" class="inline">
              <input type="hidden" name="email" value="${escapeHtml(b.email)}">
              <button type="submit" style="font-size:12px;padding:3px 8px;">Unban</button>
            </form></td>
          </tr>
        `).join('')}</tbody>
       </table>`;

  return c.html(adminShell('Reports', `
    ${flash}
    <h2>Reports</h2>
    <p class="muted">Storefront visitors flag reviews via the "Report" link on each review card. Dismiss reports that are noise; retract reviews that shouldn't be on the store; ban repeat-offender reporter emails.</p>

    ${groupsHtml}

    <h3 style="margin-top:32px;">Banned reporters</h3>
    <p class="muted">Banned email addresses can still submit reports, but they're silently dropped — no DB row, no signal back to the reporter.</p>
    ${bannedHtml}
  `, 'reports'));
});

admin.post('/reports/:id/dismiss', (c) => {
  const id = Number(c.req.param('id'));
  const report = findReviewReportById(id);
  if (!report) return c.text('report not found', 404);
  resolveReports({ reportIds: [id], newStatus: 'dismissed', resolvedBy: 'admin' });
  log('info', 'admin dismissed report', { id, reviewId: report.review_id });
  return c.redirect('/admin/reports?dismissed=1');
});

admin.post('/reports/by-review/:reviewId/dismiss-all', (c) => {
  const reviewId = Number(c.req.param('reviewId'));
  const changes = resolveAllOpenReportsForReview({ reviewId, newStatus: 'dismissed', resolvedBy: 'admin' });
  log('info', 'admin dismissed all reports for review', { reviewId, changes });
  return c.redirect('/admin/reports?dismissed=1');
});

// Retract via the Reports page. Goes through the same retract path as the
// review-detail page so the moderation_events audit log is consistent, and
// closes all open reports for the review as 'retracted'.
admin.post('/reports/by-review/:reviewId/retract', async (c) => {
  const reviewId = Number(c.req.param('reviewId'));
  const review = findReviewById(reviewId);
  if (!review) return c.text('review not found', 404);

  const form = await c.req.formData();
  const reasonRaw = String(form.get('reason') ?? '');
  if (!isModerationReason(reasonRaw)) {
    return c.text('invalid or missing reason', 400);
  }
  const noteRaw = String(form.get('note') ?? '').trim();
  const note = noteRaw === '' ? null : noteRaw.slice(0, 2000);
  const notifyCustomer = form.get('notify_customer') === '1';

  if (review.status !== 'rejected') {
    retractReview({
      reviewId,
      fromStatus: review.status,
      reason: reasonRaw,
      note,
      actor: 'admin',
      customerNotified: notifyCustomer,
    });
    log('info', 'admin retracted review via reports page', {
      reviewId,
      reason: reasonRaw,
      notifyCustomer,
    });
    if (notifyCustomer && review.reviewer_email) {
      const product = await getOrFetchProduct(review.shopify_product_id);
      const productTitle = product?.title ?? 'your purchase';
      const firstName = review.reviewer_name?.trim().split(/\s+/)[0] || 'there';
      await sendModerationEmail({
        templateKey: 'review_retracted',
        to: review.reviewer_email,
        reviewId,
        context: {
          firstName: escapeHtml(firstName),
          brandName: escapeHtml(config.email.brandName),
          productName: escapeHtml(productTitle),
          reasonPhrase: escapeHtml(MODERATION_REASON_CUSTOMER_PHRASES[reasonRaw]),
        },
      });
    }
  }

  resolveAllOpenReportsForReview({ reviewId, newStatus: 'retracted', resolvedBy: 'admin' });
  return c.redirect('/admin/reports?retracted=1');
});

admin.post('/reports/:id/ban-reporter', (c) => {
  const id = Number(c.req.param('id'));
  const report = findReviewReportById(id);
  if (!report || !report.reporter_email) return c.text('no email to ban', 400);
  banReporter({ email: report.reporter_email, bannedBy: 'admin' });
  // Also dismiss this specific report — banning means we're not acting on it.
  resolveReports({ reportIds: [id], newStatus: 'dismissed', resolvedBy: 'admin' });
  log('warn', 'admin banned reporter', { email: report.reporter_email });
  return c.redirect(`/admin/reports?banned=${encodeURIComponent(report.reporter_email)}`);
});

admin.post('/reports/unban-reporter', async (c) => {
  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim();
  if (!email) return c.text('email required', 400);
  unbanReporter(email);
  log('info', 'admin unbanned reporter', { email });
  return c.redirect(`/admin/reports?unbanned=${encodeURIComponent(email)}`);
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

// --- Branding ---

// Shared widget CSS snippet rendered into the admin Branding page so the
// mockup looks pixel-identical to the live storefront widget. Keep this in
// sync with the inlined STYLES string in src/widget/widget.ts whenever
// widget visuals change; the alternative (loading the widget bundle into
// the admin and running it for real) requires either real product data or
// a mock-data branch in the bundle.
const widgetMockupCss = `
  .rv-mockup-frame {
    background: #f6f6f6;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 32px;
    margin-bottom: 24px;
    min-height: 280px;
  }
  .rv-mockup-frame .rv-widget {
    font-family: inherit;
    color: #222;
    font-size: 16px;
    line-height: 1.5;
    margin: 0 auto;
    max-width: 720px;
    background: #fff;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
  }
  .rv-mockup-frame .rv-stars {
    display: inline-flex;
    gap: 1px;
    color: var(--reviews-star-color, #f5a623);
    letter-spacing: 1px;
    font-size: 1em;
  }
  .rv-mockup-frame .rv-star { opacity: 0.25; }
  .rv-mockup-frame .rv-star-on { opacity: 1; }
  .rv-mockup-frame .rv-aggregate {
    display: inline-flex; align-items: center; gap: 0.5rem;
  }
  .rv-mockup-frame .rv-aggregate-text {
    font-size: 0.9em; opacity: 0.85;
  }
  .rv-mockup-frame .rv-header {
    display: flex; flex-wrap: wrap; align-items: center;
    justify-content: space-between; gap: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid rgba(127,127,127,0.25);
  }
  .rv-mockup-frame .rv-cta-button {
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
  .rv-mockup-frame .rv-list {
    list-style: none !important; padding: 0; margin: 1rem 0 0;
  }
  .rv-mockup-frame .rv-review {
    padding: 1rem 0;
    border-bottom: 1px solid rgba(127,127,127,0.18);
  }
  .rv-mockup-frame .rv-review:last-child { border-bottom: none; }
  .rv-mockup-frame .rv-review-head {
    display: flex; flex-wrap: wrap; align-items: center;
    gap: 0.75rem; margin-bottom: 0.25rem;
  }
  .rv-mockup-frame .rv-review-title { font-size: 1em; font-weight: 600; }
  .rv-mockup-frame .rv-review-meta {
    display: flex; flex-wrap: wrap; gap: 0.75rem;
    font-size: 0.85em; opacity: 0.85; margin-bottom: 0.5rem;
  }
  .rv-mockup-frame .rv-review-author { font-weight: 500; }
  .rv-mockup-frame .rv-review-verified {
    font-style: italic; font-weight: normal;
    opacity: 0.7; font-size: 0.95em;
  }
  .rv-mockup-frame .rv-review-body {
    font-size: 0.95em; line-height: 1.55;
  }

  /* Editor-specific styling */
  .rv-mockup-target {
    cursor: pointer;
    transition: outline 0.15s;
    outline: 1px dashed transparent;
    outline-offset: 4px;
    border-radius: 2px;
  }
  .rv-mockup-target:hover {
    outline-color: #0a8a3a;
  }
  .rv-mockup-target.rv-mockup-active {
    outline: 2px solid #0a8a3a;
    outline-offset: 4px;
  }
  .color-field-row { display: grid; grid-template-columns: 1fr; gap: 8px; margin-bottom: 16px; }
  .color-field-inputs { display: flex; align-items: center; gap: 8px; }
  .color-field-inputs input[type="color"] { width: 48px; height: 36px; padding: 0; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; }
  .color-field-inputs input[type="text"] { width: 110px; font-family: monospace; }
  .color-field-default { font-size: 12px; color: #888; }
  .color-field-reset { font-size: 11px; padding: 4px 8px; }
  .color-presets { display: flex; flex-wrap: wrap; gap: 4px; }
  .color-presets button {
    width: 28px; height: 28px;
    border: 1px solid rgba(0,0,0,0.15);
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    transition: transform 0.1s;
  }
  .color-presets button:hover { transform: scale(1.1); }
  .range-field-inputs { display: flex; align-items: center; gap: 12px; }
  .range-field-inputs input[type="range"] { flex: 1; max-width: 240px; }
  .range-field-inputs .range-value { font-family: monospace; min-width: 40px; }
`;

const renderBrandingMockup = (): string => `
  <div class="rv-mockup-frame">
    <div class="rv-widget rv-widget-full">
      <div class="rv-header">
        <span class="rv-aggregate">
          <span class="rv-stars rv-mockup-target" data-rv-edit="starColor" title="Click to edit star color">
            <span class="rv-star rv-star-on">★</span>
            <span class="rv-star rv-star-on">★</span>
            <span class="rv-star rv-star-on">★</span>
            <span class="rv-star rv-star-on">★</span>
            <span class="rv-star rv-star-on">★</span>
          </span>
          <span class="rv-aggregate-text">4.8 (12)</span>
        </span>
        <button type="button" class="rv-cta-button rv-mockup-target" data-rv-edit="ctaBackground" title="Click to edit button color">Write a review</button>
      </div>
      <ul class="rv-list">
        <li class="rv-review">
          <div class="rv-review-head">
            <span class="rv-stars rv-mockup-target" data-rv-edit="starColor" title="Click to edit star color">
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
            </span>
            <strong class="rv-review-title">Excellent product</strong>
          </div>
          <div class="rv-review-meta">
            <span class="rv-review-author">Maria</span>
            <span>May 2026</span>
            <span class="rv-review-verified">Verified Buyer</span>
          </div>
          <div class="rv-review-body">Exactly what I was hoping for. The quality is great and it arrived faster than expected. Will definitely buy from this brand again.</div>
        </li>
        <li class="rv-review">
          <div class="rv-review-head">
            <span class="rv-stars rv-mockup-target" data-rv-edit="starColor">
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star rv-star-on">★</span>
              <span class="rv-star">★</span>
            </span>
            <strong class="rv-review-title">Good, with one small note</strong>
          </div>
          <div class="rv-review-meta">
            <span class="rv-review-author">Alex</span>
            <span>Apr 2026</span>
            <span class="rv-review-verified">Verified Reviewer</span>
          </div>
          <div class="rv-review-body">Honestly really pleased. The packaging could be a bit nicer but the product itself is solid.</div>
        </li>
      </ul>
    </div>
  </div>
`;

admin.get('/branding', (c) => {
  const overrides = getWidgetOverrides();
  const shopify = getShopifyDefaults();
  const resolved = resolveWidgetConfig();
  const flash = c.req.query('saved') === '1' ? '<div class="ok">Branding saved.</div>' : '';

  const presetSwatches = (fieldId: string) => PRESET_PALETTE
    .map((p) => `<button type="button" data-preset-for="${fieldId}" data-color="${p.hex}" style="background:${p.hex};" title="${escapeHtml(p.name)} (${p.hex})" aria-label="${escapeHtml(p.name)}"></button>`)
    .join('');

  const colorField = (opts: {
    id: string;
    label: string;
    description: string;
    overrideValue: string | null;
    shopifyValue: string | null;
    hardcodedFallback: string;
  }) => {
    const effective = opts.overrideValue ?? opts.shopifyValue ?? opts.hardcodedFallback;
    const hasOverride = opts.overrideValue !== null;
    const defaultSource = opts.shopifyValue ? `Shopify default: <code>${escapeHtml(opts.shopifyValue)}</code>` : `Default: <code>${escapeHtml(opts.hardcodedFallback)}</code>`;
    return `
      <div class="color-field-row" data-field-row="${opts.id}">
        <label for="cf-${opts.id}-color">${escapeHtml(opts.label)}</label>
        <p class="muted" style="margin:0;">${opts.description}</p>
        <div class="color-field-inputs">
          <input type="color" id="cf-${opts.id}-color" data-color-input="${opts.id}" value="${escapeHtml(effective)}">
          <input type="text"  id="cf-${opts.id}-text"  data-text-input="${opts.id}" value="${escapeHtml(effective)}" maxlength="7" pattern="^#[0-9a-fA-F]{6}$" placeholder="#RRGGBB">
          <button type="button" class="color-field-reset" data-reset-for="${opts.id}" ${hasOverride ? '' : 'disabled'}>Reset to default</button>
        </div>
        <div class="color-field-default">${defaultSource}${hasOverride ? ' · <strong style="color:#0a8a3a;">overridden</strong>' : ''}</div>
        <div class="color-presets">${presetSwatches(opts.id)}</div>
        <input type="hidden" name="${opts.id}" data-hidden-for="${opts.id}" value="${hasOverride ? escapeHtml(opts.overrideValue!) : ''}">
      </div>
    `;
  };

  // Shopify brand sync block — moved here from Settings since brand info
  // feeds the widget styling defaults. Mirrors the previous Settings block.
  const brandJsonRaw = getSetting('shop_brand_json') ?? '{}';
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
    brandPreviewHtml = '<p class="muted">(unparseable shop_brand_json — sync to overwrite)</p>';
  }

  const widgetTab = `
    <div class="card">
      <h3 style="margin-top:0;">Shopify brand defaults</h3>
      <p class="muted">These values are pulled from your Shopify store (Settings → Brand) and used as the defaults for every field below. Edit your brand colors on Shopify's side and click the sync button to pull updates.</p>
      ${brandPreviewHtml}
      <form method="POST" action="/admin/settings/sync-brand" style="margin:0;">
        <button type="submit">Sync brand info from Shopify</button>
      </form>
    </div>

    <p class="muted">Click any element on the mockup below to jump to its editor. Edit any field below the mockup to see changes reflected instantly. Fields default to Shopify brand colors when you haven't set a custom value; click "Reset to default" on any field to clear the override.</p>

    ${renderBrandingMockup()}

    <form method="POST" action="/admin/branding" id="branding-form">
      <input type="hidden" name="tab" value="widget">
      <h3 style="margin-top:0;">Widget colors and shape</h3>

      ${colorField({
        id: 'starColor',
        label: 'Star color',
        description: 'Used for review-rating stars throughout the storefront.',
        overrideValue: overrides.starColor,
        shopifyValue: shopify.starColor,
        hardcodedFallback: HARDCODED_DEFAULTS.starColor,
      })}

      ${colorField({
        id: 'ctaBackground',
        label: 'CTA button background',
        description: 'Background of the "Write a review" and "Submit" buttons.',
        overrideValue: overrides.ctaBackground,
        shopifyValue: shopify.ctaBackground,
        hardcodedFallback: HARDCODED_DEFAULTS.ctaBackground,
      })}

      ${colorField({
        id: 'ctaForeground',
        label: 'CTA button text',
        description: 'Text color on the "Write a review" and "Submit" buttons. Pick a color with strong contrast against the button background.',
        overrideValue: overrides.ctaForeground,
        shopifyValue: shopify.ctaForeground,
        hardcodedFallback: HARDCODED_DEFAULTS.ctaForeground,
      })}

      <div class="color-field-row">
        <label for="cf-borderRadius-range">Border radius</label>
        <p class="muted" style="margin:0;">How rounded the CTA buttons appear. 0 is fully square; 20 is fully pill-shaped.</p>
        <div class="range-field-inputs">
          <input type="range" id="cf-borderRadius-range" min="0" max="20" step="1" value="${overrides.borderRadius ?? HARDCODED_DEFAULTS.borderRadius}" data-range-input="borderRadius">
          <span class="range-value" data-range-value="borderRadius">${overrides.borderRadius ?? HARDCODED_DEFAULTS.borderRadius}px</span>
          <button type="button" class="color-field-reset" data-reset-for="borderRadius" ${overrides.borderRadius !== null ? '' : 'disabled'}>Reset to default</button>
        </div>
        <input type="hidden" name="borderRadius" data-hidden-for="borderRadius" value="${overrides.borderRadius !== null ? overrides.borderRadius : ''}">
      </div>

      <div style="margin-top:24px;">
        <button type="submit" class="primary">Save branding</button>
      </div>
    </form>
  `;

  // --- Email tab ---
  const emailOverrides = getEmailBrandingOverrides();
  const emailDefaults = getEmailBrandingDefaults(config.email.brandName);
  const resolvedEmail = resolveEmailBranding();
  const templates = listEmailTemplates();

  const textField = (opts: {
    id: string;
    label: string;
    description: string;
    overrideValue: string | null;
    defaultValue: string | null;
    placeholder?: string;
    name: string;
  }) => {
    const hasOverride = opts.overrideValue !== null;
    const display = opts.overrideValue ?? '';
    const defaultLine = opts.defaultValue
      ? `<div class="color-field-default">Default: <code>${escapeHtml(opts.defaultValue)}</code></div>`
      : '<div class="color-field-default">No default available.</div>';
    return `
      <div class="color-field-row">
        <label for="${opts.id}">${escapeHtml(opts.label)}</label>
        <p class="muted" style="margin:0;">${opts.description}</p>
        <input type="text" id="${opts.id}" name="${opts.name}" value="${escapeHtml(display)}" placeholder="${escapeHtml(opts.placeholder ?? '')}">
        ${defaultLine}${hasOverride ? ' · <strong style="color:#0a8a3a;">overridden</strong>' : ''}
      </div>
    `;
  };

  const templateCards = templates.length === 0
    ? '<p class="muted">No email templates found. (They should have been seeded on first boot — try restarting the container if this is unexpected.)</p>'
    : templates.map((t) => `
      <div class="card" id="template-${escapeHtml(t.template_key)}">
        <h4 style="margin:0 0 8px;">${escapeHtml(t.display_name)} <code style="font-size:0.75em;color:#888;font-weight:normal;">${escapeHtml(t.template_key)}</code></h4>
        <form method="POST" action="/admin/branding/email-template/${encodeURIComponent(t.template_key)}">
          <label for="t-${t.id}-subject">Subject</label>
          <input type="text" id="t-${t.id}-subject" name="subject" value="${escapeHtml(t.subject)}" maxlength="200">
          <p class="muted" style="font-size:12px;margin:4px 0 0;">Variables: <code>{{ brandName }}</code>, <code>{{ firstName }}</code>, <code>{{ productName }}</code>, <code>{{ productCount }}</code></p>

          <label for="t-${t.id}-body">Body (HTML)</label>
          <textarea id="t-${t.id}-body" name="body_html" rows="14" style="font-family:monospace;font-size:13px;">${escapeHtml(t.body_html)}</textarea>
          <p class="muted" style="font-size:12px;margin:4px 0 0;">Variables: same as subject, plus <code>{{ productsHtml }}</code> (renders the per-product cards). Put <code>{{ productsHtml }}</code> wherever you want the product list to appear in the email.</p>

          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="cta_enabled" value="1" ${t.cta_enabled ? 'checked' : ''} style="width:auto;">
            <span>Show "Write a review" button on each product card</span>
          </label>

          <label for="t-${t.id}-cta-label">Button label</label>
          <input type="text" id="t-${t.id}-cta-label" name="cta_label" value="${escapeHtml(t.cta_label)}" maxlength="60">

          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="is_active" value="1" ${t.is_active ? 'checked' : ''} style="width:auto;">
            <span>Template is active (dispatcher will use this template when its key matches)</span>
          </label>

          <div style="margin-top:16px; display:flex; gap:8px;">
            <button type="submit" class="primary">Save template</button>
            <a href="/admin/branding/email-template/${encodeURIComponent(t.template_key)}/preview" target="_blank" style="padding:6px 12px;border:1px solid #ccc;border-radius:4px;text-decoration:none;color:#222;font-size:13px;background:#fff;">Preview in new tab</a>
          </div>
        </form>
      </div>
    `).join('');

  const emailTab = `
    <p class="muted">Email templates ship with sensible defaults that use your Shopify brand colors (CTA button) and logo (when synced). Edit the shared branding fields below — they wrap every template — or open a specific template to customize its subject, body copy, and CTA. Designed to scale to many templates: today the dispatcher uses two (<code>request_first</code> for new customers, <code>request_repeat</code> for returning ones); future templates plug into the same system.</p>

    <h3>Shared email branding</h3>
    <p class="muted">These fields apply to every email the dispatcher sends. Leave a field blank to use the default shown.</p>

    <form method="POST" action="/admin/branding/email-branding">
      ${textField({
        id: 'eb-logoUrl',
        name: 'logoUrl',
        label: 'Logo URL',
        description: 'Image displayed at the top of every email. Use the synced Shopify logo, or paste a different image URL. Recommended: ~280px wide, transparent background.',
        overrideValue: emailOverrides.logoUrl,
        defaultValue: emailDefaults.shopifyLogoUrl,
        placeholder: emailDefaults.shopifyLogoUrl ?? 'https://...',
      })}

      ${textField({
        id: 'eb-footerText',
        name: 'footerText',
        label: 'Footer text',
        description: 'Short line at the bottom of every email, just above the unsubscribe link. Variables: {{ brandName }}.',
        overrideValue: emailOverrides.footerText,
        defaultValue: emailDefaults.defaultFooterText,
        placeholder: emailDefaults.defaultFooterText,
      })}

      ${textField({
        id: 'eb-senderName',
        name: 'senderName',
        label: 'Sender display name',
        description: 'How the sender appears in the customer\'s inbox ("From: <SENDER NAME> <reviews@…>"). Defaults to the brand name.',
        overrideValue: emailOverrides.senderName,
        defaultValue: emailDefaults.defaultSenderName,
        placeholder: emailDefaults.defaultSenderName,
      })}

      ${textField({
        id: 'eb-replyTo',
        name: 'replyTo',
        label: 'Reply-to address (optional)',
        description: 'When set, customer replies to review emails go here instead of the From address. Useful if review-request emails are sent from a no-reply alias but you want replies to land in support.',
        overrideValue: emailOverrides.replyTo,
        defaultValue: null,
        placeholder: 'support@brandname.com',
      })}

      <div style="margin-top:16px;">
        <button type="submit" class="primary">Save shared branding</button>
      </div>
    </form>

    <h3 style="margin-top:32px;">Templates</h3>
    <p class="muted">Edit the per-template content. Customers receive <code>request_first</code> the first time they're asked, <code>request_repeat</code> on subsequent asks. Adding new templates programmatically is supported — the dispatcher's "which template to use" logic is the next thing to extend when you want template-by-cohort or per-product variations.</p>
    ${templateCards}
  `;

  return c.html(adminShell('Branding', `
    ${flash}
    <h2>Branding</h2>

    <nav class="tabs" id="branding-tabs">
      <a href="#widget" data-tab="widget">Widget</a>
      <a href="#email"  data-tab="email">Email</a>
    </nav>

    <section id="tab-widget" class="tab-panel" data-tab="widget">${widgetTab}</section>
    <section id="tab-email"  class="tab-panel" data-tab="email">${emailTab}</section>

    <style>${widgetMockupCss}</style>

    <script>
      (function () {
        // --- Initial CSS variables on the mockup, from server-rendered config ---
        var resolved = ${JSON.stringify(resolved)};
        var mockup = document.querySelector('.rv-mockup-frame');
        function applyToMockup(field, value) {
          if (field === 'starColor')      mockup.style.setProperty('--reviews-star-color', value);
          if (field === 'ctaBackground')  mockup.style.setProperty('--reviews-cta-bg', value);
          if (field === 'ctaForeground')  mockup.style.setProperty('--reviews-cta-fg', value);
          if (field === 'borderRadius')   mockup.style.setProperty('--reviews-border-radius', value + 'px');
        }
        Object.keys(resolved).forEach(function (k) { applyToMockup(k, resolved[k]); });

        // --- Tab nav (same pattern as Invitations) ---
        var tabs = document.querySelectorAll('#branding-tabs a');
        var panels = document.querySelectorAll('.tab-panel');
        function showTab(name) {
          tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
          panels.forEach(function (p) { p.classList.toggle('active', p.dataset.tab === name); });
        }
        var hash = (location.hash || '').replace('#', '');
        showTab(hash || 'widget');
        tabs.forEach(function (a) {
          a.addEventListener('click', function (e) {
            e.preventDefault();
            var name = a.dataset.tab;
            history.replaceState(null, '', '#' + name);
            showTab(name);
          });
        });

        // --- Color field wiring: color picker, text input, presets, reset ---
        function setOverrideField(field, value) {
          // value === null means "no override" (reset to default).
          var hidden = document.querySelector('[data-hidden-for="' + field + '"]');
          var resetBtn = document.querySelector('[data-reset-for="' + field + '"]');
          var resolvedNote = document.querySelector('[data-field-row="' + field + '"] .color-field-default strong');
          hidden.value = value === null ? '' : value;
          if (resetBtn) resetBtn.disabled = value === null;
        }
        function syncColorField(field, value) {
          var colorInput = document.querySelector('[data-color-input="' + field + '"]');
          var textInput = document.querySelector('[data-text-input="' + field + '"]');
          if (colorInput) colorInput.value = value;
          if (textInput)  textInput.value = value;
        }
        ['starColor', 'ctaBackground', 'ctaForeground'].forEach(function (field) {
          var colorInput = document.querySelector('[data-color-input="' + field + '"]');
          var textInput  = document.querySelector('[data-text-input="' + field + '"]');
          var resetBtn   = document.querySelector('[data-reset-for="' + field + '"]');

          colorInput.addEventListener('input', function () {
            var v = colorInput.value;
            textInput.value = v;
            applyToMockup(field, v);
            setOverrideField(field, v);
          });
          textInput.addEventListener('input', function () {
            var v = textInput.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              colorInput.value = v;
              applyToMockup(field, v);
              setOverrideField(field, v);
            }
          });
          resetBtn.addEventListener('click', function () {
            // Reset to whatever the resolved default was at page load.
            var v = resolved[field];
            colorInput.value = v;
            textInput.value = v;
            applyToMockup(field, v);
            setOverrideField(field, null);
            // Reload the page after save to re-render the "overridden" tag.
            // For now, just visually clear it.
            var note = document.querySelector('[data-field-row="' + field + '"] .color-field-default strong');
            if (note) note.remove();
          });

          // Preset swatches
          document.querySelectorAll('[data-preset-for="' + field + '"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var v = btn.dataset.color;
              colorInput.value = v;
              textInput.value = v;
              applyToMockup(field, v);
              setOverrideField(field, v);
            });
          });
        });

        // --- Border-radius range slider ---
        var rangeInput = document.querySelector('[data-range-input="borderRadius"]');
        var rangeValue = document.querySelector('[data-range-value="borderRadius"]');
        var rangeReset = document.querySelector('[data-reset-for="borderRadius"]');
        rangeInput.addEventListener('input', function () {
          var v = Number(rangeInput.value);
          rangeValue.textContent = v + 'px';
          applyToMockup('borderRadius', v);
          setOverrideField('borderRadius', v);
        });
        rangeReset.addEventListener('click', function () {
          var v = resolved.borderRadius;
          rangeInput.value = v;
          rangeValue.textContent = v + 'px';
          applyToMockup('borderRadius', v);
          setOverrideField('borderRadius', null);
        });

        // --- Click-to-edit on the mockup: scroll the relevant form field
        //     into view and flash a highlight so the user knows where to go. ---
        document.querySelectorAll('.rv-mockup-target').forEach(function (el) {
          el.addEventListener('click', function (e) {
            e.preventDefault();
            var field = el.dataset.rvEdit;
            var row = document.querySelector('[data-field-row="' + field + '"]');
            if (!row) return;
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Brief highlight flash so it's clear which row matches.
            row.style.transition = 'background-color 0.4s';
            row.style.backgroundColor = '#fffbcc';
            setTimeout(function () { row.style.backgroundColor = ''; }, 800);
            // Focus the text input for immediate editing.
            var textInput = row.querySelector('[data-text-input="' + field + '"]');
            if (textInput) textInput.focus();
          });
        });
      })();
    </script>
  `, 'branding'));
});

// Trims a form value; "" → null (use default). Used for every email-branding
// override field since each can be cleared to fall back to the Shopify or
// hardcoded default.
const emptyToNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
};

admin.post('/branding/email-branding', async (c) => {
  const form = await c.req.formData();
  const overrides = {
    logoUrl:    emptyToNull(form.get('logoUrl')),
    footerText: emptyToNull(form.get('footerText')),
    senderName: emptyToNull(form.get('senderName')),
    replyTo:    emptyToNull(form.get('replyTo')),
  };
  setSetting('email_branding_json', JSON.stringify(overrides));
  log('info', 'admin saved email branding', {
    logoUrlSet: !!overrides.logoUrl,
    footerTextSet: !!overrides.footerText,
    senderNameSet: !!overrides.senderName,
    replyToSet: !!overrides.replyTo,
  });
  return c.redirect('/admin/branding?saved=1#email');
});

admin.post('/branding/email-template/:key', async (c) => {
  const key = c.req.param('key');
  const existing = findEmailTemplate(key);
  if (!existing) {
    return c.html(adminShell('Not found', `<p>No template with key <code>${escapeHtml(key)}</code>.</p><p><a href="/admin/branding#email">Back</a></p>`, 'branding'), 404);
  }
  const form = await c.req.formData();
  const subject  = String(form.get('subject') ?? '').trim();
  const bodyHtml = String(form.get('body_html') ?? '');
  const ctaLabel = String(form.get('cta_label') ?? '').trim();
  const ctaEnabled = form.get('cta_enabled') === '1';
  const isActive   = form.get('is_active') === '1';

  if (!subject) {
    return c.html(adminShell('Invalid input', `<div class="err">Subject can't be empty.</div><p><a href="/admin/branding#email">Back</a></p>`, 'branding'), 400);
  }
  if (!bodyHtml.trim()) {
    return c.html(adminShell('Invalid input', `<div class="err">Body can't be empty.</div><p><a href="/admin/branding#email">Back</a></p>`, 'branding'), 400);
  }

  upsertEmailTemplate({
    templateKey: key,
    displayName: existing.display_name,
    subject,
    bodyHtml,
    ctaEnabled,
    ctaLabel: ctaLabel || 'Write a review',
    isActive,
  });
  log('info', 'admin saved email template', { templateKey: key, isActive, ctaEnabled });
  return c.redirect('/admin/branding?saved=1#email');
});

admin.get('/branding/email-template/:key/preview', (c) => {
  const key = c.req.param('key');
  const template = findEmailTemplate(key);
  if (!template) {
    return c.text('Template not found', 404);
  }

  // Sample data — what a "typical" email would look like with this template.
  // No actual products or customers are touched; just renders the template
  // against placeholder content so the merchant can see the visual result.
  const branding = resolveEmailBranding();
  const sampleCtx = {
    firstName: 'Maria',
    brandName: config.email.brandName,
    productName: 'Sample Product',
    productCount: 2,
    productsHtml: `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px;">
        <tr>
          <td width="96" style="padding-right:16px;vertical-align:top;">
            <div style="width:80px;height:80px;background:#eee;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;">[image]</div>
          </td>
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;margin-bottom:6px;">Sample Product</div>
            ${template.cta_enabled ? `<a href="#" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">${escapeHtml(template.cta_label)}</a>
              <div style="margin-top:6px;font-size:12px;"><a href="#" style="color:#888;text-decoration:underline;">Don't ask about this one</a></div>` : `<div style="margin-top:6px;font-size:12px;"><a href="#" style="color:#888;text-decoration:underline;">Don't ask about this one</a></div>`}
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 20px;">
        <tr>
          <td width="96" style="padding-right:16px;vertical-align:top;">
            <div style="width:80px;height:80px;background:#eee;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;">[image]</div>
          </td>
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;margin-bottom:6px;">Another Sample Product</div>
            ${template.cta_enabled ? `<a href="#" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;">${escapeHtml(template.cta_label)}</a>
              <div style="margin-top:6px;font-size:12px;"><a href="#" style="color:#888;text-decoration:underline;">Don't ask about this one</a></div>` : `<div style="margin-top:6px;font-size:12px;"><a href="#" style="color:#888;text-decoration:underline;">Don't ask about this one</a></div>`}
          </td>
        </tr>
      </table>
    `,
    unsubGlobalUrl: '#preview',
  };
  const renderedBody = renderString(template.body_html, sampleCtx);
  const renderedSubject = renderString(template.subject, sampleCtx);
  const renderedFooter = renderString(branding.footerText, sampleCtx);

  const logoHeader = branding.logoUrl
    ? `<tr><td align="center" style="padding:24px 32px 0;">
         <img src="${branding.logoUrl}" alt="${escapeHtml(branding.senderName)}" style="max-width:140px; height:auto;" />
       </td></tr>`
    : '';
  const footerHtml = `
    <p style="margin:0; font-size:12px; color:#888; line-height:1.5;">
      ${renderedFooter}
      <a href="#preview" style="color:#888; text-decoration:underline;">Unsubscribe from all review requests</a>
    </p>
  `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(renderedSubject)}</title>
</head>
<body style="margin:0; padding:0; background:#f6f6f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; color:#222;">
  <div style="padding:8px 16px; background:#fff8e1; border-bottom:1px solid #ffd54f; font-size:12px; color:#7a4f01;">
    <strong>Preview</strong> — this email is rendered with sample data (placeholder customer name, fake products). Subject: <code>${escapeHtml(renderedSubject)}</code>
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#ffffff; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,0.06);">
        ${logoHeader}
        <tr><td style="padding:32px 32px 16px;">
          ${renderedBody}
        </td></tr>
        <tr><td style="padding:16px 32px; border-top:1px solid #eaeaea; background:#fafafa; border-radius:0 0 8px 8px;">
          ${footerHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(html);
});

admin.post('/branding', async (c) => {
  const form = await c.req.formData();

  const readColor = (key: string): string | null => {
    const raw = String(form.get(key) ?? '').trim();
    if (raw === '') return null;
    return isValidHexColor(raw) ? raw : null;
  };

  const readNumber = (key: string, min: number, max: number): number | null => {
    const raw = String(form.get(key) ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.max(min, Math.min(max, Math.round(n)));
    return clamped;
  };

  const overrides = {
    starColor:     readColor('starColor'),
    ctaBackground: readColor('ctaBackground'),
    ctaForeground: readColor('ctaForeground'),
    borderRadius:  readNumber('borderRadius', 0, 20),
  };

  setSetting('widget_config_json', JSON.stringify(overrides));
  log('info', 'admin saved widget branding', overrides);

  return c.redirect('/admin/branding?saved=1');
});

// --- Settings ---

admin.get('/settings', (c) => {
  const savedFlash = c.req.query('saved') === '1' ? '<div class="ok">Settings saved.</div>' : '';
  const cacheFlash = c.req.query('cache_refreshed') !== undefined
    ? `<div class="ok">Cleared ${escapeHtml(c.req.query('cache_refreshed') ?? '0')} cached product${c.req.query('cache_refreshed') === '1' ? '' : 's'}. The next storefront load (or admin operation) for each product will re-fetch from Shopify, picking up any updated metafields or product changes.</div>`
    : '';
  const pausedFlash = c.req.query('paused') === '1' ? '<div class="ok">Reviews paused. The widget and submission paths now return an "unavailable" notice.</div>' : '';
  const extendedFlash = c.req.query('extended') === '1' ? '<div class="ok">Pause extended.</div>' : '';
  const resumedFlash = c.req.query('resumed') === '1' ? '<div class="ok">Reviews resumed.</div>' : '';
  const flash = savedFlash + cacheFlash + pausedFlash + extendedFlash + resumedFlash;
  const cadenceMax = getSettingNumber('cadence_max_requests', 3);
  const cadenceMin = getSettingNumber('cadence_min_days_between', 7);
  const requestDelay = getSettingNumber('request_delay_days', 7);
  const dispatcherBatch = getSettingNumber('cadence_dispatcher_batch', 100);
  const dispatcherHour = getSettingNumber('dispatcher_hour', 20);
  const dispatcherMinute = getSettingNumber('dispatcher_minute', 17);
  const immediateOnFulfillment = getSetting('dispatch_immediately_on_fulfillment') === '1';
  const profanityList = getProfanityWordlist();
  const pauseState = getPauseState();
  const panicEvents = listPanicEvents(20);
  const notifyConfig = getNewReviewNotifyConfig();

  const activeTheme = getActiveAdminTheme();
  const themeOptions = Object.entries(ADMIN_THEMES)
    .map(([key, t]) => `<option value="${key}"${key === activeTheme ? ' selected' : ''}>${escapeHtml(t.label)}</option>`)
    .join('');

  // Hour dropdown: 1-12
  const hourOptions = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((h) => `<option value="${h}">${h}</option>`)
    .join('');
  // Minute dropdown: 0-59, two-digit
  const minuteOptions = Array.from({ length: 60 }, (_, i) => i)
    .map((m) => `<option value="${m}">${m.toString().padStart(2, '0')}</option>`)
    .join('');

  return c.html(adminShell('Settings', `
    ${flash}
    <nav class="tabs" id="settings-tabs">
      <a href="#cadence"       data-tab="cadence">Cadence</a>
      <a href="#notifications" data-tab="notifications">Notifications</a>
      <a href="#moderation"    data-tab="moderation">Moderation</a>
      <a href="#appearance"    data-tab="appearance">Appearance</a>
      <a href="#setup"         data-tab="setup">Setup</a>
    </nav>

    <section id="tab-cadence" class="tab-panel" data-tab="cadence">
    <h2>Cadence</h2>
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

        <p class="muted" style="margin: 8px 0;">Shopify brand colors and the widget appearance live on the <a href="/admin/branding">Branding</a> page.</p>

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
    </section>

    <section id="tab-moderation" class="tab-panel" data-tab="moderation">
    <div class="card">
      <h3 style="margin-top:0;">Profanity filter</h3>
      <p class="muted">Words listed here are censored to <code>****</code> in review titles and bodies at submission time. Whole-word match, case-insensitive. One word per line. Lines starting with <code>#</code> are comments. Reviewer display names are never censored. This is a light filter, not a held-pending queue — reviews still publish immediately; if a censored review needs full removal, retract it from the Reviews page.</p>
      <form method="POST" action="/admin/settings/profanity">
        <label for="profanity_wordlist">Wordlist</label>
        <textarea id="profanity_wordlist" name="profanity_wordlist" rows="8" style="font-family:monospace;font-size:13px;" placeholder="One word per line, e.g.&#10;spam&#10;scam&#10;# comment lines like this are ignored">${escapeHtml(profanityList.join('\n'))}</textarea>
        <p class="muted" style="margin-top:4px;font-size:12px;">${profanityList.length === 0 ? 'No words configured. Filter is inactive.' : `${profanityList.length} word${profanityList.length === 1 ? '' : 's'} active.`}</p>
        <div style="margin-top:12px;">
          <button type="submit" class="primary">Save wordlist</button>
        </div>
      </form>
    </div>

    ${renderPanicCard(pauseState, panicEvents)}
    </section>

    <section id="tab-notifications" class="tab-panel" data-tab="notifications">
    <div class="card">
      <h3 style="margin-top:0;">New review notifications</h3>
      <p class="muted">Get an email when a customer submits a review. Useful for catching low-star reviews early. Sent from the same Gmail SMTP as customer emails — no separate config.</p>
      <form method="POST" action="/admin/settings/new-review-notify">
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" name="enabled" value="1" ${notifyConfig.enabled ? 'checked' : ''} style="width:auto;">
          <span>Enable new-review notifications</span>
        </label>

        <label for="notify-email">Recipient email</label>
        <input type="text" id="notify-email" name="email" value="${escapeHtml(notifyConfig.email)}" placeholder="you@brandname.com" maxlength="200">

        <label>Send notifications for these ratings</label>
        <div style="display:flex; gap:16px; margin-top:6px; flex-wrap:wrap;">
          ${[1,2,3,4,5].map((n) => `
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;font-size:14px;">
              <input type="checkbox" name="ratings" value="${n}" ${notifyConfig.ratings.includes(n) ? 'checked' : ''} style="width:auto;">
              <span>${'★'.repeat(n)} (${n})</span>
            </label>
          `).join('')}
        </div>
        <p class="muted" style="margin-top:4px;font-size:12px;">Common settings: just <code>1, 2, 3</code> to catch problems, or <code>1–5</code> for every review.</p>

        <div style="margin-top:16px;">
          <button type="submit" class="primary">Save notification settings</button>
        </div>
      </form>
    </div>
    </section>

    <section id="tab-setup" class="tab-panel" data-tab="setup">
    <div class="card">
      <h3 style="margin-top:0;">Per-variant reviews (optional setup)</h3>
      <p class="muted">By default, all reviews on a product apply to every variant of that product (sizes, colors, etc. share one review pool). For products where variants are genuinely different — e.g., flavors or scents — you can opt that specific product into per-variant review pools so each variant has its own reviews, with a "Customers also reviewed these variants" section surfacing sibling-variant reviews below the main list.</p>

      <details style="margin-top:12px;">
        <summary style="cursor:pointer;font-weight:600;">How to set up per-variant reviews on a Shopify product</summary>
        <div style="margin-top:12px;padding:16px;background:#f9f9f9;border-radius:6px;font-size:14px;">
          <p><strong>One-time: define the metafield in your store.</strong></p>
          <ol style="padding-left:20px;line-height:1.6;">
            <li>Go to your Shopify admin → <strong>Settings → Custom data → Products</strong>.</li>
            <li>Click <strong>Add definition</strong>.</li>
            <li>Set <strong>Name</strong>: <code>Variant handling</code></li>
            <li>Set <strong>Namespace and key</strong>: <code>reviews.variant_handling</code></li>
            <li>Set <strong>Type</strong>: Single line text</li>
            <li>Under <strong>Validation</strong> (optional but recommended): set <em>Limit to preset choices</em> with the values <code>distinct</code> and <code>shared</code>. This makes the field a dropdown in the product editor.</li>
            <li>Click <strong>Save</strong>.</li>
          </ol>
          <p style="margin-top:16px;"><strong>Per product: turn on per-variant pools.</strong></p>
          <ol style="padding-left:20px;line-height:1.6;">
            <li>Open the product in Shopify admin.</li>
            <li>Scroll to the <strong>Metafields</strong> section.</li>
            <li>Find <strong>Variant handling</strong> and set it to <code>distinct</code>.</li>
            <li>Save.</li>
          </ol>
          <p style="margin-top:16px;">Products without the metafield set (or with it set to anything other than <code>distinct</code>) keep the default shared-review-pool behavior.</p>
          <p>The storefront widget picks up the change on the next product-cache refresh (TTL is 1 hour). To verify the change immediately, click <strong>Refresh product cache</strong> below.</p>
        </div>
      </details>

      <form method="POST" action="/admin/refresh-product-cache" style="margin-top:16px;">
        <button type="submit">Refresh product cache</button>
        <p class="muted" style="font-size:12px;margin-top:4px;">Clears the local product cache so the next storefront load re-fetches each product (and its <code>variant_handling</code> metafield) from Shopify. Use this after changing the metafield on a product if you want the storefront to reflect the change right away rather than waiting up to an hour.</p>
      </form>
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Storefront-customer review submission (App Proxy setup)</h3>
      <p class="muted">By default, customers can only leave reviews via the email-link flow (sent after fulfillment) or sample invitations. To let logged-in storefront customers submit reviews directly from product pages — and edit their own existing reviews — set up Shopify's App Proxy on the Reviews app. This routes customer-authenticated requests through Shopify's edge with a cryptographic signature we verify, so no customer can submit a review as someone else.</p>

      <details style="margin-top:12px;">
        <summary style="cursor:pointer;font-weight:600;">How to configure App Proxy in dev.shopify.com</summary>
        <div style="margin-top:12px;padding:16px;background:#f9f9f9;border-radius:6px;font-size:14px;">
          <p><strong>One-time: configure the proxy on the app version.</strong></p>
          <ol style="padding-left:20px;line-height:1.6;">
            <li>Go to <strong>dev.shopify.com → Reviews app → Versions → Create version</strong>.</li>
            <li>Carry over all the existing config (scopes, redirect URLs, embed-off, legacy install flow on, etc. — same as the current active version).</li>
            <li>In the <strong>App Proxy</strong> section, set:
              <ul style="padding-left:20px;line-height:1.6;">
                <li><strong>Subpath prefix</strong>: <code>apps</code></li>
                <li><strong>Subpath</strong>: <code>reviews</code></li>
                <li><strong>Proxy URL</strong>: <code>${escapeHtml(config.publicUrl)}/proxy/</code> (include the trailing slash)</li>
              </ul>
            </li>
            <li><strong>Release</strong> the new version. The currently-installed store(s) will automatically pick up the new App Proxy config without needing re-install.</li>
          </ol>
          <p style="margin-top:16px;"><strong>Per theme: add data attributes to the widget div.</strong></p>
          <p>In your <code>sections/product-information.liquid</code> (or wherever you placed the widget), update the div to:</p>
          <pre style="background:#222;color:#eee;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;">&lt;div
  data-reviews-widget="full"
  data-product-id="{{ product.id }}"
  data-variant-id="{{ product.selected_or_first_available_variant.id }}"
  data-customer-id="{{ customer.id }}"
&gt;&lt;/div&gt;</pre>
          <p>The <code>data-customer-id</code> Liquid variable resolves to the logged-in customer's numeric ID when they're signed in, or an empty string when they aren't. The widget reads this to decide whether to render "Write a review" / "Edit your review" / "Log in to write a review."</p>
        </div>
      </details>

      <p class="muted" style="font-size:12px;margin-top:12px;">Once App Proxy is configured, logged-in customers see a "Write a review" button in the widget header (and on empty-state cards). It opens a modal with the review form. Customers with an existing review see "Edit your review" instead, and their own review is highlighted with a "Your review" tag at the top of the list.</p>
    </div>
    </section>

    <section id="tab-appearance" class="tab-panel" data-tab="appearance">
    <h2>Appearance</h2>
    <div class="card">
      <form method="POST" action="/admin/settings/theme">
        <label for="admin_theme">Dashboard theme</label>
        <select id="admin_theme" name="admin_theme">${themeOptions}</select>
        <p class="muted" style="margin:8px 0 12px;">Changes the look of this admin dashboard only. Five accent colors in light and dark, all chosen for readability. (A "match my Shopify brand" option will appear here once brand sync is connected.)</p>
        <button type="submit" class="primary">Apply theme</button>
      </form>
    </div>
    </section>

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
    <script>
      (function () {
        var tabs = document.querySelectorAll('#settings-tabs a');
        var panels = document.querySelectorAll('.tab-panel');
        function show(name) {
          tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
          panels.forEach(function (p) { p.classList.toggle('active', p.dataset.tab === name); });
        }
        var hash = (location.hash || '').replace('#', '');
        var search = location.search;
        var initial = hash || 'cadence';
        // Panic actions redirect with ?paused/extended/resumed — land on Moderation so the result is visible.
        if (search.indexOf('paused=') !== -1 || search.indexOf('extended=') !== -1 || search.indexOf('resumed=') !== -1) initial = 'moderation';
        show(initial);
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

// --- Panic button: pause / extend / resume ---

const CONFIRM_PHRASE = 'PAUSE REVIEWS';

const notifyDevOfPause = async (input: {
  eventType: 'pause' | 'extend' | 'resume';
  reason: string | null;
  actor: string;
  pausedUntil: number | null;
}): Promise<void> => {
  const to = config.email.devNotificationEmail;
  if (!to) {
    log('info', 'panic event: dev notification skipped (DEV_NOTIFICATION_EMAIL not set)', input);
    return;
  }
  const brand = config.email.brandName;
  const verb = input.eventType === 'pause' ? 'PAUSED' : input.eventType === 'extend' ? 'EXTENDED' : 'RESUMED';
  const subject = `[Reviews / ${brand}] Panic button ${verb}`;
  const untilLine = input.pausedUntil
    ? `Paused until: ${new Date(input.pausedUntil * 1000).toISOString()} (UTC)`
    : 'Paused until: cleared';
  const reasonLine = input.reason ? `Reason: ${input.reason}` : 'Reason: (n/a)';
  const adminUrl = `${config.publicUrl.replace(/\/+$/, '')}/admin/settings`;
  const text = [
    `Reviews system event: ${verb}`,
    '',
    `Store: ${brand}`,
    `Actor: ${input.actor}`,
    reasonLine,
    untilLine,
    '',
    `Admin: ${adminUrl}`,
  ].join('\n');
  const html = `<p><strong>Reviews system event: ${escapeHtml(verb)}</strong></p>
<p>Store: ${escapeHtml(brand)}<br>
Actor: ${escapeHtml(input.actor)}<br>
${escapeHtml(reasonLine)}<br>
${escapeHtml(untilLine)}</p>
<p><a href="${adminUrl}">Open admin</a></p>`;
  try {
    await sendMail({ to, subject, html, text });
    log('info', 'panic event: dev notified', { to, eventType: input.eventType });
  } catch (err) {
    log('error', 'panic event: dev notification failed', {
      to,
      eventType: input.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

admin.post('/panic/pause', async (c) => {
  const form = await c.req.formData();
  const reason = String(form.get('reason') ?? '').trim().slice(0, 1000);
  const confirm = String(form.get('confirm') ?? '').trim();
  const hoursRaw = Number(form.get('hours') ?? PAUSE_DEFAULT_HOURS);

  if (!reason) {
    return c.text('reason required', 400);
  }
  if (confirm !== CONFIRM_PHRASE) {
    return c.text(`confirmation phrase must be "${CONFIRM_PHRASE}"`, 400);
  }
  const state = pauseReviews({ reason, actor: 'admin', hours: hoursRaw });
  log('warn', 'admin paused reviews', { hoursRaw, pausedUntil: state.pausedUntil });
  await notifyDevOfPause({
    eventType: 'pause',
    reason,
    actor: 'admin',
    pausedUntil: state.pausedUntil,
  });
  return c.redirect('/admin/settings?paused=1');
});

admin.post('/panic/extend', async (c) => {
  const form = await c.req.formData();
  const hoursRaw = Number(form.get('hours') ?? PAUSE_DEFAULT_HOURS);
  const state = extendPause({ actor: 'admin', hours: hoursRaw });
  log('warn', 'admin extended pause', { hoursRaw, pausedUntil: state.pausedUntil });
  await notifyDevOfPause({
    eventType: 'extend',
    reason: state.reason,
    actor: 'admin',
    pausedUntil: state.pausedUntil,
  });
  return c.redirect('/admin/settings?extended=1');
});

admin.post('/panic/resume', async (c) => {
  resumeReviews({ actor: 'admin' });
  log('warn', 'admin resumed reviews');
  await notifyDevOfPause({
    eventType: 'resume',
    reason: null,
    actor: 'admin',
    pausedUntil: null,
  });
  return c.redirect('/admin/settings?resumed=1');
});

admin.post('/settings/new-review-notify', async (c) => {
  const form = await c.req.formData();
  const enabled = form.get('enabled') === '1';
  const email = String(form.get('email') ?? '').trim();
  const ratings = form.getAll('ratings')
    .map((v) => parseInt(String(v), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  setNewReviewNotifyConfig({ enabled, email, ratings });
  log('info', 'admin updated new-review notification config', {
    enabled,
    hasEmail: email.length > 0,
    ratings,
  });
  return c.redirect('/admin/settings?saved=1');
});

admin.post('/settings/profanity', async (c) => {
  const form = await c.req.formData();
  const raw = String(form.get('profanity_wordlist') ?? '');
  const words = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  setProfanityWordlist(words);
  log('info', 'admin updated profanity wordlist', { wordCount: words.length });
  return c.redirect('/admin/settings?saved=1');
});

// --- Brand info sync from Shopify ---

admin.post('/settings/theme', async (c) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  const form = await c.req.formData();
  const theme = String(form.get('admin_theme') ?? '');
  if (theme in ADMIN_THEMES) {
    setSetting('admin_theme', theme);
  }
  return c.redirect('/admin/settings?saved=1');
});

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

admin.post('/refresh-product-cache', (c) => {
  const removed = clearProductCache();
  log('info', 'admin cleared product cache', { rowsRemoved: removed });
  return c.redirect('/admin/settings?cache_refreshed=' + removed);
});

admin.use('/refresh-product-cache', async (c, next) => {
  if (!(await requireAuth(c))) return c.redirect('/admin');
  await next();
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
