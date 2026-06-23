import { HttpException, HttpStatus } from '@nestjs/common';

// Best-effort in-memory sliding-window limiter for the PUBLIC (token-keyed) diner endpoints. The QR
// session token is unauthenticated, so a valid token could otherwise spam the kitchen / payment flow.
// Per-process (no external infra) — it throttles abusive bursts on an instance; pair with an edge/CDN
// limit for cross-instance guarantees.
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    throw new HttpException(
      { code: 'RATE_LIMITED', message: 'Too many requests; please slow down', messageTh: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  recent.push(now);
  buckets.set(key, recent);
  // opportunistic prune so the map can't grow unbounded across many sessions
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
}
