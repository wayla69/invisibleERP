// Public e-receipt token (POS-2): HMAC-SHA256 over `rcpt:tenant:nonce:saleNo` — an opaque capability to
// VIEW one rendered receipt without login (the "ดูใบเสร็จ" link in a LINE e-receipt push). NOT a JWT —
// same pattern as restaurant/qr-token.util.ts: unguessable (96-bit nonce + secret), self-validating
// (recompute HMAC), and the tenant scope is fed into RLS (RealtimeScope.run), never trusted for SQL.
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqualHex } from '../../common/crypto';

function tokenKey(): string {
  const raw = process.env.RECEIPT_TOKEN_SECRET || process.env.TABLE_TOKEN_SECRET || process.env.APP_ENC_KEY;
  if (!raw) {
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new Error('RECEIPT_TOKEN_SECRET (or APP_ENC_KEY) required outside NODE_ENV=development|test.');
    }
    return 'ierp-dev-receipt-token-key';
  }
  return raw;
}

export interface ReceiptClaim { tenantId: number; saleNo: string }

// The token is a SINGLE base64url blob (one clean URL path segment). Blob = `${payload}|${sig}`.
export function mintReceiptToken(c: ReceiptClaim): string {
  const nonce = randomBytes(12).toString('hex');
  const payload = `rcpt:${c.tenantId}:${nonce}:${c.saleNo}`;
  const sig = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

export function verifyReceiptToken(token: string): ReceiptClaim | null {
  if (!token) return null;
  let blob: string;
  try { blob = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const idx = blob.lastIndexOf('|');
  if (idx < 0) return null;
  const payload = blob.slice(0, idx);
  const sig = blob.slice(idx + 1);
  const expected = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  if (!sig || sig.length !== expected.length || !safeEqualHex(sig, expected)) return null;
  const [kind, t, _nonce, ...rest] = payload.split(':');
  const tenantId = Number(t);
  const saleNo = rest.join(':'); // sale numbers never contain ':', but joining keeps parsing robust
  if (kind !== 'rcpt' || !Number.isInteger(tenantId) || !saleNo) return null;
  return { tenantId, saleNo };
}
