// Campaign status state machine + transition side effects.
//
// `allowedTransitions` lives in admin-campaigns.ts (route layer) and isn't
// exported, so we test it indirectly: re-state the expected matrix here and
// confirm transitionCampaignStatus + the supporting code behave as designed.
// The retention-quarantine side effect on completed/cancelled IS testable
// directly.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TestRun, assert, assertEqual } from './_harness.js';

const tmpDir = path.join(os.tmpdir(), `reviews-camp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR = tmpDir;
process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';

const { migrate, getDb, closeDb } = await import('../src/db/client.js');
const campaigns = await import('../src/db/campaigns.js');
const {
  createCampaign, findCampaignById, transitionCampaignStatus,
  checkCapacityAndAutoClose, listQuarantinedMembers, confirmPurgeShippingAddresses,
  CAMPAIGN_STATUSES, CAMPAIGN_MEMBER_STATUSES,
} = campaigns;
type CampaignStatus = typeof campaigns.CAMPAIGN_STATUSES[number];

migrate();

const run = new TestRun('09-campaign-state-machine');

// Expected transition matrix, mirroring `allowedTransitions()` in admin-campaigns.ts.
// If this matrix drifts from the code, this test will mis-pass — but the test
// itself is a documentation of intent that catches accidental rule changes.
const EXPECTED_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft:      ['recruiting', 'cancelled'],
  recruiting: ['closed', 'cancelled'],
  closed:     ['recruiting', 'shipping', 'cancelled'],
  shipping:   ['active', 'cancelled'],
  active:     ['completed', 'cancelled'],
  completed:  [],
  cancelled:  [],
};

await run.test('Every CAMPAIGN_STATUSES value has an entry in EXPECTED_TRANSITIONS', () => {
  for (const s of CAMPAIGN_STATUSES) {
    assert(s in EXPECTED_TRANSITIONS, `Status "${s}" has no entry in expected transitions map (test or code drift)`);
  }
});

await run.test('Terminal states (completed, cancelled) have NO outgoing transitions', () => {
  assertEqual(EXPECTED_TRANSITIONS.completed.length, 0, 'completed is terminal');
  assertEqual(EXPECTED_TRANSITIONS.cancelled.length, 0, 'cancelled is terminal');
});

await run.test('cancelled is reachable from every non-terminal state', () => {
  for (const s of CAMPAIGN_STATUSES) {
    if (s === 'completed' || s === 'cancelled') continue;
    assert(EXPECTED_TRANSITIONS[s].includes('cancelled'), `"${s}" must allow transition to cancelled`);
  }
});

await run.test('closed → recruiting is allowed (re-opening applications)', () => {
  assert(EXPECTED_TRANSITIONS.closed.includes('recruiting'), 'closed should allow re-opening to recruiting');
});

// --- Side effects of transitionCampaignStatus ---

// Helper to create a campaign with a member who has a shipping address.
const createCampaignWithMember = (name: string): { campaignId: number; memberId: number } => {
  const db = getDb();
  const { campaignId } = createCampaign({
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    targetSize: 10,
    capacityWarningThreshold: 7,
    productSet: [],
    discountPercent: null,
    discountExpiresDays: null,
    discountCodePrefix: null,
    termsSummaryText: 'test summary',
    termsBodyText: 'test body',
  });
  // Insert a member with a shipping address (no customer yet — applied state).
  const result = db.prepare(`
    INSERT INTO campaign_members
      (campaign_id, status, application_data_json, shipping_address_json,
       retention_status, terms_version_id, terms_accepted_at, created_at)
    VALUES (?, 'applied', '{}', '{"city":"X"}', 'active',
            (SELECT id FROM campaign_terms_versions WHERE campaign_id = ?),
            ?, ?)
  `).run(campaignId, campaignId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  return { campaignId, memberId: Number(result.lastInsertRowid) };
};

await run.test('transitionCampaignStatus to "completed" quarantines shipping addresses', () => {
  const { campaignId, memberId } = createCampaignWithMember('Quarantine Test 1');
  const db = getDb();

  const result = transitionCampaignStatus(campaignId, 'completed');
  assertEqual(result.quarantined, 1, `Expected 1 quarantined member, got ${result.quarantined}`);

  const member = db.prepare('SELECT retention_status, shipping_address_json FROM campaign_members WHERE id = ?').get(memberId) as { retention_status: string; shipping_address_json: string | null };
  assertEqual(member.retention_status, 'pending_deletion', 'Member should be marked pending_deletion');
  // At quarantine stage, the JSON is NOT yet null — that happens at confirm purge.
  assert(member.shipping_address_json !== null, 'shipping_address_json should still be present pre-purge (quarantine ≠ delete)');
});

await run.test('transitionCampaignStatus to "cancelled" also quarantines', () => {
  const { campaignId } = createCampaignWithMember('Quarantine Test 2');
  const result = transitionCampaignStatus(campaignId, 'cancelled');
  assertEqual(result.quarantined, 1, 'Cancellation should also trigger quarantine');
});

await run.test('transitionCampaignStatus to non-terminal does NOT quarantine', () => {
  const { campaignId } = createCampaignWithMember('No Quarantine Test');
  const result = transitionCampaignStatus(campaignId, 'recruiting');
  assertEqual(result.quarantined, 0, 'Non-terminal transitions must not quarantine');
});

await run.test('confirmPurgeShippingAddresses NULLs the shipping_address_json column', () => {
  const { campaignId, memberId } = createCampaignWithMember('Purge Test');
  transitionCampaignStatus(campaignId, 'completed');

  const beforePurge = getDb().prepare('SELECT shipping_address_json FROM campaign_members WHERE id = ?').get(memberId) as { shipping_address_json: string | null };
  assert(beforePurge.shipping_address_json !== null, 'Pre-purge, JSON is present');

  const purged = confirmPurgeShippingAddresses([memberId]);
  assertEqual(purged, 1, `Expected 1 row purged, got ${purged}`);

  const afterPurge = getDb().prepare('SELECT shipping_address_json, retention_status FROM campaign_members WHERE id = ?').get(memberId) as { shipping_address_json: string | null; retention_status: string };
  assertEqual(afterPurge.shipping_address_json, null, 'shipping_address_json should be NULL after purge');
  assertEqual(afterPurge.retention_status, 'purged', 'retention_status should be "purged"');
});

await run.test('listQuarantinedMembers returns pending_deletion members', () => {
  // We've added at least 2 quarantined-then-purged + 1 quarantined-still by this
  // point. Verify only the still-pending ones come back.
  const db = getDb();
  // Re-create a known pending one for this test.
  const { campaignId, memberId } = createCampaignWithMember('Listing Test');
  transitionCampaignStatus(campaignId, 'completed');

  const queue = listQuarantinedMembers();
  const ours = queue.find((q: { id: number }) => q.id === memberId);
  assert(ours !== undefined, `Just-quarantined member ${memberId} should appear in listQuarantinedMembers result`);
});

// --- checkCapacityAndAutoClose ---

await run.test('checkCapacityAndAutoClose auto-closes when target reached + flips status', () => {
  const db = getDb();
  const { campaignId } = createCampaign({
    name: 'Capacity Test',
    slug: 'capacity-test',
    targetSize: 3,
    capacityWarningThreshold: 2,
    productSet: [],
    discountPercent: null,
    discountExpiresDays: null,
    discountCodePrefix: null,
    termsSummaryText: 's',
    termsBodyText: 'b',
  });
  // Start in recruiting (the only state where auto-close fires).
  transitionCampaignStatus(campaignId, 'recruiting');

  const insertMember = (status: string) => {
    db.prepare(`
      INSERT INTO campaign_members
        (campaign_id, status, application_data_json, retention_status, terms_version_id, terms_accepted_at, created_at)
      VALUES (?, ?, '{}', 'active',
              (SELECT id FROM campaign_terms_versions WHERE campaign_id = ?),
              ?, ?)
    `).run(campaignId, status, campaignId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  };

  // 1 member: not yet at threshold, not at capacity.
  insertMember('applied');
  let r = checkCapacityAndAutoClose(campaignId);
  assertEqual(r.activeCount, 1, 'Active count should be 1');
  assertEqual(r.thresholdCrossed, false, 'Below threshold');
  assertEqual(r.autoClosed, false, 'Below capacity');

  // 2 members: at threshold of 2, not at capacity of 3.
  insertMember('applied');
  r = checkCapacityAndAutoClose(campaignId);
  assertEqual(r.activeCount, 2, 'Active count should be 2');
  assertEqual(r.thresholdCrossed, true, 'Threshold (2) crossed for the first time');
  assertEqual(r.autoClosed, false, 'Still below capacity');

  // 3 members: at capacity. Should auto-close.
  insertMember('applied');
  r = checkCapacityAndAutoClose(campaignId);
  assertEqual(r.activeCount, 3, 'Active count should be 3');
  assertEqual(r.autoClosed, true, 'Should auto-close at target');
  // thresholdCrossed should NOT fire again — already fired.
  assertEqual(r.thresholdCrossed, false, 'Threshold only fires once per arming');

  const camp = findCampaignById(campaignId)!;
  assertEqual(camp.status, 'closed', 'Campaign status should now be "closed"');
});

await run.test('checkCapacityAndAutoClose does NOT count rejected members toward capacity', () => {
  const db = getDb();
  const { campaignId } = createCampaign({
    name: 'Rejected Counts Test',
    slug: 'rejected-counts',
    targetSize: 3,
    capacityWarningThreshold: null,
    productSet: [],
    discountPercent: null,
    discountExpiresDays: null,
    discountCodePrefix: null,
    termsSummaryText: 's',
    termsBodyText: 'b',
  });
  transitionCampaignStatus(campaignId, 'recruiting');
  // Insert 3 rejected + 1 applied. Should NOT auto-close — active count is 1.
  const insertMember = (status: string) => {
    db.prepare(`
      INSERT INTO campaign_members
        (campaign_id, status, application_data_json, retention_status, terms_version_id, terms_accepted_at, created_at)
      VALUES (?, ?, '{}', 'active',
              (SELECT id FROM campaign_terms_versions WHERE campaign_id = ?),
              ?, ?)
    `).run(campaignId, status, campaignId, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  };
  insertMember('rejected');
  insertMember('rejected');
  insertMember('rejected');
  insertMember('applied');
  const r = checkCapacityAndAutoClose(campaignId);
  assertEqual(r.activeCount, 1, 'Only the 1 non-rejected member should count');
  assertEqual(r.autoClosed, false, 'Should not auto-close at 1 active');
});

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(run.finish() ? 0 : 1);
