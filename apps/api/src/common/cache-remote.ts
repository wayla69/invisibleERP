// Optional shared (cross-node) cache store behind the in-process TtlCache — the "Redis cache adapter"
// the ops posture (`/api/ops/metrics` cache_provider) and cache.service.ts header promised. Follows the
// realtime-bus (docs/27 R1-3) blueprint exactly:
//
//   CACHE_REDIS_URL unset (default, CI/PGlite, single-node) → null: TtlCache stays pure in-memory,
//   behavior byte-identical to before this file existed.
//   CACHE_REDIS_URL set → TtlCache.wrap() reads/writes through this store so 2+ API replicas share one
//   cache (a board computed on node A serves node B) and a tenant bust on any node busts every node.
//
// Degrade-safely: ANY Redis failure falls back to the local compute path (a cache must never break the
// read it fronts) and fires a throttled ops alert — degraded, not silent. Values cross the wire as JSON,
// so a remote hit revives Dates as ISO strings; the TtlCache consumers (BI boards / finance metrics) only
// serve HTTP responses, which serialize identically either way.
//
// Kept OUT of ttl-cache.ts so the vitest coverage ratchet can measure the pure cache logic without the
// ioredis wiring (unreachable in CI — no Redis there) dragging its file coverage down.
import { captureOpsAlert } from '../observability/instrumentation';

export interface RemoteCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  delPrefix(prefix: string): Promise<unknown>;
  close?(): Promise<unknown>;
}

export const remoteCacheEnabled = (): boolean => !!(process.env.CACHE_REDIS_URL ?? '').trim();

// Lazily builds the shared ioredis store. Lazy so importing this file never touches the network and CI
// needs no Redis. One client is shared by every TtlCache instance (BI, finance metrics, ...).
let shared: RemoteCacheStore | null | undefined;
export function defaultRemoteCacheStore(): RemoteCacheStore | null {
  if (shared !== undefined) return shared;
  const url = (process.env.CACHE_REDIS_URL ?? '').trim();
  if (!url) { shared = null; return null; }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  shared = {
    get: (key) => client.get(key),
    // PX = per-key TTL in ms — Redis expires it exactly like the local Entry.expiresAt would.
    set: (key, value, ttlMs) => client.set(key, value, 'PX', Math.max(1, Math.round(ttlMs))),
    del: (key) => client.unlink(key),
    // Prefix bust (tenant cache invalidation): bounded SCAN so a huge keyspace can't block Redis.
    delPrefix: async (prefix) => {
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        cursor = next;
        if (keys.length) await client.unlink(...keys);
      } while (cursor !== '0');
    },
    close: async () => { try { await client.quit(); } catch { /* shutdown best-effort */ } },
  };
  return shared;
}

// Throttled degrade alert (mirrors realtime_redis_publish_failed / embed_provider_degraded): the first
// failure per minute is reported; the cache itself keeps serving from local compute.
let lastAlertAt = 0;
export function reportCacheDegraded(op: string, key: string, err: unknown): void {
  const now = Date.now();
  if (now - lastAlertAt < 60_000) return;
  lastAlertAt = now;
  captureOpsAlert('cache_redis_degraded', { op, key, degraded: 'served from local compute — shared cache skipped' }, err);
}
