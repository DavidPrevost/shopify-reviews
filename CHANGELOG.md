# Changelog

> **📚 Documentation map** — Shopify Reviews app. Five maintained docs; this is one of them.
>
> - **`docs/STATE.md`** — What the app does *today*: architecture, feature catalogue, deploy topology. The "current reality" doc.
> - **`docs/INSTALL.md`** — Repeatable, store-agnostic install from scratch: Dev Dashboard app, `.env`, Docker stack, OAuth token capture, webhooks, App Proxy, brand assets.
> - **`docs/OPERATIONS.md`** — Running it in production: deploy & branch/hotfix flow, env-var reference, backups & restore, monitoring, troubleshooting.
> - **`docs/ROADMAP.md`** — What's next, known debts, deferred items, and the "explicitly NOT building" list.
> - **`CHANGELOG.md`** — Dated record of notable changes, one entry per release.

---

Notable changes, newest first. Dates are `YYYY-MM-DD`.

## [Unreleased]

- _Phase 7 will record the v1 production launch (cutover to the live store) here._

## Pre-launch baseline — 2026-06-03

The app's state as it enters the v1 launch sequence. Built and validated on the dev store; not yet live on the production store.

**Capabilities at baseline**
- Review collection via post-purchase email requests, storefront submission (App Proxy), and sample/campaign invitations; immediate publish with retract-with-reason moderation, profanity censor-on-write, a storefront report-this-review queue, and a panic "pause reviews" control.
- Email **cadence & suppression engine** (the core differentiator): SQL-driven eligibility (already-reviewed / global & per-product opt-out / max-requests / min-days), a go-live cutoff guard, an emails kill switch, an operator-set daily dispatcher time, and a per-run batch cap.
- Table-driven, trigger-bound **email templates** with shared branding; the in-email CTA styling is sourced from the Widget config; self-hosted logo upload.
- Theme-agnostic **storefront widget** (`full` / `aggregate`) with brand assets fed by the Liquid brand relay + manual-entry fallback.
- **Campaigns**: application-based sample distribution with versioned terms, capacity auto-close, per-participant discount codes (redemption-tracked), anonymous feedback forms, and a retention/address-purge pipe.
- **Sample invitations** (single + CSV batch) with a distinct "Verified Reviewer" badge.
- **Embedded admin** via Shopify App Bridge + OAuth (per-shop offline token); **multi-tenant foundation** (Part A) poured but dormant (single-tenant today).
- Deployed via Docker on Mercury (dev + prod stacks), public ingress through a GCP Caddy + Tailscale relay, nightly SQLite backups to Pebbles.

**Pre-launch cleanup (on `develop`)**
- Removed the dead Storefront-API brand-sync path (`storefront-client.ts`, `fetchShopifyBrand`, `/admin/settings/sync-brand`) and the unused `@shopify/shopify-api` dependency; corrected stale comments from the embedded-admin/OAuth transition; annotated the reserved-for-v2 schema (`review_media`, `questions`, `merchant_reply`).
- Bumped `hono` to 4.12.23 (cleared a moderate-severity advisory).
- Synced `.env.example` to the real environment (dropped the dead `ADMIN_*` vars).
- Replaced the prior planning docs with this five-document suite (`STATE`, `INSTALL`, `OPERATIONS`, `ROADMAP`, `CHANGELOG`); archived the originals to `docs/legacy/`.
