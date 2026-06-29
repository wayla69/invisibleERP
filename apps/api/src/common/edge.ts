// Edge hardening: security headers (helmet) + rate limiting on the underlying
// Fastify instance. Call from main.ts AFTER the Nest app is created but BEFORE
// app.listen().
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpException, HttpStatus } from '@nestjs/common';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// Routes exempt from rate limiting (liveness/readiness probes must always pass).
const ALLOW_LIST = new Set(['/health', '/healthz', '/health/ready', '/health/live']);

// Sensitive auth endpoints get their OWN, much stricter per-IP bucket — a credential/PIN/OTP flood from
// one source can no longer hide inside (or exhaust) the loose global 300/min budget, and normal API
// traffic can no longer exhaust the auth budget. This is per-IP defence-in-depth ON TOP of the existing
// per-ACCOUNT controls (ITGC-AC-07 login lockout in LoginAttemptStore; OTP attempt-binding) — it does not
// replace them. `request-otp` is stricter still because it triggers an outbound SMS (cost + abuse vector).
const AUTH_PATHS = new Set(['/api/login', '/api/login/pin', '/api/member/auth/verify-otp']);
const OTP_PATHS = new Set(['/api/member/auth/request-otp']);

const pathOf = (req: { url?: string }) => (req.url ?? '').split('?')[0];
type Bucket = 'otp' | 'auth' | 'api';
const bucketOf = (p: string): Bucket => (OTP_PATHS.has(p) ? 'otp' : AUTH_PATHS.has(p) ? 'auth' : 'api');

const GLOBAL_MAX = Number(process.env.RATE_LIMIT_MAX ?? 300);
const AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);   // login / pin / verify-otp, per IP per window
const OTP_MAX = Number(process.env.RATE_LIMIT_OTP_MAX ?? 10);     // request-otp (outbound SMS), per IP per window

export async function registerEdge(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  // Security headers. This is a JSON API that serves no HTML/scripts, so lock CSP all the way down
  // (the web app's own CSP — which governs script execution / XSS — lives in apps/web/next.config.mjs).
  await fastify.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
  });

  await fastify.register(rateLimit, {
    // Per-request ceiling: stricter for auth/OTP, loose for the rest.
    max: (req: { url?: string }) => {
      const b = bucketOf(pathOf(req));
      return b === 'otp' ? OTP_MAX : b === 'auth' ? AUTH_MAX : GLOBAL_MAX;
    },
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    // Segment the counter by bucket so each (IP, bucket) is isolated — auth attempts can't drain the
    // global budget and vice versa. Falls back to req.ip (the plugin's default key) within each bucket.
    keyGenerator: (req: { ip?: string; url?: string }) => `${req.ip ?? 'unknown'}:${bucketOf(pathOf(req))}`,
    allowList: (req: { url?: string }) => ALLOW_LIST.has(pathOf(req)),
    // The plugin THROWS this builder's return value (index.js: `throw errorResponseBuilder(...)`), and the
    // throw is caught by the global AllExceptionsFilter. A plain object falls through to the filter's
    // generic 500 branch (the old body did exactly that — silently 500 instead of 429 on exceed, never
    // noticed because no test had exercised the edge limiter). Return a Nest HttpException so the filter's
    // `instanceof HttpException` branch emits a proper 429 with the app's `{ error: { code, ... } }` shape.
    errorResponseBuilder: (_req, context) =>
      new HttpException(
        {
          code: 'RATE_LIMITED',
          message: `Too many requests, retry in ${Math.ceil(context.ttl / 1000)}s`,
          messageTh: 'คำขอมากเกินไป กรุณาลองใหม่ภายหลัง',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
  });
}
