/**
 * Phase D3 — Employee Self-Service over PGlite.
 * Proves an employee self-scopes to ONLY their own record: profile/leave/payslips/expenses are derived
 * from the JWT username (never a body param), leave + expense submit attach to the resolved employee,
 * a manager approval posts the reimbursement to GL, self-approval is blocked (SoD), and an unlinked
 * user is refused.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover ess
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ess-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'emp1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
    { username: 'mgr1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
    { username: 'ghost', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
    { username: 'E777', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }, // links to employee by emp_code (no user_name)
  ]).onConflictDoNothing();
  // employees linked to logins by user_name (E777 is linked only by emp_code → exercises the GL-9 SoD path)
  await db.insert(s.employees).values([
    { tenantId: t1, empCode: 'E001', name: 'Somchai', position: 'Cook', userName: 'emp1', monthlySalary: '20000' },
    { tenantId: t1, empCode: 'E002', name: 'Manager', position: 'GM', userName: 'mgr1', monthlySalary: '40000' },
    { tenantId: t1, empCode: 'E003', name: 'Other', position: 'Cook', userName: 'nobody', monthlySalary: '18000' },
    { tenantId: t1, empCode: 'E777', name: 'CodeLinked', position: 'Cook', monthlySalary: '15000' }, // user_name NULL
  ]).onConflictDoNothing();
  const empId = async (code: string) => Number((await db.select().from(s.employees).where(eq(s.employees.empCode, code)))[0].id);
  const [e1, e3] = [await empId('E001'), await empId('E003')];
  await db.insert(s.leaveBalances).values({ tenantId: t1, employeeId: e1, leaveType: 'annual', year: '2026', entitled: '10', used: '2' }).onConflictDoNothing();
  // a payslip for emp1 + one for the OTHER employee (must not leak to emp1)
  const prun = await db.insert(s.payruns).values({ tenantId: t1, period: '2026-05', status: 'Posted' }).returning({ id: s.payruns.id });
  await db.insert(s.payslips).values([
    { payrunId: Number(prun[0].id), tenantId: t1, employeeId: e1, empCode: 'E001', empName: 'Somchai', gross: '20000', net: '18500' },
    { payrunId: Number(prun[0].id), tenantId: t1, employeeId: e3, empCode: 'E003', empName: 'Other', gross: '18000', net: '16800' },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const emp1 = await login('emp1'); const mgr1 = await login('mgr1'); const ghost = await login('ghost');

  // 1. profile self-resolves
  const me = await inj('GET', '/api/ess/me', emp1);
  ok('ESS /me resolves the linked employee (E001)', me.json.employee?.emp_code === 'E001' && near(me.json.leave_balances?.[0]?.remaining, 8), JSON.stringify(me.json).slice(0, 110));

  // 2. unlinked user refused
  const g = await inj('GET', '/api/ess/me', ghost);
  ok('Unlinked user → 403 ESS_NO_EMPLOYEE', g.status === 403 && g.json.error?.code === 'ESS_NO_EMPLOYEE', `${g.status} ${g.json.error?.code}`);

  // 3. self leave request (emp derived from token, not body)
  const lv = await inj('POST', '/api/ess/leave', emp1, { from_date: '2026-07-01', to_date: '2026-07-02', days: 2, reason: 'trip' });
  ok('Self leave request → pending for E001', lv.json.status === 'Pending' && lv.json.emp_code === 'E001', JSON.stringify(lv.json));
  const lvList = await inj('GET', '/api/ess/leave', emp1);
  ok('ESS leave list shows only own requests', lvList.json.count === 1, JSON.stringify(lvList.json).slice(0, 60));

  // 4. payslips self-scoped (must NOT see the other employee's slip)
  const ps = await inj('GET', '/api/ess/payslips', emp1);
  ok('ESS payslips self-scoped (1 own, no leak)', ps.json.count === 1 && ps.json.payslips?.[0]?.emp_code === 'E001', JSON.stringify(ps.json).slice(0, 80));

  // 5. expense submit + manager approve → AP reimbursement payable raised (GL Dr 5100 / Cr 2000 + AP sub-ledger)
  const ex = await inj('POST', '/api/ess/expenses', emp1, { category: 'travel', amount: 500, description: 'taxi' });
  ok('Expense submit → pending', ex.json.status === 'Pending' && near(ex.json.amount, 500), JSON.stringify(ex.json));
  const ap = await inj('POST', `/api/ess/expenses/${ex.json.id}/decide`, mgr1, { approve: true });
  ok('Manager approve → AP reimbursement payable (AP-) raised', ap.json.status === 'Approved' && /^AP-/.test(ap.json.ap_txn_no ?? '') && ap.json.payable === true, `${ap.status} ${JSON.stringify(ap.json)}`);
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${ap.json.ap_txn_no}'`)).rows as any[];
  ok('Reimbursement GL balanced: Dr 5100=500, Cr 2000=500', near(gl.filter((l) => l.account_code === '5100').reduce((a, l) => a + Number(l.debit || 0), 0), 500) && near(gl.filter((l) => l.account_code === '2000').reduce((a, l) => a + Number(l.credit || 0), 0), 500), JSON.stringify(gl));
  // the reimbursement is now a payable in the AP sub-ledger (settle-able via the AP pay flow)
  const apRow = (await pg.query(`SELECT txn_no, amount, status FROM ap_transactions WHERE txn_no='${ap.json.ap_txn_no}'`)).rows as any[];
  ok('Reimbursement is an AP payable (sub-ledger)', apRow.length === 1 && near(apRow[0].amount, 500) && apRow[0].status === 'Unpaid', JSON.stringify(apRow));

  // 6. SoD: claimant cannot approve their own expense
  const ex2 = await inj('POST', '/api/ess/expenses', mgr1, { category: 'meal', amount: 200 });
  const self = await inj('POST', `/api/ess/expenses/${ex2.json.id}/decide`, mgr1, { approve: true });
  ok('Self-approve own expense → 400 SOD_SELF_APPROVAL', self.status === 400 && self.json.error?.code === 'SOD_SELF_APPROVAL', `${self.status} ${self.json.error?.code}`);

  // 6b. SoD via emp_code link only (no user_name): claimant STILL cannot self-approve (W5/GL-9 fix)
  const ecTok = (await inj('POST', '/api/login', undefined, { username: 'E777', password: 'pw' })).json.token as string;
  const ex3 = await inj('POST', '/api/ess/expenses', ecTok, { category: 'meal', amount: 150 });
  const self2 = await inj('POST', `/api/ess/expenses/${ex3.json.id}/decide`, ecTok, { approve: true });
  ok('Self-approve via emp_code link (user_name NULL) → 400 SOD_SELF_APPROVAL', self2.status === 400 && self2.json.error?.code === 'SOD_SELF_APPROVAL', `${self2.status} ${self2.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── Phase D3 — Employee Self-Service (ESS) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} ess checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} ess checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
