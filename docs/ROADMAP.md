# ROADMAP — what's next, known debts, and what we're deliberately not building

> **📚 Documentation map** — Shopify Reviews app. Five maintained docs; this is one of them.
>
> - **`docs/STATE.md`** — What the app does *today*: architecture, feature catalogue, deploy topology. The "current reality" doc.
> - **`docs/INSTALL.md`** — Repeatable, store-agnostic install from scratch: Dev Dashboard app, `.env`, Docker stack, OAuth token capture, webhooks, App Proxy, brand assets.
> - **`docs/OPERATIONS.md`** — Running it in production: deploy & branch/hotfix flow, env-var reference, backups & restore, monitoring, troubleshooting.
> - **`docs/ROADMAP.md`** — What's next, known debts, deferred items, and the "explicitly NOT building" list.
> - **`CHANGELOG.md`** — Dated record of notable changes, one entry per release.

---

This is the catch-all for everything not built yet but worth remembering — bugs, fast-follows, deferred features, the multi-tenant plan, known debts, and the firmly-out-of-scope list. Inherited from the now-archived `development-plan.md` (idea-stash), `campaigns-feature-plan.md`, and `multi-tenancy-foundation.md`. Nothing here blocks v1 launch.

---

## Known bugs / small fixes

- **Hardcoded dispatcher-time string.** [`src/routes/admin.ts:461`](../src/routes/admin.ts#L461) tells the operator "The dispatcher normally runs daily at 14:00 UTC" next to the manual-run button. The schedule is operator-configurable (local-time picker), so this is wrong/misleading. Make it read the actual configured time, or remove the line.
- **Manual-ops buttons dump raw JSON.** "Run backfill" / "Run dispatcher" show raw payloads; replace with friendly success/error banners + a "show details" expander.
- **Branding → Email body cursor fix.** The shared first-keystroke textarea fix is applied to textareas, but the Branding → Email main body is a `contenteditable` div — if the App-Bridge first-keystroke bug shows up there, it needs a Range-based variant.
- **Dispatcher local-time DST edge + user-configurable timezone.** The admin picker converts local→UTC using the browser's offset at save time, so a DST transition could shift the effective fire time by an hour until the schedule is re-saved. No urgency (next DST change is ~5 months out). The clean fix pairs with a planned move to make the **timezone a user-configurable setting** (rather than the `.env` `TZ` var): store the operator's IANA zone and compute the schedule against it, which resolves the DST drift directly.

## Fast-follows (near-term, post-launch)

- **Auto-subscribe webhooks on OAuth callback.** Have `/auth/callback` call `installWebhooks(shop, token)` right after persisting the token, so a fresh install doesn't silently miss order events. (Critical for any multi-tenant/self-serve install.)
- **Per-surface panic exclusions.** The pause currently halts every surface; campaign applications (which queue for manual review) arguably shouldn't pause during a review-targeted panic. Add per-surface granularity.
- **Campaign template editor: full visual-toolbar parity** with Branding → Email (bold/italic/headings/alignment/colors/insert-logo/raw-HTML toggle). Extract the editor into a shared module rather than duplicating.
- **Admin nav audit / tab reorganization** once the post-launch surface stabilizes (nav was built additively).

## Deferred features (v2+)

**Reviews & storefront UX**
- Full-text content search (SQLite FTS5) in the admin reviews list; filters for `verified_kind` / has-merchant-reply.
- Storefront-side sort (rating high/low, date) + filter (verified vs not) + content search.
- Configurable widget pagination (page-size dropdown, "load more").
- Configurable minimum review body length (default 0 = star-only allowed).
- Per-product **"skip review requests"** metafield (`reviews.skip_requests`) — exclude gift cards/services/sensitive products from the dispatcher (same pattern as `variant_handling`).
- Per-product **cadence overrides** (metafield overriding `request_delay_days` per product).
- Widget visual polish: SVG stars, disclosure animation, typography/empty-state refinement.
- **Structured data for SEO (JSON-LD `AggregateRating` / `Review`).** The widget emits no schema today. The (now-sunset) Shopify Product Reviews app gave Google its star-rating rich snippets via an `AggregateRating` block, so the live cutover **drops those Google stars** until we emit our own — e.g. a Liquid block fed by the aggregate API, or from the widget. Flagged at cutover (2026-06-03) as an SEO regression to restore.

**Schema-ready v2 surfaces** (tables/columns already poured; no feature code yet)
- **Photos in reviews** — `review_media` table exists; needs upload handling, storage (Mercury FS → CDN-pluggable), widget display.
- **Product Q&A** — `questions` table exists; needs submission UI, admin moderation, product-page display.
- **Merchant replies on the storefront** — `reviews.merchant_reply` is stored via admin; widget needs to render it inline under each review.

**Email**
- **Trigger system v2** — replace the "prior reviews? repeat : first" heuristic with configurable per-template triggers (event + delay + exclusion criteria). Substantial; only worth it past ~2–3 templates. Wire the existing `review_submitted_thankyou` trigger (currently `wired:false`) as part of this.
- Email visual polish (logo header refinements, typography, on-brand spacing).

**Operations & analytics**
- Per-customer data export (reviews/purchases/email-events/opt-outs/invitations as JSON/CSV) — GDPR/CCPA tool.
- Backup management UI (last-run timestamp, size, success, "run now").
- Dashboard system-health card (dispatcher last-run + outcome, pending reports, last review, last backup).
- Analytics: trends over time (avg rating, volume, response rate), per-product, and email funnel (sent→opened→clicked→submitted). Data already accumulates in `reviews` / `email_events`.
- Webhook replay v2 (selectable range, per-order / per-type replay) — the current `/admin/sync` backfill is a blunt 90-day sweep.

**Campaigns**
- **Ongoing / rolling-campaign mode.** The v1 status enum is tuned for batch campaigns. The missing mechanic is per-member email auto-fire — sketch: a `campaign_scheduled_emails(id, campaign_id, member_id, trigger, fire_at, status)` table that cron scans for `fire_at <= now AND status='pending'`. A separate rolling-campaign status model will likely be needed.
- Applicant **variant choice** (v2: applicant picks size/color of a merchant-selected product) → truly **custom form fields** (v3, beyond Shopify-variant-modeled).
- Per-campaign **disable-capacity-warning** checkbox.
- **Single shared discount code** option (one `SUMMER40` with a global cap) as an alternative to per-participant unique codes — needs a schema change (per-member code nullable + campaign-level shared code).
- Advanced reporting: charts, multi-campaign dashboards, CSV export beyond basic.
- Shopify-Functions discount cap ("percent off with an absolute cap") — Shopify's discount API can't express it natively today; uncapped percentage + `usageLimit` + short expiry is the accepted v1 tradeoff.

## Multi-tenant roadmap

The single-tenant **foundation (Part A) is done**: `shop_id` on every domain table, composite constraints rebuilt (migration 016), the `shops` table + `getCurrentShopId()` seam, shop-scoped GDPR redaction. **OAuth install + embedded admin** (originally B4/B6) have also shipped. Guiding principle preserved: *"pour the schema now"* only for irreplaceable, constraint-heavy data — defer reconstructable config and code-layer changes (don't thread `shop_id` through the query layer until reads are genuinely shop-scoped, to avoid "works only because there's one shop" traps). Tenant = **shop**, orthogonal to user identity (Shopify's session token is the identity layer; no users table).

Deferred **Part B** (no data-migration penalty — build when multi-tenancy is actually approached):

- **B1** Per-shop `settings` (PK `(key)` → `(shop_id, key)`; `getSetting`/`setSetting` filter via `getCurrentShopId()`).
- **B2** Denormalized `shop_id` on child/ops tables (`review_media`, `email_events`, `moderation_events`, `panic_events`, `review_reports`, `banned_reporters`) — cheap `ADD COLUMN` later.
- **B3** Query-layer shop scoping (thread `shop_id = getCurrentShopId()` through every query).
- **B5** Per-shop secrets + **encryption at rest** (move Shopify token + webhook secret from `.env` to the shop row).
- **B7** Scalable email / transactional ESP — per-shop sender identity + deliverability (SPF/DKIM), per-shop rate limits, tenant-isolated suppression. *Flagged as the single largest piece of true multi-tenancy.*
- **B8** Per-shop cadence + send fairness in the scheduler (per-shop dispatcher loop).
- **B9** Per-shop / dynamic CORS (`/api/*` uses the `shops.storefront_origin` column already poured in A1).
- **B10** Zero-touch onboarding + **Theme App Extension** — self-service setup wizard (App Proxy/brand/cadence with sane defaults) and a theme-editor widget drop with no code edits (the widget already self-detects its API base).
- **B11** Shopify **Billing API** (plans, trials, recurring charges).
- **B12** App Store listing, review & compliance (privacy policy / DPA / ToS, Core Web Vitals budget on the widget, GDPR/redact review).
- **B13** Support & ops tooling (per-tenant logging/error tracking, safe shop impersonation, abuse handling, status page, SLA).
- **B14** **Postgres** migration (SQLite is single-writer-per-file — fine for one store, a ceiling for many).
- **B15** CI/CD + online migrations + zero-downtime deploys against a shared multi-tenant DB.
- **Pre-existing-customer onboarding** for an adopting store: a gentler "invite your back-catalog" campaign, selective per-customer/order import, cutoff-date vs selective-import, dedupe against already-reviewed. (Our own go-live just uses the blunt `request_cutoff_at` guard + manual outreach to ~6 legacy customers.)

## Known debts & risks

- **SQLite write ceiling** — single-writer-per-file; the throughput cap for many concurrent shops (→ Postgres, B14). Lean portable when writing new SQL.
- **Profanity re-scan at scale** — a wordlist save currently re-checks *every* review. Fine at small volumes; at tens of thousands, switch to a delta approach (only re-filter reviews containing added/removed words) and/or move it off the request thread.
- **Gmail free-tier ~500 sends/day** — the per-run batch cap (default 100) keeps us well under; raise as volume grows, and move to an ESP for real scale (B7).
- **GCP relay 1 GB/month egress** — comfortable for small-brand traffic; overage ~$0.12/GB; budget alert is the safety net.
- **Orphan-row cleanup before any constraint-rebuild migration** — the deferred-FK check at `COMMIT` surfaces orphans that `foreign_keys = ON` tolerated. Run `PRAGMA foreign_key_check` on a copy and clean before migrating prod.
- **Logo uploads not backed up** — `data/uploads/` isn't in the nightly snapshot (only the DB is). Extend `backup.sh` if needed.
- **Reliance on Shopify's legacy install flow.** Install uses the legacy OAuth authorization-code grant — the one-shot `install-shopify.ts` CLI plus the redirect flow in `auth.ts` — which requires the "Use legacy install flow" toggle on the app, a feature Shopify may eventually deprecate. We chose it because the background dispatcher needs a permanent **offline** token and the one-shot grant was the simplest way to capture one for a single store. Future: migrate to Shopify **managed installation + Token Exchange** (mint an offline token from the App Bridge session token), which removes the legacy toggle and the redirect/CLI dance and dovetails with zero-touch onboarding (B10) + webhook auto-subscribe. Verify against current Shopify auth docs at implementation time.

## Explicitly NOT building (considered and declined)

- **Pre-publish moderation queue / auto-publish toggle** — trust model is publish-now, retract-with-reason; pre-publish gating hurts the trust signal.
- **Auto-flag by rating** — same reason (a form of pre-publish gating for negative reviews).
- **Bulk moderation actions** — unnecessary without pre-publish moderation; search/filter serves the same goal.
- **Reply-template snippets** — encourage genuine, targeted replies; copy-paste suffices.
- **Shopify customer tag sync** (tagging customers by review activity) — adds Shopify-write coupling, doesn't fit the marketing flow; data is already queryable for manual segmentation.
- **Reviewer attribution beyond first-name** — first name (from the Shopify customer record, or the first word of a sample invitation's intended name) is the answer.
- **Self-hosted email server** — deliverability is hostile; Gmail SMTP via the brand alias is the choice.
- **CRM features in Campaigns** — segmentation, A/B testing, multi-touch attribution, lead scoring, cross-campaign journeys. Out of scope.
- **Speculative surface expansion** — don't extend beyond documented scope without a decision.

## Bigger-picture ideas (further out)

- **Affiliate/influencer platform** — a separate self-hosted service on the same Mercury + relay + Caddy infrastructure (additional subdomains).
- **Self-hosted small brand sites** on the same stack.
- **Outgoing webhooks** — fire events (review submitted/reported) to Klaviyo / Slack / custom endpoints; build iteratively per requested integration, not speculatively.
