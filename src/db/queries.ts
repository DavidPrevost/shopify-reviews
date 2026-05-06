import { getDb } from './client.js';

// --- Settings (key/value config in DB) ---

export const getSetting = (key: string): string | null => {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setSetting = (key: string, value: string): void => {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
};

export const getSettingNumber = (key: string, fallback: number): number => {
  const v = getSetting(key);
  return v === null ? fallback : Number(v);
};

// --- Customers ---

export interface CustomerRow {
  id: number;
  shopify_customer_id: string | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  global_opt_out: number;
  unanswered_request_count: number;
  last_request_sent_at: number | null;
  created_at: number;
}

export const upsertCustomer = (input: {
  shopifyCustomerId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
}): CustomerRow => {
  const now = Date.now();
  const db = getDb();

  db.prepare(`
    INSERT INTO customers (shopify_customer_id, email, first_name, last_name, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      shopify_customer_id = COALESCE(excluded.shopify_customer_id, customers.shopify_customer_id),
      first_name = COALESCE(excluded.first_name, customers.first_name),
      last_name = COALESCE(excluded.last_name, customers.last_name)
  `).run(
    input.shopifyCustomerId,
    input.email.toLowerCase(),
    input.firstName,
    input.lastName,
    now,
  );

  return db.prepare('SELECT * FROM customers WHERE email = ?').get(input.email.toLowerCase()) as CustomerRow;
};

export const findCustomerByEmail = (email: string): CustomerRow | null => {
  return (getDb()
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(email.toLowerCase()) as CustomerRow | undefined) ?? null;
};

// --- Purchases ---

export interface PurchaseRow {
  id: number;
  customer_id: number;
  shopify_order_id: string;
  shopify_product_id: string;
  fulfilled_at: number | null;
  due_at: number | null;
  request_count: number;
  last_request_at: number | null;
  reviewed_at: number | null;
  product_opt_out: number;
  created_at: number;
}

export const upsertPurchase = (input: {
  customerId: number;
  shopifyOrderId: string;
  shopifyProductId: string;
  fulfilledAt: number | null;
  dueAt: number | null;
}): void => {
  getDb().prepare(`
    INSERT INTO purchases
      (customer_id, shopify_order_id, shopify_product_id, fulfilled_at, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(shopify_order_id, shopify_product_id) DO UPDATE SET
      fulfilled_at = COALESCE(excluded.fulfilled_at, purchases.fulfilled_at),
      due_at = COALESCE(excluded.due_at, purchases.due_at)
  `).run(
    input.customerId,
    input.shopifyOrderId,
    input.shopifyProductId,
    input.fulfilledAt,
    input.dueAt,
    Date.now(),
  );
};

export const markPurchaseFulfilled = (input: {
  shopifyOrderId: string;
  shopifyProductId: string;
  fulfilledAt: number;
  dueAt: number;
}): void => {
  getDb().prepare(`
    UPDATE purchases
       SET fulfilled_at = ?, due_at = ?
     WHERE shopify_order_id = ? AND shopify_product_id = ?
  `).run(input.fulfilledAt, input.dueAt, input.shopifyOrderId, input.shopifyProductId);
};

// --- Email events ---

export const logEmailEvent = (input: {
  customerId: number | null;
  purchaseId: number | null;
  kind: string;
  metadata?: Record<string, unknown>;
}): void => {
  getDb().prepare(`
    INSERT INTO email_events (customer_id, purchase_id, kind, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.customerId,
    input.purchaseId,
    input.kind,
    input.metadata ? JSON.stringify(input.metadata) : null,
    Date.now(),
  );
};
