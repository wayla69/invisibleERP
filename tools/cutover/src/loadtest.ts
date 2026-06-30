/**
 * Capacity load test (operational maturity Tier 2). Boots the real Nest app and drives bounded concurrent
 * load at two endpoints — `/healthz` (framework baseline, no DB) and `/readyz` (one DB round-trip) —
 * reporting throughput + latency percentiles. REPORT-ONLY (not a CI gate): absolute numbers depend on the
 * backend (PGlite in CI vs real Postgres + PgBouncer in staging) and the runner, so it tracks RELATIVE
 * regression and gives a runnable procedure, not the prod ceiling. For a real capacity number, run against
 * staging: HARNESS_PG_URL=postgres://… (real PG) and point at a deployed instance.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover loadtest
 *   LOAD_N=5000 LOAD_C=100 … to tune total requests / concurrency.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'loadtest-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { harnessDb } from './harness-db';

const N = Number(process.env.LOAD_N ?? 2000);   // total requests per endpoint
const C = Number(process.env.LOAD_C ?? 50);     // concurrency

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function drive(app: NestFastifyApplication, url: string): Promise<void> {
  const lat: number[] = [];
  let done = 0, errors = 0;
  const t0 = Date.now();
  async function worker() {
    while (done < N) {
      done++;
      const s = Date.now();
      try {
        const r = await app.inject({ method: 'GET', url });
        if (r.statusCode >= 500) errors++;
      } catch { errors++; }
      lat.push(Date.now() - s);
    }
  }
  await Promise.all(Array.from({ length: C }, () => worker()));
  const wall = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const rps = Math.round(lat.length / wall);
  console.log(`  ${url.padEnd(10)}  n=${lat.length}  rps=${rps}  p50=${pct(lat, 50)}ms  p95=${pct(lat, 95)}ms  p99=${pct(lat, 99)}ms  max=${lat[lat.length - 1]}ms  errors=${errors}`);
}

async function main() {
  const { db: raw, kind, cleanup } = await harnessDb();
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(raw)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  console.log(`\n── load test (backend=${kind}, N=${N}/endpoint, C=${C}) ──`);
  await app.inject({ method: 'GET', url: '/healthz' }); // warm up
  await drive(app, '/healthz'); // framework baseline (no DB)
  await drive(app, '/readyz');  // one DB round-trip per request (pool pressure)
  console.log('  (report-only — run against staging with real Postgres + PgBouncer for a capacity number)\n');

  await app.close();
  await cleanup();
}
main().catch((e) => { console.error('loadtest crashed:', e); process.exit(1); });
