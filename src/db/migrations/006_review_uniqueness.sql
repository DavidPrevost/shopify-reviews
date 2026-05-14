-- Enforce "one review per customer per product" at the DB layer in addition
-- to the route-handler check. Email-link, sample-invitation, and storefront-
-- customer flows all hit this constraint. Partial index (WHERE customer_id IS
-- NOT NULL) skips edge cases where customer_id might be unset; SQLite treats
-- NULLs as distinct anyway so multiple null-customer rows would be allowed.
CREATE UNIQUE INDEX idx_reviews_customer_product
  ON reviews(customer_id, shopify_product_id)
  WHERE customer_id IS NOT NULL;
