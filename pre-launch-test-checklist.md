# Pre-Launch Click-Through Test Checklist

This is the final gate before the live store cuts over. Every test below should be performed on the **dev test store** against the **dev stack on Mercury** (`reviews-dev.teraclay.com`, container `reviews-app` in `/opt/stacks/shopify-reviews-dev/`). The goal is to surface any internal error before live customer data is involved — once the prod store is collecting real reviews, `rm data/reviews.db` stops being a valid recovery.

Work through it linearly. Each part assumes the parts before it have passed. Where a step might fail in a way that isn't obvious, the "what to check" notes say what "right" looks like.

---

## How to use this document

- **Each step is a single thing to do or check.** Tick it off (mentally or with `[x]`) before moving on.
- **When you see "what to check," that's the success condition.** If reality doesn't match, stop and write down what you saw — that's a bug.
- **SQL/bash blocks are copy-paste-ready.** Adjust IDs as noted.
- **Don't skip the "reset between tests" steps.** Some cleanup matters — e.g., a leftover panic-pause will silently break later tests.

---

## Prerequisites & assumptions

I'm assuming all of the following. Flag any that aren't true before starting:

- [x] App is installed on the dev test store via OAuth (you confirmed this).
- [x] Dev test store has **3 products with the `<div data-reviews-widget="full" ...>` snippet** on their product pages (you confirmed this).
- [x] Dev test store has **at least one customer account** you can sign in as for App-Proxy review submission testing. (Shopify dev stores → Customers → New customer → you'll need to set up Customer Accounts in Settings → Customer accounts if not already on.)
- [x] App Proxy is configured on the dev test store (subpath prefix `apps`, subpath `reviews`, Proxy URL `https://reviews-dev.teraclay.com/proxy/`). Without this, the customer-review modal, campaign application form, brand-color relay, and widget-mounted feedback form all silently 404 at the Shopify edge.
- [x] The dev store has at least one **payment method that lets you place test orders** (Shopify's "Bogus Gateway" is the standard; otherwise the dev store with `(for testing) Bogus Gateway` enabled in Settings → Payments).
- [x] You can SSH into Mercury (Tailscale).
- [x] You can access the dev test store as both an **admin** (Shopify admin) and as a **customer** (storefront, logged in to a customer account) — ideally in two different browsers or one regular + one incognito so cookies don't collide.
- [x] You have a working email address you can receive at (the test customers will need to use it as their email so you can read the request emails). Gmail "plus addressing" (`youraddress+test1@gmail.com`, `youraddress+test2@gmail.com`) lets you use the same inbox for multiple distinct test customers.

---

## Test environment access

### SSH to Mercury and tail the logs

In one terminal, keep this open the whole time. Any 500 error or unexpected behavior will surface in the logs first:

```bash
ssh mercury
docker logs -f reviews-app
```

Container name is `reviews-app` (single-container app). If you're on a different host or your compose project is renamed, find it with `docker ps | grep reviews`.

### Open a SQLite shell into the dev DB

```bash
docker exec -it reviews-app sqlite3 /app/data/reviews.db
```

Inside the shell, useful settings:

```sql
.headers on
.mode column
.timer on
```

To exit: `.quit` or `Ctrl+D`.

**For one-off queries from the host shell** (without dropping into the SQLite REPL):

```bash
docker exec reviews-app sqlite3 /app/data/reviews.db "SELECT * FROM settings;"
```

> **Local-Windows alternative:** if you're testing against the Windows dev instance instead, the DB is at `D:\AI\shopify-reviews\data\reviews.db`. Use [DB Browser for SQLite](https://sqlitebrowser.org/) — it's the friendliest UI for ad-hoc queries on Windows. The same SQL snippets work; just connect to the file directly.

### Browser setup

- **Two browsers (or one regular + one incognito).** One stays signed into Shopify admin (your admin window); the other simulates the storefront customer (the "shopper" window).
- **In the shopper window:** open DevTools → Network tab. Watch for failed requests during tests. Watch the Console for JS errors from the widget.
- **Disable cache while DevTools is open** — `widget.js` is served with `stale-while-revalidate=86400`, so stale bundles linger up to 24 hours otherwise.

### A note on Shopify webhook delivery

Real webhooks (`orders/paid`, `orders/fulfilled`, GDPR) fire from Shopify when real events happen on the dev store. They typically arrive at the dev stack within a few seconds. If you place a test order and **nothing** shows up in `docker logs -f reviews-app`, the webhook chain is broken and nothing else downstream will work — fix that first (likely a webhook misconfiguration or a stale `SHOPIFY_WEBHOOK_SECRET`).

---

## Part 0: Smoke test

Five-minute pre-flight before the real test begins. If any of these fail, the deeper tests will fail in confusing ways.

### 0.1 — App is reachable

- [x] In a browser, hit `https://reviews-dev.teraclay.com/health` — should return `{"status":"ok"}`.

### 0.2 — Admin loads

- [x] In Shopify admin, click on the Reviews app in the left nav. The embedded admin should load with the **Dashboard** tab active.
- [x] **Check the logs:** no "session token verification failed" or "embed session" warnings.

### 0.3 — All admin nav tabs respond

Click each tab in the top nav and verify it loads without error:

- [x] Dashboard
- [x] Reviews
- [x] Reports (badge will show open-reports count, if any)
- [x] Campaigns
- [x] Invitations
- [x] Branding
- [x] Settings

### 0.4 — Storefront widget loads

- [x] In the shopper window, open one of the 3 product pages with the widget.
- [x] The widget should render. If there are no reviews yet, expect "No reviews yet."
- [x] DevTools console should have **zero errors** related to `widget.js`.
- [x] DevTools network tab should show a successful `GET /widget.js`, `GET /api/widget/config`, and `GET /api/products/{id}/reviews`.

### 0.5 — Verify webhooks are firing

Quickest way: place a fake test order on the dev store now (you'll use it again in Part 4). In Shopify admin:

- [x] Orders → Create order → add one of the 3 widget-enabled products → use a customer with your real email (set up the customer first if needed) → Mark as paid (Bogus Gateway).
- [x] **In the log tail:** within ~5 seconds you should see `orders/paid processed` with the order ID, customer email, and a `lines: 1` field.
- [x] **In SQLite:** verify the row landed:
  ```sql
  SELECT id, email, shopify_customer_id FROM customers ORDER BY id DESC LIMIT 1;
  SELECT id, shopify_order_id, shopify_product_id, fulfilled_at, due_at FROM purchases ORDER BY id DESC LIMIT 1;
  ```
  Expect `fulfilled_at` and `due_at` to be **NULL** at this stage (paid, not fulfilled).

If `orders/paid processed` does NOT show up in logs: **stop here**. Either the webhook isn't subscribed, the HMAC secret is wrong, or the URL is wrong. Re-run `npm run install-webhooks` and check the dev.shopify.com app config.

---

## Part 1: Storefront reading experience (no auth needed)

### 1.1 — Full widget on a product page with no reviews

- [x] Shopper window → product 1's page.
- [x] Widget shows the empty state ("No reviews yet" or similar copy).
- [x] Aggregate stars are absent or show 0.
- [x] **Network tab:** `GET /api/products/{id}/reviews` returns 200 with `{"reviews": [], "aggregate": {"avg": null, "count": 0}, ...}`.

### 1.2 — Aggregate-only widget (optional, only if you've added one to a theme section)

If you've added `<div data-reviews-widget="aggregate" data-product-id="...">` to a collection card template:

- [x] Visit the collection page. Each card with the snippet should show stars + count (or empty state if no reviews).

If you haven't added these anywhere, skip — it's not a launch blocker.

### 1.3 — Widget styling matches the storefront theme

- [x] Widget colors look correct (stars, button, background).
- [x] If brand colors haven't been synced yet (the relay only fires when the theme has the `data-brand-*` attributes on the widget div), the widget will use hardcoded defaults — that's expected for this dev store unless you've added them.

> **To enable the brand relay**, the theme's widget div should look like:
> ```liquid
> <div data-reviews-widget="full"
>      data-product-id="{{ product.id }}"
>      data-variant-id="{{ product.selected_or_first_available_variant.id }}"
>      data-customer-id="{{ customer.id }}"
>      data-brand-primary-bg="{{ shop.brand.colors.primary[0].background }}"
>      data-brand-primary-fg="{{ shop.brand.colors.primary[0].foreground }}"
>      data-brand-secondary-bg="{{ shop.brand.colors.secondary[0].background }}"
>      data-brand-secondary-fg="{{ shop.brand.colors.secondary[0].foreground }}"
>      {% if shop.brand.logo %}data-brand-logo="{{ shop.brand.logo | image_url: width: 400 }}"{% endif %}>
> </div>
> ```
> The `{% if shop.brand.logo %}` guard prevents a Liquid error when no logo is set.

---

## Part 2: Settings configuration walkthrough

We'll set sensible test values now and verify each setting saves correctly. This baseline is what the rest of the tests assume.

### 2.1 — Settings → Cadence

Navigate: Settings → Cadence tab.

- [x] **Max requests per purchase:** set to `3` (default), save, verify it persists after reload.
- [x] **Min days between requests:** set to `7` (default).
- [x] **Days after fulfillment before first request:** set to `7` (default).
- [x] **Per-run safety cap:** set to `100` (default).
- [x] **Daily dispatcher time:** pick a time in the next 10-15 minutes (in your local timezone). Save. Verify the page reloads showing the same time in your local tz. Verify the next scheduled run actually fires when that time arrives (you can watch `docker logs -f reviews-app` for "scheduled dispatcher run starting"). Then reset to a non-disruptive time (e.g., 2pm local) for the rest of testing.
- [x] **Dispatch immediately on fulfillment:** **leave OFF for now**. (We'll toggle it on later as part of the email test; it must be off for cadence-suppression tests to make sense.)

### 2.2 — Settings → Cadence → Go-live guard

- [x] **Verify the guard is currently OFF** (says "Disabled — every imported order is eligible"). If it's set, click "Disable guard" — we want all eligibility tests to work without cutoff-filtering noise. We'll test the guard itself in Part 17.

### 2.3 — Settings → Notifications

- [x] **Enable new-review notifications:** check the box.
- [x] **Recipient email:** put your own working email here.
- [x] **Ratings:** check **all five** (1-5) for now so every test review pings you.
- [x] Save. Reload to verify it persisted.

### 2.4 — Settings → Appearance

- [x] Pick an admin theme (try "Brand — from Shopify" — it'll fall back to the default if no brand colors are synced yet). Verify the chrome (header bar, accents) recolors. Pick a different theme; verify recolor. Settle on whichever you like for the rest of the test.

### 2.5 — Settings → Setup

- [x] Read the per-variant reviews setup section (you'll exercise this in Part 13).
- [x] Read the App Proxy setup section. Confirm the **App Proxy URL it shows** matches what's actually configured in dev.shopify.com.
- [x] Click **Refresh product cache**. The page should redirect with a confirmation banner ("Cleared N cached products"). On the next product-page load, the widget re-fetches each product's data from Shopify.

---

## Part 3: Branding configuration walkthrough

### 3.1 — Branding → Widget tab

- [x] The live mockup at the top of the page should render with the current colors.
- [x] Click the **Star color** chip → change the color via the color picker. Mockup updates instantly.
- [x] Click the **CTA button** in the mockup itself (the green/dark "Write a review" button). It should select the `ctaBackground` chip automatically and scroll the editor into view with a brief highlight flash.
- [x] Pick a preset from the swatch row. Verify mockup updates.
- [x] Click **Reset to default** on the active chip. Mockup reverts.
- [x] Adjust the border-radius slider. Mockup button corners change.
- [x] Change the **"Write a review" button text**. Mockup button text changes.
- [x] Save.
- [x] **Open the shopper window and reload a product page.** Verify the widget's styling reflects your saved changes. (Hard-reload with cache disabled, since `/api/widget/config` has a 5-minute cache header.)
- [x] Come back to admin and click **Reset all widget styling to Shopify defaults**. Confirm. Reload the storefront → widget should be back to defaults.

### 3.2 — Branding → Email tab — shared branding

- [x] **Logo upload:** upload a small PNG (under 250KB). Should save and the image appears at the top of the page.
- [x] **Footer text:** set to something distinctive like `Test footer for {{ brandName }}`. Save.
- [x] **Sender display name:** leave blank (defaults to brand name) or set to something custom.
- [x] **Reply-to address:** leave blank for now.

### 3.3 — Branding → Email tab — per-template editing

For each of the seeded templates (Review Request, Review Request Followup, Repeat Customer Review, Review Removed, plus any others present), do the following:

- [x] Pick the template from the dropdown.
- [x] Click **Preview in new tab**. The preview should render with sample data (no broken images, no `{{ undefined }}` placeholders).
- [x] Edit the subject (e.g., append `[TEST]`). The unsaved-changes indicator should activate.
- [x] Switch to a different template via the dropdown — it should prompt "discard changes?". Click cancel; you're back on the edited template. Click save.
- [x] **Toggle the raw HTML view** (`</> HTML` button). Verify the body HTML is sane. Toggle back to the visual editor.
- [x] Use the **Insert variable** dropdown. Insert `{{ firstName }}`. It should appear in the body.
- [x] Use the **Insert logo** button. An `<img>` tag appears.
- [x] Save. Reload the page; verify changes persisted.
- [x] Click "Preview in new tab" again to verify your edits render correctly.

### 3.4 — Create a new email template

- [x] Click **+ New template**.
- [x] Give it a name like `Test custom template`, pick the `review_submitted_thankyou` trigger (which is currently inactive in the system but available in the picker).
- [x] Subject: `Thanks for your review`.
- [x] Save.
- [x] It should now appear in the dropdown. Open it, customize the body, save again.
- [x] **Delete it** via the red Delete button. Confirm. It's gone from the dropdown.

### 3.5 — Branding → Brand colors tab

- [x] Note the current state. If empty, manually enter:
  - Primary background: `#2d572c`
  - Primary text: `#ffffff`
  - Secondary background: `#f5a623`
  - Secondary text: `#222222`
- [x] Save.
- [x] Go back to **Widget** tab. The Shopify-brand swatch row should now show those 4 colors. Click "Brand primary" — the active chip's color updates. Reset.
- [x] Try the "Brand — from Shopify" admin theme (Settings → Appearance). The admin chrome should now use your manually-entered primary colors.

---

## Part 4: Email review-request flow (the big one)

This is the most important surface in the system. We'll test every path: first-time email, follow-up, repeat customer, cadence suppression, unsubscribe variants.

### 4A: First-time customer email — happy path

#### 4A.1 — Reset state if needed

If you placed a test order during 0.5, you'll reuse it. Otherwise, place one now:

- [ ] Shopify admin → Orders → Create order → Customer set to your test email → Add one product → Mark as paid.
- [ ] Verify in the log: `orders/paid processed`.

#### 4A.2 — Toggle dispatch-immediately ON (test-only)

This bypasses the 7-day delay so we can validate the flow today.

- [ ] Admin → Settings → Cadence → check **"Send review-request email immediately on fulfillment"**.
- [ ] Save.

#### 4A.3 — Mark the test order as fulfilled

- [ ] Shopify admin → the test order → click **Fulfill** → mark fulfilled (no tracking number needed).
- [ ] **In the log:** within seconds you should see:
  - `orders/fulfilled processed` with `immediate: true`
  - `dispatcher run starting` (because immediate mode triggered it)
  - `dispatch sent` with the template name and customer ID
- [ ] Check your inbox. The review-request email should arrive within ~30 seconds.

#### 4A.4 — Verify the email itself

- [ ] **From line:** matches your configured sender name (brand name).
- [ ] **Subject:** matches the active `review_request` template.
- [ ] **Body:** uses `{{ firstName }}` and `{{ brandName }}` correctly (no literal `{{ ... }}` left over).
- [ ] **Logo:** shows up at the top (if you uploaded one in 3.2).
- [ ] **Product image, title, and "Write a review" button** all render. Image actually loads.
- [ ] **"Don't ask about this one" link** is present under the CTA.
- [ ] **Footer + "Unsubscribe from all review requests" link** present.
- [ ] **HTML and plain-text part both present** (in Gmail: hit "Show original" — should see `Content-Type: multipart/alternative` and both parts).
- [ ] **List-Unsubscribe header present** (in Gmail's "Show original" view, look for `List-Unsubscribe:` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`).

#### 4A.5 — Click through and submit

- [ ] Click the **Write a review** button. Lands on the hosted review page at `/r/<token>` on `reviews-dev.teraclay.com`.
- [ ] Page shows the product title and an empty form.
- [ ] Pick 5 stars, write a title, write a body.
- [ ] Submit.
- [ ] Success page renders ("Thanks for your review!" or similar).
- [ ] **Log line:** `review submitted` with `verifiedKind: 'purchase'`.
- [ ] **New-review notification email:** within ~30 seconds you should receive your own notification (since you enabled it in 2.3 with all 5 ratings checked).
- [ ] **In SQLite, verify the row landed:**
  ```sql
  SELECT id, rating, title, body, verified_kind, verified_purchase, status, customer_id FROM reviews ORDER BY id DESC LIMIT 1;
  ```
  Expect: `verified_kind='purchase'`, `verified_purchase=1`, `status='published'`.
- [ ] **Verify the purchase was marked reviewed:**
  ```sql
  SELECT id, reviewed_at FROM purchases ORDER BY id DESC LIMIT 1;
  ```
  Expect: `reviewed_at` is a unix timestamp (not NULL).

#### 4A.6 — Verify the review is on the storefront

- [ ] Shopper window → the product's page. Hard reload.
- [ ] The review appears, with 5 stars, your title, body, and **"Verified Buyer" badge**.
- [ ] Aggregate at the top of the widget shows `5.0 (1)` or equivalent.

#### 4A.7 — Verify it shows in admin Reviews

- [ ] Admin → Reviews tab. Your review is at the top of the list.
- [ ] Click into it. Review-detail page renders correctly. Original text matches.

### 4B: Follow-up email

The follow-up template (`review_request_followup`) fires when a customer has already received at least one review-request email but hasn't reviewed the product yet. To test it we need an unanswered prior request.

#### 4B.1 — Set up the prior-request state

Place a new test order (use a different product or a fresh customer email to avoid duplicate-review collisions):

- [ ] Create a new test order with a *different* customer email (e.g., `youremail+followup@gmail.com`).
- [ ] Mark fulfilled. With dispatch-immediately still ON, you'll get the first review request email.
- [ ] **Do not click through or review.** Let the email sit.

#### 4B.2 — Simulate time passing so the cadence allows a second send

The dispatcher won't send a second request until `cadence_min_days_between` (default 7) days have passed since the last send. SQL to backdate:

```sql
-- Find the customer and purchase
SELECT c.id AS customer_id, c.email, c.last_request_sent_at, c.unanswered_request_count,
       p.id AS purchase_id, p.fulfilled_at, p.due_at, p.last_request_at, p.request_count
  FROM customers c JOIN purchases p ON p.customer_id = c.id
  WHERE c.email = 'youremail+followup@gmail.com';

-- Backdate the request timestamps by 8 days so cadence_min_days_between (7) is satisfied.
-- Replace <customer_id> and <purchase_id> below.
UPDATE customers
   SET last_request_sent_at = unixepoch() - (8 * 86400)
 WHERE id = <customer_id>;

UPDATE purchases
   SET last_request_at = unixepoch() - (8 * 86400),
       due_at = unixepoch() - 60
 WHERE id = <purchase_id>;
```

#### 4B.3 — Trigger a follow-up dispatcher run

- [ ] Admin → Dashboard → **Run dispatcher now**.
- [ ] **In the log:** look for `dispatch sent` with `template: review_request_followup` (NOT `review_request`).
- [ ] Check inbox: a second email arrived. **Subject and body should match the follow-up template, not the first-time template.**
- [ ] **Don't review through this one either** — we'll keep using it for the next test.

### 4C: Repeat-customer email

The `repeat_customer_review` template fires when the customer has at least one previous review on record. The 4A customer (who submitted a review) is now a repeat customer.

#### 4C.1 — Set up another order for the 4A customer

- [ ] Place a new test order from the **same customer used in 4A** (who submitted a review). Use a different product so we don't hit the "duplicate review" suppression.
- [ ] Mark fulfilled. With dispatch-immediately ON, the email fires.
- [ ] **In the log:** look for `dispatch sent` with `template: repeat_customer_review` (NOT `review_request`).
- [ ] Inbox: the email subject/body matches the repeat-customer template.

> **Why the distinction matters:** the dispatcher's template-selection logic in [src/scheduler/dispatcher.ts](src/scheduler/dispatcher.ts) picks `review_request_followup` if any purchase has prior requests, else `repeat_customer_review` if the customer has any prior reviews, else `review_request`. If the wrong template fires, that logic is wrong. Watch the log.

### 4D: Cadence suppression — verify all five rules

The dispatcher emits a per-run audit log line showing how many purchases were excluded by each rule. We want to verify each rule actually fires.

#### 4D.1 — Setup: turn dispatch-immediately OFF

- [ ] Admin → Settings → Cadence → uncheck **"Send review-request email immediately on fulfillment"**.
- [ ] Save. We want manual control of dispatcher runs from here on.

#### 4D.2 — Rule 1: `globalOptOut`

- [ ] Pick a customer that has a pending purchase with `due_at` set to past (use SQL to find one or set one up).
- [ ] Admin → Customers → look up that customer by email → click **"Apply global opt-out"**.
- [ ] Admin → Dashboard → **Run dispatcher now**.
- [ ] **Log line:** `dispatcher run starting` → `suppressed: { globalOptOut: N, ... }` where N ≥ 1.

#### 4D.3 — Rule 2: `productOptOut`

This fires when a customer has clicked "Don't ask about this one" on a specific product but doesn't have a global opt-out. To set this up:

```sql
-- Set product_opt_out on a purchase. Replace <purchase_id>.
UPDATE purchases SET product_opt_out = 1 WHERE id = <purchase_id>;
-- Ensure due_at is in the past so it would otherwise be picked up.
UPDATE purchases SET due_at = unixepoch() - 60 WHERE id = <purchase_id>;
```

- [ ] Run the dispatcher again. **Log line:** `suppressed.productOptOut` ≥ 1.

#### 4D.4 — Rule 3: `maxRequestsHit`

- [ ] Find a purchase with `request_count = 3` (or set one up):

```sql
UPDATE purchases SET request_count = 3, due_at = unixepoch() - 60 WHERE id = <purchase_id>;
```

- [ ] Run dispatcher. **Log line:** `suppressed.maxRequestsHit` ≥ 1.

#### 4D.5 — Rule 4: `cadenceTooSoon`

- [ ] Set a purchase's customer to have just received a request very recently:

```sql
UPDATE customers SET last_request_sent_at = unixepoch() - 3600 WHERE id = <customer_id>;
UPDATE purchases SET due_at = unixepoch() - 60 WHERE customer_id = <customer_id>;
```

- [ ] Run dispatcher. **Log line:** `suppressed.cadenceTooSoon` ≥ 1.

#### 4D.6 — Rule 5: `alreadyReviewed`

The 4A customer's purchase already has `reviewed_at` set, so they're already in this state. To confirm:

```sql
-- Find a reviewed purchase
SELECT id FROM purchases WHERE reviewed_at IS NOT NULL LIMIT 1;
-- Set due_at to past so it would otherwise be picked up
UPDATE purchases SET due_at = unixepoch() - 60 WHERE id = <purchase_id>;
```

- [ ] Run dispatcher. **Log line:** `suppressed.alreadyReviewed` ≥ 1.

### 4E: Per-product unsubscribe

- [ ] In your inbox, open the second email (the follow-up from 4B, or any prior request).
- [ ] Click **"Don't ask about this one"** under one of the product CTAs.
- [ ] You land on a hosted page ("You've been unsubscribed from review requests for [product]" or similar).
- [ ] **In SQLite:**
  ```sql
  SELECT id, product_opt_out FROM purchases WHERE id = <purchase_id>;
  -- Expect product_opt_out = 1
  ```
- [ ] **Verify global subscription was NOT affected:**
  ```sql
  SELECT id, email, global_opt_out FROM customers WHERE id = <customer_id>;
  -- Expect global_opt_out = 0
  ```

### 4F: Global unsubscribe (the link in the footer)

- [ ] Open another request email. Click **"Unsubscribe from all review requests"** at the bottom.
- [ ] Lands on a "you're unsubscribed" page.
- [ ] **In SQLite:**
  ```sql
  SELECT id, email, global_opt_out FROM customers WHERE id = <customer_id>;
  -- Expect global_opt_out = 1
  ```
- [ ] **Email events table records it:**
  ```sql
  SELECT id, customer_id, kind FROM email_events WHERE customer_id = <customer_id> ORDER BY id DESC LIMIT 5;
  -- Expect a row with kind='unsubscribed'
  ```

### 4G: One-click List-Unsubscribe (Gmail's "Unsubscribe" link in the header bar)

- [ ] In Gmail, open a review-request email. Above the subject line, Gmail should show **"Unsubscribe"** (which uses the `List-Unsubscribe` and `List-Unsubscribe-Post` headers).
- [ ] Click it. Confirm in Gmail's modal.
- [ ] The customer should now be globally opted out. Verify in SQLite as in 4F.

### 4H: Re-subscribe a customer (admin action)

- [ ] Admin → Customers → look up an opted-out customer → click **"Re-subscribe customer"**.
- [ ] Page reloads with a flash "Re-subscribed. Cleared N pending review-requests so the customer won't be backfilled."
- [ ] **Verify global_opt_out is cleared:**
  ```sql
  SELECT id, email, global_opt_out FROM customers WHERE id = <customer_id>;
  -- Expect global_opt_out = 0
  ```
- [ ] **Verify any pending `due_at`s on that customer's purchases were cleared:**
  ```sql
  SELECT id, due_at FROM purchases WHERE customer_id = <customer_id>;
  -- Any unreviewed rows should have due_at = NULL.
  ```

---

## Part 5: Storefront customer review submission (App Proxy)

This requires Customer Accounts to be enabled on the dev store and at least one customer account to log in as.

### 5.1 — Anonymous visitor sees the "log in" affordance

- [x] Shopper window, signed OUT.
- [x] Open a product page. The widget should show some form of "Log in to write a review" call-to-action (NOT the "Write a review" button, NOT a form).

### 5.2 — Logged-in customer with no prior review sees "Write a review"

- [x] Sign in as a Shopify customer account on the dev storefront.
- [x] Open a product page (use a product the customer has NOT yet reviewed). The widget header should now show a **"Write a review"** button.
- [x] **In DevTools Network tab:** look for a request to `/apps/reviews/customer/review?logged_in_customer_id=...&signature=...` — Shopify-edge-signed. Status 200 (or 401 if the customer has no review yet, which the widget treats as "no prior review").

### 5.3 — Submit a review via the modal

- [x] Click **Write a review** in the widget.
- [x] Native `<dialog>` opens with a form (stars, title, body).
- [x] Hit ESC — modal closes (focus trap working).
- [x] Reopen, fill it out, submit.
- [x] Success message in the modal, modal closes after a beat, widget refreshes to show the new review.
- [x] **The review is at the top** with a **"Your review"** badge/tag.
- [x] **Log line:** `proxy review insert` or similar.
- [x] **In SQLite:**
  ```sql
  SELECT id, rating, customer_id, verified_kind, verified_purchase, status FROM reviews ORDER BY id DESC LIMIT 1;
  ```
  Expect: `verified_kind='purchase'` if the logged-in customer has a prior purchase of that product (any order, any time), else `verified_kind=NULL`.

### 5.4 — Edit your own review

- [x] Same logged-in customer, same product. The widget header now shows **"Edit your review"** instead of "Write a review".
- [x] Click it. Modal opens **pre-populated** with the existing review's stars, title, body.
- [x] Change the body, change the rating, submit.
- [x] Widget refreshes; review shows the new content.
- [x] **In SQLite, verify the row was UPDATED, not duplicated:**
  ```sql
  SELECT COUNT(*) FROM reviews WHERE customer_id = <customer_id> AND shopify_product_id = '<product_id>';
  -- Expect 1
  ```
- [x] **`updated_at` should be more recent than `created_at`** on that row.

### 5.5 — Submission while reviews are paused

- [x] Activate the panic button (skip ahead to 9.1 if you want; otherwise come back here later).
- [x] Try to write a new review via the modal. Should fail gracefully with a paused notice (not a stack trace).

### 5.6 — App Proxy signature failure detection

This validates that the App Proxy HMAC verification actually rejects forged requests:

```bash
# Hit the proxy endpoint with NO signature; expect 401
curl -i 'https://reviews-dev.teraclay.com/proxy/customer/review?logged_in_customer_id=999'
# Expect: HTTP/1.1 401 Unauthorized, body {"error":"invalid_signature"}
```

- [x] Verified: the endpoint refuses unsigned requests.

---

## Part 6: Report-a-review flow

### 6.1 — Submit a report from the storefront

- [ ] Shopper window. Open a product with at least one review (not the customer's own review if signed in).
- [ ] Click the small **"Report"** link below a review.
- [ ] A modal opens with a reason dropdown, optional message, optional email.
- [ ] Pick a reason (e.g., "Spam"), add a short message, leave email blank.
- [ ] Submit. Confirmation appears in the modal.
- [ ] **In SQLite:**
  ```sql
  SELECT id, review_id, reason, message, reporter_email, reporter_ip, status FROM review_reports ORDER BY id DESC LIMIT 1;
  ```
  Expect a row with `status='open'`, the reason you picked, no email, an IP hash present.

### 6.2 — Admin Reports tab shows the new report

- [ ] Admin → Reports tab. The **Reports nav badge** should now show `1` (or higher).
- [ ] The reported review group is visible. The report row inside it shows your reason and message.

### 6.3 — Dismiss a single report

- [ ] Click **Dismiss this report** on the individual report.
- [ ] Page reloads with a "Report dismissed" flash. The badge decrements.
- [ ] **In SQLite:**
  ```sql
  SELECT id, status, resolved_by FROM review_reports ORDER BY id DESC LIMIT 1;
  -- Expect status='dismissed', resolved_by='admin'
  ```

### 6.4 — Dismiss all reports for a review

- [ ] Submit two reports on the same review (re-do 6.1 twice).
- [ ] Admin → Reports → the review group shows 2 reports.
- [ ] Click **Dismiss all reports for this review**. Both reports close.

### 6.5 — Retract a review via the Reports page

- [ ] Submit a fresh report on a review.
- [ ] Admin → Reports → pick a reason from the dropdown in the right column, optionally add a note, leave "Email reviewer" checked.
- [ ] Click **Retract review**.
- [ ] Page reloads with "Review retracted and reports cleared."
- [ ] **The review is now in `rejected` status** — verify in Reviews tab, status pill is `rejected`.
- [ ] **Storefront widget no longer shows it** — reload the product page.
- [ ] **You (or the test customer if it's a real email) get the retraction email.**
- [ ] **In SQLite:**
  ```sql
  SELECT id, status, moderation_reason FROM reviews WHERE id = <review_id>;
  -- Expect status='rejected'
  SELECT id, status FROM review_reports WHERE review_id = <review_id>;
  -- Expect all reports closed with status='retracted'
  ```

### 6.6 — Ban a reporter

- [ ] Submit a report **with an email address** in the optional field.
- [ ] Admin → Reports → click **Ban reporter** next to that report.
- [ ] Confirm. Page reloads showing the email in the **Banned reporters** table at the bottom.
- [ ] **Try to submit another report from that email** (storefront, fill in the same email). The endpoint silently 200s — no DB row, no error.
- [ ] **In SQLite:**
  ```sql
  SELECT * FROM banned_reporters;
  -- Expect the banned email
  SELECT COUNT(*) FROM review_reports WHERE reporter_email = '<banned_email>' AND status = 'open';
  -- Expect 0 (the new submission was silently dropped)
  ```

### 6.7 — Unban

- [ ] Admin → Reports → click **Unban** next to the banned email.
- [ ] Page reloads, the email is no longer in the banned list.

### 6.8 — Edge case: anonymous report on the customer's own review

- [ ] Sign in to the storefront as the customer who left the review.
- [ ] On their own review, **the Report link should not be present** (the widget hides it for the customer's own review).

---

## Part 7: Admin moderation

### 7.1 — Light publish/pending flip

- [ ] Admin → Reviews → click a published review → on the review-detail page, in the Moderation card, click **"Hold for review"**.
- [ ] Page reloads with status pill = `pending`.
- [ ] **Storefront widget no longer shows it.**
- [ ] Click **"Publish"** to flip back.
- [ ] **Verify no moderation_events row was created** (this isn't a moderation decision):
  ```sql
  SELECT COUNT(*) FROM moderation_events WHERE review_id = <review_id>;
  -- Expect: 0 (or the count before, unchanged)
  ```

### 7.2 — Retract with each moderation reason

Cycle through all 9 reasons at least once across a few reviews:

For each reason (profanity, spam, off-topic, not-a-customer, harassment, contains-pii, legal-takedown, duplicate, other):

- [ ] Pick a published review (create more test reviews if needed).
- [ ] Click **Retract review** in the Moderation card.
- [ ] Pick the reason from the dropdown.
- [ ] Add an internal note (e.g., "Test retract — reason: profanity").
- [ ] Leave "Email the reviewer" checked.
- [ ] Click **Retract review** in the modal.
- [ ] Page reloads with banner "Review retracted. Notification email sent to the reviewer."
- [ ] **You receive the retract email** (since you're the customer in your tests). The customer-facing reason phrase matches the reason you picked (NOT the internal note).
- [ ] **In SQLite:**
  ```sql
  SELECT id, event_type, from_status, reason, note, actor, customer_notified
    FROM moderation_events WHERE review_id = <review_id> ORDER BY id DESC LIMIT 1;
  -- Expect a row with event_type='retract', reason=<your reason>, note=<your note>, customer_notified=1.
  ```

### 7.3 — Retract without notifying the customer

- [ ] On another review, retract — **uncheck "Email the reviewer"**.
- [ ] You should NOT receive an email.
- [ ] `moderation_events.customer_notified` for this row = 0.

### 7.4 — Restore a retracted review

- [ ] Open a retracted review.
- [ ] In the Moderation card, click **Restore review**.
- [ ] Optional: add a note. Check "Email the reviewer."
- [ ] Click Restore.
- [ ] Page reloads; status is `published`.
- [ ] Storefront widget shows it again.
- [ ] You receive the restore email.
- [ ] **Audit log shows both events** (retract first, then restore) on the review detail page.

### 7.5 — Restored review can be re-reviewed by the same customer

The uniqueness index excludes rejected reviews, so a retract-then-resubmit shouldn't fail:

```sql
-- Verify the partial unique index excludes rejected
SELECT name, sql FROM sqlite_master WHERE name = 'idx_reviews_customer_product';
-- Expect a partial unique index with `WHERE customer_id IS NOT NULL AND status <> 'rejected'`
```

- [ ] If you want to exercise it: retract a customer's review, then have that customer (via App Proxy login OR a fresh email-link with a new purchase) submit a new review for the same product. The new review should insert without a UNIQUE constraint error.

### 7.6 — Merchant reply (stored only, not yet shown on storefront)

- [ ] Open a review detail page.
- [ ] In the **Merchant reply** card, type a reply.
- [ ] Save.
- [ ] Reload. Reply text persists in the textarea.
- [ ] **In SQLite:**
  ```sql
  SELECT id, merchant_reply, merchant_reply_at FROM reviews WHERE id = <review_id>;
  -- Expect the reply text and a timestamp
  ```
- [ ] **Storefront verification:** the reply does NOT appear on the storefront widget — that's expected (it's slated for a future build).

---

## Part 8: Profanity filter

### 8.1 — Set up a wordlist

- [x] Admin → Reviews → **Moderation** sub-tab.
- [x] In the Profanity Filter card, click **Reveal list**.
- [x] If empty, add a few test words (use innocuous test words to avoid awkwardness — `# Test wordlist` as a header, then `widget`, `frodo`, `bananas` on their own lines). The first line should be a comment.
- [x] Save. Page reloads with banner "Wordlist saved. Re-ran the filter over existing reviews (N re-checked)."

### 8.2 — Submit a review containing a wordlisted word

- [x] Submit a fresh review (any submission path) with body containing the word `bananas`.
- [x] Verify on the storefront — the word should appear as `*******` (asterisks of equal length).
- [x] **In SQLite:**
  ```sql
  SELECT id, title, body, title_original, body_original FROM reviews ORDER BY id DESC LIMIT 1;
  -- Expect: body has asterisks, body_original has the literal word.
  ```
- [x] Admin review detail page shows the **original** uncensored text with a "Showing the original text" note.

### 8.3 — Add a word, verify re-censor on save

- [x] Add another word to the wordlist (e.g., `widget`).
- [x] Save.
- [x] Reviews that contain the word `widget` in their original text should now be censored on the storefront.

### 8.4 — Remove a word, verify un-censor on save

- [x] Remove `bananas` from the wordlist.
- [x] Save.
- [x] Reviews with `bananas` in their original should now show it uncensored on the storefront.

### 8.5 — Reviewer names are never censored

- [x] Make sure the wordlist has some word that's also someone's first name (or use the test customer's actual first name temporarily).
- [x] Verify the reviewer name still displays in full on the storefront.
- [x] Reset: remove that word from the wordlist when done.

### 8.6 — Whole-word, case-insensitive matching

- [x] Test that `widget` matches `Widget` and `WIDGET` but does NOT match `widgets` (the partial-substring problem — "widget" in "widgets" should NOT be censored).
- [x] If `widgets` IS censored, that's a bug.

---

## Part 9: Panic button

### 9.1 — Activate

- [x] Admin → Reviews → Moderation sub-tab → **Pause reviews now** button.
- [x] Modal opens.
- [x] Type a reason (e.g., "Testing the panic button").
- [x] Set duration to **1 hour** (we don't want the test to leave reviews paused).
- [x] Type the confirmation phrase: `PAUSE REVIEWS`.
- [x] Click **Pause reviews**.
- [x] Page reloads to the Reviews tab with a confirmation banner.

### 9.2 — Red banner appears on every admin page

- [x] **Top of every admin page** now has the red "REVIEWS ARE PAUSED — auto-resumes in Xh Ym" banner with a one-click Resume button.
- [x] Visible on Dashboard, Reviews, Reports, Campaigns, Invitations, Branding, Settings.

### 9.3 — Storefront widget shows the paused notice

- [x] Shopper window → reload a product page.
- [x] The widget shows "Reviews are temporarily unavailable" (or similar) instead of reviews and aggregate.
- [x] **No JS errors** in the DevTools console.

### 9.4 — All submission paths return errors

- [x] **Email-link path:** click through any saved review email's "Write a review" link → the hosted page should show a non-alarming "Reviews are temporarily unavailable" notice with HTTP status 503.
- [x] **Sample-invitation path:** visit any pending sample invitation URL → same paused notice, 503.
- [x] **App Proxy customer-review submission:** if you try to submit via the modal, you get an error.
- [x] **`/api/reviews/submit` direct call:**
  ```bash
  curl -i -X POST https://reviews-dev.teraclay.com/api/reviews/submit \
    -H 'Content-Type: application/json' \
    -d '{"token":"x","rating":5,"body":"test"}'
  # Expect: 503 with {"error":"reviews_paused"}
  ```
- [x] **Campaign application:** if you have an active campaign with applications open, try to submit one — should fail (or show paused). (Skip if no active campaign yet; this rule isn't critical for the panic feature.)

### 9.5 — Dispatcher run skips

- [x] Admin → Dashboard → **Run dispatcher now**.
- [x] **Log line:** `dispatcher skipped: reviews are paused`.
- [x] Result page shows `{"sent": 0, ...}` and no emails actually go out.

### 9.6 — Dev notification email arrives

- [x] If `DEV_NOTIFICATION_EMAIL` is set in the env, you should have received an email like `[Reviews / <brand>] Panic button PAUSED` shortly after activating.
- [x] If you don't see it, check the log for `panic event: dev notification skipped` (means env var isn't set — that's a config issue, not a bug).

### 9.7 — Extend the pause

- [x] Admin → Reviews → Moderation tab → Panic card.
- [x] Set extend hours to 2, click **Extend pause**.
- [x] Page reloads showing the new auto-resume time roughly 2 hours from now.
- [x] **Log line:** `panic event: dev notified` with `eventType: extend`.
- [x] **Second dev notification email** arrives.

### 9.8 — Resume

- [x] Click **Resume reviews now** (either in the banner or the Panic card).
- [x] Page reloads with success flash.
- [x] Banner is gone from all pages.
- [x] Storefront widget renders reviews again.
- [x] **Log line:** `panic event: dev notified` with `eventType: resume`.
- [x] **Third dev notification email** arrives.

### 9.9 — Pause history is preserved

- [x] Admin → Reviews → Moderation sub-tab → Panic card.
- [x] **Pause history** table shows all three events: pause, extend, resume — in reverse chronological order with timestamps, reasons, and actor.

### 9.10 — Auto-resume

(Optional — slow test. Skip unless you want to validate the timer.)

- [x] Pause for 1 hour.
- [x] **In SQLite, force the timer to expire:**
  ```sql
  -- Set panic_paused_until to 1 minute ago
  UPDATE settings SET value = CAST((unixepoch() - 60) AS TEXT) WHERE key = 'panic_paused_until';
  ```
- [x] Reload any admin page. The banner should be gone. Storefront widget should work again. No "resume" event was recorded (auto-lapse is silent — that's by design).

---

## Part 10: Sample invitations

### 10.1 — Create a single invitation

- [ ] Admin → Invitations → Individual sub-tab.
- [ ] Product ID: paste a Shopify admin product URL (e.g., `https://admin.shopify.com/store/<store-handle>/products/<numeric-id>`). The form should accept it.
- [ ] Recipient name: `Test Recipient`.
- [ ] Recipient email: `youremail+invite1@gmail.com`.
- [ ] Notes: `Test invitation 1`.
- [ ] **Generate invitation link**.
- [ ] Page reloads with a copyable URL in a flash banner. URL format: `https://reviews-dev.teraclay.com/r/invite/<token>`.

### 10.2 — Try the bad-input paths

- [ ] Try creating an invitation with a product handle (e.g., `red-hat-product`). It should fail with a clear error message about not supporting handles.
- [ ] Try with a Shopify storefront product URL — same expected behavior.
- [ ] Try with a malformed GID. Should fail.
- [ ] Try with a numeric product ID only. Should succeed.

### 10.3 — Submit a review via the invitation link

- [ ] Open the URL from 10.1 in a private/incognito window (so no cookies/auth interference).
- [ ] Hosted review form renders with the product title.
- [ ] Fill out 4 stars, title, body, your name.
- [ ] Submit.
- [ ] Success page.
- [ ] **In SQLite:**
  ```sql
  SELECT id, rating, reviewer_name, verified_kind FROM reviews ORDER BY id DESC LIMIT 1;
  -- Expect verified_kind='sample'
  SELECT id, consumed_at, consumed_review_id FROM sample_invitations ORDER BY id DESC LIMIT 1;
  -- Expect consumed_at is set, consumed_review_id matches the review.id from above.
  ```
- [ ] Storefront widget on that product page shows the new review with **"Verified Reviewer"** badge (NOT "Verified Buyer").

### 10.4 — Single-use enforcement

- [ ] Open the same invitation URL again. Should show "this invitation has already been used" (or similar) — should NOT show the form.

### 10.5 — Expired invitation

```sql
-- Expire an invitation manually
UPDATE sample_invitations SET expires_at = unixepoch() - 60 WHERE id = <invitation_id>;
```

- [ ] Visit that invitation's URL (generate a fresh token via admin's "View link" if needed). Should show "expired" page.

### 10.6 — Batch CSV upload

- [ ] Admin → Invitations → **Batch** sub-tab.
- [ ] Click **Download blank template (CSV)**. Saves a `sample-invitations-template.csv`.
- [ ] Open the CSV, replace `REPLACE_WITH_PRODUCT_ID` with one of your real product IDs. Add 2-3 more rows with different products/recipients.
- [ ] **Add one deliberately-malformed row** (e.g., `product_id` set to `not-a-real-product-id`) to test the skip-with-summary behavior.
- [ ] Save the CSV.
- [ ] Upload via **CSV file** → **Upload and create**.
- [ ] Result page shows "Created N invitations" + a "1 row skipped" summary for the malformed row with the row number and reason.
- [ ] Admin → Invitations → Manage sub-tab — confirms all the new pending invitations.

### 10.7 — CSV export

- [ ] Admin → Invitations → Batch → **Download all invitations as CSV**.
- [ ] CSV downloads with columns: id, status, product_id, product_name, name, email, notes, created_iso, expires_iso, consumed_iso, invitation_url.
- [ ] Open it — every pending invitation has a working URL. Click one to verify.

### 10.8 — Banned reporter / opted-out customer on invitation submission

(Edge case — only worth doing if you want to be thorough.)

- [ ] Globally opt out a customer. Create a sample invitation for the same email. Submit the review. **It should succeed** — global opt-out is about review-request emails, not review submission.

---

## Part 11: Customer management

### 11.1 — Look up a customer

- [x] Admin → Customers → enter an email (or navigate from a review-detail page via the customer link).
- [x] Page renders: name, email, opt-out state, unanswered request count, last-request timestamp, purchases table.

### 11.2 — Apply global opt-out (covered in 4D.2)

### 11.3 — Re-subscribe (covered in 4H)

---

## Part 12: Dashboard

### 12.1 — Stat cards reflect current state

- [ ] Counts for Published / Pending / Rejected match `SELECT status, COUNT(*) FROM reviews GROUP BY status;`.
- [ ] Submitted (30d) matches `SELECT COUNT(*) FROM reviews WHERE created_at >= unixepoch() - 30*86400;`.

### 12.2 — Drill-down links

For each of the 7 stat cards, click and verify:

- [x] Published → Reviews tab filtered to `status=published`.
- [x] Pending → Reviews tab filtered to `status=pending`.
- [x] Rejected → Reviews tab filtered to `status=rejected`.
- [x] Submitted (30d) → Reviews tab filtered to date range.
- [x] Sent (30d) → Activity list (with Product column).
- [x] Unsubscribed (30d) → Activity list.
- [x] Send failed (30d) → Activity list.

### 12.3 — Recent reviews table

- [x] Up to 10 most recent reviews appear. Click "View" on one — review detail page loads.

### 12.4 — Manual operations

- [x] Click **Run Shopify backfill (last 90 days)**. Page reloads with a JSON dump of the result. No 500.
- [x] Click **Run dispatcher now**. Page reloads with a JSON dump of the dispatch result.

---

## Part 13: Variant handling (per-product opt-in)

### 13.1 — Set up the Shopify metafield definition

This is a one-time Shopify setup, only needed if you want to test per-variant pools. Skip if the dev store is single-variant only.

- [ ] Shopify admin → Settings → Custom data → Products → Add definition.
- [ ] Name: `Variant handling`. Namespace and key: `reviews.variant_handling`. Type: Single line text. Validation: limit to preset choices `distinct` and `shared`. Save.

### 13.2 — Pick a multi-variant product to test on

- [ ] Make sure one of your dev-store products has at least 2 variants (size, color, etc.). If none do, add a temporary one.
- [ ] On that product, set the Metafield → Variant handling → `distinct`.

### 13.3 — Refresh product cache

- [ ] Admin → Settings → Setup → **Refresh product cache** button.

### 13.4 — Verify per-variant pools on the storefront

- [ ] Make sure you have reviews on at least 2 different variants of that product. (You may need to place orders for each variant, fulfill, and submit reviews. Or place the same order with multiple variants.)
- [ ] Visit the product page. Pick variant A. Review widget should show only reviews tied to variant A.
- [ ] Below the main list, a **"Customers also reviewed these variants"** section should appear with reviews for variant B (and beyond).
- [ ] Pick variant B in the variant selector. Widget reloads (MutationObserver picks up the variant change). Main list now shows variant B; the "related" section shows variant A.
- [ ] **Verify with SQL:**
  ```sql
  SELECT id, shopify_product_id, shopify_variant_id FROM reviews WHERE shopify_product_id = '<product_id>';
  ```

### 13.5 — Toggle back to shared

- [ ] Set the metafield to `shared` (or delete it) on that product.
- [ ] Refresh product cache.
- [ ] Storefront: all reviews show in one pool again. "Related variants" section is gone.

---

## Part 14: Campaigns — full lifecycle test

This is the most complex feature in the system. Plan ~1 hour for this part if you go through every step.

### 14.1 — Create a campaign

- [x] Admin → Campaigns → **+ New campaign**.
- [x] **Name:** `Summer Test Campaign`.
- [x] **Slug:** verify the URL preview updates as you type (live preview shows `/page/<slug>` or similar). Type something with capital letters or spaces — the field should reject them per the HTML5 pattern.
- [x] **Participant Limit:** `5` (small for testing).
- [x] **Capacity warning threshold:** `60` (percent). Verify the live "warning fires at 3 applications" helper text below.
- [x] **Products:** check 2 of the 3 widget-enabled products. If the picker is empty, click **Refresh from Shopify** to populate it.
- [x] **Enable discount terms:** checked.
- [x] **Discount percent:** `15`.
- [x] **Discount expiry days:** `30`.
- [x] **Discount code prefix:** `SUMMER`. Verify the live preview shows `SUMMERXXXXXXXX`.
- [x] **Terms summary:** keep the seeded boilerplate (or shorten for testing).
- [x] **Terms body:** keep the seeded boilerplate.
- [x] **Create campaign**.

### 14.2 — Verify the campaign was created

- [x] You land on the campaign detail page. Status pill = `draft`. Slug, status, products, discount terms all match what you entered.
- [x] **In SQLite:**
  ```sql
  SELECT id, name, slug, status, target_size, capacity_warning_threshold, discount_percent, discount_expires_days, discount_code_prefix FROM campaigns ORDER BY id DESC LIMIT 1;
  SELECT id, version_number, summary_text, body_text FROM campaign_terms_versions ORDER BY id DESC LIMIT 1;
  ```
- [x] Click **Edit settings** → make a small change (e.g., bump participant limit to 6) → save → verify it sticks.

### 14.3 — Move to Recruiting

- [x] On the campaign detail page, click **Move to Recruiting** (or whatever the next-status button is labeled).
- [x] Status pill flips to `recruiting`.

### 14.4 — Create the Shopify Page with the application form

- [x] Shopify admin → Online Store → Pages → **Add page**.
- [x] Title: `Apply to Summer Campaign`.
- [x] Content (use the HTML view / `<>` button):
  ```html
  <div data-campaign-form="summer-test-campaign"></div>
  ```
  (Replace `summer-test-campaign` with whatever slug you actually used.)
- [x] Visibility: Visible.
- [x] Save. Note the page URL — should look like `https://<dev-store>.myshopify.com/pages/apply-to-summer-campaign`.

### 14.5 — Application form renders publicly

- [x] Shopper window (signed out — campaigns are open to anyone). Open the Page URL.
- [x] The application form renders within ~1 second. Form should include:
  - Plain-language summary box (from your terms summary)
  - Full terms expandable
  - Name field
  - Email field
  - Shipping address fields
  - "I agree to the terms" checkbox
  - Submit button
- [x] **DevTools console:** no errors. **Network tab:** `GET /apps/reviews/campaigns/<slug>/config` returns 200 with the campaign config.

### 14.6 — Submit an application

- [x] Fill out the form with `youremail+applicant1@gmail.com` (NOT one of your earlier test emails — fresh customer).
- [x] Realistic name and shipping address.
- [x] Tick the terms-agreement checkbox.
- [x] Submit.
- [x] Success screen: "Thanks, we'll be in touch."
- [x] **In SQLite:**
  ```sql
  SELECT id, campaign_id, customer_id, status, terms_version_id, terms_accepted_at FROM campaign_members ORDER BY id DESC LIMIT 1;
  -- Expect status='applied', customer_id=NULL (until approval), terms_version_id matches.
  SELECT shipping_address_json FROM campaign_members WHERE id = <member_id>;
  -- JSON object with the address.
  ```
- [x] **Application-confirmation email** arrives in `youremail+applicant1@gmail.com`. Subject and body match the `campaign_application_confirmation` template. Should include a recap of the terms summary.

### 14.7 — Submit a few more applications

- [x] Submit 2 more applications with `+applicant2@gmail.com`, `+applicant3@gmail.com`.
- [x] **Each one triggers a confirmation email.**

### 14.8 — Verify capacity-warning email fires at the threshold

You set the threshold at 60% of 6 = 4 (warning fires when reaching the 4th application). Submit a 4th application:

- [x] Submit `+applicant4@gmail.com`.
- [x] **Capacity-warning email** arrives at whatever admin email is configured. Verify it lands.
- [x] **Log line:** `campaign capacity warning fired` (or similar — search the dispatch-campaign code for the exact wording).
- [x] Submit a 5th and 6th application. Capacity warning should **NOT** fire again (it's one-shot per campaign unless you re-arm it).

### 14.9 — Re-arm capacity warning

- [x] Admin → Campaigns → detail page → **Reset capacity warning** button.
- [x] **In SQLite:**
  ```sql
  SELECT capacity_warning_fired_at FROM campaigns WHERE id = <campaign_id>;
  -- Expect NULL (re-armed)
  ```

### 14.10 — Auto-close at target

- [x] You've hit 6 of 6 applications. The campaign should have **auto-closed** — status pill is now `closed`.
- [x] If you try to submit a 7th, the application page should show "Applications are closed."

### 14.11 — Approve members

- [x] On the campaign detail page, you should see the applications queue. Approve `applicant1`, `applicant2`, `applicant3`.
- [x] For each approval:
  - **In SQLite:** member status = `approved`, customer_id is now set (a customer record was upserted).
- [x] Sample invitations are NOT auto-created on approval. After approving, the queue shows a "Generate N sample invitations per approved applicant" button — click it (covered in 14.14). Idempotent; re-running skips members who already have invitations.
  ```sql
  SELECT id, campaign_id, intended_email FROM sample_invitations WHERE campaign_id = <campaign_id>;
  ```

### 14.12 — Reject and remove

- [x] Reject `applicant4` (with a reason if the UI asks). The member row stays in the DB with `status='rejected'` — retained for the audit trail.
- [x] Remove `applicant5` entirely. Note: **Remove hard-deletes the `campaign_members` row** (and the shipping_address_json with it). Only offered pre-ship (status `applied` or `approved`); once a member is shipped/reviewed/done, Remove is hidden because downstream artifacts already exist (invitations, codes, sent emails).
- [x] In SQLite, verify: the rejected member's row is still present with `status='rejected'`; the removed member's row is gone.

### 14.13 — Move to Shipping

- [x] Status transition: campaign → `shipping`.

### 14.14 — Bulk-generate invitations

Approval does not auto-create invitations. Click **Generate N sample invitations per approved applicant** in the queue. Verify all 3 approved members now have invitations (one per campaign product).

### 14.15 — Send the "Samples shipped" batch email

- [x] On the campaign detail page, find the **Batch emails** card.
- [x] The "Samples shipped" row shows `Eligible: 3` (the 3 approved members with invitations).
- [x] Click **Send "Samples shipped"**.
- [x] Confirmation page (or inline result): `sent: 3, failed: 0`.
- [x] All 3 approved members receive their email with personalized review links for each of the 2 products.
- [x] **Log lines:** 3 `campaign batch send sent` (or similar) entries.
- [x] **In SQLite:**
  ```sql
  SELECT id, status, decided_at FROM campaign_members WHERE status IN ('shipped', 'reviewed', 'done') AND campaign_id = <campaign_id>;
  -- All 3 should now be in 'shipped' status.
  ```

### 14.16 — Per-campaign template override (clone + edit + revert)

- [x] Click **Preview / edit template** on the "Samples shipped" row.
- [x] This clones the default template for this campaign and opens an editor.
- [x] Change the subject (add `[CAMPAIGN OVERRIDE]`) and save.
- [x] **In SQLite:**
  ```sql
  SELECT id, campaign_id, template_key, subject FROM email_templates WHERE campaign_id = <campaign_id>;
  -- Expect a row with the override subject and campaign_id set.
  ```
- [x] Resend a single test (or wait for the next test in the lifecycle) — verify the new subject is used.
- [x] Click **Revert to default**. The campaign-specific row is deleted; future sends use the default again.
- [x] Verify in SQLite that the override row is gone.

### 14.17 — Send the "Review reminder" batch

- [x] Wait briefly (or just proceed). The "Review reminder" row should show `Eligible: 3` (all in shipped state).
- [x] Click **Send "Review reminder"**.
- [x] 3 reminder emails fire. Bodies should mention "Now that you've had a chance to try the samples..." or whatever the template says.
- [x] **Member statuses advance from `shipped` to `reminded`.** Re-firing the batch should now show `Eligible: 0` — `reminded` members are intentionally excluded so they don't get the reminder twice.

### 14.18 — Have one of the recipients leave a review

- [x] Click through one of the campaign review links in your inbox. Submit a 5-star review.
- [x] **In SQLite:**
  ```sql
  SELECT id, verified_kind FROM reviews ORDER BY id DESC LIMIT 1;
  -- Expect verified_kind='sample'
  -- Verify member status updates from 'shipped' to 'reviewed' for that member.
  SELECT id, status FROM campaign_members WHERE campaign_id = <campaign_id> ORDER BY id;
  ```

### 14.19 — Send the "Launch thanks" batch (auto-generates discount codes)

- [x] Move the campaign status to `active` (one of the transitions).
- [x] On the Batch emails card, the "Launch thanks" row should show `Eligible: 3` (members in shipped + reviewed).
- [x] Click **Send "Launch thanks"**.
- [x] **Phase 1 (codes):** the dispatcher creates a Shopify discount code per member via `discountCodeBasicCreate`. If ANY code fails, the batch aborts before sending — verify via logs that this is an all-or-nothing operation.
- [x] **Phase 2 (send):** emails go out with the per-recipient code embedded.
- [x] **In Shopify admin → Discounts:** you should see 3 new codes prefixed with `SUMMER`.
- [x] **In SQLite:**
  ```sql
  SELECT id, discount_code, discount_code_id, code_status FROM campaign_members WHERE campaign_id = <campaign_id>;
  -- Each should have a discount_code, a discount_code_id (Shopify GID), code_status='active'.
  ```
- [x] Open one of the "Launch thanks" emails — body shows the unique code (`SUMMER` + 8 chars).

### 14.20 — Use a discount code on an order and verify redemption tracking

- [x] Shopify admin → Orders → Create order → use one of the test customers and the product in the campaign → at checkout, apply one of the SUMMER discount codes.
- [x] Mark the order as paid.
- [ ] **Log line:** `campaign discount code redeemed` with the member ID, code, and order total.
- [ ] **In SQLite:**
  ```sql
  SELECT id, code_status, code_redeemed_at, code_redeemed_order_id, code_redeemed_order_total FROM campaign_members WHERE discount_code = '<code>';
  -- Expect code_status='redeemed', code_redeemed_at set, code_redeemed_order_id matches the new order, code_redeemed_order_total matches.
  ```

### 14.21 — Cleanup discount codes — "unredeemed only"

- [ ] On the campaign detail page, find the **Discount codes** card.
- [ ] Click **Cleanup unredeemed codes**.
- [ ] **In Shopify admin → Discounts:** the unredeemed codes are now gone. The redeemed one (from 14.20) is still there.
- [ ] **In SQLite:**
  ```sql
  SELECT discount_code, code_status FROM campaign_members WHERE campaign_id = <campaign_id>;
  -- Unredeemed members now have code_status='deleted_from_shopify'.
  ```

### 14.22 — Cleanup discount codes — "all"

- [ ] (Optional — only if you want to wipe everything.) Click **Cleanup ALL codes**.
- [ ] The redeemed code is also deleted from Shopify. Past redemptions in `orders` are unaffected (the code is gone but the order history remains).

### 14.23 — Move the campaign to Completed → retention queue activates

- [ ] Campaign status → `completed`.
- [ ] **Shipping addresses are quarantined automatically.**
- [ ] Admin → Campaigns → **Retention queue** link.
- [ ] The queue page shows all members of the completed campaign as pending purge.
- [ ] **In SQLite:**
  ```sql
  SELECT id, retention_status FROM campaign_members WHERE campaign_id = <campaign_id>;
  -- All approved/shipped members should have retention_status='pending_deletion'
  -- (or whatever the schema uses — verify against [src/db/migrations/018_campaigns.sql](src/db/migrations/018_campaigns.sql))
  SELECT id, shipping_address_json FROM campaign_members WHERE campaign_id = <campaign_id>;
  -- The shipping_address_json column is NULL (quarantined).
  ```

### 14.24 — Confirm purge

- [ ] Retention queue → check the boxes for the members to purge → **Permanently delete selected shipping addresses**.
- [ ] Confirm.
- [ ] Page reloads; the queue is now empty (or smaller).
- [ ] **In SQLite:**
  ```sql
  SELECT id, retention_status, shipping_address_json FROM campaign_members WHERE id IN (<ids>);
  -- retention_status='purged', shipping_address_json=NULL still.
  -- Name + email on the parent customer record remain intact.
  ```

### 14.25 — Cancelled campaign also triggers retention quarantine

(Optional — only if you want to fully test the path.)

- [ ] Create another quick campaign with 1 application. Move it to `cancelled`. Verify shipping addresses quarantine the same way.

---

## Part 15: Campaign feedback forms

Feedback forms can be tested independently of campaigns — they only require an existing campaign to be attached to. Use the `Summer Test Campaign` from Part 14.

### 15.1 — Create a feedback form

- [ ] Admin → Campaigns → Summer Test Campaign → scroll to the **Feedback forms** section.
- [ ] Click **+ New feedback form**.
- [ ] Title: `Product feedback`.
- [ ] Intro text: `We'd love to hear what you thought.`
- [ ] Product: pick one of the campaign's products (or leave as campaign-wide).
- [ ] Save.
- [ ] The form appears in the list with an **access key** (a short URL token) and a **public URL** like `https://reviews-dev.teraclay.com/feedback/<key>`.

### 15.2 — Add one of each question type

- [ ] Click into the form's edit page.
- [ ] Add a **1-5 rating** question: "Overall, how would you rate the product?" — required.
- [ ] Add a **single-choice** question: "Would you buy again?" with options `Yes / Maybe / No` — required.
- [ ] Add a **multi-choice** question: "Which features did you like?" with options `Quality / Design / Price / Packaging` — not required.
- [ ] Add a **short text** question: "One-word summary?" — not required.
- [ ] Add a **long text** question: "Anything else you'd like us to know?" — not required.

### 15.3 — Test the hosted landing (no JS required)

- [ ] In incognito, open the form's public URL.
- [ ] Page renders cleanly with brand colors (pulled from `shop_brand_json` if set, otherwise defaults).
- [ ] **Disable JavaScript in DevTools** (Settings → Debugger → "Disable JavaScript"). Reload. **The page still works.**
- [ ] Fill out all questions. Skip the optional name + email fields at the top.
- [ ] Submit (native form POST).
- [ ] You land on a thank-you page.
- [ ] **Re-enable JS for the next test.**

### 15.4 — Submit a second response with name + email

- [ ] Open the form URL in another private window.
- [ ] Fill the optional name + email fields this time.
- [ ] Fill out questions differently.
- [ ] Submit.

### 15.5 — Verify rate limiting

The hosted landing is rate-limited per IP (20 submissions / 60 seconds).

- [ ] (Optional — only worth testing if you want to be thorough.) Try 20+ rapid submissions from the same browser. The 21st should fail with a clear "too many requests" message.

### 15.6 — View the report

- [ ] Admin → Campaigns → Summer Test Campaign → **Feedback forms** → click the form → **Report** or aggregate view.
- [ ] Report page shows:
  - Per-question aggregates: count, average for the 1-5 rating; tallies for single/multi choice; raw text dump for free-text.
  - The 2 responses with their submission time + optional name/email.

### 15.7 — Widget-mounted form variant

- [ ] In Shopify, edit the existing Page (or create a new one). Replace the campaign form snippet with:
  ```html
  <div data-campaign-feedback-form="<access_key>"></div>
  ```
- [ ] Visit the page in incognito (with JS enabled). The widget should render the form (same questions).
- [ ] Submit a response. Verify it lands in the same `campaign_feedback_responses` table.

### 15.8 — Delete a question

- [ ] On the form edit page, delete the multi-choice question.
- [ ] Verify in SQLite that the question row is gone (or marked deleted, depending on the schema):
  ```sql
  SELECT id, type, prompt FROM campaign_feedback_questions WHERE form_id = <form_id>;
  ```
- [ ] **Reload the public hosted page** — the question is gone.

### 15.9 — Delete the whole form

- [ ] Delete the form from the campaign detail page.
- [ ] Public URL now 404s (or shows "form not found").
- [ ] **In SQLite, verify cascade:**
  ```sql
  SELECT * FROM campaign_feedback_forms WHERE id = <form_id>;        -- 0 rows
  SELECT * FROM campaign_feedback_questions WHERE form_id = <form_id>; -- 0 rows
  SELECT * FROM campaign_feedback_responses WHERE form_id = <form_id>; -- 0 rows
  ```

---

## Part 16: GDPR webhooks

Shopify mandates these three. They MUST return HMAC-verified 200s. **`shop/redact` is destructive** — it wipes all data for the shop. Save it for last (or skip on dev).

### 16.1 — `customers/data_request` (safe, just logged)

This webhook fires when a customer requests their data. We log it but don't auto-export.

To trigger it, you can use Shopify's webhook test feature:

- Shopify admin → Settings → Notifications → scroll to **Webhooks** → find the `Customer data request` webhook → **Send test notification**.

- [ ] **Log line:** `customers/data_request received` with the customer ID and email.
- [ ] **No DB changes.**

### 16.2 — `customers/redact` (anonymizes a customer)

- [ ] Pick a test customer to anonymize. Note their ID first.
- [ ] Send a test `Customer redact` webhook from the same Shopify admin notifications page. Adjust the payload to reference that customer.
- [ ] **Log line:** `customers/redact applied`.
- [ ] **In SQLite:**
  ```sql
  SELECT id, email, first_name, last_name FROM customers WHERE id = <customer_id>;
  -- Expect anonymized fields (likely email='anonymized-<id>@redacted', name fields NULL).
  ```

### 16.3 — `shop/redact` — **WARNING: WIPES ALL DATA FOR THE SHOP**

The webhook is supposed to fire 48 hours after app uninstall. It deletes every row tied to the shop. **Do not test this on the active dev test store unless you're prepared to lose everything in the DB.**

If you do want to verify it works (recommended at least once, on a throwaway dev install):

1. Take a DB snapshot first: `docker exec reviews-app cp /app/data/reviews.db /app/data/reviews-pre-shop-redact.db`
2. Trigger the test webhook.
3. Verify all data is wiped:
   ```sql
   SELECT COUNT(*) FROM customers;  -- 0
   SELECT COUNT(*) FROM reviews;    -- 0
   SELECT COUNT(*) FROM purchases;  -- 0
   SELECT COUNT(*) FROM campaigns;  -- 0
   ```
4. Restore: `docker exec reviews-app cp /app/data/reviews-pre-shop-redact.db /app/data/reviews.db`, then restart the container.

- [ ] **Easier alternative:** trust the unit-level behavior (the route in [src/routes/webhooks.ts](src/routes/webhooks.ts) is scoped to a specific shop_id and the logic is straightforward) and skip the live test. Confirm by code review that the deletes are scoped to a single `shop_id` (which they are — see line 247-267 of webhooks.ts).

---

## Part 17: Go-live guard

The go-live guard prevents the dispatcher from emailing pre-launch customers when you cut over to the live store. Test it now so the cutover is uneventful.

### 17.1 — Set the cutoff to NOW

- [ ] Admin → Settings → Cadence → **Set cutoff to now (go-live)**.
- [ ] Confirm.
- [ ] Page reloads. The Go-live guard card shows "Active — only orders fulfilled on or after [timestamp] (UTC) receive automated requests."

### 17.2 — Verify pre-cutoff orders are suppressed

- [ ] Backdate an existing purchase to before the cutoff:
  ```sql
  UPDATE purchases SET fulfilled_at = unixepoch() - 60, due_at = unixepoch() - 30, reviewed_at = NULL, request_count = 0 WHERE id = <purchase_id>;
  UPDATE customers SET last_request_sent_at = NULL WHERE id = (SELECT customer_id FROM purchases WHERE id = <purchase_id>);
  ```
- [ ] Run dispatcher manually. **The pre-cutoff purchase should NOT be sent.**
- [ ] **Log line:** the suppression audit should show it dropped, but it'll go under the right category. Verify the SQL in `findEligiblePurchases` actually filters by `request_cutoff_at` — see [src/db/queries.ts](src/db/queries.ts).

### 17.3 — Verify post-cutoff orders ARE sent

- [ ] Place a fresh test order. Mark fulfilled. Since dispatch-immediately is OFF, manually run the dispatcher.
- [ ] The post-cutoff order's email should fire normally.

### 17.4 — Clear the guard

- [ ] Admin → Settings → Cadence → **Disable guard**.
- [ ] Confirm.
- [ ] The card returns to "Disabled — every imported order is eligible."

---

## Part 18: Operational checks

### 18.1 — Logs survive a restart

- [ ] On Mercury: `docker restart reviews-app`.
- [ ] `docker logs reviews-app | tail -50` — recent context should still be there (Docker keeps logs).
- [ ] Boot lines should include: migrations applied, `ensureCurrentShop()`, scheduler registered.

### 18.2 — Backup ran

- [ ] On Mercury: `ls -la /opt/stacks/shopify-reviews-dev/data/` — look for `reviews.db.YYYY-MM-DD.sqlite` or similar backup artifact.
- [ ] Or: `cat /opt/stacks/shopify-reviews-dev/data/backup.log` to see the backup container's recent activity.

### 18.3 — Cron is firing at the configured time

- [ ] **In SQLite:**
  ```sql
  SELECT key, value FROM settings WHERE key IN ('dispatcher_hour', 'dispatcher_minute');
  ```
- [ ] Note that hour/minute are in UTC.
- [ ] Watch `docker logs -f reviews-app` near that time. You should see `scheduled dispatcher run starting`.

### 18.4 — Dispatcher schedule reload on save

- [ ] Admin → Settings → Cadence → change the dispatcher time by 1 minute → save.
- [ ] **Log line:** `dispatcher scheduler registered` with the new cron expression.

### 18.5 — Refresh product cache flushes

- [ ] **In SQLite:** `SELECT COUNT(*) FROM products_cache;` — note the count.
- [ ] Admin → Settings → Setup → **Refresh product cache**.
- [ ] `SELECT COUNT(*) FROM products_cache;` — should be 0 (cache emptied).
- [ ] Visit a product page on the storefront — cache repopulates as products are re-fetched.

### 18.6 — Email send failure is recoverable

(Optional, but valuable — confirms that a temporarily-broken SMTP doesn't poison anything permanently.)

- [ ] Temporarily set `SMTP_PASS` in the dev stack's `.env` to a wrong value. Restart the container.
- [ ] Trigger an email (e.g., place a test order, fulfill).
- [ ] **Log line:** `dispatch send failed` with the SMTP error. `logEmailFailure` writes a row to `email_events` with `kind='send_failed'`.
- [ ] **Dashboard "Send failed (30d)" stat** should increment.
- [ ] Restore the correct `SMTP_PASS`. Restart. The next dispatcher run should succeed for the same purchases (the failed sends didn't mark them as sent).

---

## Part 19: Pre-flight to live launch

Quick checklist after all the above passes — the final items per the dev plan §17:

- [ ] All settings are reset to production-appropriate defaults:
  - [ ] Dispatch immediately on fulfillment: **OFF**
  - [ ] Cadence values match what you want for prod
  - [ ] Dispatcher time: 2pm local (or whatever you want)
  - [ ] New-review notifications: set to your real ops email + the ratings you actually want pinged
  - [ ] Profanity wordlist: cleaned of test entries
  - [ ] No active panic pause
  - [ ] No leftover test reviews on the storefront (you'll wipe the DB before prod cutover anyway, but tidy is good)
  - [ ] No leftover test campaigns
- [ ] All seeded email templates have been reviewed for prod-grade copy.
- [ ] Brand colors / logo / footer text all set to prod values.
- [ ] Admin theme set to the team's preference.

When the prod stack is stood up, the cutover steps (per dev-plan §14):
1. Run the §17 pre-deploy checklist on prod (DB snapshot, FK check, smoke test).
2. **Set the go-live cutoff to now** *immediately* after the first backfill completes.
3. Reach out to the dozen-ish legacy customers by hand (don't auto-email them).
4. Then turn dispatch-immediately OFF (if it was on for cutover testing) and let the schedule run normally.

---

## Appendix A: SQL snippets cheat sheet

### Find a customer + their purchases

```sql
SELECT c.id, c.email, c.global_opt_out, c.unanswered_request_count, c.last_request_sent_at,
       p.id AS p_id, p.shopify_order_id, p.shopify_product_id, p.fulfilled_at, p.due_at,
       p.request_count, p.last_request_at, p.reviewed_at, p.product_opt_out
  FROM customers c
  LEFT JOIN purchases p ON p.customer_id = c.id
 WHERE c.email = 'someone@example.com'
 ORDER BY p.id DESC;
```

### See all eligible purchases right now (what the next dispatcher run would pick up)

```sql
SELECT p.id, p.shopify_order_id, p.shopify_product_id, p.due_at, p.request_count, p.reviewed_at,
       c.email, c.global_opt_out, c.unanswered_request_count
  FROM purchases p JOIN customers c ON c.id = p.customer_id
 WHERE p.due_at IS NOT NULL AND p.due_at <= unixepoch()
   AND p.reviewed_at IS NULL AND p.product_opt_out = 0
   AND c.global_opt_out = 0
   AND p.request_count < (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'cadence_max_requests')
 ORDER BY p.due_at;
```

### Most recent dispatcher activity from email_events

```sql
SELECT kind, customer_id, purchase_id, created_at, metadata_json
  FROM email_events
 ORDER BY id DESC
 LIMIT 20;
```

### Counts of every key entity (sanity check before / after big tests)

```sql
SELECT 'customers' AS t, COUNT(*) AS n FROM customers UNION ALL
SELECT 'purchases', COUNT(*) FROM purchases UNION ALL
SELECT 'reviews', COUNT(*) FROM reviews UNION ALL
SELECT 'email_events', COUNT(*) FROM email_events UNION ALL
SELECT 'sample_invitations', COUNT(*) FROM sample_invitations UNION ALL
SELECT 'campaigns', COUNT(*) FROM campaigns UNION ALL
SELECT 'campaign_members', COUNT(*) FROM campaign_members UNION ALL
SELECT 'campaign_feedback_responses', COUNT(*) FROM campaign_feedback_responses;
```

### Reset a single purchase for repeat-testing (so the next dispatcher run sends to it again)

```sql
UPDATE purchases SET reviewed_at = NULL, request_count = 0, last_request_at = NULL, due_at = unixepoch() - 60, product_opt_out = 0
 WHERE id = <purchase_id>;
UPDATE customers SET last_request_sent_at = NULL, unanswered_request_count = 0, global_opt_out = 0
 WHERE id = (SELECT customer_id FROM purchases WHERE id = <purchase_id>);
DELETE FROM reviews WHERE customer_id = (SELECT customer_id FROM purchases WHERE id = <purchase_id>)
                      AND shopify_product_id = (SELECT shopify_product_id FROM purchases WHERE id = <purchase_id>);
```

### Wipe the entire dev DB to a clean slate (dev only — destructive)

```bash
# On Mercury:
docker stop reviews-app
rm /opt/stacks/shopify-reviews-dev/data/reviews.db
docker start reviews-app
# On boot, migrations re-run; you'll have a fresh DB with seeded defaults.
# Re-install Shopify webhooks afterward.
```

---

## Appendix B: Time-warp recipes

Time-bound triggers are the hardest thing to test "honestly" without waiting. These are the SQL-driven cheats — use them deliberately and reset state when done.

### Bypass the 7-day fulfillment delay

Either:
- **Settings UI:** turn ON `Dispatch immediately on fulfillment`. Easiest.
- **SQL:** backdate `fulfilled_at` and set `due_at` to past:
  ```sql
  UPDATE purchases SET fulfilled_at = unixepoch() - (8 * 86400), due_at = unixepoch() - 60
    WHERE id = <purchase_id>;
  ```

### Allow a second request earlier than the 7-day cadence

```sql
UPDATE customers SET last_request_sent_at = unixepoch() - (8 * 86400) WHERE id = <customer_id>;
UPDATE purchases  SET last_request_at     = unixepoch() - (8 * 86400) WHERE id = <purchase_id>;
```

### Expire a sample invitation

```sql
UPDATE sample_invitations SET expires_at = unixepoch() - 60 WHERE id = <id>;
```

### Re-arm a fired capacity warning

```sql
UPDATE campaigns SET capacity_warning_fired_at = NULL WHERE id = <campaign_id>;
```

### Force the panic-button to "lapse" (test auto-resume)

```sql
UPDATE settings SET value = CAST((unixepoch() - 60) AS TEXT) WHERE key = 'panic_paused_until';
```

### Force-expire the product cache TTL (so the next read goes back to Shopify)

```sql
UPDATE products_cache SET updated_at = unixepoch() - (2 * 3600) WHERE shopify_product_id = '<product_id>';
```

Or globally:

```sql
UPDATE products_cache SET updated_at = unixepoch() - (2 * 3600);
```

Or use the Admin UI's **Refresh product cache** button (Settings → Setup).

---

## Appendix C: Common errors and what they mean

| Symptom | Most likely cause |
| --- | --- |
| Storefront widget renders nothing, console shows CORS error | `STOREFRONT_ORIGIN` in `.env` doesn't match the dev store's storefront domain |
| Widget shows "temporarily unavailable" even though you didn't pause | A leftover panic pause from a prior test. Check `SELECT value FROM settings WHERE key = 'panic_paused_until';` |
| Webhook returns 401 in your logs (`hmac verification failed`) | `SHOPIFY_WEBHOOK_SECRET` doesn't match the app's client secret, OR Shopify's payload encoding is different from what we expect (uncommon) |
| `orders/paid processed` log line appears but the customer/purchase aren't in SQLite | `shop/redact` for an unknown shop OR the webhook resolved to a different shop_id than expected. Check the X-Shopify-Shop-Domain header in the log context. |
| App Proxy customer-review submission returns 401 invalid_signature | App Proxy isn't configured in dev.shopify.com, or the configured Proxy URL doesn't match `PUBLIC_URL` |
| `POST /proxy/brand` returns 404 from Shopify | App Proxy missing — same fix as above |
| Dispatcher runs but sends nothing, "considered: 0" | No purchases match the eligibility criteria. Walk through Appendix A's "see all eligible purchases" query to debug |
| Dispatcher runs and "send failed" appears | SMTP credentials wrong (`SMTP_USER`/`SMTP_PASS`), OR Gmail's daily quota hit, OR a transient SMTP issue. Check the error message in the email_events.metadata_json column |
| `customer_id IS NULL` error on campaign approval | The campaign member's email collided with an existing customer in a weird way. Check the upsert path in [src/db/campaigns.ts](src/db/campaigns.ts) |
| Discount code creation fails on launch_thanks send | `write_discounts` OAuth scope missing from the install, OR a Shopify API rate-limit. The all-or-nothing logic means no emails go out — re-install with the right scope and retry |
| Sample invitation page shows "expired" but the timestamp is in the future | Clock skew between the container and the host. Verify with `docker exec reviews-app date` and `date` on Mercury |

---

## Appendix D: When you find a bug

For each bug:

1. **Note where you were in this checklist** (e.g., "Part 14.19, step 3").
2. **What you did:** copy-paste the exact action.
3. **What you expected:** what the doc said should happen.
4. **What actually happened:** screenshots + log excerpt + relevant SQL state.
5. **Log excerpt:** copy the last 30 lines from `docker logs reviews-app` so the bug doesn't lose context.

That's enough for me to triage and fix without having to re-derive the test conditions.
