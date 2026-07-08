import { Injectable } from '@nestjs/common';
import { remoteCacheEnabled } from '../../common/cache-remote';

// E5 (Platform Phase 30) — cache interface. The DEFAULT is an in-memory TTL cache (single-node / CI). The
// Redis adapter now exists (common/cache-remote.ts, behind the read-through TtlCache): set CACHE_REDIS_URL
// to swap it in — the EmbedderService precedent (deterministic default, real provider by config).
// `provider` reports the ACTUAL posture (redis only when the adapter is live), so /api/ops/metrics can't
// claim a shared cache that isn't wired. Provisioning managed Redis is an infra/ops task.
@Injectable()
export class CacheService {
  private store = new Map<string, { v: unknown; exp: number }>();
  private hits = 0;
  private misses = 0;

  get provider() { return remoteCacheEnabled() ? 'redis' : 'memory'; }

  set(key: string, value: unknown, ttlSec = 60): void {
    this.store.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  }

  get<T = unknown>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) { this.misses++; return undefined; }
    if (Date.now() > e.exp) { this.store.delete(key); this.misses++; return undefined; }
    this.hits++;
    return e.v as T;
  }

  del(key: string): void { this.store.delete(key); }

  stats() { return { provider: this.provider, size: this.store.size, hits: this.hits, misses: this.misses }; }
}
