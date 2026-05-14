import { config } from '../config.js';
import { signToken, verifyToken, type VerifyResult } from '../lib/hmac.js';
import { nowSec, daysToSec } from '../lib/time.js';

export interface ReviewTokenPayload {
  purchaseId: number;
  customerId: number;
  exp: number;
}

export interface UnsubscribeTokenPayload {
  customerId: number;
  kind: 'global' | 'product';
  purchaseId?: number;
  exp?: number;
}

export interface SampleInviteTokenPayload {
  invitationId: number;
  productId: string;
  exp: number;
}

const REVIEW_TOKEN_TTL_DAYS = 60;
export const SAMPLE_INVITE_TTL_DAYS = 90;

export const signReviewToken = (input: { purchaseId: number; customerId: number }): string => {
  if (!config.email.tokenSecret) {
    throw new Error('EMAIL_TOKEN_SECRET is not configured');
  }
  return signToken(config.email.tokenSecret, {
    purchaseId: input.purchaseId,
    customerId: input.customerId,
    exp: nowSec() + daysToSec(REVIEW_TOKEN_TTL_DAYS),
  });
};

export const verifyReviewToken = (token: string): VerifyResult<ReviewTokenPayload> => {
  return verifyToken<ReviewTokenPayload>(config.email.tokenSecret, token);
};

export const signUnsubscribeToken = (input: UnsubscribeTokenPayload): string => {
  if (!config.email.tokenSecret) {
    throw new Error('EMAIL_TOKEN_SECRET is not configured');
  }
  // Unsubscribe tokens never expire — once a customer clicks, the action is
  // applied immediately. No exp set so an old email link still works.
  return signToken(config.email.tokenSecret, { ...input });
};

export const verifyUnsubscribeToken = (token: string): VerifyResult<UnsubscribeTokenPayload> => {
  return verifyToken<UnsubscribeTokenPayload>(config.email.tokenSecret, token);
};

export const signSampleInviteToken = (input: {
  invitationId: number;
  productId: string;
  // Token exp. Pass the invitation row's `expires_at` so re-signing (e.g.,
  // during a CSV re-export) doesn't accidentally extend the invitation's
  // effective lifetime beyond what was recorded at creation time. Defaults
  // to nowSec()+90d for callers that don't have access to the row.
  exp?: number;
}): string => {
  if (!config.email.tokenSecret) {
    throw new Error('EMAIL_TOKEN_SECRET is not configured');
  }
  const exp = input.exp ?? nowSec() + daysToSec(SAMPLE_INVITE_TTL_DAYS);
  return signToken(config.email.tokenSecret, {
    invitationId: input.invitationId,
    productId: input.productId,
    exp,
  });
};

export const verifySampleInviteToken = (token: string): VerifyResult<SampleInviteTokenPayload> => {
  return verifyToken<SampleInviteTokenPayload>(config.email.tokenSecret, token);
};
