# INSTALL — standing up the Reviews app for a store

> **📚 Documentation map** — Shopify Reviews app. Five maintained docs; this is one of them.
>
> - **`docs/STATE.md`** — What the app does *today*: architecture, feature catalogue, deploy topology. The "current reality" doc.
> - **`docs/INSTALL.md`** — Repeatable, store-agnostic install from scratch: Dev Dashboard app, `.env`, Docker stack, OAuth token capture, webhooks, App Proxy, brand assets.
> - **`docs/OPERATIONS.md`** — Running it in production: deploy & branch/hotfix flow, env-var reference, backups & restore, monitoring, troubleshooting.
> - **`docs/ROADMAP.md`** — What's next, known debts, deferred items, and the "explicitly NOT building" list.
> - **`CHANGELOG.md`** — Dated record of notable changes, one entry per release.

---

This is the repeatable, **store-agnostic** install. Nothing here is specific to migrating off another reviews provider — that one-time work lives in a separate cutover doc and is not part of the ongoing process. Placeholder values use `brandname` / `brandname.com`; substitute the real store.

**Part 1 (deployment prerequisites)** is done once per host/brand. **Part 2 (app install)** is the repeatable per-store/per-stack process.

---

## Part 1 — Deployment prerequisites (once per host)

### 1.1 Host
A machine running Docker, reachable on a private network you control. In this deployment that's **Mercury** (Intel N100, Ubuntu 24.04), joined to a **Tailscale** tailnet. The app's port is published **only on the Tailscale interface** (see the compose `ports:` binding), never `0.0.0.0`.

### 1.2 Public HTTPS ingress — the relay
Mercury keeps zero inbound ports open to the internet. Public traffic arrives through a small always-free cloud VM running **Caddy + Tailscale** that reverse-proxies to Mercury over the tailnet.

1. Create a Google Cloud account, a project (e.g. `shopify-reviews-relay`), and a **budget alert** ($5 threshold, alerts at 50/90/100%) — the always-free tier covers this but the alert is the safety net (egress overage is ~$0.12/GB).
2. Create an **`e2-micro`** VM (look for the "Free tier eligible" tag) in `us-east1`, `us-central1`, or `us-west1` (the always-free regions), Ubuntu 24.04, allow HTTP/HTTPS. **Promote its ephemeral IP to static.**
3. SSH in; install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and join the same tailnet. Verify with `tailscale ping <mercury-tailscale-ip>`.
4. Install Caddy (the cloudsmith apt repo), then `/etc/caddy/Caddyfile`:
   ```
   reviews-dev.brandname.com {
       reverse_proxy <MERCURY_TAILSCALE_IP>:8071
   }
   reviews.brandname.com {
       reverse_proxy <MERCURY_TAILSCALE_IP>:8070
   }
   ```
   `sudo systemctl reload caddy`. Caddy auto-issues Let's Encrypt certs on first request.
5. At your DNS host (Squarespace here), add A records: `reviews` and `reviews-dev` → the relay's static IP.

### 1.3 Gmail SMTP
The app sends through Gmail using the brand's existing alias (e.g. `reviews@brandname.com` configured under **Send mail as**).
1. Enable 2-Step Verification on the Google account.
2. Create an **App Password** at `myaccount.google.com/apppasswords` (name it `shopify-reviews`); copy the 16-char value.
3. Confirm the send-as alias is verified and warning-free in Gmail → Settings → Accounts.
4. SMTP values: host `smtp.gmail.com`, port `587`, user = the Gmail account address, pass = the app password, `SMTP_FROM` = `Reviews <reviews@brandname.com>`.

---

## Part 2 — App install (per store / per stack)

### 2.1 Create the Shopify app (Dev Dashboard — current embedded model)
At `dev.shopify.com` → **Apps → Create app → "Start from Dev Dashboard"**. Name it `Reviews`. Then **Versions → Create version** and configure:

- **App URL**: the embedded-admin entry — `https://reviews.brandname.com/admin` (Shopify loads this in the admin iframe; it serves the App Bridge bootstrap). Not the bare domain.
- **Embed app in Shopify admin**: ✅ **CHECKED** (the admin is embedded via App Bridge).
- **Allowed redirection URL(s)**: `https://reviews.brandname.com/auth/callback` (the app's own `/auth` flow — the primary install path). Also add `http://localhost:3456/auth/callback` for the optional `install-shopify` CLI fallback.
- **Use legacy install flow**: ✅ CHECKED (both the app's `/auth` flow and the CLI use the OAuth grant).
- **Scopes**: `read_orders, read_customers, read_products, read_discounts, write_discounts`
  - `read_orders` covers fulfillment data; `read_customers` is protected data (validates on dev, may need consent on a live store); **`read_discounts` + `write_discounts` are required for campaign discount codes**. Declare exactly the canonical set the code requests — defined once in [`src/shopify/scopes.ts`](../src/shopify/scopes.ts) and used by both install paths.
- **Webhooks API version**: current (matches `SHOPIFY_API_VERSION`).
- **App Proxy** (configure now, at v1 — not later): subpath prefix `apps`, subpath `reviews`, **Proxy URL `https://reviews.brandname.com/proxy/`** (the trailing slash is required). This powers storefront review submit/edit, the brand relay, and campaign/feedback forms.
- **Compliance (GDPR) webhooks**: **not applicable to a custom, single-store app** — there is no field for them. Shopify only requires/exposes the compliance webhooks (and the linked "protected customer data access" process) for **App-Store-distributed** apps. The handlers in `src/routes/webhooks.ts` for `customers/data_request`, `customers/redact`, `shop/redact` sit dormant as a safety net and would only be wired if the app ever goes public. Skip this step.

**Release the version.** Then from **Settings → Credentials**, copy the **Client ID** and **Client secret** (the secret doubles as the webhook signing secret). Paste the secret into `.env` (`SHOPIFY_WEBHOOK_SECRET`) carefully — a trailing space or stray character from copy-paste silently fails OAuth/webhook HMAC verification ("signature invalid").

### 2.2 Create the Docker stack
On the host, create the stack dir (`/opt/stacks/shopify-reviews-prod/` for prod, `/opt/stacks/shopify-reviews-dev/` for dev). Add `docker-compose.yml` (the app service binds `${HOST_BIND_IP}:${HOST_PORT}:8080`; prod `HOST_PORT=8070`, dev `8071`) and a `.env`.

Build `.env` from [`.env.example`](../.env.example). Fill in: the public URL, storefront origin, brand name, `HOST_BIND_IP` (Mercury's Tailscale IP) + `HOST_PORT`, the Shopify Client ID + secret (as `SHOPIFY_WEBHOOK_SECRET`), the API version, a **freshly generated** `EMAIL_TOKEN_SECRET` (`openssl rand -hex 32` — never reuse dev's), and the Gmail SMTP values. Leave `SHOPIFY_ADMIN_TOKEN` empty for now. Per-variable docs are in [OPERATIONS.md](OPERATIONS.md).

Bring it up: `sudo docker compose up -d --build`. Confirm migrations + seeds ran cleanly: `docker compose logs reviews-app | grep -i 'migration\|listening'`.

### 2.3 Install the app on the store (OAuth)
With the stack running and reachable at its public HTTPS URL, install via the app's **own** OAuth flow — logged into the target store's Shopify admin, visit:
```
https://reviews.brandname.com/auth?shop=<store>.myshopify.com
```
Approve the scopes. The app exchanges the code for a **permanent OFFLINE** token (`shpua_…`; it rejects online/expiring tokens), **persists it to `shops.access_token` in the DB** (the Admin API client prefers this over `SHOPIFY_ADMIN_TOKEN`), and lands you in the embedded admin. No token copy-paste; `SHOPIFY_ADMIN_TOKEN` in `.env` stays empty.

Prereqs: the public HTTPS URL must already serve (the callback returns to `https://reviews.brandname.com/auth/callback`, which must be an Allowed redirection URL), and `SHOPIFY_WEBHOOK_SECRET` must exactly match the app's client secret (a mismatch fails the callback with "signature invalid").

**Alternative — `install-shopify` CLI** (e.g. before the stack is up, or for an env-var token model): from your workstation with `SHOPIFY_CLIENT_ID` + `SHOPIFY_WEBHOOK_SECRET` available, `npm run install-shopify:dev -- --shop <handle>` runs the grant via a `localhost:3456` listener and prints the token to paste into `.env` as `SHOPIFY_ADMIN_TOKEN`, then `docker compose up -d --force-recreate`. (Pass the creds as real env vars or a dedicated env file — a stray `.env` already loaded will override them.)

### 2.4 Subscribe webhooks
Webhooks are **not** auto-subscribed on install. After installing via `/auth` (token in the DB, not `.env`), run on the host — it reads the token from the DB and passes it in:
```
docker exec -e SHOPIFY_SHOP_DOMAIN=<store>.myshopify.com \
  -e SHOPIFY_ADMIN_TOKEN="$(docker exec <container> sqlite3 /app/data/reviews.db \
      "SELECT access_token FROM shops WHERE shop_domain='<store>.myshopify.com'")" \
  -e PUBLIC_URL=https://reviews.brandname.com \
  <container> node dist/scripts/install-webhooks.js
```
(`<container>` is `reviews-app-prod` / `reviews-app-dev`.) If instead you used the CLI and `SHOPIFY_ADMIN_TOKEN` is in `.env`, a plain `npm run install-webhooks` (or `docker exec <container> node dist/scripts/install-webhooks.js`) works. It idempotently subscribes `orders/paid` and `orders/fulfilled` to `PUBLIC_URL/webhooks/...`. (GDPR topics aren't subscribed here — see 2.1.)

### 2.5 Brand assets
Set the store's colors + logo in Shopify **Settings → Brand** *before* the first storefront visit, so the **brand relay** populates on first load. The theme's widget `<div>` carries `data-brand-*` attributes (guard the logo: `{% if shop.brand.logo %}…{% endif %}`); the widget posts them to `/proxy/brand`. If brand data isn't set, use **manual entry** in the admin Branding page as the fallback. `shop_brand_json` stays empty until either path runs.

### 2.6 Verify
```
curl http://<MERCURY_TAILSCALE_IP>:8070/health      # from the host, over Tailscale
curl https://reviews.brandname.com/health           # from outside, through the relay
```
Both should return `{"status":"ok"}`. Then load a product page on the storefront and confirm the widget renders and (if a customer is logged in) submission works.
