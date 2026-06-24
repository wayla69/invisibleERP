import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal HS256 JWT verify for OIDC id_tokens signed with the client_secret (a spec-valid
// confidential-client option) — lets SSO work and be fully tested without an external JWKS/network
// call. RS256 (asymmetric) verification against the issuer JWKS is a documented follow-on.

const b64uDecode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const b64u = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface IdTokenClaims { iss?: string; aud?: string | string[]; sub?: string; email?: string; exp?: number; [k: string]: unknown }

// Verify an HS256 JWT against `secret`. Returns the claims, or throws with a stable reason string.
export function verifyHs256(token: string, secret: string): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('MALFORMED');
  const [h, p, sig] = parts;
  const header = JSON.parse(b64uDecode(h));
  if (header.alg !== 'HS256') throw new Error('UNSUPPORTED_ALG');
  const expected = b64u(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('BAD_SIGNATURE');
  return JSON.parse(b64uDecode(p)) as IdTokenClaims;
}

// Sign helper (used by the test harness to mint an id_token; also handy for a future internal IdP).
export function signHs256(claims: IdTokenClaims, secret: string): string {
  const header = b64u(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  const sig = b64u(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}
