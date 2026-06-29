// Tiny in-process TTL cache for short-lived read caching (e.g. the BI dashboard board, 30s TTL).
// Dependency-free and per-process: under cluster each worker keeps its own copy, which is fine for a
// short-TTL read cache (a Redis-backed shared cache is the multi-node upgrade path, but Redis is not
// available in the test/CI harness env, so the in-process cache keeps the feature fully exercised in CI).
//
// Tenant isolation is the CALLER's responsibility: every key MUST include the tenant id so one tenant can
// never be served another tenant's cached aggregate.
interface Entry { value: unknown; expiresAt: number }

export class TtlCache {
  private readonly store = new Map<string, Entry>();
  constructor(private readonly maxEntries = 1000) {}

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
  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.get<T>(key);
      if (hit !== undefined) return hit;
    }
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  // Invalidate one key, or every key under a prefix (e.g. `bi:42:` to bust a tenant's cached boards).
  delete(key: string): void { this.store.delete(key); }
  deletePrefix(prefix: string): void {
    for (const k of this.store.keys()) if (k.startsWith(prefix)) this.store.delete(k);
  }
  clear(): void { this.store.clear(); }
}
