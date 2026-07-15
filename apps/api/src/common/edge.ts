// Edge hardening: security headers (helmet) + rate limiting on the underlying
// Fastify instance. Call from main.ts AFTER the Nest app is created but BEFORE
// app.listen().
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpException, HttpStatus } from '@nestjs/common';
import zlib from 'node:zlib';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import { rateLimitRedis } from './rate-limit-store';

// Routes exempt from rate limiting (liveness/readiness probes must always pass).
const ALLOW_LIST = new Set(['/health', '/healthz', '/health/ready', '/health/live']);

// Sensitive auth endpoints get their OWN, much stricter per-IP bucket — a credential/PIN/OTP flood from
// one source can no longer hide inside (or exhaust) the loose global 300/min budget, and normal API
// traffic can no longer exhaust the auth budget. This is per-IP defence-in-depth ON TOP of the existing
// per-ACCOUNT controls (ITGC-AC-07 login lockout in LoginAttemptStore; OTP attempt-binding) — it does not
// replace them. `request-otp` is stricter still because it triggers an outbound SMS (cost + abuse vector).
const AUTH_PATHS = new Set(['/api/login', '/api/login/pin', '/api/member/auth/verify-otp']);
const OTP_PATHS = new Set(['/api/member/auth/request-otp']);
// Anonymous public-write endpoints (no JWT) get their own strict per-IP bucket — an unauthenticated form
// spammer can neither exhaust the global budget nor hide inside it (CRM-2 web-to-lead; honeypot drops are
// handled in the controller, this is the volume backstop).
const PUBLIC_WRITE_PATHS = new Set(['/api/crm/web-to-lead']);

const pathOf = (req: { url?: string }) => (req.url ?? '').split('?')[0];
type Bucket = 'otp' | 'auth' | 'lead' | 'api';
const bucketOf = (p: string): Bucket =>
  OTP_PATHS.has(p) ? 'otp' : AUTH_PATHS.has(p) ? 'auth' : PUBLIC_WRITE_PATHS.has(p) ? 'lead' : 'api';
// Exported for the control-test harness (ToE): asserts the public web-to-lead path is on the strict bucket.
export const rateLimitBucketOf = (path: string): Bucket => bucketOf(path);

const GLOBAL_MAX = Number(process.env.RATE_LIMIT_MAX ?? 300);
const AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);   // login / pin / verify-otp, per IP per window
const OTP_MAX = Number(process.env.RATE_LIMIT_OTP_MAX ?? 10);     // request-otp (outbound SMS), per IP per window
const LEAD_MAX = Number(process.env.RATE_LIMIT_WEB_LEAD_MAX ?? 20); // public web-to-lead form, per IP per window

export async function registerEdge(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();

  // Response compression (gzip/brotli). This is a JSON API whose largest reads are unbounded, highly
  // repetitive text — GL account-ledger detail, master-data / audit CSV exports, consolidation run lines,
  // BI report generation, the sales cube — which compress by ~70-90%. Register FIRST so its onSend hook
  // wraps every downstream reply. Content-type gating is `mime-db`-driven (the plugin's default): it only
  // compresses `compressible: true` types (application/json, text/csv, text/plain, …) and skips the already-
  // zipped xlsx/pdf attachment downloads (compressible: false) and `text/event-stream` (SSE) — no per-route
  // allow-list needed. SSE also bypasses reply.send (Nest writes @Sse straight to reply.raw), so the hook
  // never touches those streams. Brotli quality is pinned to a moderate level: these are dynamic, per-request
  // compressions, and Node's brotli default (quality 11) is far too CPU-heavy for that — q4 keeps most of the
  // ratio at a fraction of the cost. Below `threshold` bytes the payload is sent uncompressed (the overhead
  // would exceed the saving). Opt out entirely with DISABLE_HTTP_COMPRESSION=1.
  if (process.env.DISABLE_HTTP_COMPRESSION !== '1') {
    const threshold = Math.max(0, Math.floor(Number(process.env.COMPRESSION_THRESHOLD ?? 1024)) || 0);
    const brotliQuality = Math.min(11, Math.max(0, Math.floor(Number(process.env.COMPRESSION_BROTLI_QUALITY ?? 4)) || 0));
    await fastify.register(compress, {
      global: true,
      threshold,
      // Prefer brotli when the client advertises it (better ratio than gzip), else gzip, else deflate.
      encodings: ['br', 'gzip', 'deflate'],
      brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality } },
      zlibOptions: { level: 6 }, // gzip/deflate sweet spot (Node default) — good ratio, low CPU.
    });
  }

  // Security headers. This is a JSON API that serves no HTML/scripts, so lock CSP all the way down
  // (the web app's own CSP — which governs script execution / XSS — lives in apps/web/next.config.mjs).
  await fastify.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] } },
  });

  // Shared counter store when a Redis URL is configured, so the per-IP limit holds across replicas
  // (security review L-8); unset ⇒ the plugin's default in-process store (unchanged single-node behaviour).
  const redis = rateLimitRedis();
  await fastify.register(rateLimit, {
    ...(redis ? { redis } : {}),
    // Per-request ceiling: stricter for auth/OTP, loose for the rest.
    max: (req: { url?: string }) => {
      const b = bucketOf(pathOf(req)!);
      return b === 'otp' ? OTP_MAX : b === 'auth' ? AUTH_MAX : b === 'lead' ? LEAD_MAX : GLOBAL_MAX;
    },
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
    // Segment the counter by bucket so each (IP, bucket) is isolated — auth attempts can't drain the
    // global budget and vice versa. Falls back to req.ip (the plugin's default key) within each bucket.
    keyGenerator: (req: { ip?: string; url?: string }) => `${req.ip ?? 'unknown'}:${bucketOf(pathOf(req)!)}`,
    allowList: (req: { url?: string }) => ALLOW_LIST.has(pathOf(req)!),
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
