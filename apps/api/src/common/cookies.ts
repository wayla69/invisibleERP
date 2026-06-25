// Cookie-based session auth (P1 web hardening). The JWT is delivered to the browser as an httpOnly cookie
// so it is unreachable from JS (XSS can't exfiltrate it), paired with a readable double-submit CSRF token.
// Dependency-free (manual Set-Cookie / Cookie parsing) to avoid a new runtime dependency.
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';

export const AUTH_COOKIE = 'ierp_token'; // httpOnly — the JWT
export const CSRF_COOKIE = 'ierp_csrf';  // readable — double-submit CSRF token (also the client's "session exists" flag)

const MAX_AGE = Number(process.env.AUTH_COOKIE_MAX_AGE ?? 43200); // seconds (default 12h)
const isProd = () => process.env.NODE_ENV === 'production';

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

function serialize(name: string, value: string, opts: { httpOnly?: boolean; maxAge?: number }): string {
  const p = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (opts.httpOnly) p.push('HttpOnly');
  if (isProd()) p.push('Secure'); // browsers still send Secure cookies over http://localhost in dev
  if (opts.maxAge != null) p.push(`Max-Age=${opts.maxAge}`);
  return p.join('; ');
}

// Set the auth (httpOnly JWT) + CSRF (readable) cookies on login/refresh. Returns the CSRF token minted.
export function setAuthCookies(reply: FastifyReply, token: string): string {
  const csrf = randomBytes(24).toString('hex');
  reply.header('set-cookie', [
    serialize(AUTH_COOKIE, token, { httpOnly: true, maxAge: MAX_AGE }),
    serialize(CSRF_COOKIE, csrf, { httpOnly: false, maxAge: MAX_AGE }),
  ]);
  return csrf;
}

// Expire both cookies on logout.
export function clearAuthCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    serialize(AUTH_COOKIE, '', { httpOnly: true, maxAge: 0 }),
    serialize(CSRF_COOKIE, '', { httpOnly: false, maxAge: 0 }),
  ]);
}
