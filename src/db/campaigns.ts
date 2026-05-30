// Query helpers for the Campaigns feature. Kept in its own file to keep
// queries.ts focused on the core review pipeline.
//
// Conventions match queries.ts: explicit row types, prepared statements
// inline at call sites, shop_id defaults applied by the migration (no need
// to thread shop_id through every insert today — when multi-tenancy lands,
// the seam at getCurrentShopId() in lib/tenant.ts gets wired up everywhere
// in one pass).

import { getDb } from './client.js';
import { nowSec } from '../lib/time.js';

// --- Enums ---

export const CAMPAIGN_STATUSES = [
  'draft',
  'recruiting',
  'closed',
  'shipping',
  'active',
  'completed',
  'cancelled',
] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export const isCampaignStatus = (v: unknown): v is CampaignStatus =>
  typeof v === 'string' && (CAMPAIGN_STATUSES as readonly string[]).includes(v);

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  recruiting: 'Recruiting',
  closed: 'Closed',
  shipping: 'Shipping',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const CAMPAIGN_MEMBER_STATUSES = [
  'applied',
  'approved',
  'rejected',
  'shipped',
  'reviewed',
  'done',
] as const;
export type CampaignMemberStatus = typeof CAMPAIGN_MEMBER_STATUSES[number];

export const isCampaignMemberStatus = (v: unknown): v is CampaignMemberStatus =>
  typeof v === 'string' && (CAMPAIGN_MEMBER_STATUSES as readonly string[]).includes(v);

export const CAMPAIGN_MEMBER_STATUS_LABELS: Record<CampaignMemberStatus, string> = {
  applied: 'Applied',
  approved: 'Approved',
  rejected: 'Rejected',
  shipped: 'Shipped',
  reviewed: 'Reviewed',
  done: 'Done',
};

// --- Row types ---

export interface CampaignRow {
  id: number;
  shop_id: number;
  name: string;
  slug: string;
  status: CampaignStatus;
  target_size: number;
  capacity_warning_threshold: number | null;
  capacity_warning_fired_at: number | null;
  product_set_json: string;
  discount_percent: number | null;
  discount_expires_days: number | null;
  discount_code_prefix: string | null;
  created_at: number;
  updated_at: number;
}

export interface CampaignTermsVersionRow {
  id: number;
  shop_id: number;
  campaign_id: number;
  version_number: number;
  body_text: string;
  // Plain-language summary shown above the full body in the application
  // form. Added in migration 020; NULL on versions created before that
  // migration.
  summary_text: string | null;
  created_at: number;
}

export interface CampaignMemberRow {
  id: number;
  shop_id: number;
  campaign_id: number;
  customer_id: number | null;
  status: CampaignMemberStatus;
  application_data_json: string;
  shipping_address_json: string | null;
  retention_status: string;
  terms_version_id: number;
  terms_accepted_at: number;
  ip_hash: string | null;
  user_agent: string | null;
  discount_code: string | null;
  discount_code_id: string | null;
  code_status: string | null;
  code_redeemed_at: number | null;
  code_redeemed_order_id: string | null;
  code_redeemed_order_total: number | null;
  decided_at: number | null;
  decided_by: string | null;
  created_at: number;
}

// Product-set entry as stored in campaigns.product_set_json. The whole array
// is a JSON column; helpers below parse/stringify so callers see a typed shape.
export interface CampaignProduct {
  shopifyProductId: string;
  shopifyVariantId: string | null;
}

// --- Campaigns ---

export const listCampaigns = (): CampaignRow[] => {
  return getDb()
    .prepare('SELECT * FROM campaigns ORDER BY created_at DESC, id DESC')
    .all() as CampaignRow[];
};

export const findCampaignById = (id: number): CampaignRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaigns WHERE id = ?')
    .get(id) as CampaignRow | undefined) ?? null;
};

export const findCampaignBySlug = (slug: string): CampaignRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaigns WHERE slug = ?')
    .get(slug) as CampaignRow | undefined) ?? null;
};

// Creates a campaign in `draft` status and seeds version 1 of the terms in a
// single transaction. Returns the new campaign id and the terms_version_id of
// v1 (the caller may want to display it immediately).
export const createCampaign = (input: {
  name: string;
  slug: string;
  targetSize: number;
  capacityWarningThreshold: number | null;
  productSet: CampaignProduct[];
  discountPercent: number | null;
  discountExpiresDays: number | null;
  discountCodePrefix: string | null;
  termsSummaryText: string;
  termsBodyText: string;
}): { campaignId: number; termsVersionId: number } => {
  const now = nowSec();
  const db = getDb();
  let campaignId = 0;
  let termsVersionId = 0;

  db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO campaigns
        (name, slug, status, target_size, capacity_warning_threshold,
         product_set_json, discount_percent, discount_expires_days,
         discount_code_prefix, created_at, updated_at)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.slug,
      input.targetSize,
      input.capacityWarningThreshold,
      JSON.stringify(input.productSet),
      input.discountPercent,
      input.discountExpiresDays,
      input.discountCodePrefix,
      now,
      now,
    );
    campaignId = Number(result.lastInsertRowid);

    const termsResult = db.prepare(`
      INSERT INTO campaign_terms_versions
        (campaign_id, version_number, body_text, summary_text, created_at)
      VALUES (?, 1, ?, ?, ?)
    `).run(campaignId, input.termsBodyText, input.termsSummaryText, now);
    termsVersionId = Number(termsResult.lastInsertRowid);
  })();

  return { campaignId, termsVersionId };
};

// Updates the merchant-editable fields on a campaign (everything except
// status, which has its own transition function). The campaign-setup form
// posts here for edits to an existing campaign.
export const updateCampaignSettings = (input: {
  id: number;
  name: string;
  targetSize: number;
  capacityWarningThreshold: number | null;
  productSet: CampaignProduct[];
  discountPercent: number | null;
  discountExpiresDays: number | null;
  discountCodePrefix: string | null;
}): void => {
  getDb().prepare(`
    UPDATE campaigns
       SET name = ?,
           target_size = ?,
           capacity_warning_threshold = ?,
           product_set_json = ?,
           discount_percent = ?,
           discount_expires_days = ?,
           discount_code_prefix = ?,
           updated_at = ?
     WHERE id = ?
  `).run(
    input.name,
    input.targetSize,
    input.capacityWarningThreshold,
    JSON.stringify(input.productSet),
    input.discountPercent,
    input.discountExpiresDays,
    input.discountCodePrefix,
    nowSec(),
    input.id,
  );
};

export const updateCampaignStatus = (id: number, status: CampaignStatus): void => {
  getDb().prepare(`
    UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, nowSec(), id);
};

// Wraps updateCampaignStatus with the retention-pipe side effect: when a
// campaign moves to a terminal state (completed/cancelled), every member's
// shipping_address_json flips to `pending_deletion` quarantine. The merchant
// later confirms the purge from the Retention queue admin view.
//
// Quarantine-only side effect: the actual NULL of the shipping address
// happens at Stage 2 (admin confirmation). At Stage 1 the field is still
// readable from the DB; the retention_status flag tells the rest of the app
// not to read it.
//
// Returns the number of newly-quarantined member rows.
export const transitionCampaignStatus = (id: number, status: CampaignStatus): { quarantined: number } => {
  const db = getDb();
  let quarantined = 0;
  db.transaction(() => {
    db.prepare(`UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowSec(), id);
    if (status === 'completed' || status === 'cancelled') {
      const result = db.prepare(`
        UPDATE campaign_members
           SET retention_status = 'pending_deletion'
         WHERE campaign_id = ?
           AND retention_status = 'active'
           AND shipping_address_json IS NOT NULL
      `).run(id);
      quarantined = result.changes;
    }
  })();
  return { quarantined };
};

// Resets the "capacity warning has fired" timestamp so the next crossing of
// the threshold fires another warning. Used by the admin "Reset capacity
// warning" button.
export const resetCapacityWarning = (id: number): void => {
  getDb().prepare(`
    UPDATE campaigns SET capacity_warning_fired_at = NULL, updated_at = ? WHERE id = ?
  `).run(nowSec(), id);
};

export const markCapacityWarningFired = (id: number): void => {
  const now = nowSec();
  getDb().prepare(`
    UPDATE campaigns SET capacity_warning_fired_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, id);
};

// Called after a successful application insert. Examines the campaign's
// current active count against (a) the auto-close target_size and (b) the
// capacity-warning threshold, applying any state changes atomically. Returns
// flags so the caller can fire the notification email outside the
// transaction.
//
//   thresholdCrossed: true iff this insert crossed `capacity_warning_threshold`
//                     AND no warning had previously fired (since last reset)
//   autoClosed:       true iff this insert reached target_size AND the
//                     campaign was 'recruiting' (state flipped to 'closed')
export interface CapacityCheckResult {
  thresholdCrossed: boolean;
  autoClosed: boolean;
  activeCount: number;
}

export const checkCapacityAndAutoClose = (campaignId: number): CapacityCheckResult => {
  const db = getDb();
  let result: CapacityCheckResult = { thresholdCrossed: false, autoClosed: false, activeCount: 0 };

  db.transaction(() => {
    const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId) as CampaignRow | undefined;
    if (!camp) return;

    const activeRow = db.prepare(`
      SELECT COUNT(*) AS n FROM campaign_members
       WHERE campaign_id = ? AND status <> 'rejected'
    `).get(campaignId) as { n: number };
    const active = activeRow.n;

    let autoClosed = false;
    if (active >= camp.target_size && camp.status === 'recruiting') {
      db.prepare(`UPDATE campaigns SET status = 'closed', updated_at = ? WHERE id = ?`).run(nowSec(), campaignId);
      autoClosed = true;
    }

    let thresholdCrossed = false;
    if (
      camp.capacity_warning_threshold !== null &&
      active >= camp.capacity_warning_threshold &&
      camp.capacity_warning_fired_at === null
    ) {
      db.prepare(`UPDATE campaigns SET capacity_warning_fired_at = ?, updated_at = ? WHERE id = ?`)
        .run(nowSec(), nowSec(), campaignId);
      thresholdCrossed = true;
    }

    result = { thresholdCrossed, autoClosed, activeCount: active };
  })();

  return result;
};

// Parses the product_set_json column. Returns [] on parse failure rather than
// throwing — the column should never be malformed but a defensive default
// keeps the rest of the page rendering.
export const parseProductSet = (campaign: CampaignRow): CampaignProduct[] => {
  try {
    const parsed = JSON.parse(campaign.product_set_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CampaignProduct =>
        typeof p === 'object' && p !== null && typeof (p as CampaignProduct).shopifyProductId === 'string',
    );
  } catch {
    return [];
  }
};

// --- Terms versions ---

export const listTermsVersions = (campaignId: number): CampaignTermsVersionRow[] => {
  return getDb()
    .prepare(`
      SELECT * FROM campaign_terms_versions
       WHERE campaign_id = ?
       ORDER BY version_number DESC
    `)
    .all(campaignId) as CampaignTermsVersionRow[];
};

export const findTermsVersion = (id: number): CampaignTermsVersionRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_terms_versions WHERE id = ?')
    .get(id) as CampaignTermsVersionRow | undefined) ?? null;
};

// The most recently saved terms version, which is what new applicants accept.
// Campaigns always have at least version 1 (created with the campaign).
export const getActiveTermsVersion = (campaignId: number): CampaignTermsVersionRow | null => {
  return (getDb()
    .prepare(`
      SELECT * FROM campaign_terms_versions
       WHERE campaign_id = ?
       ORDER BY version_number DESC
       LIMIT 1
    `)
    .get(campaignId) as CampaignTermsVersionRow | undefined) ?? null;
};

// Creates a new terms version with version_number = max + 1. The merchant
// saves a new version explicitly (no auto-versioning on every keystroke);
// each save creates one row capturing both the plain-language summary and
// the full legal body.
export const saveTermsVersion = (input: {
  campaignId: number;
  summaryText: string;
  bodyText: string;
}): CampaignTermsVersionRow => {
  const db = getDb();
  const now = nowSec();
  let newId = 0;

  db.transaction(() => {
    const row = db.prepare(`
      SELECT COALESCE(MAX(version_number), 0) AS max_version
        FROM campaign_terms_versions
       WHERE campaign_id = ?
    `).get(input.campaignId) as { max_version: number };
    const next = row.max_version + 1;

    const result = db.prepare(`
      INSERT INTO campaign_terms_versions
        (campaign_id, version_number, body_text, summary_text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.campaignId, next, input.bodyText, input.summaryText, now);
    newId = Number(result.lastInsertRowid);
  })();

  return findTermsVersion(newId)!;
};

// --- Members ---

export const listMembersByCampaign = (campaignId: number): CampaignMemberRow[] => {
  return getDb()
    .prepare(`
      SELECT * FROM campaign_members
       WHERE campaign_id = ?
       ORDER BY created_at DESC, id DESC
    `)
    .all(campaignId) as CampaignMemberRow[];
};

export const findCampaignMemberById = (id: number): CampaignMemberRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_members WHERE id = ?')
    .get(id) as CampaignMemberRow | undefined) ?? null;
};

// Returns the most recent non-rejected member for this campaign matching the
// given email (extracted from application_data_json). Used by the public apply
// endpoint to reject duplicate submissions politely. A rejected application
// doesn't block reapplying.
export const findCampaignMemberByEmail = (
  campaignId: number,
  email: string,
): CampaignMemberRow | null => {
  return (getDb()
    .prepare(`
      SELECT * FROM campaign_members
       WHERE campaign_id = ?
         AND json_extract(application_data_json, '$.email') = ?
         AND status <> 'rejected'
       ORDER BY created_at DESC
       LIMIT 1
    `)
    .get(campaignId, email.toLowerCase()) as CampaignMemberRow | undefined) ?? null;
};

// Per-status member counts for the detail page summary. Returns a complete
// record with zeros so the UI doesn't have to coalesce.
export const countMembersByStatus = (campaignId: number): Record<CampaignMemberStatus, number> => {
  const out: Record<CampaignMemberStatus, number> = {
    applied: 0, approved: 0, rejected: 0, shipped: 0, reviewed: 0, done: 0,
  };
  const rows = getDb()
    .prepare(`
      SELECT status, COUNT(*) AS n FROM campaign_members
       WHERE campaign_id = ?
       GROUP BY status
    `)
    .all(campaignId) as Array<{ status: string; n: number }>;
  for (const r of rows) {
    if (isCampaignMemberStatus(r.status)) out[r.status] = r.n;
  }
  return out;
};

// Returns the number of "active" applications (applied + approved + shipped +
// reviewed + done — everything that isn't rejected). Used to decide auto-close
// and capacity-warning crossings.
export const countActiveMembers = (campaignId: number): number => {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS n FROM campaign_members
       WHERE campaign_id = ?
         AND status <> 'rejected'
    `)
    .get(campaignId) as { n: number };
  return row.n;
};

// Inserts a new application row. Returns the new member id. The caller is
// responsible for capturing IP/UA and pre-serializing the JSON columns;
// keeping this thin lets the public endpoint own its own validation surface.
export const insertCampaignMember = (input: {
  campaignId: number;
  applicationDataJson: string;
  shippingAddressJson: string | null;
  termsVersionId: number;
  ipHash: string | null;
  userAgent: string | null;
}): number => {
  const now = nowSec();
  const result = getDb().prepare(`
    INSERT INTO campaign_members
      (campaign_id, status, application_data_json, shipping_address_json,
       terms_version_id, terms_accepted_at, ip_hash, user_agent, created_at)
    VALUES (?, 'applied', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.campaignId,
    input.applicationDataJson,
    input.shippingAddressJson,
    input.termsVersionId,
    now,
    input.ipHash,
    input.userAgent,
    now,
  );
  return Number(result.lastInsertRowid);
};

export const updateMemberStatus = (input: {
  id: number;
  status: CampaignMemberStatus;
  customerId?: number | null;
  decidedBy?: string | null;
}): void => {
  const now = nowSec();
  const db = getDb();
  // Stamp decided_at/decided_by for moderation transitions (approved/rejected).
  // Other transitions (shipped/reviewed/done) get the same stamp; harmless.
  db.prepare(`
    UPDATE campaign_members
       SET status = ?,
           customer_id = COALESCE(?, customer_id),
           decided_at = ?,
           decided_by = COALESCE(?, decided_by)
     WHERE id = ?
  `).run(
    input.status,
    input.customerId ?? null,
    now,
    input.decidedBy ?? null,
    input.id,
  );
};

// Hard-deletes a member row pre-ship. Used by the "remove from campaign"
// admin action for applicants who change their mind before shipping. Cascades
// nothing — invitations and discount codes haven't been generated yet at this
// stage.
export const deleteCampaignMember = (id: number): void => {
  getDb().prepare('DELETE FROM campaign_members WHERE id = ?').run(id);
};

// Helpers for parsing the JSON columns when iterating members in bulk. The
// columns are TEXT in SQLite so callers always parse; centralize the shape
// here so a typo at one call site doesn't drift from another.
export interface CampaignApplicationData {
  firstName: string;
  lastName: string;
  email: string;
  message: string | null;
}

export const parseApplicationData = (
  member: CampaignMemberRow,
): CampaignApplicationData | null => {
  try {
    const parsed = JSON.parse(member.application_data_json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    return {
      firstName: typeof o.firstName === 'string' ? o.firstName : '',
      lastName: typeof o.lastName === 'string' ? o.lastName : '',
      email: typeof o.email === 'string' ? o.email : '',
      message: typeof o.message === 'string' ? o.message : null,
    };
  } catch {
    return null;
  }
};

// --- Campaign-tagged sample invitations ---
//
// Wraps the INSERT into sample_invitations with a campaign_id column. We
// don't reuse createSampleInvitation in queries.ts because its column list
// would need to grow for an optional campaign_id and we'd be threading
// undefined through every existing call site. Cleaner to have campaigns own
// its variant.

export const createCampaignInvitation = (input: {
  campaignId: number;
  shopifyProductId: string;
  intendedEmail: string;
  intendedName: string | null;
  notes: string | null;
  expiresAt: number;
}): number => {
  const now = nowSec();
  const result = getDb().prepare(`
    INSERT INTO sample_invitations
      (shopify_product_id, intended_email, intended_name, notes,
       created_at, expires_at, campaign_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.shopifyProductId,
    input.intendedEmail.toLowerCase(),
    input.intendedName,
    input.notes,
    now,
    input.expiresAt,
    input.campaignId,
  );
  return Number(result.lastInsertRowid);
};

// True if at least one campaign-tagged invitation exists for this campaign
// and recipient email. Used to make the bulk-generate action idempotent: if
// the merchant clicks "Generate invitations" twice, the second click skips
// members who already got invitations the first time.
export const memberHasInvitations = (
  campaignId: number,
  email: string,
): boolean => {
  const row = getDb()
    .prepare(`
      SELECT 1 AS x FROM sample_invitations
       WHERE campaign_id = ?
         AND intended_email = ?
       LIMIT 1
    `)
    .get(campaignId, email.toLowerCase()) as { x: 1 } | undefined;
  return row !== undefined;
};

// Per-member invitation count, used for the admin queue display ("3 of 3
// invitations generated"). Cheap query — campaign_id is indexed.
export const countInvitationsForMember = (
  campaignId: number,
  email: string,
): number => {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS n FROM sample_invitations
       WHERE campaign_id = ?
         AND intended_email = ?
    `)
    .get(campaignId, email.toLowerCase()) as { n: number };
  return row.n;
};

// Lists the campaign-tagged invitations for one campaign. Used by the admin
// detail page to show the linked invitation set per member.
export interface CampaignInvitationRow {
  id: number;
  shopify_product_id: string;
  intended_email: string | null;
  intended_name: string | null;
  consumed_at: number | null;
  consumed_review_id: number | null;
  created_at: number;
  expires_at: number;
  campaign_id: number | null;
}

export const listInvitationsByCampaign = (campaignId: number): CampaignInvitationRow[] => {
  return getDb()
    .prepare(`
      SELECT id, shopify_product_id, intended_email, intended_name,
             consumed_at, consumed_review_id, created_at, expires_at, campaign_id
        FROM sample_invitations
       WHERE campaign_id = ?
       ORDER BY id DESC
    `)
    .all(campaignId) as CampaignInvitationRow[];
};

// --- Discount codes ---

// Records a freshly-created Shopify discount code on a campaign member. The
// admin "Generate codes" action calls this after every successful Shopify
// API mutation; failures don't write a row, so a partial batch leaves clean
// state.
export const setMemberDiscountCode = (input: {
  memberId: number;
  code: string;
  discountId: string;
}): void => {
  getDb().prepare(`
    UPDATE campaign_members
       SET discount_code = ?,
           discount_code_id = ?,
           code_status = 'active'
     WHERE id = ?
  `).run(input.code, input.discountId, input.memberId);
};

// Marks a member's code as redeemed when the orders/paid webhook spots the
// code on an incoming order. Stores the order id and total for the campaign-
// level "X codes redeemed, $Y revenue" stats.
export const markMemberCodeRedeemed = (input: {
  memberId: number;
  orderId: string;
  orderTotal: number;
}): void => {
  getDb().prepare(`
    UPDATE campaign_members
       SET code_status = 'redeemed',
           code_redeemed_at = ?,
           code_redeemed_order_id = ?,
           code_redeemed_order_total = ?
     WHERE id = ?
  `).run(nowSec(), input.orderId, input.orderTotal, input.memberId);
};

// Used by the orders/paid handler to look up which member owns a given code.
// Returns null if the code isn't ours (most codes won't be), so the webhook
// handler skips quickly.
export const findMemberByDiscountCode = (code: string): CampaignMemberRow | null => {
  return (getDb()
    .prepare('SELECT * FROM campaign_members WHERE discount_code = ?')
    .get(code) as CampaignMemberRow | undefined) ?? null;
};

// Updates a member's code_status after the cleanup action removed the code
// from Shopify. We never null out the actual code string or discount_code_id
// — those stay as the audit trail.
export const markMemberCodeDeleted = (memberId: number): void => {
  getDb().prepare(`
    UPDATE campaign_members SET code_status = 'deleted_from_shopify' WHERE id = ?
  `).run(memberId);
};

// Per-status counts for the discount-code stats card on the detail page.
export interface CodeStats {
  active: number;
  redeemed: number;
  expired: number;
  deleted_from_shopify: number;
  unredeemed_revenue: number; // sum of code_redeemed_order_total for redeemed
}

export const codeStats = (campaignId: number): CodeStats => {
  const rows = getDb()
    .prepare(`
      SELECT code_status AS status, COUNT(*) AS n,
             COALESCE(SUM(code_redeemed_order_total), 0) AS total_revenue
        FROM campaign_members
       WHERE campaign_id = ? AND discount_code IS NOT NULL
       GROUP BY code_status
    `)
    .all(campaignId) as Array<{ status: string; n: number; total_revenue: number }>;

  const out: CodeStats = {
    active: 0,
    redeemed: 0,
    expired: 0,
    deleted_from_shopify: 0,
    unredeemed_revenue: 0,
  };
  for (const r of rows) {
    if (r.status === 'active') out.active = r.n;
    else if (r.status === 'redeemed') {
      out.redeemed = r.n;
      out.unredeemed_revenue = r.total_revenue;
    }
    else if (r.status === 'expired') out.expired = r.n;
    else if (r.status === 'deleted_from_shopify') out.deleted_from_shopify = r.n;
  }
  return out;
};

// Members whose discount code can be deleted in a cleanup action. `mode`
// picks which subset: 'unredeemed' = code_status IN ('active','expired'),
// 'all' = any non-null discount_code_id. Excludes already-deleted codes so
// repeat clicks don't re-call Shopify.
export const listMembersForCodeCleanup = (
  campaignId: number,
  mode: 'unredeemed' | 'all',
): CampaignMemberRow[] => {
  const baseSql = `
    SELECT * FROM campaign_members
     WHERE campaign_id = ?
       AND discount_code_id IS NOT NULL
       AND code_status <> 'deleted_from_shopify'
  `;
  if (mode === 'unredeemed') {
    return getDb()
      .prepare(`${baseSql} AND code_status IN ('active', 'expired')`)
      .all(campaignId) as CampaignMemberRow[];
  }
  return getDb().prepare(baseSql).all(campaignId) as CampaignMemberRow[];
};

// --- Retention queue (Stage 2 of the two-stage deletion pipe) ---
//
// listQuarantinedMembers returns every member row across all campaigns whose
// shipping address is in `pending_deletion`. The admin reviews and confirms;
// confirmPurgeShippingAddresses NULLs the actual JSON column and flips the
// retention flag to 'purged' so a future restore (e.g., from a backup) can
// tell what was already retention-deleted.

export interface QuarantinedMemberRow extends CampaignMemberRow {
  campaign_name: string;
  campaign_status: string;
}

export const listQuarantinedMembers = (): QuarantinedMemberRow[] => {
  return getDb().prepare(`
    SELECT m.*, c.name AS campaign_name, c.status AS campaign_status
      FROM campaign_members m
      JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.retention_status = 'pending_deletion'
     ORDER BY m.campaign_id DESC, m.id DESC
  `).all() as QuarantinedMemberRow[];
};

export const countQuarantinedMembers = (): number => {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM campaign_members WHERE retention_status = 'pending_deletion'`)
    .get() as { n: number };
  return row.n;
};

// Hard-delete the shipping addresses for the given member ids in a single
// transaction. Each row's shipping_address_json is NULLed and retention_status
// flips to 'purged'. Returns the number of rows affected.
export const confirmPurgeShippingAddresses = (memberIds: number[]): number => {
  if (memberIds.length === 0) return 0;
  const db = getDb();
  let total = 0;
  const placeholders = memberIds.map(() => '?').join(',');
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE campaign_members
         SET shipping_address_json = NULL,
             retention_status = 'purged'
       WHERE id IN (${placeholders})
         AND retention_status = 'pending_deletion'
    `).run(...memberIds);
    total = result.changes;
  })();
  return total;
};
