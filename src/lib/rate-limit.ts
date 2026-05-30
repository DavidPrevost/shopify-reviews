// Module-scoped in-memory rate limiter. Used by the campaign-application
// endpoint to slow drive-by abuse. Not a substitute for real traffic shaping
// at the GCP relay layer — this is the second line of defense.
//
// Semantics: take(key, limit, windowSec) returns true if the request fits in
// the rolling window, false if it exceeds. Each key tracks a count and a
// reset timestamp; on first miss after reset the counter starts at 1.

const buckets = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup so the map doesn't grow without bound. Runs every minute,
// drops any bucket whose reset has passed by more than 5 minutes (so even
// rarely-hit keys eventually evict).
const PRUNE_INTERVAL_MS = 60_000;
const PRUNE_STALENESS_SEC = 300;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

const startPruning = (): void => {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, b] of buckets.entries()) {
      if (b.resetAt + PRUNE_STALENESS_SEC < nowSec) buckets.delete(key);
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
};

export const take = (key: string, limit: number, windowSec: number): boolean => {
  startPruning();
  const nowSec = Math.floor(Date.now() / 1000);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= nowSec) {
    buckets.set(key, { count: 1, resetAt: nowSec + windowSec });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
};
