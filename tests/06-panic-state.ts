// Panic-button state machine: pause / extend / resume / auto-lapse.
//
// The pause state lives in three settings keys + a panic_events audit table.
// We exercise all four transitions and verify both the state representation
// and the audit trail. Auto-lapse is silent (no resume event) — that's a
// deliberate design choice; verify it.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TestRun, assert, assertEqual } from './_harness.js';

const tmpDir = path.join(os.tmpdir(), `reviews-panic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR = tmpDir;
process.env.EMAIL_TOKEN_SECRET = '0'.repeat(64);
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.SHOPIFY_SHOP_DOMAIN = 'test.myshopify.com';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test';

const { migrate, closeDb, getDb } = await import('../src/db/client.js');
const { getPauseState, pauseReviews, extendPause, resumeReviews, listPanicEvents, PAUSE_MIN_HOURS, PAUSE_MAX_HOURS, PAUSE_DEFAULT_HOURS, isReviewsPaused } = await import('../src/lib/panic.js');
const { setSetting } = await import('../src/db/queries.js');

migrate();

const run = new TestRun('06-panic-state');

await run.test('Fresh state: not paused, no events', () => {
  const state = getPauseState();
  assertEqual(state.paused, false, 'Fresh state should not be paused');
  assertEqual(state.pausedUntil, null, 'pausedUntil should be null');
  assertEqual(isReviewsPaused(), false, 'isReviewsPaused() helper returns false');
  const events = listPanicEvents(50);
  assertEqual(events.length, 0, `Expected zero panic_events on fresh DB, got ${events.length}`);
});

await run.test('pauseReviews → paused, audit row written', () => {
  const state = pauseReviews({ reason: 'Test pause', actor: 'test-suite', hours: 24 });
  assertEqual(state.paused, true, 'State should be paused');
  assertEqual(state.reason, 'Test pause', 'Reason preserved');
  assert(state.pausedUntil !== null && state.pausedUntil > Math.floor(Date.now() / 1000), 'pausedUntil should be in the future');
  assertEqual(isReviewsPaused(), true, 'isReviewsPaused() returns true while paused');

  const events = listPanicEvents(50);
  assertEqual(events.length, 1, `Expected 1 panic_events row after pause, got ${events.length}`);
  assertEqual(events[0]!.event_type, 'pause', 'Event type should be "pause"');
  assertEqual(events[0]!.reason, 'Test pause', 'Event reason preserved');
  assertEqual(events[0]!.actor, 'test-suite', 'Event actor preserved');
});

await run.test('extendPause extends pausedUntil and writes second audit row', () => {
  const before = getPauseState();
  // Wait a moment to ensure the new until is measurably later (we extend by
  // hours so this isn't strictly necessary, but documents intent).
  const state = extendPause({ actor: 'test-suite', hours: 48 });
  assertEqual(state.paused, true, 'Still paused after extend');
  assert(state.pausedUntil! > before.pausedUntil!, 'pausedUntil should advance after extend');

  const events = listPanicEvents(50);
  assertEqual(events.length, 2, `Expected 2 events after extend, got ${events.length}`);
  // Events are ordered DESC, so most recent first.
  assertEqual(events[0]!.event_type, 'extend', 'Most recent event is "extend"');
  assertEqual(events[0]!.reason, 'Test pause', 'Extend event carries forward original reason');
});

await run.test('resumeReviews clears state and writes resume audit row', () => {
  const state = resumeReviews({ actor: 'test-suite' });
  // resumeReviews returns void; verify via getPauseState.
  const after = getPauseState();
  assertEqual(after.paused, false, 'Should not be paused after resume');
  assertEqual(after.pausedUntil, null, 'pausedUntil cleared');
  assertEqual(after.reason, null, 'reason cleared');

  const events = listPanicEvents(50);
  assertEqual(events.length, 3, `Expected 3 events after resume, got ${events.length}`);
  assertEqual(events[0]!.event_type, 'resume', 'Most recent event is "resume"');
});

await run.test('pauseReviews with hours > MAX clamps to MAX', () => {
  const state = pauseReviews({ reason: 'Clamp test high', actor: 'test', hours: PAUSE_MAX_HOURS + 100 });
  const elapsedHours = (state.pausedUntil! - Math.floor(Date.now() / 1000)) / 3600;
  assert(
    elapsedHours <= PAUSE_MAX_HOURS + 0.1,
    `Hours should be clamped to ≤ ${PAUSE_MAX_HOURS}; got ${elapsedHours}`,
    { requested: PAUSE_MAX_HOURS + 100, clampedToHours: elapsedHours },
  );
  resumeReviews({ actor: 'cleanup' });
});

await run.test('pauseReviews with hours < MIN clamps to MIN', () => {
  const state = pauseReviews({ reason: 'Clamp test low', actor: 'test', hours: 0 });
  const elapsedHours = (state.pausedUntil! - Math.floor(Date.now() / 1000)) / 3600;
  assert(
    elapsedHours >= PAUSE_MIN_HOURS - 0.1,
    `Hours should be clamped to ≥ ${PAUSE_MIN_HOURS}; got ${elapsedHours}`,
    { requested: 0, clampedToHours: elapsedHours },
  );
  resumeReviews({ actor: 'cleanup' });
});

await run.test('pauseReviews with NaN hours uses default', () => {
  const state = pauseReviews({ reason: 'NaN test', actor: 'test', hours: NaN });
  const elapsedHours = (state.pausedUntil! - Math.floor(Date.now() / 1000)) / 3600;
  assert(
    Math.abs(elapsedHours - PAUSE_DEFAULT_HOURS) < 0.1,
    `NaN hours should fall back to PAUSE_DEFAULT_HOURS (${PAUSE_DEFAULT_HOURS}); got ${elapsedHours}`,
    { requested: 'NaN', resultedInHours: elapsedHours },
  );
  resumeReviews({ actor: 'cleanup' });
});

await run.test('Auto-lapse: panic_paused_until in the past → paused=false, NO resume event', () => {
  // Manually set state to "paused but expired" — what happens when nobody clicks
  // resume before the timer runs out.
  setSetting('panic_paused_until', String(Math.floor(Date.now() / 1000) - 60));
  setSetting('panic_paused_reason', 'Expired test');
  setSetting('panic_paused_at', String(Math.floor(Date.now() / 1000) - 7200));

  const beforeEventCount = listPanicEvents(50).length;
  const state = getPauseState();
  assertEqual(state.paused, false, 'Expired pause should report not-paused');
  assertEqual(state.secondsRemaining, 0, 'No remaining time');

  // The critical guarantee: no resume event is written by the lapse itself.
  const afterEventCount = listPanicEvents(50).length;
  assertEqual(
    afterEventCount, beforeEventCount,
    'Auto-lapse must NOT create a panic_events row. Lapse is silent by design.',
    { beforeEventCount, afterEventCount },
  );

  // Clean up
  setSetting('panic_paused_until', '');
  setSetting('panic_paused_reason', '');
  setSetting('panic_paused_at', '');
});

await run.test('extendPause on a NOT-paused state behaves like a fresh pause', () => {
  // Defensive fallback: panic.ts extends with "Extended without active pause"
  // reason if there's no active pause. Confirm it works without throwing.
  const state = extendPause({ actor: 'test', hours: 2 });
  assertEqual(state.paused, true, 'Extend with no active pause should create one');
  assertEqual(state.reason, 'Extended without active pause', 'Reason should be the defensive fallback');
  resumeReviews({ actor: 'cleanup' });
});

closeDb();
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(run.finish() ? 0 : 1);
