// Database schema integrity, applied against a freshly-migrated temp DB.
//
// Why a temp DB instead of the local one: the local D:\AI\shopify-reviews\data
// DB is stale — the user develops/tests on the Mercury dev stack, so the
// local file lags behind. Re-running migrations on the local file would
// modify it; using a temp DB lets us answer the more interesting question
// instead: "do ALL migrations apply cleanly to a fresh DB and produce the
// expected schema?" That's the same code path that will run on prod cutover.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { TestRun, assert, assertEqual } from './_harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationsDir = path.join(repoRoot, 'src', 'db', 'migrations');

const tmpDir = path.join(os.tmpdir(), `reviews-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR = tmpDir;
process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';

const { migrate, closeDb } = await import('../src/db/client.js');
const { seedDefaultEmailTemplates } = await import('../src/email/email-config.js');
const { seedDefaultProfanityWordlist } = await import('../src/lib/profanity.js');
const { ensureCurrentShop } = await import('../src/lib/tenant.js');

// Apply the full boot sequence so we test what the live app does on first boot.
let migrateError: unknown = null;
try {
  migrate();
  ensureCurrentShop();
  seedDefaultEmailTemplates();
  seedDefaultProfanityWordlist();
} catch (e) {
  migrateError = e;
}

const run = new TestRun('02-database');

await run.test('All migrations apply to a fresh DB without throwing', () => {
  assert(
    migrateError === null,
    `migrate() or one of the seeders threw during boot. The app would fail to start on a fresh install.`,
    { error: migrateError instanceof Error ? migrateError.message : String(migrateError) },
  );
});

// Open a read-only handle for inspection.
const db = new Database(path.join(tmpDir, 'reviews.db'), { readonly: true });

await run.test('All .sql migration files have a row in _migrations after boot', () => {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (db.prepare('SELECT filename FROM _migrations').all() as Array<{ filename: string }>)
      .map((r) => r.filename),
  );
  const missing = files.filter((f) => !applied.has(f));
  assert(
    missing.length === 0,
    `Migration files exist on disk but didn't get applied. migrate() may have errored mid-list.`,
    { missing, expectedCount: files.length, actualAppliedCount: applied.size },
  );
});

await run.test('PRAGMA foreign_key_check returns no violations on fresh DB', () => {
  const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  assert(
    violations.length === 0,
    `Foreign-key violations on a freshly-migrated DB. This is the same kind of FK-orphan that crashed migration 016 on dev.`,
    { violations: violations.slice(0, 20) },
  );
});

await run.test('All expected tables exist', () => {
  const expectedTables = [
    'customers', 'products_cache', 'purchases', 'reviews', 'review_media',
    'email_events', 'questions', 'settings', 'sample_invitations',
    'email_templates', 'moderation_events', 'panic_events', 'review_reports',
    'banned_reporters', 'shops', 'campaigns', 'campaign_terms_versions',
    'campaign_members', 'campaign_feedback_forms', 'campaign_feedback_questions',
    'campaign_feedback_responses', 'campaign_feedback_answers',
  ];
  const actual = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != '_migrations'").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  const missing = expectedTables.filter((t) => !actual.has(t));
  assert(
    missing.length === 0,
    `Expected tables are missing from the schema after a full migration. The corresponding migration may have failed.`,
    { missing, allTables: [...actual].sort() },
  );
});

await run.test('Critical indices exist', () => {
  const expectedIndices = [
    'idx_purchases_due',
    'idx_reviews_product',
    'idx_reviews_customer_product',
    'idx_email_events_customer',
    'idx_campaigns_status',
    'idx_campaign_members_status',
    'uniq_default_template',
    'uniq_campaign_template',
  ];
  const actual = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  const missing = expectedIndices.filter((i) => !actual.has(i));
  assert(
    missing.length === 0,
    `Critical indices missing from a fresh schema.`,
    { missing, allIndices: [...actual].sort() },
  );
});

await run.test('Settings has all keys the code reads with sensible types', () => {
  const required = [
    'cadence_max_requests',
    'cadence_min_days_between',
    'request_delay_days',
    'cadence_dispatcher_batch',
    'shop_brand_json',
  ];
  const settings = new Map(
    (db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>)
      .map((r) => [r.key, r.value]),
  );
  const missing = required.filter((k) => !settings.has(k));
  assert(
    missing.length === 0,
    `Required settings keys are missing after a fresh boot. They should be seeded by migration 001 or by boot code.`,
    { missing, presentKeys: [...settings.keys()].sort() },
  );

  const numericKeys = ['cadence_max_requests', 'cadence_min_days_between', 'request_delay_days', 'cadence_dispatcher_batch'];
  for (const k of numericKeys) {
    const v = Number(settings.get(k));
    assertEqual(Number.isFinite(v), true,
      `Setting "${k}" is not a finite number. Code that calls getSettingNumber will fall through to the fallback.`,
      { key: k, rawValue: settings.get(k) });
  }
});

await run.test('shops table has the real shop row from env (not just placeholder)', () => {
  const shops = db.prepare('SELECT id, shop_domain FROM shops').all() as Array<{ id: number; shop_domain: string }>;
  assert(shops.length >= 1, `shops table is empty after ensureCurrentShop() ran.`);
  const realShop = shops.find((s) => s.shop_domain === 'test.myshopify.com');
  assert(
    realShop !== undefined,
    `Expected shops row with shop_domain='test.myshopify.com' (from env SHOPIFY_SHOP_DOMAIN). ensureCurrentShop() didn't upsert it.`,
    { allShops: shops },
  );
});

await run.test('Default email templates seeded for every wired trigger', () => {
  const wiredTriggers = [
    'review_request',
    'review_request_followup',
    'repeat_customer_review',
    'review_removed',
    'review_restored',
    'campaign_application_confirmation',
    'campaign_shipped_notification',
    'campaign_review_reminder',
    'campaign_launch_thanks',
  ];
  const templates = db.prepare(
    'SELECT template_key, trigger_event, is_active FROM email_templates WHERE campaign_id IS NULL',
  ).all() as Array<{ template_key: string; trigger_event: string | null; is_active: number }>;
  const byTrigger = new Map<string, typeof templates[number]>();
  for (const t of templates) {
    if (t.trigger_event) byTrigger.set(t.trigger_event, t);
  }

  const missing = wiredTriggers.filter((t) => !byTrigger.has(t));
  assert(
    missing.length === 0,
    `Wired triggers have no active default template. The dispatcher's findActiveTemplateForTrigger() will return null → those send paths silently skip.`,
    { missingTriggers: missing, seededTriggers: [...byTrigger.keys()] },
  );

  const inactive = wiredTriggers
    .map((t) => ({ trigger: t, row: byTrigger.get(t) }))
    .filter(({ row }) => row && row.is_active !== 1)
    .map(({ trigger }) => trigger);
  assert(inactive.length === 0, `Wired triggers have an INACTIVE template (is_active=0). Same effect as missing.`, { inactiveTriggers: inactive });
});

await run.test('Profanity wordlist seeded on first boot', () => {
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'profanity_seeded'").get() as { value: string } | undefined;
  assert(
    seeded?.value === '1',
    `profanity_seeded flag is not '1'. seedDefaultProfanityWordlist() didn't complete.`,
    { actual: seeded?.value ?? '(missing)' },
  );
  const wordlist = db.prepare("SELECT value FROM settings WHERE key = 'profanity_wordlist'").get() as { value: string } | undefined;
  assert(
    wordlist !== undefined && wordlist.value.length > 0,
    `Default profanity wordlist is empty after seeding.`,
  );
});

await run.test('reviews.shopify_product_id unique-per-customer index excludes rejected', () => {
  const idx = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_reviews_customer_product'",
  ).get() as { sql: string } | undefined;
  assert(idx !== undefined, `idx_reviews_customer_product index doesn't exist.`);
  const sql = idx!.sql.toLowerCase();
  assert(
    sql.includes("status <> 'rejected'"),
    `idx_reviews_customer_product exists but its WHERE clause doesn't exclude rejected reviews. Retracted-then-resubmit will fail with a UNIQUE constraint violation.`,
    { actualSql: idx!.sql },
  );
});

await run.test('campaign_feedback_answers has ON DELETE CASCADE on FKs', () => {
  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='campaign_feedback_answers'",
  ).get() as { sql: string } | undefined;
  assert(tableSql !== undefined, `campaign_feedback_answers table doesn't exist.`);
  const sql = tableSql!.sql.toLowerCase();
  assert(
    sql.includes('on delete cascade'),
    `campaign_feedback_answers does not have ON DELETE CASCADE. Deleting a response or question would leave orphan answer rows.`,
    { actualSql: tableSql!.sql },
  );
});

await run.test('email_templates partial unique indices enforce one-default + one-per-campaign', () => {
  const idx1 = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='uniq_default_template'",
  ).get() as { sql: string } | undefined;
  const idx2 = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='uniq_campaign_template'",
  ).get() as { sql: string } | undefined;
  assert(idx1 !== undefined, `uniq_default_template index missing.`);
  assert(idx2 !== undefined, `uniq_campaign_template index missing.`);
  assert(
    idx1!.sql.toLowerCase().includes('campaign_id is null'),
    `uniq_default_template index doesn't restrict to campaign_id IS NULL. Could allow duplicate defaults.`,
    { actualSql: idx1!.sql },
  );
  assert(
    idx2!.sql.toLowerCase().includes('campaign_id is not null'),
    `uniq_campaign_template index doesn't restrict to campaign_id IS NOT NULL. Could allow duplicate campaign-specific overrides.`,
    { actualSql: idx2!.sql },
  );
});

db.close();
closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(run.finish() ? 0 : 1);
