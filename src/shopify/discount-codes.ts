// Shopify Admin API helpers for per-participant campaign discount codes.
//
// We generate one code per campaign member at the "Generate discount codes"
// admin action. Each code is created with:
//   - usageLimit: 1            (single redemption per code)
//   - appliesOncePerCustomer:1 (defense in depth)
//   - percentage discount      (per the campaign's discount_percent setting)
//   - endsAt = startsAt + discount_expires_days
//
// Customer scoping (locking a code to one specific Shopify customer) is NOT
// applied in v1: a campaign applicant might not have a pre-existing Shopify
// customer record, and the cleanest fallback is "any customer can use, but
// only once." If a code leaks, the blast radius is exactly one redemption.
//
// Shopify's discount API does not natively support "percentage off with an
// absolute cap." A 40% code on a $1,000 order saves $400. Combined with
// usage-limit-1 and a short expiry, this is an acceptable risk per the
// design conversation; cap-via-Shopify-Functions is a v2 enhancement.

import { shopifyAdmin, ShopifyAdminError, type GraphQLUserError } from './admin-client.js';
import { log } from '../lib/logger.js';

export interface CreateDiscountInput {
  code: string;              // the code string the customer enters at checkout
  title: string;             // admin-facing label in Shopify's Discounts list
  percentageOff: number;     // 1-100, will be sent to Shopify as 0.01-1.00
  startsAtIso: string;       // ISO 8601 UTC; usually "right now"
  endsAtIso: string;         // ISO 8601 UTC
  // How many redemptions the code allows. Per-code (each campaign member gets
  // a UNIQUE code, so usageLimit is per-recipient). Defaults to 1 to preserve
  // historical behavior when callers don't pass it.
  usageLimit?: number;
}

export interface CreateDiscountResult {
  // Shopify GID for the discount code node. Used later by discountCodeDelete.
  discountId: string;
}

const CREATE_MUTATION = `
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode {
      id
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

interface CreateMutationResponse {
  discountCodeBasicCreate: {
    codeDiscountNode: { id: string } | null;
    userErrors: GraphQLUserError[];
  };
}

export const createCampaignDiscountCode = async (
  input: CreateDiscountInput,
): Promise<CreateDiscountResult> => {
  if (input.percentageOff < 1 || input.percentageOff > 100) {
    throw new Error(`createCampaignDiscountCode: percentageOff out of range: ${input.percentageOff}`);
  }
  // Shopify accepts the percentage as a fractional value (0.40 = 40%).
  const fraction = input.percentageOff / 100;

  const usageLimit = input.usageLimit ?? 1;
  if (usageLimit < 1) {
    throw new Error(`createCampaignDiscountCode: usageLimit must be >= 1, got ${usageLimit}`);
  }

  const data = await shopifyAdmin<CreateMutationResponse>(CREATE_MUTATION, {
    basicCodeDiscount: {
      title: input.title,
      code: input.code,
      startsAt: input.startsAtIso,
      endsAt: input.endsAtIso,
      usageLimit,
      // appliesOncePerCustomer: when usageLimit > 1, we want the same customer
      // to be able to redeem the code repeatedly (the whole point of raising
      // the limit). When usageLimit = 1, we keep this on as defense-in-depth.
      appliesOncePerCustomer: usageLimit === 1,
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: fraction },
        items: { all: true },
      },
    },
  });

  const result = data.discountCodeBasicCreate;
  if (result.userErrors.length > 0) {
    const msg = result.userErrors.map((e) => `${(e.field ?? []).join('.')}: ${e.message}`).join('; ');
    throw new ShopifyAdminError(`discountCodeBasicCreate user errors: ${msg}`);
  }
  if (!result.codeDiscountNode?.id) {
    throw new ShopifyAdminError('discountCodeBasicCreate returned no node id');
  }
  return { discountId: result.codeDiscountNode.id };
};

const DELETE_MUTATION = `
mutation discountCodeDelete($id: ID!) {
  discountCodeDelete(id: $id) {
    deletedCodeDiscountId
    userErrors {
      field
      message
      code
    }
  }
}`;

interface DeleteMutationResponse {
  discountCodeDelete: {
    deletedCodeDiscountId: string | null;
    userErrors: GraphQLUserError[];
  };
}

// Used by Step 7's cleanup action. Returns true on success, false if Shopify
// reported the discount no longer exists (treated as already-deleted, which
// is what we want — idempotent cleanup).
export const deleteCampaignDiscountCode = async (discountId: string): Promise<boolean> => {
  try {
    const data = await shopifyAdmin<DeleteMutationResponse>(DELETE_MUTATION, { id: discountId });
    const result = data.discountCodeDelete;
    if (result.userErrors.length > 0) {
      // "Discount code not found" type errors are fine — treat as already gone.
      const notFound = result.userErrors.some((e) =>
        /not found|does not exist/i.test(e.message),
      );
      if (notFound) return true;
      log('warn', 'discountCodeDelete user errors', { discountId, errors: result.userErrors });
      return false;
    }
    return result.deletedCodeDiscountId !== null;
  } catch (err) {
    log('warn', 'discountCodeDelete failed', {
      discountId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};
