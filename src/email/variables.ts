// Flat, global variable namespace for email templates. One registry the editor
// shows for every template, with plain-language descriptions — rather than a
// distinct list per template. A template may reference any of these; on send,
// the renderer fills in whatever the triggering event provides and leaves the
// rest blank (renderString returns '' for an absent key). So names are global
// and unambiguous: `retractionReason`, not a context-specific `reason`.

export interface EmailVariable {
  key: string;
  label: string;
  description: string;
  // Whether the value expands to a block of HTML (vs. a simple inline string).
  // The editor calls these out so nobody expects a plain word from {{ productsHtml }}.
  expands?: boolean;
}

export const EMAIL_VARIABLES: EmailVariable[] = [
  { key: 'brandName', label: 'Brand name', description: 'Your store / brand name.' },
  { key: 'firstName', label: 'Customer first name', description: "The recipient's first name (falls back to “there” when unknown)." },
  { key: 'productName', label: 'Product name', description: 'For single-product emails, the product title. In multi-product review requests, the first product.' },
  { key: 'productCount', label: 'Product count', description: 'How many products are in a multi-product review request.' },
  {
    key: 'productsHtml',
    label: 'Product list with review buttons',
    description: 'Inserts a formatted block listing every product in the order, each with its own review button. You insert it once; it renders one card per product. Used in review-request emails.',
    expands: true,
  },
  { key: 'reviewUrl', label: 'Review link', description: 'A direct link for the recipient to write their review (used in single-product / transactional emails).' },
  { key: 'unsubscribeUrl', label: 'Unsubscribe link', description: 'One-click link to stop review-request emails.' },
  { key: 'retractionReason', label: 'Reason a review was removed', description: 'Customer-friendly reason text, used in the “Review removed” email.' },
  { key: 'logoUrl', label: 'Logo image URL', description: 'URL of your uploaded/synced logo — use it as the src of an <img> if you want the logo inside the body (it already appears in the header).' },
  { key: 'campaignName', label: 'Campaign name', description: 'The campaign\'s display name. Available in campaign-triggered emails.' },
  {
    key: 'reviewLinksHtml',
    label: 'Campaign review links',
    description: 'Inserts the participant\'s personalized review-link buttons (one per product in the campaign\'s sample pack). Used in the shipped-notification and review-reminder emails.',
    expands: true,
  },
  { key: 'discountCode', label: 'Discount code', description: 'The per-participant discount code issued for the campaign. Used in the launch-thanks email.' },
  {
    key: 'feedbackUrlsHtml',
    label: 'Campaign feedback links',
    description: 'Inserts the participant\'s links to the campaign\'s feedback forms. Used in the shipped-notification and review-reminder emails when feedback forms are configured.',
    expands: true,
  },
];

export const EMAIL_VARIABLE_KEYS = new Set(EMAIL_VARIABLES.map((v) => v.key));
