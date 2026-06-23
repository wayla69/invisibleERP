import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ierp/shared'],
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
