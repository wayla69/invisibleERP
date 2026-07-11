/**
 * HR-1 (docs/42) — Organisation structure, positions & headcount governance (HR-01). Boots the AppModule over
 * PGlite, seeds a tenant + role/permission fixtures, and drives the org-structure endpoints end-to-end:
 * department hierarchy, positions with a budgeted headcount, effective-dated assignments, the HR-01 headcount
 * control (block + exec override, audit-logged), the org chart, and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-org
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-org-secret';
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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // exec (override path)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr_admin only (no exec)
    { username: 'hrread', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },     // hr read only
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },    // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrread'), perm: 'hr' },
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
  const hrread = await login('hrread');
  const t2admin = await login('t2admin');

  // Two employees on the shared payroll identity (T1).
  const e1 = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', monthly_salary: 30000 });
  const e2 = await inj('POST', '/api/payroll/employees', admin, { name: 'Malee', monthly_salary: 28000 });
  const emp1 = e1.json.emp_code; const emp2 = e2.json.emp_code;
  ok('Seed two employees on payroll identity', /^EMP/.test(emp1 ?? '') && /^EMP/.test(emp2 ?? ''), JSON.stringify({ emp1, emp2 }));

  // ── 1. Department hierarchy ──────────────────────────────────────────────
  const dTop = await inj('POST', '/api/hcm/org/departments', hradmin, { dept_code: 'CORP', name: 'Corporate', cost_center: 'CC-100' });
  ok('hr_admin creates a top-level department', dTop.status < 300 && dTop.json.dept_code === 'CORP', JSON.stringify({ s: dTop.status }));
  const dEng = await inj('POST', '/api/hcm/org/departments', hradmin, { dept_code: 'ENG', name: 'Engineering', parent_dept_code: 'CORP' });
  ok('Create a child department under a parent (hierarchy)', dEng.status < 300, JSON.stringify({ s: dEng.status }));
  const dDup = await inj('POST', '/api/hcm/org/departments', hradmin, { dept_code: 'CORP', name: 'Dup' });
  ok('Duplicate dept_code rejected (DEPT_EXISTS)', dDup.status === 400 && dDup.json?.error?.code === 'DEPT_EXISTS', JSON.stringify({ s: dDup.status, c: dDup.json?.error?.code }));

  // A read-only `hr` user may LIST but not CREATE (perms: reads hr/hr_admin/exec, writes hr_admin/exec).
  const readList = await inj('GET', '/api/hcm/org/departments', hrread);
  ok('hr read-only user CAN list departments', readList.status === 200 && readList.json.count >= 2, JSON.stringify({ s: readList.status, c: readList.json.count }));
  const readWrite = await inj('POST', '/api/hcm/org/departments', hrread, { dept_code: 'X', name: 'X' });
  ok('hr read-only user CANNOT create a department (403)', readWrite.status === 403, JSON.stringify({ s: readWrite.status }));

  // ── 2. Positions (budgeted_headcount=1) ──────────────────────────────────
  const pLead = await inj('POST', '/api/hcm/org/positions', hradmin, { position_code: 'ENG-LEAD', title: 'Engineering Lead', dept_code: 'ENG', job_grade: 'G7', budgeted_headcount: 1 });
  ok('Create a position with budgeted_headcount=1', pLead.status < 300 && pLead.json.budgeted_headcount === 1, JSON.stringify({ s: pLead.status }));
  const pDev = await inj('POST', '/api/hcm/org/positions', hradmin, { position_code: 'ENG-DEV', title: 'Engineer', dept_code: 'ENG', reports_to_position_code: 'ENG-LEAD', budgeted_headcount: 0 });
  ok('Create a subordinate position (reports_to; unbudgeted headcount=0)', pDev.status < 300, JSON.stringify({ s: pDev.status }));

  // ── 3. Assignments + HR-01 headcount governance ──────────────────────────
  const a1 = await inj('POST', '/api/hcm/org/assignments', hradmin, { emp_code: emp1, position_code: 'ENG-LEAD' });
  ok('Assign employee #1 to a budgeted-1 position (within budget)', a1.status < 300 && a1.json.headcount_overridden === false, JSON.stringify({ s: a1.status, o: a1.json.headcount_overridden }));

  const a2block = await inj('POST', '/api/hcm/org/assignments', hradmin, { emp_code: emp2, position_code: 'ENG-LEAD' });
  ok('HR-01: 2nd assignment beyond budgeted headcount BLOCKED (HEADCOUNT_EXCEEDED) for a non-exec', a2block.status === 403 && a2block.json?.error?.code === 'HEADCOUNT_EXCEEDED', JSON.stringify({ s: a2block.status, c: a2block.json?.error?.code }));

  const a2over = await inj('POST', '/api/hcm/org/assignments', admin, { emp_code: emp2, position_code: 'ENG-LEAD', override_reason: 'temporary dual-hatting' });
  ok('HR-01: exec override succeeds (headcount_overridden=true)', a2over.status < 300 && a2over.json.headcount_overridden === true, JSON.stringify({ s: a2over.status, o: a2over.json.headcount_overridden }));

  // The exec override is audit-logged on the doc status log (HR-01 evidence).
  const slog: any = await pg.query(`select * from doc_status_log where doc_type='HRASSIGN'`);
  ok('HR-01: override is audit-logged (doc_status_log HRASSIGN, HEADCOUNT_OVERRIDE)', (slog.rows?.length ?? 0) >= 1 && String(slog.rows?.[0]?.remarks ?? '').includes('HEADCOUNT_OVERRIDE'), JSON.stringify({ n: slog.rows?.length, r: String(slog.rows?.[0]?.remarks ?? '').slice(0, 40) }));

  // Unbudgeted position (budgeted_headcount=0) has no cap — both employees assign without override.
  const u1 = await inj('POST', '/api/hcm/org/assignments', hradmin, { emp_code: emp1, position_code: 'ENG-DEV' });
  const u2 = await inj('POST', '/api/hcm/org/assignments', hradmin, { emp_code: emp2, position_code: 'ENG-DEV' });
  ok('Unbudgeted position (headcount=0) accepts multiple assignments with no override', u1.status < 300 && u2.status < 300 && u1.json.headcount_overridden === false && u2.json.headcount_overridden === false, JSON.stringify({ s1: u1.status, s2: u2.status }));

  // ── 4. Reads: positions headcount + assignments list ─────────────────────
  const posList = await inj('GET', '/api/hcm/org/positions', hradmin);
  const lead = (posList.json.positions ?? []).find((p: any) => p.position_code === 'ENG-LEAD');
  ok('Positions list reports current_headcount=2 vs budgeted=1 (over budget)', lead?.current_headcount === 2 && lead?.budgeted_headcount === 1, JSON.stringify({ cur: lead?.current_headcount, bud: lead?.budgeted_headcount }));
  const aList = await inj('GET', '/api/hcm/org/assignments?position_code=ENG-LEAD', hradmin);
  ok('Assignments filter by position returns both assignees', aList.json.count === 2, JSON.stringify({ c: aList.json.count }));

  // ── 5. Org chart tree ────────────────────────────────────────────────────
  const chart = await inj('GET', '/api/hcm/org/chart', admin);
  const corp = (chart.json.tree ?? []).find((d: any) => d.dept_code === 'CORP');
  const eng = corp?.children?.find((d: any) => d.dept_code === 'ENG');
  const chartLead = eng?.positions?.find((p: any) => p.position_code === 'ENG-LEAD');
  ok('Org chart returns the department tree (CORP → ENG child)', !!corp && !!eng, JSON.stringify({ corp: !!corp, eng: !!eng }));
  ok('Org chart nests positions with current assignees + vacancies', chartLead?.current_headcount === 2 && chartLead?.assignees?.length === 2 && chartLead?.vacancies === 0, JSON.stringify({ hc: chartLead?.current_headcount, va: chartLead?.vacancies }));
  ok('Org chart totals: 2 departments, filled headcount reflects assignments', chart.json.totals?.departments === 2 && chart.json.totals?.filled_headcount >= 3, JSON.stringify(chart.json.totals));

  // ── 6. RLS tenant isolation ──────────────────────────────────────────────
  // T2's admin creates a department; it must never appear to T1, and T1's CORP/ENG must never appear to T2.
  const t2dept = await inj('POST', '/api/hcm/org/departments', t2admin, { dept_code: 'T2ONLY', name: 'Second-Co Dept' });
  ok('T2 admin can create its own department', t2dept.status < 300, JSON.stringify({ s: t2dept.status }));
  const t1sees = await inj('GET', '/api/hcm/org/departments', admin);
  const t2sees = await inj('GET', '/api/hcm/org/departments', t2admin);
  const t1codes = (t1sees.json.departments ?? []).map((d: any) => d.dept_code);
  const t2codes = (t2sees.json.departments ?? []).map((d: any) => d.dept_code);
  ok('RLS: T1 does NOT see T2ONLY (tenant isolation)', !t1codes.includes('T2ONLY') && t1codes.includes('CORP'), JSON.stringify({ t1codes }));
  ok('RLS: T2 does NOT see T1 departments (sees only its own)', t2codes.includes('T2ONLY') && !t2codes.includes('CORP') && !t2codes.includes('ENG'), JSON.stringify({ t2codes }));

  console.log('\n── HR-1 — Org structure, positions & headcount governance (HR-01) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-1 org checks failed` : `\n✅ All ${checks.length} HR-1 org checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
