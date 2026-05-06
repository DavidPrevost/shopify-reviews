import crypto from 'node:crypto';

export const hmacSha256 = (secret: string, message: string | Buffer): Buffer => {
  return crypto.createHmac('sha256', secret).update(message).digest();
};

export const hmacSha256Base64 = (secret: string, message: string | Buffer): string => {
  return hmacSha256(secret, message).toString('base64');
};

export const hmacSha256Hex = (secret: string, message: string | Buffer): string => {
  return hmacSha256(secret, message).toString('hex');
};

export const constantTimeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

const base64UrlEncode = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64UrlDecode = (s: string): Buffer => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
};

export const signToken = (secret: string, payload: object): string => {
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64UrlEncode(hmacSha256(secret, body));
  return `${body}.${sig}`;
};

export type VerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export const verifyToken = <T extends { exp?: number }>(
  secret: string,
  token: string,
): VerifyResult<T> => {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sig] = parts as [string, string];

  const expected = base64UrlEncode(hmacSha256(secret, body));
  if (!constantTimeEqual(expected, sig)) return { ok: false, reason: 'bad_signature' };

  let payload: T;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
};
