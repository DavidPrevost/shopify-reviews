# LIVE-CUTOVER — one-time migration runbook (Yotpo → Reviews on the live store)

> **One-time runbook.** This document is used **once**, for the live cutover of `teraclay.myshopify.com`, then archived to `docs/legacy/` after Phase 7. It is **not** part of the ongoing process — repeatable, store-agnostic install lives in [INSTALL.md](INSTALL.md); Yotpo cleanup appears here and nowhere else. For day-to-day operation see [OPERATIONS.md](OPERATIONS.md).

The goal: take the live store from "vestigial/broken Yotpo widget" to "fully on Reviews," with a clean rollback path at every step. Execution is yours (theme editor, Shopify admin, browser); this doc is the checklist. Work through the adaptive bits (exact theme file + widget placement) together when you're in the editor.

---

## Prerequisites (Phases 5 & 6 — must be done first)

Do **not** start the cutover until all of these are true. They're the output of the clean-Dev-Dashboard-app phase and the prod-stack phase.

- [ ] **Prod stack is healthy**: `curl https://reviews.teraclay.com/health` → `{"status":"ok"}` from outside the network.
- [ ] **Reviews app is installed on the live store** via OAuth, with the **corrected discount scopes** — `read_orders, read_customers, read_products, read_discounts, write_discounts`. ⚠ This is the [launch blocker in ROADMAP](ROADMAP.md): if the app was installed without `read_discounts`/`write_discounts`, campaign discount codes won't work and you'd have to re-consent on the live store. Confirm the scopes on the captured token before proceeding.
- [ ] **Webhooks subscribed** on the live store (`install-webhooks` run — they aren't auto-subscribed).
- [ ] **App Proxy configured** on the live app: prefix `apps`, subpath `reviews`, Proxy URL `https://reviews.teraclay.com/proxy/` (trailing slash).
- [ ] **DNS live**: `reviews.teraclay.com` resolves to the relay and serves over HTTPS.
- [ ] **A fresh prod DB snapshot exists** (see OPERATIONS → Backups) before any backfill.

---

## Pre-flight (before touching the live theme)

1. **Set brand assets in Shopify → Settings → Brand** (logo + brand colors). These must be set *before* the first storefront product-page visit on the new widget, so the **brand relay** populates `shop_brand_json` on cutover. If brand isn't set in Shopify, use **manual entry** in the Reviews admin (Branding) as the fallback.
2. **Duplicate the live theme** (Online Store → Themes → ⋯ → Duplicate). This duplicate is your **rollback safety net** — the currently-published theme stays untouched until you publish.
3. **Note where the Yotpo reviews widget currently sits** in the theme (which template/section, and the surrounding markup). That location is the **breadcrumb** for where the Reviews widget goes.
4. **The dev-store theme already has a working integration** (script tag + widget div + brand-relay attributes). Treat it as the source of truth and replicate it onto Trademark 1.7.3 — only the theme's file structure differs, not the snippet.
5. **Review and finalize the email templates** (Branding → Email) for prod-grade copy. The cutover ships with email *working* — dispatcher live, templates ready — not with sending disabled.

---

## The theme integration (Trademark 1.7.3 — adaptive placement)

Trademark 1.7.3 is a legacy (pre-OS-2.0) theme, so edits are direct file edits in the theme code editor. Work on the **duplicate** from pre-flight, then publish it when satisfied.

**1. Widget script** — add to `layout/theme.liquid`, just before `</body>`:
```html
<script src="https://reviews.teraclay.com/widget.js" defer></script>
```
(The bundle detects its own API base from this `src`, so it knows to call `reviews.teraclay.com`.)

**2. Product-page widget `<div>`** — place it where the Yotpo widget was (likely the product template/section — `templates/product.liquid` or `sections/product-template.liquid`, **confirm in the editor**). Replicate the dev theme's div. Reference shape:
```liquid
<div
  data-reviews-widget="full"
  data-product-id="{{ product.id }}"
  data-variant-id="{{ product.selected_or_first_available_variant.id }}"
  data-customer-id="{{ customer.id }}"
  data-brand-primary-bg="{{ shop.brand.colors.primary[0].background }}"
  data-brand-primary-fg="{{ shop.brand.colors.primary[0].foreground }}"
  data-brand-secondary-bg="{{ shop.brand.colors.secondary[0].background }}"
  data-brand-secondary-fg="{{ shop.brand.colors.secondary[0].foreground }}"
  data-brand-logo="{% if shop.brand.logo %}{{ shop.brand.logo | image_url: width: 400 }}{% endif %}"
></div>
```
Notes:
- `data-customer-id` (from `{{ customer.id }}`) is **UI-only** — it decides whether to show the review form or a "log in to review" link. Submission is always re-verified server-side via the App Proxy signature, so a spoofed value gains nothing.
- `data-variant-id` drives the **per-variant review pools** feature (products whose `variant_handling` metafield is `distinct` get their own pool; the rest share one). It's built and running on dev, so include it — replicate exactly how the dev theme sources the selected variant id and updates it on variant change (the widget re-renders on change via a MutationObserver). The snippet shows `{{ product.selected_or_first_available_variant.id }}` as a starting point; match the dev theme's actual handling.
- The `data-brand-*` attributes are what the brand relay reads and POSTs to `/proxy/brand`. The exact `shop.brand.colors…` Liquid is what the dev theme uses — **confirm it renders non-empty in the live theme** (it depends on brand being set in Settings → Brand). Guard the logo exactly as shown so a missing logo doesn't throw.

**3. Aggregate stars on collection cards** — in the product-card/grid snippet, where Yotpo's stars were:
```liquid
<div data-reviews-widget="aggregate" data-product-id="{{ product.id }}"></div>
```
A built, running feature — include it in the cutover. (Mirror wherever the dev theme places it.)

**4. Remove all Yotpo remnants:** the Yotpo widget div/snippet, any Yotpo `<script>` tags or Liquid includes in `theme.liquid`, leftover Yotpo asset references, **and Yotpo's product metafields** (Settings → Custom data → Products). A clean cutover leaves nothing of the old system behind.

**5. Preview the duplicate theme**, confirm the widget renders on a product page and Yotpo is gone, then **publish** the duplicate.

**6. Campaign & feedback form Pages.** Campaigns and feedback forms are storefront surfaces too — each is embedded in a Shopify **Page** (not a theme file), rendered by the widget script from step 1:
- Campaign application form → a Page containing `<div data-campaign-form="<campaign-slug>"></div>`.
- Campaign feedback form → a Page containing `<div data-campaign-feedback-form="<access-key>"></div>`.
Recreate, on the live store, every campaign/feedback Page that exists on dev (matching slugs/keys). If no campaign is active at go-live, wire these when you launch the first live campaign — the mechanism is part of the deployment, not an afterthought.

---

## Cutover sequence (the order to flip things)

1. Confirm all **Prerequisites** are green.
2. Confirm **brand assets** are set in Settings → Brand (or queued for manual entry).
3. **Duplicate** the live theme (rollback backup).
4. Take a **prod DB snapshot**.
5. Edit the duplicate: add the **widget script + div(s)**, remove **all Yotpo theme code**. Preview.
6. **Publish** the edited theme. Visit a **product page** once — this fires the brand relay and populates `shop_brand_json`.
7. Run the **prod backfill** (Settings → Setup → "Run backfill", or `npm run backfill`) to import recent paid orders.
8. **Immediately set the go-live cutoff guard** — Settings → Cadence → "Set cutoff to now". This (plus backfill leaving pre-cutoff orders un-armed) prevents the first dispatcher run from emailing your entire order history. (The email kill switch in Settings → Setup is an emergency stop, **not** a launch step — finalize templates as part of go-live, per pre-flight, rather than launching with email off.)
9. Run the **smoke tests** below. Once the widget is confirmed working, **uninstall the Yotpo app** (Apps → Yotpo → Delete) — last, because it's the least-reversible step.
10. **Manually reach out to the ~half-dozen pre-launch customers** by hand. Do **not** auto-email them — the cutoff guard deliberately excludes them from the dispatcher.

---

## Smoke tests

- [ ] `curl https://reviews.teraclay.com/health` → `{"status":"ok"}` (external).
- [ ] Product page: the **full widget renders** (reviews list / empty state + aggregate stars) and is styled with brand colors.
- [ ] Collection / search / grid pages: **aggregate stars render on product cards** (the `aggregate` widget).
- [ ] **Per-variant reviews**: on a `distinct`-variant product, switching variant shows that variant's pool (the widget re-renders on variant change).
- [ ] Admin **Branding → Widget** shows the brand colors — confirms the relay populated `shop_brand_json` (if blank after a product-page visit, check Settings → Brand and the `data-brand-*` Liquid, or use manual entry).
- [ ] **Logged-in customer submits a review** via the widget → succeeds (App Proxy POST), and the review appears.
- [ ] **Edit-your-own-review** works; **Report-this-review** files into the admin reports queue.
- [ ] If using sample invitations: a **single-use invite link** loads and submits (shows "Verified Reviewer").
- [ ] For **every campaign/feedback Page** you set up: the **application form** and **feedback form** load and submit; **generate discount codes** for a campaign and confirm creation succeeds (this is where the scope blocker bites if unresolved).
- [ ] Place a **test order** (Bogus Gateway) and fulfill it → a purchase row is created; confirm the **go-live guard** keeps historical customers out of the dispatcher's eligible set.
- [ ] **Email sends end-to-end** — trigger a review-request (e.g., the test order via the dev fulfillment toggle) and confirm it arrives with correct branding, links, and a working unsubscribe.

---

## Rollback

The cutover is designed so nothing destructive happens to review data, and the storefront is one click from reverting.

- **Primary safety net — the theme.** If anything looks wrong after publishing, **republish the original (pre-cutover) theme** from Online Store → Themes. That instantly restores the prior storefront (including the old Yotpo markup), with zero data loss. This is why the Yotpo app is uninstalled *last* — until then, the backup theme is a complete revert.
- **Backend misbehaving but theme fine:** the widget fails *gracefully* ("Reviews are temporarily unavailable") and you can hit the **panic "pause reviews"** control. Review data is untouched.
- **Data:** the pre-backfill **DB snapshot** is the restore point if a backfill imports something unexpected (restore per OPERATIONS).
- **Note:** the existing Yotpo install is already broken (lost account, 404'd button), so "roll back to working Yotpo" isn't a goal — rollback means returning to the known prior state (broken Yotpo and all) while you diagnose, not a regression in capability.

---

## After the cutover is stable (Phase 7 wrap — coordinator, not you)

Once smoke tests pass and the store is stable: add the launch entry to [CHANGELOG.md](../CHANGELOG.md), merge `develop` → `main`, and `git mv docs/LIVE-CUTOVER.md docs/legacy/` (this doc has done its job).
