// "Pause reviews" emergency control.
//
// State model: a single timestamp setting `panic_paused_until` is the truth
// for "is the system paused right now?" — if it's set to a future unix
// timestamp, reviews are paused; if it's null, empty, or in the past, they
// aren't. Auto-expiration is free: no cron, no background job. The dashboard
// just notices when the clock passes the expiration.
//
// History lives in the panic_events table (queries below). Every pause /
// extend / resume action writes one row there; pauses that lapse silently
// (no manual resume) don't write a "lapsed" row — the absence of any later
// event AND a paused_until in the past is what "lapsed" looks like.

import { getDb } from '../db/client.js';
import { getSetting, setSetting } from '../db/queries.js';
import { nowSec } from './time.js';

const KEY_UNTIL = 'panic_paused_until';
const KEY_REASON = 'panic_paused_reason';
const KEY_PAUSED_AT = 'panic_paused_at';

export const PAUSE_DEFAULT_HOURS = 72;
export const PAUSE_MIN_HOURS = 1;
export const PAUSE_MAX_HOURS = 168; // one week ceiling

export interface PauseState {
  paused: boolean;
  pausedUntil: number | null;
  pausedAt: number | null;
  reason: string | null;
  secondsRemaining: number;
}

export const getPauseState = (): PauseState => {
  const untilRaw = getSetting(KEY_UNTIL);
  const until = untilRaw ? Number(untilRaw) : null;
  const now = nowSec();
  if (until === null || !Number.isFinite(until) || until <= now) {
    return {
      paused: false,
      pausedUntil: until,
      pausedAt: null,
      reason: null,
      secondsRemaining: 0,
    };
  }
  return {
    paused: true,
    pausedUntil: until,
    pausedAt: Number(getSetting(KEY_PAUSED_AT) ?? 0) || null,
    reason: getSetting(KEY_REASON),
    secondsRemaining: until - now,
  };
};

export const isReviewsPaused = (): boolean => getPauseState().paused;

interface RecordEventInput {
  eventType: 'pause' | 'extend' | 'resume';
  reason: string | null;
  actor: string;
  pausedUntil: number | null;
}

const recordPanicEvent = (input: RecordEventInput): void => {
  getDb().prepare(`
    INSERT INTO panic_events (event_type, reason, actor, paused_until, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.eventType, input.reason, input.actor, input.pausedUntil, nowSec());
};

export const pauseReviews = (input: {
  reason: string;
  actor: string;
  hours: number;
}): PauseState => {
  const hours = clampHours(input.hours);
  const now = nowSec();
  const until = now + hours * 3600;
  setSetting(KEY_UNTIL, String(until));
  setSetting(KEY_REASON, input.reason);
  setSetting(KEY_PAUSED_AT, String(now));
  recordPanicEvent({
    eventType: 'pause',
    reason: input.reason,
    actor: input.actor,
    pausedUntil: until,
  });
  return getPauseState();
};

export const extendPause = (input: {
  actor: string;
  hours: number;
}): PauseState => {
  const current = getPauseState();
  if (!current.paused) {
    // Defensive: extending a not-currently-paused state behaves like a fresh
    // pause with no reason. Caller should normally check first.
    return pauseReviews({ reason: 'Extended without active pause', actor: input.actor, hours: input.hours });
  }
  const hours = clampHours(input.hours);
  const until = nowSec() + hours * 3600;
  setSetting(KEY_UNTIL, String(until));
  recordPanicEvent({
    eventType: 'extend',
    reason: current.reason,
    actor: input.actor,
    pausedUntil: until,
  });
  return getPauseState();
};

export const resumeReviews = (input: { actor: string }): void => {
  setSetting(KEY_UNTIL, '');
  setSetting(KEY_REASON, '');
  setSetting(KEY_PAUSED_AT, '');
  recordPanicEvent({
    eventType: 'resume',
    reason: null,
    actor: input.actor,
    pausedUntil: null,
  });
};

const clampHours = (h: number): number => {
  if (!Number.isFinite(h)) return PAUSE_DEFAULT_HOURS;
  return Math.max(PAUSE_MIN_HOURS, Math.min(PAUSE_MAX_HOURS, Math.floor(h)));
};

export interface PanicEventRow {
  id: number;
  event_type: 'pause' | 'extend' | 'resume';
  reason: string | null;
  actor: string;
  paused_until: number | null;
  created_at: number;
}

export const listPanicEvents = (limit = 50): PanicEventRow[] => {
  return getDb()
    .prepare('SELECT * FROM panic_events ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as PanicEventRow[];
};
