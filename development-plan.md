# Shopify Reviews — Development Plan

This document is the canonical reference for the Shopify reviews application. It is intended for any developer (human or AI agent) picking up this project. Read it end-to-end before writing code.

---

## 1. Purpose & Context

The brand currently uses Yotpo for product reviews on its Shopify storefront. The previous owner's Yotpo account was lost; the lingering widget still renders stale aggregate ratings ("7 reviews / 5 stars"), but the "Write Review" button is broken because the JS bundle 404s. Yotpo's pricing ($15/month for under 50 reviews) does not fit the brand's bootstrapped re-startup budget.

This project replaces Yotpo with a **self-hosted, owner-controlled reviews application** running on the brand's home-lab hardware. It must integrate with the live Shopify store for product data, customer data, and order events, and it must surface reviews on storefront product pages without disrupting customer experience.

---

## 2. Goals & Non-Goals

### Goals

- **$0/month baseline.** Use existing hardware, existing Gmail account, Google Cloud Always-Free tier (e2-micro VM in a US region, with 1 GB egress/month included). Overage on egress is metered at ~$0.12/GB; budget alerts ensure no surprise bills.
- **Reliable review-request emails** with sophisticated suppression logic so customers are asked at the right moment and never spammed.
- **Visual integration with the current legacy theme** (Trademark 1.7.3) without tight coupling to it — the widget must survive a future theme redesign without rework.
- **Maintainable by an owner with basic coding skills** (Python, SQL, HTML — no fluency in any language). Favor convention, boring code, clear naming. No clever abstractions.
- **Forward-compatible with v2 features** — photos, Q&A, merchant replies, analytics — without schema rewrites.
- **Forward-compatible with multi-tenancy** — if the project ever serves more than one store, retrofit should be additive, not a rewrite.

### Non-Goals (explicitly out of scope)

- Photo uploads in reviews (data model accommodates; do not implement now).
- Customer Q&A on products (data model accommodates; do not implement now).
- Merchant replies surfaced in admin UI (column exists; admin route stubbed for v2).
- Analytics dashboard (data accumulates; dashboard is v2).
- Multi-store support (single-tenant by design today).
- Shopify App Store listing or distribution beyond this single store.
- OAuth installation flow (we use a static Admin API token instead — see §5).
- Shopify embedded admin via App Bridge (we use a separate password-protected admin URL).
- Self-hosted email server (deliverability is hostile; we use Gmail SMTP via the brand's existing alias).
- Any feature beyond what this document specifies. Do not extend the surface speculatively.

---

## 3. Decision-Making Values

When you face a judgment call this document doesn't explicitly cover, apply these in priority order:

1. **The customer email experience is sacred.** Never send a review request that could be perceived as spam. The suppression logic in the dispatcher (see §10) is the most sensitive surface in the system. New email pathways must check all suppression rules. When in doubt, send fewer emails, not more.

2. **Self-host where reasonable.** This is a values choice, not just an economic one — the owner prefers ownership, control, and ISP-resident infrastructure. Default to running on owned hardware. Use third parties only when the alternative is materially worse (Gmail for SMTP deliverability is the canonical example; running our own SMTP is a deliverability nightmare we explicitly rejected).

3. **Boring code wins.** The owner has basic skills and will maintain this for years. Prefer the obvious solution over the elegant one. Prefer named functions over chains of higher-order operations. Prefer plain SQL strings over ORM abstractions. Prefer one file with three similar functions over a clever generic abstraction. Three-line repetition is fine; premature DRY is not.

4. **Don't add unrequested features.** A bug fix doesn't need surrounding cleanup. A one-shot operation doesn't need a helper. Don't design for hypothetical future requirements that are not in this plan. If you find yourself building a configuration knob "just in case," delete it.

5. **Trust the boundaries you've validated.** Validate at system boundaries (user input, Shopify webhooks, email-link tokens). Internally, trust your own code. Do not add error handling for scenarios that cannot happen — `assert`-style guards make code worse, not better.

6. **Comments explain *why*, not *what*.** Default to writing no comments. Add a comment only when the WHY is genuinely non-obvious (a hidden constraint, a workaround for a specific upstream bug). Never restate what the code already says.

7. **Privacy-respecting by default.** No third-party trackers in the storefront widget. No analytics SDKs. No data shipped to vendors that don't strictly need it. The widget calls our backend only.

8. **Future-proof against the theme.** The widget should survive a theme migration (the brand plans to redesign within ~12 months). Do not couple the widget to Trademark 1.7.3's CSS classes. Use `currentColor`, `inherit`, and theme CSS custom properties.

9. **Forward-compat the schema, not the code.** Keep `review_media`, `questions`, `merchant_reply` columns from day one. Don't write code paths that exercise them yet — but the data model accommodates them so v2 doesn't require migrations.

10. **Prefer reversibility.** Before destructive actions (DB resets, theme code edits, DNS changes), ensure there's a backup or a duplicate. The Yotpo cleanup plan starts with "duplicate the theme" for exactly this reason.

---

## 4. Working with the User

The owner is a co-owner of the brand, not an engineer. Adapt accordingly.

### Profile

- Coding background: basic (simple Python, SQL, HTML). Not fluent in any language.
- Home-lab operator: comfortable with Docker, Portainer, Tailscale.
- Strong product instincts: thinks carefully about the user-facing experience (especially email cadence) and will catch product-thinking gaps you may overlook.
- Strategic thinker about vendor decisions and long-term maintenance.

### Communication Rules (these are firm)

1. **Never use the AskUserQuestion tool.** Ask clarifying questions in plain prose, embedded in your response. The owner finds multi-choice option boxes restrictive and counter to the back-and-forth they prefer. This applies in all modes, including plan mode — direct user feedback overrides default workflow rules.

2. **Explain platform features in plain language before relying on their proper names.** When introducing tooling jargon (Shopify App Proxy, Tailscale, Docker Compose concepts, etc.), give a one-line everyday-terms description first. The owner will push back on jargon-dense responses.

3. **When you have a clear best answer, lead with the decision.** Don't enumerate alternatives you've already rejected unless the owner explicitly asks for a comparison or the tradeoff is genuinely open. Walking through rejected options reads as filler when the recommendation is unambiguous.

4. **Be willing to walk through process steps live.** Yotpo cleanup, Shopify admin configuration, theme code edits, DNS setup — the owner expects to do these together with step-by-step guidance, not be handed a checklist and wished good luck.

5. **Match scope to the request.** A simple question gets a direct answer. A design question gets a substantive answer. Don't over-explain trivial things; don't under-explain consequential ones.

---

## 5. Architecture Overview

One Node.js application, deployed as a Docker stack on **Mercury** (the brand's home-lab mini-PC), exposed to the public internet via a tiny **Google Cloud Always-Free e2-micro VM** running Caddy. The relay terminates HTTPS at `reviews.<brand-domain>` and proxies traffic to Mercury over Tailscale. Storefront integration is a single `<script>` tag plus placeholder `<div>` in the legacy theme.

```
   Customer browser ───► reviews.brandname.com  (Squarespace A record → GCP public IP)
                                  │
                                  ▼
            ┌──────────────────────────────────────────────────┐
            │   Google Cloud e2-micro VM (Ubuntu 24.04)        │
            │   ─ Caddy: HTTPS termination + Let's Encrypt     │
            │   ─ Tailscale: joined to brand tailnet           │
            │   ─ Reverse-proxies to mercury:8070 (prod) or    │
            │                       mercury:8071 (dev)         │
            └──────────────────────┬───────────────────────────┘
                                   │ Tailscale (encrypted overlay,
                                   │ no inbound ports on home network)
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │              Mercury (Ubuntu 24.04 + Docker)           │
       │   /opt/stacks/shopify-reviews-{dev,prod}/              │
       │                                                        │
       │   ┌──────────────────────────────┐                     │
       │   │ reviews-app (Node/Hono)      │                     │
       │   │  - Admin UI  (/admin)        │                     │
       │   │  - Storefront API (/api)     │                     │
       │   │  - Webhooks (/webhooks)      │                     │
       │   │  - Widget JS (/widget.js)    │                     │
       │   │  - node-cron scheduler       │                     │
       │   │  bound to Tailscale IP only  │                     │
       │   └────────┬─────────────────────┘                     │
       │            │ volume mount                              │
       │   ┌────────▼─────────┐                                 │
       │   │ /data/reviews.db │ ──► nightly rsync ──► Pebbles   │
       │   │   (SQLite file)  │     (/opt/backups/shopify-      │
       │   └──────────────────┘      reviews/)                  │
       └────────────────────────────────────────────────────────┘

      Outbound mail → smtp.gmail.com (existing brand alias)
      Inbound webhooks ← Shopify (via GCP relay → Mercury)
      Widget reads     ← customer browsers (via GCP relay → Mercury)
```

### Key technical choices

- **Hono** (Node web framework) — small, well-documented, Express-like API. Tiny mental model.
- **better-sqlite3** — synchronous SQLite client. Easiest possible DB interface in Node.
- **nodemailer** — standard library for SMTP.
- **node-cron** — in-process cron scheduler.
- **esbuild** — single-config-file bundler for the storefront widget JS.
- **Docker Compose** — matches the existing `/opt/stacks/[service]/` pattern on Mercury.
- **Google Cloud e2-micro (Always Free) + Caddy + Tailscale** for public ingress. Replaces the originally-planned Cloudflare Tunnel (Cloudflare's free tier no longer permits subdomain zones, and migrating brandname.com's DNS wholesale was too risky for a live storefront). Oracle Cloud was attempted first but its UI failed to populate the platform-image catalog. The relay model isolates all public traffic to a separate machine; Mercury never opens a port to the internet. The 1 GB/month egress ceiling is comfortable for typical small-brand traffic; overage is metered at $0.12/GB with billing alerts as the safety net.
- **Static Shopify Admin API token** (no OAuth) — single-store custom apps don't need OAuth. Token is generated once in Shopify admin and stored in the app's `.env`.
- **Password-protected admin UI** at `reviews.<brand-domain>/admin` — no Shopify embedded admin, no App Bridge, no session-token JWTs. The admin is a plain server-rendered HTML interface accessed in any browser tab.
- **Direct CORS-allowed storefront API** — not Shopify App Proxy. The widget JS calls our backend directly from the storefront origin. App Proxy is unavailable to single-store custom apps anyway.

### Explicitly avoided

Remix, Next.js, Drizzle, Prisma, React for admin UI, OAuth flow, Shopify App Bridge, Shopify Theme App Extensions, Cloudflare Workers, D1, transactional email services (Resend/SES), self-hosted SMTP, full Cloudflare DNS migration, opening inbound ports on the home network. Each was considered; each was rejected.

---

## 6. Development & Deployment Workflow

**This project uses a remote-execution development model. Read this section carefully.**

### The development machine

Code is **written** on the Windows desktop at `D:\AI\shopify-reviews\`. The local machine is for editing files, running typecheck (`npm run typecheck`), and reviewing diffs. **It is not used for running the application.**

Do not assume the application can be tested locally with `npm run dev` or `docker compose up`. The owner does not want to install Docker on Windows for this project, and several runtime dependencies (Tailscale-routed backups, GCP relay HTTPS, Gmail SMTP from a server identity) are easier to validate in the actual deployment environment.

### The execution machine — Mercury

All running of the application — both for **testing** and for **production deployment** — happens on **Mercury**, the brand's primary home-lab mini-PC.

- Hostname/Tailscale IP: `100.117.6.18`
- OS: Ubuntu Server 24.04 LTS
- Docker + Portainer-based service management
- Stack convention: `/opt/stacks/[service]/docker-compose.yml`
- Reach Mercury via SSH over Tailscale (the dev machine must have Tailscale running and authenticated to the same tailnet).

### Code transit: local → Mercury

The recommended path is **Gitea** (the self-hosted Git server already running on Mercury at port 3000):

1. Develop locally; commit to a Git repo.
2. Push to a private Gitea repository on Mercury.
3. SSH into Mercury, `git pull` in `/opt/stacks/shopify-reviews/`, then `docker compose up -d --build`.

Alternative paths (if the owner prefers): rsync over Tailscale, or a shared filesystem mount. Confirm with the owner which path they want to use; do not assume.

### Two parallel deployments — dev and prod

To test against a Shopify development store without endangering the live brand store, run **two parallel Docker stacks on Mercury**:

- `/opt/stacks/shopify-reviews-dev/` — points at a free Shopify development store (the owner will create one via Shopify Partners during step 12). Public hostname: `reviews-dev.brandname.com`.
- `/opt/stacks/shopify-reviews/` — points at the live brand store. Public hostname: `reviews.brandname.com`.

Each stack has its own `.env` with its own Shopify token, webhook secret, and host port (8070 prod, 8071 dev). The application code is identical between the two; the GCP relay's Caddy config maps each public hostname to the right port on Mercury. (The reviews app originally used 8080/8081, but a media downloader on Mercury was already squatting on 8080, so the reviews stacks moved to 8070/8071. Mercury's port convention now: reviews uses 80xx, affiliates uses 90xx, even = prod, odd = dev.)

### The development loop

1. Edit code locally.
2. Run `npm run typecheck` locally to catch type errors fast.
3. Commit and push to Gitea.
4. SSH to Mercury → pull → `docker compose -f /opt/stacks/shopify-reviews-dev/docker-compose.yml up -d --build`.
5. Hit `https://reviews-dev.brandname.com/health` to verify the deploy.
6. Test the change against the dev Shopify store (place test orders, mark fulfilled, etc.).
7. Once verified on dev, repeat for the prod stack on Mercury.

**Never deploy directly to the prod stack without first validating on dev.**

### Local development conveniences

- `npm run typecheck` — type check without emitting JS. Run before every commit.
- `npm run build` — compile to `dist/` and copy non-TS assets (migrations, email templates). Useful to verify the build passes locally before pushing.
- `npm run dev` — runs `tsx watch src/index.ts` locally with hot reload. **This will fail without a working `.env` file pointing at a live Shopify store**, so it's of limited use unless you set up a local-dev `.env`. In practice, prefer pushing to Mercury for any actual exercise of the code.

---

## 7. Implementation Plan

The build is sequenced so each step has something testable on its own. Do not skip ahead. Each step ends with a verification gate.

### Step 1 — Scaffolding ✅ (already complete; see §14)

`package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.dockerignore`, `src/index.ts` (Hono hello-world), `src/config.ts`, `src/lib/logger.ts`.

Verification gate: `npm run typecheck && npm run build`, then on Mercury `docker compose up -d --build` and `curl https://reviews-dev.brandname.com/health` returns `{"status":"ok"}`.

### Step 2 — Database layer (partially scaffolded; see §14)

Files involved:
- `src/db/migrations/001_initial.sql` — full schema (see §8)
- `src/db/client.ts` — `getDb()`, `closeDb()`, `migrate()` using better-sqlite3
- `src/db/queries.ts` — named query functions; will grow as features are added
- `scripts/copy-assets.mjs` — copies `src/db/migrations/*.sql` to `dist/db/migrations/` during build

Verification gate: server boots on Mercury, `migrate()` runs, `_migrations` table exists with `001_initial.sql` recorded, all schema tables present.

### Step 3 — Shopify Admin API client

Files:
- `src/shopify/admin-client.ts` — GraphQL client using `fetch` and the static Admin API token. One function: `shopifyAdmin<T>(query, variables): Promise<T>`. No need to wrap REST; GraphQL covers everything we need.
- `src/shopify/types.ts` — minimal types for the entities we read (Product, Customer, Order, Fulfillment).
- `src/shopify/webhook-verify.ts` — HMAC SHA256 verification of Shopify webhook signatures.
- `src/lib/hmac.ts` — generic HMAC helpers used by webhook verification and email-link token signing.

The Admin client must include the access token in `X-Shopify-Access-Token` header on every request. The API version is read from `config.shopify.apiVersion` (default `2026-01`).

Verification gate: from a Mercury shell inside the running container, `node -e "import('./dist/shopify/admin-client.js').then(m => m.shopifyAdmin('{ shop { name } }').then(console.log))"` returns the brand's shop name.

### Step 4 — Webhook receivers

Files:
- `src/routes/webhooks.ts` — Hono router with the webhook endpoints
- The webhook routes mounted in `src/index.ts`

Endpoints (all POST, all HMAC-verified):

- `/webhooks/orders/paid` — upsert customer, insert `purchases` rows for each line item with `due_at = NULL`
- `/webhooks/orders/fulfilled` — set `fulfilled_at = now`, `due_at = now + (request_delay_days * 86400)` for matching purchases
- `/webhooks/customers/data_request` — log; respond per Shopify's required behavior (deferred full impl to step 10)
- `/webhooks/customers/redact` — stub for step 10
- `/webhooks/shop/redact` — stub for step 10

HMAC verification middleware reads the raw request body (Hono's body cache), computes `HMAC-SHA256(body, webhookSecret)`, base64-encodes, and constant-time compares to the `X-Shopify-Hmac-Sha256` header. **Reject any request with a missing or invalid signature with HTTP 401 — do not log the body.**

Webhook subscriptions are created at install time by calling Shopify's GraphQL API (`webhookSubscriptionCreate`) — write a one-time setup script `scripts/install-webhooks.ts` runnable via `npm run install-webhooks`.

Verification gate: place a test order in the Shopify dev store admin; observe a `_webhook_received` log entry on Mercury and a row appear in `purchases` table. Trigger an HMAC failure (modify a header) and observe a 401.

### Step 5 — Initial backfill script

Files:
- `src/shopify/sync.ts` — `backfillRecentOrders(daysBack: number = 90)`. Pages through the GraphQL `orders` connection with a `created_at:>=...` filter, upserts customers, inserts purchases, marks fulfilled ones with `due_at` set per the cadence rules.
- `scripts/backfill.ts` — CLI entry: `npm run backfill -- --days 90`

The backfill is idempotent — running it twice produces the same result. Reasoning: SQL upserts are keyed on `(shopify_order_id, shopify_product_id)` for purchases and `email` for customers.

Verification gate: run on Mercury against the dev store, count rows: `customers`, `purchases`. Compare to a manual Shopify admin query of recent orders. Numbers should match.

### Step 6 — Email pipeline

Files:
- `src/email/smtp-client.ts` — nodemailer transport configured from `config.email.smtp`. One function: `sendMail({ to, subject, html, text })`.
- `src/email/tokens.ts` — `signReviewToken(payload)`, `verifyReviewToken(token)`, `signUnsubscribeToken(payload)`, `verifyUnsubscribeToken(token)`. HMAC-SHA256 over JSON payloads with expiry. Tokens are URL-safe base64.
- `src/email/render.ts` — minimal template rendering (string substitution `{{variable}}` from a context object). No template engine.
- `src/email/templates/request-first.html` — first-time customer template
- `src/email/templates/request-repeat.html` — repeat-customer template (different copy)
- `src/scheduler/dispatcher.ts` — the daily review-request dispatcher. Implements the SQL query in §10 verbatim; iterates results; sends emails; updates state. Single transaction per email attempt.
- `src/scheduler/cron.ts` — registers `node-cron` schedule (`0 14 * * *` — 14:00 UTC daily). Imported at startup from `src/index.ts`.
- Update `scripts/copy-assets.mjs` to also copy `src/email/templates` to `dist/email/templates`.

Add deps: `nodemailer`, `node-cron`, plus `@types/nodemailer` and `@types/node-cron` in devDependencies. Add `bcrypt` for the admin password hash check (used in step 9).

The dispatcher must be **manually triggerable** for testing: expose `npm run dispatch -- --once` that runs one pass and exits.

Verification gate: on Mercury dev stack, set a fulfilled-order's `due_at` to now (manually via SQL), run `npm run dispatch -- --once`, confirm:
- An email arrives at the test address with `From: reviews@brandname.com`
- `purchases.request_count` incremented
- `customers.last_request_sent_at` set
- `email_events` row inserted

### Step 7 — Storefront API

Files:
- `src/routes/api.ts` — Hono router with the storefront endpoints

Endpoints:
- `GET /api/products/:productId/reviews?page=N&size=20` — list published reviews + aggregate `{avg, count}`. CORS headers allow `STOREFRONT_ORIGIN`.
- `GET /api/products/:productId/aggregate` — `{avg, count}` only, used by collection cards.
- `POST /api/reviews/submit` — submit review with signed token from email link. Verify token, look up purchase, insert review with `verified_purchase = 1` if customer matches, set `purchases.reviewed_at`.

Mount the router at `/api` in `src/index.ts`. CORS middleware applies only to this prefix.

Verification gate: from a separate machine, `curl https://reviews-dev.brandname.com/api/products/<dev-store-product-id>/reviews` returns `{reviews: [], aggregate: {avg: null, count: 0}}` with the right CORS headers.

### Step 8 — Storefront widget

Files:
- `src/widget/widget.ts` — vanilla TypeScript, no framework. Reads `data-product-id` and `data-reviews-widget` mode from each placeholder `<div>` on the page. Calls `/api/...` and renders inline.
- `src/widget/widget.css` — uses `currentColor`, `inherit`, and theme CSS custom properties for visual integration. One overridable accent via `--reviews-star-color`.
- `esbuild.config.mjs` — builds `src/widget/widget.ts` to `public/widget.js` (single file, IIFE format, minified). Also copies `src/widget/widget.css` to `public/widget.css`.
- `src/routes/widget.ts` — serves `/widget.js` and `/widget.css` with long cache headers. Also serves `/r/:token` — the review-submission landing page (token-gated form).

Update `package.json`:
- `"build": "tsc && node esbuild.config.mjs && node scripts/copy-assets.mjs"`

Two display modes:
- `data-reviews-widget="full"` — full reviews list + aggregate stars + "Write a review" link (token-gated, only shows if user has an unreviewed purchase token in the URL hash). For product pages.
- `data-reviews-widget="aggregate"` — stars + count only, links to product page. For collection cards.

Verification gate: serve the widget locally; embed in a one-off test HTML page; confirm rendering against a dev-store product. Then verify `https://reviews-dev.brandname.com/widget.js` loads correctly with caching headers.

### Step 9 — Admin UI

Files:
- `src/routes/admin.ts` — server-rendered HTML routes (no React, no SPA)
- `src/lib/auth.ts` — admin password verification (`bcrypt.compare`) and signed session cookie

Pages:
- `GET /admin` — login form
- `POST /admin/login` — set session cookie on success
- `GET /admin/dashboard` — recent reviews, send-rate stats, pending moderation count
- `GET /admin/reviews?status=...` — list with moderation actions
- `POST /admin/reviews/:id/status` — publish / reject / hide
- `POST /admin/reviews/:id/reply` — set merchant reply (UI plumbing for v2; column already exists)
- `GET /admin/customers/:email` — view + manage opt-outs
- `GET /admin/settings` / `POST /admin/settings` — cadence config (`cadence_max_requests`, `cadence_min_days_between`, `request_delay_days`, `cadence_dispatcher_batch`)
- `POST /admin/sync` — trigger manual full Shopify backfill

Use plain HTML with inline `<style>` blocks. No external CSS files for admin. No JavaScript except minimal form-confirmation handlers if needed. The admin is for the owner; aesthetic polish is not a goal.

Verification gate: log in successfully, see dashboard, moderate a review, change a setting, log out.

### Step 10 — GDPR webhook handlers

Three Shopify-mandated webhooks must respond correctly or Shopify will eventually disable the app:

- `customers/data_request` — log the request, return 200. No automatic data export needed for our scale; the owner handles requests manually.
- `customers/redact` — anonymize the customer record (set email/name to deterministic hash, drop `shopify_customer_id`). Anonymize their reviews (set `reviewer_email` and `reviewer_name`).
- `shop/redact` — wipe the entire database (this fires only if the app is uninstalled and 48 hours pass). Acceptable for our single-store self-hosted use; the brand controls the only install.

Verification gate: trigger each via Shopify's webhook test tool in admin; verify behaviors.

### Step 11 — Backup script

Files:
- `scripts/backup.sh` — bash script: SQLite snapshot via `sqlite3 reviews.db ".backup /data/snapshots/reviews-$(date).db"`, then `rsync` to Pebbles via Tailscale.

Add to `docker-compose.yml`:

```yaml
backup:
  image: alpine:latest
  container_name: reviews-backup
  restart: unless-stopped
  volumes:
    - ./data:/data:ro
    - ./scripts:/scripts:ro
    - /root/.ssh:/root/.ssh:ro      # SSH key on Mercury for Pebbles access
  command: sh -c "apk add --no-cache rsync openssh-client sqlite tzdata && crond -f -d 8"
  environment:
    TZ: America/New_York
```

Cron entry inside the container (set up at first run): `0 3 * * * /scripts/backup.sh`. Snapshot rotates: keep 7 daily, 4 weekly. Pebbles target: `/opt/backups/shopify-reviews/`.

Verification gate: on Mercury dev stack, `docker compose exec backup /scripts/backup.sh`. Confirm a snapshot file appears in `/opt/backups/shopify-reviews/` on Pebbles.

### Step 12 — Public ingress via Google Cloud relay (Caddy + Tailscale)

Replaces the originally-planned Cloudflare Tunnel. Performed via Google Cloud, Squarespace DNS, and SSH — no application code changes. Full step-by-step instructions for the owner are in [external-accounts-setup.md](external-accounts-setup.md), Part 3. Summary:

1. Owner signs up for Google Cloud (free trial credits + Always-Free e2-micro tier), creates a project, and sets up billing budget alerts before provisioning anything.
2. Create an `e2-micro` VM in `us-east1`/`us-central1`/`us-west1` (the only always-free regions) running Ubuntu 24.04 LTS. Check both "Allow HTTP traffic" and "Allow HTTPS traffic" during creation to populate the GCP firewall rules. Promote the ephemeral external IP to static.
3. Install Tailscale on the relay VM and join it to the brand tailnet so it can reach Mercury privately.
4. Install Caddy. Configure `/etc/caddy/Caddyfile` with two server blocks:
   ```
   reviews-dev.brandname.com { reverse_proxy 100.117.6.18:8071 }
   reviews.brandname.com     { reverse_proxy 100.117.6.18:8070 }
   ```
   (Substitute Mercury's actual Tailscale IP.) Caddy auto-issues Let's Encrypt certs on first request.
5. At Squarespace → DNS, add **two A records**: host `reviews` → GCP static IP, host `reviews-dev` → same GCP static IP. Apex zone otherwise untouched. Set TTL to 5 minutes if Squarespace allows it, so any future migration propagates fast.
6. On Mercury, each `docker-compose.yml` (dev and prod) binds the app's port to the Tailscale interface only via `${HOST_BIND_IP}:${HOST_PORT}:8080`. Prod uses host port 8070; dev uses 8071. (The container's *internal* port stays 8080 — that's the app's listener inside the container — only the host-side mapping changed.)

Verification gate: `curl https://reviews-dev.brandname.com/health` from any internet-connected machine returns `{"status":"ok"}` once the dev stack is deployed. Before that point, Caddy will return 502 (which still confirms the ingress chain is working).

### Step 13 — Yotpo cleanup (live store)

Walk through with the owner; do not perform autonomously.

1. **Backup the theme.** Shopify Admin → Online Store → Themes → ⋯ → Duplicate. This creates a restore point.
2. **Edit Code → search for `yotpo` and `staticw2` (case-insensitive) across all files.** Common locations:
   - `layout/theme.liquid` — script tag
   - `templates/product.liquid` — `{% include 'yotpo' %}` or hardcoded widget div
   - `snippets/yotpo.liquid` — delete file if exists
   - `assets/yotpo.js`, `assets/yotpo.css` — delete files if exist
3. **Uninstall Yotpo app** if still listed in Apps. Triggers Shopify to clean any Script Tags Yotpo registered via the Script Tag API (these don't appear in theme code).
4. **Delete stale metafields.** Settings → Custom data → Products → Metafield definitions → look for `yotpo` namespace → delete. Shopify purges associated values across all products. (This is what's still rendering "7 reviews / 5 stars" on the live site.)
5. **Preview the cleaned theme.** Verify no console errors, no visual remnants.
6. **Publish.**

### Step 14 — Theme integration (live store)

Two one-time edits via Shopify Admin → Online Store → Themes → ⋯ → Edit Code:

- **`layout/theme.liquid`** — add immediately before `</head>`:
  ```liquid
  <script src="https://reviews.brandname.com/widget.js" defer></script>
  ```
- **`templates/product.liquid`** — add wherever reviews should render (typically below the product description / above related products):
  ```liquid
  <div data-reviews-widget="full" data-product-id="{{ product.id }}"></div>
  ```
- **Collection cards** — add to the relevant product-card snippet (in Trademark, often `snippets/product-grid-item.liquid` or similar; identify with the owner):
  ```liquid
  <div data-reviews-widget="aggregate" data-product-id="{{ product.id }}"></div>
  ```

Verification gate: visit a product page on the live store; widget renders; aggregate matches a manually-counted set of test reviews.

---

## 8. Database Schema

Single-tenant. SQLite. Located at `/data/reviews.db` inside the container, mounted from `./data/reviews.db` on the host.

```sql
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_customer_id TEXT,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  global_opt_out INTEGER NOT NULL DEFAULT 0,
  unanswered_request_count INTEGER NOT NULL DEFAULT 0,
  last_request_sent_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE products_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL,
  title TEXT NOT NULL,
  featured_image_url TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  shopify_order_id TEXT NOT NULL,
  shopify_product_id TEXT NOT NULL,
  fulfilled_at INTEGER,
  due_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER,
  reviewed_at INTEGER,
  product_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(shopify_order_id, shopify_product_id)
);
CREATE INDEX idx_purchases_due ON purchases(due_at)
  WHERE reviewed_at IS NULL AND product_opt_out = 0;

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id),
  reviewer_email TEXT NOT NULL,
  reviewer_name TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT NOT NULL,
  verified_purchase INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',  -- pending|published|rejected
  merchant_reply TEXT,
  merchant_reply_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_product ON reviews(shopify_product_id, status);

CREATE TABLE review_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'image',
  storage_key TEXT NOT NULL,
  width INTEGER, height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  purchase_id INTEGER REFERENCES purchases(id),
  kind TEXT NOT NULL,  -- request_sent|opened|clicked|bounced|unsubscribed|review_submitted
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_events_customer ON email_events(customer_id, kind);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_product_id TEXT NOT NULL,
  asker_email TEXT,
  body TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('cadence_max_requests',       '3'),
  ('cadence_min_days_between',   '7'),
  ('request_delay_days',         '7'),
  ('cadence_dispatcher_batch',   '100'),
  ('shop_brand_json',            '{}');
```

Aggregate rating is computed on read (`SELECT AVG(rating), COUNT(*) FROM reviews WHERE status='published' AND shopify_product_id=?`). At this scale, no materialized counter is needed.

---

## 9. API Surface

All routes served from `https://reviews.<brand-domain>`:

### Storefront API (CORS allowing `STOREFRONT_ORIGIN`)
- `GET  /api/products/:productId/reviews?page=N&size=20` — list published reviews + aggregate
- `GET  /api/products/:productId/aggregate` — `{avg, count}` only
- `POST /api/reviews/submit` — submit review with signed token

### Public utility
- `GET /widget.js` — bundled storefront widget (long cache)
- `GET /widget.css`
- `GET /r/:token` — review-submission landing page (token-gated)
- `GET /unsubscribe?token=...` — global opt-out (signed token)
- `GET /unsubscribe/product?token=...` — per-purchase opt-out

### Webhooks (Shopify HMAC-verified)
- `POST /webhooks/orders/paid`
- `POST /webhooks/orders/fulfilled`
- `POST /webhooks/customers/data_request` ← GDPR mandatory
- `POST /webhooks/customers/redact`        ← GDPR mandatory
- `POST /webhooks/shop/redact`             ← GDPR mandatory

### Admin (password-protected, server-rendered HTML)
- `GET  /admin`                       — login
- `POST /admin/login`
- `GET  /admin/dashboard`
- `GET  /admin/reviews`
- `POST /admin/reviews/:id/status`
- `POST /admin/reviews/:id/reply`
- `GET  /admin/customers/:email`
- `GET  /admin/settings`
- `POST /admin/settings`
- `POST /admin/sync`

---

## 10. Email Cadence Logic

The dispatcher's eligibility query expresses every suppression rule. **All future suppression rules go in this query as additional `AND` clauses** — do not implement them imperatively in TypeScript.

```sql
SELECT p.*, c.*
FROM purchases p
JOIN customers c ON c.id = p.customer_id
WHERE p.due_at IS NOT NULL
  AND p.due_at <= unixepoch()
  AND p.reviewed_at IS NULL
  AND p.product_opt_out = 0
  AND c.global_opt_out = 0
  AND p.request_count < CAST((SELECT value FROM settings WHERE key='cadence_max_requests') AS INTEGER)
  AND (c.last_request_sent_at IS NULL
       OR c.last_request_sent_at < unixepoch()
          - CAST((SELECT value FROM settings WHERE key='cadence_min_days_between') AS INTEGER) * 86400)
  AND NOT EXISTS (
    SELECT 1 FROM reviews r
    WHERE r.customer_id = c.id
      AND r.shopify_product_id = p.shopify_product_id
  )
LIMIT (SELECT CAST(value AS INTEGER) FROM settings WHERE key='cadence_dispatcher_batch');
```

The per-run cap (`cadence_dispatcher_batch`) defaults to 100 and is configurable via the admin settings page. It's a defensive guard against runaway-bug scenarios and Gmail deliverability spikes — Gmail's free-tier sending ceiling is around 500/day, so the cap should always stay comfortably below that. Raise it as the brand grows.

**Go-live guard (`request_cutoff_at`).** The eligibility query carries one more clause: `AND p.fulfilled_at >= (SELECT value FROM settings WHERE key='request_cutoff_at')`. The setting is a unix timestamp; `0` (the dev default) disables the guard so the whole imported history is eligible. Its purpose is the live-launch flood problem: a live store has years of fulfilled orders, and the backfill arms each fulfilled order with a past `due_at`, so without this guard the first dispatcher run would email every historical customer. At launch the owner sets the cutoff to "now" (Settings → Cadence → **Go-live guard**, "Set cutoff to now"), so only orders fulfilled from launch onward are ever auto-requested; the store's handful of pre-existing customers are reached out to manually (and excluded naturally by the `NOT EXISTS reviews` clause once they've reviewed). Defense-in-depth: the backfill *also* leaves pre-cutoff fulfillments un-armed (`due_at` NULL) so they're captured for reference but never queued — meaning the guard holds regardless of the order in which the owner backfills vs. sets the cutoff. New fulfillments arriving via the `orders/fulfilled` webhook are always stamped with the current time, so they're always post-cutoff and need no special handling.

For each row returned:

1. Pick template: `repeat` if `EXISTS (SELECT 1 FROM reviews WHERE customer_id = c.id)`, else `first`.
2. Generate review-link signed token: `HMAC-SHA256({purchase_id, customer_id, exp: now+60d}, EMAIL_TOKEN_SECRET)`.
3. Generate unsubscribe token (separate signing).
4. Render template with brand colors from `settings.shop_brand_json`.
5. `nodemailer.sendMail({...})` via Gmail SMTP.
6. On success (in a single DB transaction):
   - Increment `purchases.request_count`
   - Increment `customers.unanswered_request_count`
   - Set `purchases.last_request_at = now`, `customers.last_request_sent_at = now`
   - Advance `purchases.due_at` by `cadence_min_days_between` days, OR null it if `request_count >= cadence_max_requests`
   - Insert `email_events` row with `kind='request_sent'`
7. On failure: log to `email_events` with `kind='bounced'` (or similar), do not advance counters.

When a review is submitted, the submission handler must:
- Set `purchases.reviewed_at = now` (permanent stop signal for that purchase)
- Set `customers.unanswered_request_count = 0` (acknowledged engagement)
- Insert `email_events` with `kind='review_submitted'`

When a customer clicks unsubscribe:
- Global: `customers.global_opt_out = 1`. Insert `email_events` with `kind='unsubscribed'`.
- Per-product: `purchases.product_opt_out = 1`. Insert `email_events` with `kind='unsubscribed'` and metadata.

---

## 11. Theme Integration & Yotpo Cleanup

See §7 step 13 (cleanup) and step 14 (integration).

The **storefront widget design philosophy** is: drop-in compatible with any theme, modern or legacy. Achieved by:
- A single `<script>` tag (no theme app extension required)
- Placeholder `<div>` with data attributes (no theme-specific markup)
- CSS that uses `currentColor`, `inherit`, and theme CSS custom properties
- One overridable `--reviews-star-color` for explicit accent control

When the brand redesigns to a modern (Online Store 2.0) theme later, the same widget continues to work — move the same one-line `<div>` into the new theme. An optional Online Store 2.0 App Block wrapper can be added then for drag-and-drop placement; the underlying widget JS does not change.

---

## 12. Verification Plan

Performed end-to-end on the **dev stack** before any changes touch the prod stack.

1. Owner creates a Shopify Partners account and a free development store.
2. Deploy the `shopify-reviews-dev` stack on Mercury, pointed at the dev store via a separate `.env`.
3. Create 2-3 test products on the dev store.
4. Place a test order with an email address you control.
5. Mark the order fulfilled in Shopify admin.
6. Verify a `purchases` row appears with the correct `due_at`.
7. Manually trigger the dispatcher: `docker exec reviews-app npm run dispatch -- --once`.
8. Confirm email receipt; click the review link; submit a review.
9. Visit a product page on the dev store; confirm the widget renders the new review.
10. Test suppression rules:
    - Re-attempt review on the same product → blocked
    - Click the unsubscribe link → verify global opt-out persists
    - Re-run dispatcher with opted-out customer → no email sent
    - Manually set `request_count` to max → re-run dispatcher → no email sent
11. Test webhook HMAC: replay a webhook with a tampered signature → 401, no DB write.
12. Only with all green: deploy to live store, run Yotpo cleanup, install widget tag.

---

## 13. Operational Context

### Hardware (home lab)

Two always-on Intel N100 mini-PCs running Ubuntu Server 24.04 LTS, each with 16GB DDR4 + 512GB SSD. Both use Docker + Portainer for service deployment, with stacks under `/opt/stacks/[service]/docker-compose.yml`.

- **Mercury** (Tailscale: `100.117.6.18`) — primary persistent-services host. Runs the reviews app. Light, steady load.
  - Existing services: Gitea (3000, SSH 2222), Prometheus (9090), Grafana (3001), Portainer (9443), Node Exporter (9100).
- **Pebbles** (Tailscale: `100.86.45.31`) — automation/AI/agent orchestration host. Receives reviews-app backups via rsync.
  - Existing services: Flowise, n8n, Qdrant, Open WebUI, Ollama, Portainer, Node Exporter.

### Network

Devices are on a Tailscale mesh. Neither was publicly exposed before this project. The reviews app introduces public-internet exposure via a **Google Cloud e2-micro (Always-Free) relay VM** that joins the same tailnet — Mercury and Pebbles continue to have zero inbound ports open to the internet.

### Domain

Brand domain (`brandname.com`) is held at **Squarespace**, which also hosts DNS. We add two A records — `reviews` and `reviews-dev` — pointing at the GCP relay's public IP. Nothing else about the apex zone changes. Squarespace stays the sole authoritative DNS for the brand domain.

### Email

Brand uses an existing Gmail account with a custom-domain alias (`reviews@brandname.com` forwarding to a Gmail address). The reviews app uses Gmail SMTP with the alias configured under "Send mail as" — so outbound emails appear from `reviews@brandname.com` while leveraging Google's deliverability reputation.

---

## 14. Current Build Status

### Step 1–14 (original implementation plan)

- **Step 1** ✅ Scaffolding (Hono server, Docker, build pipeline)
- **Step 2** ✅ Database layer ([src/db/client.ts](src/db/client.ts), [src/db/queries.ts](src/db/queries.ts), migrations up through `007_email_templates.sql`)
- **Step 3** ✅ Shopify Admin API client and webhook HMAC verification ([src/shopify/](src/shopify/), [src/lib/hmac.ts](src/lib/hmac.ts))
- **Step 4** ✅ Webhook receivers ([src/routes/webhooks.ts](src/routes/webhooks.ts)) + one-time installer ([src/scripts/install-webhooks.ts](src/scripts/install-webhooks.ts))
- **Step 5** ✅ Backfill ([src/shopify/sync.ts](src/shopify/sync.ts), [src/scripts/backfill.ts](src/scripts/backfill.ts))
- **Step 6** ✅ Email pipeline (SMTP client, signed tokens, templates, dispatcher, cron) under [src/email/](src/email/) and [src/scheduler/](src/scheduler/); manual trigger at [src/scripts/dispatch.ts](src/scripts/dispatch.ts)
- **Step 7** ✅ Storefront API ([src/routes/api.ts](src/routes/api.ts))
- **Step 8** ✅ Storefront widget bundle ([src/widget/](src/widget/)) + email-link review submission and unsubscribe pages ([src/routes/widget.ts](src/routes/widget.ts))
- **Step 9** ✅ Server-rendered admin UI ([src/routes/admin.ts](src/routes/admin.ts), [src/lib/auth.ts](src/lib/auth.ts))
- **Step 10** ✅ GDPR webhook handlers (folded into Step 4's `webhooks.ts`)
- **Step 11** ✅ Backup script ([scripts/backup.sh](scripts/backup.sh)) + sidecar service in `docker-compose.yml`
- **Step 12** ✅ Google Cloud relay (Caddy + Tailscale) — GCP e2-micro VM running, DNS A records at Squarespace, App Proxy configured on the dev store. See [external-accounts-setup.md](external-accounts-setup.md).
- **Step 13** ⏳ Yotpo cleanup on the **live** store (pending live-store deployment).
- **Step 14** ⏳ Theme integration on the **live** store (pending live-store deployment; dev-store theme integration done).

### Features built beyond the original plan

These were either added during the build as user-priority items or evolved from in-flight design conversations:

- **Sample invitations** — single-create form, CSV batch upload with template download, CSV export with mail-merge URLs; admin Branding/Invitations tab; "Verified Reviewer" badge to distinguish from purchase-verified reviews.
- **Per-variant + related reviews** — Shopify metafield `reviews.variant_handling = 'distinct'` per product; when set, reviews are filtered by variant on display and a "Customers also reviewed these variants" section surfaces sibling reviews.
- **Storefront-customer review submission via Shopify App Proxy** — logged-in customers submit and edit reviews directly from product pages through a modal dialog; HMAC-verified customer identity from Shopify; verified_kind set to 'purchase' when the customer has a prior purchase of the product, null otherwise.
- **Branding admin page** with Widget and Email tabs:
  - Widget tab: star color, CTA background/foreground, border radius, with full hex picker + 13-color preset palette + Shopify-default inheritance + live in-admin mockup that updates as you edit + click-to-edit on mockup elements
  - Email tab: shared email branding (logo, footer text, sender name, reply-to) + per-template editing (subject, body HTML, CTA enable/label, active flag) + "Preview in new tab" rendering with sample data
- **Email template architecture** — `email_templates` table with shared shell-wrapper pattern; supports any number of templates keyed by string identifiers; default templates seeded on first boot.
- **Multi-product email batching** — one email per (customer, order), with each product's CTA inline.
- **Suppression audit logging** — dispatcher emits per-run breakdown of why purchases were excluded (globalOptOut, productOptOut, maxRequestsHit, cadenceTooSoon, alreadyReviewed).
- **Re-subscribe with backlog clear** — admin re-subscribing a customer wipes their pending `due_at` values so they don't get a flood of backfill emails.
- **"Dispatch immediately on fulfillment" dev toggle** — for testing without waiting 14 days.
- **Dynamic-DOM-friendly widget** — MutationObserver picks up late-loading widget elements (related products, variant-change section re-renders, etc.), not just elements present at DOMContentLoaded.
- **Configurable dispatcher schedule** — admin sets daily run time in their local timezone via a 12-hour-format dropdown; system stores UTC.
- **Brand colors + logo → `shop_brand_json`** — primary/secondary colors and logo used as defaults for the widget, email, and the (future) admin "brand" theme. Three ways they get there, in order of how they're sourced:
  1. **Liquid relay (the live path).** `shop.brand` (colors, `logo`, etc.) is exposed in **Liquid** to every theme with no API token. The widget snippet carries `data-brand-primary-bg`/`-fg`, `-secondary-*`, and `data-brand-logo` (rendered by `{{ shop.brand.colors.primary[0].background }}`, `{{ shop.brand.logo | image_url }}`). The widget relays them once per visitor session to **`POST /proxy/brand`** (App-Proxy **HMAC-verified** — genuinely from the shop), which writes `shop_brand_json`. Logo is restricted to Shopify-CDN URLs (it becomes an email `<img src>`). The endpoint skips when the store has no brand data and no-ops when nothing changed, so page views don't churn the DB. This is how brand assets reach the backend **without Storefront API access**.
  2. **Manual entry** (`POST /admin/branding/brand-colors`, Branding → Widget) — the fallback for stores with no Shopify brand assets, or before the theme snippet is in place. The Liquid relay takes precedence when the store has brand data.
  3. **Storefront-API auto-sync (dormant).** The original design — `src/shopify/storefront-client.ts` + `fetchShopifyBrand` + `/admin/settings/sync-brand`. Unusable here because the Dev Dashboard doesn't expose Storefront API access (unauthenticated scopes) for this single-store custom app (`storefrontAccessTokenCreate` fails without one). Kept in place in case access ever opens up.

  **Required setup + gotchas (learned getting the relay working end-to-end — read before debugging a "brand colors aren't importing" report):**
  - **The brand data must be set in Shopify admin → Settings → Brand** (the *brand assets* page). This is a different place from the theme's color schemes (Customize → Colors) — colors set in theme schemes do **not** populate `shop.brand`. If `{{ shop.brand.colors.primary[0].background }}` renders empty in the theme, the brand assets simply aren't filled in.
  - **The App Proxy MUST be configured for the relay (and customer review submission) to work.** This was the actual blocker: the relay `POST /apps/reviews/brand` returned a **Shopify-side 404** because the App Proxy wasn't set up on the store. (Reading reviews still worked because that uses the public `/api/*` CORS path, not the proxy — so a broken/absent App Proxy is invisible until you exercise a proxy route.) Configure in dev.shopify.com → Reviews app → new version → **App Proxy**: subpath prefix `apps`, subpath `reviews`, Proxy URL `https://reviews-dev.teraclay.com/proxy/` (trailing slash). Release; existing installs pick it up without a reinstall. The same channel powers customer review submission/edit, so both light up together.
  - **Diagnosing where a relay 404 comes from:** `curl -i -X POST http://100.117.6.18:8071/proxy/brand` directly on Mercury. A `401 invalid_signature` means the *route exists and the backend is current* → the 404 is Shopify-side (App Proxy not routing). A `404` means the backend is missing the route (old code). NOTE the app binds to Mercury's **Tailscale IP**, not localhost — use `100.117.6.18:8071`, not `localhost:8071`.
  - **The `data-brand-logo` Liquid errors when no logo is set** — `{{ shop.brand.logo | image_url }}` throws "invalid url input" on a nil logo. Guard it: `{% if shop.brand.logo %}{{ shop.brand.logo | image_url: width: 400 }}{% endif %}`.
  - **Testing the relay:** it fires once per browser session (`sessionStorage['rv-brand-relayed']`) — clear that key to force a re-relay. And `widget.js` is served with `stale-while-revalidate=86400`, so browsers run the cached bundle for up to ~24h; use DevTools "Disable cache" + hard reload (or incognito *with* cache disabled) to guarantee the fresh bundle during dev.
  - The full documented widget `<div>` snippet (with all `data-brand-*` attributes) lives in the admin under **Branding → Email → App Proxy setup**.
- **Self-configuring widget bundle** — widget detects its API base at runtime from its own script src, so the same bundle works on dev and prod.
- **Native HTML5 dialog** for the storefront-customer review modal (focus trap, backdrop, mobile-responsive — all built-in).

### Admin & branding overhaul (later session — committed, deploy/validation gap noted below)

- **Chunk A moderation suite** — retract-with-reason + `moderation_events` audit log (migration 008), reports queue + `banned_reporters` (011), pause-reviews panic button + `panic_events` (010), uniqueness-excludes-rejected (009), profanity filter, configurable new-review notifications. (Was built in a prior session and uncommitted; secured this session.)
- **Admin theme system** — 10 presets (5 accents × light/dark) via CSS variables on the shell; chrome themed, semantic colors (status pills, error/success, star gold, danger, pause banner) left fixed. Picker in Settings → Appearance. Plus a **"Brand — from Shopify"** theme that applies the synced brand primary pair to header/accent over a neutral light base (no light/dark derivation by design).
- **Settings → sub-tabs** — Cadence / Notifications / Appearance / Setup (Moderation moved out, see below).
- **Dashboard drill-downs** — stat cards are links: review-status → filtered Reviews; email/customer stats → `/admin/activity?kind=…` lists (with a Product column); "Submitted" → Reviews filtered to last 30 days.
- **Reviews tab redesign** — filter by status/rating/product/reviewer/date, sortable columns, real product + variant names (variant titles cached via migration 012). **Moderation is now a sub-tab here** (profanity + panic), relocated from Settings; profanity wordlist is blur+Reveal.
- **Widget branding** — explicit background / text / button-label overrides with inherit-by-default + truthful live preview + "reset to Shopify defaults". A "Shopify brand" swatch row in each color field applies synced brand colors in one click.
- **Self-hosted logo upload** — PNG/JPG, 250 KB cap, served at `/uploads` (long cache, nosniff); sets the shared email logo URL.
- **Email template system** — trigger-based selection (migration 013) with a curated trigger registry + flat global variable registry; 4 seeded defaults (Review Request, Review Request Followup, Repeat Customer Review, Review Removed) + dormant Review Restored; moderation emails select by trigger. Editor: dropdown selector + unsaved-changes guard, per-template trigger picker, create/delete, constrained toolbar (bold/italic/heading/list/link) + insert-logo + insert-variable + raw-HTML toggle. No server-side HTML sanitizer (admin is a trusted boundary).
- **Profanity censor-on-write, store-both** (migration 014) — see §15 Chunk A item 2 for the full model; re-scan on wordlist save; curated default wordlist seeded once; comments persist (raw text stored).
- **Brand assets without Storefront API** — Liquid relay (`shop.brand` → widget `data-brand-*` attributes → HMAC `/proxy/brand` → `shop_brand_json`) + manual entry fallback. See §5 brand-colors note.

### Conventions adopted during build (deviations from earlier draft)

- **All persisted timestamps are unix seconds**, matching SQLite's `unixepoch()`. Helpers in [src/lib/time.ts](src/lib/time.ts). The earlier scaffold mixed `Date.now()` (ms) and `unixepoch()` (s); standardized on seconds.
- **Per-run dispatcher cap** is stored in `settings.cadence_dispatcher_batch` (default 100), not hardcoded in the SQL. Adjustable from the admin settings page.
- **Runtime CLI scripts** (install-webhooks, backfill, dispatch, install-shopify) live under [src/scripts/](src/scripts/) so they compile to `dist/scripts/` and run inside the container. Build-time scripts (esbuild config, copy-assets) stay in [scripts/](scripts/).
- **GDPR-mandatory webhook topics** (customers/data_request, customers/redact, shop/redact) are configured at the app-version level in dev.shopify.com, NOT subscribed via the GraphQL `webhookSubscriptionCreate` mutation. Shopify deprecated GraphQL-side subscription for these topics in late 2025.
- **Shopify static-token install flow was deprecated for merchant-owned stores effective 2026-01-01.** We use the new Dev Dashboard's OAuth-grant install via a one-shot helper script (`install-shopify.ts`) that captures the permanent Admin API token. Token prefix is `shpua_` (new format), not the legacy `shpat_`.
- **Product cache has a 1-hour TTL** in `products_cache.updated_at`; the manual "Refresh product cache" button on the Branding page flushes immediately for the impatient.

### What's left to ship before live-store launch

**Run the pre-deployment checklist in §17 before each of these steps that touches state.** Once the live store is collecting real reviews, "wipe and re-seed" stops being a valid recovery — the checklist is what prevents the same kind of avoidable failures we hit during dev.

1. Step 13 — Yotpo cleanup on the live brand store (theme code edits + metafield removal). Risky; walked through with owner, not autonomous.
2. Step 14 — widget integration on the live (Trademark 1.7.3) theme. Different file paths than the dev-store Dawn-derivative theme.
3. Install Reviews app on the live store (the dev.shopify.com Collaboration wrinkle — the live store is not currently in the Teraclay org).
4. Stand up `/opt/stacks/shopify-reviews/` prod stack on Mercury with fresh secrets, live store domain, and host port 8070.
5. DNS A record for `reviews.<brand>` at Squarespace (already done for dev).
6. App Proxy configuration on the live-store install for storefront-customer review submission.
7. **Set the go-live guard** (Settings → Cadence → "Set cutoff to now") on the prod stack as part of cutover, so the store's pre-existing customers are never auto-emailed. The backfill also leaves pre-cutoff orders un-armed, but set the cutoff regardless — it's the explicit launch line. Then reach out to the ~half-dozen legacy customers by hand. See §10 "Go-live guard."

---

## 15. Post-MVP Roadmap

Features deferred to after MVP launch. Update this list as priorities shift; the order is a snapshot, not a contract.

### Roadmap items completed (chronological-ish)

- ✅ Storefront-customer review submission (Shopify App Proxy + modal dialog + edit-your-own-review)
- ✅ Aggregate widget on collection cards (theme div added; widget renders inline)
- ✅ Per-variant + related reviews (Shopify metafield-driven; sibling-variant "related" section)
- ✅ Sample-invitation tooling (single + batch CSV + export with mail-merge URLs)
- ✅ Branding admin page (widget visual customization + email template + shared email branding)
- ✅ Multi-product email batching (one email per order with all products inline)
- ✅ **Campaigns feature** (application-based sample distribution) — see [campaigns-feature-plan.md](campaigns-feature-plan.md). Covers public application form (App Proxy + Shopify Page embed), versioned terms, approval queue + customer upsert, batch invitation generation, capacity warning + auto-close, four campaign email triggers with admin batch-send, per-participant Shopify discount codes (`write_discounts` scope) with redemption tracking via `orders/paid` webhook and two-option code cleanup, two-stage retention pipe (quarantine → admin-confirmed purge of shipping addresses), and per-(campaign, product) anonymous feedback forms with question-type aggregates. Migrations 018 + 019. Ongoing/rolling-campaign mode (per-member auto-fire email scheduling) is logged as a bounded future addition.

### Chunk A: Moderation, reporting, notifications — ✅ complete

1. ✅ **Retract-with-reason + audit log.** Migration 008 adds `moderation_reason` (9-value enum: profanity, spam, off-topic, not-a-customer, harassment, contains-pii, legal-takedown, duplicate, other) and `moderation_note` to `reviews`, plus a `moderation_events` table that records every retract/restore with from/to status, reason, internal note, actor, and customer-notified flag. Admin review-detail page swaps the old 3-button moderation card for a Retract dialog (reason dropdown + optional internal note + opt-out checkbox for customer notification) and shows the full history in an audit-log card. `review_retracted` and `review_restored` email templates seed on first boot and are merchant-editable on the Branding/Email tab. Storefront removal is silent. Migration 009 relaxes the per-customer-per-product unique index to apply only to non-rejected reviews so a retracted customer can resubmit. A public-facing "review moderation policy" page is deferred to its own pass.

2. ✅ **Profanity wordlist filter (censor-on-write, store-both).** Admin-editable newline-separated wordlist; `#`-prefixed lines are comments. Whole-word, case-insensitive match (avoids the Scunthorpe problem); matched words become `*`s of equal length. Applied at all five submission paths (email-link, sample, App Proxy submit + edit, legacy api) via `sanitizeReviewText`. Reviewer names are intentionally not censored. The wordlist UI lives on the **Reviews → Moderation** sub-tab (not Settings), blurred behind a "Reveal" toggle so a screenful of slurs isn't shown by accident.

   **Data model (migration 014):** each review stores BOTH the censored display copy (`title`/`body`, what the public storefront reads) AND the raw original (`title_original`/`body_original`, read only by the admin moderation view and the re-scan). This is deliberately *censor-on-write*, not censor-on-read: the public read path only ever reads the pre-censored column, so it cannot accidentally leak profanity if a new read path forgets to filter — keeping the core guarantee strong. Storing the original is what enables re-censoring (word added) AND un-censoring (word removed).

   **Re-scan on save:** saving the wordlist calls `recensorAllReviews()`, which re-derives every review's censored columns from its stored original using the current list — so adding a word censors matching old reviews and removing one un-censors them, with no change to the customer-facing read path. It's a synchronous admin-triggered batch (idempotent, whole-word). Reviews predating migration 014 have a NULL original and are skipped (admin shows their censored text).

   **⚠️ Future, at scale:** the re-scan currently re-checks *every* review on each save. At small volumes that's milliseconds. If review counts ever reach the tens of thousands, switch to a **delta approach** — diff the old vs. new wordlist and only re-filter reviews whose original text contains an added/removed word — and/or move the batch off the request thread. Deliberately deferred now to avoid premature complexity (the delta's whole-word matching is an extra place for bugs).

3. ✅ **"Pause reviews" panic button.** New `panic_events` audit table (migration 010) plus three settings keys for current state (`panic_paused_until`, `panic_paused_reason`, `panic_paused_at`). Settings page exposes a Pause dialog requiring a reason, a duration (1-168h, default 72), and the typed phrase "PAUSE REVIEWS" to confirm. While paused: storefront widget shows "Reviews are temporarily unavailable" and hides aggregate; all submission paths (API, App Proxy, email-link, sample) return 503; the dispatcher's cron run short-circuits with a warning log. A red banner is injected at the top of every admin page with a one-click Resume; Settings card surfaces countdown, extend, and resume controls plus the full pause history. Activation/extension/resume sends an operational email to `DEV_NOTIFICATION_EMAIL` when configured. Auto-resumes silently when `paused_until` passes — no cron needed.

4. ✅ **Reported reviews moderation queue.** Migration 011 adds `review_reports` (with a partial unique index on `(review_id, reporter_ip)` for status='open' as anti-spam dedupe) and `banned_reporters`. Storefront widget grows a "Report" button on each review (hidden on the customer's own review); clicking opens a modal with a simpler 5-value reason enum, optional message, and optional email. The `/api/reviews/:id/report` endpoint is CORS-allowed (unauthenticated), silently drops reports from banned emails with 200 OK so the reporter gets no signal, and silently succeeds for non-published reviews to avoid leaking review status. New "Reports" admin tab (with open-count badge in the nav) groups open reports by review; each group has dismiss-this / dismiss-all / retract-the-review (uses the same retract flow + audit log + customer notification email as the review-detail page) and per-report ban-this-email actions; banned reporters listed below with unban.

5. ✅ **Configurable new-review notifications.** Settings card with master toggle, recipient email, and per-rating checkboxes (1-5). The `notifyOnNewReview` helper checks all three before firing, looks up the review + product, and sends a plain operational email (no template — internal-only) with the rating, reviewer label, body, and an admin link. Wired into the four new-review insertion paths (skipped on the proxy edit path — edits aren't new reviews). Fire-and-forget: failures are logged but don't block the submission response.

### Prioritized next — Chunk B: Search, filters, storefront UX polish

6. **Reviews list search + filters in admin** (full Reviews tab redesign): **🟡 partially done** —
   - ✅ Filter by rating, date range, product, reviewer (email/name), status; sortable columns; real product + variant names. (Shipped in the admin overhaul.)
   - ⬜ Still to do: full-text content search across title and body (SQLite FTS5), and filters for verified_kind / has-merchant-reply.
7. **Storefront sort/filter on reviews list**:
   - Content search box
   - Sort by rating (high-to-low, low-to-high)
   - Sort by date (newest, oldest)
   - Filter by verified (any verification badge vs unverified)
8. **Configurable widget pagination** — dropdown for page size (5/10/15/20/25), default 20. "Load more reviews" button at end of current page when more pages exist.
9. **Per-product "skip review requests" metafield.** Same Shopify metafield pattern as `variant_handling`: namespace `reviews`, key `skip_requests` (boolean). When true, dispatcher excludes the product's purchases from eligibility. For gift cards, services, sensitive products, etc.
10. **Configurable minimum review body length.** Default 0 (star-only allowed). Admin setting on Settings page.
11. **Visual polish — widget.** SVG stars instead of text characters, smooth disclosure animation on `<details>`, refined typography hierarchy, polished empty-state. Pure CSS/SVG work.

### Prioritized next — Chunk C: Operations, analytics, observability

12. **Per-customer data export.** Admin action that downloads a customer's full data (reviews, purchases, email events, opt-out status, sample invitations they consumed) as JSON or CSV. Customer-facing GDPR/CCPA support tool. Build at admin level for now; layer a developer-level cross-store export when multi-tenant.
13. **Backup management UI.** Backup container writes `/data/backup-status.json` after each run; admin Settings card surfaces: last-run timestamp, file size, last-success status. "Run backup now" button touches a trigger file the backup container watches.
14. **System health card on Dashboard.** Store-facing info: dispatcher last-run timestamp + outcome, pending reports count, last review received, last backup. "Is the system OK at a glance" answer.
15. **Analytics — trends over time.** Avg rating by month, review volume by month, response rate (% of email sends that produced a review). Data is already there in `reviews` and `email_events`; this is admin-UI work.
16. **Analytics — per-product.** Which products get reviewed most/least, avg rating per product, response rate per product, products with many purchases but few reviews. Surfaces what's working and what's missing.
17. **Analytics — email funnel.** Sent → opened (requires pixel; opt-in if added) → clicked (we already have the data via token clicks) → submitted. Useful for tuning subject lines and cadence.

### Held for later

- **Visual polish — emails.** Logo header refinements, better typography hierarchy, on-brand spacing.
- **Photos in reviews.** Schema is ready (`review_media` table). Need upload handling on submission, storage (Mercury filesystem to start, CDN-pluggable later), and display in widget.
- **Q&A on products.** Schema is ready (`questions` table). Need submission UI, admin moderation, display on product page.
- **Merchant replies on storefront widget.** Admin already has the form to write replies (`merchant_reply` column); the storefront widget needs to surface them inline below each review.
- **Email-template trigger system (v2).** Replace the current "if customer has prior reviews use repeat else use first" heuristic with a configurable per-template trigger system: event (fulfilled, email sent, review submitted), delay, exclusion criteria. Substantial design work — only worth doing when we have more than 2-3 templates.
- **Per-product cadence overrides.** Shopify metafield to override `request_delay_days` per product (e.g., 5 days for consumables, 30 for high-consideration purchases).
- **Webhook replay v2.** Current `/admin/sync` does 90-day backfill blunt-instrument style. Future: selectable time range, per-order replay, per-webhook-type replay, visibility into what got synced.
- **Admin tab reorganization.** The overall nav (Dashboard / Reviews / Reports / Campaigns / Invitations / Branding / Settings) was built additively; once the post-launch surface stabilizes, audit the grouping and rename/regroup where it makes sense. Flagged from 2026-06-02 click-through feedback.
- **Manual-ops button feedback.** The "Run backfill" and "Run dispatcher" buttons on the dashboard currently dump raw JSON on success. Replace with friendly success/error banners that summarize the result in one line, with a "Show details" expand for the raw payload (useful for tech support, hidden by default). Flagged from 2026-06-02 click-through feedback (test plan §12.4).
- **Panic-button exclusions per surface.** Currently the panic button pauses *all* submission surfaces (storefront widget, email-link, sample invite, App Proxy, campaign applications). Campaign applications are arguably a different concern (they don't publish anything immediately; they queue for manual review). Future: add per-surface granularity so the merchant can keep some surfaces open during a review-targeted panic. Flagged from 2026-06-02 click-through feedback (test plan §9.4).

### Future considerations (further out)

- **Affiliate/influencer platform** as a separate self-hosted service alongside reviews on the same infrastructure (Mercury + GCP relay + Caddy).
- **Multi-tenant retrofit** if the project ever serves more than one store. Estimated 2-3 weeks with the email layer being the largest single piece.
- **Self-hosted small websites** on the same Mercury + GCP relay stack — would coexist via additional subdomains routed through the same Caddy instance.
- **Outgoing webhooks** — fire events to external services (Klaviyo, Slack, custom integrations) when reviews submit or get reported. Build iteratively as specific integrations are requested rather than speculatively.

### Multi-tenancy / public app

The full assessment of what it takes to offer this as a public, multi-store Shopify app — and the decision about which foundations to **pour now** (before go-live, while dev data is still disposable) vs. **defer** until true multi-tenancy is closer — lives in its own canonical doc: **[multi-tenancy-foundation.md](multi-tenancy-foundation.md)**. That doc holds the concrete `016_tenancy_foundation` migration plan (a `shops` table, a `shop_id` key + composite constraints, a `getCurrentShopId()` seam, scoped `shop/redact`) and the logged list of deferred work (OAuth, embedded admin, scalable email, per-shop settings, billing, listing, Postgres, CI/CD, etc.). The two items previously listed here — pre-existing-customer onboarding and near-zero-config install — are folded into that doc (B10/B4). Read it before starting any multi-tenant work.

### Explicitly NOT building (decisions made during planning)

These were considered and turned down. Don't re-propose unless the user brings them up.

- **Pre-publish moderation (auto-publish vs queue toggle).** Trust model: publish-immediately, retract-with-reason only. Brand-controlled pre-publish queues hurt the trust signal on reviews. Captured under Chunk A item 1.
- **Auto-flag by rating.** Same reason — that's a form of pre-publish gating for negative reviews.
- **Bulk moderation actions.** Without pre-publish moderation, bulk operations aren't needed; search/filter on the Reviews list serves the same goal.
- **Reply-template snippets.** Encourage genuine, targeted merchant replies; if a brand wants to reuse text, they can copy-paste.
- **Shopify customer tag sync.** Adds Shopify-write coupling and doesn't fit the brand's marketing flow. The underlying data is already queryable in our admin for manual segmentation.
- **Reviewer attribution options beyond first-name-only.** First-name from Shopify customer record is the answer; sample-invite reviews use the first word of the invitation's intended_name.

---

## 16. Reference Materials

- **Approved planning conversation**: `~/.claude/plans/okay-claude-i-co-own-a-logical-wilkes.md` — the original plan written during the planning conversation. This `development-plan.md` supersedes it as the canonical reference; the planning file is preserved for context on *why* certain decisions were made.
- **Project memory**: `~/.claude/projects/D--AI-shopify-reviews/memory/` — user profile, communication style preferences, home-lab infrastructure details, project state. Auto-loaded into Claude Code sessions in this project.
- **Global Claude preferences**: `~/.claude/CLAUDE.md` — communication-style rules (no AskUserQuestion, plain language, lead with decisions).

When this document and any of those references conflict, **this document wins** — it's the actively-maintained plan. Update it as the project evolves; do not let it drift from reality.

---

## 17. Pre-deployment Checklist

Once the live store is collecting real reviews, the recovery options narrow sharply — `rm data/reviews.db` stops being a valid answer. This checklist is what protects against the avoidable failures we've already seen on dev (FK-orphan migration crash, 2026-05-30) and a few we haven't, but obviously could.

Use it in three contexts: **A** before any deploy that includes a migration, **B** specifically before the live-store launch (one time, additionally), and **C** after every deploy to confirm the system actually came up the way we expected.

### A. Before any deploy that includes a migration

Applies to dev *and* prod. Cheap on dev (the data is disposable) but builds the muscle for prod, where it's load-bearing.

1. **Snapshot the DB before the deploy.** On Mercury:
   ```bash
   cd /opt/stacks/shopify-reviews-{dev,prod}
   sudo sqlite3 data/reviews.db ".backup data/reviews.db.pre-$(date +%Y%m%d-%H%M).bak"
   ```
   This is a point-in-time copy you can restore in seconds if the migration goes sideways. Do this *every* time, regardless of confidence — it's 30 seconds of insurance.

2. **Run `PRAGMA foreign_key_check`** against the *current* DB before the migration:
   ```bash
   sudo sqlite3 data/reviews.db "PRAGMA foreign_key_check;"
   ```
   Empty output = clean. Any output is `(table, rowid, parent_table, fkid)` per orphan — a child row whose FK target is missing. The dev DB had orphans accumulated from months of testing that the rebuild surfaced on COMMIT; the live DB could too, depending on how Shopify webhooks and our own moderation flows have interacted over time.

3. **For each orphan, decide repair-or-delete.** Usually delete — an orphan child whose parent is gone has no recoverable referent. Run the delete *before* the migration deploys:
   ```sql
   -- Example: delete email_events whose customer is gone
   DELETE FROM email_events WHERE customer_id NOT IN (SELECT id FROM customers);
   ```
   Pre-clean every reported violation. If anything's unclear (e.g., an orphan that's evidence of a bug we should investigate), pause the deploy.

4. **Dry-run the migration on a copy** (prod especially):
   ```bash
   sudo cp data/reviews.db /tmp/dryrun.db
   sudo sqlite3 /tmp/dryrun.db < src/db/migrations/0XX_whatever.sql
   sudo sqlite3 /tmp/dryrun.db "PRAGMA foreign_key_check;"
   ```
   The migration should apply without error and the post-check should be empty. If either fails, the migration isn't ready.

5. **Local pre-flight before pushing**: `npm run typecheck && npm run build` — non-negotiable. The migration file is copied to `dist/` by `scripts/copy-assets.mjs`, so a successful build is also a successful migration-file copy.

### B. Before the live-store launch (additional, one-time)

All of §A, plus:

6. **Set the go-live cadence guard** (Settings → Cadence → "Set cutoff to now") *immediately after* the migration deploys on prod. This is what stops the dispatcher from emailing every historical customer the first time it runs. See §10 "Go-live guard."

7. **Have a written outreach plan for the pre-existing customers** (the ~half-dozen who bought before launch). Manual emails, not the dispatcher. The cutoff guard suppresses the auto-path; this is the replacement.

8. **Verify the prod `.env`** has every required value: `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_WEBHOOK_SECRET`, `EMAIL_TOKEN_SECRET`, `SMTP_*`, `BRAND_NAME`, `PUBLIC_URL`, `STOREFRONT_ORIGIN`, `DEV_NOTIFICATION_EMAIL`. **Generate fresh secrets** (`EMAIL_TOKEN_SECRET` especially) — do not reuse dev values.

9. **Verify the OAuth install completed** for the live shop: `sudo sqlite3 data/reviews.db "SELECT shop_domain, length(access_token), access_scopes FROM shops;"` — expect a non-null token length and the right scope set.

10. **Test-fire each subscribed webhook** from the Shopify admin's webhook test tool. Confirm each one appears in the logs with `"webhook received"` and that the relevant DB row updates.

11. **Confirm DNS + Caddy routing** for the live host: `curl -I https://reviews.<brand>/health` returns 200 from outside the tailnet.

12. **Confirm the backup pipeline** runs successfully against the new prod stack: `sudo docker compose exec backup /scripts/backup.sh` and check the snapshot lands on Pebbles. Don't wait for the first scheduled run to discover backups are broken.

### C. After every deploy (dev or prod)

Cheap to run, catches the obvious failures while the deploy is fresh in mind.

13. **`curl <public-url>/health` returns `{"status":"ok"}`** — full chain works (relay → Tailscale → container).
14. **Migrations applied cleanly**: `sudo docker compose logs --tail=100 reviews-app | grep -i 'migration\|error'` — every expected migration shows as applied, no errors after.
15. **Scheduler registered**: same log search, look for `"dispatcher scheduler registered"`.
16. **Click-through smoke test**: load `/admin` and at least one sub-tab (Dashboard, Reviews, Branding); load a storefront product page and confirm the widget renders.
17. **For prod after the first webhook**: confirm the corresponding DB row appears (e.g., a test order produces a `purchases` row).
18. **`PRAGMA foreign_key_check` again after the migration**, just to confirm the new schema is clean.

### Rollback

The "if it goes wrong" answer changes with the kind of failure:

- **Migration crashed mid-run**: SQLite rolled back the transaction — the DB is in its pre-migration state. Investigate, fix, redeploy.
- **Migration succeeded but code is broken**: restore the snapshot from §A.1, `docker compose down`, redeploy the prior code. The snapshot guarantees this works in seconds.
- **Migration succeeded, code works, but something subtle is wrong**: don't rush a rollback — the prior snapshot is missing post-deploy writes. Stop the dispatcher (panic button), diagnose, hotfix forward.

The first two cases are why §A.1 (snapshot before deploy) is non-negotiable.
