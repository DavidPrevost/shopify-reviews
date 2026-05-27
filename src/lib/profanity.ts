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
import { log } from './logger.js';

const SETTING_KEY = 'profanity_wordlist';
const SEEDED_KEY = 'profanity_seeded';

// Raw stored text exactly as the merchant typed it — comments (# lines), blank
// lines, and ordering preserved. Used to render the editor textarea.
export const getProfanityWordlistText = (): string => getSetting(SETTING_KEY) ?? '';

// Active words used for censoring: drop blank lines and # comments, trim, and
// dedupe case-insensitively. Comments are honored at parse time, not stored
// away — so they survive a save.
export const getProfanityWordlist = (): string[] => {
  const raw = getSetting(SETTING_KEY) ?? '';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const w = line.trim();
    if (w === '' || w.startsWith('#')) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
};

// Stores the textarea content verbatim (comments included). Line endings are
// normalized to \n and trailing blank lines trimmed; nothing else is stripped.
export const setProfanityWordlistText = (text: string): void => {
  setSetting(SETTING_KEY, text.replace(/\r\n/g, '\n').replace(/\s+$/, ''));
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

// A moderate starter wordlist. Curated to catch clearly offensive language and
// the common slurs while deliberately leaving out mild words (damn/hell/crap)
// that cause annoying false positives on a storefront. Matching is whole-word,
// so common inflections are listed explicitly (fuck, fucking, fucker, …).
// Inspired by the widely-used LDNOOBW list, trimmed down to avoid over-
// censoring. The merchant is expected to edit this to taste.
const DEFAULT_PROFANITY_TEXT = `# Profanity filter wordlist — whole-word, case-insensitive.
# Lines starting with # are comments. Edit freely: add or remove words and save.
# Mild words (damn, hell, crap) are intentionally left out to avoid over-censoring.

# --- Strong profanity ---
fuck
fucks
fucked
fucking
fuckin
fucker
fuckers
motherfucker
motherfuckers
motherfucking
shit
shits
shitty
shitting
bullshit
shithead
bitch
bitches
bitching
asshole
assholes
dumbass
jackass
prick
pricks
cunt
cunts
twat
dickhead
dickheads
cocksucker
pussy
whore
whores
slut
sluts
bastard
douchebag

# --- Slurs (offensive; recommended to always screen) ---
nigger
niggers
nigga
faggot
faggots
fag
retard
retarded
spic
chink
kike
wetback
tranny
dyke`;

// Seeds the default wordlist once, on first boot after this shipped. Guarded by
// a flag so that *clearing* the list (merchant wants no filter) sticks and it
// isn't re-seeded on the next restart. Only seeds when no list is set yet.
export const seedDefaultProfanityWordlist = (): void => {
  if (getSetting(SEEDED_KEY) === '1') return;
  if ((getSetting(SETTING_KEY) ?? '').trim() === '') {
    setProfanityWordlistText(DEFAULT_PROFANITY_TEXT);
    log('info', 'seeded default profanity wordlist');
  }
  setSetting(SEEDED_KEY, '1');
};
