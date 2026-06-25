import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== 'production';
// The browser calls the API either same-origin (proxy mode, NEXT_PUBLIC_API_URL='') or at its own origin.
// connect-src must allow both. Derive just the origin from the configured API URL.
let apiOrigin = '';
try { apiOrigin = process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : ''; } catch { /* ignore */ }

// Content-Security-Policy for the web app — the layer that contains XSS (script/connect/frame). The auth
// token now lives in an httpOnly cookie (unreadable by JS), so even if a script were injected it can't
// exfiltrate the session. 'unsafe-inline' on script is a pragmatic concession to Next's inline bootstrap
// (nonce-based hardening is a tracked follow-up); 'unsafe-eval' is dev-only (HMR/react-refresh).
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  `connect-src 'self'${apiOrigin ? ' ' + apiOrigin : ''}${isDev ? ' ws: wss:' : ''}`,
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ierp/shared'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // monorepo root (มี lockfile หลายไฟล์บนเครื่อง — ระบุชัดเพื่อเลิก warning)
  outputFileTracingRoot: join(__dirname, '..', '..'),
  // Optional single-port dev/preview proxy. When API_PROXY_TARGET is set (e.g. a cloud port-preview that
  // exposes only :3000), Next forwards /api/* same-origin to the API so one port serves both. Pair with
  // NEXT_PUBLIC_API_URL='' so the browser calls /api/* on this host. Unset in prod ⇒ no-op (web & API
  // stay on their own origins). This must NOT default-on, or prod would proxy to a non-existent localhost.
  async rewrites() {
    const api = process.env.API_PROXY_TARGET;
    if (!api) return [];
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
