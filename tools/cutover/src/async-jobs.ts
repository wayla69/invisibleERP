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
import { JobQueueService } from '../../../apps/api/dist/modules/jobs/job-queue.service';
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

  // ── ITGC-OP-04: dead-letter + stuck-job reaper ──────────────────────────────────────────────────
  const queue = app.get(JobQueueService);

  // 8. dead-letter — a job whose type has NO handler fails; with maxAttempts=1 it exhausts on the first
  // tick and lands in 'failed' (the dead-letter state that raises an ops alert).
  const dlId = await queue.enqueue({ jobType: 'no_such_handler', tenantId: hq, bypass: true, maxAttempts: 1 });
  await worker.tick();
  const dl = await inj('GET', `/api/jobs/${dlId}`, admin);
  ok('retry-exhausted job → dead-letter (status failed)', dl.json.status === 'failed', JSON.stringify({ st: dl.json.status, err: dl.json.error }).slice(0, 120));

  // 9. stuck-job reaper — two jobs left 'running' with a STALE lock (their worker "died"). One has retries
  // left → requeued; one is exhausted → dead-lettered. (claimNext only picks 'queued', so without the
  // reaper these sit forever.)
  const old = new Date(Date.now() - 10 * 60_000); // 10 min ago > default 5-min stale threshold
  const [stuckRetry] = await db.insert(s.backgroundJobs).values({ tenantId: hq, jobType: 'zombie', status: 'running', attempts: 1, maxAttempts: 3, lockedAt: old, payload: {} }).returning({ id: s.backgroundJobs.id });
  const [stuckDead]  = await db.insert(s.backgroundJobs).values({ tenantId: hq, jobType: 'zombie', status: 'running', attempts: 3, maxAttempts: 3, lockedAt: old, payload: {} }).returning({ id: s.backgroundJobs.id });
  const reaped = await worker.reap();
  ok('reaper requeues 1 + dead-letters 1 stuck job', reaped.requeued === 1 && reaped.deadLettered === 1, JSON.stringify(reaped));
  const sr = await inj('GET', `/api/jobs/${Number(stuckRetry.id)}`, admin);
  const sd = await inj('GET', `/api/jobs/${Number(stuckDead.id)}`, admin);
  ok('reaped-with-retries → requeued (status queued)', sr.json.status === 'queued', `st=${sr.json.status}`);
  ok('reaped-exhausted → dead-letter (status failed)', sd.json.status === 'failed', `st=${sd.json.status}`);

  // 10. a fresh 'running' job (lock NOT stale) is left alone by the reaper
  const [fresh] = await db.insert(s.backgroundJobs).values({ tenantId: hq, jobType: 'zombie', status: 'running', attempts: 1, maxAttempts: 3, lockedAt: new Date(), payload: {} }).returning({ id: s.backgroundJobs.id });
  const reaped2 = await worker.reap();
  const fr = await inj('GET', `/api/jobs/${Number(fresh.id)}`, admin);
  ok('fresh running job is NOT reaped', reaped2.requeued === 0 && reaped2.deadLettered === 0 && fr.json.status === 'running', JSON.stringify({ ...reaped2, st: fr.json.status }));

  // 11. opsCounts surfaces dead-letters + stuck for the metrics/health endpoint
  const counts = await queue.opsCounts();
  ok('opsCounts reports failed ≥ 2 and a fresh running job', counts.failed >= 2 && counts.running >= 1, JSON.stringify(counts));

  // 12. ops-metrics endpoint — admin-gated, surfaces pool + jobs backlog (Step 2 observability)
  const metrics = await inj('GET', '/api/jobs/ops-metrics', admin);
  ok('GET /api/jobs/ops-metrics → pool + requests + jobs backlog', metrics.status === 200 && typeof metrics.json?.pool?.max === 'number' && metrics.json?.jobs?.failed >= 2, JSON.stringify(metrics.json).slice(0, 160));
  // 13. ops-metrics is NOT a per-tenant endpoint — a scoped non-'users' principal is denied
  const metricsCross = await inj('GET', '/api/jobs/ops-metrics', t2sales);
  ok('ops-metrics gated to admin/ops (403 for scoped sales user)', metricsCross.status === 403, `status=${metricsCross.status}`);

  // ── 2.7 (docs/27 R1-5 / AUD-ARC-07): cross-tenant scheduler sweep + heartbeat + in-process tick ──
  const { BiService } = require('../../../apps/api/dist/modules/bi/bi.service');
  const { SchedulerTickService } = require('../../../apps/api/dist/modules/bi/scheduler-tick.service');
  const { SchedulerHeartbeatService } = require('../../../apps/api/dist/modules/jobs/scheduler-heartbeat.service');
  const biSchema = require('../../../apps/api/dist/database/schema/bi');
  const bi = app.get(BiService);
  const tickSvc = app.get(SchedulerTickService);
  const hb = app.get(SchedulerHeartbeatService);

  // 14. two tenants each have a due subscription; the platform-wide sweep enqueues BOTH (the per-tenant
  // runDue/runDueAsync only ever saw the caller's tenant — the multi-company scheduling gap this closes).
  await db.insert(biSchema.reportSubscriptions).values([
    { tenantId: hq, name: 'HQ daily KPI', reportType: 'kpi_board', frequency: 'daily', isActive: true, recipients: [], filters: {}, createdBy: 'admin' },
    { tenantId: t2, name: 'T2 daily KPI', reportType: 'kpi_board', frequency: 'daily', isActive: true, recipients: [], filters: {}, createdBy: 't2sales' },
  ]);
  const sweep = await bi.runDueAllAsync('toe:sweep');
  ok('cross-tenant sweep enqueues due subscriptions of BOTH tenants', sweep.due === 2 && sweep.enqueued === 2 && sweep.mode === 'queued', JSON.stringify(sweep));
  await worker.drain();
  const hqRuns = await db.select().from(biSchema.reportRuns).where(eq(biSchema.reportRuns.tenantId, hq));
  const t2Runs = await db.select().from(biSchema.reportRuns).where(eq(biSchema.reportRuns.tenantId, t2));
  ok('worker ran each subscription RLS-scoped in ITS OWN tenant (report_runs in both)', hqRuns.length >= 1 && t2Runs.length >= 1, `hq=${hqRuns.length} t2=${t2Runs.length}`);

  // 15. multi-trigger idempotency — a DUPLICATE enqueue for the just-ran (no longer due) subscription
  // no-ops at execution time (the handler re-checks dueness), so cron + tick + manual can't double-deliver.
  const [hqSub] = await db.select().from(biSchema.reportSubscriptions).where(eq(biSchema.reportSubscriptions.tenantId, hq));
  const dupId = await queue.enqueue({ jobType: 'report_subscription', payload: { subscriptionId: Number(hqSub.id) }, tenantId: hq, actor: 'toe:dup' });
  await worker.drain();
  const dupJob = await inj('GET', `/api/jobs/${dupId}`, admin);
  ok('duplicate enqueue of a not-due subscription no-ops (skipped: not due)', dupJob.json.status === 'done' && dupJob.json.result?.skipped === 'not due', JSON.stringify(dupJob.json.result));
  ok('no extra report_run from the duplicate', (await db.select().from(biSchema.reportRuns).where(eq(biSchema.reportRuns.tenantId, hq))).length === hqRuns.length);

  // 16. heartbeat — the sweep stamped it; fresh = ok, tiny threshold = stale, unknown scheduler = never.
  const hbOk = await hb.checkStale('bi_scheduler');
  ok('heartbeat stamped by the sweep → status ok', hbOk.status === 'ok' && typeof hbOk.age_ms === 'number', JSON.stringify(hbOk));
  const hbStale = await hb.checkStale('bi_scheduler', 0);
  ok('stale threshold exceeded → status stale (ops alert path)', hbStale.status === 'stale', JSON.stringify(hbStale));
  ok('unknown scheduler → status never (fresh install must not page)', (await hb.checkStale('never_configured')).status === 'never');
  const om = await inj('GET', '/api/jobs/ops-metrics', admin);
  ok('ops-metrics surfaces scheduler heartbeat posture', ['ok', 'stale'].includes(om.json?.scheduler?.status), JSON.stringify(om.json?.scheduler));

  // 17. in-process tick — default-inert (not armed under test/unset env) but steppable; overlap guard holds.
  ok('SchedulerTickService default-inert (not armed without SCHEDULER_TICK_MS)', tickSvc.armed === false);
  const tickRes = await tickSvc.tickOnce();
  ok('tickOnce() runs the sweep (0 due after the runs above)', tickRes.due === 0 && !tickRes.error, JSON.stringify(tickRes));

  await app.close();
  console.log('\n── Step 4 — async background-job queue ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  if (failed) { console.log(`\n❌ ${failed}/${checks.length} async-jobs checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} async-jobs checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
