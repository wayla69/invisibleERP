/**
 * HR-6 (docs/42, Wave 2) — Compensation bands + benefits, control HR-06 (comp-change maker-checker within
 * band). Boots the AppModule over PGlite, seeds a tenant + role/permission fixtures, and drives the comp
 * endpoints end-to-end: pay-grade bands, in-band vs OUT_OF_BAND comp changes, the exec override (audit-logged),
 * the SOD_SELF_APPROVAL maker-checker + employee-salary write on approval, reject-leaves-salary-unchanged,
 * benefit plans/enrolments (+ end + ess own-scope), and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-comp
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-comp-secret';
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

  // Two separate companies (org_id NULL ⇒ each isolated to its own tenant in multi-company mode).
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CO2', name: 'Second Co' }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'CO2')))[0].id);

  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // exec (override + approve path)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr_admin (create + approve)
    { username: 'hrmaker', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr only (create, cannot override/approve)
    { username: 'essuser', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // ess (own-scope enrolment read)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },    // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrmaker'), perm: 'hr' },
    { userId: await uid('essuser'), perm: 'ess' },
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
  const hrmaker = await login('hrmaker');
  const essuser = await login('essuser');
  const t2admin = await login('t2admin');

  // Two employees on the shared payroll identity (T1); link emp2 to the ess login for own-scope reads.
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', monthly_salary: 28000 });
  const emp1 = e1.json.emp_code; const emp2 = e2.json.emp_code;
  await db.update(s.employees).set({ userName: 'essuser' }).where(eq(s.employees.empCode, emp2));
  ok('Seed two employees on payroll identity', /^EMP/.test(emp1 ?? '') && /^EMP/.test(emp2 ?? ''), JSON.stringify({ emp1, emp2 }));

  // ── 1. Pay grades ────────────────────────────────────────────────────────
  const g5 = await inj('POST', '/api/hcm/comp/grades', hradmin, { grade_code: 'G5', name: 'Grade 5', min_salary: 25000, mid_salary: 32500, max_salary: 40000 });
  ok('hr_admin creates a pay grade band', g5.status < 300 && g5.json.grade_code === 'G5', JSON.stringify({ s: g5.status }));
  const gDup = await inj('POST', '/api/hcm/comp/grades', hradmin, { grade_code: 'G5', name: 'Dup', min_salary: 1, max_salary: 2 });
  ok('Duplicate grade_code rejected (GRADE_EXISTS)', gDup.status === 400 && gDup.json?.error?.code === 'GRADE_EXISTS', JSON.stringify({ s: gDup.status, c: gDup.json?.error?.code }));
  const gradesList = await inj('GET', '/api/hcm/comp/grades', hrmaker);
  ok('hr (read) user CAN list grades', gradesList.status === 200 && gradesList.json.count >= 1, JSON.stringify({ s: gradesList.status, c: gradesList.json.count }));

  // ── 2. Comp changes + HR-06 band check ───────────────────────────────────
  const inBand = await inj('POST', '/api/hcm/comp/changes', hrmaker, { emp_code: emp1, change_type: 'merit', new_salary: 35000, new_grade: 'G5', reason: 'annual merit' });
  ok('In-band comp change is accepted (pending)', inBand.status < 300 && inBand.json.status === 'pending' && inBand.json.out_of_band_overridden === false, JSON.stringify({ s: inBand.status }));

  const outBand = await inj('POST', '/api/hcm/comp/changes', hrmaker, { emp_code: emp1, change_type: 'promotion', new_salary: 50000, new_grade: 'G5' });
  ok('HR-06: out-of-band comp change BLOCKED (OUT_OF_BAND) for a non-override maker', outBand.status === 400 && outBand.json?.error?.code === 'OUT_OF_BAND', JSON.stringify({ s: outBand.status, c: outBand.json?.error?.code }));

  const outBandNoFlag = await inj('POST', '/api/hcm/comp/changes', hradmin, { emp_code: emp1, change_type: 'promotion', new_salary: 50000, new_grade: 'G5' });
  ok('HR-06: hr_admin still needs the explicit override flag (OUT_OF_BAND without it)', outBandNoFlag.status === 400 && outBandNoFlag.json?.error?.code === 'OUT_OF_BAND', JSON.stringify({ s: outBandNoFlag.status, c: outBandNoFlag.json?.error?.code }));

  const override = await inj('POST', '/api/hcm/comp/changes', admin, { emp_code: emp1, change_type: 'promotion', new_salary: 50000, new_grade: 'G5', override: true, reason: 'board-approved retention' });
  ok('HR-06: exec override allows an out-of-band change (out_of_band_overridden=true)', override.status < 300 && override.json.out_of_band_overridden === true, JSON.stringify({ s: override.status, o: override.json.out_of_band_overridden }));
  const slog: any = await pg.query(`select * from doc_status_log where doc_type='COMPCHG'`);
  ok('HR-06: out-of-band override is audit-logged (doc_status_log COMPCHG, OUT_OF_BAND_OVERRIDE)', (slog.rows?.length ?? 0) >= 1 && String(slog.rows?.[0]?.remarks ?? '').includes('OUT_OF_BAND_OVERRIDE'), JSON.stringify({ n: slog.rows?.length }));

  // ── 3. Maker-checker approval (HR-06) ────────────────────────────────────
  const inBandId = inBand.json.id;
  const selfApprove = await inj('POST', `/api/hcm/comp/changes/${inBandId}/approve`, hradmin, {});
  // hrmaker requested it; hradmin ≠ requester so hradmin CAN approve it — instead test self-approval with a hradmin-requested change:
  ok('A distinct approver (hr_admin ≠ requester hrmaker) may approve', selfApprove.status < 300 && selfApprove.json.status === 'approved', JSON.stringify({ s: selfApprove.status }));
  const salAfter: any = await pg.query(`select monthly_salary from employees where emp_code='${emp1}'`);
  ok('HR-06: employee monthly_salary updated ONLY on approval (30000 → 35000)', Number(salAfter.rows?.[0]?.monthly_salary) === 35000, JSON.stringify({ sal: salAfter.rows?.[0]?.monthly_salary }));

  // Self-approval guard: hradmin creates a change then tries to approve their OWN request.
  const ownChange = await inj('POST', '/api/hcm/comp/changes', hradmin, { emp_code: emp2, change_type: 'merit', new_salary: 30000, new_grade: 'G5' });
  const ownApprove = await inj('POST', `/api/hcm/comp/changes/${ownChange.json.id}/approve`, hradmin, {});
  ok('HR-06: requester CANNOT approve their own comp change (SOD_SELF_APPROVAL, 403)', ownApprove.status === 403 && ownApprove.json?.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: ownApprove.status, c: ownApprove.json?.error?.code }));
  const emp2Before: any = await pg.query(`select monthly_salary from employees where emp_code='${emp2}'`);
  ok('HR-06: a pending (self-blocked) change leaves employee salary unchanged (still 28000)', Number(emp2Before.rows?.[0]?.monthly_salary) === 28000, JSON.stringify({ sal: emp2Before.rows?.[0]?.monthly_salary }));

  // Reject leaves salary unchanged; a different user (admin) rejects hradmin's pending change.
  const rej = await inj('POST', `/api/hcm/comp/changes/${ownChange.json.id}/reject`, admin, {});
  ok('HR-06: a distinct user can reject a pending change', rej.status < 300 && rej.json.status === 'rejected', JSON.stringify({ s: rej.status }));
  const emp2After: any = await pg.query(`select monthly_salary from employees where emp_code='${emp2}'`);
  ok('HR-06: reject leaves employee salary unchanged (still 28000)', Number(emp2After.rows?.[0]?.monthly_salary) === 28000, JSON.stringify({ sal: emp2After.rows?.[0]?.monthly_salary }));

  // hr-only maker cannot approve (approval gated hr_admin/exec).
  const change3 = await inj('POST', '/api/hcm/comp/changes', hrmaker, { emp_code: emp2, change_type: 'adjustment', new_salary: 31000, new_grade: 'G5' });
  const makerApprove = await inj('POST', `/api/hcm/comp/changes/${change3.json.id}/approve`, hrmaker, {});
  ok('An hr-only maker CANNOT approve (403; approval reserved to hr_admin/exec)', makerApprove.status === 403, JSON.stringify({ s: makerApprove.status }));

  // ── 4. Benefit plans + enrolments ─────────────────────────────────────────
  const plan = await inj('POST', '/api/hcm/comp/benefit-plans', hradmin, { plan_code: 'HMO', name: 'Health HMO', category: 'health', employer_cost: 1500, employee_cost: 500 });
  ok('Create a benefit plan', plan.status < 300 && plan.json.plan_code === 'HMO', JSON.stringify({ s: plan.status }));
  const enr1 = await inj('POST', '/api/hcm/comp/enrollments', hradmin, { emp_code: emp1, plan_code: 'HMO' });
  const enr2 = await inj('POST', '/api/hcm/comp/enrollments', hradmin, { emp_code: emp2, plan_code: 'HMO' });
  ok('Enrol two employees into a benefit plan', enr1.status < 300 && enr2.status < 300, JSON.stringify({ s1: enr1.status, s2: enr2.status }));
  const enrDup = await inj('POST', '/api/hcm/comp/enrollments', hradmin, { emp_code: emp1, plan_code: 'HMO' });
  ok('Duplicate active enrolment rejected (ALREADY_ENROLLED)', enrDup.status === 400 && enrDup.json?.error?.code === 'ALREADY_ENROLLED', JSON.stringify({ s: enrDup.status, c: enrDup.json?.error?.code }));
  const enrEnd = await inj('POST', `/api/hcm/comp/enrollments/${enr1.json.id}/end`, hradmin, {});
  ok('End an enrolment (status → ended)', enrEnd.status < 300 && enrEnd.json.status === 'ended', JSON.stringify({ s: enrEnd.status }));

  // ess own-scope: essuser (linked to emp2) sees only their own enrolments, not emp1's.
  const essView = await inj('GET', '/api/hcm/comp/enrollments', essuser);
  const essCodes = (essView.json.enrollments ?? []).map((r: any) => r.emp_code);
  ok('ess user sees ONLY their own enrolments (own-scope read)', essView.status === 200 && essCodes.length >= 1 && essCodes.every((c: string) => c === emp2), JSON.stringify({ essCodes }));

  // ── 5. RLS tenant isolation ──────────────────────────────────────────────
  const t2grade = await inj('POST', '/api/hcm/comp/grades', t2admin, { grade_code: 'T2G', name: 'T2 Grade', min_salary: 1, max_salary: 9 });
  ok('T2 admin can create its own pay grade', t2grade.status < 300, JSON.stringify({ s: t2grade.status }));
  const t1grades = (await inj('GET', '/api/hcm/comp/grades', admin)).json.grades ?? [];
  const t2grades = (await inj('GET', '/api/hcm/comp/grades', t2admin)).json.grades ?? [];
  const t1codes = t1grades.map((g: any) => g.grade_code); const t2codes = t2grades.map((g: any) => g.grade_code);
  ok('RLS: T1 does NOT see T2G; T2 does NOT see G5 (tenant isolation)', t1codes.includes('G5') && !t1codes.includes('T2G') && t2codes.includes('T2G') && !t2codes.includes('G5'), JSON.stringify({ t1codes, t2codes }));

  console.log('\n── HR-6 — Compensation bands + benefits (control HR-06) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-6 comp checks failed` : `\n✅ All ${checks.length} HR-6 comp checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
