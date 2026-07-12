// G1 (docs/45, MKT-13): channel-link capability token — HMAC-SHA256 over `clink:tenant:nonce:platform:refHash`,
// an opaque capability to LINK one marketplace customer ref to the bearer's own member account (printed as a
// package-insert QR / sent post-order). NOT a JWT — same pattern as pos/receipt-token.util.ts: unguessable
// (96-bit nonce + secret), self-validating, and the tenant scope is fed into RLS, never trusted for SQL.
// Possession alone never links: the holder must ALSO authenticate as a member (OTP/LINE) and give explicit
// consent — the token only names WHICH external ref is being claimed.
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqualHex } from '../../common/crypto';

function tokenKey(): string {
  const raw = process.env.CHANNEL_LINK_TOKEN_SECRET || process.env.TABLE_TOKEN_SECRET || process.env.APP_ENC_KEY;
  if (!raw) {
    const env = process.env.NODE_ENV;
    if (env !== 'development' && env !== 'test') {
      throw new Error('CHANNEL_LINK_TOKEN_SECRET (or APP_ENC_KEY) required outside NODE_ENV=development|test.');
    }
    return 'ierp-dev-channel-link-token-key';
  }
  return raw;
}

export interface ChannelLinkClaim { tenantId: number; platform: string; refHash: string }

// The token is a SINGLE base64url blob (one clean URL path segment). Blob = `${payload}|${sig}`.
export function mintChannelLinkToken(c: ChannelLinkClaim): string {
  const nonce = randomBytes(12).toString('hex');
  const payload = `clink:${c.tenantId}:${nonce}:${c.platform}:${c.refHash}`;
  const sig = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`, 'utf8').toString('base64url');
}

export function verifyChannelLinkToken(token: string): ChannelLinkClaim | null {
  if (!token) return null;
  let blob: string;
  try { blob = Buffer.from(token, 'base64url').toString('utf8'); } catch { return null; }
  const idx = blob.lastIndexOf('|');
  if (idx < 0) return null;
  const payload = blob.slice(0, idx);
  const sig = blob.slice(idx + 1);
  const expected = createHmac('sha256', tokenKey()).update(payload).digest('hex');
  if (!sig || sig.length !== expected.length || !safeEqualHex(sig, expected)) return null;
  const [kind, t, _nonce, platform, ...rest] = payload.split(':');
  const tenantId = Number(t);
  const refHash = rest.join(':'); // sha256 hex never contains ':', but joining keeps parsing robust
  if (kind !== 'clink' || !Number.isInteger(tenantId) || !platform || !refHash) return null;
  return { tenantId, platform, refHash };
}
