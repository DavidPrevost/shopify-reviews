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
            │   ─ Reverse-proxies to mercury:8080 (prod) or    │
            │                       mercury:8081 (dev)         │
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

Each stack has its own `.env` with its own Shopify token, webhook secret, and host port (8080 prod, 8081 dev). The application code is identical between the two; the GCP relay's Caddy config maps each public hostname to the right port on Mercury.

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
   reviews-dev.brandname.com { reverse_proxy 100.117.6.18:8081 }
   reviews.brandname.com     { reverse_proxy 100.117.6.18:8080 }
   ```
   (Substitute Mercury's actual Tailscale IP.) Caddy auto-issues Let's Encrypt certs on first request.
5. At Squarespace → DNS, add **two A records**: host `reviews` → GCP static IP, host `reviews-dev` → same GCP static IP. Apex zone otherwise untouched. Set TTL to 5 minutes if Squarespace allows it, so any future migration propagates fast.
6. On Mercury, each `docker-compose.yml` (dev and prod) binds the app's port to the Tailscale interface only via `${HOST_BIND_IP}:${HOST_PORT}:8080`. Prod uses host port 8080; dev uses 8081.

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

### Completed in code (steps 1–11)

- **Step 1** ✅ Scaffolding (Hono server, Docker, build pipeline)
- **Step 2** ✅ Database layer ([src/db/client.ts](src/db/client.ts), [src/db/queries.ts](src/db/queries.ts), [src/db/migrations/001_initial.sql](src/db/migrations/001_initial.sql))
- **Step 3** ✅ Shopify Admin API client and webhook HMAC verification ([src/shopify/](src/shopify/), [src/lib/hmac.ts](src/lib/hmac.ts))
- **Step 4** ✅ Webhook receivers ([src/routes/webhooks.ts](src/routes/webhooks.ts)) + one-time installer ([src/scripts/install-webhooks.ts](src/scripts/install-webhooks.ts))
- **Step 5** ✅ Backfill ([src/shopify/sync.ts](src/shopify/sync.ts), [src/scripts/backfill.ts](src/scripts/backfill.ts))
- **Step 6** ✅ Email pipeline (SMTP client, signed tokens, templates, dispatcher, cron) under [src/email/](src/email/) and [src/scheduler/](src/scheduler/); manual trigger at [src/scripts/dispatch.ts](src/scripts/dispatch.ts)
- **Step 7** ✅ Storefront API ([src/routes/api.ts](src/routes/api.ts))
- **Step 8** ✅ Storefront widget bundle ([src/widget/](src/widget/)) + email-link review submission and unsubscribe pages ([src/routes/widget.ts](src/routes/widget.ts))
- **Step 9** ✅ Server-rendered admin UI ([src/routes/admin.ts](src/routes/admin.ts), [src/lib/auth.ts](src/lib/auth.ts))
- **Step 10** ✅ GDPR webhook handlers (folded into Step 4's `webhooks.ts`)
- **Step 11** ✅ Backup script ([scripts/backup.sh](scripts/backup.sh)) + sidecar service in `docker-compose.yml`

`npm run typecheck` and `npm run build` both pass.

### Conventions adopted during build (deviations from earlier draft)

- **All persisted timestamps are unix seconds**, matching SQLite's `unixepoch()`. Helpers in [src/lib/time.ts](src/lib/time.ts). The earlier scaffold mixed `Date.now()` (ms) and `unixepoch()` (s); standardized on seconds.
- **Per-run dispatcher cap** is now stored in `settings.cadence_dispatcher_batch` (default 100), not hardcoded in the SQL. Adjustable from the admin settings page.
- **Runtime CLI scripts** (install-webhooks, backfill, dispatch) live under [src/scripts/](src/scripts/) so they compile to `dist/scripts/` and run inside the container. Build-time scripts (esbuild config, copy-assets) stay in [scripts/](scripts/).

### Remaining work (steps 12–14, all external configuration, not code)

- **Step 12** Google Cloud relay (Caddy + Tailscale) — needs GCP account, e2-micro Always-Free VM, A records added at Squarespace. See [external-accounts-setup.md](external-accounts-setup.md). Oracle Cloud was attempted first but its image catalog failed to populate; switched to GCP for a smoother signup. Cloudflare Tunnel was the original plan but Cloudflare's free-tier subdomain zone path is no longer available.
- **Step 13** Yotpo cleanup on the live store — walk through with the owner.
- **Step 14** Theme integration on the live store — walk through with the owner.

Before any of those, the stack must deploy successfully to Mercury's dev environment with a working `.env` (Shopify dev-store token, Gmail app password, secrets generated). Verification gates per §7 should be exercised in order against the dev stack.

---

## 15. Reference Materials

- **Approved planning conversation**: `~/.claude/plans/okay-claude-i-co-own-a-logical-wilkes.md` — the original plan written during the planning conversation. This `development-plan.md` supersedes it as the canonical reference; the planning file is preserved for context on *why* certain decisions were made.
- **Project memory**: `~/.claude/projects/D--AI-shopify-reviews/memory/` — user profile, communication style preferences, home-lab infrastructure details, project state. Auto-loaded into Claude Code sessions in this project.
- **Global Claude preferences**: `~/.claude/CLAUDE.md` — communication-style rules (no AskUserQuestion, plain language, lead with decisions).

When this document and any of those references conflict, **this document wins** — it's the actively-maintained plan. Update it as the project evolves; do not let it drift from reality.
