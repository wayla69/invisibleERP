import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@ierp/shared'],
  // monorepo root (มี lockfile หลายไฟล์บนเครื่อง — ระบุชัดเพื่อเลิก warning)
  outputFileTracingRoot: join(__dirname, '..', '..'),
};

export default nextConfig;
