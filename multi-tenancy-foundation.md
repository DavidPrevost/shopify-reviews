# Multi-Tenancy Foundation — Pour-Now Plan + Deferred Public-App Work

**Status: reviewed plan, NOT yet implemented.** This document is the canonical record of (A) the tenancy foundation we intend to pour *before* the live-store go-live, while the dev database is still disposable test data, and (B) the public-app work we are deliberately deferring until true multi-tenancy is closer. It expands the two future bullets in [development-plan.md](development-plan.md) §15.

See development-plan.md §1–§5 for product context and §8 for the current single-tenant schema.

---

## Why now (the cost asymmetry)

Right now the dev database holds **disposable test data** — we can reshape the schema for essentially free (worst case: wipe and re-seed). The moment real customer reviews exist on the live store, every schema change becomes a careful, backed-up, locked migration against a single-writer SQLite file. So for schema, "now" isn't merely cheaper than "later" — it's roughly *free* vs. *careful*.

**The sorting test for every item:** *does delaying it force a data migration?* If yes → pour it now. If it's purely additive code or infrastructure with no schema impact → defer; doing it early is wasted effort at one-store scale.

**Tenancy model decision (low-regret):** the tenant is the **shop**. This matches Shopify's own install model (apps install per shop). If an account-spanning-multiple-shops concept is ever needed, an `accounts` table can sit *above* `shops` without re-keying any data underneath. So keying on `shop_id` is the conventional, safe choice — we are not betting on a complex tenancy design being right.

**Data tenancy ≠ user identity.** `shop_id` answers "which shop's data does this request touch." It does *not* model "which humans may access this shop" — that is Shopify's job. Under an embedded (App Bridge) admin, Shopify authenticates the merchant and hands us a per-request session token asserting the shop (and the user); a Shopify staffer who works on five shops simply gets a correctly-scoped token per shop. We therefore store **no users table and no access mapping** (at most a nullable audit `actor` later). See Decisions #4.

---

## Part A — Pour now (before go-live)

The whole Part A is intended as **one migration (`016_tenancy_foundation.sql`) plus a small amount of boot/seam code**. The discipline: add the *shape* (a `shops` table, a `shop_id` key, the composite constraints that are painful to alter on live data) and a single seam for "which shop is this." **Do not** thread `shop_id` through the query layer — with one shop's data, every existing query is already correct, and threading it is the same cost later for zero benefit now.

### A1. `shops` table + `getCurrentShopId()` seam

New table (top of migration 016):

```sql
CREATE TABLE shops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_domain       TEXT NOT NULL UNIQUE,          -- e.g. brand.myshopify.com
  storefront_origin TEXT,                          -- for per-shop CORS later
  brand_name        TEXT,
  api_version       TEXT,
  installed_at      INTEGER,
  created_at        INTEGER NOT NULL
);
```

Seam — new `src/lib/tenant.ts`:

```ts
// The single chokepoint for "which shop is this request for." Returns the one
// seeded shop today; when we go multi-tenant this is the ONLY place that
// changes — it'll read the shop from the OAuth session / X-Shopify-Shop-Domain
// instead of returning a constant.
export const CURRENT_SHOP_ID = 1;
export const getCurrentShopId = (): number => CURRENT_SHOP_ID;
```

Boot-time seeding — `ensureCurrentShop()` called from `src/index.ts` right after `migrate()` (migrations are pure SQL and can't read env, so the shop row is populated in code from `config`, the same pattern as the curated-wordlist seed):

```ts
// Upsert the single shop row (id=1) from env config on every boot.
export const ensureCurrentShop = (): void => { /* INSERT ... ON CONFLICT(shop_domain) DO UPDATE */ };
```

The migration itself inserts a bare placeholder row so `shop_id = 1` is a valid FK target during the rest of the migration; `ensureCurrentShop()` fills in the real domain/origin/brand on boot.

### A2. `shop_id` on the domain tables + composite constraints

Add `shop_id INTEGER NOT NULL DEFAULT 1` and fix the constraints/indexes that include the keys. Two kinds of change:

**Index-only (cheap — `DROP INDEX` / `CREATE INDEX`, no table rebuild):**

- **`reviews`** — highest-value data, and happily it has *no* inline `UNIQUE`, so no rebuild. Add `shop_id`, then:
  - `idx_reviews_product` → `(shop_id, shopify_product_id, status)`
  - `idx_reviews_customer_product` (partial unique) → `(shop_id, customer_id, shopify_product_id) WHERE customer_id IS NOT NULL AND status <> 'rejected'`
- **`purchases`** — recreate `idx_purchases_due` → `(shop_id, due_at) WHERE reviewed_at IS NULL AND product_opt_out = 0` (the table-constraint change below still needs a rebuild).
- **`sample_invitations`**, **`questions`** — just `ADD COLUMN shop_id`; recreate their plain indexes to lead with `shop_id` if desired (optional).

**Table rebuilds (needed to change an inline/table-level `UNIQUE`):**

| Table | Constraint change | FK children? |
|---|---|---|
| `customers` | `email UNIQUE` → `UNIQUE(shop_id, email)` *(the concrete blocker — two shops can share a customer email)* | yes (purchases, reviews, email_events) |
| `purchases` | `UNIQUE(shopify_order_id, shopify_product_id)` → `UNIQUE(shop_id, shopify_order_id, shopify_product_id)` *(Shopify order ids are per-shop, can collide across shops)* | yes (email_events) |
| `products_cache` | `shopify_product_id UNIQUE` → `UNIQUE(shop_id, shopify_product_id)` *(included — FK-free, cheap; regenerable cache so low-risk either way)* | no |
| `email_templates` | `template_key UNIQUE` → `UNIQUE(shop_id, template_key)` *(included — FK-free; each shop gets its own template set)* | no |
| `banned_reporters` | PK `(email)` → PK `(shop_id, email)` *(included — same painful-later profile as `customers`, FK-free, single read site so minimal seam coupling)* | no |

Each rebuilt/changed table also needs its `ON CONFLICT(...)` target widened to include `shop_id` in the corresponding upsert ([queries.ts](src/db/queries.ts): customers L52, purchases L109, banned_reporters L603, email_templates L997, products_cache L1426). Because `shop_id` carries `DEFAULT 1`, the insert *value* fills itself — so this is a one-line change to the conflict column list per upsert, not seam-threading.

### A3. Rebuild mechanics (the one real implementation risk)

Because the migration runner runs each file inside a transaction with `foreign_keys = ON`, and **`PRAGMA foreign_keys` is ignored inside a transaction**, the classic 12-step rebuild (which sets `foreign_keys=OFF`) will not work here. Use **`PRAGMA defer_foreign_keys = ON`** instead — it *is* honored mid-transaction and defers FK enforcement to `COMMIT`. Per-rebuild pattern:

```sql
PRAGMA defer_foreign_keys = ON;
CREATE TABLE customers_new ( ...same columns + shop_id..., UNIQUE(shop_id, email) );
INSERT INTO customers_new SELECT *, 1 AS shop_id FROM customers;   -- preserve id values
DROP TABLE customers;
ALTER TABLE customers_new RENAME TO customers;
-- recreate any indexes/triggers the table had
```

Because we **preserve `id` values**, every child FK (`purchases.customer_id`, `reviews.customer_id`, `email_events.customer_id`) stays valid and passes the deferred check at commit. Only `customers` and `purchases` have FK children, so they're the only rebuilds needing this care; `products_cache` and `email_templates` are FK-free and rebuild trivially.

**De-risking:** validate the full migration on a copy now, run `PRAGMA foreign_key_check` after, and confirm row counts. The payoff of doing this now is precisely that we exercise the scary rebuild on data we don't mind losing.

### A4. Scope `shop/redact` and the GDPR redact

Independently worthwhile as a safety fix: today `shop/redact` deletes the **entire database** ([webhooks.ts:179](src/routes/webhooks.ts)). Once `shop_id` exists, scope every delete to the redacting shop (resolved from `X-Shopify-Shop-Domain`). For one store this also removes a live foot-gun — a stray redact (test, or 48h post-uninstall) currently nukes everything. `customers/redact` anonymization should likewise be shop-scoped.

### A5. Webhook routing by shop domain (included)

Resolve `X-Shopify-Shop-Domain` → `shop_id` on incoming webhooks (returns the one shop now; 401 on mismatch). Small, defensive, makes handlers shop-aware, and reuses the same "resolve shop from domain" helper that A4's scoped `shop/redact` already requires — so it's a near-free rider. The **dispatcher per-shop loop is *not* in Part A** — wrapping the eligibility query in `for (shop of shops)` is the thin end of threading `shop_id` through the query layer, which Part A deliberately avoids; it lands with per-shop cadence/fairness in B8.

### Explicitly NOT in Part A (stop here)

- **Do not** thread `shop_id` into the rest of the query layer — same cost later, adds bug surface now.
- **`settings` stays global for now** (see deferred B1) — making it per-shop forces the shop seam into every settings read *and every future settings seed* for zero current benefit, and settings data is reconstructable (no painful-later data loss). This is the deliberate line where the "pour schema now" principle stops: it applies to irreplaceable, constraint-heavy data tables, not to reconstructable config.
- **Child/ops tables** (`review_media`, `email_events`, `moderation_events`, `panic_events`, `review_reports`, `banned_reporters`) get no `shop_id` now — they reach their shop via a parent FK, and a denormalized `shop_id` is a cheap `ADD COLUMN` later (no constraint rebuild).

### Testing & rollback

Dev data is disposable, so the safety net is trivial now: snapshot `reviews.db`, apply, run `PRAGMA foreign_key_check` + row-count checks, click through admin + a storefront submit. If anything's off, wipe and re-seed. This is the entire reason to do it now rather than later.

---

## Next sprint — embedded admin via App Bridge (on dev only)

Sequenced after Part A. Replaces the standalone password-protected admin entirely with one embedded inside Shopify admin (App Bridge), built and exercised on the dev store/dev stack until stable. Since there is no live deployment of this app yet, there's no run-mode flag and no parallel admins to maintain — embedded simply *is* the admin once this sprint lands. When the live store eventually installs it, it installs the embedded version.

**Scope of the sprint:**

- **OAuth install flow** (`/auth` and `/auth/callback`) using `@shopify/shopify-api` (the official Node library) — captures the per-shop access token on install and writes it to a new `shops.access_token` column (small migration 017).
- **Session-token (JWT) verification middleware** replaces the password+cookie auth in [src/lib/auth.ts](src/lib/auth.ts). Shopify becomes the identity layer; we store no users.
- **App Bridge in the admin shell** — script loaded in admin HTML, CSP / iframe headers on every admin response so Shopify can frame the app at the right shop origin.
- **Form-auth shim** — a session-token-to-short-lived-cookie exchange so the existing form-heavy admin (`<form method="POST">` everywhere) keeps working without rewriting every form into authenticated `fetch` calls.
- **`getCurrentShopId()` upgrades** from "return 1" to "read shop from the session token / `X-Shopify-Shop-Domain`." Same one function — the seam from Part A is the only place that changes.
- **New "Reviews (dev)" app in the Shopify Partner Dashboard** (Teraclay org), with its client ID/secret in the dev `.env`. The existing custom-app static-token install coexists initially and is uninstalled once the new install is stable.

**Out of scope (still deferred):**

- A second "Reviews (prod)" app in the Partner Dashboard and any live deployment — happens only once embedded is stable on dev. Promotion from dev to prod is a config + deploy event on our side, not a Shopify-side ceremony.
- Encryption-at-rest of per-shop tokens (the deferred half of B5) — overkill for one shop with OS-level disk encryption; revisited at true multi-tenancy.
- A Polaris re-style of the admin UI — App Bridge wraps the existing pages fine; visual restyling stays optional.

**Why this isn't deferred to "post-go-live":** there is no live deployment of this app yet, so there is nothing on the live side to push back. Building on dev now uses the dev environment for what it was meant for (safe development of major changes), and the multi-admin / per-user-attribution benefit kicks in the moment the live store ever does install.

---

## Part B — Deferred until true multi-tenancy is closer (the log)

Each item below is recorded with *why deferring is safe* (almost always: no data-migration penalty — it's additive code/infra, and where a seam is needed Part A already pours it).

**B1. Per-shop `settings`.** Change `settings` PK `(key)` → `(shop_id, key)` and have `getSetting`/`setSetting` filter via `getCurrentShopId()`. *Safe to defer:* settings data is reconstructable; the later change is mechanical (rebuild + two functions), not a data-loss risk. Deferred to avoid threading the seam through every setting read/seed prematurely.

**B2. Denormalized `shop_id` on child/ops tables.** *Safe to defer:* plain `ADD COLUMN`, no constraint rebuild; reachable via parent FK until then.

**B3. Query-layer shop scoping.** Threading `shop_id = getCurrentShopId()` into every query. *Safe to defer:* with one shop the queries are already correct; same cost whenever done.

**B4. OAuth install flow.** *Promoted out of deferred — being done in the "embedded admin" sprint above.* Captures the per-shop access token on install and writes it to `shops.access_token` (migration 017).

**B5. Per-shop secrets + encryption at rest.** Shopify access token and webhook secret move from `.env` to the shop record, encrypted. *Safe to defer, and deliberately so:* moving secrets to the DB only pays off once OAuth is writing them; building token encryption now is premature. Part A keeps secrets in `.env` and puts only *non-secret* per-shop config on the `shops` row.

**B6. Embedded admin via App Bridge + session-token auth.** *Promoted out of deferred — being done in the "embedded admin" sprint above.* Replaces password+cookie auth in [src/lib/auth.ts](src/lib/auth.ts) with Shopify-issued session JWTs verified per request.

**B7. Scalable email / transactional ESP.** Per-shop sender identity + deliverability (SPF/DKIM or verified-sender), per-shop send-rate limits, tenant-isolated suppression. Replaces the single shared Gmail SMTP + single `EMAIL_TOKEN_SECRET` + single `BRAND_NAME`. *Safe to defer:* email sending is stateless infra — nothing to migrate; Gmail's ~500/day is fine for one small store. The plan already flags this as the single largest piece of true multi-tenancy.

**B8. Per-shop cadence & send fairness in the scheduler.** Per-shop cadence settings and fairness/rate-limiting so one large store doesn't starve others or blow a shared sender quota. *Safe to defer:* Part A's optional per-shop dispatcher loop (A5) is the seam; the fairness logic fills in later.

**B9. Per-shop / dynamic CORS.** `/api/*` currently allows one `STOREFRONT_ORIGIN` ([api.ts:29](src/routes/api.ts)). Becomes a per-shop lookup (the `shops.storefront_origin` column from A1 is the home for it). *Safe to defer:* still one origin today; the column is poured now so it's a lookup later, not a schema change.

**B10. Zero-touch onboarding + Theme App Extension / app-embed block.** Self-service setup wizard (App Proxy, brand, cadence with sane defaults) replacing every "walk through it with the owner" step, and a Theme App Extension so the widget drops onto product pages from the theme editor with no code edits. *Safe to defer:* the current `<script>`+`<div>` keeps working; this is additive packaging. The widget JS itself largely carries over (it already self-detects its API base).

**B11. Shopify Billing API.** Plans, trials, recurring charges. *Safe to defer:* purely commercial, zero today, bolt-on.

**B12. App Store listing, review, and compliance.** Listing assets, privacy policy / DPA / ToS, performance budgets (the storefront widget is measured on Core Web Vitals), and the reviewed GDPR/redact webhooks (A4 is a down payment). *Safe to defer:* commercial/process work, no code-coupling now.

**B13. Support & operations tooling.** Per-tenant logging/error tracking, safe shop impersonation/inspection for support, abuse handling, status page, SLA. *Safe to defer:* additive.

**B14. Postgres engine migration (architecture, not hardware).** `better-sqlite3` is synchronous and single-writer-per-file — fine for one store, a throughput ceiling for many concurrent shops regardless of box size. Likely move to Postgres (concurrent writers, pooling, online migrations, PITR). *Caveat that cuts against Part A:* if a Postgres rewrite is imminent, some of the Part A SQLite migration is redone in Postgres — but the *shape* (shop-as-tenant, composite keys) transfers across engines, so the decision still holds. Mitigations now: don't gold-plate the SQLite migration, and lean portable when writing new SQL (mind `unixepoch()`, `INSERT OR REPLACE`).

**B15. Workflow: CI/CD + online migrations + zero-downtime deploys.** Today: edit locally → push Gitea → SSH → `docker compose up --build` on two hand-managed stacks. A public app needs staging, CI/CD, rollback, and migrations that run safely against a live shared multi-tenant DB without taking everyone's storefront widget down at once. *Safe to defer:* process/infra, no schema coupling.

---

## Decisions (settled 2026-05-27)

1. **Include `products_cache` and `email_templates` in the now-pour.** Cost is one `ON CONFLICT` line each plus an FK-free table rebuild; a uniformly shop-keyed schema is worth it. (Both are reconstructable, so this was a genuine judgment call, not a clear win.)
2. **Defer per-shop `settings`** (→ B1). It needs a *primary-key* rebuild (not just an index swap) for reconstructable config, and — deciding factor — its read path (`getSetting` = `WHERE key=?`) would stay un-shop-scoped, so making the PK composite now creates a "works only because there's one shop" trap. Leave settings fully global until we scope its reads. Cost-of-later is low: settings holds no irreplaceable data (new shops seed fresh defaults; our handful of values copy over trivially), so the later change is mechanical, not a risky data migration.
3. **Include webhook shop-domain routing; defer the dispatcher per-shop loop** (loop → B8). Routing is a near-free rider on A4's resolve-shop helper; the loop is the start of query-layer `shop_id` threading, which Part A avoids.
4. **Tenant = shop, confirmed — and orthogonal to user identity.** A Shopify user who is staff on multiple shops is handled entirely by Shopify + App Bridge: the embedded admin receives a per-shop session token asserting "this request is for shop X (and here's the user)," and we serve shop X's data. We store no users table and no who-can-access-what mapping (at most a nullable audit `actor` later). The separate "one account/agency owns several shops with unified billing or cross-shop views" case is a *commercial* construct — an `accounts` table above `shops`, additive and deferred (distinct from multi-shop staff access, which needs nothing from us).
5. **No run-mode flag / dual-admin maintenance** (settled 2026-05-28). An earlier draft had embedded developed alongside standalone via an `APP_MODE` env switch so a live deployment could keep running standalone while embedded matured on dev. That was overengineering: there is no live deployment of the app yet, so there is no second mode to support. Embedded simply replaces standalone. When the live store eventually installs the app, it'll be embedded too. One codebase, one admin, no fork.
6. **Include `banned_reporters` in Part A** (settled 2026-05-28). Discovered during pre-build sanity check: PK is `(email)`, which has the same painful-later constraint profile as `customers.email` (two shops should be able to ban the same email independently). FK-free, single read site, so the seam coupling is minimal. Same rebuild pattern; fold into 016.
