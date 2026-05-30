# Campaigns Feature — Development Plan

This document tracks the design and build of the Campaigns feature inside shopify-reviews. It is scoped to this feature set; the canonical app-wide reference remains [development-plan.md](development-plan.md). When this document and the main plan conflict, the main plan wins for cross-cutting concerns; this document is authoritative for campaign-specific decisions.

## Build status

All ten steps from §7 below are code-complete and pass typecheck. End-to-end manual verification on the dev stack is pending — the user-requested workflow was build everything, verify at the end. Notable artifacts:

- **Migrations:** [018_campaigns.sql](src/db/migrations/018_campaigns.sql), [019_campaign_feedback.sql](src/db/migrations/019_campaign_feedback.sql)
- **Queries:** [src/db/campaigns.ts](src/db/campaigns.ts), [src/db/feedback.ts](src/db/feedback.ts)
- **Admin routes:** [src/routes/admin-campaigns.ts](src/routes/admin-campaigns.ts) (mounted at /admin/campaigns from [src/routes/admin.ts](src/routes/admin.ts))
- **Public routes:** campaign apply + feedback endpoints in [src/routes/proxy.ts](src/routes/proxy.ts)
- **Widget:** campaign-form + feedback-form rendering in [src/widget/widget.ts](src/widget/widget.ts)
- **Email dispatcher:** [src/email/dispatch-campaign.ts](src/email/dispatch-campaign.ts), capacity-warning helper in [src/email/notify-campaign-capacity.ts](src/email/notify-campaign-capacity.ts)
- **Shopify discount codes:** [src/shopify/discount-codes.ts](src/shopify/discount-codes.ts); `write_discounts` added to [src/shopify/oauth.ts](src/shopify/oauth.ts) OAUTH_SCOPES (merchants will be re-prompted on next install)
- **Webhook:** `orders/paid` extended in [src/routes/webhooks.ts](src/routes/webhooks.ts) to detect campaign-code redemptions

Pre-deploy checklist:
1. Rebuild the widget bundle (`npm run build`) before the campaign-form / feedback-form divs render in the browser.
2. Re-install the Shopify app (or run an OAuth reauth) so the new `write_discounts` scope is granted before clicking "Generate discount codes."
3. The `feedbackUrlsHtml` email block links to a placeholder App Proxy URL — merchants should swap their actual Shopify Page URL into the shipped-notification and review-reminder template bodies when configuring real feedback forms.

---

## 1. Purpose

Application-based sample distribution program managed end-to-end inside the reviews app. Originally driven by the brand's Summer 26 review-seeding push (recruit ~75 participants, mail 3-product sample packs, collect reviews), designed so the same machinery supports ongoing free-sample customer-acquisition campaigns as a future extension.

Built inside shopify-reviews rather than as a separate app because the customers table, email pipeline, sample_invitations + /sample-program review flow, branding/admin shell, and App Proxy are already in place. A separate app would duplicate roughly 70-80% of that and require a sync layer.

---

## 2. Scope

### In scope (v1 build)

- Per-campaign data model with status lifecycle, target size, terms (versioned), discount config, and product set.
- Public application form embedded in a Shopify Page via the widget pattern; POST through App Proxy.
- Application moderation queue (approve / reject) with customer upsert on approval.
- Bulk-generate 3 sample invitations per approved member, reusing the existing /sample-program flow.
- Four new email triggers with admin batch-send buttons; per-recipient template rendering.
- Per-participant unique discount codes via the Shopify Admin API, with usage-limit-1 + per-customer-scope + expiry.
- Redemption tracking via the `orders/paid` webhook.
- Discount-code cleanup action with two options ("delete unredeemed only" / "delete all").
- Capacity-warning email at a configurable threshold; one-shot per crossing with manual re-arm.
- Retention pipe: campaign close triggers two-stage quarantine of shipping addresses (reuses the affiliate-app pattern).
- Feedback forms per (campaign, product) with anonymous submission + admin reporting view.

### Out of scope (deferred, logged as future)

- Per-member email auto-fire scheduling (the mechanic that unlocks ongoing-campaign mode).
- A status model tailored to ongoing campaigns — the v1 enum is tuned for batch campaigns and will not fit rolling mode without revision.
- Applicant variant choice (merchant selects product but applicant picks size/color).
- Truly custom form fields not modeled in Shopify variants (size preferences, "why are you interested," etc.).
- Disable-capacity-warning checkbox (per-campaign opt-out of the warning entirely).
- Advanced reporting (charts, multi-campaign dashboards, CSV export beyond basic).
- Shopify-side discount "percent off with absolute cap" via Shopify Functions.
- Standalone-hosted form URL at reviews.<brand>.com/sample-program/* — Shopify-Page hosting is the only path.
- CRM features: segmentation, A/B testing, multi-touch attribution, lead scoring, cross-campaign journeys. Explicitly rejected.

---

## 3. Design Decisions

Decisions reached during the design conversation. Each is load-bearing for the implementation; revisiting one means revisiting the plan.

### Naming

- Admin tab is **Campaigns**, not "Sample Program." Keeps the feature general-purpose.
- Each campaign has a user-facing `name` (free text, set by merchant in setup) and a separate URL-safe `slug` (e.g., `summer26`).

### Form delivery

- Public form is rendered by our widget JS into a Shopify Page. Merchant creates a Page in Shopify admin and pastes `<div data-campaign-form="<slug>"></div>` in the body.
- Form submissions POST through App Proxy to `/proxy/campaigns/:slug/apply`.
- Form code lives in our app (one place to maintain, one place to ship updates). Merchant manages surrounding page copy in Shopify admin.
- No standalone-URL fallback. Shopify storefront is a hard requirement for using this feature.

### Status lifecycle

Explicit enum on `campaigns.status`:

```
draft → recruiting → closed → shipping → active → completed
                                                   ↑
                                          cancelled (from any state)
```

- `draft`: campaign assembled but not published. Public form URL returns 404.
- `recruiting`: form is live, applications accepted.
- `closed`: target_size hit OR manually closed. Form returns "applications closed."
- `shipping`: admin marked sample packs as mailed. (Set when ship-notification batch is queued.)
- `active`: review-reminder batch sent.
- `completed`: launch email sent. Triggers retention pipe Stage 1.
- `cancelled`: soft-kill from any prior state. Cleanup behaviors apply (codes can be deleted, addresses can be quarantined).

States are stored explicitly, not inferred from timestamps. Transitions are admin-triggered (typically by the action that defines the state — clicking "Send launch email" both sends and flips to `completed`).

**Future note:** this enum is tuned for the batch-campaign lifecycle. Ongoing/rolling campaigns will need a different state model when that feature lands.

### Terms

- Stored in a separate versioned table: `campaign_terms_versions(id, campaign_id, version_number, body_text, created_at)`.
- `campaign_members` references a specific terms version via `terms_version_id` plus a `terms_accepted_at` timestamp.
- Editing terms on a published campaign creates a new version row; existing members keep pointing at their original version.
- Admin can view version history per campaign and link to the historical text from each member's row.

### Opt-out behavior

- Campaign-issued emails are **non-revocable consent in the terms** — accepting the terms is a condition of participation, and the four campaign emails are part of the bargain.
- Prior `customers.global_opt_out = 1` does NOT block campaign sends. Members who applied while opted-out still receive campaign emails.
- Campaign sends do NOT increment `customers.unanswered_request_count` or `customers.last_request_sent_at`. Campaign sends are separate from review-request cadence; counting them would suppress future review requests inappropriately.

### Reviewed-products handling in the reminder email

- The `campaign_review_reminder` template uses generic copy: "If you've already reviewed, thank you. If you haven't, your links are below."
- All three product review links are included in every reminder, regardless of per-product review state.
- Reason: per-recipient link filtering is brittle (the customer might have reviewed via the storefront customer modal without using their unique link), and the engineering cost outweighs the polish.

### Application form fields (v1)

Fixed schema for v1:

- First name, last name
- Email
- Shipping address (name, street, city, state/region, postal code, country)
- Optional message / "why are you interested" free text
- Terms acceptance checkbox (linked to the active terms version)

All non-fixed fields (free-text "why," any future per-campaign questions) go into `application_data_json`. Shipping address lives in its own dedicated nullable `shipping_address_json` column on `campaign_members` so retention-pipe redaction is a single column update.

Per-campaign custom form fields are a future feature (variant-selection v2 / custom-fields v2).

### Capacity warning

- Per-campaign configurable absolute threshold (default = 80% of target_size).
- Setup form orders fields so the threshold is configured AFTER target_size, so the live UI can show "warning fires at N of M applications."
- Single warning per crossing. Once it fires, it does not fire again unless re-armed.
- Admin "Reset capacity warning" button re-arms it (useful after rejecting applications drops the count below threshold and the merchant wants notification on the next crossing).
- v2: a per-campaign checkbox to disable the warning entirely.

### Auto-close

- When approved+pending applications reach `target_size`, the campaign auto-flips from `recruiting` to `closed`.
- Public form on closed campaigns shows "applications closed."
- Admin can manually re-open (status flip back to `recruiting`) if rejections free up capacity.

### Discount codes

- Per-participant unique codes via `discountCodeBasicCreate` Admin API mutation.
- Required scope: `write_discounts` (add to OAuth scope list).
- Per code: `usageLimit: 1`, customer eligibility scoped to that member's Shopify customer record, `endsAt` configurable per campaign.
- Discount type: percentage off (configurable per campaign). Shopify's discount API does not natively support "percent off with absolute cap"; uncapped percentage is accepted as the tradeoff. Cap-via-Shopify-Functions is deferred to v2.
- Code string format: configurable per-campaign prefix (e.g., `S26-`) + random suffix.
- Storage on `campaign_members`: `discount_code` (string), `discount_code_id` (Shopify GID for delete API), `code_status` enum (`active` / `redeemed` / `expired` / `deleted_from_shopify`).
- Codes are batch-created at the time the merchant clicks "Send launch email" — that's the moment they need to exist.

### Redemption tracking

- `orders/paid` webhook handler examines `order.discountApplications` for codes matching any campaign-issued code.
- On match: flip `campaign_members.code_status = 'redeemed'`, store the order id and timestamp on the member row.
- Admin Campaign detail view shows: `X of Y codes redeemed, total revenue $Z, avg order $W, redemptions over time`.

### Code cleanup

Admin action on a completed campaign offers two buttons:

- "Delete unredeemed codes" — clears expired-without-redemption codes from Shopify, preserves used codes (keeps the at-a-glance Shopify-side Discounts-list view of which codes drove revenue). This is the conservative default.
- "Delete all campaign codes" — clears every code from Shopify. Redemption history persists on the orders themselves; aggregate reports still work; only the per-code rows in Shopify's Discounts list go away.

Our database keeps the full audit trail forever in both cases — only Shopify-side records are touched.

### Retention pipe

Reuses the affiliate-app two-stage human-confirmed pattern documented at `D:\AI\Affiliate\docs\data-retention.md`.

- Status transition to `completed` (or `cancelled`) triggers Stage 1: every `campaign_members.shipping_address_json` for that campaign flips to a `pending_deletion` state (e.g., a `retention_status` column or move to a parallel quarantine table).
- Application code no longer reads the quarantined field; the merchant-facing UI behaves as if shipping addresses are gone.
- Quarantined rows appear in a new admin "Retention queue" view (per the affiliate app's pattern).
- Stage 2: merchant reviews the queue and confirms the batch. Hard delete sets `shipping_address_json = NULL` and flips `retention_status` to `purged`.
- Name, email, campaign association persist on a longer clock (analogous to the affiliate app's contact-record clock — TBD whether to keep indefinitely while the campaign exists, or set its own clock).

### Feedback forms

- Data model:
  - `campaign_feedback_forms(id, campaign_id, shopify_product_id NULL, title, intro_text, access_key, created_at)` — one form per (campaign, product); NULL product means "campaign-wide feedback."
  - `campaign_feedback_questions(id, form_id, position, type, prompt, required, options_json)` — v1 types: `rating_1_5`, `single_choice`, `multi_choice`, `short_text`, `long_text`.
  - `campaign_feedback_responses(id, form_id, submitted_at, optional_name, optional_email, ip_hash)` — one row per submission. `ip_hash` is anti-spam only; not joined to anything.
  - `campaign_feedback_answers(response_id, question_id, value_text, value_number, value_json)` — per-question values.
- Access via shared URL key (e.g., `<brand>.com/pages/summer-26-feedback?key=7x9k`). Not per-user tokens — fully anonymous by design.
- Form rendering uses the same widget pattern as the application form. Merchant creates a Shopify Page per form, pastes `<div data-campaign-feedback-form="<key>"></div>`.
- Admin form builder: stripped-down Google-Forms-style UI per campaign.
- Reporting v1: per-question aggregates (distribution bars for rating/choice, response list for text). No charts, no CSV export — both v2.
- New email variable `feedbackUrlsHtml` expands into a block of "Product A: [Give feedback] · Product B: [Give feedback]" links in the shipped-notification and review-reminder templates.

### Variant selection

- v1: merchant picks 3 products from the Shopify catalog as part of campaign setup. For each product, merchant picks a specific variant. No applicant choice.
- v2: applicant variant choice (form gets a size/color dropdown per product, member row records the chosen variant, invitations get tagged accordingly).
- v3: truly custom form fields (size preference for brands without size variants, free-text questions, etc.).

### Ongoing-acquisition campaigns (future, designed-for)

Same data model and admin UI; the missing piece is per-member email auto-fire. New future table sketch: `campaign_scheduled_emails(id, campaign_id, member_id, trigger, fire_at, status)`. Cron scans for `fire_at <= now AND status='pending'`, fires the matching template per-recipient, marks sent. Plugs into everything else with no migration to existing tables.

Status enum will likely need a separate model for rolling campaigns — flagged but not designed here.

---

## 4. Data Model

Single migration adds the new tables and the `campaign_id` column on `sample_invitations`. SQLite; multi-tenancy-aware (`shop_id` on every row, following the migration-016 pattern).

```sql
-- New tables

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  target_size INTEGER NOT NULL,
  capacity_warning_threshold INTEGER,
  capacity_warning_fired_at INTEGER,
  product_set_json TEXT NOT NULL,        -- [{shopify_product_id, shopify_variant_id}, ...]
  discount_percent INTEGER,
  discount_expires_days INTEGER,
  discount_code_prefix TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(shop_id, slug)
);
CREATE INDEX idx_campaigns_status ON campaigns(shop_id, status);

CREATE TABLE campaign_terms_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  body_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(shop_id, campaign_id, version_number)
);

CREATE TABLE campaign_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id),       -- NULL until approved
  status TEXT NOT NULL DEFAULT 'applied',             -- applied|approved|rejected|shipped|reviewed|done
  application_data_json TEXT NOT NULL,
  shipping_address_json TEXT,                         -- nullable for retention purge
  retention_status TEXT NOT NULL DEFAULT 'active',    -- active|pending_deletion|purged
  terms_version_id INTEGER NOT NULL REFERENCES campaign_terms_versions(id),
  terms_accepted_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  discount_code TEXT,
  discount_code_id TEXT,                              -- Shopify GID for delete API
  code_status TEXT,                                   -- NULL|active|redeemed|expired|deleted_from_shopify
  code_redeemed_at INTEGER,
  code_redeemed_order_id TEXT,
  code_redeemed_order_total REAL,
  decided_at INTEGER,
  decided_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_campaign_members_campaign_status ON campaign_members(shop_id, campaign_id, status);
CREATE INDEX idx_campaign_members_email ON campaign_members(shop_id, json_extract(application_data_json, '$.email'));
CREATE INDEX idx_campaign_members_code ON campaign_members(discount_code) WHERE discount_code IS NOT NULL;

-- Feedback forms

CREATE TABLE campaign_feedback_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  shopify_product_id TEXT,                            -- NULL = campaign-wide
  title TEXT NOT NULL,
  intro_text TEXT,
  access_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(shop_id, access_key)
);

CREATE TABLE campaign_feedback_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  form_id INTEGER NOT NULL REFERENCES campaign_feedback_forms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,                                 -- rating_1_5|single_choice|multi_choice|short_text|long_text
  prompt TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,                                  -- choice options for single_choice/multi_choice
  created_at INTEGER NOT NULL
);

CREATE TABLE campaign_feedback_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL,
  form_id INTEGER NOT NULL REFERENCES campaign_feedback_forms(id) ON DELETE CASCADE,
  submitted_at INTEGER NOT NULL,
  optional_name TEXT,
  optional_email TEXT,
  ip_hash TEXT
);

CREATE TABLE campaign_feedback_answers (
  response_id INTEGER NOT NULL REFERENCES campaign_feedback_responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES campaign_feedback_questions(id) ON DELETE CASCADE,
  value_text TEXT,
  value_number REAL,
  value_json TEXT,
  PRIMARY KEY (response_id, question_id)
);

-- Existing table modification

ALTER TABLE sample_invitations ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id);
CREATE INDEX idx_sample_invitations_campaign ON sample_invitations(campaign_id) WHERE campaign_id IS NOT NULL;
```

---

## 5. Routes

### Public (App Proxy, HMAC-verified)

- `GET  /proxy/campaigns/:slug/config` — returns campaign metadata + active terms text + form schema. Used by the widget to render the form. 404 if status != `recruiting`.
- `POST /proxy/campaigns/:slug/apply` — submit application. Validates required fields, captures terms_version_id, writes `campaign_members` row, fires `campaign_application_confirmation` email. Rate-limit by IP. Auto-close trigger checked here.
- `GET  /proxy/campaigns/feedback/:access_key/config` — returns feedback form schema.
- `POST /proxy/campaigns/feedback/:access_key/submit` — submit feedback responses.

### Admin (auth-protected)

- `GET  /admin/campaigns` — list with status counts.
- `POST /admin/campaigns` — create campaign (name, slug, target_size, threshold, discount terms, initial terms text).
- `GET  /admin/campaigns/:id` — detail page with status, members grouped by status, batch-send buttons, discount-code stats, feedback-form list.
- `POST /admin/campaigns/:id/status` — transition status (publish from draft, close, ship, complete, cancel, reopen).
- `POST /admin/campaigns/:id/terms` — save new terms version.
- `POST /admin/campaigns/:id/products` — set product/variant selection.
- `POST /admin/campaigns/:id/members/:memberId/approve`
- `POST /admin/campaigns/:id/members/:memberId/reject`
- `POST /admin/campaigns/:id/members/:memberId/remove` — pre-ship hard delete.
- `POST /admin/campaigns/:id/generate-invitations` — bulk-create 3 sample_invitations per approved member.
- `POST /admin/campaigns/:id/generate-discount-codes` — batch-create via Shopify API.
- `POST /admin/campaigns/:id/send/:trigger` — manual batch-send for one of the three admin-triggered email events.
- `POST /admin/campaigns/:id/reset-capacity-warning`
- `POST /admin/campaigns/:id/cleanup-codes` — delete-unredeemed-only or delete-all.
- `GET  /admin/campaigns/:id/feedback/:formId` — reporting view per form.
- `POST /admin/campaigns/:id/feedback` — create feedback form.
- `POST /admin/campaigns/:id/feedback/:formId/questions` — add/edit/remove questions.
- `GET  /admin/retention-queue` — new top-level page; lists quarantined shipping addresses across campaigns; bulk-confirm purge.

### Webhooks

- `POST /webhooks/orders/paid` — existing handler extended to check for matching campaign discount codes and update `campaign_members.code_status`.

---

## 6. Email Triggers & Variables

Added to `src/email/triggers.ts`:

| Event | Wired | Description |
|---|---|---|
| `campaign_application_confirmation` | true | Sent automatically on application submission. Confirms receipt and reiterates terms. |
| `campaign_shipped_notification` | true (admin batch) | Sent when admin clicks "Send shipped notifications." Per-recipient: includes their 3 review links. |
| `campaign_review_reminder` | true (admin batch) | Reminder 2-3 weeks after shipping. Generic copy ("if you've reviewed, thank you; otherwise here are your links"). |
| `campaign_launch_thanks` | true (admin batch) | Brand-launch announcement with the per-participant discount code. |

Added to `src/email/variables.ts`:

| Key | Description |
|---|---|
| `campaignName` | Human-readable campaign name. |
| `reviewLinksHtml` | Pre-rendered block of the participant's 3 review-link buttons (one per product). Mirrors `productsHtml`. |
| `discountCode` | Per-participant unique discount code string. |
| `feedbackUrlsHtml` | Pre-rendered block of feedback-form links (one per product or per campaign-wide form). |

Default templates seeded on first boot for all four events. Merchant-editable like the existing templates.

---

## 7. Suggested Implementation Sequencing

Sequencing reflects "smallest visible end-to-end first, then layer in capabilities." Each step builds something testable on the dev stack. Within a step, parallelization is fine; between steps, the verification gate matters because later work depends on earlier behavior.

Phase numbers are a suggestion, not a contract; reorder if implementation reveals a better path.

### Step 1 — Migration + admin shell

Migration adds all new tables and the `sample_invitations.campaign_id` column. Admin "Campaigns" tab lands with list + create + empty detail views. Status transitions wired (just status updates, no side effects yet). Terms editor that creates new version rows on save.

Verification gate: create a draft campaign, edit terms (creates v1 then v2 rows), transition through statuses manually. No public-facing surface yet.

### Step 2 — Public application form + auto-confirmation

Campaign widget JS bundle (extends existing widget). Public `/proxy/campaigns/:slug/config` and `/proxy/campaigns/:slug/apply` endpoints. Application-confirmation email trigger + default template seed. Rate-limit middleware on the apply endpoint. Documentation for the Shopify Page setup.

Verification gate: create a Shopify Page on the dev store, paste the embed div, fill out the form, see the application appear in the admin queue and the confirmation email arrive.

### Step 3 — Approval workflow + invitation generation

Applications queue UI in the campaign detail. Approve/reject actions; customer upsert on approval. "Generate invitations for approved members" action that creates 3 sample_invitations per member tagged with `campaign_id`.

Verification gate: submit a dev application, approve it in admin, see the customer row created, run generate-invitations and verify 3 sample_invitations rows appear with correct product IDs.

### Step 4 — Capacity warning + auto-close

Threshold field on campaign setup; capacity-warning email fires on crossing; auto-close on target hit; "Reset capacity warning" button; "Reopen campaign" button.

Verification gate: set a small target_size (5) and threshold (3), submit applications until threshold crossed, see the warning email; submit more until target hit, see auto-close; reject one, reopen, submit another, verify behaviors.

### Step 5 — Batch email sends

Three remaining triggers + default template seeds. Per-recipient context builder (filling `reviewLinksHtml`, `campaignName`, etc.). Batch-send admin buttons per trigger. Per-recipient render + send loop reusing the dispatcher's send machinery.

Verification gate: with 3+ approved members holding generated invitations, click "Send shipped notifications," verify each member receives a personalized email with their 3 review-link buttons.

### Step 6 — Discount codes

Per-campaign discount-terms config in setup form. `discountCodeBasicCreate` batch generation when admin clicks "Generate discount codes." Storage on member rows. Required scope (`write_discounts`) added to OAuth scope list.

Verification gate: on the dev store, generate codes for approved members, verify codes appear in Shopify Discounts list with correct terms and customer scoping. Manually test a redemption.

### Step 7 — Redemption tracking + code cleanup

`orders/paid` webhook handler extension. Redemption stats on the campaign detail page. Cleanup action with two-button choice.

Verification gate: place a test order on the dev store using a generated code, verify the member row updates with `code_status='redeemed'` + order details. Run the cleanup actions and verify expected codes are removed from Shopify while others persist.

### Step 8 — Retention pipe

Status `completed` transition triggers Stage 1 quarantine on all member shipping addresses for that campaign. New admin "Retention queue" view listing quarantined items across campaigns. Stage 2 confirmation action.

Verification gate: complete a test campaign, verify shipping addresses flip to `pending_deletion`, appear in the retention queue, confirm the purge, verify `shipping_address_json` is NULL and `retention_status='purged'`.

### Step 9 — Feedback forms

Feedback-form data model already exists from migration 1. Form builder admin UI. Public form widget (same pattern). Submission endpoint. Reporting view with per-question aggregates. `feedbackUrlsHtml` variable wired into the shipped + reminder templates.

Verification gate: create a feedback form on a test campaign, configure questions of each type, embed in a Shopify Page, submit responses, view the reporting page and verify aggregates.

### Step 10 — Documentation + handoff prep

Update [development-plan.md](development-plan.md) §15 to mark Campaigns as complete and reference this document. Document the Shopify-Page setup flow for the merchant (similar to the brand-relay setup block in §14). Log the future items (per-member auto-fire, variant choice, custom form fields) in the post-MVP roadmap.

---

## 8. Open Questions

Settled enough to build, but worth surfacing where assumptions were made:

- **Discount terms specifics** — exact percentage, expiry window, optional max-amount approach. Owner is still finalizing. Schema supports `discount_percent` + `discount_expires_days`; setup UI exposes both.
- **Contact-record retention clock for campaign members** — affiliate app has a 10-year clock for the basic contact record. Campaign members might warrant the same; might warrant something different. Defer specifics until we've shipped one campaign and have a feel for the operational pattern.
- **Per-campaign vs. global default capacity-warning threshold** — currently per-campaign, defaulting to 80%. If multiple campaigns share the same operational threshold, a settings-page default would save typing. Defer until needed.

---

## 9. Cross-references

- App-wide reference: [development-plan.md](development-plan.md). Update §15 (post-MVP roadmap) to point here when shipping.
- Retention pattern source: `D:\AI\Affiliate\docs\data-retention.md` — two-stage human-confirmed deletion pipe.
- Email pipeline: [src/email/triggers.ts](src/email/triggers.ts), [src/email/variables.ts](src/email/variables.ts), [src/scheduler/dispatcher.ts](src/scheduler/dispatcher.ts).
- Sample invitations: [src/db/queries.ts](src/db/queries.ts) (search `sample_invitations` / `SampleInvitationRow`).
- App Proxy: existing routes under `/proxy/*` in [src/routes/api.ts](src/routes/api.ts) (or wherever proxy routes live).
- Widget pattern: [src/widget/](src/widget/) + [src/routes/widget.ts](src/routes/widget.ts).
