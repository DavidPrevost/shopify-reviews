import { shopifyAdmin } from './admin-client.js';

export interface ShopifyCustomerInfo {
  shopifyCustomerId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

const fetchQuery = `
  query ($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      lastName
    }
  }
`;

// Fetches a customer record from Shopify by their numeric ID. Used by the
// storefront-customer review flow when a logged-in customer submits but
// we don't yet have a local customers row (e.g., they signed up but never
// purchased — our DB only gets populated by orders/paid webhooks). Returns
// null if the customer no longer exists on Shopify.
export const fetchShopifyCustomer = async (
  shopifyCustomerId: string,
): Promise<ShopifyCustomerInfo | null> => {
  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  const data = await shopifyAdmin<{
    customer: { id: string; email: string | null; firstName: string | null; lastName: string | null } | null;
  }>(fetchQuery, { id: gid });

  if (!data.customer || !data.customer.email) return null;

  return {
    shopifyCustomerId,
    email: data.customer.email,
    firstName: data.customer.firstName,
    lastName: data.customer.lastName,
  };
};
