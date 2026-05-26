-- Email templates gain a trigger_event: the event that causes the template to
-- be sent. This replaces the old hardcoded "request_first vs request_repeat"
-- key-matching in the dispatcher with a trigger-based selection, and lets the
-- merchant create their own templates bound to a curated list of triggers.
--
-- template_key stays as the stable internal id (and the URL slug for editing);
-- trigger_event is the new functional selector. The dispatcher and the
-- moderation flows look up "the active template for trigger X".
--
-- Backfill the existing seeded rows so deployed dev/prod stacks keep working
-- without a reseed. New triggers (review_request_followup) seed on next boot.
ALTER TABLE email_templates ADD COLUMN trigger_event TEXT;

UPDATE email_templates SET trigger_event = 'review_request'        WHERE template_key = 'request_first';
UPDATE email_templates SET trigger_event = 'repeat_customer_review' WHERE template_key = 'request_repeat';
UPDATE email_templates SET trigger_event = 'review_removed'        WHERE template_key = 'review_retracted';
UPDATE email_templates SET trigger_event = 'review_restored'       WHERE template_key = 'review_restored';

-- The retract context variable was renamed reasonPhrase -> retractionReason for
-- the flat global namespace. Fix the already-seeded body so the placeholder
-- still resolves on installs that seeded before this change.
UPDATE email_templates
   SET body_html = REPLACE(body_html, '{{ reasonPhrase }}', '{{ retractionReason }}')
 WHERE template_key = 'review_retracted';
