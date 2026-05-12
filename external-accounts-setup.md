# External Accounts Setup — Shopify, Google Cloud, Gmail

You can work through these in any order, but the **Gmail app password** is the fastest, **Shopify** has the most steps, and the **Google Cloud** signup can have a verification delay so it's worth kicking off early.

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

## Part 2 — Shopify (≈45 minutes)

> **Important — Shopify's app development structure changed in late 2025 / early 2026.** The old "store admin → Apps → Develop apps" flow that produced static Admin API tokens for single-store custom apps was **deprecated for merchant-owned stores effective January 1, 2026.** New apps now go through Shopify's **Dev Dashboard** at `dev.shopify.com`, and obtaining an Admin API access token requires a one-time install via OAuth. The token is still permanent once obtained — only the *path to it* is different.

The pieces we need:

1. A **Dev Dashboard account** (org-level — replaces the old "Partners account").
2. A **development store** for testing without touching the live brand store.
3. The **Reviews app** itself, created at the org level in the Dev Dashboard.
4. **Admin API access tokens** for both the dev store and the live store (one per install).

If you've already started this setup before reading this doc, sections 2.1, 2.2, and possibly 2.4 may already be done — skim and skip ahead.

### 2.1 — Sign up for the Shopify Dev Dashboard

1. Go to **dev.shopify.com** → sign in (or create a free account).
2. Use the brand's primary Gmail address.
3. The dashboard is one consolidated UI: **Apps**, **Stores**, **Catalogs**, **Organization**. There's no separate "Partners" account anymore.
4. Note your **organization ID** from the URL — it appears in every dashboard path as `/dashboard/<org-id>/...`.

### 2.2 — Create a development store

1. Sidebar → **Stores** → top-right **Create store**.
2. Pick **Development store** (free, no time limit; can't be transferred to a real merchant — fine for our purposes).
3. Store name: something like **`<brand>-dev`** (becomes `<brand>-dev.myshopify.com`).
4. Skip data-import prompts; defaults are fine.
5. Once created, the store appears in the Stores tab. Click it to open the dev-store admin in a new tab.

### 2.3 — Add a few test products to the dev store

1. Dev-store admin → **Products → Add product**.
2. Create 2–3 simple products. Title, description, price — anything. Add one image each so the storefront widget has something to render.
3. Set each to **Active** with **Online Store** in the sales channels.
4. We'll use these later to test the full review flow without ever touching the live store.

### 2.4 — Create the "Reviews" app

1. Dev Dashboard → sidebar → **Apps** → top-right **Create app**.
2. You'll see two paths. Pick **"Start from Dev Dashboard"** (the right-hand panel labeled *"Add scopes to quickly generate API credentials"*) — *not* the Shopify CLI option, which scaffolds a distributable app with embedded admin.
3. App name: **`Reviews`** → click **Create**.
4. You'll land on a "Create version" page. Submitting that form would create the app *and* immediately release a default version with `https://example.com` as the App URL, embedded admin enabled, and no scopes — none of which is right for our use case. **Don't fill out and submit that form yet.** Instead, navigate away (e.g., click your app name in the sidebar to go to the overview) — the app already exists at this point. You may see an initial `reviews-1` version with default settings; we'll override it in the next step.

### 2.5 — Configure and release a proper app version

Versions in the Dev Dashboard are immutable — every config change is a new released version. We'll create `reviews-2` with the right config.

1. Reviews app sidebar → **Versions** → top-right **Create version**.
2. Fill in:
   - **App URL**: `https://example.com` (cosmetic placeholder — only used by Shopify when merchants click into an embedded admin, which we're disabling)
   - **Embed app in Shopify admin**: **UNCHECK** ← critical (we have our own admin UI at `reviews.<brand>.com/admin`, not embedded in Shopify)
   - **Webhooks API version**: `2026-04` (latest, default)
   - **Scopes** (required, comma-separated): `read_orders, read_customers, read_products`
     - *The old `read_fulfillments` scope is gone; `read_orders` covers fulfillment data.*
     - *`read_customers` is "protected customer data." It validates fine on dev stores; for the live store install it may show an extra consent screen.*
     - *`write_metafields` (for v2 merchant replies) gets added in a later version — not needed for MVP.*
   - **Optional scopes**: leave blank
   - **Use legacy install flow**: **CHECK** ← critical (the default "Token Exchange" install flow requires App Bridge and embedded admin, which we don't use; legacy flow is the standard OAuth grant flow)
   - **Redirect URLs**: `http://localhost:3456/auth/callback`
     - *This is where Shopify sends the OAuth callback during install. We'll capture the token there with a one-shot local listener — see 2.6.*
3. Click **Release** (top-right). Confirm in the modal (you can skip the optional version name/message).
4. Version list should now show `reviews-2 Active`.

### 2.6 — Note the app's Client ID and Client Secret

These are app-level credentials shared across all installs. The secret is also the **webhook signing secret** — same value, dual purpose.

1. Reviews app sidebar → **Settings** → **Credentials** section.
2. Copy **Client ID** (visible by default).
3. Click **Reveal client secret** → copy it.
4. Save to your temp note:
   ```
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...           # also used as SHOPIFY_WEBHOOK_SECRET
   ```

### 2.7 — Install on the dev store, capture the Admin API access token

This is the modern equivalent of the old "reveal token once" button. The install kicks off an OAuth grant flow; the access token is returned in the callback. We capture it with a tiny local script.

**The dev team will provide a `scripts/install-shopify.ts` helper** that does the full dance:

- Opens a local HTTP listener on `http://localhost:3456/auth/callback`
- Opens your browser to:
  `https://<shop>.myshopify.com/admin/oauth/authorize?client_id=<id>&scope=read_orders,read_customers,read_products&redirect_uri=http://localhost:3456/auth/callback&state=<nonce>`
- After you click Install on Shopify's consent screen, Shopify redirects to `localhost:3456/auth/callback?code=...`
- The script exchanges the `code` for an access token by POSTing to `https://<shop>.myshopify.com/admin/oauth/access_token` with the client ID + secret
- The script prints the access token; you paste it into your temp note

> Status note for the dev: the `install-shopify` script doesn't exist yet — it's part of project setup. It runs once per store, then is never needed again unless you add a new store. Reference: Shopify's "Authorization code grant" flow, https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant.

Run:
```
npm run install-shopify -- --shop <brand>-dev
```

Save:
```
SHOPIFY_DEV_DOMAIN=<brand>-dev.myshopify.com
SHOPIFY_ADMIN_TOKEN_DEV=shpat_...                    # starts with shpat_
```

> **Alternative if the install-shopify script isn't ready yet:** the Reviews app overview page in the Dev Dashboard has an **"Install app"** button (top-right of the Installs section). Clicking it triggers a special `redirect_from_developer_dashboard` flow that may bypass the redirect URL entirely and complete the install via Shopify's UI. After install, the Installs section of the app should expose the per-install Admin API access token. **This path is unverified at the time of writing — try it once on the dev store and let us know what you see.**

### 2.8 — Repeat the install for the live brand store

Same flow as 2.7, with the install target swapped to the live store (`<brand>.myshopify.com`):

```
npm run install-shopify -- --shop <brand>
```

The OAuth consent screen on the live store will tell you exactly what data the Reviews app can access. **Read it before clicking Install** — granting these scopes gives the app real read access to your live customers and orders.

Save:
```
SHOPIFY_PROD_DOMAIN=<brand>.myshopify.com
SHOPIFY_ADMIN_TOKEN_PROD=shpat_...
```

### 2.9 — Note your storefront origin

For `.env` setup, the dev/prod stacks need to know the URL customers actually visit (becomes the storefront-API CORS allowlist):

```
SHOPIFY_STOREFRONT_ORIGIN=https://www.<brand>.com
```

This is your custom storefront domain, *not* the `.myshopify.com` admin domain.

### 2.10 — Things to verify with us

This doc makes a couple of educated guesses about parts of the install flow that weren't end-to-end tested while it was being written. Tell us if reality differs:

1. **What appears in the Installs section of the app after a successful install** — specifically, whether the Admin API access token is visible there as a fallback if the OAuth callback capture fails.
2. **Whether `read_customers` validates and grants normally during the live-store install** — it's classified as "protected customer data" and may trigger an extra approval prompt or require us to fill out a "Request access" form.
3. **Whether the "Install app" button's `redirect_from_developer_dashboard` flow can be used instead of the OAuth-with-localhost-listener path.** If yes, we simplify 2.7 considerably.

---

## Part 3 — Public ingress: Google Cloud + Caddy + Tailscale (≈45 minutes)

We'll use a tiny always-free virtual machine on Google Cloud Platform (GCP) as a doorway from the public internet to Mercury. The reviews app stays on Mercury; the VM just relays traffic.

In plain terms:
- A small Linux machine in Google's data center is given the public DNS name `reviews.brandname.com`.
- That machine joins your Tailscale network (so it can reach Mercury privately, the same way your laptop can).
- A piece of software called **Caddy** runs on the machine; it auto-fetches HTTPS certificates and forwards every request to Mercury.
- At Squarespace, we add **two A records** (one each for `reviews` and `reviews-dev`) pointing at the VM's IP. Nothing else about your DNS changes.

Cost: **$0/month** for typical small-brand traffic. GCP's Always Free tier covers an `e2-micro` VM in a US region, plus 1 GB of internet egress per month. If traffic exceeds 1 GB egress, overage is billed at ~$0.12/GB — predictable and metered. We'll set up billing alerts so you'll never get a surprise.

### 3.1 — Sign up for Google Cloud

1. Go to **cloud.google.com** → click **Get started for free** (or **Sign in** if you already have a Google account associated with the brand Gmail).
2. Sign in with the brand's Gmail address. Google may ask for a few profile details.
3. Sign-up will ask for:
   - **Country** — pick yours
   - **Account type** — *Individual* is correct for our use
   - **Credit/debit card** — Google will *not* charge it as long as you stay in always-free configuration. They use it to deter abuse and to handle overages if any. New accounts get $300 in free credits valid for 90 days, but those credits are **separate from** the always-free tier we'll be using.
4. Activation usually completes within a few minutes; occasionally there's a verification delay of a few hours.

If your card gets declined or activation hangs for more than half a day, tell me and we'll pivot to **DigitalOcean** ($6/month, US-based) — same architecture, much smoother signup.

### 3.2 — Create a project

GCP organizes everything under "projects." Each project is isolated and has its own billing, resources, and permissions. We'll make one just for the reviews relay.

1. Top of the GCP console, click the **project dropdown** (next to the "Google Cloud" logo) → **New Project**.
2. **Project name**: `shopify-reviews-relay` (or anything memorable).
3. **Organization/location**: leave default ("No organization" is fine for an individual account).
4. Click **Create**. After ~30 seconds, switch into the new project via the same dropdown.

### 3.3 — Set up billing alerts (do this before creating any resources)

This is the safety net that ensures you never get a surprise bill. Set it up *first*, before anything is running.

1. Top-left hamburger menu → **Billing**.
2. If prompted, **link your billing account** to the new project.
3. Once linked, click **Budgets & alerts** in the Billing sidebar → **Create budget**.
4. Settings:
   - **Name**: `reviews-relay-budget`
   - **Scope**: select the `shopify-reviews-relay` project (uncheck "All projects")
   - **Time range**: Monthly
   - **Target amount**: `5` (USD) — this is *not* a hard cap; it's the spending threshold above which alerts fire. $5/month is generous; you'd have to send roughly 35 GB of overage traffic to reach it.
   - **Alert thresholds**: leave the defaults at 50%, 90%, 100% — Google will email you when each threshold is crossed.
5. Click **Finish**.

You can come back later and lower the alert amount once you have a sense of normal traffic — say, $1 or $2 — so you get notified the moment anything looks unusual.

### 3.4 — Create the e2-micro VM

The `e2-micro` shape is the always-free compute instance — small but plenty for a reverse proxy.

1. Hamburger menu → **Compute Engine** → **VM instances**. If this is your first time, click **Enable** when prompted to enable the Compute Engine API (~30 seconds).
2. Click **Create instance**.
3. Settings:
   - **Name**: `reviews-relay`
   - **Region**: must be one of `us-west1`, `us-central1`, or `us-east1` for always-free eligibility. Pick the one closest to your customers. For a US East Coast brand: `us-east1` (South Carolina). For West Coast: `us-west1` (Oregon).
   - **Zone**: any sub-zone (e.g., `us-east1-b`) is fine
   - **Machine configuration** → **Series**: `E2` → **Machine type**: `e2-micro` (2 vCPU shared, 1 GB memory). *Look for the "Free tier eligible" tag next to it — that's the always-free shape.*
   - **Boot disk**: click **Change** → select **Ubuntu** → **Ubuntu 24.04 LTS** (x86/64, amd64). Size: leave at default (10 GB is fine; always-free covers up to 30 GB).
   - **Firewall**: ✅ check both **Allow HTTP traffic** and **Allow HTTPS traffic**. (These add the right firewall rules automatically.)
4. Click **Create**. Provisioning takes about 30 seconds.

Once the instance shows up in the VM list with a green check, copy the **External IP** column — that's your relay's public IP (e.g., `35.231.xx.xx`). **Save this IP.**

### 3.5 — Reserve a static external IP (so the IP doesn't change)

By default, GCP gives the VM an *ephemeral* IP that changes if the VM is ever stopped. For a customer-facing service, we want a static IP that stays the same.

1. Hamburger menu → **VPC network** → **IP addresses**.
2. The current ephemeral IP shows up in the list with type "Ephemeral." Click the **three-dots menu** at the right → **Promote to static**.
3. Give it a name like `reviews-relay-ip`. Click **Reserve**.

A static external IP is **free as long as it's attached to a running VM**. If you ever delete the VM without releasing the IP, Google starts billing for the unattached IP — so if you decommission, release the IP afterward.

### 3.6 — SSH into the VM

The easiest path on Windows is GCP's built-in browser SSH:

1. **Compute Engine** → **VM instances**.
2. Click the **SSH** button to the right of `reviews-relay`. A new tab opens with a fully-functional terminal.

This avoids the need to manage SSH keys yourself. (If you'd rather use your own SSH client, the GCP console can also generate keys and add them to instance metadata — let me know and I'll walk through it.)

### 3.7 — Install Tailscale on the relay

This makes the relay part of your private Tailscale network, so it can reach Mercury without opening any ports on your home router.

In the SSH session:

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The second command prints a URL. Open it in a browser (any device — your laptop is fine), sign in with the same Tailscale account that owns your tailnet, and approve. The relay will appear in your tailnet.

In your Tailscale admin console (`login.tailscale.com/admin/machines`), give the new machine a memorable name like `reviews-relay`. Note its Tailscale IP (something like `100.x.y.z`).

Test that the relay can reach Mercury through Tailscale:
```
tailscale ping 100.117.6.18
```

(Replace with Mercury's actual Tailscale IP.) You should see a `pong from mercury (...)` reply. GCP's minimal Ubuntu image doesn't ship the regular `ping` command — `tailscale ping` is built into the Tailscale binary and is actually a better diagnostic here because it tells you whether the Tailscale tunnel is routing properly, not just whether ICMP works.

### 3.8 — Install Caddy

Caddy is the reverse-proxy. It handles HTTPS automatically by talking to Let's Encrypt; you do not need to manage certificates yourself.

```
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Verify Caddy is running:
```
sudo systemctl status caddy
```

(GCP's Ubuntu images don't ship with locked-down host firewalls the way some other clouds do — UFW is inactive by default — so no extra firewall config is needed inside the VM. The `Allow HTTP/HTTPS traffic` checkboxes from step 3.4 handled the GCP-level firewall.)

### 3.9 — Add the DNS A records at Squarespace

1. Squarespace → Settings → Domains → `brandname.com` → **DNS settings**.
2. Add a new record:
   - **Type**: `A`
   - **Host**: `reviews`
   - **Data/Value**: the GCP static IP from 3.5 (e.g., `35.231.xx.xx`)
   - **TTL**: 5 minutes if possible (lower TTL = faster propagation if you ever need to migrate). 1 hour is fine if Squarespace doesn't expose TTL controls.
3. Add a second A record:
   - **Type**: `A`
   - **Host**: `reviews-dev`
   - **Data/Value**: the same GCP IP
4. Save.

Both subdomains point to the same VM; Caddy will route them to different ports on Mercury. Propagation usually takes 5–30 minutes via Squarespace.

### 3.10 — Configure Caddy

GCP's minimal Ubuntu image doesn't include a text editor by default. Install nano first (or skip if you'd rather use vim):

```
sudo apt install -y nano
```

Back in the SSH session, edit `/etc/caddy/Caddyfile`:

```
sudo nano /etc/caddy/Caddyfile
```

Replace the existing contents with (substituting your real domain for `brandname.com` and Mercury's actual Tailscale IP for `100.117.6.18`):

```
reviews-dev.brandname.com {
    reverse_proxy 100.117.6.18:8081
}

reviews.brandname.com {
    reverse_proxy 100.117.6.18:8080
}
```

Save (Ctrl+O, Enter, Ctrl+X) and reload Caddy:

```
sudo systemctl reload caddy
```

Caddy will automatically request Let's Encrypt certificates the first time someone visits each subdomain. The first request takes ~5 seconds while the cert is issued; after that it's cached.

### 3.11 — Verify

From any machine on the public internet (your phone on cellular, or your laptop):

```
curl https://reviews-dev.brandname.com/health
```

Once the dev stack is deployed on Mercury this should return `{"status":"ok"}`. Until then, you'll get a 502 from Caddy — that's expected and confirms ingress is working end-to-end (it's reaching Mercury but Mercury isn't running anything yet on port 8081).

---

## Summary — what you should have when done

A plain-text note that looks something like this (real values filled in):

```
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
GMAIL_SEND_AS_ADDRESS=reviews@brandname.com
GMAIL_SMTP_USERNAME=brandname.gmail.address@gmail.com

SHOPIFY_CLIENT_ID=...                    # app-level, same in both stack .envs
SHOPIFY_CLIENT_SECRET=...                # app-level; also SHOPIFY_WEBHOOK_SECRET

# Dev stack's .env on Mercury (/opt/stacks/shopify-reviews-dev/.env):
SHOPIFY_SHOP_DOMAIN=teraclay-dev.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...            # from running install-shopify against the dev store

# Prod stack's .env on Mercury (/opt/stacks/shopify-reviews/.env):
SHOPIFY_SHOP_DOMAIN=brandname.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...            # from running install-shopify against the live store
SHOPIFY_STOREFRONT_ORIGIN=https://www.brandname.com

GCP_RELAY_PUBLIC_IP=35.231.xx.xx
GCP_RELAY_TAILSCALE_IP=100.x.y.z
GCP_RELAY_PROJECT=shopify-reviews-relay
GCP_RELAY_REGION=us-east1
```

(There's no `CLOUDFLARED_TOKEN` anymore — we replaced Cloudflare Tunnel with the Oracle/Caddy relay.)

Tell me when you have all three parts done (or when one is blocking you) and we'll move into deployment. Plus tell me about anything that didn't match the steps above — Oracle and Shopify both occasionally rearrange their UI, and the steps above reflect what they look like as of early 2026.
