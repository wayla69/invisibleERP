import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// NB: the Content-Security-Policy is NOT set here — it needs a per-request nonce (security review M-1) and
// therefore lives in `src/middleware.ts`. A static header can't carry a nonce. The remaining headers are
// request-independent and stay here (they also apply to any path middleware's matcher skips).
const securityHeaders = [
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
  // The tsconfig alias points @ierp/shared at its TS SOURCE (so web never sees a stale dist), but that
  // source uses nodenext-style `./x.js` specifiers — map them back to `.ts` for webpack, exactly like tsc
  // does. Without this, the first real @ierp/shared import fails `Module not found: './entitlements.js'`.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.js', '.ts'], '.mjs': ['.mjs', '.mts'] };
    return config;
  },
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
