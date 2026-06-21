// Public diner table-session token: HMAC-SHA256 over tenant:table:session:nonce. NOT a JWT — it is an
// opaque capability bound to one table_session. Tenant scope is fed into RLS (set_config app.tenant_id),
// never trusted directly for SQL. Unguessable (96-bit nonce + secret); self-validating (recompute HMAC).
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqualHex } from '../../common/crypto';

function tokenKey(): string {
  const raw = process.env.TABLE_TOKEN_SECRET || process.env.APP_ENC_KEY;
  if (!raw) {
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new Error('TABLE_TOKEN_SECRET (or APP_ENC_KEY) required outside NODE_ENV=development|test.');
    }
    return 'ierp-dev-table-token-key';
  }
  return raw;
}

export interface TableClaim { tenantId: number; tableId: number; sessionId: number; }

// The token is a SINGLE base64url blob (no '.'/'/' separators) so it is one clean URL path segment
// the router can't mis-parse. Blob = `${payload}|${sig}`.
export function mintTableToken(c: TableClaim): string {
  const nonce = randomBytes(12).toString('hex');
  const payload = `${c.tenantId}:${c.tableId}:${c.sessionId}:${nonce}`;
  const sig = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

export function verifyTableToken(token: string): TableClaim | null {
  if (!token) return null;
  let blob: string;
  try { blob = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const idx = blob.lastIndexOf('|');
  if (idx < 0) return null;
  const payload = blob.slice(0, idx);
  const sig = blob.slice(idx + 1);
  const expected = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  if (!sig || sig.length !== expected.length || !safeEqualHex(sig, expected)) return null;
  const [t, tbl, sess] = payload.split(':');
  const tenantId = Number(t), tableId = Number(tbl), sessionId = Number(sess);
  if (![tenantId, tableId, sessionId].every(Number.isInteger)) return null;
  return { tenantId, tableId, sessionId };
}
