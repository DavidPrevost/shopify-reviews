// All persisted timestamps are unix seconds (matches SQLite's unixepoch()).
// Use these helpers so the convention stays consistent across the codebase.

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const daysToSec = (days: number): number => days * 86400;
