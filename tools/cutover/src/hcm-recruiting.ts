/**
 * HR-4 (docs/42, Wave 2) — Recruiting / ATS with the HR-04 control. Boots the AppModule over PGlite, seeds a
 * tenant + role/permission fixtures, and drives the recruiting endpoints end-to-end: job requisitions with the
 * maker-checker approval (self-approve → SOD_SELF_APPROVAL), the candidate → application pipeline, the
 * requisition-approved gate on the offer/hire stages (REQUISITION_NOT_APPROVED), offer authorization
 * (OFFER_NOT_APPROVED + self-approve SoD), the accepted+approved offer → payroll.employees hire, the
 * headcount-bound hiring cap (HEADCOUNT_EXCEEDED), and RLS tenant isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hcm-recruiting
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hcm-recruiting-secret';
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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t1 },     // exec (distinct approver)
    { username: 'hradmin', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr_admin (creator + would-be self-approver)
    { username: 'hrmaker', passwordHash: await pw.hash('admin123'), role: 'Sales', tenantId: t1 },    // hr only (can create, cannot approve)
    { username: 't2admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: t2 },    // other company
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  await db.insert(s.userPermissions).values([
    { userId: await uid('hradmin'), perm: 'hr_admin' },
    { userId: await uid('hrmaker'), perm: 'hr' },
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
  const t2admin = await login('t2admin');

  // ── 1. Requisition create + maker-checker approval (HR-04) ─────────────────
  const r1 = await inj('POST', '/api/hcm/recruiting/requisitions', hradmin, { req_no: 'REQ1', headcount: 1, justification: 'Backfill lead' });
  ok('hr_admin creates a job requisition (pending, requested_by set)', r1.status < 300 && r1.json.status === 'pending' && r1.json.requested_by === 'hradmin', JSON.stringify({ s: r1.status, st: r1.json.status }));

  const selfApprove = await inj('POST', '/api/hcm/recruiting/requisitions/REQ1/approve', hradmin);
  ok('HR-04: requester self-approving the requisition BLOCKED (SOD_SELF_APPROVAL)', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: selfApprove.status, c: selfApprove.json?.error?.code }));

  const makerApprove = await inj('POST', '/api/hcm/recruiting/requisitions/REQ1/approve', hrmaker);
  ok('hr-only maker CANNOT approve a requisition (403 perm)', makerApprove.status === 403, JSON.stringify({ s: makerApprove.status }));

  const approve = await inj('POST', '/api/hcm/recruiting/requisitions/REQ1/approve', admin);
  ok('A DIFFERENT approver (exec) approves the requisition', approve.status < 300 && approve.json.status === 'approved' && approve.json.approved_by === 'admin', JSON.stringify({ s: approve.status, st: approve.json.status }));

  // ── 2. Candidates + application pipeline ───────────────────────────────────
  const c1 = await inj('POST', '/api/hcm/recruiting/candidates', hradmin, { cand_no: 'CAND1', name: 'Anong Srisai', email: 'anong@example.com', source: 'referral' });
  ok('Add a candidate (CAND1)', c1.status < 300 && c1.json.cand_no === 'CAND1', JSON.stringify({ s: c1.status }));

  const app1 = await inj('POST', '/api/hcm/recruiting/applications', hradmin, { req_no: 'REQ1', cand_no: 'CAND1' });
  ok('Create an application (CAND1 → REQ1, stage applied)', app1.status < 300 && app1.json.stage === 'applied', JSON.stringify({ s: app1.status, st: app1.json.stage }));
  const app1Id = app1.json.id;

  const scr = await inj('PATCH', `/api/hcm/recruiting/applications/${app1Id}/stage`, hradmin, { stage: 'screen' });
  const intv = await inj('PATCH', `/api/hcm/recruiting/applications/${app1Id}/stage`, hradmin, { stage: 'interview' });
  ok('Advance the application applied → screen → interview', scr.status < 300 && intv.status < 300 && intv.json.stage === 'interview', JSON.stringify({ scr: scr.status, intv: intv.json.stage }));

  // ── 3. HR-04: offer/hire stages require an APPROVED requisition ────────────
  await inj('POST', '/api/hcm/recruiting/requisitions', hradmin, { req_no: 'REQ2', headcount: 1 }); // pending (never approved)
  await inj('POST', '/api/hcm/recruiting/candidates', hradmin, { cand_no: 'CAND2', name: 'Boonsri' });
  const app2 = await inj('POST', '/api/hcm/recruiting/applications', hradmin, { req_no: 'REQ2', cand_no: 'CAND2' });
  const app2ToOffer = await inj('PATCH', `/api/hcm/recruiting/applications/${app2.json.id}/stage`, hradmin, { stage: 'offer' });
  ok('HR-04: advancing to offer against an UNAPPROVED requisition BLOCKED (REQUISITION_NOT_APPROVED)', app2ToOffer.status === 403 && app2ToOffer.json?.error?.code === 'REQUISITION_NOT_APPROVED', JSON.stringify({ s: app2ToOffer.status, c: app2ToOffer.json?.error?.code }));

  // ── 4. Offer authorization (HR-04) ─────────────────────────────────────────
  const offer1 = await inj('POST', '/api/hcm/recruiting/offers', hradmin, { application_id: app1Id, offered_salary: 45000, offered_grade: 'G7' });
  ok('Create an offer on the approved-requisition application (pending)', offer1.status < 300 && offer1.json.status === 'pending', JSON.stringify({ s: offer1.status, st: offer1.json.status }));
  const offer1Id = offer1.json.id;

  const convBefore = await inj('POST', `/api/hcm/recruiting/offers/${offer1Id}/convert`, admin);
  ok('HR-04: converting an UNAPPROVED offer BLOCKED (OFFER_NOT_APPROVED)', convBefore.status === 403 && convBefore.json?.error?.code === 'OFFER_NOT_APPROVED', JSON.stringify({ s: convBefore.status, c: convBefore.json?.error?.code }));

  const offerSelfApprove = await inj('POST', `/api/hcm/recruiting/offers/${offer1Id}/approve`, hradmin);
  ok('HR-04: offer creator self-approving BLOCKED (SOD_SELF_APPROVAL)', offerSelfApprove.status === 403 && offerSelfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', JSON.stringify({ s: offerSelfApprove.status, c: offerSelfApprove.json?.error?.code }));

  const offerApprove = await inj('POST', `/api/hcm/recruiting/offers/${offer1Id}/approve`, admin);
  ok('A DIFFERENT approver authorizes the offer', offerApprove.status < 300 && offerApprove.json.status === 'approved', JSON.stringify({ s: offerApprove.status, st: offerApprove.json.status }));

  // Seed a SECOND application + approved offer on REQ1 BEFORE the first convert (so the requisition is still
  // 'approved' when both offers are authorized — the headcount cap then bites on the second convert).
  await inj('POST', '/api/hcm/recruiting/candidates', hradmin, { cand_no: 'CAND3', name: 'Chalerm' });
  const app3 = await inj('POST', '/api/hcm/recruiting/applications', hradmin, { req_no: 'REQ1', cand_no: 'CAND3' });
  const offer3 = await inj('POST', '/api/hcm/recruiting/offers', hradmin, { application_id: app3.json.id, offered_salary: 42000 });
  const offer3Approve = await inj('POST', `/api/hcm/recruiting/offers/${offer3.json.id}/approve`, admin);
  ok('Second offer on the same requisition is also authorized (pre-hire)', offer3Approve.status < 300 && offer3Approve.json.status === 'approved', JSON.stringify({ s: offer3Approve.status }));

  // ── 5. Convert → hire (payroll.employees row) ──────────────────────────────
  const convert = await inj('POST', `/api/hcm/recruiting/offers/${offer1Id}/convert`, admin);
  ok('Approved offer converts to a hire (emp_code minted)', convert.status < 300 && /^EMP/.test(convert.json.emp_code ?? '') && convert.json.candidate === 'CAND1', JSON.stringify({ s: convert.status, e: convert.json.emp_code }));

  const empRows: any = await pg.query(`select emp_code, name from employees where name = 'Anong Srisai'`);
  ok('The hire created a payroll.employees row carrying the candidate identity', (empRows.rows?.length ?? 0) === 1 && String(empRows.rows?.[0]?.name) === 'Anong Srisai', JSON.stringify({ n: empRows.rows?.length }));

  const reqList = await inj('GET', '/api/hcm/recruiting/requisitions', admin);
  const req1Row = (reqList.json.requisitions ?? []).find((r: any) => r.req_no === 'REQ1');
  ok('Requisition flips to `filled` once its headcount is hired', req1Row?.status === 'filled' && req1Row?.hired === 1, JSON.stringify({ st: req1Row?.status, h: req1Row?.hired }));

  // ── 6. Headcount cap (HR-04) ───────────────────────────────────────────────
  const convert3 = await inj('POST', `/api/hcm/recruiting/offers/${offer3.json.id}/convert`, admin);
  ok('HR-04: hiring beyond the requisition headcount BLOCKED (HEADCOUNT_EXCEEDED)', convert3.status === 403 && convert3.json?.error?.code === 'HEADCOUNT_EXCEEDED', JSON.stringify({ s: convert3.status, c: convert3.json?.error?.code }));

  // ── 7. RLS tenant isolation ────────────────────────────────────────────────
  const t2req = await inj('POST', '/api/hcm/recruiting/requisitions', t2admin, { req_no: 'T2REQ', headcount: 2 });
  ok('T2 admin can create its own requisition', t2req.status < 300, JSON.stringify({ s: t2req.status }));
  const t1sees = await inj('GET', '/api/hcm/recruiting/requisitions', admin);
  const t2sees = await inj('GET', '/api/hcm/recruiting/requisitions', t2admin);
  const t1nos = (t1sees.json.requisitions ?? []).map((r: any) => r.req_no);
  const t2nos = (t2sees.json.requisitions ?? []).map((r: any) => r.req_no);
  ok('RLS: T1 does NOT see T2REQ (tenant isolation)', !t1nos.includes('T2REQ') && t1nos.includes('REQ1'), JSON.stringify({ t1nos }));
  ok('RLS: T2 sees only its own requisition (not REQ1)', t2nos.includes('T2REQ') && !t2nos.includes('REQ1'), JSON.stringify({ t2nos }));

  console.log('\n── HR-4 — Recruiting / ATS (requisitions → pipeline → offer → hire, HR-04) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} HR-4 recruiting checks failed` : `\n✅ All ${checks.length} HR-4 recruiting checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
