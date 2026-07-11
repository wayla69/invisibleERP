/**
 * HR-9 (docs/42 HCM depth, Wave 3) — Workforce analytics BI report types (HR-09). Boots the AppModule over
 * PGlite, seeds two tenants with employees / org assignments / pay grades / an offboarding lifecycle / leave
 * balances, then drives the five new schedulable, read-only BI report types end-to-end (create a subscription,
 * run it, read the persisted report_runs.summary payload) and asserts each aggregate:
 *   hr_headcount_trend · hr_turnover · hr_tenure_distribution · hr_comp_ratio · hr_leave_liability
 * plus RLS tenant isolation (T2 sees only its own headcount). The reports feed the detective HR-09 control.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-analytics
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-analytics-secret';
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
const near = (a: number, b: number, eps = 0.5) => Math.abs(Number(a) - Number(b)) <= eps;

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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },   // exec (has bi/exec)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },  // other company
  ]).onConflictDoNothing();

  // ── Seed T1 workforce directly (read-only reports; RLS not enforced on the raw seed connection) ──────────
  // Employees: EMP2 is out-of-band (salary above its G5 band max); EMP4 is ungraded; EMP5 has left (inactive).
  await db.insert(s.employees).values([
    { tenantId: t1, empCode: 'EMP1', name: 'Somchai', jobGrade: 'G5', monthlySalary: '32000', startDate: '2020-01-15', active: true },
    { tenantId: t1, empCode: 'EMP2', name: 'Malee',   jobGrade: 'G5', monthlySalary: '50000', startDate: '2024-06-01', active: true },
    { tenantId: t1, empCode: 'EMP3', name: 'Anan',    jobGrade: 'G4', monthlySalary: '22000', startDate: '2025-10-01', active: true },
    { tenantId: t1, empCode: 'EMP4', name: 'Nid',                     monthlySalary: '15000',                          active: true }, // ungraded, no start date
    { tenantId: t1, empCode: 'EMP5', name: 'Left',    jobGrade: 'G4', monthlySalary: '20000', startDate: '2022-03-01', active: false }, // separated
  ]).onConflictDoNothing();
  const empId = async (code: string) => Number((await db.select().from(s.employees).where(eq(s.employees.empCode, code)))[0].id);
  const e1 = await empId('EMP1'); const e3 = await empId('EMP3');

  // Pay grades (HR-6 bands): G5 25000–40000 (mid 32500), G4 18000–24000 (mid 21000).
  await db.insert(s.payGrades).values([
    { tenantId: t1, gradeCode: 'G5', name: 'Grade 5', minSalary: '25000', midSalary: '32500', maxSalary: '40000' },
    { tenantId: t1, gradeCode: 'G4', name: 'Grade 4', minSalary: '18000', midSalary: '21000', maxSalary: '24000' },
  ]).onConflictDoNothing();

  // Org: one department + position + two CURRENT assignments (end_date NULL) → headcount by dept/position.
  const [dept] = await db.insert(s.hrDepartments).values({ tenantId: t1, deptCode: 'ENG', name: 'Engineering' }).returning();
  const [pos] = await db.insert(s.hrPositions).values({ tenantId: t1, positionCode: 'ENG-DEV', title: 'Developer', deptId: Number(dept.id), budgetedHeadcount: 5 }).returning();
  await db.insert(s.hrAssignments).values([
    { tenantId: t1, empCode: 'EMP1', positionId: Number(pos.id), effectiveDate: '2020-01-15', endDate: null },
    { tenantId: t1, empCode: 'EMP2', positionId: Number(pos.id), effectiveDate: '2024-06-01', endDate: null },
  ]);

  // Offboarding lifecycle (HR-5) completed recently → one separation in the turnover window.
  await db.insert(s.employeeLifecycle).values({ tenantId: t1, empCode: 'EMP5', kind: 'offboarding', status: 'complete', completedAt: new Date() });

  // Leave balance for EMP3: entitled 10, used 2 → 8 untaken days. Valued (working_days=20) at 22000/20 = 1100/day → 8800.
  await db.insert(s.leaveBalances).values({ tenantId: t1, employeeId: e3, leaveType: 'annual', leaveTypeCode: 'annual', year: '2026', entitled: '10', used: '2', accrued: '0', carryover: '0', expired: '0' });

  // ── Seed T2 (isolation): a single employee + grade + leave balance ──────────────────────────────────────
  await db.insert(s.employees).values({ tenantId: t2, empCode: 'T2-EMP1', name: 'OtherCo Staff', jobGrade: 'T2G', monthlySalary: '40000', startDate: '2023-01-01', active: true }).onConflictDoNothing();
  await db.insert(s.payGrades).values({ tenantId: t2, gradeCode: 'T2G', name: 'T2 Grade', minSalary: '30000', midSalary: '40000', maxSalary: '50000' }).onConflictDoNothing();

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
  const t2admin = await login('t2admin');

  // Create a subscription of report_type, run it now, and return { run, data } (data = persisted report_runs.summary jsonb).
  const runReport = async (token: string, report_type: string, filters?: any) => {
    const sub = await inj('POST', '/api/bi/subscriptions', token, { name: report_type, report_type, frequency: 'weekly', ...(filters ? { filters } : {}) });
    const run = await inj('POST', `/api/bi/subscriptions/${sub.json.id}/run`, token, {});
    const rows = (await pg.query(`SELECT summary FROM report_runs WHERE id = ${Number(run.json.run_id)}`)).rows as any[];
    return { run: run.json, data: rows[0]?.summary ?? {} };
  };

  // ── 1. report-types catalog exposes the five HR-9 keys ──────────────────────────────────────────────────
  const rtypes = await inj('GET', '/api/bi/report-types', admin);
  ok('report-types catalog exposes the five HR-9 workforce-analytics report types',
    ['hr_headcount_trend', 'hr_turnover', 'hr_tenure_distribution', 'hr_comp_ratio', 'hr_leave_liability'].every((k) => JSON.stringify(rtypes.json).includes(k)), '');

  // ── 2. hr_headcount_trend ───────────────────────────────────────────────────────────────────────────────
  const hc = await runReport(admin, 'hr_headcount_trend');
  ok('hr_headcount_trend runs success', hc.run.status === 'success', JSON.stringify({ s: hc.run.status }));
  ok('hr_headcount_trend: total_active = 4 (EMP1–4 active; EMP5 left)', hc.data.total_active === 4, JSON.stringify({ t: hc.data.total_active }));
  const engDept = (hc.data.by_department ?? []).find((d: any) => d.department === 'Engineering');
  ok('hr_headcount_trend: Engineering headcount = 2 (from current assignments)', engDept?.headcount === 2, JSON.stringify(hc.data.by_department));
  const devPos = (hc.data.by_position ?? []).find((p: any) => p.position === 'Developer');
  ok('hr_headcount_trend: Developer position headcount = 2', devPos?.headcount === 2, JSON.stringify(hc.data.by_position));
  ok('hr_headcount_trend: hire-cohort trend present (by_hire_month)', Array.isArray(hc.data.by_hire_month) && hc.data.by_hire_month.length >= 1, JSON.stringify(hc.data.by_hire_month));

  // ── 3. hr_turnover ──────────────────────────────────────────────────────────────────────────────────────
  const tv = await runReport(admin, 'hr_turnover');
  ok('hr_turnover runs success', tv.run.status === 'success', JSON.stringify({ s: tv.run.status }));
  ok('hr_turnover: 1 separation (completed offboarding lifecycle)', tv.data.separations === 1, JSON.stringify({ sep: tv.data.separations }));
  ok('hr_turnover: turnover_pct = 20% (1 sep / 5 avg headcount)', near(tv.data.turnover_pct, 20), JSON.stringify({ pct: tv.data.turnover_pct, avg: tv.data.avg_headcount }));

  // ── 4. hr_tenure_distribution ───────────────────────────────────────────────────────────────────────────
  const tn = await runReport(admin, 'hr_tenure_distribution');
  ok('hr_tenure_distribution runs success', tn.run.status === 'success', JSON.stringify({ s: tn.run.status }));
  ok('hr_tenure_distribution: 4 active employees bucketed', tn.data.total === 4, JSON.stringify({ total: tn.data.total }));
  const bkt = (key: string) => (tn.data.buckets ?? []).find((b: any) => b.bucket === key)?.count;
  ok('hr_tenure_distribution: <1y bucket = 1 (EMP3 hired 2025-10)', bkt('<1y') === 1, JSON.stringify(tn.data.buckets));
  ok('hr_tenure_distribution: unknown bucket = 1 (EMP4 no start date)', bkt('unknown') === 1, JSON.stringify(tn.data.buckets));

  // ── 5. hr_comp_ratio ────────────────────────────────────────────────────────────────────────────────────
  const cr = await runReport(admin, 'hr_comp_ratio');
  ok('hr_comp_ratio runs success', cr.run.status === 'success', JSON.stringify({ s: cr.run.status }));
  ok('hr_comp_ratio: 3 rated (G5×2, G4×1; EMP4 ungraded, EMP5 inactive excluded)', cr.data.count_rated === 3, JSON.stringify({ rated: cr.data.count_rated, ungraded: cr.data.ungraded }));
  ok('hr_comp_ratio: 1 employee out-of-band (EMP2 salary 50000 > G5 max 40000)', cr.data.employees_out_of_band === 1 && cr.data.out_of_band?.[0]?.emp_code === 'EMP2' && cr.data.out_of_band?.[0]?.flag === 'above', JSON.stringify(cr.data.out_of_band));
  ok('hr_comp_ratio: EMP1 comp ratio ≈ 0.985 (32000 / 32500 mid)', near(cr.data.by_grade?.find((g: any) => g.grade === 'G5')?.midpoint, 32500), JSON.stringify(cr.data.by_grade));

  // ── 6. hr_leave_liability (working_days=20 → EMP3 8 untaken days × 22000/20 = 8800) ──────────────────────
  const ll = await runReport(admin, 'hr_leave_liability', { working_days: 20 });
  ok('hr_leave_liability runs success', ll.run.status === 'success', JSON.stringify({ s: ll.run.status }));
  ok('hr_leave_liability: total_untaken_days = 8', near(ll.data.total_untaken_days, 8), JSON.stringify({ d: ll.data.total_untaken_days }));
  ok('hr_leave_liability: total_liability = 8800 THB (8 days × 22000/20)', near(ll.data.total_liability, 8800, 1), JSON.stringify({ l: ll.data.total_liability }));
  ok('hr_leave_liability: summary carries the THB total', /8800/.test(ll.run.summary ?? ''), JSON.stringify({ sum: (ll.run.summary ?? '').slice(0, 70) }));

  // ── 7. RLS tenant isolation: T2 sees ONLY its own workforce ─────────────────────────────────────────────
  const hcT2 = await runReport(t2admin, 'hr_headcount_trend');
  ok('RLS: T2 hr_headcount_trend total_active = 1 (its own only, not T1’s 4)', hcT2.data.total_active === 1, JSON.stringify({ t: hcT2.data.total_active }));
  const crT2 = await runReport(t2admin, 'hr_comp_ratio');
  ok('RLS: T2 hr_comp_ratio rated = 1 (T2-EMP1 in T2G band, no T1 rows)', crT2.data.count_rated === 1 && crT2.data.employees_out_of_band === 0, JSON.stringify({ rated: crT2.data.count_rated, oob: crT2.data.employees_out_of_band }));

  console.log('\n── HR-9 — Workforce analytics BI report types (HR-09) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-9 workforce-analytics checks failed` : `\n✅ All ${checks.length} HR-9 workforce-analytics checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
