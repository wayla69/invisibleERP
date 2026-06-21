// Per-ORDER public tracking token for online/delivery/kiosk channel orders. HMAC-SHA256 over
// tenant:order:nonce — an opaque capability bound to one order (not a table session). Mirrors
// qr-token.util but claim = { tenantId, orderId }. Tenant scope feeds RLS, never trusted for SQL directly.
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqualHex } from '../../common/crypto';

function tokenKey(): string {
  const raw = process.env.TABLE_TOKEN_SECRET || process.env.APP_ENC_KEY;
  if (!raw) {
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') throw new Error('TABLE_TOKEN_SECRET (or APP_ENC_KEY) required outside NODE_ENV=development|test.');
    return 'ierp-dev-table-token-key';
  }
  return raw;
}

export interface ChannelClaim { tenantId: number; orderId: number; }

export function mintChannelToken(c: ChannelClaim): string {
  const nonce = randomBytes(12).toString('hex');
  const payload = `${c.tenantId}:${c.orderId}:${nonce}`;
  const sig = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

export function verifyChannelToken(token: string): ChannelClaim | null {
  if (!token) return null;
  let blob: string;
  try { blob = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const idx = blob.lastIndexOf('|');
  if (idx < 0) return null;
  const payload = blob.slice(0, idx);
  const sig = blob.slice(idx + 1);
  const expected = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  if (!sig || sig.length !== expected.length || !safeEqualHex(sig, expected)) return null;
  const [t, o] = payload.split(':');
  const tenantId = Number(t), orderId = Number(o);
  if (![tenantId, orderId].every(Number.isInteger)) return null;
  return { tenantId, orderId };
}
