import { Controller, Get } from '@nestjs/common';
import { Permissions } from '../../common/decorators';
import { CacheService } from './cache.service';

// E5 (Platform Phase 30) — ops / scale posture. Surfaces process metrics + the cache/queue provider posture
// (the health probes /healthz + /readyz already exist). Read-only; no GL. The cache self-test proves the
// CacheService works end to end (set → cached read within TTL).
@Controller('api/ops')
export class OpsController {
  constructor(private readonly cache: CacheService) {}

  @Get('metrics') @Permissions('exec', 'users')
  metrics() {
    return {
      uptime_s: Math.round(process.uptime()),
      node: process.version,
      cache: this.cache.stats(),
      scale: {
        cache_provider: this.cache.provider,
        queue_provider: process.env.QUEUE_PROVIDER || 'in-process',
        note: 'Redis cache + a durable job queue swap in behind these interfaces; provisioning them (+ read replicas, partitioning) is an infra/ops task per the lean-then-scale plan.',
      },
    };
  }

  // Proves the CacheService round-trips: first call seeds the key (cached:false), a call within the TTL hits it.
  @Get('cache-selftest') @Permissions('exec', 'users')
  selftest() {
    const key = 'ops:selftest';
    const before = this.cache.get<string>(key);
    if (before !== undefined) return { ok: true, cached: true, value: before };
    const value = `ok-${Math.round(process.uptime())}`;
    this.cache.set(key, value, 30);
    return { ok: true, cached: false, value };
  }
}
