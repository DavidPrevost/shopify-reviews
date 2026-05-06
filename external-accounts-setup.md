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

## Part 3 — Public ingress: Oracle Cloud + Caddy + Tailscale (≈45 minutes)

The plan changed: instead of Cloudflare Tunnel (which would have required moving brandname.com's DNS to Cloudflare — too risky for a live storefront), we'll use a tiny always-free virtual machine on Oracle Cloud as a doorway from the public internet to Mercury. The reviews app stays on Mercury; the VPS just relays traffic.

In plain terms:
- A small Linux machine in Oracle's data center is given the public DNS name `reviews.brandname.com`.
- That machine joins your Tailscale network (so it can reach Mercury privately, the same way your laptop can).
- A piece of software called **Caddy** runs on the machine; it auto-fetches HTTPS certificates and forwards every request to Mercury.
- At Squarespace, we add **one A record** (a single new line) for `reviews` pointing at the VPS's IP. Nothing else about your DNS changes.

Cost: $0/month (Oracle's "Always Free" tier is genuinely free, not a trial).

### 3.1 — Sign up for Oracle Cloud

1. Go to **oracle.com/cloud/free** → **Start for free**.
2. Use the brand's Gmail address.
3. Sign-up will ask for:
   - **Country** — pick yours
   - **Home region** — *this matters and can't easily be changed later.* Pick the data center geographically closest to your customers. For a US brand, "US East (Ashburn)" or "US West (Phoenix/San Jose)" are good defaults.
   - **Phone verification** — they SMS you a code
   - **Credit/debit card** — they will *not* charge it on the Always Free tier, but they verify it. Prepaid cards sometimes get rejected; use a regular credit card if you can.
4. Sign-up takes 5–10 minutes from email confirmation through account activation. There may be a delay before the account is fully active.

A few quirks worth knowing:
- Oracle is bureaucratic compared to AWS/Cloudflare. Don't be alarmed if their UI feels enterprise-y.
- If your card gets rejected and signup fails, **Hetzner Cloud** (~€4.50/month) is the cleanest alternative — same architecture, much smoother signup. Tell me if you hit this and we'll pivot.

### 3.2 — Create an Always Free ARM compute instance

Oracle's Always Free tier includes up to four small ARM-based virtual machines (technically "Ampere A1" instances). One is plenty for our purpose.

1. Once logged in, go to **Compute → Instances → Create instance**.
2. Settings:
   - **Name**: `reviews-relay`
   - **Image**: click "Change image" → choose **Canonical Ubuntu 24.04** (Minimal is fine).
   - **Shape**: click "Change shape" → "Ampere" tab → **VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory. (You can give it more — the free pool allows up to 4 OCPU / 24 GB across all your A1 instances combined.)
   - **Networking**: leave the defaults (Oracle creates a VCN and public subnet automatically). Make sure **"Assign a public IPv4 address"** is checked.
   - **SSH keys**: choose **"Generate a key pair"**. Click "Save private key" — this downloads a `ssh-key-XXXX.key` file. **Move it somewhere safe immediately**; you cannot re-download it. (On Windows, save it to `C:\Users\you\.ssh\oracle-reviews-relay.key`.)
3. Click **Create**. Provisioning takes 1–3 minutes.

Once running, the instance details page shows a **Public IP address** (something like `141.148.xx.xx`). **Save this IP** — you'll need it for DNS and SSH.

### 3.3 — Configure Oracle's network firewall

Oracle puts a firewall in front of every instance ("security list" in their terminology). By default it only allows SSH inbound. We need to also allow HTTP (80) and HTTPS (443).

1. From the instance detail page, click on the **Subnet** name under "Primary VNIC".
2. Click on the **Default Security List** for that subnet.
3. Under "Ingress Rules", click **Add Ingress Rules** and add two rules:
   - Source: `0.0.0.0/0`, IP Protocol: `TCP`, Destination Port Range: `80` — Description: `HTTP for Let's Encrypt + redirects`
   - Source: `0.0.0.0/0`, IP Protocol: `TCP`, Destination Port Range: `443` — Description: `HTTPS public traffic`
4. Save.

(There is *also* a host-level firewall inside Ubuntu that we'll handle in the next section.)

### 3.4 — SSH into the new instance

From your Windows machine, open PowerShell or Git Bash and:

```
ssh -i C:\Users\you\.ssh\oracle-reviews-relay.key ubuntu@141.148.xx.xx
```

(Replace the path and IP with yours. Username is always `ubuntu` for Ubuntu images.)

If SSH refuses with a permissions error about the key file, on Windows run:
```
icacls C:\Users\you\.ssh\oracle-reviews-relay.key /inheritance:r /grant:r "$($env:UserName):(R)"
```

### 3.5 — Install Tailscale on the relay

This makes the relay part of your private Tailscale network, so it can reach Mercury without opening any ports on your home router.

```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The second command prints a URL. Open it in a browser (any device — your laptop is fine), sign in with the same Tailscale account that owns your tailnet, and approve. The relay will appear in your tailnet.

In your Tailscale admin console (`login.tailscale.com/admin/machines`), give the new machine a memorable name like `reviews-relay`. Note its Tailscale IP (something like `100.x.y.z`).

Test that the relay can reach Mercury:
```
ping -c 3 100.117.6.18
```

(Replace with Mercury's actual Tailscale IP.) You should see ping replies.

### 3.6 — Open the host firewall for HTTP/HTTPS

Ubuntu's `iptables` rules ship locked down on Oracle images. Run:

```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

(If `netfilter-persistent` isn't installed: `sudo apt install -y iptables-persistent` first; it'll prompt to save current rules — say yes.)

### 3.7 — Install Caddy

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

### 3.8 — Add the DNS A record at Squarespace

1. Squarespace → Settings → Domains → `brandname.com` → **DNS settings**.
2. Add a new record:
   - **Type**: `A`
   - **Host**: `reviews`
   - **Data/Value**: the Oracle public IP (e.g., `141.148.xx.xx`)
   - **TTL**: 1 hour (or whatever's default)
3. Add a second A record:
   - **Type**: `A`
   - **Host**: `reviews-dev`
   - **Data/Value**: the same Oracle public IP
4. Save.

Both subdomains point to the same VPS; Caddy will route them to different ports on Mercury. Propagation usually takes 5–30 minutes via Squarespace.

### 3.9 — Configure Caddy

Edit `/etc/caddy/Caddyfile` (replace the existing contents):

```
sudo nano /etc/caddy/Caddyfile
```

Paste in (replacing `brandname.com` with your real domain and `100.117.6.18` with Mercury's actual Tailscale IP):

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

### 3.10 — Verify

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

SHOPIFY_DEV_DOMAIN=brandname-dev.myshopify.com
SHOPIFY_ADMIN_TOKEN_DEV=shpat_...
SHOPIFY_API_KEY_DEV=...
SHOPIFY_API_SECRET_DEV=...

SHOPIFY_PROD_DOMAIN=brandname.myshopify.com
SHOPIFY_STOREFRONT_ORIGIN=https://www.brandname.com
SHOPIFY_ADMIN_TOKEN_PROD=shpat_...
SHOPIFY_API_KEY_PROD=...
SHOPIFY_API_SECRET_PROD=...

ORACLE_RELAY_PUBLIC_IP=141.148.xx.xx
ORACLE_RELAY_TAILSCALE_IP=100.x.y.z
ORACLE_RELAY_SSH_KEY_PATH=C:\Users\you\.ssh\oracle-reviews-relay.key
```

(There's no `CLOUDFLARED_TOKEN` anymore — we replaced Cloudflare Tunnel with the Oracle/Caddy relay.)

Tell me when you have all three parts done (or when one is blocking you) and we'll move into deployment. Plus tell me about anything that didn't match the steps above — Oracle and Shopify both occasionally rearrange their UI, and the steps above reflect what they look like as of early 2026.
