/**
 * C2b — Payroll cutover. Create employees → run monthly payroll → SSO + PIT(ภ.ง.ด.1) withheld,
 * ONE balanced GL entry, idempotent per (tenant, period), ภ.ง.ด.1 summary. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover payroll
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pay-secret';
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
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

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

  // ── 1. create two employees (30k → SSO capped 750 + WHT; 12k → SSO 600, no WHT) ──
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', national_id: '1234567890123', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', national_id: '9876543210987', monthly_salary: 12000 });
  ok('Create employees (auto emp_code, tenant-scoped)', e1.status < 300 && e2.status < 300 && /^EMP/.test(e1.json.emp_code ?? ''), JSON.stringify({ a: e1.json.emp_code, sa: e1.status }));

  const emps = await inj('GET', '/api/payroll/employees', admin);
  ok('List active employees → 2', emps.json.count === 2, `count=${emps.json.count}`);

  // ── 2. run payroll for 2026-06 → SSO + WHT computed, balanced GL ──
  const run = await inj('POST', '/api/payroll/runs?period=2026-06', admin);
  ok('Run payroll → JE posted',
    /^JE-/.test(run.json.entry_no ?? '') && run.json.headcount === 2, JSON.stringify({ e: run.json.entry_no, h: run.json.headcount }));
  ok('Gross 42,000 / SSO ee 1,350 / SSO er 1,350 / WHT 170.83 / net 40,479.17',
    near(run.json.gross_total, 42000) && near(run.json.sso_employee_total, 1350) && near(run.json.sso_employer_total, 1350) &&
    near(run.json.wht_total, 170.83) && near(run.json.net_total, 40479.17),
    JSON.stringify({ g: run.json.gross_total, ee: run.json.sso_employee_total, w: run.json.wht_total, net: run.json.net_total }));

  // ── 3. GL: trial balance balanced; expense + payables correct ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (code: string) => (tb.json.rows ?? []).find((r: any) => r.account_code === code);
  ok('Trial balance balanced', tb.json.totals?.balanced === true, `bal=${tb.json.totals?.balanced}`);
  ok('5600 Salaries dr 42,000; 5610 Employer-SSO dr 1,350',
    near(row('5600')?.debit, 42000) && near(row('5610')?.debit, 1350),
    JSON.stringify({ s5600: row('5600')?.debit, s5610: row('5610')?.debit }));
  ok('2350 SSO payable cr 2,700 (ee+er); 2360 WHT payable cr 170.83',
    near(row('2350')?.credit, 2700) && near(row('2360')?.credit, 170.83),
    JSON.stringify({ s2350: row('2350')?.credit, s2360: row('2360')?.credit }));

  // ── 4. idempotent per period ──
  const rerun = await inj('POST', '/api/payroll/runs?period=2026-06', admin);
  ok('Re-run same period → already (idempotent)', rerun.json.already === true, JSON.stringify(rerun.json).slice(0, 60));

  // ── 5. ภ.ง.ด.1 monthly WHT remittance summary ──
  const pnd1 = await inj('GET', '/api/payroll/pnd1?period=2026-06', admin);
  ok('ภ.ง.ด.1: 2 lines, total income 42,000, total WHT 170.83',
    pnd1.json.headcount === 2 && near(pnd1.json.total_income, 42000) && near(pnd1.json.total_wht, 170.83),
    JSON.stringify({ h: pnd1.json.headcount, inc: pnd1.json.total_income, wht: pnd1.json.total_wht }));

  // ── 6. payslips retrievable with per-employee net ──
  const slips = await inj('GET', '/api/payroll/runs/2026-06/slips', admin);
  const somchai = (slips.json.slips ?? []).find((x: any) => x.emp_name === 'Somchai');
  ok('Payslips: Somchai net 29,079.17 (30k − 750 SSO − 170.83 WHT)',
    slips.json.count === 2 && near(somchai?.net, 29079.17),
    JSON.stringify({ n: slips.json.count, net: somchai?.net }));

  console.log('\n── C2b — payroll (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} payroll checks failed` : `\n✅ All ${checks.length} payroll checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
