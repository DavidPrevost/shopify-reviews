// Minimal shapes of the Shopify Admin API entities we read.
// Not exhaustive — extend as new fields are needed.

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyCustomer {
  id: string;            // gid://shopify/Customer/123
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface ShopifyProduct {
  id: string;            // gid://shopify/Product/123
  handle: string;
  title: string;
  featuredImage: { url: string } | null;
}

export interface ShopifyLineItem {
  id: string;            // gid://shopify/LineItem/123
  title: string;
  quantity: number;
  product: { id: string } | null;
}

export interface ShopifyFulfillment {
  id: string;
  status: string;
  createdAt: string;     // ISO 8601
}

export interface ShopifyOrder {
  id: string;            // gid://shopify/Order/123
  name: string;          // e.g. "#1001"
  createdAt: string;
  customer: ShopifyCustomer | null;
  lineItems: { nodes: ShopifyLineItem[] };
  fulfillments: ShopifyFulfillment[];
  displayFulfillmentStatus: string;  // 'FULFILLED' | 'UNFULFILLED' | 'PARTIALLY_FULFILLED' | ...
}

// Numeric ID helpers — Shopify GIDs are like "gid://shopify/Order/12345"
// We store the numeric portion as TEXT in the database.

export const gidToNumeric = (gid: string): string => {
  const parts = gid.split('/');
  return parts[parts.length - 1] ?? gid;
};
