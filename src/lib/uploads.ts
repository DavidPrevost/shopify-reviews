import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Self-hosted logo upload. Stored under the persistent /data volume so it
// survives container rebuilds. (Note: the nightly backup snapshots the SQLite
// DB, not this directory — extend backup.sh to rsync /data/uploads if logo
// durability across host loss matters.) Kept to PNG/JPG only: those are the
// formats email clients render reliably (Gmail
// strips SVG, Outlook desktop doesn't do WebP), and avoiding SVG also sidesteps
// the script-in-SVG XSS vector for a file we serve from our own origin.
//
// The 250 KB cap is the real egress control — the relay shares a 1 GB/month
// free tier across services, and a logo is fetched on every email open.

export const UPLOADS_DIR = path.join(config.dataDir, 'uploads');
export const MAX_LOGO_BYTES = 256 * 1024; // 250 KB

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export const saveLogo = async (
  file: File,
): Promise<{ ok: true; filename: string } | { ok: false; error: string }> => {
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) return { ok: false, error: 'Unsupported file type. Use a PNG or JPG.' };
  if (file.size === 0) return { ok: false, error: 'The file is empty.' };
  if (file.size > MAX_LOGO_BYTES) {
    return { ok: false, error: `File too large (${Math.round(file.size / 1024)} KB). Max is 250 KB — try compressing or resizing it.` };
  }
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  // Timestamp + random suffix gives a fresh URL each upload, so a replaced
  // logo busts any cached copy in email clients without manual cache control.
  const filename = `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return { ok: true, filename };
};

// Reads an uploaded file for serving. Rejects anything that isn't a plain
// filename in the uploads dir (no path traversal) with a known image ext.
// Returns an ArrayBuffer (what Hono's c.body accepts directly).
export const readUpload = (name: string): { body: ArrayBuffer; contentType: string } | null => {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) return null;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPE_BY_EXT[ext];
  if (!contentType) return null;
  const full = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(full)) return null;
  const buf = fs.readFileSync(full);
  const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return { body, contentType };
};
