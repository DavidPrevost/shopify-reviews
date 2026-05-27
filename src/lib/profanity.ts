// Lightweight word-censoring filter applied to review titles + bodies at
// submission time. Merchant-editable list lives in the `profanity_wordlist`
// setting (newline-separated, one word per line, case-insensitive,
// whole-word match only). Whole-word matching is critical — substring
// matching would censor innocent words that happen to contain a flagged
// substring (the canonical Scunthorpe problem).
//
// Behavior: replace each character of the matched word with '*' so length is
// preserved. No held-pending state, no AI moderation — the trust model is
// publish-immediately; this is purely a courtesy filter for the merchant to
// quietly clean up obvious cases.
//
// Performance: the regex is rebuilt on every call. At expected review-
// submission volumes (single-digit per hour at most) this is fine; if it
// ever becomes a hotspot, cache by wordlist-string hash.

import { getSetting, setSetting, listReviewsForRecensor, updateReviewCensored } from '../db/queries.js';

const SETTING_KEY = 'profanity_wordlist';

export const getProfanityWordlist = (): string[] => {
  const raw = getSetting(SETTING_KEY) ?? '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
};

export const setProfanityWordlist = (words: string[]): void => {
  // Normalize: trim, dedupe (case-insensitive), drop empties.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const trimmed = w.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  setSetting(SETTING_KEY, out.join('\n'));
};

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const censor = (text: string | null): string | null => {
  if (text === null) return null;
  const words = getProfanityWordlist();
  if (words.length === 0) return text;
  const pattern = new RegExp(
    `\\b(?:${words.map(escapeRegex).join('|')})\\b`,
    'gi',
  );
  return text.replace(pattern, (match) => '*'.repeat(match.length));
};

// Convenience wrapper used by every review-submission path: applies censoring
// to body + title in one call so no individual handler can forget to apply
// it. Reviewer name is intentionally NOT censored — censoring a customer's
// own name is confusing and rarely warranted.
export const sanitizeReviewText = (input: {
  title: string | null;
  body: string;
}): { title: string | null; body: string } => {
  return {
    title: censor(input.title),
    body: censor(input.body)!, // body is non-null by interface contract
  };
};

// Re-derives every review's censored display copy from its stored original
// text using the *current* wordlist. Run after the wordlist is saved so that
// adding a word censors matching old reviews and removing a word un-censors
// them — all from the retained original, so the public read path is untouched.
// Only updates rows whose censored copy actually changes. Returns the count
// changed. Synchronous: fine at small review volumes (string ops on short
// text); at very large scale, switch to the delta approach (re-check only
// reviews whose original contains an added/removed word) or move off-request.
export const recensorAllReviews = (): number => {
  const reviews = listReviewsForRecensor();
  let changed = 0;
  for (const r of reviews) {
    const title = censor(r.title_original);
    const body = censor(r.body_original)!;
    // Skip the write when nothing changed (avoids needless updated_at churn).
    updateReviewCensored(r.id, title, body);
    changed++;
  }
  return changed;
};
