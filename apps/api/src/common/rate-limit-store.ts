// Shared rate-limit backend (security review L-8). The edge @fastify/rate-limit and the public-API per-key
// limiter both kept PER-PROCESS counters, so under horizontal scaling (N replicas) a client effectively got
// N× the intended budget and a flood could hide by spreading across nodes. When RATE_LIMIT_REDIS_URL (or the
// existing REALTIME_REDIS_URL) is set, counters live in Redis so limits hold ACROSS replicas; unset ⇒ the
// per-process in-memory path (unchanged default, CI/single-node/PGlite need no Redis).
//
//   • edge limiter  → rateLimitRedis()  (passed to @fastify/rate-limit's native `redis` option)
//   • public-API    → hitRateLimit()    (a small fixed-window INCR/PEXPIRE, else the in-memory Map)

let redisClient: any;

// Lazily builds a single shared ioredis connection. Lazy so importing this file never touches the network.
export function rateLimitRedis(): any | null {
  if (redisClient !== undefined) return redisClient;
  const url = (process.env.RATE_LIMIT_REDIS_URL ?? process.env.REALTIME_REDIS_URL ?? '').trim();
  if (!url) { redisClient = null; return null; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Redis = require('ioredis');
    redisClient = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
  } catch { redisClient = null; }
  return redisClient;
}

const mem = new Map<string, { windowStart: number; count: number }>();

// Count one hit against a fixed window. Shared via Redis when configured, else per-process. On any Redis
// error it degrades to the in-memory path (still enforces per-process) rather than failing the request open.
export async function hitRateLimit(key: string, max: number, windowMs: number, now: number): Promise<{ limited: boolean; retryAfter: number }> {
  const r = rateLimitRedis();
  if (r) {
    try {
      const bucket = Math.floor(now / windowMs);
      const rk = `rl:pub:${key}:${bucket}`;
      const count = Number(await r.incr(rk));
      if (count === 1) await r.pexpire(rk, windowMs);
      const resetAt = (bucket + 1) * windowMs;
      return { limited: count > max, retryAfter: Math.ceil((resetAt - now) / 1000) };
    } catch { /* Redis unavailable → degrade to in-memory below */ }
  }
  const b = mem.get(key);
  if (!b || now - b.windowStart >= windowMs) { mem.set(key, { windowStart: now, count: 1 }); return { limited: false, retryAfter: 0 }; }
  b.count += 1;
  return { limited: b.count > max, retryAfter: Math.ceil((b.windowStart + windowMs - now) / 1000) };
}
