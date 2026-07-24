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

// ── Rotating table QR (SOX-ICFR #3) ────────────────────────────────────────────────────────────────────
// The printed static `diningTables.qrToken` is a PERMANENT unauthenticated capability: anyone who ever
// photographs a table card can open sessions / fire orders from anywhere, forever. A tenant with a per-table
// display (tablet / e-ink) can instead show a SHORT-TTL signed token `HMAC(tenant:table:window)` that a
// photographed code makes worthless within ~a minute. This is additive — static-placard tenants keep the
// stable token; the rotating path is offered alongside it.
const ROT_WINDOW_MS = Number(process.env.QR_ROTATING_WINDOW_MS ?? 30_000); // token validity granularity

export function mintRotatingTableToken(tenantId: number, tableId: number, now = Date.now()): string {
  const win = Math.floor(now / ROT_WINDOW_MS);
  const payload = `rot:${tenantId}:${tableId}:${win}`;
  const sig = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

/** Verify a rotating token: valid only for the current or immediately-previous window (≤ ~2×window old). */
export function verifyRotatingTableToken(token: string, now = Date.now()): { tenantId: number; tableId: number } | null {
  if (!token) return null;
  let blob: string;
  try { blob = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const idx = blob.lastIndexOf('|');
  if (idx < 0) return null;
  const payload = blob.slice(0, idx);
  const sig = blob.slice(idx + 1);
  const parts = payload.split(':');
  if (parts[0] !== 'rot' || parts.length !== 4) return null;
  const tenantId = Number(parts[1]), tableId = Number(parts[2]), win = Number(parts[3]);
  if (![tenantId, tableId, win].every(Number.isInteger)) return null;
  const cur = Math.floor(now / ROT_WINDOW_MS);
  if (win !== cur && win !== cur - 1) return null; // expired — outside the current/previous window
  const expected = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  if (!sig || sig.length !== expected.length || !safeEqualHex(sig, expected)) return null;
  return { tenantId, tableId };
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
