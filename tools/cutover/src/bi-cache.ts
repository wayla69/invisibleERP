/**
 * Step 5 ToE — BI dashboard read-through cache (short TTL).
 * Boots the real Nest app over PGlite and asserts: the KPI board is cached per tenant for the TTL window
 * (a value inserted after the first read is NOT seen on a second read within the window → cache hit);
 * BI_CACHE_TTL_MS=0 disables caching (the new value IS seen); the cache key is tenant-isolated (one
 * tenant's cached board never bleeds into another's); and a snapshot refresh busts the tenant's cache.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover bi-cache
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bicache-secret';
process.env.NODE_ENV = 'test';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }, { code: 'T2', name: 'T2' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const hq = await tid('HQ'), t1 = await tid('T1'), t2 = await tid('T2');
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 },
    { username: 'mgr2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  const today = new Date().toISOString().slice(0, 10);
  const addSale = async (tenant: number, no: string, total: string) =>
    db.insert(s.custPosSales).values({ saleNo: no, saleDate: today, tenantId: tenant, total, subtotal: total, taxAmount: '0', status: 'Completed', paymentMethod: 'Cash', createdBy: 'seed' });
  await addSale(t1, 'S-T1-1', '100');

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token;
  const mgr1 = await login('mgr1', 'pw');
  const mgr2 = await login('mgr2', 'pw');

  // 1. cache hit: read board (mtd 100), insert another sale, read again within the TTL window → still 100
  process.env.BI_CACHE_TTL_MS = '60000';
  const v1 = await inj('GET', '/api/bi/kpi', mgr1);
  ok('board reads MTD sales = 100', v1.json.sales?.mtd === 100, `mtd=${v1.json.sales?.mtd}`);
  await addSale(t1, 'S-T1-2', '50'); // would make MTD 150 if recomputed
  const v2 = await inj('GET', '/api/bi/kpi', mgr1);
  ok('second read within TTL is served from cache (still 100, not 150)', v2.json.sales?.mtd === 100, `mtd=${v2.json.sales?.mtd}`);

  // 2. TTL=0 disables caching → the new value is computed fresh
  process.env.BI_CACHE_TTL_MS = '0';
  const v3 = await inj('GET', '/api/bi/kpi', mgr1);
  ok('BI_CACHE_TTL_MS=0 disables cache → fresh MTD = 150', v3.json.sales?.mtd === 150, `mtd=${v3.json.sales?.mtd}`);

  // 3. tenant isolation — T2's board is computed for T2 (0), never served T1's cached value
  process.env.BI_CACHE_TTL_MS = '60000';
  const t2v = await inj('GET', '/api/bi/kpi', mgr2);
  ok('cache key is tenant-isolated (T2 board = 0, not T1 cached)', t2v.json.sales?.mtd === 0, `mtd=${t2v.json.sales?.mtd}`);

  // 4. snapshot refresh busts the tenant cache → next read recomputes.
  //    The T1 board is still cached at 100 (from step 1, ttl 60s) even though two more sales (50, 25) landed;
    //  the refresh drops the cache so the next read recomputes the true total (100+50+25 = 175).
  const prime = await inj('GET', '/api/bi/kpi', mgr1); // cached → 100
  await addSale(t1, 'S-T1-3', '25');
  const stale = await inj('GET', '/api/bi/kpi', mgr1); // still cached → 100
  await inj('POST', '/api/bi/snapshots/refresh', mgr1, {}); // busts T1 cache
  const fresh = await inj('GET', '/api/bi/kpi', mgr1); // recompute → 175
  ok('snapshot refresh busts cache → next read recomputes (cached 100 → fresh 175)', prime.json.sales?.mtd === 100 && stale.json.sales?.mtd === 100 && fresh.json.sales?.mtd === 175, `prime=${prime.json.sales?.mtd} stale=${stale.json.sales?.mtd} fresh=${fresh.json.sales?.mtd}`);

  // 5. sales-cube is cached too (distinct key, same mechanism)
  const sc1 = await inj('GET', '/api/bi/sales-cube?period=month', mgr2);
  await addSale(t2, 'S-T2-1', '99');
  const sc2 = await inj('GET', '/api/bi/sales-cube?period=month', mgr2);
  ok('sales-cube cached within TTL (T2 total stable across the new sale)', JSON.stringify(sc1.json.totals) === JSON.stringify(sc2.json.totals), `${JSON.stringify(sc1.json.totals)} vs ${JSON.stringify(sc2.json.totals)}`);

  delete process.env.BI_CACHE_TTL_MS;
  await app.close();
  console.log('\n── Step 5 — BI dashboard read-through cache ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} bi-cache checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} bi-cache checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
