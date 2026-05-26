-- The one-review-per-customer-per-product uniqueness rule should apply only
-- to active reviews, not retracted ones. A customer whose review was
-- retracted (status='rejected') with a reason gets a notification email
-- inviting them to submit again — they need to be able to do that without
-- crashing on the unique constraint. The historical retracted row stays in
-- place for the audit trail.
--
-- Effect: a customer may have at most one non-rejected review per product,
-- plus any number of rejected (retracted) reviews accumulated over time.

DROP INDEX IF EXISTS idx_reviews_customer_product;

CREATE UNIQUE INDEX idx_reviews_customer_product
  ON reviews(customer_id, shopify_product_id)
  WHERE customer_id IS NOT NULL AND status <> 'rejected';
