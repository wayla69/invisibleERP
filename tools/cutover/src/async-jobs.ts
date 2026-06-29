/**
 * Step 4 ToE — async background-job queue (off-thread financial ops).
 * Boots the real Nest app over PGlite and asserts: a payroll run can be enqueued (POST /runs?async=1 → 202
 * queued + job_id), the worker claims + runs it inside the job's own tenant tx (status → done, payrun created),
 * the run is idempotent under the queue's at-least-once retry, and job status is RLS-isolated per tenant.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover async-jobs
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'jobs-secret';
process.env.NODE_ENV = 'test'; // worker poll loop OFF — we drive it deterministically via drain()
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { JobWorkerService } from '../../../apps/api/dist/modules/jobs/job-worker.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIG = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) await pg.exec(readFileSync(join(MIG, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'อีกบริษัท' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 't2sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t2 }, // scoped — for RLS isolation
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const worker = app.get(JobWorkerService);

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  const t2sales = (await inj('POST', '/api/login', undefined, { username: 't2sales', password: 'admin123' })).json.token;

  // seed two employees for HQ tenant
  await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', national_id: '1234567890123', monthly_salary: 30000 });
  await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', national_id: '9876543210987', monthly_salary: 12000 });

  // 1. enqueue an async payroll run → 202-style queued response with a job id
  const enq = await inj('POST', '/api/payroll/runs?period=2026-06&async=1', admin);
  const jobId = enq.json.job_id;
  ok('enqueue payroll run → queued + job_id', enq.json.queued === true && typeof jobId === 'number' && enq.json.status === 'queued', JSON.stringify(enq.json));

  // 2. before the worker runs, status is queued and NO payrun exists yet (proves it is off-thread)
  const before = await inj('GET', `/api/jobs/${jobId}`, admin);
  const runsBefore = await inj('GET', '/api/payroll/runs', admin);
  ok('job pending before worker runs (status queued, no payrun yet)', before.json.status === 'queued' && (runsBefore.json.runs ?? runsBefore.json.payruns ?? []).length === 0, JSON.stringify({ st: before.json.status }));

  // 3. drive the worker → claims + runs the job inside the job's tenant tx
  const processed = await worker.drain();
  const after = await inj('GET', `/api/jobs/${jobId}`, admin);
  ok('worker drains 1 job', processed === 1, `processed=${processed}`);
  ok('job → done with payroll result (headcount 2, JE created)', after.json.status === 'done' && after.json.result?.headcount === 2 && /^JE-/.test(after.json.result?.entry_no ?? ''), JSON.stringify({ st: after.json.status, r: after.json.result }));

  // 4. the payrun is now persisted (worker ran the real handler against the tenant data)
  const runs = await inj('GET', '/api/payroll/runs', admin);
  ok('payrun persisted by the worker', (runs.json.runs ?? runs.json.payruns ?? []).some((r: any) => r.period === '2026-06'), JSON.stringify(runs.json).slice(0, 120));

  // 5. idempotency — enqueue the same period again, worker runs it, result reports already-run (no double-post)
  const enq2 = await inj('POST', '/api/payroll/runs?period=2026-06&async=1', admin);
  await worker.drain();
  const after2 = await inj('GET', `/api/jobs/${enq2.json.job_id}`, admin);
  ok('re-run is idempotent (job done, result.already=true)', after2.json.status === 'done' && after2.json.result?.already === true, JSON.stringify(after2.json.result));

  // 6. RLS isolation — a scoped user in another tenant cannot see HQ's job
  const cross = await inj('GET', `/api/jobs/${jobId}`, t2sales);
  ok('RLS: other tenant cannot see the job (NOT_FOUND)', cross.json.error?.code === 'NOT_FOUND', JSON.stringify(cross.json).slice(0, 120));

  // 7. empty queue → worker tick is a no-op
  const none = await worker.tick();
  ok('empty queue → tick() returns false', none === false, `tick=${none}`);

  await app.close();
  console.log('\n── Step 4 — async background-job queue ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} async-jobs checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} async-jobs checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
