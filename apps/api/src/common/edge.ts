// Edge hardening: security headers (helmet) + rate limiting on the underlying
// Fastify instance. Call from main.ts AFTER the Nest app is created but BEFORE
// app.listen().
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// Routes exempt from rate limiting (liveness/readiness probes must always pass).
const ALLOW_LIST = new Set(['/health', '/healthz', '/health/ready', '/health/live']);

export async function registerEdge(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  // Security headers. CSP off by default — this is a JSON API, not HTML.
  await fastify.register(helmet, { global: true, contentSecurityPolicy: false });

  await fastify.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    allowList: (req: { url?: string }) => {
      const path = (req.url ?? '').split('?')[0];
      return ALLOW_LIST.has(path);
    },
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Too many requests, retry in ${Math.ceil(context.ttl / 1000)}s`,
        messageTh: 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง',
      },
    }),
  });
}
