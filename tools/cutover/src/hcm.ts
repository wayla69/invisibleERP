/**
 * Phase 19 — HCM/Payroll depth. Employee w/ provident fund + hourly rate → log OT + unpaid leave →
 * run payroll (OT pay, PF, unpaid deduction, extended GL) → ภ.ง.ด.1ก annual. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // PAY-03 maker-checker
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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  const approver = (await inj('POST', '/api/login', undefined, { username: 'approver', password: 'admin123' })).json.token;

  // ── 1. employee: salary 30000, hourly 200, PF 5% ──
  const e = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', national_id: '1234567890123', bank_account: '123-4-56789-0', monthly_salary: 30000, hourly_rate: 200, pf_rate: 0.05 });
  const code = e.json.emp_code;
  ok('Create employee w/ PF 5% + hourly 200', e.status < 300 && /^EMP/.test(code ?? ''), JSON.stringify({ s: e.status }));

  // ── 2. attendance: 10 OT hours; 3. unpaid leave 2 days (approved) ──
  await inj('POST', '/api/hcm/timesheets', admin, { emp_code: code, work_date: '2026-06-15', ot_hours: 10 });
  const lv = await inj('POST', '/api/hcm/leave', admin, { emp_code: code, leave_type: 'unpaid', from_date: '2026-06-20', to_date: '2026-06-21', days: 2, paid: false });
  const appr = await inj('POST', `/api/hcm/leave/${lv.json.id}/approve`, admin);
  ok('Log 10h OT + approve 2-day unpaid leave', appr.json.status === 'Approved', JSON.stringify({ st: appr.json.status }));

  // ── 4. run payroll: OT 3000, unpaid 2000, gross 31000, PF 1500, WHT 220.83, net 28529.17 ──
  const run = await inj('POST', '/api/payroll/runs?period=2026-06', admin);
  ok('Payroll: OT 3000, unpaid 2000, gross 31000, PF ee 1500, WHT 220.83, net 28529.17',
    near(run.json.ot_total, 3000) && near(run.json.unpaid_total, 2000) && near(run.json.gross_total, 31000) &&
    near(run.json.pf_employee_total, 1500) && near(run.json.wht_total, 220.83) && near(run.json.net_total, 28529.17),
    JSON.stringify({ ot: run.json.ot_total, gross: run.json.gross_total, pf: run.json.pf_employee_total, net: run.json.net_total }));

  // ── 4b. PAY-03 maker-checker: a different user approves before the JE is effective ──
  const appro = await inj('POST', '/api/payroll/runs/2026-06/approve', approver);
  ok('Payroll run approved by a different user → Posted (PAY-03 SoD)', appro.json.status === 'Posted' && appro.json.approved_by === 'approver', JSON.stringify(appro.json));

  // ── 5. GL after approval: 5600 dr 31000, 5620 PF dr 1500, 2370 PF payable cr 3000, TB balanced ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (c: string) => (tb.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('GL: 5600 dr 31000, 5620 PF dr 1500, 2370 PF payable cr 3000, TB balanced',
    tb.json.totals?.balanced === true && near(row('5600')?.debit, 31000) && near(row('5620')?.debit, 1500) && near(row('2370')?.credit, 3000),
    JSON.stringify({ bal: tb.json.totals?.balanced, sal: row('5600')?.debit, pf: row('2370')?.credit }));

  // ── 6. ภ.ง.ด.1ก annual summary ──
  const pnd1a = await inj('GET', '/api/payroll/pnd1a?year=2026', admin);
  ok('ภ.ง.ด.1ก 2026: 1 employee, income 31000, WHT 220.83',
    pnd1a.json.headcount === 1 && near(pnd1a.json.total_income, 31000) && near(pnd1a.json.total_wht, 220.83),
    JSON.stringify({ h: pnd1a.json.headcount, inc: pnd1a.json.total_income, wht: pnd1a.json.total_wht }));

  // ── 7. ITGC-AC-19 (docs/24 R0-1) — employee PII is ciphertext AT REST but decrypts through the API ──
  // Raw SQL sees the stored bytes (v1:<iv>:<tag>:<ct>); the schema read decrypts, so PND1A still carries
  // the real citizen ID. The payslip snapshot column is encrypted independently of the employee master.
  const empRest: any = await pg.query('select national_id, bank_account from employees limit 1');
  const slipRest: any = await pg.query('select national_id from payslips limit 1');
  const erow = empRest.rows?.[0] ?? {}; const srow = slipRest.rows?.[0] ?? {};
  ok('ITGC-AC-19: citizen ID + bank account ciphertext at rest (employees + payslips)',
    String(erow.national_id ?? '').startsWith('v1:') && String(erow.bank_account ?? '').startsWith('v1:') && String(srow.national_id ?? '').startsWith('v1:'),
    JSON.stringify({ nid: String(erow.national_id ?? '').slice(0, 6), bank: String(erow.bank_account ?? '').slice(0, 6), slip: String(srow.national_id ?? '').slice(0, 6) }));
  ok('ITGC-AC-19: API still returns the decrypted citizen ID (PND1A line)',
    (pnd1a.json.lines ?? [])[0]?.national_id === '1234567890123', JSON.stringify((pnd1a.json.lines ?? [])[0]));

  console.log('\n── Phase 19 — HCM/Payroll depth (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HCM checks failed` : `\n✅ All ${checks.length} HCM checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
