# External Accounts Setup — Shopify, Cloudflare, Gmail

You can work through these in any order, but the **Gmail app password** is the fastest, **Shopify** has the most steps, and **Cloudflare** has DNS propagation delays so kicking it off early is helpful.

When something asks you to copy a value (token, password, etc.), paste it into a temporary plain-text note. We'll move them all into proper `.env` files together later. Don't email these values to yourself or save them in cloud-synced docs — local plaintext is fine for the next few days.

---

## Part 1 — Gmail (≈10 minutes)

You already have the brand's Gmail account and a `reviews@brandname.com` alias set up to "send mail as" through it. We just need an **app password** so the reviews server can send mail through Gmail without using your real password.

### 1.1 — Confirm 2-Step Verification is on

App passwords only exist if 2-Step Verification is enabled on the Google account.

1. Go to **myaccount.google.com** while signed in to the brand Gmail account.
2. Left sidebar → **Security**.
3. Look for "2-Step Verification" — should say "On". If it says "Off", turn it on now (Google walks you through SMS/authenticator setup).

### 1.2 — Generate the app password

1. Same Security page, search for **"App passwords"** in the page or go directly to **myaccount.google.com/apppasswords**.
2. If you don't see it, it's because 2-Step is not on yet — fix that first.
3. Under "App name" (or "Select app"), type **`shopify-reviews`** and click **Create**.
4. Google shows a **16-character password** in a yellow box (4 groups of 4 letters). **Copy this immediately** — once you close the dialog, you can't see it again.
5. Save it in your temp notes as:
   ```
   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
   ```
   (Spaces don't matter — Gmail accepts with or without them.)

### 1.3 — Confirm the alias is working

Open Gmail's **Settings → Accounts and Import → "Send mail as"** section. You should see `reviews@brandname.com` listed with no warning indicator next to it.

If it's not there or shows a warning, this is the first thing to fix — the rest of the project depends on the alias working. Tell me and we'll troubleshoot together.

---

## Part 2 — Shopify (≈30 minutes)

You already have the live brand store. We need three things:

1. A free **Partners account** (lets you spin up a sandbox dev store).
2. A **dev store** for testing without touching the live one.
3. **Admin API tokens** for both the dev store and the live store, so the reviews app can read products / customers / orders.

### 2.1 — Create a Shopify Partners account

1. Go to **partners.shopify.com**.
2. Click **"Join now"** (or "Sign up").
3. Use the brand's primary Gmail address.
4. Account type: **Merchant** is fine, or **Other** if asked.
5. Confirm the email Shopify sends you.

### 2.2 — Create a development store

1. In the Partners dashboard left sidebar: **Stores → Add store**.
2. Store type: **Development store** (free, no time limit, but **cannot** be transferred to a real merchant later — that's fine, we just need it for testing).
3. Purpose: **"Build a new app or theme"** or **"Create a store to test or build for myself"** — either works.
4. Store name: something like **`brandname-dev`** (this becomes `brandname-dev.myshopify.com`).
5. Login email: same as your Partners account.
6. Skip data import questions; defaults are fine.
7. After creation: **log in to the dev store admin** (it's at `brandname-dev.myshopify.com/admin`).

### 2.3 — Add a few test products to the dev store

1. Dev store admin → **Products → Add product**.
2. Create 2 or 3 simple products. Title, description, price — anything. Add one image each so the widget has something to render.
3. Make sure each is set to **Active** and **Online Store** is in the sales channels.
4. We'll use these later to test the full review flow without ever touching the live store.

### 2.4 — Get an Admin API token (DEV STORE)

This is the long part — Shopify hides it under "Develop apps" which is itself behind a setting that's off by default.

1. Dev store admin → **Apps** (left sidebar) → top of page, click **"Develop apps"**.
2. If you see a **"Allow custom app development"** prompt: click it, accept the warning, click **Allow**. (You only do this once per store.)
3. Click **"Create an app"** in the top-right.
4. Name: **`Reviews`**. App developer: your account. Click **Create app**.
5. On the new app's page → **Configuration** tab → **Admin API integration → Configure**.
6. Check these scopes (use the search box):
   - `read_products`
   - `read_product_listings`
   - `read_customers`
   - `read_orders`
   - `read_fulfillments`
   - `read_inventory` (only if needed later — skip for now)
7. Click **Save**.
8. Switch to the **API credentials** tab.
9. Click **Install app** → **Install** to confirm.
10. After install, the page shows:
    - **Admin API access token** — click "Reveal token once". **Copy immediately.** Save as `SHOPIFY_ADMIN_TOKEN_DEV=...`. Starts with `shpat_`.
    - **API key** — visible normally. Save as `SHOPIFY_API_KEY_DEV=...`.
    - **API secret key** — click "Reveal" to see. Save as `SHOPIFY_API_SECRET_DEV=...`.

The API secret is what we'll use for HMAC-verifying webhooks later. The Admin API token is what authenticates our outbound calls to Shopify.

### 2.5 — Get an Admin API token (LIVE BRAND STORE)

Same procedure, on the live store admin (`brandname.myshopify.com/admin` or your custom admin URL):

1. **Apps → Develop apps → Allow custom app development** (one time).
2. **Create an app** named `Reviews`.
3. Same scopes as above.
4. Install → reveal Admin API token, API key, API secret.
5. Save as:
   - `SHOPIFY_ADMIN_TOKEN_PROD=shpat_...`
   - `SHOPIFY_API_KEY_PROD=...`
   - `SHOPIFY_API_SECRET_PROD=...`

**Important:** The live store token gives the reviews app real access to your real customers and orders. Keep these notes private and we'll move them straight into the `.env` file once we deploy.

### 2.6 — Take note of your store domains

For `.env` setup, we'll need:
- Dev myshopify domain: `brandname-dev.myshopify.com` (whatever you actually named it)
- Live myshopify domain: `brandname.myshopify.com` (the underlying Shopify hostname, **not** your custom storefront domain)
- Live custom storefront origin: the URL your customers actually visit, e.g. `https://www.brandname.com` (this becomes the CORS allowlist)

---

## Part 3 — Cloudflare (≈20 minutes active + several hours DNS propagation)

We need a free Cloudflare account, plus DNS for the `reviews` and `reviews-dev` subdomains delegated from Squarespace to Cloudflare.

### 3.1 — Sign up

1. Go to **dash.cloudflare.com/sign-up**.
2. Use the brand's Gmail.
3. Confirm email.

Stay on the **Free** plan throughout — everything we need is on free.

### 3.2 — Add the subdomain as a zone

This is the unusual part. We're not handing the whole `brandname.com` to Cloudflare — only `reviews.brandname.com`. Squarespace stays in charge of the apex zone (your storefront, MX records, etc.).

1. Cloudflare dashboard → **Add a domain** (or "Add site") in the top nav.
2. In the input box, type **`reviews.brandname.com`** (the full subdomain, not the apex).
3. Click **Continue**.
4. Plan: **Free**. Click **Continue**.
5. Cloudflare offers to scan existing DNS — there will be nothing to import for a brand-new subdomain. Skip / Continue.
6. Cloudflare shows you **two nameservers** (sometimes four) like `xxx.ns.cloudflare.com` and `yyy.ns.cloudflare.com`. **Copy these.**

Some accounts get prompted that adding a subdomain zone requires a higher plan. If that happens, tell me — there's a workaround using a CNAME from Squarespace to a Cloudflare-hosted hostname, but it changes the Tunnel setup. Free-tier subdomain zones do work for most accounts, just not all.

### 3.3 — Delegate the subdomain at Squarespace

1. Log in to **Squarespace → Settings → Domains** for `brandname.com`.
2. Open **DNS settings** (the panel that shows A, CNAME, MX records).
3. **Add a new record**:
   - Type: **NS**
   - Host: `reviews` (just the word "reviews" — Squarespace will append `.brandname.com`)
   - Data/Value: the first Cloudflare nameserver, e.g. `xxx.ns.cloudflare.com`
4. **Add another NS record** for the same host `reviews`, value: the second Cloudflare nameserver.
5. (If Cloudflare gave 4, add all 4 — repeat the same `reviews` host with each value.)
6. Repeat the entire set with host `reviews-dev` so we have both subdomains delegated. (Saves a future trip back to Squarespace.)
7. Save changes.

### 3.4 — Wait for DNS propagation

DNS changes can take anywhere from minutes to several hours. While you wait:

1. Go to **dnschecker.org**.
2. Look up `reviews.brandname.com` with type **NS**.
3. You should eventually see green checkmarks worldwide showing the Cloudflare nameservers. Once that happens, Cloudflare's dashboard will also show the zone as **Active**.

You don't have to babysit this — move on to other tasks and check back in a few hours.

### 3.5 — Create the Cloudflare Tunnel (after the zone is Active)

Once Cloudflare shows your zone as Active, come back and:

1. Cloudflare dashboard → **Zero Trust** (left sidebar, lower section).
2. **Networks → Tunnels → Create a tunnel**.
3. Connector type: **Cloudflared**.
4. Tunnel name: **`reviews-mercury`**.
5. Click **Save tunnel**.
6. On the next screen ("Install and run a connector"), choose **Docker** as the environment.
7. Cloudflare shows a `docker run` command — inside that command is a `--token eyJ...` value. **Copy the entire token string** (the long base64-ish blob).
8. Save as `CLOUDFLARED_TOKEN=eyJ...` in your notes.
9. **Don't actually run** the docker command Cloudflare shows you — we'll integrate it into the project's docker-compose instead.

### 3.6 — Add public hostnames to the tunnel

Same Tunnels page → click the `reviews-mercury` tunnel → **Public Hostname** tab → **Add a public hostname**:

1. **First hostname** (dev):
   - Subdomain: `reviews-dev`
   - Domain: `brandname.com` (should be selectable from a dropdown once the zone is Active)
   - Type: **HTTP**
   - URL: `reviews-app:8080`
   - Save.
2. **Second hostname** (prod) — repeat with subdomain `reviews`, same URL `reviews-app:8080`.

The `reviews-app:8080` is the internal Docker service name + port. Both hostnames will point at this same string; the Tunnel runs inside the same Docker network as the app and resolves the name. Each environment (dev vs. prod) has its own Docker stack, so each has its own `reviews-app` container — they don't conflict.

---

## Summary — what you should have when done

A plain-text note that looks something like this (real values filled in):

```
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
GMAIL_SEND_AS_ADDRESS=reviews@brandname.com
GMAIL_SMTP_USERNAME=brandname.gmail.address@gmail.com

SHOPIFY_DEV_DOMAIN=brandname-dev.myshopify.com
SHOPIFY_ADMIN_TOKEN_DEV=shpat_...
SHOPIFY_API_KEY_DEV=...
SHOPIFY_API_SECRET_DEV=...

SHOPIFY_PROD_DOMAIN=brandname.myshopify.com
SHOPIFY_STOREFRONT_ORIGIN=https://www.brandname.com
SHOPIFY_ADMIN_TOKEN_PROD=shpat_...
SHOPIFY_API_KEY_PROD=...
SHOPIFY_API_SECRET_PROD=...

CLOUDFLARED_TOKEN=eyJ...
```

Tell me when you have all three parts done (or when one is blocking you) and we'll move into deployment. Plus tell me about anything that didn't match the steps above — Shopify and Cloudflare both occasionally rearrange their UI, and the steps above reflect what they look like as of early 2026.
