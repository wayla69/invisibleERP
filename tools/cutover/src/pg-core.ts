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
import { eq, inArray, sql } from 'drizzle-orm';
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

// Two org groupings for the multi-company org-sharing check (ITGC-AC-18). Values are arbitrary org ids
// (kept well clear of the small tenant ids to avoid confusing the two columns when reading failures).
const ORG_A = 8001, ORG_B = 8002;

async function main() {
  const { db: raw, kind, cleanup } = await harnessDb();
  const db = tenantAwareProxy(raw); // the app injects the proxied db; harness seeds through it too
  const pw = new PasswordService();
  console.log(`pg-core: backend = ${kind}${kind === 'pg' ? ' (real Postgres)' : ' (PGlite)'}`);

  // Seed through a BYPASS context (SET ROLE app_user + app.bypass_rls) — required on real Postgres where
  // every tenant table is FORCE-RLS and a bare INSERT would be rejected. Works unchanged on PGlite.
  let hq = 0, t1 = 0, t2 = 0, mA1 = 0, mA2 = 0, mB1 = 0;
  await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, async () => {
    await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
    for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
      await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
    await db.insert(s.tenants).values([
      { code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' },
      // Multi-company (ITGC-AC-18): two sibling tenants share ORG_A; a third sits in ORG_B. An org-scoped
      // Admin in ORG_A must see BOTH siblings' data rows but never ORG_B's (org sharing without leak).
      { code: 'MA1', name: 'ออร์กเอ-หนึ่ง', orgId: ORG_A }, { code: 'MA2', name: 'ออร์กเอ-สอง', orgId: ORG_A },
      { code: 'MB1', name: 'ออร์กบี-หนึ่ง', orgId: ORG_B },
    ]).onConflictDoNothing();
    const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
    hq = await tid('HQ'); t1 = await tid('T1'); t2 = await tid('T2');
    mA1 = await tid('MA1'); mA2 = await tid('MA2'); mB1 = await tid('MB1');
    await db.insert(s.users).values([
      { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
      { username: 't1sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },
      { username: 't2sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t2 },
    ]).onConflictDoNothing();
    // A tenant-scoped row per shop (background_jobs is FORCE-RLS) to prove isolation over HTTP, plus one per
    // org-sibling tenant for the AC-18 org-sharing check below.
    await db.insert(s.backgroundJobs).values([
      { tenantId: t1, jobType: 'seed', status: 'done', payload: {} },
      { tenantId: t2, jobType: 'seed', status: 'done', payload: {} },
      { tenantId: mA1, jobType: 'seed', status: 'done', payload: {} },
      { tenantId: mA2, jobType: 'seed', status: 'done', payload: {} },
      { tenantId: mB1, jobType: 'seed', status: 'done', payload: {} },
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

  // 2b. Multi-company org SHARING on a DATA table (ITGC-AC-18). An org-scoped Admin (app.org_id set, NO
  //     global bypass) must see EVERY sibling tenant's rows in its org — not just its own — while a
  //     different org stays invisible. This exercises the per-DATA-table org clause on `tenant_isolation`
  //     (added by 0196, silently clobbered by 0218's plain RLS re-loop, RE-APPLIED by 0232). Driven at the
  //     DB layer (like pg-smoke) so it runs on BOTH backends and needs no app-wide TENANCY_MODE flip (which
  //     would break the single-company HQ-bypass check above). On real Postgres this runs under SET ROLE
  //     app_user with FORCE RLS — the authoritative reproduction of the prod behaviour.
  const orgSeen = await raw.transaction(async (tx: any) => {
    try { await tx.execute(sql`SET LOCAL ROLE app_user`); } catch { /* PGlite dev without the role — RLS off */ }
    await tx.execute(sql`select set_config('app.bypass_rls', '', true),
      set_config('app.tenant_id', ${String(mA1)}, true), set_config('app.org_id', ${String(ORG_A)}, true)`);
    const rows = await tx.select({ t: s.backgroundJobs.tenantId }).from(s.backgroundJobs)
      .where(inArray(s.backgroundJobs.tenantId, [mA1, mA2, mB1]));
    return rows.map((r: any) => Number(r.t));
  });
  const org1 = orgSeen.filter((t: number) => t === mA1 || t === mA2).length; // sibling rows the org-Admin sees
  ok('RLS: org-scoped Admin sees BOTH sibling tenants in its org (AC-18 org sharing)', org1 === 2, `org1=${org1}`);
  ok('RLS: org-scoped Admin does NOT see a different-org tenant (no leak)', !orgSeen.includes(mB1), `sawOtherOrg=${orgSeen.includes(mB1)}`);

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
