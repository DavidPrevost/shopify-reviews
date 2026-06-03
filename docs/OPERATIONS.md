# OPERATIONS — running, maintaining, and debugging the Reviews app

> **📚 Documentation map** — Shopify Reviews app. Five maintained docs; this is one of them.
>
> - **`docs/STATE.md`** — What the app does *today*: architecture, feature catalogue, deploy topology. The "current reality" doc.
> - **`docs/INSTALL.md`** — Repeatable, store-agnostic install from scratch: Dev Dashboard app, `.env`, Docker stack, OAuth token capture, webhooks, App Proxy, brand assets.
> - **`docs/OPERATIONS.md`** — Running it in production: deploy & branch/hotfix flow, env-var reference, backups & restore, monitoring, troubleshooting.
> - **`docs/ROADMAP.md`** — What's next, known debts, deferred items, and the "explicitly NOT building" list.
> - **`CHANGELOG.md`** — Dated record of notable changes, one entry per release.

---

## Deploy & branch model

- **`main` = production** (`/opt/stacks/shopify-reviews/`, port 8070, `reviews.teraclay.com`). **`develop` = development** (`/opt/stacks/shopify-reviews-dev/`, port 8071, `reviews-dev.teraclay.com`).
- Code is **written on Windows** (`D:\AI\shopify-reviews\`), pushed to **Gitea** on Mercury (`http://100.117.6.18:3000/kymermosst/shopify-reviews.git`), then pulled on the host.
- **Normal loop:** edit → `npm run typecheck` + `npm run build` + `npx tsx tests/run-all.ts` locally → commit → push → on Mercury `git pull` in the stack dir → `sudo docker compose up -d --build` → verify `/health`.
- **Never deploy to prod without validating on dev first.** Hotfixes made on `main` merge back to `develop`.
- The Windows dev machine does **not** run Docker — all app execution is on Mercury (remote-execution model).

### The `.env` change rule ⚠
The container reads env vars **at creation only**, and `config.ts` exports a frozen object (nodemailer also builds a singleton transport on first send). `docker restart` keeps the old injected env. To pick up an `.env` change:
```
cd /opt/stacks/shopify-reviews-{dev,prod}
docker compose up -d --force-recreate      # or: docker compose down && docker compose up -d
```
This matters most at cutover when generating fresh secrets — a `docker restart` will silently keep the old values.

---

## Environment variables

Build a stack's `.env` from [`.env.example`](../.env.example). Reference:

| Var | Purpose |
|---|---|
| `PORT` | Container-internal listen port (fixed `8080`; the host maps `HOST_PORT`→8080). |
| `TZ` | Process/OS timezone (display + the backup sidecar). The dispatcher schedule itself is handled via the admin's local-time picker, stored as UTC. |
| `PUBLIC_URL` | The stack's public HTTPS URL; used to build webhook callback URLs and email links. |
| `STOREFRONT_ORIGIN` | Allowed CORS origin for the public `/api/*` read endpoints. |
| `BRAND_NAME` | Default sender/brand name in emails. |
| `HOST_BIND_IP` | Mercury's Tailscale IP — restricts the published port to the tailnet (read by docker-compose, not the app). |
| `HOST_PORT` | Published host port: `8070` prod, `8071` dev (read by docker-compose). |
| `REVIEWS_CONTAINER_NAME` / `REVIEWS_BACKUP_CONTAINER_NAME` | Container names (compose interpolation). Each stack sets them explicitly — dev uses `reviews-app-dev`/`reviews-backup-dev`, prod uses `reviews-app-prod`/`reviews-backup-prod` — so there's no ambiguous bare name and the stacks can't collide on one host. Use the matching name in `docker exec` commands. |
| `SHOPIFY_SHOP_DOMAIN` | `<store>.myshopify.com`. |
| `SHOPIFY_CLIENT_ID` | App client ID / API key (public; also the App Bridge key). |
| `SHOPIFY_ADMIN_TOKEN` | Offline Admin API token from `install-shopify` (`shpua_…`). Fallback only — the per-shop `shops.access_token` written by OAuth takes precedence once present. |
| `SHOPIFY_WEBHOOK_SECRET` | The app's **client secret**. One value, three jobs: webhook HMAC, OAuth callback signing, embedded-admin session-token (JWT) verification. |
| `SHOPIFY_API_VERSION` | Admin/GraphQL API version (e.g. `2026-01`). |
| `EMAIL_TOKEN_SECRET` | HMAC secret for signed review-link / unsubscribe tokens. **Generate fresh per environment** (`openssl rand -hex 32`); never reuse dev's in prod. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Gmail SMTP config (app password as `SMTP_PASS`). |
| `DEV_NOTIFICATION_EMAIL` | Operator notifications (panic activations, etc.). Empty = skip. |

**Removed (do not re-add):** `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `ADMIN_SESSION_TTL_DAYS` — the password-admin model is gone; auth is App Bridge session tokens. `config.ts` no longer reads them. Optional `DATA_DIR` defaults to `./data` (the compose volume mounts host `./data` → `/app/data`); `DISPATCHER_CRON` can override the schedule for tests.

---

## Backups & restore

- A **backup sidecar** container snapshots the SQLite DB nightly (3 AM, `scripts/backup.sh`) to **`/opt/stacks/shopify-reviews-{dev,prod}/data/snapshots/`** and rsyncs to **Pebbles** (`/opt/backups/…`) over Tailscale. Rotation: 7 daily + 4 weekly.
- **Restore:** stop the app, replace `data/reviews.db` with a snapshot, `docker compose up -d`.
- **Snapshot before every migration.** It's the primary recovery path (see Rollback below).
- Note: the backup snapshots the DB, **not** `data/uploads/` (logos). Extend `backup.sh` if logo durability across host loss matters.

## Monitoring / health

- `curl https://reviews.teraclay.com/health` → `{"status":"ok"}` exercises relay → Tailscale → container.
- Logs: `sudo docker compose logs --tail=100 reviews-app | grep -i 'migration\|error'` (and look for `dispatcher scheduler registered`).
- Drop into the DB: `docker exec -it reviews-app-dev sqlite3 /app/data/reviews.db` — substitute your stack's container name (`reviews-app-dev` / `reviews-app-prod`) in every `docker exec` example here.

---

## Conventions & gotchas (read before changing code)

These are reproducible traps surfaced during the build/testing rounds. A maintainer who knows them avoids re-deriving them.

- **Suppression rules live in the eligibility SQL** (`src/db/queries.ts`), not scattered TS. New cadence rules go in as `AND` clauses there. The three respect rules (already-reviewed, global opt-out, product opt-out) are never bypassable.
- **Migrations are tracked by filename** (`_migrations` table), not content-hashed. Editing an already-applied migration's text is safe (won't re-run); a *new* migration must be a new numbered file.
- **Hono matches routes in registration order.** Register literal routes **before** their `/:param` siblings, or the literal gets swallowed (e.g. `/retention-queue` must precede `/:id`; `/new` before `/:key`). Bitten twice.
- **Embedded-admin first-keystroke cursor bug.** In any pre-filled multi-line `<textarea>` inside the Shopify admin iframe, the first keystroke lands at position (0,0). Fix: mark it `class="…"`, apply `renderTextareaCursorFixScript()` (`src/lib/admin-textarea-fix.ts`), and drop `autocomplete/autocorrect/autocapitalize/spellcheck`. Apply to any new pre-filled admin textarea. (The Branding→Email main body is a `contenteditable` div — a Range-based variant would be needed there; flagged in ROADMAP.)
- **Nested `<form>` silently breaks the outer form.** Browsers close the outer form at an inner one, orphaning its submit button (no error). Make the inner action a sibling form with an id and associate the button via `form="id"`. Canonical example: `renderRefreshProductsForm()`.
- **`filter: blur()` desyncs textarea cursors.** Don't use CSS `filter` on inputs you want to type in (auto-reveal on focus instead).
- **Backticks inside comments inside backtick template literals** close the literal and produce a misleading `',' expected.` build error. Escape or paraphrase.
- **`SMTP_FROM` display name vs `branding.senderName`:** `smtp-client.ts` extracts just the address from `SMTP_FROM` and applies the per-shop sender name/reply-to for customer-facing sends. Operator notifications intentionally use the raw from.
- **Email CTA button = Widget config.** The dispatcher and campaign email paths style the button via `resolveWidgetConfig()` — change it in Branding → Widget and both the storefront button and email button change. The per-template `cta_label` column is preserved but ignored at render.
- **Email kill switch** (`emails_disabled`, Settings → **Setup**) blocks every `sendMail` at the source (returns `BLOCKED_BY_KILL_SWITCH`). Use it to go live collecting reviews while sending no email.
- **Cadence dev toggles** (Settings → Cadence, default OFF): `dispatch_immediately_on_fulfillment` (skips `request_delay_days` in the fulfilled webhook only — **not** backfill), `bypass_cadence_min_days`, `bypass_cadence_max_requests`. Surfaced in `DispatchResult.bypassed`.
- **Audit reads of `productOptOut`/`maxRequestsHit` are legitimately 0** even when suppression worked — terminal suppressions null `due_at`, which removes the row from the audit candidate set. Not a bug.
- **Dispatcher schedule is set in local time** via the Settings → Cadence picker (browser converts to/from the UTC `dispatcher_hour`/`dispatcher_minute`; node-cron runs UTC). Changing it re-registers the cron live (no restart).

---

## Troubleshooting playbook

- **App Proxy returns 404 (storefront submit / brand relay / campaign forms).** The proxy isn't configured on the store, or the version is stale. Diagnose directly: `curl -i -X POST http://<mercury-tailscale-ip>:807x/proxy/brand` — **401 `invalid_signature`** means the route exists and you just need a real signed request (good); **404** means the App Proxy isn't set up (prefix `apps`, subpath `reviews`, Proxy URL `…/proxy/` with trailing slash) or you're on old code.
- **Brand colors aren't importing.** Confirm they're set in Shopify **Settings → Brand** (not just theme schemes); confirm the theme div emits non-empty `data-brand-*` (guard the logo with `{% if shop.brand.logo %}`); confirm the App Proxy is configured; the relay fires once per browser session (`sessionStorage['rv-brand-relayed']` — clear to re-fire). Manual entry in Branding is the fallback.
- **Widget changes not showing.** `widget.js` is served `stale-while-revalidate` (~24h browser cache). Use DevTools "Disable cache" + hard reload, or incognito with cache disabled, to guarantee the fresh bundle. Rebuild (`npm run build`) regenerates `public/widget.js`.
- **Webhooks not firing** (orders paid/fulfilled produce no log lines). They aren't auto-subscribed on install — run `install-webhooks`. Recipe using the per-shop DB token from inside the container:
  ```
  docker exec -e SHOPIFY_SHOP_DOMAIN=<store>.myshopify.com \
    -e SHOPIFY_ADMIN_TOKEN="$(docker exec reviews-app-dev sqlite3 /app/data/reviews.db \
        "SELECT access_token FROM shops WHERE shop_domain='<store>.myshopify.com'")" \
    -e PUBLIC_URL=https://reviews.teraclay.com \
    reviews-app-dev node dist/scripts/install-webhooks.js
  ```
- **Curl from Mercury must use the Tailscale IP** (`100.117.6.18:807x`), not `localhost` — the app binds the tailnet interface.
- **PowerShell `curl` is `Invoke-WebRequest`** (different flags). Use `curl.exe` or run from inside the container.

---

## Common operational tasks

- **Backfill recent orders:** Settings → Setup → "Run backfill" (or `npm run backfill`). Respects the go-live cutoff; always uses `request_delay_days` (the immediate-on-fulfillment toggle does not apply to backfill).
- **Force a dispatcher run:** Settings → Setup → "Run dispatcher" (or `npm run dispatch`). *(Both manual-ops buttons currently dump raw JSON — friendly banners are a logged fast-follow.)*
- **Set the go-live cutoff guard:** Settings → Cadence → "Set cutoff to now" — do this immediately after the first prod backfill so pre-launch customers aren't emailed.
- **Refresh product cache:** Settings → Setup → "Refresh product cache" (flushes `products_cache`; next storefront load re-fetches, picking up metafield changes; TTL is otherwise 1h).
- **Pause everything (panic):** the "Pause reviews" control sets `panic_paused_until`; auto-expires, or resume manually.

## Tests
`npx tsx tests/run-all.ts` runs 10 files (~121 assertions) against fresh temp DBs, including a boot smoke test. Run after any non-trivial `src/` change, before commit. `npm run build` catches type errors `tsx` is permissive about.
