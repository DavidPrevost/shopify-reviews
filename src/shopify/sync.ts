import { shopifyAdmin } from './admin-client.js';
import { gidToNumeric } from './types.js';
import {
  upsertCustomer,
  upsertPurchase,
  markOrderFulfilled,
  getSettingNumber,
} from '../db/queries.js';
import { migrate } from '../db/client.js';
import { log } from '../lib/logger.js';
import { daysToSec } from '../lib/time.js';

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFulfillmentStatus: string;
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      quantity: number;
      product: { id: string } | null;
      variant: { id: string } | null;
    }>;
  };
  fulfillments: Array<{ id: string; status: string; createdAt: string }>;
}

const ordersQuery = `
  query backfillOrders($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        displayFulfillmentStatus
        customer { id email firstName lastName }
        lineItems(first: 50) {
          nodes { id title quantity product { id } variant { id } }
        }
        fulfillments(first: 10) { id status createdAt }
      }
    }
  }
`;

export interface BackfillResult {
  ordersScanned: number;
  customersUpserted: number;
  purchasesUpserted: number;
  ordersMarkedFulfilled: number;
}

const isoToSec = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

export const backfillRecentOrders = async (daysBack = 90): Promise<BackfillResult> => {
  migrate();

  const sinceDate = new Date(Date.now() - daysBack * 86_400_000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD
  const queryFilter = `created_at:>=${sinceDate} financial_status:paid`;

  const result: BackfillResult = {
    ordersScanned: 0,
    customersUpserted: 0,
    purchasesUpserted: 0,
    ordersMarkedFulfilled: 0,
  };

  const requestDelaySec = daysToSec(getSettingNumber('request_delay_days', 7));
  // Go-live guard: orders fulfilled before this cutoff are imported for
  // reference but never armed (due_at stays NULL), so backfilling a live store
  // with historical orders can't trigger a flood of requests to pre-existing
  // customers. 0 = disabled (dev default). See development-plan.md §10.
  const requestCutoffAt = getSettingNumber('request_cutoff_at', 0);

  interface OrdersResponse {
    orders: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: OrderNode[];
    };
  }

  let cursor: string | null = null;
  do {
    const data: OrdersResponse = await shopifyAdmin<OrdersResponse>(ordersQuery, {
      cursor,
      query: queryFilter,
    });

    for (const order of data.orders.nodes) {
      result.ordersScanned += 1;
      const orderId = gidToNumeric(order.id);
      const email = order.customer?.email ?? null;
      if (!email) continue;

      const customer = upsertCustomer({
        shopifyCustomerId: order.customer?.id ? gidToNumeric(order.customer.id) : null,
        email,
        firstName: order.customer?.firstName ?? null,
        lastName: order.customer?.lastName ?? null,
      });
      result.customersUpserted += 1;

      for (const line of order.lineItems.nodes) {
        if (!line.product?.id) continue;
        upsertPurchase({
          customerId: customer.id,
          shopifyOrderId: orderId,
          shopifyProductId: gidToNumeric(line.product.id),
          shopifyVariantId: line.variant?.id ? gidToNumeric(line.variant.id) : null,
          fulfilledAt: null,
          dueAt: null,
        });
        result.purchasesUpserted += 1;
      }

      if (order.displayFulfillmentStatus === 'FULFILLED') {
        const lastFulfillment = order.fulfillments
          .map((f) => isoToSec(f.createdAt))
          .sort((a, b) => b - a)[0];
        if (lastFulfillment) {
          const armed = lastFulfillment >= requestCutoffAt;
          markOrderFulfilled({
            shopifyOrderId: orderId,
            fulfilledAt: lastFulfillment,
            dueAt: armed ? lastFulfillment + requestDelaySec : null,
          });
          result.ordersMarkedFulfilled += 1;
        }
      }
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);

  log('info', 'backfill complete', { ...result, daysBack });
  return result;
};
