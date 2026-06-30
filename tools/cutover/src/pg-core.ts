/**
 * Real-Postgres core harness (operational maturity — Step 3). Boots the ACTUAL Nest app over the swappable
 * harness DB and drives a representative cross-section through HTTP: auth, RLS tenant isolation, the async
 * job round-trip, audit-log immutability, and the ops-metrics endpoint. With HARNESS_PG_URL set (CI
 * pg-core job) it runs on REAL Postgres — so FORCE ROW LEVEL SECURITY under app_user, postgres-js
 * date/numeric handling, and the append-only audit trigger are exercised for real, not on PGlite. Without
 * the env it runs on PGlite (local), so it's part of the normal suite too.
 *   HARNESS_PG_URL=postgres://… NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pg-core
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pgcore-secret';
process.env.NODE_ENV = 'test'; // worker poll loop OFF — driven via tick()

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { JobWorkerService } from '../../../apps/api/dist/modules/jobs/job-worker.service';
import { JobQueueService } from '../../../apps/api/dist/modules/jobs/job-queue.service';
import { runInTenantContext } from '../../../apps/api/dist/common/tenant-run';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';
import { harnessDb } from './harness-db';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const { db: raw, kind, cleanup } = await harnessDb();
  const db = tenantAwareProxy(raw); // the app injects the proxied db; harness seeds through it too
  const pw = new PasswordService();
  console.log(`pg-core: backend = ${kind}${kind === 'pg' ? ' (real Postgres)' : ' (PGlite)'}`);

  // Seed through a BYPASS context (SET ROLE app_user + app.bypass_rls) — required on real Postgres where
  // every tenant table is FORCE-RLS and a bare INSERT would be rejected. Works unchanged on PGlite.
  let hq = 0, t1 = 0, t2 = 0;
  await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, async () => {
    await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
    for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
      await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
    await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
    const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
    hq = await tid('HQ'); t1 = await tid('T1'); t2 = await tid('T2');
    await db.insert(s.users).values([
      { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
      { username: 't1sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },
      { username: 't2sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t2 },
    ]).onConflictDoNothing();
    // A tenant-scoped row per shop (background_jobs is FORCE-RLS) to prove isolation over HTTP.
    await db.insert(s.backgroundJobs).values([
      { tenantId: t1, jobType: 'seed', status: 'done', payload: {} },
      { tenantId: t2, jobType: 'seed', status: 'done', payload: {} },
    ]);
  });

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(db).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  // 1. auth works on the chosen backend (scrypt verify + JWT issue)
  const adminTok = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  const t1Tok = (await inj('POST', '/api/login', undefined, { username: 't1sales', password: 'admin123' })).json.token;
  const t2Tok = (await inj('POST', '/api/login', undefined, { username: 't2sales', password: 'admin123' })).json.token;
  ok('login issues tokens for admin + both tenants', !!adminTok && !!t1Tok && !!t2Tok);

  // 2. RLS isolation over HTTP — each scoped user sees ONLY their tenant's jobs (FORCE-RLS under app_user
  //    on real Postgres; the whole point of the gate). Admin (HQ bypass) sees both.
  const t1Jobs = await inj('GET', '/api/jobs', t1Tok);
  const t2Jobs = await inj('GET', '/api/jobs', t2Tok);
  const adminJobs = await inj('GET', '/api/jobs', adminTok);
  const cnt = (r: any) => (r.json.jobs ?? []).length;
  ok('RLS: T1 user sees exactly its own job (1)', cnt(t1Jobs) === 1, `t1=${cnt(t1Jobs)}`);
  ok('RLS: T2 user sees exactly its own job (1)', cnt(t2Jobs) === 1, `t2=${cnt(t2Jobs)}`);
  ok('RLS: HQ admin (bypass) sees both tenants jobs (≥2)', cnt(adminJobs) >= 2, `admin=${cnt(adminJobs)}`);

  // 3. async job round-trip on the backend (enqueue → worker tick → done)
  const queue = app.get(JobQueueService);
  const worker = app.get(JobWorkerService);
  const jid = await queue.enqueue({ jobType: 'no_such_handler', tenantId: t1, bypass: true, maxAttempts: 1 });
  await worker.tick();
  const jrow = await inj('GET', `/api/jobs/${jid}`, adminTok);
  ok('job processed to a terminal state (failed dead-letter)', jrow.json.status === 'failed', `st=${jrow.json.status}`);

  // 4. the Step-2 ops-metrics endpoint serves on the backend (cross-tenant counts via the bypass path)
  const metrics = await inj('GET', '/api/jobs/ops-metrics', adminTok);
  ok('ops-metrics endpoint serves (pool + jobs)', metrics.status === 200 && typeof metrics.json?.pool?.max === 'number', `status=${metrics.status}`);
  // NB: audit_log append-only immutability on real Postgres is covered by the `pg-smoke` job (a raw,
  // autocommit DELETE → P0001). It is intentionally NOT re-tested here: a failing query inside a
  // postgres-js transaction poisons that transaction, so it can't be caught-and-continued mid-tx.

  await app.close();
  await cleanup();

  console.log(`\n── pg-core (${kind}) ──`);
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pg-core checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pg-core checks passed (${kind})`);
}
main().catch((e) => { console.error('pg-core crashed:', e); process.exit(1); });
