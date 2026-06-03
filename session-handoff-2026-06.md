# Session handoff — pre-launch testing round, 2026-05-30 to 2026-06-02

The user was working through `pre-launch-test-checklist.md` doing click-through testing on the dev store and feeding back issues as they hit them. This doc captures the actionable context — what was found, what was built, what was learned, and what's still pending — so the next agent doesn't need to re-derive any of it.

The user is making good progress through the checklist. As of this handoff they're at Part 14.5/14.6 (campaign application form). Most blockers identified during testing have been fixed and shipped.

---

## Test infrastructure (built this session — don't reinvent)

### Internal test suite (`tests/`)

`tests/run-all.ts` runs 10 numbered test files, ~120 assertions total, against fresh temp DBs (not the local stale one). Touches build/typecheck, schema migrations, FK integrity, tokens, HMAC + App Proxy signature, profanity matching, panic state machine, dispatcher eligibility + suppression audit, validation predicates, campaign state transitions, and a boot smoke test that actually starts the app and hits `/health`.

Run with `npx tsx tests/run-all.ts`. Each file is also runnable standalone — `npx tsx tests/07-dispatcher-eligibility.ts` etc. Run after any non-trivial change to `src/` to catch regressions before deploy.

The harness is in `tests/_harness.ts` — tiny assertion library with descriptive failure messages and a context object so failed tests print what reality actually looked like. Use `assert(condition, message, context)` and `assertEqual(actual, expected, message, extraContext)`.

**Important quirk:** `tests/10-boot-smoke.ts` uses `node dist/index.js`, not `tsx src/index.ts`. On Windows, `spawn({shell:true})` of `npx tsx ...` makes the cmd shell wrapper exit and look like a crash even though the underlying process keeps running. The dist binary doesn't need shell:true.

### Pre-launch click-through checklist (`pre-launch-test-checklist.md`)

User-journey ordered, very granular, with SQL recipes for time-warping cadence-bound flows and a section explaining how to access the DB inside the container (`docker exec -it reviews-app sqlite3 /app/data/reviews.db`). The user is working through it linearly.

**Caveat:** the checklist has `curl ...` examples that assume bash. On Windows PowerShell `curl` is aliased to `Invoke-WebRequest` (different flags entirely) — use `curl.exe` to bypass the alias, OR run from inside the container. This is documented in the checklist now but may surface again.

---

## Critical technical findings (the gotchas)

These bit us during testing. Future agents will save time by knowing about them upfront.

### 1. Shopify embedded admin iframe + textarea cursor bug

**Symptom:** in any pre-filled multi-line textarea inside the Shopify-admin iframe, the FIRST keystroke after page load goes to position (0,0) regardless of where the visible cursor is. After that one wrong-position insert, the textarea behaves normally.

**Root cause is unknown** (we suspect App Bridge focus management or iframe focus race), but the fix is in production:

- Mark the textarea with `class="campaign-terms-input"` (or any class — just be consistent in the JS selector)
- Apply `renderTermsTextareaCursorFixScript()` from `src/routes/admin-campaigns.ts`
- The script catches the first `input` event, compares the actual textarea value against (a) what would result from a correct insert at the saved cursor position and (b) what would result from a buggy insert at position 0, and if the bug pattern matches, splices the character to the right position in-place

The fix also disables `autocomplete` / `autocorrect` / `autocapitalize` / `spellcheck` on the textarea — these were observed to interfere with selection state.

**A simpler `mouseup` setSelectionRange fix did NOT work** — by the time `input` fires, the wrong state has already locked in. The fix has to detect AFTER input and splice. We tried multiple lighter approaches first.

**Apply this fix to any new pre-filled multi-line textarea in the admin** — it's a reproducible iframe bug, not specific to campaign terms.

### 2. Nested `<form>` elements silently break the outer form

The campaign create form had a "Refresh from Shopify" button inside the product picker. The picker rendered its own `<form>` for the refresh action, nested inside the main `<form action="/admin/campaigns">`. Per HTML spec, browsers silently close the outer form when they encounter an inner one — the Create button became orphaned and clicks did literally nothing (no console message, no network request).

**Fix pattern:** make the inner action a SIBLING form before the main form, give it an id, and associate the button via the HTML5 `form="formid"` attribute:

```html
<form id="refresh-form" method="POST" action="..." style="display:none;">
  <input type="hidden" name="..." value="..." />
</form>
<form id="main-form" method="POST" action="...">
  ...
  <button type="submit" form="refresh-form">Refresh</button>
  ...
</form>
```

`renderRefreshProductsForm()` in `admin-campaigns.ts` is the canonical example. Look for similar nesting before assuming "the button doesn't work" is something else.

### 3. Hono route order matters for literal-vs-parameterized

`admin.post('/branding/email-template/:key', ...)` registered before `admin.post('/branding/email-template/new', ...)` meant `POST /new` matched the `:key` route with `key="new"` and 404'd with "No template with key `new`". Hono matches in registration order.

**Always register literal routes before their parameterized siblings.** Same issue could surface anywhere `:param` and a literal share a prefix.

### 4. CSS `filter: blur()` desyncs cursor positioning in input elements

The profanity wordlist textarea uses `filter: blur(6px)` for "don't accidentally see slurs." Clicking landed the visible cursor at the click position but the underlying selection stayed at (0,0). Fix: auto-reveal (drop the blur) on focus or click. Don't use `filter` on textareas if you want functional cursor positioning.

### 5. Backticks inside comments inside backtick template literals

```ts
return `
  <script>
    // CSS \`filter: blur\` desyncs ...   ← the literal backticks close the outer template literal
  </script>
`;
```

This was a real build break. Either escape with `\` ` or just paraphrase the comment to avoid backticks. The TypeScript compiler error says `',' expected.` which doesn't point at the real issue.

### 6. SMTP_FROM display name silently overrode `branding.senderName`

`SMTP_FROM=Teraclay Reviews <reviews@teraclay.com>` in `.env`. The "Sender display name" field in Branding → Email was saved, read, and ignored — `sendMail` always passed the raw SMTP_FROM. The fix in `src/email/smtp-client.ts` now extracts just the email address from SMTP_FROM and uses `{ name: senderName, address }` when a senderName is provided. Customer-facing send paths (dispatcher, send-template, dispatch-campaign) pass `branding.senderName` and `branding.replyTo` through. Operator-facing notifications (panic, new-review, capacity) intentionally don't.

### 7. The "via gmail.com" annotation is an SPF problem, not a code problem

User wanted to remove it. Requires adding `include:_spf.google.com` to teraclay.com's SPF TXT record at Squarespace. They have an existing `v=spf1 include:mailgun.org ~all` that's LOCKED — Squarespace email forwarding owns it. Can't add a second SPF record (RFC 7208 violation; breaks both records). User chose to live with the "via gmail.com" annotation for now. If they ever upgrade to Google Workspace, DKIM signing makes the annotation go away cleanly.

### 8. Webhooks aren't auto-subscribed on OAuth install

A new merchant who installs via OAuth gets the access token persisted in `shops.access_token` but webhooks aren't subscribed until someone runs the `install-webhooks` script. The user hit this during testing — orders were paid/fulfilled but no log lines appeared because Shopify wasn't calling our endpoints.

**Workaround:** run install-webhooks with the per-shop token from the DB:

```bash
docker exec -e SHOPIFY_SHOP_DOMAIN=<store>.myshopify.com \
            -e SHOPIFY_ADMIN_TOKEN="$(docker exec reviews-app sqlite3 /app/data/reviews.db "SELECT access_token FROM shops WHERE shop_domain='<store>.myshopify.com'")" \
            -e PUBLIC_URL=https://<your-public-url> \
            reviews-app node dist/scripts/install-webhooks.js
```

**Fast-follow** logged: have the OAuth callback in `src/routes/auth.ts` auto-call `installWebhooks(shopDomain, token)` right after `setShopAccessToken(...)`. Critical for multi-tenant launch.

### 9. `productOptOut` and `maxRequestsHit` audit buckets always show 0 in practice

Both `setProductOptOut` and `recordRequestSentBatch` (when hitting the cap) null `due_at` as part of the suppression. The audit query requires `due_at IS NOT NULL`, so the row leaves the audit candidate set. The suppression itself works (the customer correctly doesn't get an email); the audit count just doesn't reflect it.

This is a CONSISTENT design — terminal suppression states null `due_at`, which serves as the canonical "this purchase is done." It's not a bug, but operators reading the audit log shouldn't interpret "productOptOut: 0" as "no one has opted out."

If you ever want a true lifetime-suppressions count, that's a separate query against `email_events` or a new table — don't add it to the audit.

### 10. Backfill ignores `dispatch_immediately_on_fulfillment`

The immediate-fire toggle only short-circuits the `orders/fulfilled` webhook handler. Manual backfill always uses `request_delay_days` (default 7). User tripped on this when they expected backfilled new orders to be eligible immediately. Documented behavior — the toggle name is honest about being about fulfillment, not about backfill.

### 11. Audit reports what cadence rules WOULD suppress, even when bypassed

The two cadence-bypass dev toggles (`bypass_cadence_min_days`, `bypass_cadence_max_requests`) loosen the eligibility query but DON'T touch the audit. So with bypass ON you can see "cadenceTooSoon: 1, sent: 1" in the same log line — which looks like double-counting but is intentional. The `bypassed` field on `DispatchResult` (and in the log) tells the operator when bypasses are active. Don't "fix" the audit to subtract bypassed counts — it's deliberate observability.

---

## Architecture decisions made this session

### Email button styling = Widget config (single source of truth)

`src/scheduler/dispatcher.ts`, `src/email/dispatch-campaign.ts`, and the admin email-preview helper all use `resolveWidgetConfig()` (not `resolveBrandColors()`) for the email CTA button:
- `widget.ctaBackground` / `ctaForeground` / `borderRadius` / `ctaLabel`

This means **changing the storefront widget's CTA in Branding → Widget changes the email button too.** One knob, two surfaces.

The per-template `cta_label` column still exists in the DB and is still submitted as a hidden field on save (so existing values aren't blanked), but it's IGNORED at render time. If a future change wants per-template label overrides back, the data is preserved.

### Email logo header is NOT auto-prepended anywhere

User explicitly: "We shouldn't force anything on them (except the unsubscribe button — that's kinda important)." The shell template no longer carries `{{ logoHeader }}` — `_shell.html` wraps body + footer only. Merchants insert the logo manually via the editor toolbar's Logo button or `{{ logoUrl }}` variable.

Default seeded templates do NOT include the logo. Existing templates will lose their logo unless the merchant re-adds it via the toolbar — this is the user's explicit design choice.

### Email kill switch lives in Settings → Setup, not Notifications

The kill switch (`emails_disabled` setting) blocks every `sendMail` call via a check at the top of `src/email/smtp-client.ts`. When ON, sendMail logs `sendMail blocked: emails_disabled kill switch is ON` with the `to` and `subject` for visibility, then returns immediately with `messageId: 'BLOCKED_BY_KILL_SWITCH'`. Use case: deploy to live store, accept reviews via the storefront widget, send no emails until templates are ready.

Lives in Settings → **Setup** (configuration toggle), not Notifications (which is for receiving notifications). Red warning treatment.

### Cadence bypass toggles for testing

Three dev toggles in Settings → Cadence (yellow warning treatment, all default OFF):
1. `dispatch_immediately_on_fulfillment` — bypasses `request_delay_days` in the webhook handler
2. `bypass_cadence_min_days` — bypasses `cadenceTooSoon` in the eligibility query
3. `bypass_cadence_max_requests` — bypasses `maxRequestsHit` in the eligibility query

`alreadyReviewed`, `globalOptOut`, and `productOptOut` are deliberately NEVER bypassable — those are correctness/respect rules, not policy.

`getCadenceBypassFlags()` in `queries.ts` returns the current state; the dispatcher reads it and surfaces in `DispatchResult.bypassed` + log line.

### Manual-ops button result dumps are temporary

The "Run backfill" and "Run dispatcher" buttons currently dump raw JSON. **Fast-follow** logged to replace with friendly success/error banners + expandable details. Don't spend time polishing the raw JSON — it's slated for replacement.

---

## Feature inventory (what shipped this session)

Mostly polish, but a few real features:

**Migrations added:**
- `021_campaign_discount_usage_limit.sql` — adds `discount_usage_limit INTEGER NOT NULL DEFAULT 1` to campaigns. Per-recipient redemption count. Each member still gets a unique code; this controls how many times THAT code can be used.

**Settings keys added:**
- `emails_disabled` — kill switch
- `bypass_cadence_min_days` — dev toggle
- `bypass_cadence_max_requests` — dev toggle

**`email_branding_json` field added:**
- `cardBackground` — email main card background color (default `#ffffff`)

**Schema constraint relaxed:**
- `discount-codes.ts`: when `usageLimit > 1`, `appliesOncePerCustomer` flips to `false` so the same customer can redeem the same code multiple times. When `usageLimit === 1`, defense-in-depth keeps it `true`.

**Admin UI restructured:**
- Branding → Email is now three collapsible `<details>` sections (Templates open, Shared settings + Available variables collapsed) with tighter margins so the page doesn't sprawl
- Sender Display Name override actually works now (was silently ignored — see finding #6)
- Reply-to address ditto
- "Preview in new tab" works without saving (POST to `/admin/branding/email-template/preview`)
- Editor toolbar gained text-color + highlight-color buttons + left/center/right alignment buttons (consistent SVG icons, not Unicode arrows)
- All toolbar controls share `height: 28px; box-sizing: border-box` for baseline alignment
- Auto-dismiss flash banners after 4s (in `adminShell`)
- Tab-persistent redirects on Settings POSTs (Notifications, Appearance, Setup, Branding/brand-colors all land on their own tab)

**Campaign create form polish (Part 14.1):**
- Fixed: nested form was causing Create button to silently fail (see finding #2)
- URL slug: live validation on input + blur, helper explains the embed-handle mental model
- Capacity-warning preview is muted+italic with X-of-Y bold larger
- Participant limit + capacity threshold side-by-side responsively
- Launch discount params side-by-side; defaults blank with "Please enter..." placeholders
- Product picker capped at 2 columns
- "Uses per code" field added (mapped to migration 021)
- Terms textareas got the cursor fix

**Campaign detail page polish (Part 14.2):**
- Terms textareas got the cursor fix
- "Automated emails" section above batch-sends with the `campaign_application_confirmation` row (preview/edit only, no Send)
- "Preview / edit template" links restyled as buttons
- Campaign template editor got Preview-in-new-tab, dirty indicator, beforeunload guard, Insert-variable dropdown
- Products listed by NAME (looked up from `products_cache`) with tiny muted ID alongside
- Terms version history removed (was growing forever, not clickable)
- Discount terms summary includes "X use(s) per code"

---

## Pending pre-launch items (NOT addressed)

These are real blockers the user knows about, but they're on the user's plate, not in code:

1. **Yotpo cleanup on the live store.** Theme code edits + metafield removal. Risky; user is doing this manually.
2. **Theme integration on the live (Trademark 1.7.3) theme.** Different file paths than the dev-store theme.
3. **Install Reviews app on the live store** via OAuth.
4. **Stand up `/opt/stacks/shopify-reviews/` prod stack on Mercury** with fresh secrets, live store domain, host port 8070.
5. **DNS A record for `reviews.<brand>.com`** at Squarespace.
6. **App Proxy configuration on the live store** for storefront-customer review submission.
7. **Set the go-live guard** (Settings → Cadence → "Set cutoff to now") on the prod stack immediately after first backfill.
8. **Manual outreach to ~half-dozen legacy customers** by hand (don't auto-email them).

See `development-plan.md` §14 "What's left to ship" and §17 "Pre-deployment Checklist" — both are kept up to date.

---

## Fast-follows logged in `development-plan.md` §15

Don't build these now, but they're tracked:

- **Webhook auto-subscribe on OAuth callback** — critical for multi-tenant launch
- **Manual-ops button feedback** — friendly success/error banners replacing raw JSON dumps
- **Admin tab reorganization** — overall nav audit once surface stabilizes
- **Per-surface panic exclusions** — campaign applications shouldn't necessarily pause during a review-targeted panic
- **Campaign discount: single shared code option** — currently per-member unique codes only
- **Campaign template editor: full visual-toolbar parity with Branding → Email** — currently has insert-variable, dirty indicator, preview-no-save, beforeunload; missing the full visual contenteditable + toolbar (bold/italic/headings/alignment/colors/insert-logo/raw-HTML toggle). Extract from admin.ts into a shared module.

---

## User communication patterns to know

User's preferences (consistent across this session — also in `~/.claude/CLAUDE.md` and their memory):

- **Prose questions only.** Never use `AskUserQuestion`. Embed questions in your response.
- **Plain language before jargon.** When introducing a Shopify / Cloudflare / Docker term, give a one-line everyday-language description first.
- **Lead with the decision** when you have a clear best answer. Don't enumerate alternatives you've already rejected unless the tradeoff is genuinely open.
- **Concise commit messages.** 1-2 sentences. No bullet lists in the commit message body. No Co-Authored-By footer unless explicitly requested. (Existing history has long verbose commits; the user has explicitly stated they prefer shorter — follow the preference, not the existing pattern.)
- **For shopify-reviews specifically: don't follow the plan mechanically.** Write things fully the first time; update the plan when implementation reveals a better path.
- **"Boring code wins" is a heuristic, not a license to under-deliver on security or features.** Surface trade-offs explicitly when the simpler option costs real ground.

The user is a co-owner of a small Shopify brand. Basic technical background (Python, SQL, HTML). Home-lab operator (Mercury = persistent Intel N100, Pebbles = on-demand). Strong product instincts.

---

## Key files to know when picking up

- `src/routes/admin.ts` — Big file (~3500 lines). Admin pages. Branding → Email editor is here.
- `src/routes/admin-campaigns.ts` — Campaign-specific admin. ~1700 lines. Houses the textarea cursor fix as a reusable helper.
- `src/scheduler/dispatcher.ts` — Email dispatcher. Uses `resolveWidgetConfig()` for button styling now.
- `src/email/smtp-client.ts` — The kill switch lives here. Also where senderName extraction happens.
- `src/email/email-config.ts` — `resolveEmailBranding()` + the cardBackground field.
- `src/db/campaigns.ts` — Campaign queries. `CampaignRow` now includes `discount_usage_limit`.
- `src/db/queries.ts` — Big file (~1800 lines). Core review/customer queries. Eligibility + audit are here. `getCadenceBypassFlags()` here.
- `src/email/triggers.ts` — Trigger registry. `campaign_application_confirmation` is wired and now has UI exposure.
- `src/email/variables.ts` — Variable registry consumed by both admin.ts editor and admin-campaigns.ts editor.
- `tests/_harness.ts` — Test harness. Tiny but useful.
- `pre-launch-test-checklist.md` — The user is working through this linearly.
- `development-plan.md` — Canonical project reference. §14 "current state", §15 "post-MVP roadmap" (where fast-follows accumulate), §17 "pre-deployment checklist."

---

## Quick smell-test commands

Run these whenever you're not sure if something works:

```bash
# Full test suite (must always pass before commit/push)
npx tsx tests/run-all.ts

# Just the dispatcher eligibility — the highest-value tests
npx tsx tests/07-dispatcher-eligibility.ts

# Build (catches type errors the tests miss because tsx is permissive)
npm run build

# Tail the dev stack's logs on Mercury
ssh mercury 'docker logs -f reviews-app'

# Drop into the dev DB
ssh mercury 'docker exec -it reviews-app sqlite3 /app/data/reviews.db'
```

The test suite has 10 files, ~120 assertions. All passing as of this handoff. If anything fails after a change, the failure message names the assertion and prints actual-vs-expected — don't ignore.

---

## What's actively being tested right now

The user just finished feedback round on Part 14.2 (campaign detail page) and was about to move to 14.5 / 14.6 (the campaign application form — applicant-facing UI rendered by the widget, plus the backend submission flow at `POST /proxy/campaigns/:slug/apply`).

Expect feedback in the next round about:
- The applicant form rendering (`renderCampaignForm` in `src/widget/widget.ts`)
- The terms acceptance flow
- The capacity-warning email trigger (when an application crosses the threshold)
- The auto-close behavior when capacity is reached
- Application data validation

If the next agent picks this up mid-conversation, the user expects continuity: small commits per round of feedback, push after each commit so they can pull and rebuild on Mercury, test results communicated tersely.

---

## Addendum — 2026-06-03 round

The 2026-06-03 session worked through the rest of Part 14 (campaigns full lifecycle, applicants tab, batch sends, discount redemption, retention) and Part 18 (operational checks). Parts 13, 15, 16, and 17 of the checklist were intentionally deferred from this round per merchant decision (live-launch urgency); they remain tracked in the checklist with deferral notes. **Part 17 in particular is expected to be exercised AS PART of the live cutover itself** (per dev-plan §17 Part B step 6 — "Set the go-live cadence guard immediately after the migration deploys on prod"), not re-tested standalone on dev.

Test suite is still green: `npx tsx tests/run-all.ts` → 10 files, 121 assertions, all passing (a new audit-priority regression test was added — see item 4 below).

The items below are the go-live-relevant delta from this round. UI polish, placeholder/color tweaks, applicants-tab split, ZIP API auto-populate, etc. are not duplicated here — they're in the test checklist and the code.

### 1. New campaign member status: `reminded` (+ hidden status-progression bug fix)

`CAMPAIGN_MEMBER_STATUSES` gained a `reminded` value between `shipped` and `reviewed`. New member lifecycle:

```
applied → approved → shipped → reminded → reviewed → done    (rejected as a side-arm)
```

- `campaign_review_reminder` send now advances member status to `reminded` (was status-neutral). Re-firing the reminder batch naturally skips members who already got it.
- `campaign_launch_thanks` eligibility broadened to `shipped` | `reminded` | `reviewed` (was `shipped` | `reviewed`).
- The `campaign_members.status` column is plain `TEXT` with no `CHECK` constraint, so the new value needs **no migration** — only the in-memory enum + label + pill style changed.

**Hidden bug fixed in the same commit.** The checklist (14.18) had expected sample-invitation review submission to advance `campaign_members.status` from `shipped`/`reminded` → `reviewed`. It never did — `consumeSampleInvitation` only updated `sample_invitations`. New helper `markCampaignMemberReviewed(campaignId, email)` in `src/db/campaigns.ts` is now called from both consume sites in `src/routes/widget.ts`. Forward-only: pre-existing campaign members on prod (none yet, since prod isn't live) would not be retroactively progressed, but every new sample-invitation review will progress correctly going forward.

### 2. `orders/paid`: discount-code redemption check moved ahead of the no-email gate

Was: handler bailed out on `no_email` BEFORE running the campaign-code redemption block. Effect: admin-created test orders (Bogus Gateway, manual order without an attached customer) silently skipped redemption tracking. Real customer orders worked.

Now: the discount-code redemption block runs first; the no-email gate only short-circuits the `upsertCustomer` / `upsertPurchase` work below it. On prod this is invisible for normal customer orders, but any admin-created test order on the live store that applies a campaign code will now correctly flip the member's `code_status` to `'redeemed'`.

### 3. Hono route order — confirmed second hit of finding #3

`/admin/campaigns/retention-queue` 404'd because `/retention-queue` was registered AFTER `/:id`. Both are single-segment paths; Hono matched the literal request to `/:id` with `id='retention-queue'`, failed `Number.isInteger`, and returned 404. Fix moved both retention-queue handlers ahead of `/:id` with an explicit code comment.

**Rule for `/admin/campaigns` (and any other base with `/:id`):** literal single-segment routes MUST be registered before `/:id`. Current literals to keep ahead: `/new`, `/retention-queue`. Anything new added at this level (e.g., a future `/bulk-import`) needs the same treatment.

### 4. Suppression audit priority order changed — amends finding #11

- **Old order:** globalOptOut → productOptOut → maxRequestsHit → cadenceTooSoon → alreadyReviewed
- **New order:** globalOptOut → productOptOut → **alreadyReviewed** → maxRequestsHit → cadenceTooSoon

All three non-bypassable respect rules (globalOptOut, productOptOut, alreadyReviewed) now outrank the two bypassable policy rules (maxRequestsHit, cadenceTooSoon). The **eligibility query is unchanged**; only the per-row bucket attribution in `auditSuppressions()` moved.

Reason for the change: during 18.6 testing with `bypass_cadence_min_days=1`, the audit reported `cadenceTooSoon: 1` and `considered: 0`, which looked like the bypass was broken. It wasn't — the row was being excluded by `NOT EXISTS (reviews)`, the non-bypassable already-reviewed clause. The old priority order attributed that row to cadenceTooSoon, hiding the real blocker. Under the new order, when the dev cadence-bypass toggles are on, any non-zero `cadenceTooSoon` value is now **genuinely** "only blocked by cadence" — a respect-rule blocker would have caught it first.

Finding #11 in the main doc still describes the design intent correctly. The "with bypass ON you can see 'cadenceTooSoon: 1, sent: 1'" example is now narrower in scope (a row attributed to cadenceTooSoon is genuinely cadence-blocked, not also reviewed/opted-out) — observability is more useful, not less. A regression test for the new ordering lives at `tests/07-dispatcher-eligibility.ts` under "Audit priority: alreadyReviewed wins over cadenceTooSoon when both apply".

### 5. `.env` changes require `docker compose up -d --force-recreate`, not `docker restart` ⚠

The container reads env vars (SMTP_PASS, EMAIL_TOKEN_SECRET, SHOPIFY_WEBHOOK_SECRET, SHOPIFY_CLIENT_*, PUBLIC_URL, etc.) **at boot only**, and `config.ts` exports a frozen object. nodemailer further builds a singleton transport from those values on the first send and reuses it for the lifetime of the process. `docker restart reviews-app` keeps the existing container's already-injected env vars; Docker only re-reads `env_file:` when **creating** a container.

To pick up an `.env` change:

```bash
cd /opt/stacks/shopify-reviews-{dev,prod}
docker compose up -d --force-recreate
```

(or `docker compose down && docker compose up -d`). This matters specifically at cutover when generating fresh secrets per dev-plan §17 Part B step 8 — issuing a `docker restart` after editing prod `.env` will not pick up the new values.

### 6. Backup snapshot location

The backup sidecar writes snapshots to `/opt/stacks/shopify-reviews-{dev,prod}/data/snapshots/`, not directly to `data/`. The dev-plan and earlier checklist drafts pointed at `data/`. Updated in the checklist (18.2); flagging here so any go-live verification script the coordinator writes that asserts on backup presence checks the correct path.

### Pending follow-up flagged this round (not blocking launch)

- **Branding → Email contenteditable cursor fix.** The shared textarea cursor fix (`src/lib/admin-textarea-fix.ts`) was applied to the campaign template body textarea and the Branding → Email raw-HTML toggle textarea this round. The Branding → Email main body editor is a `contenteditable` div, not a textarea — a different fix shape (Range-based) would be required if the same App-Bridge first-keystroke bug shows up there in real use. Not built yet; flagged as a fast-follow to land alongside the existing "Campaign template editor: full visual-toolbar parity with Branding → Email" item in dev-plan §15.
