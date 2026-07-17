// Cookie-based session auth (P1 web hardening). The JWT is delivered to the browser as an httpOnly cookie
// so it is unreachable from JS (XSS can't exfiltrate it), paired with a readable double-submit CSRF token.
// Dependency-free (manual Set-Cookie / Cookie parsing) to avoid a new runtime dependency.
import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export const AUTH_COOKIE = 'ierp_token'; // httpOnly — the JWT (short-lived access token)
export const CSRF_COOKIE = 'ierp_csrf';  // readable — double-submit CSRF token (also the client's "session exists" flag)
export const REFRESH_COOKIE = 'ierp_refresh'; // httpOnly — opaque refresh token, scoped to /api/auth

// ── Signed CSRF token (SOX-ICFR #4) ────────────────────────────────────────────────────────────────────
// The double-submit CSRF token is now BOUND to the session by deriving it as HMAC(secret, jti) rather than a
// free random value, so a token minted for one session cannot authorize a mutation on another (defends
// against cross-session token reuse / CSRF-token fixation). It remains a valid double-submit token, so the
// client contract is unchanged (read the cookie, echo it in X-CSRF-Token). Secret falls back to JWT_SECRET
// (always present outside dev). Guard-side ENFORCEMENT of the binding is staged behind CSRF_SIGNED_ENFORCE
// (see guards.ts) so an in-flight session minted before the rollout is not forced to re-auth.
const CSRF_SECRET = () => process.env.CSRF_SECRET || process.env.JWT_SECRET || '';
export function signedCsrf(jti: string | undefined): string {
  const secret = CSRF_SECRET();
  if (!jti || !secret) return randomBytes(24).toString('hex'); // dev / no-jti fallback → random double-submit
  return createHmac('sha256', secret).update(`csrf:${jti}`).digest('hex').slice(0, 48);
}

// Best-effort decode of a JWT payload (base64url) WITHOUT verifying — used only to read our own freshly
// minted token's jti/role/kind to bind the CSRF cookie and choose the cookie SameSite. Never trust this for
// authorization (the guard verifies the signature); it only shapes cookies we are about to set.
function decodeJwtPayload(token: string): { jti?: string; role?: string; kind?: string } {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) ?? {};
  } catch { return {}; }
}

// External/portal-facing principals reach the app through top-level navigation (an email link, a QR page),
// which a SameSite=Strict cookie would strip → logged-out. They get SameSite=Lax; internal staff get Strict.
function isPortalAudience(p: { role?: string; kind?: string }): boolean {
  return p.kind === 'member' || p.role === 'Customer';
}

// Access-cookie lifetime — coherent with the ACCESS-TOKEN TTL by default (docs/27 R2-4 / AUD-SEC-05: the
// signed JWT always governs; a cookie that outlives it only confuses audits). Parses JWT_EXPIRES_IN
// ('1h' / '30m' / bare seconds); AUTH_COOKIE_MAX_AGE still overrides explicitly.
function jwtTtlSeconds(): number {
  const raw = (process.env.JWT_EXPIRES_IN ?? '1h').trim();
  const m = /^(\d+)([smhd]?)$/.exec(raw);
  if (!m) return 3600;
  const nVal = Number(m[1]);
  const mult = m[2] === 'd' ? 86400 : m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1;
  return nVal * mult;
}
const MAX_AGE = Number(process.env.AUTH_COOKIE_MAX_AGE ?? jwtTtlSeconds()); // seconds (default = access-token TTL; was a hardcoded 12h)
// Refresh-cookie lifetime — the long session window over which an access token can be silently renewed.
const REFRESH_MAX_AGE = Number(process.env.REFRESH_COOKIE_MAX_AGE ?? 604800); // seconds (default 7d)
// The refresh token is only ever sent to the auth endpoints (refresh + logout), not every request, to
// limit its exposure. Kept overridable for cross-origin deploys that must widen it.
const REFRESH_PATH = (process.env.REFRESH_COOKIE_PATH ?? '/api/auth').trim() || '/api/auth';
const isProd = () => process.env.NODE_ENV === 'production';

// Cross-origin deploys (web and API on different hosts) need the session cookie scoped so the browser can
// read the CSRF flag on the web origin and send the auth cookie to the API. Both are env-driven and
// default to the original single-origin behaviour (no Domain, SameSite=Lax) so existing deploys are
// unchanged.
//   AUTH_COOKIE_DOMAIN   — e.g. ".oshinei.co" makes the cookie shared by every *.oshinei.co subdomain
//                          (app.* + api.* are same-site under one registrable domain, so Lax still works).
//   AUTH_COOKIE_SAMESITE — "None" for web/API on *different registrable domains* (true cross-site);
//                          forces Secure (browsers drop SameSite=None without it). "Lax" (default) | "Strict".
// Read per-call (not memoised) so a deploy can change them without a code change — and so tests can flip
// them for a single request. Only ever evaluated on login/logout, so the cost is irrelevant.
const cookieDomain = (): string => (process.env.AUTH_COOKIE_DOMAIN ?? '').trim();
// Resolve SameSite (SOX-ICFR #4). An explicit AUTH_COOKIE_SAMESITE always wins (cross-origin deploys set
// 'None'; it also preserves any operator override). Otherwise the default is now per-audience: Strict for
// internal staff sessions (closes CSRF structurally for the internal app), Lax for portal/member sessions
// (external links must still carry the cookie on top-level navigation). `audience` unknown ⇒ Strict.
const cookieSameSite = (audience?: 'internal' | 'portal'): 'Lax' | 'None' | 'Strict' => {
  const raw = (process.env.AUTH_COOKIE_SAMESITE ?? '').trim().toLowerCase();
  if (raw === 'none') return 'None';
  if (raw === 'strict') return 'Strict';
  if (raw === 'lax') return 'Lax';
  return audience === 'portal' ? 'Lax' : 'Strict'; // no explicit env → per-audience default
};

// Parse a single cookie value out of the raw Cookie header.
export function readCookie(req: { headers?: Record<string, any> }, name: string): string | undefined {
  const raw = req.headers?.cookie;
  if (typeof raw !== 'string' || !raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function serialize(name: string, value: string, opts: { httpOnly?: boolean; maxAge?: number; path?: string; audience?: 'internal' | 'portal' }): string {
  const sameSite = cookieSameSite(opts.audience);
  const domain = cookieDomain();
  const p = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, `SameSite=${sameSite}`];
  if (domain) p.push(`Domain=${domain}`);
  if (opts.httpOnly) p.push('HttpOnly');
  // Secure in prod, and ALWAYS with SameSite=None (browsers reject a None cookie without Secure).
  if (isProd() || sameSite === 'None') p.push('Secure'); // browsers still send Secure cookies over http://localhost in dev
  if (opts.maxAge != null) p.push(`Max-Age=${opts.maxAge}`);
  return p.join('; ');
}

// Set the auth (httpOnly JWT) + CSRF (readable) cookies on login/refresh, plus the httpOnly refresh cookie
// when a refresh token is supplied (scoped to /api/auth so it isn't sent on every request). Returns the
// CSRF token minted. All cookies are written in ONE set-cookie array — a second reply.header('set-cookie')
// call would clobber the first.
export function setAuthCookies(reply: FastifyReply, token: string, refreshToken?: string): string {
  // Derive the session's jti (to sign the CSRF token) and audience (to choose SameSite) from the token we
  // are about to set — no controller plumbing needed. Portal/member sessions → Lax, internal → Strict.
  const p = decodeJwtPayload(token);
  const audience: 'internal' | 'portal' = isPortalAudience(p) ? 'portal' : 'internal';
  const csrf = signedCsrf(p.jti);
  const cookies = [
    serialize(AUTH_COOKIE, token, { httpOnly: true, maxAge: MAX_AGE, audience }),
    serialize(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: MAX_AGE, audience }),
  ];
  if (refreshToken) cookies.push(serialize(REFRESH_COOKIE, refreshToken, { httpOnly: true, maxAge: REFRESH_MAX_AGE, path: REFRESH_PATH, audience }));
  reply.header('set-cookie', cookies);
  return csrf;
}

// Expire all session cookies on logout (the refresh cookie must be cleared on its own Path to match).
export function clearAuthCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    serialize(AUTH_COOKIE, '', { httpOnly: true, maxAge: 0 }),
    serialize(CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 }),
    serialize(REFRESH_COOKIE, '', { httpOnly: true, maxAge: 0, path: REFRESH_PATH }),
  ]);
}
