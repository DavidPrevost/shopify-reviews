# v1 Launch Handoff — Seven-Phase Plan for a New Chat

The chat that produced this is out of context. Everything a fresh Claude Code chat needs to take over the v1 launch (clean install on the live brand store, transition off the prototype) is below. Read it end-to-end before doing anything.

---

## What this is

A guided plan for moving the app from "tested on dev, ready to ship" to "running on the live store" through seven sequenced phases. Phases are sequential — do not skip. Most phases have a user-facing component; you produce the step-by-step checklists as you go (see "Collaboration model" below). Confirm with the user before each phase transition.

Pre-launch testing is complete; **further testing resumes on `develop` after v1 is live**, not before. The remaining work is cleanup, documentation, and deployment — no new features.

---

## Read these first (precedence rules apply)

In this order:

1. **`session-handoff-2026-06.md`** — **takes precedence over every other document**, including this one and the dev plan. It was maintained by two prior Claude Code instances that worked through testing-surfaced issues; it reflects the most current truth about feature state, behaviour, and decisions. When anything conflicts with it, update the *other* document to match — not the code.
2. **`pre-launch-test-checklist.md`** — testing context. Incomplete but explicitly accepted as sufficient to proceed.
3. **`development-plan.md`** — historical and architectural context. **Outdated in several places** — especially around the admin auth (it's now embedded via App Bridge / session-token exchange, not the password+cookie model the plan describes) and brand acquisition. Treat as informational, not authoritative. This doc gets archived in Phase 3.
4. **`external-accounts-setup.md`** — the original Shopify Dev Dashboard / GCP relay setup. Also drifted — particularly the "Embed app: UNCHECK" instruction, which is now wrong (embedded admin needs CHECKED). This doc gets superseded by `docs/INSTALL.md` in Phase 3.
5. **Memory at `C:\Users\kymer\.claude\projects\D--AI-shopify-reviews\memory\`** — communication style (plain-prose questions, no `AskUserQuestion`, lead with decisions, plain language before jargon), commit conventions (1–2 sentences, no `Co-Authored-By`), engineering values.

---

## Locked decisions (don't re-litigate)

- **Branching:** `main` = production, deployed at `/opt/stacks/shopify-reviews/`. `develop` = development, deployed at `/opt/stacks/shopify-reviews-dev/`. Hotfixes on `main` merge back to `develop`.
- **All cleanup and documentation work happens on `develop`.** `main` stays as the known-stable pre-launch snapshot until the Phase 7 cutover merge.
- **One new clean Dev Dashboard app, for prod only.** The existing dev app stays as-is on the dev store. Don't rebuild it.
- **Embedded admin is the current model.** The new prod app version's "Embed app in Shopify admin" is **CHECKED**. The historical "no embedded admin" notes in `development-plan.md` and `external-accounts-setup.md` are stale.
- **Doc suite shape:** five maintained docs going forward — `STATE.md`, `INSTALL.md`, `OPERATIONS.md`, `ROADMAP.md`, `CHANGELOG.md`. Each carries a header listing all five with one-line scope (drafted in Phase 1). Old plan files get archived to `docs/legacy/`, not deleted.
- **Campaigns ships in v1.** Mid-build, intentionally not fully refined, continues to grow post-launch.
- **HEAD at handoff time:** the chat producing this document is no longer tracking HEAD precisely. Trust `session-handoff-2026-06.md` + a fresh `git log` for current state.

---

## Conventions (from memory + prior sessions)

- Plain prose questions only. No `AskUserQuestion`.
- Lead with the decision; don't enumerate rejected alternatives unless asked.
- Commit messages: 1–2 sentences, factual; no `Co-Authored-By`.
- `npm run typecheck` / `npm run build` before any commit.
- Push to Gitea (`http://100.117.6.18:3000/kymermosst/shopify-reviews.git`). `git push origin main` and `git push origin develop` are already allowed without prompt via `.claude/settings.local.json`.
- Don't commit unless the user explicitly says to. Once they do, push without re-asking.

---

## Environment cheat sheet

- Code locally at `D:\AI\shopify-reviews\`.
- Mercury (`100.117.6.18`), Ubuntu 24.04, Docker.
- **Dev stack:** `/opt/stacks/shopify-reviews-dev/`, host port `8071`, public `https://reviews-dev.teraclay.com`. Tracks `main` today; flips to `develop` in Phase 1.
- **Prod stack (to be created in Phase 6):** `/opt/stacks/shopify-reviews/`, host port `8070`, public `https://reviews.teraclay.com`. DNS + Caddy already configured.
- App binds to Mercury's **Tailscale IP**, not localhost. Curl from Mercury uses `100.117.6.18:80xx`, not `localhost:80xx`.
- Live brand store: `teraclay.myshopify.com`. Dev store: `teraclay-dev.myshopify.com`.

---

## Collaboration model

Some work is yours (code, file writes, git operations the user has authorized). Some is the user's (Dev Dashboard clicks, Mercury SSH, theme edits, browser testing).

**For every user-side step, you produce a step-by-step checklist with exact commands, click paths, or field values.** The user executes and pastes back results. You interpret, adapt, and move to the next step.

Phase rhythm:
1. State the goal and the Claude/user split.
2. Do your side.
3. Produce the user-side checklist.
4. User executes; pastes results.
5. Verify, adapt, continue.

For routine steps, "run these and tell me if anything broke" is fine. For consequential ones (Dev Dashboard config, live-store actions), use confirmation points between steps.

---

## Phase 2 enhancement — discovery before action

In Phase 2 (Codebase cleanup), **do not delete or annotate anything without user review.** Process:

1. **Discovery pass.** Scan the codebase. Produce two markdown lists:
   - **List A — Proposed deletions** (confirmed orphans). Each item: file path, one-sentence description, why it's flagged (e.g., "no in-code references; documented as dormant in dev plan §14").
   - **List B — Proposed annotations** (code supporting unbuilt features that needs a clarifying comment). Each item: file path, what the code does, why a comment helps, suggested comment text.
2. **Present both lists** to the user as a single readable document.
3. **Wait.** The user reviews — items might be "orphans" only because they're undocumented, not because they're truly unused.
4. **Only after approval** do you execute the deletions and annotations.

This protects against deleting something used in a way the discovery pass missed.

---

## The seven phases

### Phase 1 — Branching foundation

**Goal:** create `develop` branch, flip the dev stack to track it, agree on the cross-reference header block that goes at the top of every doc in Phase 3.

**Claude:**
- Create `develop` from current `main`; push.
- Draft a short cross-reference header block listing all five docs (`STATE.md`, `INSTALL.md`, `OPERATIONS.md`, `ROADMAP.md`, `CHANGELOG.md`) with one-line scope each. Present for approval.

**User:**
- On Mercury, point the dev stack at `develop`. You give the exact commands.

**Done when:** both branches on Gitea, dev stack confirmed pulling `develop`, header block approved.

---

### Phase 2 — Codebase cleanup (discovery → review → execute)

**Goal:** find genuinely orphan code and remove it; clarify code that supports unbuilt features with comments. All on `develop`.

**Known orphan to include in List A:** the Storefront API path — `src/shopify/storefront-client.ts`, `fetchShopifyBrand` in `src/shopify/brand-info.ts`, the `/admin/settings/sync-brand` route, and any UI that triggers it. The "Sync brand info" button is believed to have already been removed; verify. Replaced by the Liquid relay (live) plus manual entry (fallback). Document the decision in `STATE.md` and `ROADMAP.md` in Phase 3.

**Other things to check:** unused imports surfaced by the cleanup; obsolete test files; dead code paths from earlier iterations; outdated planning documents (the original planning file under `~/.claude/plans/` may already be slated for archiving in Phase 3 — flag it).

**Claude (discovery):**
- Scan the codebase and the doc tree. Produce List A and List B per the Phase 2 enhancement rule. Present.

**User:**
- Review the lists; approve, reject, or modify items.

**Claude (execute after approval):**
- Apply deletions and annotations. `typecheck && build`. Commit on `develop`. Push.

**Done when:** lists approved, changes applied, build green, pushed.

---

### Phase 3 — Documentation suite

**Goal:** produce the five-doc suite that becomes the source of truth going forward. Reconcile the embedded-admin drift, brand-acquisition reality, App Proxy lessons. **`session-handoff-2026-06.md` wins on every conflict.**

**Claude (incremental, with review at each doc):**
- **`docs/STATE.md`** — what the app does today, current architecture, feature catalogue (Chunks A complete, Campaigns in v1 mid-build, etc.), deploy topology. Replaces most of dev plan §5 and §14.
- **`docs/INSTALL.md`** — repeatable install for *any* store. Dev Dashboard app creation (mirror the prod-app config from Phase 5), `.env` setup, Docker stack, `install-shopify` (OAuth grant + token capture), `install-webhooks`, App Proxy config, brand-asset prep. **No Yotpo. Nothing one-off.** This is the ongoing-process doc.
- **`docs/OPERATIONS.md`** — deploy workflow (the branch model from Phase 1), `.env.example`, env-var reference, backups + restore procedure, monitoring posture, branching/hotfix flow, troubleshooting (the App Proxy 404 gotcha, brand-relay debugging chain, Tailscale-IP curl pattern, widget-bundle `stale-while-revalidate` caching).
- **`docs/ROADMAP.md`** — next features, known debts, deferred items, "explicitly NOT building" list (carry forward from `project_followups` memory and dev plan §15).
- **`CHANGELOG.md`** — initialise with a pre-launch baseline entry. Phase 7 adds the launch entry.
- Apply the Phase 1 cross-reference header to each doc.
- Move `development-plan.md` and the original planning file to `docs/legacy/` (git mv, so history is preserved). Same with `external-accounts-setup.md` once its content has been migrated.

**User:**
- Review each doc as it lands. Push back on anything that misstates current behaviour.

**Done when:** all five docs written, reviewed, committed on `develop`; legacy docs archived; build still green.

---

### Phase 4 — One-off live-cutover doc

**Goal:** produce `docs/LIVE-CUTOVER.md`. Single-use migration document for moving the live brand store off Yotpo and onto Reviews. Used once, then archived after Phase 7.

**Critical:** Yotpo cleanup goes here, NOT in `INSTALL.md`. After this cutover, the install flow for any new store has nothing to do with Yotpo.

**Claude:**
- Draft `docs/LIVE-CUTOVER.md` covering:
  - Pre-flight (brand assets populated in Shopify Settings → Brand, backup/duplicate of current live theme made).
  - Yotpo cleanup — two instructions: delete the Yotpo widget div from the live theme, uninstall the Yotpo app from the live store.
  - Theme widget `<div>` placement on Trademark 1.7.3. **Adaptive:** likely the same location the Yotpo widget occupied; work through exact placement with the user when they're in the theme editor. Use the now-removed Yotpo location as the breadcrumb.
  - Brand assets confirmation in Settings → Brand (must be set *before* first storefront visit so the relay populates on cutover).
  - Smoke-test checklist (widget renders, brand colors visible in admin Branding → Widget, customer review submission via App Proxy succeeds, sample/campaign endpoints respond).
  - Cutover sequence (the order in which to flip things).
  - Rollback notes (how to revert if something goes wrong mid-cutover — the duplicated theme is the primary safety net).
- Present for review.

**User:**
- Review. Execution happens in Phase 7.

**Done when:** doc reviewed and committed on `develop`.

---

### Phase 5 — Clean Dev Dashboard app for prod

**Goal:** create a brand-new clean Reviews app in dev.shopify.com for the live store — no version cruft, final v1 config.

**User-driven (clicks in Dev Dashboard). You produce the checklist.**

**Claude:**
- Produce a thorough step-by-step checklist: every click, every field, every value. Include:
  - Where to start (`dev.shopify.com` → Apps → Create app → "Start from Dev Dashboard").
  - App name, organisation.
  - App version config: App URL (placeholder), **Embed app: CHECKED**, redirect URL (the `install-shopify` callback), legacy install flow CHECKED, scopes (`read_orders, read_customers, read_products, write_discounts` — the campaign feature needs `write_discounts`), Webhooks API version (current).
  - **App Proxy** section at v1 (subpath prefix `apps`, subpath `reviews`, Proxy URL `https://reviews.teraclay.com/proxy/` — trailing slash required). Not added later; configured from version one.
  - Release the version.
  - Capture Client ID + Client Secret (secret doubles as webhook signing secret).
  - Confirm the live store is in the Teraclay org as a Collaboration (was flagged in the dev plan as a wrinkle — the live store may need to be invited if it isn't already).
- Present the checklist.

**User:**
- Execute in Dev Dashboard. Paste any UI deltas (Shopify rearranges this UI often). Save credentials to temp notes.

**Done when:** user confirms app created and released; credentials recorded.

---

### Phase 6 — Prod stack on Mercury

**Goal:** stand up `/opt/stacks/shopify-reviews/` on Mercury, install the app on the live store, configure webhooks, get health green.

**User-executed; you produce the step-by-step.**

**Claude:**
- Produce a checklist with all commands and `.env` template values:
  - Create the stack folder.
  - Create `.env` (port 8070, prod store domain, prod Client ID + Secret, fresh secrets for `EMAIL_TOKEN_SECRET` and `ADMIN_SESSION_SECRET`, Gmail SMTP config, `STOREFRONT_ORIGIN` for the live store, etc.).
  - Create `docker-compose.yml` (or copy from dev, change `HOST_PORT=8070`, ensure `HOST_BIND_IP=100.117.6.18`, point data volume at a fresh prod data dir).
  - `sudo docker compose up -d --build`.
  - Verify migrations + seeds via `docker compose logs reviews-app`.
  - Run `install-shopify` against the live store; capture the admin token (note: `shpua_` prefix in the new format).
  - Update `.env` with the token; restart.
  - Run `install-webhooks` for the live store.
  - Verify health via Tailscale IP first (`curl http://100.117.6.18:8070/health`), then via the relay (`curl https://reviews.teraclay.com/health`).
- Segment the checklist with confirmation points if it's long.

**Adaptive items:**
- The `install-shopify` helper script may have been written for the older non-embedded admin model. Verify it works with the new embedded setup; if it needs adjustments, do them on `develop`.
- Brand-relay can't fire until the live theme has the `data-brand-*` widget div in place — that's Phase 7. So the prod stack's `shop_brand_json` will be empty until cutover. Manual entry is the bridge if needed.

**Done when:** prod stack running, token captured, webhooks installed, `https://reviews.teraclay.com/health` returns `{"status":"ok"}` from outside.

---

### Phase 7 — Live cutover

**Goal:** execute `docs/LIVE-CUTOVER.md`. Take the live store from Yotpo-vestigial to fully on Reviews.

**Claude:**
- Walk through `LIVE-CUTOVER.md` step-by-step. Interpret what the user pastes back at each step.
- After cutover is verified stable:
  - Update `CHANGELOG.md` with the launch entry (date from the user; clean summary).
  - Merge `develop` → `main`. Push.
  - `git mv docs/LIVE-CUTOVER.md docs/legacy/` — done, archived.
  - Commit the merge/archive on `main`.

**User:**
- Execute the cutover (theme edits, Yotpo cleanup, Settings → Brand confirm, first storefront product-page visit to populate brand-relay, smoke tests).
- Report each step's outcome.

**Done when:** smoke tests pass; CHANGELOG entry merged on `main`; `develop` merged into `main`; `LIVE-CUTOVER.md` archived; Reviews app is the live reviews system on `teraclay.com`.

---

## Adaptive items (decide in flight, with the user)

- **Exact widget-div placement on Trademark 1.7.3.** Use the now-removed Yotpo location as the breadcrumb. Confirm visually with the user.
- **Doc filename choices.** If the user prefers `STATUS.md`, `DEPLOY.md`, etc., confirm before writing.
- **Borderline items in the Phase 2 lists.** Don't unilaterally decide — that's why the user reviews.
- **`.env.example` shape.** Build from the current dev `.env`; redact secrets; document each variable in `OPERATIONS.md`.
- **Launch CHANGELOG entry.** Get the launch date from the user.
- **Reconciliation of any other drift** discovered while writing the doc suite — `session-handoff-2026-06.md` is always the tiebreaker.

---

## Explicitly NOT in scope

- **Multi-tenant retrofit.** Deferred to the public-release phase. Document as a known debt in `ROADMAP.md`. Do not start.
- **Storefront API auto-sync.** Deleted in Phase 2. Decision documented in `STATE.md` / `ROADMAP.md`.
- **Yotpo cleanup outside `LIVE-CUTOVER.md`.** Do not include in `INSTALL.md`. It is a one-time migration, not part of the ongoing install flow.
- **New features.** Cleanup + docs + deploy only. Post-launch development resumes on `develop`.
- **Public-release polish.** Marketable app naming, hosted-installer flow, multi-store support — all post-v1.

---

## Opening move

1. Read `session-handoff-2026-06.md` end-to-end. It's authoritative.
2. Skim `pre-launch-test-checklist.md`.
3. Read this document end-to-end.
4. Read the project memory files.
5. Skim `development-plan.md` for historical context. Do not treat as authoritative.
6. Confirm the locked decisions with the user (don't re-litigate them — just acknowledge), and begin **Phase 1**: state the plan, produce the user-side commands for the `develop` branch creation and the Mercury dev stack flip.

Confirm with the user before each phase transition. Don't bundle phases unless explicitly told to.

---

*End of handoff. Build the app live. Don't break the dev stack.*
