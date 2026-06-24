import { Injectable } from '@nestjs/common';

// E5 (Platform Phase 30) — cache interface. The DEFAULT is an in-memory TTL cache (single-node / CI). Set
// CACHE_PROVIDER=redis to swap a Redis adapter behind this SAME interface — the EmbedderService precedent
// (deterministic default, real provider by config). Provisioning managed Redis + read replicas is an
// infra/ops task (lean-then-scale, Bangkok/Alibaba) — out of scope for the app layer.
@Injectable()
export class CacheService {
  private store = new Map<string, { v: unknown; exp: number }>();
  private hits = 0;
  private misses = 0;

  get provider() { return process.env.CACHE_PROVIDER || 'memory'; }

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
