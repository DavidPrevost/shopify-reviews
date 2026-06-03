# Self-Hosted Shopify Reviews App — Implementation Plan

## Context

The brand currently uses Yotpo for product reviews on its Shopify storefront. Account access has been lost; the lingering widget renders stale aggregate ratings ("7 reviews / 5 stars"), but the "Write Review" button is broken because the JS bundle 404s. Yotpo's pricing ($15/month for under 50 reviews) is not a fit for the brand's bootstrapped budget.

We are replacing Yotpo with a self-hosted reviews application running on the brand's existing home-lab hardware (Mercury). Goals:

- Zero recurring monthly cost (uses existing hardware, existing Gmail, free Cloudflare tier)
- Integrate cleanly with the legacy Shopify theme (Trademark 1.7.3) AND survive a future theme redesign without rework
- Send well-targeted review-request emails — no spam, no silence — with per-customer + per-product suppression logic from day one
- Be maintainable by an owner with basic coding skills (favor boring, well-trodden patterns)
- Have a clean upgrade path to v2 features (photos, Q&A, merchant replies, analytics) without schema rewrites

## Architecture (one page)

One Node.js application, deployed as a Docker stack on Mercury, exposed to the internet via Cloudflare Tunnel at `reviews.<brand-domain>`. Storefront integration is a single `<script>` tag plus placeholder `<div>` in the legacy theme.

```
                        ┌──────────────────────────────┐
                        │   Cloudflare (DNS + Tunnel)  │
                        │ reviews.brandname.com (HTTPS)│
                        └──────────────┬───────────────┘
                                       │ outbound tunnel
        ┌──────────────────────────────┴──────────────────────────────┐
        │              Mercury (Ubuntu 24.04 + Docker)                │
        │   /opt/stacks/shopify-reviews/docker-compose.yml            │
        │                                                             │
        │   ┌──────────────────────┐     ┌──────────────────────────┐ │
        │   │ cloudflared          │────▶│ reviews-app (Node/Hono)  │ │
        │   │ (CF Tunnel daemon)   │     │  - Admin UI  (/admin)    │ │
        │   └──────────────────────┘     │  - Storefront API (/api) │ │
        │                                │  - Webhooks (/webhooks)  │ │
        │                                │  - Widget JS (/widget.js)│ │
        │                                │  - node-cron scheduler   │ │
        │                                └────────┬─────────────────┘ │
        │                                         │ volume mount      │
        │                                ┌────────▼─────────┐         │
        │                                │ /data/reviews.db │         │
        │                                │   (SQLite file)  │         │
        │                                └──────────────────┘         │
        └─────────────────────────────────────────────────────────────┘
                       │ nightly rsync over Tailscale
                       ▼
              Pebbles: /opt/backups/shopify-reviews/

      Outbound mail → smtp.gmail.com (existing brand alias)
      Inbound webhooks ← Shopify; widget reads ← customer browsers
```

**Stack choices** (all selected for basic-skill maintainability):

- **Hono** — small, well-documented Node web framework. Express-like API, tiny mental model.
- **better-sqlite3** — synchronous SQLite client. Easiest possible DB interface in Node.
- **nodemailer** — standard library for SMTP.
- **node-cron** — in-process cron scheduler.
- **esbuild** — single-config-file bundler for the storefront widget.
- **Docker Compose** — matches the existing `/opt/stacks/[service]/` pattern on Mercury.

**Avoided**: Remix, Next.js, Drizzle/Prisma, React for admin UI, OAuth flow, Shopify App Bridge. Single-store custom apps don't need any of it; using a static admin API token plus password-protected admin pages is dramatically simpler.

## Repo Layout

Development directory: `D:\AI\shopify-reviews\`. Deployed to `/opt/stacks/shopify-reviews/` on Mercury.

```
shopify-reviews/
├── docker-compose.yml         # Three services: reviews-app, cloudflared, backup
├── Dockerfile                 # Multi-stage build for the Node app
├── .env.example               # All config knobs
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # Hono setup, route mounting, server start
│   ├── config.ts              # Env loading + validation
│   ├── routes/
│   │   ├── admin.ts           # Server-rendered HTML admin pages
│   │   ├── api.ts             # Storefront read/write (CORS-allowed)
│   │   ├── webhooks.ts        # Shopify HMAC-verified receivers
│   │   ├── widget.ts          # Serves widget.js + review submission landing
│   │   └── unsubscribe.ts     # Email opt-out endpoints
│   ├── db/
│   │   ├── schema.sql
│   │   ├── client.ts          # better-sqlite3 wrapper, migration runner
│   │   └── queries.ts         # All SQL in named functions
│   ├── shopify/
│   │   ├── admin-client.ts    # GraphQL Admin API client (static token)
│   │   ├── webhook-verify.ts  # HMAC verification
│   │   └── sync.ts            # Initial backfill + ongoing sync helpers
│   ├── email/
│   │   ├── smtp-client.ts     # nodemailer + Gmail
│   │   ├── tokens.ts          # HMAC-signed review-link tokens
│   │   └── templates/
│   │       ├── request-first.html
│   │       └── request-repeat.html
│   ├── scheduler/
│   │   ├── cron.ts            # node-cron registration
│   │   └── dispatcher.ts      # The daily email dispatcher
│   ├── widget/
│   │   ├── widget.ts          # Bundled to public/widget.js by esbuild
│   │   └── widget.css
│   └── lib/
│       ├── hmac.ts
│       ├── auth.ts            # Admin password / session cookies
│       └── logger.ts
├── public/                    # Static (built widget.js, admin CSS)
└── scripts/
    ├── backup.sh              # SQLite snapshot + rsync to Pebbles
    └── install.sh             # First-run helper
```

## Database Schema

Single-tenant (no `shop_id` column needed). Forward-compatible with v2 features.

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
  due_at INTEGER,                  -- when next request becomes eligible
  request_count INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER,
  reviewed_at INTEGER,             -- set when review submitted; permanent stop signal
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
  status TEXT NOT NULL DEFAULT 'published',  -- pending|published|rejected (v2 moderation)
  merchant_reply TEXT,                       -- v2, nullable
  merchant_reply_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_product ON reviews(shopify_product_id, status);

-- v2 photo uploads (data path forward-compatible; empty for MVP)
CREATE TABLE review_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'image',
  storage_key TEXT NOT NULL,       -- path under /data/media/
  width INTEGER, height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  purchase_id INTEGER REFERENCES purchases(id),
  kind TEXT NOT NULL,              -- request_sent|opened|clicked|bounced|unsubscribed|review_submitted
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_events_customer ON email_events(customer_id, kind);

-- v2 placeholder
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
  ('cadence_max_requests',     '3'),
  ('cadence_min_days_between', '7'),
  ('request_delay_days',       '7'),
  ('shop_brand_json',          '{}');
```

Aggregate rating is computed on read (`SELECT AVG(rating), COUNT(*) FROM reviews WHERE status='published' AND shopify_product_id=?`). At this scale, no materialized counter needed.

## API Surface

All routes served from `https://reviews.<brand-domain>`:

**Storefront API (CORS allowing only the brand storefront origin)**
- `GET  /api/products/:productId/reviews?page=N&size=20` — list published reviews + aggregate
- `GET  /api/products/:productId/aggregate` — `{avg, count}` for collection cards
- `POST /api/reviews/submit` — submit review with signed token from email link

**Public utility**
- `GET /widget.js` — bundled storefront widget (long cache headers; CF edge caches)
- `GET /widget.css`
- `GET /r/:token` — review-submission landing page (token-gated)
- `GET /unsubscribe?token=...` — global opt-out (signed token)
- `GET /unsubscribe/product?token=...` — per-purchase opt-out

**Webhooks (Shopify HMAC-verified)**
- `POST /webhooks/orders/paid`
- `POST /webhooks/orders/fulfilled`
- `POST /webhooks/customers/data_request`   ← GDPR mandatory
- `POST /webhooks/customers/redact`         ← GDPR mandatory
- `POST /webhooks/shop/redact`              ← GDPR mandatory

**Admin (password-protected, server-rendered HTML)**
- `GET  /admin`                       — login page
- `POST /admin/login`
- `GET  /admin/dashboard`             — stats, recent activity
- `GET  /admin/reviews`               — list + filter; moderation actions
- `POST /admin/reviews/:id/status`    — publish/reject
- `POST /admin/reviews/:id/reply`     — merchant reply (UI plumbing now, surface in v2)
- `GET  /admin/customers/:email`      — view + manage opt-outs
- `GET  /admin/settings`
- `POST /admin/settings`              — update cadence config
- `POST /admin/sync`                  — manual full Shopify backfill

## Email Cadence Logic

The differentiator: the daily dispatcher (`node-cron`, runs at 14:00 UTC) selects eligible purchases with all suppression rules expressed as a single SQL query:

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
LIMIT 100;
```

For each row:

1. Pick template variant: `repeat` if customer has any prior review, `first` otherwise
2. Generate signed token: `HMAC-SHA256({purchase_id, customer_id, exp: now+60d}, EMAIL_TOKEN_SECRET)`
3. Render HTML (brand colors pulled from cached `settings.shop_brand_json`)
4. Send via Gmail SMTP using nodemailer
5. On success: increment counters, set timestamps, advance `due_at` by `cadence_min_days_between` days
6. When `request_count >= cadence_max_requests`: NULL `due_at` (permanent stop for this purchase)
7. Log to `email_events`

All suppression checks live *inside* the SQL — no email goes out unless every condition is met. Adding new rules later means appending `AND` clauses.

## Webhook Flow

- `orders/paid` → upsert customer, insert `purchases` rows for each line item with `due_at = NULL`
- `orders/fulfilled` → set `fulfilled_at = now`, `due_at = now + (request_delay_days * 86400)` for matching purchases
- `customers/data_request` → log; respond per Shopify's required behavior
- `customers/redact` → anonymize customer + reviews
- `shop/redact` → wipe DB

A first-run backfill script pulls the last 90 days of fulfilled orders to seed the `purchases` table, so review requests start flowing for recent customers from day one.

## Theme Integration (Legacy Trademark 1.7.3)

Two one-time edits via Shopify Admin → Online Store → Themes → ⋯ → Edit Code:

**`layout/theme.liquid`** — add immediately before `</head>`:
```liquid
<script src="https://reviews.brandname.com/widget.js" defer></script>
```

**`templates/product.liquid`** — add wherever reviews should render (typically below the product description / above related products):
```liquid
<div data-reviews-widget="full" data-product-id="{{ product.id }}"></div>
```

**For collection cards** — add to the relevant product-card snippet (in Trademark, often `snippets/product-grid-item.liquid` or similar; we'll identify the right file together):
```liquid
<div data-reviews-widget="aggregate" data-product-id="{{ product.id }}"></div>
```

The widget JS:

- Self-contained, no jQuery, ~10KB gzipped
- Reads `data-product-id` and `data-reviews-widget` mode from each placeholder
- Calls `https://reviews.brandname.com/api/...` (CORS-allowed for the brand storefront origin)
- Renders inline; uses `currentColor`, `inherit`, and theme CSS variables for visual integration
- One overridable accent color via attribute: `data-star-color="#f5a623"`

**Future-proofing**: when the brand redesigns to a modern (Online Store 2.0) theme, the same widget works — move the same one-line `<div>` into the new theme. Optionally, an Online Store 2.0 App Block wrapper can be added later for drag-and-drop placement; the underlying widget code does not change.

## Yotpo Cleanup

Performed during go-live, in order:

1. **Backup**: Online Store → Themes → ⋯ → Duplicate (creates a restore point in 10 seconds)
2. **Search and remove theme code**: Edit Code → search all files (case-insensitive) for `yotpo` and `staticw2`. Common locations:
   - `layout/theme.liquid` — script tag
   - `templates/product.liquid` — `{% include 'yotpo' %}` or hardcoded widget div
   - `snippets/yotpo.liquid` — delete file if exists
   - `assets/yotpo.js`, `assets/yotpo.css` — delete files if exist
3. **Uninstall Yotpo app** (if still listed): Apps → Yotpo → Uninstall. Triggers Shopify to clean any Script Tags Yotpo registered via the Script Tag API (these don't show in theme code).
4. **Delete stale metafields**: Settings → Custom data → Products → Metafield definitions → look for `yotpo` namespace → delete. Shopify purges associated values across all products. (This is what's still rendering "7 reviews / 5 stars".)
5. **Preview** the cleaned theme; verify product pages render with no console errors.
6. **Publish**.

I'll walk through these steps live during deployment.

## Deployment

**`/opt/stacks/shopify-reviews/docker-compose.yml`:**

```yaml
services:
  reviews-app:
    build: .
    container_name: reviews-app
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data
    expose:
      - "8080"
    networks:
      - reviews-net

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: reviews-cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARED_TOKEN}
    networks:
      - reviews-net
    depends_on:
      - reviews-app

  backup:
    image: alpine:latest
    container_name: reviews-backup
    restart: unless-stopped
    volumes:
      - ./data:/data:ro
      - ./scripts:/scripts:ro
      - ${HOME}/.ssh:/root/.ssh:ro
    command: sh -c "apk add --no-cache rsync openssh-client sqlite tzdata && crond -f -d 8"
    # /etc/crontabs/root inside container runs scripts/backup.sh nightly

networks:
  reviews-net:
    driver: bridge
```

**`.env`** (template; real values stored only on Mercury):

```
SHOPIFY_SHOP_DOMAIN=brandname.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...
SHOPIFY_WEBHOOK_SECRET=...
EMAIL_TOKEN_SECRET=...                 # 32+ random bytes
ADMIN_PASSWORD_HASH=...                # bcrypt hash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=brand-gmail-account@gmail.com
SMTP_PASS=...                          # Gmail app password
SMTP_FROM=Reviews <reviews@brandname.com>
PUBLIC_URL=https://reviews.brandname.com
STOREFRONT_ORIGIN=https://brandname.com
CLOUDFLARED_TOKEN=...
TZ=America/New_York
```

## DNS / Cloudflare Tunnel Setup

Domain stays at Squarespace. Only `reviews.brandname.com` is delegated to Cloudflare.

1. Sign up for a free Cloudflare account
2. Add a **subdomain zone** for `reviews.brandname.com` (Cloudflare supports zones at subdomain level — choose this rather than adding the full apex)
3. Cloudflare assigns four nameservers for that zone
4. In Squarespace's DNS panel for `brandname.com`, add **NS records** for the host `reviews` pointing to those four Cloudflare nameservers
5. In Cloudflare → Zero Trust → Networks → Tunnels → Create Tunnel → name `reviews-mercury` → choose Docker → copy the connector token into `CLOUDFLARED_TOKEN`
6. In the tunnel's "Public Hostnames" tab: `reviews.brandname.com` → Service: HTTP → URL: `reviews-app:8080`
7. Cloudflare auto-provisions HTTPS

## Shopify Setup

1. Store admin → Settings → Apps and sales channels → Develop apps → Create an app → name "Reviews"
2. Configuration → Admin API integration → grant scopes:
   - `read_orders`, `read_customers`, `read_products`, `read_fulfillments`
   - `write_metafields` (for v2 merchant-reply pinning)
3. Install in store → copy the Admin API access token → `SHOPIFY_ADMIN_TOKEN`
4. Webhooks: created programmatically by the app's first-run code, pointing at `PUBLIC_URL/webhooks/...`
5. Webhook signing secret (from the app's settings page) → `SHOPIFY_WEBHOOK_SECRET`

## Gmail SMTP Setup

1. In the brand's Gmail account: Account → Security → enable 2FA if not already on
2. Generate an App Password labeled `shopify-reviews` → use as `SMTP_PASS`
3. Gmail Settings → Accounts and Import → Send mail as → add `reviews@brandname.com` → verify with the code sent to the alias
4. Test: send a manual test email from the deployed app to a personal address; confirm `From: reviews@brandname.com` and inbox delivery (not spam)

## Verification Plan (before going live)

End-to-end test on a free Shopify development store:

1. Create a Shopify Partners account → spin up a free dev store
2. Run a second instance of the stack pointed at the dev store (separate `.env`)
3. Create 2-3 test products on the dev store
4. Place a test order with an email address you control
5. Mark the order fulfilled in Shopify admin
6. Verify a `purchases` row appears with the correct `due_at`
7. Manually fire the dispatcher: `docker exec reviews-app node dist/scheduler/dispatcher.js --once`
8. Confirm email receipt; click the review link; submit a review
9. Visit a product page on the dev store; confirm the widget renders the new review
10. Test suppression rules:
    - Re-attempt review on same product → blocked
    - Click unsubscribe → verify global opt-out persists
    - Re-run dispatcher with opt-out customer → no email sent
    - Re-run dispatcher with `request_count` already at max → no email sent
11. Test webhook HMAC: replay a webhook with a tampered signature → rejected
12. Only with all green: deploy to live store, run Yotpo cleanup, install widget tag

## Build Order (commit-by-commit)

Each step has something testable on its own:

1. Scaffolding — `package.json`, tsconfig, Hono "hello world", Dockerfile, `docker-compose.yml`
2. Database — `schema.sql`, better-sqlite3 wrapper, migration runner
3. Shopify client — GraphQL client with static token, type definitions
4. Webhook receivers — HMAC verify, `orders/paid` + `orders/fulfilled`, write to DB
5. Initial backfill script — pull recent orders, populate `purchases`
6. Email pipeline — nodemailer + Gmail SMTP, signed-token generator, one template, dispatcher SQL
7. Storefront API — list/aggregate/submit endpoints with CORS
8. Storefront widget — vanilla TS bundle + CSS, two display modes, theme inheritance
9. Admin UI — login, dashboard, reviews list, moderation actions, settings
10. GDPR webhooks — `data_request`, `redact` handlers
11. Backup script — SQLite snapshot + rsync to Pebbles via Tailscale
12. Cloudflare Tunnel + DNS delegation — provision and connect
13. Shopify Yotpo cleanup — walk through together
14. Theme integration — add script tag and placeholder divs

## Critical Files To Be Created

- `D:\AI\shopify-reviews\docker-compose.yml`
- `D:\AI\shopify-reviews\Dockerfile`
- `D:\AI\shopify-reviews\.env.example`
- `D:\AI\shopify-reviews\src\index.ts`
- `D:\AI\shopify-reviews\src\db\schema.sql`
- `D:\AI\shopify-reviews\src\routes\webhooks.ts`
- `D:\AI\shopify-reviews\src\routes\api.ts`
- `D:\AI\shopify-reviews\src\routes\admin.ts`
- `D:\AI\shopify-reviews\src\scheduler\dispatcher.ts`
- `D:\AI\shopify-reviews\src\widget\widget.ts`
- `D:\AI\shopify-reviews\scripts\backup.sh`

## Deferred to v2

Schema and code paths already accommodate these — no rewrites required:

- Photo uploads in reviews (`review_media` table + `/data/media/` storage exist)
- Q&A on products (`questions` table exists)
- Merchant replies to reviews (`merchant_reply` columns exist; admin route stubbed)
- Analytics dashboard (data is already accumulating in `email_events` and `reviews`)
- Multi-store support (would require adding `shop_id` everywhere — easy retrofit)

## Post-Plan Memory To Save (after exiting plan mode)

For future sessions on this project:

- **User memory**: co-owner of small Shopify brand; basic coding (Python, SQL, HTML); home-lab operator with Docker/Portainer/Tailscale familiarity
- **Feedback memory**: prefers prose questions over multi-choice prompts; explain decisions plainly without jargon and without enumerating rejected alternatives
- **Project memory**: home-lab consists of Mercury (100.117.6.18) and Pebbles (100.86.45.31) — Intel N100 mini-PCs, 16GB RAM, Ubuntu 24.04, Docker stacks under `/opt/stacks/[service]/`; Mercury hosts persistent services (Gitea, Grafana, Prometheus, Portainer); Pebbles hosts on-demand/automation services (Flowise, n8n, Qdrant, Ollama, Open WebUI, Portainer); domain held at Squarespace, currently redirects to brandname.shopify.com
- **Reference memory**: Shopify reviews app project lives at `D:\AI\shopify-reviews\` (dev) and `/opt/stacks/shopify-reviews/` (Mercury)
