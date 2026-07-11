/**
 * C2b — Payroll cutover. Create employees → run monthly payroll → SSO + PIT(ภ.ง.ด.1) withheld,
 * ONE balanced GL entry, idempotent per (tenant, period), ภ.ง.ด.1 summary. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover payroll
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pay-secret';
process.env.NODE_ENV = 'test';
// A sender is on file so the payslip-email path reaches the transport (→ 503 EMAIL_NOT_CONFIGURED with SMTP
// unset), proving the flow is complete rather than tripping the earlier no-sender guard.
process.env.MAIL_FROM = process.env.MAIL_FROM || 'hr@example.com';

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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'อีกบริษัท' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T2')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // PAY-03: a DIFFERENT same-tenant user approves the run
    { username: 'hqadmin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: null }, // HQ super-admin: no tenant → must name one to run payroll
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
  // Raw variant for the payslip PDF endpoints (a PDF/HTML body is not JSON): expose the status, the raw body
  // and the content-type so the document render + PDPA gating can be asserted regardless of Chromium presence.
  const injRaw = async (m: string, url: string, token?: string) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: String(res.body ?? ''), ctype: String(res.headers['content-type'] ?? '') };
  };
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  const approver = (await inj('POST', '/api/login', undefined, { username: 'approver', password: 'admin123' })).json.token;

  // ── 1. create two employees (30k → SSO capped 750 + WHT; 12k → SSO 600, no WHT) ──
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', national_id: '1234567890123', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', national_id: '9876543210987', monthly_salary: 12000 });
  ok('Create employees (auto emp_code, tenant-scoped)', e1.status < 300 && e2.status < 300 && /^EMP/.test(e1.json.emp_code ?? ''), JSON.stringify({ a: e1.json.emp_code, sa: e1.status }));

  const emps = await inj('GET', '/api/payroll/employees', admin);
  ok('List active employees → 2', emps.json.count === 2, `count=${emps.json.count}`);

  // ── 2. run payroll for 2026-06 → SSO + WHT computed, balanced GL ──
  const run = await inj('POST', '/api/payroll/runs?period=2026-06', admin);
  ok('Run payroll → JE created PendingApproval (PAY-03: not yet posted)',
    /^JE-/.test(run.json.entry_no ?? '') && run.json.headcount === 2 && run.json.status === 'PendingApproval', JSON.stringify({ e: run.json.entry_no, h: run.json.headcount, st: run.json.status }));
  ok('Gross 42,000 / SSO ee 1,350 / SSO er 1,350 / WHT 170.83 / net 40,479.17',
    near(run.json.gross_total, 42000) && near(run.json.sso_employee_total, 1350) && near(run.json.sso_employer_total, 1350) &&
    near(run.json.wht_total, 170.83) && near(run.json.net_total, 40479.17),
    JSON.stringify({ g: run.json.gross_total, ee: run.json.sso_employee_total, w: run.json.wht_total, net: run.json.net_total }));

  // ── 3. PAY-03 maker-checker: the Draft JE is EXCLUDED from balances until a different user approves ──
  const tbBefore = await inj('GET', '/api/ledger/trial-balance', admin);
  const rowB = (code: string) => (tbBefore.json.rows ?? []).find((r: any) => r.account_code === code);
  ok('Before approval: payroll JE is Draft → 5600 excluded from trial balance (0 / absent)',
    !rowB('5600') || near(rowB('5600')?.debit, 0), JSON.stringify({ s5600: rowB('5600')?.debit ?? 'absent' }));
  const selfApprove = await inj('POST', '/api/payroll/runs/2026-06/approve', admin);
  ok('Maker cannot approve own run → 403 SOD_VIOLATION', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_VIOLATION', `${selfApprove.status} ${selfApprove.json.error?.code}`);
  const approve = await inj('POST', '/api/payroll/runs/2026-06/approve', approver);
  ok('Different user approves → Posted (approved_by ≠ prepared_by)',
    approve.json.status === 'Posted' && approve.json.approved_by === 'approver' && approve.json.prepared_by === 'admin', JSON.stringify(approve.json));

  // ── 4. GL after approval: trial balance balanced; expense + payables correct ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (code: string) => (tb.json.rows ?? []).find((r: any) => r.account_code === code);
  ok('Trial balance balanced', tb.json.totals?.balanced === true, `bal=${tb.json.totals?.balanced}`);
  ok('After approval: 5600 Salaries dr 42,000; 5610 Employer-SSO dr 1,350',
    near(row('5600')?.debit, 42000) && near(row('5610')?.debit, 1350),
    JSON.stringify({ s5600: row('5600')?.debit, s5610: row('5610')?.debit }));
  ok('2350 SSO payable cr 2,700 (ee+er); 2360 WHT payable cr 170.83',
    near(row('2350')?.credit, 2700) && near(row('2360')?.credit, 170.83),
    JSON.stringify({ s2350: row('2350')?.credit, s2360: row('2360')?.credit }));

  // ── 4a-bis. PAY-02: payroll-liability schedule (outstanding vs payrun accrual) + cash remittance ──
  const liab1 = await inj('GET', '/api/payroll/liabilities', admin);
  const lrow = (c: string) => (liab1.json.lines ?? []).find((l: any) => l.account_code === c);
  ok('Liability schedule: 2350 outstanding 2700 reconciled to the payrun accrual; 2360 outstanding 170.83; all reconciled',
    near(lrow('2350')?.outstanding, 2700) && lrow('2350')?.reconciled === true && near(lrow('2360')?.outstanding, 170.83) && liab1.json.all_reconciled === true,
    JSON.stringify({ o2350: lrow('2350')?.outstanding, r2350: lrow('2350')?.reconciled, o2360: lrow('2360')?.outstanding, all: liab1.json.all_reconciled }));
  const overRemit = await inj('POST', '/api/payroll/liabilities/remit', admin, { account_code: '2350', amount: 99999 });
  ok('Remit beyond outstanding → 400 REMIT_EXCEEDS_OUTSTANDING', overRemit.status === 400 && overRemit.json.error?.code === 'REMIT_EXCEEDS_OUTSTANDING', `${overRemit.status} ${overRemit.json.error?.code}`);
  const notLiab = await inj('POST', '/api/payroll/liabilities/remit', admin, { account_code: '5600', amount: 100 });
  ok('Remit a non-liability account → 400 NOT_LIABILITY_ACCOUNT', notLiab.status === 400 && notLiab.json.error?.code === 'NOT_LIABILITY_ACCOUNT', `${notLiab.status} ${notLiab.json.error?.code}`);
  const remit = await inj('POST', '/api/payroll/liabilities/remit', admin, { account_code: '2350', amount: 1000, ref: 'SSO-2026-06' });
  ok('Remit 1000 SSO → outstanding_after 1700, JE posted', near(remit.json.outstanding_after, 1700) && /^JE-/.test(remit.json.entry_no ?? ''), JSON.stringify(remit.json));
  const liab2 = await inj('GET', '/api/payroll/liabilities', admin);
  const l2 = (liab2.json.lines ?? []).find((l: any) => l.account_code === '2350');
  const tbR = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('After remit: 2350 accrued 2700 / remitted 1000 / outstanding 1700, still reconciled, TB balanced',
    near(l2?.accrued, 2700) && near(l2?.remitted, 1000) && near(l2?.outstanding, 1700) && l2?.reconciled === true && tbR.json.totals?.balanced === true,
    JSON.stringify({ a: l2?.accrued, rem: l2?.remitted, o: l2?.outstanding, rec: l2?.reconciled, bal: tbR.json.totals?.balanced }));

  // ── 4b. idempotent per period (a Posted run blocks a re-run) ──
  const rerun = await inj('POST', '/api/payroll/runs?period=2026-06', admin);
  ok('Re-run same period → already (idempotent)', rerun.json.already === true && rerun.json.status === 'Posted', JSON.stringify(rerun.json).slice(0, 70));

  // ── 4c. reject path: a pending run can be rejected, then re-run fresh ──
  await inj('POST', '/api/payroll/runs?period=2026-08', admin);
  const rejectAug = await inj('POST', '/api/payroll/runs/2026-08/reject', admin, { reason: 'ตัวเลขผิด' });
  ok('Reject pending run → Voided JE + run Rejected', rejectAug.json.status === 'Rejected' && /^JE-/.test(rejectAug.json.entry_no ?? ''), JSON.stringify(rejectAug.json));
  const rerunAug = await inj('POST', '/api/payroll/runs?period=2026-08', admin);
  ok('After reject, re-run same period → fresh PendingApproval (not blocked)', rerunAug.json.status === 'PendingApproval' && rerunAug.json.already !== true, JSON.stringify({ st: rerunAug.json.status, already: rerunAug.json.already }));

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

  // ── 6b. สลิปเงินเดือน (payslip) print + PDPA access control (PAY-04) ──
  // Link Somchai + Malee to self-service (ess-only) users so the PDPA guard can be exercised: an employee may
  // download ONLY their own slip; HR/payroll may print anyone's; an ess-only user cannot reach the HR route.
  const empList = (await inj('GET', '/api/payroll/employees', admin)).json.employees;
  const somE = empList.find((e: any) => e.name === 'Somchai');
  const malE = empList.find((e: any) => e.name === 'Malee');
  const uSom = (await db.insert(s.users).values({ username: 'somchai', passwordHash: await pw.hash('emp123'), role: 'Cashier', tenantId: hq }).returning({ id: s.users.id }))[0];
  const uMal = (await db.insert(s.users).values({ username: 'malee', passwordHash: await pw.hash('emp123'), role: 'Cashier', tenantId: hq }).returning({ id: s.users.id }))[0];
  await db.insert(s.userPermissions).values([{ userId: Number(uSom.id), perm: 'ess' }, { userId: Number(uMal.id), perm: 'ess' }]).onConflictDoNothing();
  await db.update(s.employees).set({ userName: 'somchai' }).where(eq(s.employees.id, Number(somE.id)));
  await db.update(s.employees).set({ userName: 'malee' }).where(eq(s.employees.id, Number(malE.id)));
  const somTok = (await inj('POST', '/api/login', undefined, { username: 'somchai', password: 'emp123' })).json.token;

  const slipsFull = (await inj('GET', '/api/payroll/runs/2026-06/slips', admin)).json.slips;
  const somSlip = slipsFull.find((x: any) => x.emp_name === 'Somchai');
  const malSlip = slipsFull.find((x: any) => x.emp_name === 'Malee');
  ok('Slips list exposes a slip id for printing', Number.isFinite(somSlip?.id) && Number.isFinite(malSlip?.id), JSON.stringify({ som: somSlip?.id, mal: malSlip?.id }));

  const ownPdf = await injRaw('GET', `/api/ess/payslips/${somSlip.id}/pdf`, somTok);
  const ownIsHtml = ownPdf.ctype.includes('html');
  ok('ESS: employee downloads OWN payslip → 200, body rendered', ownPdf.status === 200 && ownPdf.body.length > 200, `${ownPdf.status} len=${ownPdf.body.length} (${ownPdf.ctype})`);
  ok('Payslip never leaks the full 13-digit citizen ID', !ownPdf.body.includes('1234567890123'), 'full national_id absent');
  ok('Payslip masks the citizen ID to last-4 (PDPA data-minimisation)', !ownIsHtml || ownPdf.body.includes('x-xxxx-xxxxx-xx-3'), ownIsHtml ? 'masked marker present' : 'pdf-mode (mask not string-checkable)');

  const otherPdf = await injRaw('GET', `/api/ess/payslips/${malSlip.id}/pdf`, somTok);
  ok('ESS PDPA: employee CANNOT download a colleague’s payslip → 404', otherPdf.status === 404, `${otherPdf.status}`);

  const hrPdf = await injRaw('GET', `/api/payroll/slips/${somSlip.id}/pdf`, admin);
  ok('HR/payroll can print any payslip → 200', hrPdf.status === 200 && hrPdf.body.length > 200, `${hrPdf.status}`);
  const somHr = await injRaw('GET', `/api/payroll/slips/${somSlip.id}/pdf`, somTok);
  ok('HR payslip route is gated: ess-only employee → 403', somHr.status === 403, `${somHr.status}`);

  const emailSlip = await inj('POST', `/api/payroll/slips/${somSlip.id}/send-email`, admin, { to_email: 'somchai@example.com' });
  ok('Payslip email path complete (503 EMAIL_NOT_CONFIGURED, SMTP unset)', emailSlip.status === 503 && emailSlip.json.error?.code === 'EMAIL_NOT_CONFIGURED', `${emailSlip.status} ${emailSlip.json.error?.code}`);
  const badEmail = await inj('POST', `/api/payroll/slips/${somSlip.id}/send-email`, admin, { to_email: 'not-an-email' });
  ok('Payslip email rejects an invalid recipient → 400', badEmail.status === 400, `${badEmail.status}`);

  // ── no-code document template applied LIVE to the payslip (Platform Phase 10 — wire planned→live) ──
  // Author a payslip template (presentation only) then re-fetch the slip: the tenant's header note + accent
  // must be genuinely consumed at render time (not just stored). Admin carries users/exec for the designer.
  const tplRes = await inj('POST', '/api/document-templates', admin, { doc_type: 'payslip', name: 'สลิปบริษัท', config: { header: { header_note: 'PAYSLIP-HDR-Z', accent_color: '#0F766E' }, footer: { terms_text: 'ข้อมูลลับ โปรดเก็บรักษา' } } });
  ok('Payslip template: create (first → default)', tplRes.status < 300 && tplRes.json.is_default === true, `${tplRes.status} ${JSON.stringify(tplRes.json).slice(0, 60)}`);
  const themedSlip = await injRaw('GET', `/api/payroll/slips/${somSlip.id}/pdf`, admin);
  ok('Payslip template applied LIVE: the tenant header note + accent are rendered on the slip', themedSlip.status === 200 && themedSlip.body.includes('PAYSLIP-HDR-Z') && themedSlip.body.includes('#0F766E') && themedSlip.body.includes('ข้อมูลลับ โปรดเก็บรักษา'), `note=${themedSlip.body.includes('PAYSLIP-HDR-Z')} accent=${themedSlip.body.includes('#0F766E')}`);
  ok('Payslip template: core integrity — net pay + masked citizen ID still render under a custom template', themedSlip.body.includes('เงินได้สุทธิ') && themedSlip.body.includes('x-xxxx-xxxxx-xx-3') && !themedSlip.body.includes('1234567890123'), 'net + masked id present');

  // ── 7. cross-tenant guard (C2): an HQ super-admin (no tenant) must name a tenant; the run is scoped ──
  // seed an active employee under ANOTHER tenant — it must NOT be swept into an HQ payroll run.
  await db.insert(s.employees).values({ tenantId: t2, empCode: 'EMP-T2-1', name: 'OtherCo Staff', monthlySalary: '20000', active: true }).onConflictDoNothing();
  const hqadmin = (await inj('POST', '/api/login', undefined, { username: 'hqadmin', password: 'admin123' })).json.token;
  const noTenant = await inj('POST', '/api/payroll/runs?period=2026-07', hqadmin);
  ok('HQ admin without tenant_id → 400 TENANT_REQUIRED', noTenant.status === 400 && noTenant.json.error?.code === 'TENANT_REQUIRED', `${noTenant.status} ${noTenant.json.error?.code}`);
  const scoped = await inj('POST', `/api/payroll/runs?period=2026-07&tenant_id=${hq}`, hqadmin);
  ok('HQ admin with tenant_id=HQ → runs ONLY HQ staff (headcount 2, excludes other tenant)', /^JE-/.test(scoped.json.entry_no ?? '') && scoped.json.headcount === 2, JSON.stringify({ e: scoped.json.entry_no, h: scoped.json.headcount }));

  // Master-data audit Phase 2: department/hourly_rate/pf_rate were accepted at creation but missing from the
  // GET projection (fmtEmp); sso_no/department/allowances/bank_account/start_date now also collectible at
  // creation. Placed at the END (a 3rd employee would shift the headcount=2 assertions run earlier).
  const e3 = await inj('POST', '/api/payroll/employees', admin, {
    name: 'Preecha', national_id: '1112223334445', sso_no: '9998887776', position: 'Chef', department: 'Kitchen',
    monthly_salary: 20000, hourly_rate: 150, pf_rate: 0.03, allowances: 1000, bank_account: '111-2-33333-4', start_date: '2026-01-15', sso_eligible: true,
  });
  ok('Create employee with department/hourly_rate/pf_rate/sso_no/allowances/bank_account/start_date',
    e3.status < 300 && e3.json.department === 'Kitchen' && near(e3.json.hourly_rate, 150) && near(e3.json.pf_rate, 0.03) && e3.json.sso_no === '9998887776' && near(e3.json.allowances, 1000) && e3.json.bank_account === '111-2-33333-4' && e3.json.start_date === '2026-01-15',
    JSON.stringify(e3.json).slice(0, 220));
  const empsList2 = (await inj('GET', '/api/payroll/employees', admin)).json.employees;
  const e3Row = (empsList2 ?? []).find((r: any) => r.emp_code === e3.json.emp_code);
  ok('Employee list now projects department/hourly_rate/pf_rate (previously missing from fmtEmp)',
    e3Row?.department === 'Kitchen' && near(e3Row?.hourly_rate, 150) && near(e3Row?.pf_rate, 0.03), JSON.stringify(e3Row).slice(0, 150));

  // ── docs/40 step 4: a tenant posting-rule override re-maps a payroll leg WITHOUT a code change ──
  // Seed a real override account + a tenant-scoped PAYROLL.GROSS/wages_expense rule → 5601, run a fresh
  // period and approve: the salaries debit lands on 5601 (unmapped roles keep their literals). The rule is
  // tenant-scoped — the NULL-tenant demo defaults from 0158 never shadow the code.
  await db.insert(s.accounts).values({ code: '5601', name: 'Salaries — override test', type: 'Expense', normalBalance: 'D', isPostable: true }).onConflictDoNothing();
  await db.insert(s.postingRules).values({ tenantId: hq, eventType: 'PAYROLL.GROSS', legOrder: 1, role: 'wages_expense', side: 'DR', accountCode: '5601', active: true });
  const runNov = await inj('POST', '/api/payroll/runs?period=2026-11', admin);
  await inj('POST', '/api/payroll/runs/2026-11/approve', approver);
  const led5601 = (await inj('GET', '/api/ledger/account-ledger?account=5601', admin)).json;
  ok('Posting-rule override: PAYROLL.GROSS wages_expense re-mapped to 5601 (tenant rule ?? literal)',
    /^JE-/.test(runNov.json.entry_no ?? '') && Number(runNov.json.gross_total) > 0 && near(led5601.total_debit, Number(runNov.json.gross_total)),
    JSON.stringify({ gross: runNov.json.gross_total, dr5601: led5601.total_debit }));

  console.log('\n── C2b — payroll (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} payroll checks failed` : `\n✅ All ${checks.length} payroll checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
