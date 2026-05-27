-- Store the reviewer's original (uncensored) title/body alongside the censored
-- display copy. The existing `title`/`body` columns remain the *censored*
-- display text that the public storefront reads (so the customer-facing read
-- path stays trivial and can never accidentally leak profanity — it only ever
-- reads the pre-censored column). The new `_original` columns hold the raw text
-- and are read only by the admin (who needs to see what was actually written
-- to moderate) and by the wordlist re-scan.
--
-- Why store both rather than censor-on-read: censor-on-read would force every
-- read path (now and future) to remember to filter, and one that forgot would
-- leak raw profanity publicly. Storing a precomputed censored column keeps the
-- guarantee strong while still allowing re-censor (word added) and un-censor
-- (word removed) by re-deriving the display copy from the original.
--
-- Existing rows predate this and have NULL originals (their raw text was never
-- captured); the admin falls back to showing the censored text for those, and
-- they can't be un-censored. Acceptable: pre-launch test data is disposable.
ALTER TABLE reviews ADD COLUMN title_original TEXT;
ALTER TABLE reviews ADD COLUMN body_original TEXT;
