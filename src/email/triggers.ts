// Curated list of events a merchant can bind an email template to. The
// dispatcher and moderation flows select "the active template for trigger X"
// rather than matching hardcoded template keys, so merchants can create their
// own templates and choose when they fire.
//
// `wired: true` means the system actually sends on this trigger today. A few
// forward-looking triggers are listed with `wired: false` so a merchant can
// author the template now; they start sending when that path ships. The admin
// UI labels the unwired ones clearly so nobody expects a silent send.

export interface EmailTrigger {
  event: string;
  label: string;
  description: string;
  wired: boolean;
}

export const EMAIL_TRIGGERS: EmailTrigger[] = [
  {
    event: 'review_request',
    label: 'Review request (first time)',
    description: 'Sent after an order is fulfilled and the request delay passes, to a customer being asked for the first time.',
    wired: true,
  },
  {
    event: 'review_request_followup',
    label: 'Review request follow-up',
    description: "A later reminder to a customer who was asked but hasn't reviewed yet (their 2nd or 3rd request, within your cadence cap).",
    wired: true,
  },
  {
    event: 'repeat_customer_review',
    label: 'Repeat customer request',
    description: 'Sent instead of the first-time template when the customer has reviewed you before.',
    wired: true,
  },
  {
    event: 'review_removed',
    label: 'Review removed (retracted)',
    description: 'Sent to a reviewer when you retract their review, if you choose to notify them.',
    wired: true,
  },
  {
    event: 'review_restored',
    label: 'Review restored',
    description: 'Sent when a previously removed review is put back, if you choose to notify the reviewer.',
    wired: true,
  },
  {
    event: 'review_submitted_thankyou',
    label: 'Thank-you after a review',
    description: 'A thank-you sent when a customer submits a review. Not sent automatically yet — author it now and it activates when this trigger ships.',
    wired: false,
  },
  {
    event: 'campaign_application_confirmation',
    label: 'Campaign — application received',
    description: 'Sent automatically when someone applies to a campaign. Confirms receipt and reiterates the terms they accepted.',
    wired: true,
  },
  {
    event: 'campaign_shipped_notification',
    label: 'Campaign — samples shipped',
    description: 'Admin-triggered batch sent after sample packs are mailed. Per-recipient: includes their review links for each product in the sample pack.',
    wired: true,
  },
  {
    event: 'campaign_review_reminder',
    label: 'Campaign — review reminder',
    description: 'Admin-triggered batch sent 2-3 weeks after shipping. Generic copy plus review links — if a recipient has already reviewed, the email thanks them.',
    wired: true,
  },
  {
    event: 'campaign_launch_thanks',
    label: 'Campaign — launch thanks',
    description: 'Admin-triggered batch with the brand-launch announcement and the per-participant discount code.',
    wired: true,
  },
];

export const isEmailTrigger = (s: unknown): s is string =>
  typeof s === 'string' && EMAIL_TRIGGERS.some((t) => t.event === s);

export const triggerLabel = (event: string | null): string =>
  EMAIL_TRIGGERS.find((t) => t.event === event)?.label ?? event ?? '(no trigger)';
