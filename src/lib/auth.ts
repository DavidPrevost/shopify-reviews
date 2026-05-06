import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { signToken, verifyToken } from './hmac.js';
import { nowSec, daysToSec } from './time.js';

export const SESSION_COOKIE_NAME = 'reviews_admin_session';

interface SessionPayload {
  iat: number;
  exp: number;
}

export const verifyAdminPassword = async (password: string): Promise<boolean> => {
  if (!config.admin.passwordHash) return false;
  try {
    return await bcrypt.compare(password, config.admin.passwordHash);
  } catch {
    return false;
  }
};

export const signSessionCookie = (): string => {
  if (!config.admin.sessionSecret) {
    throw new Error('ADMIN_SESSION_SECRET is not configured');
  }
  const now = nowSec();
  const payload: SessionPayload = {
    iat: now,
    exp: now + daysToSec(config.admin.sessionTtlDays),
  };
  return signToken(config.admin.sessionSecret, payload);
};

export const verifySessionCookie = (cookieValue: string | undefined): boolean => {
  if (!cookieValue || !config.admin.sessionSecret) return false;
  const result = verifyToken<SessionPayload>(config.admin.sessionSecret, cookieValue);
  return result.ok;
};
