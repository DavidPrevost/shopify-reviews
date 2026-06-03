# STATE — what the Reviews app is and does today

> **📚 Documentation map** — Shopify Reviews app. Five maintained docs; this is one of them.
>
> - **`docs/STATE.md`** — What the app does *today*: architecture, feature catalogue, deploy topology. The "current reality" doc.
> - **`docs/INSTALL.md`** — Repeatable, store-agnostic install from scratch: Dev Dashboard app, `.env`, Docker stack, OAuth token capture, webhooks, App Proxy, brand assets.
> - **`docs/OPERATIONS.md`** — Running it in production: deploy & branch/hotfix flow, env-var reference, backups & restore, monitoring, troubleshooting.
> - **`docs/ROADMAP.md`** — What's next, known debts, deferred items, and the "explicitly NOT building" list.
> - **`CHANGELOG.md`** — Dated record of notable changes, one entry per release.

---

## In one paragraph

A self-hosted Shopify product-reviews app — a replacement for a stale Yotpo install — for a single brand store (Teraclay) today, written so a multi-tenant version is a later step rather than a rewrite. It collects reviews (via post-purchase email requests, storefront submission, and sample/campaign invitations), moderates them, renders them on the storefront through a script-tag widget, and runs an email engine whose defining feature is **disciplined review-request cadence and suppression**. It also runs **Campaigns**: an application-based sample-distribution program with versioned terms, discount codes, and feedback forms.

The app is a single Node.js (Hono) process backed by SQLite, deployed via Docker on a home-lab mini-PC (Mercury), reached from the public internet through a small always-free cloud relay. There is no third-party tracker, no external SaaS dependency beyond Gmail SMTP and Shopify's own APIs.

---

## Architecture (current model)

> The earlier "password-protected standalone admin / static token / no OAuth / no App Proxy / Storefront-API brand sync" design is **superseded**. What follows is the live model.

- **Admin UI is embedded in Shopify admin** via App Bridge. Each admin page load carries a Shopify **session token (JWT)**; the app verifies it (hand-rolled HMAC verification in `src/lib/embed-auth.ts`, signed with the app's client secret) and exchanges it for a short-lived signed **session cookie** (`reviews_embed_session`, 24h, `SameSite=None; Secure`) so subsequent in-iframe GET navigations and `<form>` POSTs authenticate without a fresh token each time. When there's no valid cookie, `/admin/*` serves a tiny bootstrap page that loads App Bridge, gets a token, posts it to `/admin/exchange-session`, and reloads.
- **Install is via OAuth.** A one-shot helper (`src/scripts/install-shopify.ts`) runs the OAuth grant flow and captures a **permanent offline** Admin API token (new `shpua_` prefix), persisted per-shop in `shops.access_token`. The Admin API client (`src/shopify/admin-client.ts`) prefers that per-shop token and falls back to `SHOPIFY_ADMIN_TOKEN` from `.env` only until OAuth has populated the column.
- **The app's client secret is one value with three jobs**: OAuth callback signing, webhook HMAC verification, and embedded-admin session-token (JWT) verification. It lives in `.env` as `SHOPIFY_WEBHOOK_SECRET` for historical reasons.
- **Storefront customer actions go through Shopify's App Proxy** (`/proxy/*`). Every proxy request's HMAC signature is verified before anything runs (`src/shopify/app-proxy-verify.ts`), so the `logged_in_customer_id` Shopify forwards can be trusted. This carries: logged-in-customer review submit/edit, the **brand relay** (`POST /proxy/brand`), and the public **campaign application** and **feedback** forms.
- **Public review reads** (review lists, aggregate stars) stay on `/api/*` with CORS to the storefront origin — no per-request Shopify round trip, no auth needed.
- **The storefront widget** is a single esbuild-bundled IIFE (`public/widget.js`) loaded by a `<script>` tag plus placeholder `<div>`s with `data-*` attributes — deliberately theme-agnostic so it survives a theme redesign. It detects its own API base from its script `src`, so one bundle works on dev and prod.
- **Persistence is SQLite** (`better-sqlite3`, synchronous) at `data/reviews.db`, with a filename-tracked migration runner (`src/db/client.ts`).
- **Scheduling is in-process** (`node-cron`): a daily dispatcher job at an operator-configured time, plus on-demand admin actions.

### Deploy topology

| | Dev | Prod |
|---|---|---|
| Stack dir (Mercury) | `/opt/stacks/shopify-reviews-dev/` | `/opt/stacks/shopify-reviews/` |
| Host port (Tailscale-bound) | `8071` | `8070` |
| Public URL | `https://reviews-dev.teraclay.com` | `https://reviews.teraclay.com` |
| Shopify store | `teraclay-dev.myshopify.com` | `teraclay.myshopify.com` |
| Tracks branch | `develop` | `main` |

- **Mercury** (`100.117.6.18`, Tailscale IP) is a persistent Intel N100 mini-PC on Ubuntu 24.04 running Docker. The app's port is bound to Mercury's **Tailscale interface**, not `0.0.0.0` — so it's never directly exposed to the LAN or internet.
- **Public ingress** is a Google Cloud always-free `e2-micro` VM running **Caddy + Tailscale**. Caddy terminates HTTPS (Let's Encrypt) for `reviews*.teraclay.com` and reverse-proxies over Tailscale to Mercury's bound port. Squarespace holds DNS (one A record per subdomain → the relay's static IP). Mercury keeps **zero inbound ports** open to the internet.
- **Backups**: a sidecar container snapshots the SQLite DB nightly to `data/snapshots/` and rsyncs to the second mini-PC (Pebbles) over Tailscale.
- **Branch model**: `main` = production, `develop` = development; hotfixes on `main` merge back to `develop`. Code is written on Windows (`D:\AI\shopify-reviews\`), pushed to Gitea on Mercury, pulled + `docker compose up -d --build` on the target stack.

### Tech stack

TypeScript (ESM) · Hono · better-sqlite3 · nodemailer (Gmail SMTP via the brand's `reviews@` alias) · node-cron · esbuild (widget bundle) · Docker Compose. No ORM; SQL is written directly. Build = `tsc` + esbuild + an asset-copy step.

---

## Data model

All timestamps are unix seconds. The migration runner applies numbered `.sql` files in `src/db/migrations/` once each (tracked by filename in `_migrations`).

**Core (active) tables**: `customers`, `products_cache`, `purchases`, `reviews`, `email_events`, `settings`, `email_templates`, `sample_invitations`, `moderation_events`, `panic_events`, `review_reports`, `banned_reporters`, and the campaign tables (`campaigns`, `campaign_terms_versions`, `campaign_members`, `campaign_feedback_forms`, `campaign_feedback_questions`, `campaign_feedback_responses`, `campaign_feedback_answers`).

**Reserved-for-a-future-version schema** (poured now to avoid a later data migration; not exercised by feature code today — touched only by GDPR-redact wipes):
- `review_media` table → future photo/video reviews.
- `questions` table → future product Q&A. *(Distinct from the built campaign `feedback_questions`.)*
- `reviews.merchant_reply` / `merchant_reply_at` columns → admin can store a reply, but the storefront widget does not surface it yet.

**Multi-tenant foundation (Part A — done, dormant)**: every domain table carries a `shop_id` (default `1`), composite `UNIQUE`/index constraints were rebuilt around it (migration 016), a `shops` table holds per-shop config + the OAuth token (migration 017), and `src/lib/tenant.ts`'s `getCurrentShopId()` is the single chokepoint that returns the constant `1` today and becomes the per-request shop lookup when multi-tenancy is built. See `docs/ROADMAP.md` for the deferred multi-tenant work (Part B).

---

## Feature catalogue

### Review collection & moderation
- Reviews are **published immediately** (trust model: publish-now, retract-with-reason — no pre-publish moderation queue by design). Moderation = retract (reason required, optional internal note, optional notify-the-reviewer email) and restore, all written to an audit log (`moderation_events`).
- **Profanity filter**: censor-on-write. The stored public title/body are censored; the original text is preserved in `*_original` columns and shown only in admin. The merchant edits a visible (blur-until-focus) wordlist; a save re-scans existing reviews.
- **Report-this-review** flow: storefront visitors flag reviews → a reports queue in admin; abusive reporters can be banned.
- **Panic "pause reviews"** button: a single `panic_paused_until` timestamp gates all review-acceptance surfaces; auto-expires with no cron (the dashboard just notices the clock passed). Pause/extend/resume are logged.

### Email cadence & suppression — the core differentiator
- Post-purchase flow: `orders/paid` records customers + purchases; `orders/fulfilled` arms a purchase with a `due_at` (fulfillment time + `request_delay_days`, default 7). The daily dispatcher emails everything that's due and **not suppressed**.
- **Suppression rules live in the eligibility SQL**, not scattered logic. A purchase is excluded if: already reviewed by that customer, global opt-out, per-product opt-out, request count ≥ cap (`cadence_max_requests`, default 3), or too soon since the last request (`cadence_min_days_between`, default 7). The three **respect rules** (already-reviewed, global opt-out, product opt-out) are never bypassable; the two **policy rules** (max-requests, min-days) have dev-only bypass toggles.
- **Suppression audit**: each dispatcher run reports why rows were held back, in priority order globalOptOut → productOptOut → alreadyReviewed → maxRequestsHit → cadenceTooSoon (respect rules outrank policy rules so a non-zero `cadenceTooSoon` genuinely means "only cadence held it"). Terminal suppressions null `due_at`, so `productOptOut`/`maxRequestsHit` legitimately read 0 in the audit even though the suppression worked.
- **Go-live cutoff guard** (`request_cutoff_at`): orders fulfilled before the cutoff are imported but left un-armed (`due_at` NULL), so backfilling a live store's history can't flood pre-existing customers. Set at launch; backfill also refuses to arm pre-cutoff orders as a second line of defense.
- **Email kill switch** (`emails_disabled`, in Settings → Setup): blocks every `sendMail` call at the source. Use case: go live accepting reviews via the widget while sending no email until templates are ready.
- **Dispatcher schedule**: runs once daily at a time the operator sets in **Settings → Cadence** via a local-timezone `HH:MM AM/PM` picker (the admin UI shows the browser's timezone and converts to/from the UTC hour/minute stored in settings; node-cron runs in UTC under the hood). The schedule re-registers live when the setting changes — no restart. A per-run batch cap (`cadence_dispatcher_batch`, default 100) guards against runaway sends and stays well under Gmail's ~500/day ceiling.
- **Backfill**: an admin/CLI action that scans recent paid orders and imports customers/purchases (respecting the cutoff guard). Note: backfill always uses `request_delay_days`; the "dispatch immediately on fulfillment" dev toggle only affects the live `orders/fulfilled` path.

### Email templates & branding
- Templates are **table-driven** (`email_templates`) and bound to **triggers**, so the merchant edits copy and chooses when each fires rather than touching code. Wired triggers: review request (first / repeat / follow-up), review removed/restored, and the four campaign emails. `review_submitted_thankyou` is listed but `wired:false` (authorable now, sends when that path ships).
- Rendered emails wrap body + footer in a shared shell (`_shell.html`). **No logo is auto-prepended** — the merchant inserts it via the editor or `{{ logoUrl }}` (explicit design choice; the unsubscribe footer is the only thing forced).
- The in-email CTA button's colors, border-radius, and label come from **Branding → Widget** (`resolveWidgetConfig()`), so one knob styles both the storefront button and the email button. (A per-template `cta_label` column is preserved but ignored at render.)
- **Sender display name** and **reply-to** overrides are honored for customer-facing sends (the raw `SMTP_FROM` address is reused but the display name is swapped). Operator notifications intentionally don't.
- **Logo upload**: self-hosted PNG/JPG (≤250 KB) stored under the data volume, served from our origin; new uploads get a fresh URL to bust email-client caches.
- The admin chrome has **10 preset themes** plus a "Brand" theme derived from the store's brand colors when present.

### Storefront widget
- Two display modes: `full` (reviews list + aggregate + write/edit CTA, on product pages) and `aggregate` (stars + count, for collection cards). MutationObserver-friendly for dynamic themes.
- Colors inherit from the theme by default (`currentColor`/`inherit`/CSS variables) with optional explicit `data-*` overrides.
- **Brand assets** reach the backend via the **Liquid brand relay**: the theme passes `shop.brand` colors + logo as data attributes; the widget posts them to the HMAC-verified `/proxy/brand`, which writes `shop_brand_json` (shared by widget, emails, and the admin Brand theme). **Manual entry** in Branding is the fallback. *(The old Storefront-API brand-sync path was removed — Shopify doesn't expose Storefront API access to this single-store app.)*
- Verified badges: "Verified Buyer" (purchase-backed) vs "Verified Reviewer" (sample/invitation).

### Campaigns (shipping in v1, intentionally mid-build)
An application-based sample-distribution program. Lifecycle: **draft → recruiting → closed → shipping → active → completed** (cancel available from any state). Members move **applied → approved → shipped → reminded → reviewed → done** (rejected as a side branch).
- Public application form (rendered by the widget into a Shopify Page, submitted via App Proxy) with **versioned terms** — a submission must match the active terms version. Capacity auto-closes the campaign at target and fires a one-shot capacity-warning email at a threshold. Rate-limited by IP.
- **Per-participant discount codes** via the Shopify Admin API (`discountCodeBasicCreate`), each `usageLimit`-capped (per-recipient limit configurable via `discount_usage_limit`); redemption tracked through `orders/paid`. Cleanup actions delete unredeemed or all codes (audit trail kept).
- **Feedback forms**: one per (campaign, product), anonymous via a shared access key, question types rating/single/multi/short/long, with per-question admin aggregates. Reachable both as a hosted landing page and embedded via the widget.
- **Retention pipe**: completing a campaign quarantines shipping addresses (`pending_deletion`); a merchant-confirmed purge NULLs them (Stage 2).
- Campaign emails (`application_confirmation`, `shipped_notification`, `review_reminder`, `launch_thanks`) are non-revocable-consent per the accepted terms and don't touch the normal review-request cadence counters.

### Sample invitations
Single-use review links for product given outside the normal purchase flow (influencers, free samples). Single or CSV-batch creation, mail-merge export, and a "Verified Reviewer" badge distinct from "Verified Buyer."

---

## Known limitations (pointers — full detail in ROADMAP)
- Single-tenant today (multi-tenant foundation poured, not wired).
- Reserved v2 surfaces not built: photo reviews, product Q&A, storefront-surfaced merchant replies, analytics dashboard.
- Webhooks are **not** auto-subscribed on OAuth install — `install-webhooks` must be run per shop (see INSTALL/OPERATIONS).
- Manual-ops buttons (backfill/dispatcher) currently dump raw JSON (a friendly-banner fast-follow is logged).
