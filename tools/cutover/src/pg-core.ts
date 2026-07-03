/**
 * Real-Postgres core harness (operational maturity — Step 3). Boots the ACTUAL Nest app over the swappable
 * harness DB and drives a representative cross-section through HTTP: auth, RLS tenant isolation (both the
 * single-company global-HQ bypass AND the multi-company org-scoped Admin path — ITGC-AC-18 / migration
 * 0196), the async job round-trip, audit-log immutability, and the ops-metrics endpoint. With HARNESS_PG_URL set (CI
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

  // 5. Multi-company org-scoped Admin ISOLATION + SHARING (ITGC-AC-18 / hybrid org-tenancy, migrations 0196
  //    + 0232). The TenantTxInterceptor reads process.env.TENANCY_MODE per-request, so we flip it live (no
  //    reboot) and prove what a self-service-signup SaaS needs: an Admin is ISOLATED from other companies —
  //    a fresh signup (org_id=NULL) and a single-tenant company Admin each see ONLY their own tenant, and an
  //    org-scoped Admin never sees another company — AND cross-account org SHARING works: an org-scoped Admin
  //    DOES see a SIBLING tenant's data in its own org (org1===2; see the hard assertion below).
  //    A distinct jobType keeps the single-company cohort above from skewing the counts. Seeded via a
  //    bypass context (FORCE-RLS rejects a bare insert).
  let mA1 = 0, mA2 = 0, mB = 0, mC = 0;
  await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, async () => {
    await db.insert(s.tenants).values([
      { code: 'ORG1HQ', name: 'กลุ่มหนึ่ง สนญ.', orgId: 1 },
      { code: 'ORG1BR', name: 'กลุ่มหนึ่ง สาขา', orgId: 1 },
      { code: 'ORG2CO', name: 'บริษัทสอง', orgId: 2 },
      { code: 'NEWCO', name: 'สมัครใหม่ (org ว่าง)', orgId: null },
    ]).onConflictDoNothing();
    const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
    mA1 = await tid('ORG1HQ'); mA2 = await tid('ORG1BR'); mB = await tid('ORG2CO'); mC = await tid('NEWCO');
    await db.insert(s.users).values([
      { username: 'org1admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: mA1, orgId: 1 },
      { username: 'org2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: mB, orgId: 2 },
      { username: 'newcoadmin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: mC, orgId: null },
    ]).onConflictDoNothing();
    await db.insert(s.backgroundJobs).values([
      { tenantId: mA1, jobType: 'mc_seed', status: 'done', payload: {} },
      { tenantId: mA2, jobType: 'mc_seed', status: 'done', payload: {} },
      { tenantId: mB, jobType: 'mc_seed', status: 'done', payload: {} },
      { tenantId: mC, jobType: 'mc_seed', status: 'done', payload: {} },
    ]);
  });

  process.env.TENANCY_MODE = 'multi-company'; // flip live — the interceptor reads it per request
  const mcTok = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'admin123' })).json.token;
  const mcCnt = async (tok: string) => (await inj('GET', '/api/jobs?type=mc_seed', tok)).json.count;
  const org1Tok = await mcTok('org1admin');
  const org1 = await mcCnt(org1Tok);
  const org2 = await mcCnt(await mcTok('org2admin'));
  const newco = await mcCnt(await mcTok('newcoadmin'));

  // The two guarantees a self-service-signup SaaS needs — and BOTH hold on PGlite AND real Postgres, since
  // they rely only on the tenant_id clause of the RLS policy (present on every tenant table since 0002):
  ok('multi-company: fresh-signup Admin (org_id=NULL) sees ONLY its own tenant (1) — the reported case', newco === 1, `newco=${newco}`);
  ok('multi-company: a single-tenant company Admin sees only its own company (1)', org2 === 1, `org2=${org2}`);

  // Contrast — flip BACK to single-company: the SAME Admin now sees ALL 4 companies (global HQ bypass). The
  // exact behaviour the TENANCY_MODE fix changes, asserted in both directions; holds on both backends.
  process.env.TENANCY_MODE = 'single-company';
  const org1Single = await mcCnt(org1Tok);
  ok('single-company (contrast): the SAME Admin sees ALL companies — the risky global-bypass default multi-company fixes', org1Single === 4, `org1Single=${org1Single}`);
  process.env.TENANCY_MODE = 'multi-company';

  // Org-scoped ISOLATION + SHARING in one count: org1 Admin (org_id=1, whose org spans mA1+mA2) must see
  // BOTH of its own org's tenants (cross-account SHARING — it reads its sibling's DATA rows) and NEITHER of
  // the other two companies (org2 mB, org-null mC) → org1 === 2 exactly: never 1 (over-isolated) nor 3–4
  // (leak). This needs 0196's per-tenant-table org clause, which 0218's plain RLS re-loop had dropped on the
  // data tables and 0232 re-applies — so it now holds on BOTH PGlite and real Postgres. (Was org1=1 before
  // the 0232 fix: the mode over-isolated to the Admin's own tenant — fail-closed, no leak.)
  ok('multi-company: org-scoped Admin sees BOTH its org tenants and NO other company — cross-account SHARING active (org1===2)', org1 === 2, `org1=${org1}`);
  delete process.env.TENANCY_MODE; // restore harness default

  await app.close();
  await cleanup();

  console.log(`\n── pg-core (${kind}) ──`);
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} pg-core checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pg-core checks passed (${kind})`);
}
main().catch((e) => { console.error('pg-core crashed:', e); process.exit(1); });
