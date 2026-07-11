/**
 * HR-8 (docs/42, Wave 3) — Employee Self-Service (ESS) depth, control HR-08 (profile-change maker-checker).
 * Boots the AppModule over PGlite, seeds a tenant + role/permission fixtures, and drives the ESS endpoints
 * end-to-end: a sensitive profile-change request parks pending (master untouched), a low-risk change
 * auto-applies, self-approval is blocked (SOD_SELF_APPROVAL) + an ess user cannot reach the approve endpoint,
 * a distinct HR approver writes the employee field, reject leaves the master unchanged, own-scope isolation
 * (a second employee sees neither the request nor the document), document upload + own-read + bad-object-key
 * rejection + hr-visibility hiding, the team directory, and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-ess
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-ess-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();

  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CO2', name: 'Second Co' }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'CO2')))[0].id);

  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },       // exec/HR (approve path)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },      // hr_admin (approve)
    { username: 'hrmaker', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },      // hr (self-approval SOD test)
    { username: 'essuser', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },      // ess (own emp1)
    { username: 'essuser2', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },     // ess (own emp2, isolation)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },      // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrmaker'), perm: 'hr' },
    { userId: await uid('essuser'), perm: 'ess' },
    { userId: await uid('essuser2'), perm: 'ess' },
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
  const essuser2 = await login('essuser2');
  const t2admin = await login('t2admin');

  // Seed employees on the shared payroll identity and link each to a login for own-scope resolution.
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', monthly_salary: 30000, department: 'Sales' });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', monthly_salary: 28000, department: 'Sales' });
  const eHr = await inj('POST', '/api/payroll/employees', admin, { name: 'HR Maker', monthly_salary: 40000, department: 'HR' });
  const emp1 = e1.json.emp_code; const emp2 = e2.json.emp_code; const empHr = eHr.json.emp_code;
  await db.update(s.employees).set({ userName: 'essuser' }).where(eq(s.employees.empCode, emp1));
  await db.update(s.employees).set({ userName: 'essuser2' }).where(eq(s.employees.empCode, emp2));
  await db.update(s.employees).set({ userName: 'hrmaker' }).where(eq(s.employees.empCode, empHr));
  // A t2 employee linked to t2admin for the RLS check.
  const eT2 = await inj('POST', '/api/payroll/employees', t2admin, { name: 'T2 Emp', monthly_salary: 20000 });
  const empT2 = eT2.json.emp_code;
  await db.update(s.employees).set({ userName: 't2admin' }).where(eq(s.employees.empCode, empT2));
  ok('Seed employees linked to ESS logins', /^EMP/.test(emp1 ?? '') && /^EMP/.test(emp2 ?? '') && /^EMP/.test(empHr ?? ''), JSON.stringify({ emp1, emp2, empHr, empT2 }));

  const bankOf = async (code: string) => (await pg.query(`select bank_account, national_id, phone, name from employees where emp_code='${code}'`)).rows?.[0] as any;

  // ── 1. Sensitive profile-change request parks pending (master untouched) ─────
  const bankReq = await inj('POST', '/api/hcm/ess/profile-requests', essuser, { field: 'bank_account', new_value: '1234567890', reason: 'new bank' });
  ok('ess creates a SENSITIVE change → pending (HR-08)', bankReq.status < 300 && bankReq.json.status === 'pending' && bankReq.json.sensitive === true, JSON.stringify({ s: bankReq.status, st: bankReq.json.status }));
  ok('HR-08: sensitive change leaves the employees master untouched (bank still empty)', !(await bankOf(emp1)).bank_account, JSON.stringify({ bank: (await bankOf(emp1)).bank_account }));

  // ── 2. Low-risk field auto-applies at request time ───────────────────────────
  const phoneReq = await inj('POST', '/api/hcm/ess/profile-requests', essuser, { field: 'phone', new_value: '0812345678' });
  ok('ess low-risk change (phone) auto-applies (status applied)', phoneReq.status < 300 && phoneReq.json.status === 'applied' && phoneReq.json.auto_applied === true, JSON.stringify({ s: phoneReq.status, st: phoneReq.json.status }));
  ok('Low-risk change written to the employees master immediately', (await bankOf(emp1)).phone === '0812345678', JSON.stringify({ phone: (await bankOf(emp1)).phone }));

  // ── 3. Own-scope isolation on requests ───────────────────────────────────────
  const essOwnList = await inj('GET', '/api/hcm/ess/profile-requests', essuser);
  ok('ess sees ONLY their own requests', essOwnList.status === 200 && (essOwnList.json.requests ?? []).every((r: any) => r.emp_code === emp1) && essOwnList.json.count >= 2, JSON.stringify({ codes: (essOwnList.json.requests ?? []).map((r: any) => r.emp_code) }));
  const otherList = await inj('GET', '/api/hcm/ess/profile-requests', essuser2);
  ok('A second employee does NOT see emp1 requests (own-scope)', otherList.status === 200 && !(otherList.json.requests ?? []).some((r: any) => r.emp_code === emp1), JSON.stringify({ codes: (otherList.json.requests ?? []).map((r: any) => r.emp_code), n: otherList.json.count }));
  ok('Sensitive values are masked in the request list', (essOwnList.json.requests ?? []).some((r: any) => r.field === 'bank_account' && String(r.new_value).includes('••••')), JSON.stringify({ v: (essOwnList.json.requests ?? []).find((r: any) => r.field === 'bank_account')?.new_value }));

  // ── 4. Self-approval blocked (SOD_SELF_APPROVAL) ─────────────────────────────
  const ownChange = await inj('POST', '/api/hcm/ess/profile-requests', hrmaker, { field: 'name', new_value: 'HR Maker Renamed' });
  ok('hr user creates a sensitive change on their OWN record → pending', ownChange.status < 300 && ownChange.json.status === 'pending', JSON.stringify({ s: ownChange.status }));
  const selfApprove = await inj('POST', `/api/hcm/ess/profile-requests/${ownChange.json.id}/approve`, hrmaker, {});
  ok('HR-08: requester CANNOT approve their own change (SOD_SELF_APPROVAL, 403)', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfApprove.status, c: selfApprove.json?.error?.code }));
  ok('HR-08: self-blocked change leaves the master name unchanged', (await bankOf(empHr)).name === 'HR Maker', JSON.stringify({ name: (await bankOf(empHr)).name }));

  // ── 5. ess cannot reach the approve endpoint at all ──────────────────────────
  const essApprove = await inj('POST', `/api/hcm/ess/profile-requests/${bankReq.json.id}/approve`, essuser, {});
  ok('An ess user cannot approve (403 — approval reserved to hr/hr_admin)', essApprove.status === 403, JSON.stringify({ s: essApprove.status }));

  // ── 6. Distinct HR approver writes the employee field ────────────────────────
  const approve = await inj('POST', `/api/hcm/ess/profile-requests/${bankReq.json.id}/approve`, hradmin, {});
  ok('A distinct hr_admin approves the sensitive change', approve.status < 300 && approve.json.status === 'approved', JSON.stringify({ s: approve.status }));
  // bank_account is an encrypted-at-rest column — read it back through drizzle (which decrypts) not raw SQL.
  const empRow = (await db.select().from(s.employees).where(eq(s.employees.empCode, emp1)))[0];
  ok('HR-08: employee bank_account written ONLY on approval', empRow?.bankAccount === '1234567890', JSON.stringify({ bank: empRow?.bankAccount }));
  const slog: any = await pg.query(`select * from doc_status_log where doc_type='ESSPROFILE' and new_status='Approved'`);
  ok('HR-08: approval is audit-logged (doc_status_log ESSPROFILE)', (slog.rows?.length ?? 0) >= 1, JSON.stringify({ n: slog.rows?.length }));

  // ── 7. Reject leaves the master unchanged ────────────────────────────────────
  const nidReq = await inj('POST', '/api/hcm/ess/profile-requests', essuser, { field: 'national_id', new_value: '1103700000000' });
  const reject = await inj('POST', `/api/hcm/ess/profile-requests/${nidReq.json.id}/reject`, hradmin, { reason: 'illegible scan' });
  ok('A distinct HR user can reject a pending change', reject.status < 300 && reject.json.status === 'rejected', JSON.stringify({ s: reject.status }));
  ok('HR-08: reject leaves the employees master unchanged (national_id still empty)', !(await bankOf(emp1)).national_id, JSON.stringify({ nid: (await bankOf(emp1)).national_id }));

  // ── 8. Bad field / bad object key rejected ───────────────────────────────────
  const badField = await inj('POST', '/api/hcm/ess/profile-requests', essuser, { field: 'monthly_salary', new_value: '99999' });
  ok('A non-ESS-editable field is rejected (400)', badField.status === 400, JSON.stringify({ s: badField.status }));

  // ── 9. Personal documents (own-scope + safe object key) ──────────────────────
  const doc1 = await inj('POST', '/api/hcm/ess/documents', essuser, { doc_type: 'certificate', title: 'Degree Certificate', file_ref: 'objstore:emp/emp1/degree.pdf' });
  ok('ess uploads their OWN document', doc1.status < 300 && doc1.json.emp_code === emp1 && doc1.json.visibility === 'private', JSON.stringify({ s: doc1.status }));
  const badKey = await inj('POST', '/api/hcm/ess/documents', essuser, { doc_type: 'other', title: 'x', file_ref: 'objstore:../../etc/passwd' });
  ok('An unsafe object key is rejected (BAD_OBJECT_KEY)', badKey.status === 400 && badKey.json?.error?.code === 'BAD_OBJECT_KEY', JSON.stringify({ s: badKey.status, c: badKey.json?.error?.code }));
  const ownDocs = await inj('GET', '/api/hcm/ess/documents', essuser);
  ok('ess reads their own documents', ownDocs.status === 200 && (ownDocs.json.documents ?? []).some((d: any) => d.emp_code === emp1), JSON.stringify({ n: ownDocs.json.count }));
  const otherDocs = await inj('GET', '/api/hcm/ess/documents', essuser2);
  ok('A second employee does NOT see emp1 documents (own-scope)', otherDocs.status === 200 && !(otherDocs.json.documents ?? []).some((d: any) => d.emp_code === emp1), JSON.stringify({ n: otherDocs.json.count }));
  // HR uploads an hr-visibility doc for emp1 — hidden from the employee.
  const hrDoc = await inj('POST', '/api/hcm/ess/documents', hradmin, { doc_type: 'tax_form', title: 'PND91 (HR)', emp_code: emp1, visibility: 'hr' });
  ok('HR uploads an hr-visibility doc on behalf of an employee', hrDoc.status < 300 && hrDoc.json.visibility === 'hr', JSON.stringify({ s: hrDoc.status }));
  const ownDocs2 = await inj('GET', '/api/hcm/ess/documents', essuser);
  ok('An hr-visibility doc is hidden from the employee', !(ownDocs2.json.documents ?? []).some((d: any) => d.visibility === 'hr'), JSON.stringify({ vis: (ownDocs2.json.documents ?? []).map((d: any) => d.visibility) }));

  // ── 10. Team directory ───────────────────────────────────────────────────────
  const essTeam = await inj('GET', '/api/hcm/ess/team', essuser);
  ok('ess sees a department-scoped team directory', essTeam.status === 200 && essTeam.json.scope === 'department' && (essTeam.json.team ?? []).some((m: any) => m.emp_code === emp1), JSON.stringify({ scope: essTeam.json.scope, n: essTeam.json.count }));
  const hrTeam = await inj('GET', '/api/hcm/ess/team', hradmin);
  ok('HR sees a company-scoped team directory', hrTeam.status === 200 && hrTeam.json.scope === 'company', JSON.stringify({ scope: hrTeam.json.scope, n: hrTeam.json.count }));

  // ── 11. RLS tenant isolation ─────────────────────────────────────────────────
  const t2change = await inj('POST', '/api/hcm/ess/profile-requests', t2admin, { field: 'phone', new_value: '021112222' });
  ok('T2 admin can create a change on its own employee', t2change.status < 300, JSON.stringify({ s: t2change.status }));
  const t1all = await inj('GET', '/api/hcm/ess/profile-requests', admin);
  const t2all = await inj('GET', '/api/hcm/ess/profile-requests', t2admin);
  const t1codes = (t1all.json.requests ?? []).map((r: any) => r.emp_code);
  const t2codes = (t2all.json.requests ?? []).map((r: any) => r.emp_code);
  ok('RLS: T1 does NOT see T2 requests; T2 does NOT see T1 requests', t1codes.includes(emp1) && !t1codes.includes(empT2) && t2codes.includes(empT2) && !t2codes.includes(emp1), JSON.stringify({ t1codes, t2codes }));

  console.log('\n── HR-8 — Employee Self-Service depth (control HR-08) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-8 ESS checks failed` : `\n✅ All ${checks.length} HR-8 ESS checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
