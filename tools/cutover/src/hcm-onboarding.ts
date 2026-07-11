/**
 * HR-5 (docs/42) — Onboarding / offboarding lifecycle + the HR-05 access-revocation-completeness control.
 * Boots the AppModule over PGlite, seeds a tenant + role/permission fixtures, and drives the lifecycle
 * endpoints end-to-end: onboarding/offboarding templates with tasks (one flagged is_access_revocation),
 * starting a template for an employee (task instantiation), marking tasks done/skipped, the HR-05 completion
 * gate (an offboarding cannot complete while an access-revocation task is pending → ACCESS_REVOCATION_INCOMPLETE),
 * the hr_admin/exec + reason skip authorisation (audit-logged), the offboarding-exceptions detective read,
 * and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-onboarding
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-onb-secret';
process.env.NODE_ENV = 'test';
process.env.TENANCY_MODE = 'multi-company'; // per-company isolation (org_id=NULL ⇒ own tenant only) — needed for the RLS check

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

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();

  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CO2', name: 'Second Co' }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'CO2')))[0].id);

  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // Admin → hr_admin-capable (skip path)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr_admin
    { username: 'hrbasic', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr only (write, but NOT skip access-revocation)
    { username: 'execonly', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },   // exec only (read, NOT write)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },    // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrbasic'), perm: 'hr' },
    { userId: await uid('execonly'), perm: 'exec' },
  ]).onConflictDoNothing();

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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'admin123' })).json.token;
  const admin = await login('admin');
  const hradmin = await login('hradmin');
  const hrbasic = await login('hrbasic');
  const execonly = await login('execonly');
  const t2admin = await login('t2admin');

  // Two employees on the shared payroll identity (T1).
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', monthly_salary: 28000 });
  const emp1 = e1.json.emp_code; const emp2 = e2.json.emp_code;
  ok('Seed two employees on payroll identity', /^EMP/.test(emp1 ?? '') && /^EMP/.test(emp2 ?? ''), JSON.stringify({ emp1, emp2 }));

  // ── 1. Onboarding template + tasks ───────────────────────────────────────
  const onb = await inj('POST', '/api/hcm/lifecycle/templates', hrbasic, { code: 'ONB-STD', name: 'Standard onboarding', kind: 'onboarding' });
  ok('hr user creates an onboarding template', onb.status < 300 && onb.json.kind === 'onboarding', JSON.stringify({ s: onb.status, k: onb.json.kind }));
  const onbId = onb.json.id;
  await inj('POST', `/api/hcm/lifecycle/templates/${onbId}/tasks`, hrbasic, { title: 'Sign employment contract', category: 'docs' });
  await inj('POST', `/api/hcm/lifecycle/templates/${onbId}/tasks`, hrbasic, { title: 'Provision IT accounts', category: 'it_access' });
  const onbT3 = await inj('POST', `/api/hcm/lifecycle/templates/${onbId}/tasks`, hrbasic, { title: 'Issue laptop', category: 'equipment' });
  ok('Add ordered tasks to the onboarding template', onbT3.status < 300 && onbT3.json.seq === 3, JSON.stringify({ s: onbT3.status, seq: onbT3.json.seq }));

  // execonly (exec read, no write) CAN list but CANNOT create → SoD (reads hr/hr_admin/exec, writes hr/hr_admin).
  const execList = await inj('GET', '/api/hcm/lifecycle/templates', execonly);
  ok('exec read-only user CAN list templates', execList.status === 200 && execList.json.count >= 1, JSON.stringify({ s: execList.status, c: execList.json.count }));
  const execWrite = await inj('POST', '/api/hcm/lifecycle/templates', execonly, { code: 'X', name: 'X' });
  ok('exec read-only user CANNOT create a template (403)', execWrite.status === 403, JSON.stringify({ s: execWrite.status }));
  const dup = await inj('POST', '/api/hcm/lifecycle/templates', hrbasic, { code: 'ONB-STD', name: 'dup' });
  ok('Duplicate template code rejected (TEMPLATE_EXISTS)', dup.status === 400 && dup.json?.error?.code === 'TEMPLATE_EXISTS', JSON.stringify({ s: dup.status, c: dup.json?.error?.code }));

  // ── 2. Offboarding template + tasks (two flagged is_access_revocation) ────
  const off = await inj('POST', '/api/hcm/lifecycle/templates', hradmin, { code: 'OFF-STD', name: 'Standard offboarding', kind: 'offboarding' });
  ok('hr_admin creates an offboarding template', off.status < 300 && off.json.kind === 'offboarding', JSON.stringify({ s: off.status, k: off.json.kind }));
  const offId = off.json.id;
  await inj('POST', `/api/hcm/lifecycle/templates/${offId}/tasks`, hradmin, { title: 'Collect laptop & badge', category: 'equipment' });
  const offRevA = await inj('POST', `/api/hcm/lifecycle/templates/${offId}/tasks`, hradmin, { title: 'Revoke email & SSO access', category: 'it_access', is_access_revocation: true });
  await inj('POST', `/api/hcm/lifecycle/templates/${offId}/tasks`, hradmin, { title: 'Revoke VPN & prod access', category: 'it_access', is_access_revocation: true });
  ok('Offboarding task can be flagged is_access_revocation', offRevA.status < 300 && offRevA.json.is_access_revocation === true, JSON.stringify({ s: offRevA.status, r: offRevA.json.is_access_revocation }));

  // ── 3. Start onboarding → tasks instantiated ──────────────────────────────
  const startOnb = await inj('POST', '/api/hcm/lifecycle/start', hrbasic, { emp_code: emp1, template_id: onbId });
  ok('Start onboarding for an employee (tasks instantiated)', startOnb.status < 300 && startOnb.json.tasks_created === 3 && startOnb.json.status === 'in_progress', JSON.stringify({ s: startOnb.status, n: startOnb.json.tasks_created }));
  const startBad = await inj('POST', '/api/hcm/lifecycle/start', hrbasic, { emp_code: 'EMP-NONE', template_id: onbId });
  ok('Start with an unknown employee rejected (EMP_NOT_FOUND)', startBad.status === 404 && startBad.json?.error?.code === 'EMP_NOT_FOUND', JSON.stringify({ s: startBad.status, c: startBad.json?.error?.code }));

  // ── 4. Mark onboarding tasks done → complete ──────────────────────────────
  const onbLc = (await inj('GET', `/api/hcm/lifecycle?emp_code=${emp1}`, hrbasic)).json.lifecycles?.[0];
  ok('List lifecycle by emp_code returns the started onboarding with its tasks', onbLc?.kind === 'onboarding' && onbLc?.tasks?.length === 3, JSON.stringify({ kind: onbLc?.kind, n: onbLc?.tasks?.length }));
  for (const tk of onbLc?.tasks ?? []) await inj('PATCH', `/api/hcm/lifecycle/tasks/${tk.id}`, hrbasic, { status: 'done' });
  const compOnb = await inj('POST', `/api/hcm/lifecycle/${onbLc.id}/complete`, hrbasic);
  ok('Complete onboarding once all tasks are done', compOnb.status < 300 && compOnb.json.status === 'complete', JSON.stringify({ s: compOnb.status, st: compOnb.json.status }));

  // ── 5. Start offboarding + HR-05 access-revocation-completeness gate ───────
  const startOff = await inj('POST', '/api/hcm/lifecycle/start', hradmin, { emp_code: emp1, template_id: offId });
  ok('Start offboarding for the employee (3 tasks, 2 access-revocation)', startOff.status < 300 && startOff.json.kind === 'offboarding' && startOff.json.tasks_created === 3, JSON.stringify({ s: startOff.status, n: startOff.json.tasks_created }));
  const offLc = (await inj('GET', `/api/hcm/lifecycle?emp_code=${emp1}`, hradmin)).json.lifecycles.find((l: any) => l.kind === 'offboarding');
  const revTasks = (offLc?.tasks ?? []).filter((t: any) => t.is_access_revocation);
  const nonRev = (offLc?.tasks ?? []).find((t: any) => !t.is_access_revocation);
  ok('Offboarding lifecycle exposes access_revocation_pending count', offLc?.access_revocation_pending === 2, JSON.stringify({ p: offLc?.access_revocation_pending }));
  // Complete the non-access task, leave both access-revocation tasks pending.
  await inj('PATCH', `/api/hcm/lifecycle/tasks/${nonRev.id}`, hradmin, { status: 'done' });

  // HR-05: cannot complete while an access-revocation task is pending.
  const blocked = await inj('POST', `/api/hcm/lifecycle/${offLc.id}/complete`, hradmin);
  ok('HR-05: offboarding completion BLOCKED while access-revocation pending (ACCESS_REVOCATION_INCOMPLETE)', blocked.status === 400 && blocked.json?.error?.code === 'ACCESS_REVOCATION_INCOMPLETE', JSON.stringify({ s: blocked.status, c: blocked.json?.error?.code }));

  // Skipping an access-revocation task: hr-only user denied; hr_admin without a reason denied; with a reason OK.
  const skipDenied = await inj('PATCH', `/api/hcm/lifecycle/tasks/${revTasks[0].id}`, hrbasic, { status: 'skipped', reason: 'n/a' });
  ok('HR-05: hr-only user CANNOT skip an access-revocation task (SKIP_REQUIRES_HR_ADMIN)', skipDenied.status === 403 && skipDenied.json?.error?.code === 'SKIP_REQUIRES_HR_ADMIN', JSON.stringify({ s: skipDenied.status, c: skipDenied.json?.error?.code }));
  const skipNoReason = await inj('PATCH', `/api/hcm/lifecycle/tasks/${revTasks[0].id}`, hradmin, { status: 'skipped' });
  ok('HR-05: skipping an access-revocation task requires a reason (SKIP_REASON_REQUIRED)', skipNoReason.status === 400 && skipNoReason.json?.error?.code === 'SKIP_REASON_REQUIRED', JSON.stringify({ s: skipNoReason.status, c: skipNoReason.json?.error?.code }));
  const skipOk = await inj('PATCH', `/api/hcm/lifecycle/tasks/${revTasks[0].id}`, hradmin, { status: 'skipped', reason: 'Account already disabled by IdP on last working day' });
  ok('HR-05: hr_admin skips an access-revocation task with a reason', skipOk.status < 300 && skipOk.json.status === 'skipped', JSON.stringify({ s: skipOk.status }));
  const slog: any = await pg.query(`select * from doc_status_log where doc_type='EMPLIFECYCLE'`);
  ok('HR-05: the access-revocation skip is audit-logged (doc_status_log EMPLIFECYCLE, ACCESS_REVOCATION_SKIP)', (slog.rows?.length ?? 0) >= 1 && String(slog.rows?.[0]?.remarks ?? '').includes('ACCESS_REVOCATION_SKIP'), JSON.stringify({ n: slog.rows?.length }));

  // Still one access-revocation task pending → still blocked.
  const stillBlocked = await inj('POST', `/api/hcm/lifecycle/${offLc.id}/complete`, hradmin);
  ok('HR-05: still blocked with one access-revocation task pending', stillBlocked.status === 400 && stillBlocked.json?.error?.code === 'ACCESS_REVOCATION_INCOMPLETE', JSON.stringify({ s: stillBlocked.status }));
  // Complete the last access-revocation task (done) → completion now succeeds.
  await inj('PATCH', `/api/hcm/lifecycle/tasks/${revTasks[1].id}`, hradmin, { status: 'done' });
  const compOff = await inj('POST', `/api/hcm/lifecycle/${offLc.id}/complete`, hradmin);
  ok('HR-05: offboarding completes once every access-revocation task is done/skipped', compOff.status < 300 && compOff.json.status === 'complete', JSON.stringify({ s: compOff.status, st: compOff.json.status }));

  // ── 6. Offboarding-exceptions detective read ──────────────────────────────
  // A fresh open offboarding for emp2 with an access-revocation task left pending.
  const startOff2 = await inj('POST', '/api/hcm/lifecycle/start', hradmin, { emp_code: emp2, template_id: offId });
  ok('Start a second (stale) offboarding for the detective read', startOff2.status < 300, JSON.stringify({ s: startOff2.status }));
  const exc0 = await inj('GET', '/api/hcm/lifecycle/offboarding-exceptions?days=0', hradmin);
  ok('offboarding-exceptions (days=0) surfaces the open offboarding with unrevoked access', exc0.json.count >= 1 && (exc0.json.exceptions ?? []).some((x: any) => x.emp_code === emp2 && x.access_revocation_pending >= 1), JSON.stringify({ c: exc0.json.count }));
  const exc30 = await inj('GET', '/api/hcm/lifecycle/offboarding-exceptions?days=30', hradmin);
  ok('offboarding-exceptions (days=30) excludes not-yet-stale offboardings', exc30.json.count === 0, JSON.stringify({ c: exc30.json.count }));

  // ── 7. RLS tenant isolation ───────────────────────────────────────────────
  const t2tpl = await inj('POST', '/api/hcm/lifecycle/templates', t2admin, { code: 'T2ONLY', name: 'Second-Co template', kind: 'onboarding' });
  ok('T2 admin can create its own template', t2tpl.status < 300, JSON.stringify({ s: t2tpl.status }));
  const t1codes = ((await inj('GET', '/api/hcm/lifecycle/templates', admin)).json.templates ?? []).map((x: any) => x.code);
  const t2codes = ((await inj('GET', '/api/hcm/lifecycle/templates', t2admin)).json.templates ?? []).map((x: any) => x.code);
  ok('RLS: T1 does NOT see T2ONLY (tenant isolation)', !t1codes.includes('T2ONLY') && t1codes.includes('ONB-STD'), JSON.stringify({ t1codes }));
  ok('RLS: T2 sees only its own template (not T1 ONB-STD/OFF-STD)', t2codes.includes('T2ONLY') && !t2codes.includes('ONB-STD') && !t2codes.includes('OFF-STD'), JSON.stringify({ t2codes }));

  console.log('\n── HR-5 — Onboarding / offboarding lifecycle + access-revocation completeness (HR-05) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-5 lifecycle checks failed` : `\n✅ All ${checks.length} HR-5 lifecycle checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
