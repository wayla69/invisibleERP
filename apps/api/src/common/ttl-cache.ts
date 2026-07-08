// Tiny in-process TTL cache for short-lived read caching (e.g. the BI dashboard board, 30s TTL).
// Dependency-free and per-process BY DEFAULT: under cluster each worker keeps its own copy, which is fine
// for a short-TTL read cache. Setting CACHE_REDIS_URL upgrades wrap()/invalidation to read/write through a
// SHARED Redis store (common/cache-remote.ts) so 2+ API replicas serve one cache and a tenant bust reaches
// every node — unset (CI/PGlite/single-node) the behavior is byte-identical to the pure in-memory cache.
//
// Tenant isolation is the CALLER's responsibility: every key MUST include the tenant id so one tenant can
// never be served another tenant's cached aggregate.
import { defaultRemoteCacheStore, reportCacheDegraded, type RemoteCacheStore } from './cache-remote';

interface Entry { value: unknown; expiresAt: number }

export class TtlCache {
  private readonly store = new Map<string, Entry>();
  private readonly remote: RemoteCacheStore | null;

  // `remote` is injectable for tests (fake store); `undefined` = resolve from CACHE_REDIS_URL (null when
  // unset — the default-inert path); `null` = explicitly local-only.
  constructor(private readonly maxEntries = 1000, remote?: RemoteCacheStore | null) {
    this.remote = remote !== undefined ? remote : defaultRemoteCacheStore();
  }

  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) { this.store.delete(key); return undefined; }
    return e.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return; // caching disabled — never store
    // crude cap: drop the oldest insertion when full (Map preserves insertion order)
    if (this.store.size >= this.maxEntries) {
      const first = this.store.keys().next().value;
      if (first !== undefined) this.store.delete(first);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Compute-through helper: serve a fresh value on miss/expired/disabled, store it when caching is on.
  // Lookup order: local map → shared Redis (when configured; a hit seeds the local map so repeat reads on
  // this node stay in-process) → compute (stored to both). A Redis failure degrades to compute + a
  // throttled ops alert — the cache must never break the read it fronts.
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.get<T>(key);
      if (hit !== undefined) return hit;
      if (this.remote) {
        try {
          const raw = await this.remote.get(key);
          if (raw != null) {
            const value = JSON.parse(raw) as T;
            this.set(key, value, ttlMs);
            return value;
          }
        } catch (err) { reportCacheDegraded('get', key, err); }
      }
    }
    const value = await compute();
    this.set(key, value, ttlMs);
    if (this.remote && ttlMs > 0) {
      // fire-and-forget write-through: a slow/failed Redis write must not delay the response.
      try { void Promise.resolve(this.remote.set(key, JSON.stringify(value), ttlMs)).catch((err) => reportCacheDegraded('set', key, err)); }
      catch (err) { reportCacheDegraded('set', key, err); }
    }
    return value;
  }

  // Invalidate one key, or every key under a prefix (e.g. `bi:42:` to bust a tenant's cached boards).
  // With a shared store the bust is propagated so every node drops the entry (fire-and-forget + alert).
  delete(key: string): void {
    this.store.delete(key);
    if (this.remote) {
      try { void Promise.resolve(this.remote.del(key)).catch((err) => reportCacheDegraded('del', key, err)); }
      catch (err) { reportCacheDegraded('del', key, err); }
    }
  }
  deletePrefix(prefix: string): void {
    for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
    if (this.remote) {
      try { void Promise.resolve(this.remote.delPrefix(prefix)).catch((err) => reportCacheDegraded('delPrefix', prefix, err)); }
      catch (err) { reportCacheDegraded('delPrefix', prefix, err); }
    }
  }
  clear(): void { this.store.clear(); } // local-only (test helper) — shared entries expire by TTL
}
