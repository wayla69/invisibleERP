/**
 * Load smoke (workstream: post-decomposition performance baseline) — boots the REAL compiled API
 * in-process on PGlite (same recipe as e2e.ts) and measures request latency (p50/p95) + throughput on a
 * fixed scenario set: hot reads (stock list, trial balance, procurement catalog) and the GL write path
 * (postEntry with a unique idempotency ref per request).
 *
 * This is a RELATIVE regression harness, not an absolute benchmark: PGlite-in-process numbers say nothing
 * about prod Postgres/network, but on the same machine they move when the CODE gets slower — which is the
 * question after a refactor. Baseline pinned in tools/cutover/load-baseline.json:
 *   UPDATE_LOADBASE=1 pnpm --filter @ierp/cutover load     ← re-pin (commit the diff + why)
 *   pnpm --filter @ierp/cutover load                        ← compare (fails only on a ≥2.5× p95 regression)
 * Deliberately NOT a CI matrix gate: shared-runner latency variance would flake a timing gate. Run it
 * locally before/after perf-sensitive changes and on release candidates (see docs/ops runbook note).
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'load-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as s from '../../../apps/api/dist/database/schema/index';
import { ymd } from '../../../apps/api/dist/database/queries';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const BASELINE_PATH = resolve(process.cwd(), 'load-baseline.json');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;

// Modest but non-trivial world: enough rows that list endpoints do real work.
async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  const now = new Date();
  for (let i = 0; i < 200; i++) {
    const id = `LOAD-${String(i).padStart(4, '0')}`;
    await db.insert(s.items).values({ itemId: id, itemDescription: `Load item ${i} สินค้าโหลดเทสต์`, uom: 'EA', unitPrice: String(10 + (i % 90)) }).onConflictDoNothing();
    await db.insert(s.stockSnapshots).values({ generateDate: now, itemId: id, itemDescription: `Load item ${i}`, uom: 'EA', avQty: String(i % 50), totalStock: String(i % 50) });
  }
}

type Stat = { p50: number; p95: number; max: number; rps: number; errors: number };
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function runScenario(name: string, n: number, conc: number, fire: (i: number) => Promise<number>): Promise<Stat> {
  const durations: number[] = [];
  let errors = 0;
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (true) {
      const i = next++;
      if (i >= n) return;
      const t = performance.now();
      const status = await fire(i);
      durations.push(performance.now() - t);
      if (status >= 400) errors++;
    }
  }));
  const wall = (performance.now() - t0) / 1000;
  const stat = { p50: +pct(durations, 50).toFixed(1), p95: +pct(durations, 95).toFixed(1), max: +Math.max(...durations).toFixed(1), rps: +(n / wall).toFixed(1), errors };
  console.log(`  ${name.padEnd(34)} p50 ${String(stat.p50).padStart(7)}ms  p95 ${String(stat.p95).padStart(7)}ms  ${String(stat.rps).padStart(7)} req/s  errors ${errors}`);
  return stat;
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) =>
    app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });

  const login = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  const token = login.json().token as string;
  if (!token) { console.error('❌ load-smoke: login failed'); process.exit(1); }

  // Warm-up (JIT, connection setup, first-query planning) — excluded from measurement.
  for (let i = 0; i < 20; i++) await inj('GET', '/api/inventory/stock?limit=50', token);

  console.log('load-smoke — in-process PGlite, relative baseline (not an absolute benchmark)');
  const results: Record<string, Stat> = {};
  results['read:inventory-stock'] = await runScenario('GET /api/inventory/stock', 300, 10, async (i) =>
    (await inj('GET', `/api/inventory/stock?limit=100&search=${i % 7 === 0 ? 'Load' : ''}`, token)).statusCode);
  results['read:trial-balance'] = await runScenario('GET /api/ledger/trial-balance', 200, 10, async () =>
    (await inj('GET', '/api/ledger/trial-balance', token)).statusCode);
  results['read:catalog'] = await runScenario('GET /api/procurement/catalog', 300, 10, async (i) =>
    (await inj('GET', `/api/procurement/catalog?limit=48&offset=${(i % 4) * 48}`, token)).statusCode);
  results['write:journal'] = await runScenario('POST /api/ledger/journal', 150, 5, async (i) =>
    (await inj('POST', '/api/ledger/journal', token, {
      source: 'LOAD', sourceRef: `LOAD-${i}`, memo: `load ${i}`,
      lines: [{ account_code: '5100', debit: 10 }, { account_code: '1000', credit: 10 }],
    })).statusCode);

  const errorTotal = Object.values(results).reduce((a, r) => a + r.errors, 0);
  if (errorTotal > 0) { console.error(`❌ load-smoke: ${errorTotal} request(s) errored — fix correctness before reading timings`); process.exit(1); }

  if (process.env.UPDATE_LOADBASE) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ pinned_at: ymd(), note: 'in-process PGlite relative baseline — re-pin only with a justified commit', results }, null, 2) + '\n');
    console.log(`📌 baseline pinned → ${BASELINE_PATH}`);
    await app.close();
    return;
  }
  if (!existsSync(BASELINE_PATH)) {
    console.error('❌ no load-baseline.json — pin one first: UPDATE_LOADBASE=1 pnpm --filter @ierp/cutover load');
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).results as Record<string, Stat>;
  let failed = 0;
  for (const [k, r] of Object.entries(results)) {
    const b = base[k];
    if (!b) { console.error(`  ⚠️  ${k}: no baseline entry (re-pin to add)`); continue; }
    const ratio = r.p95 / b.p95;
    const bad = ratio >= 2.5; // generous: machine noise stays under it, a real algorithmic regression doesn't
    if (bad) failed++;
    console.log(`  ${bad ? '❌' : '✅'} ${k.padEnd(24)} p95 ${r.p95}ms vs baseline ${b.p95}ms (×${ratio.toFixed(2)})`);
  }
  await app.close();
  if (failed) { console.error(`❌ load-smoke: ${failed} scenario(s) regressed ≥2.5× on p95`); process.exit(1); }
  console.log('✅ load-smoke: all scenarios within 2.5× of the pinned p95 baseline');
}

main().catch((e) => { console.error(e); process.exit(1); });
