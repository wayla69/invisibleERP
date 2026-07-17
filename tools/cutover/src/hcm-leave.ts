/**
 * HR-2 (docs/42) — Leave accrual engine + policies (control HR-02). Over PGlite.
 * Covers: create leave type (monthly 1.25 d), policy override by grade, accrual run credits `accrued`,
 * re-run same period is idempotent (no double), request within balance OK, request over balance blocked
 * (INSUFFICIENT_LEAVE_BALANCE), carryover cap applied at year boundary, and per-tenant RLS isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-leave
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-leave-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { runInTenantContext } from '../../../apps/api/dist/common/tenant-run';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const raw: any = drizzle(pg, { schema: s });
  const db = tenantAwareProxy(raw);
  const pw = new PasswordService();

  await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, async () => {
    await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
    for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
      await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
    await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'BR2', name: 'Branch 2' }]).onConflictDoNothing();
  });
  const t1 = Number((await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, () => db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ'))))[0].id);
  const t2 = Number((await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, () => db.select().from(s.tenants).where(eq(s.tenants.code, 'BR2'))))[0].id);
  await runInTenantContext(db, { tenantId: null, bypass: true, actor: 'seed' }, async () => {
    await db.insert(s.users).values([
      { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // HQ bypass — approves leave (≠ requester)
      { username: 't1sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // non-bypass, T1-scoped (has 'exec')
      { username: 't2sales', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t2 },    // non-bypass, T2-scoped
    ]).onConflictDoNothing();
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'admin123' })).json.token;
  const admin = await login('admin');
  const t1s = await login('t1sales');
  const t2s = await login('t2sales');

  // ── 1. leave type: ANNUAL, monthly accrual 1.25 d, carryover cap 5, max balance 30 ──
  const ct = await inj('POST', '/api/hcm/leave/types', t1s, { code: 'annual', name: 'พักร้อน', accrual_method: 'monthly', accrual_rate_days: 1.25, carryover_cap_days: 5, max_balance_days: 30 });
  ok('Create leave type (monthly 1.25 d, cap 5, max 30)', ct.status < 300 && ct.json.accrual_method === 'monthly', JSON.stringify({ s: ct.status, id: ct.json.id }));

  // ── 2. policy override: grade M2 → 2.0 d/period ──
  const cp = await inj('POST', '/api/hcm/leave/policies', t1s, { leave_type_code: 'annual', job_grade: 'M2', accrual_rate_days: 2.0 });
  ok('Create policy override (grade M2 → 2.0 d)', cp.status < 300 && near(cp.json.accrual_rate_days, 2.0), JSON.stringify({ s: cp.status }));

  // ── 3. employees: A (grade M2), B (grade M1), C (grade M1) — all in T1 ──
  const mkEmp = async (name: string, grade: string) => (await inj('POST', '/api/payroll/employees', admin, { name, job_grade: grade, monthly_salary: 30000, start_date: '2020-01-15' })).json;
  const eA = await mkEmp('สมชาย M2', 'M2');
  const eB = await mkEmp('สมหญิง M1', 'M1');
  const eC = await mkEmp('สมปอง M1', 'M1');
  ok('Create 3 employees (A=M2, B=M1, C=M1)', /^EMP/.test(eA.emp_code) && /^EMP/.test(eB.emp_code) && /^EMP/.test(eC.emp_code), JSON.stringify({ a: eA.emp_code, grade: eA.job_grade }));

  // Seed C's PRIOR-year (2025) balance with 8 accrued days so the year-boundary carryover cap can be exercised.
  await runInTenantContext(db, { tenantId: t1, bypass: false, actor: 'seed' }, async () => {
    await db.insert(s.leaveBalances).values({ tenantId: t1, employeeId: Number(eC.id), leaveType: 'annual', leaveTypeCode: 'annual', year: '2025', entitled: '0', accrued: '8', carryover: '0', used: '0', expired: '0' });
  });

  // ── 4. accrual run for 2026-06 (first 2026 run — creates every 2026 balance) ──
  const run = await inj('POST', '/api/hcm/leave/accrual/run', t1s, { period: '2026-06' });
  ok('Accrual run 2026-06: 3 employees, total 4.5 d (2.0 + 1.25 + 1.25)', run.json.already === false && run.json.employees_count === 3 && near(run.json.accrued, 4.5), JSON.stringify(run.json));

  const balOf = async (empCode: string, year: string) => {
    const b = await inj('GET', `/api/hcm/leave/balances?emp_code=${empCode}`, t1s);
    return (b.json.balances ?? []).find((r: any) => String(r.year) === year) ?? null;
  };
  const bA = await balOf(eA.emp_code, '2026');
  const bB = await balOf(eB.emp_code, '2026');
  ok('HR-2 policy override: A (M2) accrued 2.0', bA && near(bA.accrued, 2.0), JSON.stringify(bA));
  ok('HR-2 type default: B (M1) accrued 1.25', bB && near(bB.accrued, 1.25), JSON.stringify(bB));

  // Carryover cap: C's 2026 row carries min(8,5)=5; the 2025 row records expired 3.
  const bC26 = await balOf(eC.emp_code, '2026');
  const bC25 = await balOf(eC.emp_code, '2025');
  ok('HR-2 carryover cap: C 2026 carryover = 5 (min of 8 vs cap 5)', bC26 && near(bC26.carryover, 5), JSON.stringify(bC26));
  ok('HR-2 carryover cap: C 2025 expired = 3 (lost beyond cap)', bC25 && near(bC25.expired, 3), JSON.stringify(bC25));

  // ── 5. idempotency: re-run 2026-06 is a no-op ──
  const rerun = await inj('POST', '/api/hcm/leave/accrual/run', t1s, { period: '2026-06' });
  const bA2 = await balOf(eA.emp_code, '2026');
  ok('HR-2 idempotent: re-run 2026-06 → already, A still 2.0 (no double-accrual)', rerun.json.already === true && bA2 && near(bA2.accrued, 2.0), JSON.stringify({ already: rerun.json.already, a: bA2?.accrued }));

  // ── 6. entitlement gate — request WITHIN balance is accepted ──
  const lvOk = await inj('POST', '/api/hcm/leave', t1s, { emp_code: eA.emp_code, leave_type: 'annual', from_date: '2026-06-25', to_date: '2026-06-26', days: 1.5, paid: true });
  ok('HR-02 gate: request 1.5 d within A available 2.0 → Pending', lvOk.status < 300 && lvOk.json.status === 'Pending', JSON.stringify({ s: lvOk.status, code: lvOk.json?.error?.code }));

  // ── 7. entitlement gate — request OVER balance is blocked ──
  const lvOver = await inj('POST', '/api/hcm/leave', t1s, { emp_code: eB.emp_code, leave_type: 'annual', from_date: '2026-06-25', to_date: '2026-06-27', days: 2, paid: true });
  ok('HR-02 gate: request 2 d over B available 1.25 → INSUFFICIENT_LEAVE_BALANCE', lvOver.status === 400 && lvOver.json?.error?.code === 'INSUFFICIENT_LEAVE_BALANCE', JSON.stringify({ s: lvOver.status, code: lvOver.json?.error?.code }));

  // ── 8. unpaid leave bypasses the gate (unpaid does not consume the entitlement) ──
  const lvUnpaid = await inj('POST', '/api/hcm/leave', t1s, { emp_code: eB.emp_code, leave_type: 'annual', from_date: '2026-06-25', to_date: '2026-06-30', days: 5, paid: false });
  ok('HR-02 gate: unpaid 5 d over balance still allowed (not gated)', lvUnpaid.status < 300 && lvUnpaid.json.status === 'Pending', JSON.stringify({ s: lvUnpaid.status }));

  // ── 9. approval remains maker-checker (approver ≠ requester) — self-approval blocked ──
  const selfAppr = await inj('POST', `/api/hcm/leave/${lvOk.json.id}/approve`, t1s);
  ok('Leave self-approval still blocked (SoD)', selfAppr.status === 403 && selfAppr.json?.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfAppr.status, code: selfAppr.json?.error?.code }));
  const appr = await inj('POST', `/api/hcm/leave/${lvOk.json.id}/approve`, admin);
  const bA3 = await balOf(eA.emp_code, '2026');
  ok('Leave approve (distinct approver) → used 1.5, available 0.5', appr.json.status === 'Approved' && bA3 && near(bA3.used, 1.5) && near(bA3.available, 0.5), JSON.stringify({ st: appr.json.status, used: bA3?.used, avail: bA3?.available }));

  // ── 10. allow_negative type relaxes the gate ──
  await inj('POST', '/api/hcm/leave/types', t1s, { code: 'special', name: 'ลาพิเศษ', accrual_method: 'none', allow_negative: true });
  const lvNeg = await inj('POST', '/api/hcm/leave', t1s, { emp_code: eB.emp_code, leave_type: 'special', from_date: '2026-06-25', to_date: '2026-06-26', days: 3, paid: true });
  ok('HR-02 gate: allow_negative type → request over (zero) balance allowed', lvNeg.status < 300 && lvNeg.json.status === 'Pending', JSON.stringify({ s: lvNeg.status }));

  // ── 11. RLS isolation — a T2 user only ever sees T2 leave types + a T2-scoped accrual run ──
  await inj('POST', '/api/hcm/leave/types', t2s, { code: 'brannual', name: 'พักร้อน BR2', accrual_method: 'monthly', accrual_rate_days: 1 });
  const t2types = await inj('GET', '/api/hcm/leave/types', t2s);
  const t1types = await inj('GET', '/api/hcm/leave/types', t1s);
  const t2codes = (t2types.json.leave_types ?? []).map((x: any) => x.code);
  const t1codes = (t1types.json.leave_types ?? []).map((x: any) => x.code);
  ok('RLS: T2 sees only its own leave type (brannual), not T1 annual', t2codes.includes('brannual') && !t2codes.includes('annual') && t1codes.includes('annual') && !t1codes.includes('brannual'), JSON.stringify({ t2: t2codes, t1: t1codes }));

  await inj('POST', '/api/payroll/employees', t2s, { name: 'BR2 emp', job_grade: 'M1', monthly_salary: 20000, start_date: '2021-01-01' }).catch(() => null);
  // T2 has 0 or 1 employees; the accrual run must count ONLY T2 employees (never T1's 3).
  const t2run = await inj('POST', '/api/hcm/leave/accrual/run', t2s, { period: '2026-06' });
  ok('RLS: T2 accrual run counts only T2 employees (< T1 3)', t2run.status < 300 && Number(t2run.json.employees_count) < 3, JSON.stringify(t2run.json));

  // ── PE-3 (privilege-escalation audit): an `ess` self-service caller reads ONLY their OWN balances ──
  await runInTenantContext(db, { tenantId: t1, bypass: false, actor: 'seed' }, async () => {
    await db.update(s.employees).set({ userName: 'empa' }).where(eq(s.employees.empCode, eA.emp_code));
  });
  const empaUid = Number((await db.insert(s.users).values({ username: 'empa', passwordHash: await pw.hash('admin123'), role: 'Cashier', tenantId: t1 }).returning({ id: s.users.id }))[0].id);
  await db.insert(s.userPermissions).values([{ userId: empaUid, perm: 'ess' }]).onConflictDoNothing(); // ess-only (override) → not HR
  const empa = await login('empa');
  const ownList = await inj('GET', '/api/hcm/leave/balances', empa);
  const ownRows = ownList.json.balances ?? [];
  ok('PE-3: ess caller with no emp_code sees only their OWN balances (no tenant-wide dump)',
    ownRows.length > 0 && ownRows.every((r: any) => Number(r.employee_id) === Number(eA.id)),
    JSON.stringify({ n: ownRows.length, ids: [...new Set(ownRows.map((r: any) => r.employee_id))] }));
  const spyB = await inj('GET', `/api/hcm/leave/balances?emp_code=${eB.emp_code}`, empa);
  const spyRows = spyB.json.balances ?? [];
  ok('PE-3: ess caller cannot read a colleague’s balances via emp_code (own-scoped, not eB)',
    spyRows.every((r: any) => Number(r.employee_id) === Number(eA.id)),
    JSON.stringify({ bId: Number(eB.id), ids: [...new Set(spyRows.map((r: any) => r.employee_id))] }));

  console.log('\n── HR-2 — Leave accrual engine + policies (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-2 leave-accrual checks failed` : `\n✅ All ${checks.length} HR-2 leave-accrual checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
