/**
 * Phase 18 — Projects/PPM. Create a project → log costs (→ project WIP) → bill the customer
 * (→ revenue + relieve WIP to cost of services), with balanced GL at every step. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover projects
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'prj-secret';
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
    { username: 'mgr', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // independent approver (P3 maker-checker)
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
  const mgr = (await inj('POST', '/api/login', undefined, { username: 'mgr', password: 'admin123' })).json.token;

  // ── 1. create project (T&M) ──
  const cr = await inj('POST', '/api/projects', admin, { project_code: 'PRJ-A', name: 'ระบบ ERP ลูกค้า', customer_name: 'ACME', billing_type: 'TM', contract_amount: 10000 });
  ok('Create project → status Open', cr.status < 300 && cr.json.project_code === 'PRJ-A' && cr.json.status === 'Open', JSON.stringify({ s: cr.status }));

  // ── 2. log costs: time 5000 + expense 2000 → cost_to_date 7000 ──
  await inj('POST', '/api/projects/PRJ-A/cost', admin, { entry_type: 'time', description: 'งานพัฒนา', amount: 5000 });
  const c2 = await inj('POST', '/api/projects/PRJ-A/cost', admin, { entry_type: 'expense', description: 'ค่าเดินทาง', amount: 2000 });
  ok('Log 2 costs → cost_to_date 7000', near(c2.json.cost_to_date, 7000), JSON.stringify({ c: c2.json.cost_to_date }));

  // ── 3. GL after costs: 1260 WIP dr 7000; 2390 applied cr 7000; TB balanced ──
  const tb1 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r1 = (c: string) => (tb1.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Cost GL: 1260 WIP dr 7000, 2390 applied cr 7000, TB balanced',
    tb1.json.totals?.balanced === true && near(r1('1260')?.debit, 7000) && near(r1('2390')?.credit, 7000),
    JSON.stringify({ bal: tb1.json.totals?.balanced, wip: r1('1260')?.debit }));

  // ── 4. bill 10000 → revenue 10000, relieve WIP 7000 to COGS, margin 3000 ──
  const bill = await inj('POST', '/api/projects/PRJ-A/bill', admin, { amount: 10000 });
  ok('Bill 10000 → revenue 10000, cost recognized 7000, margin 3000',
    near(bill.json.revenue, 10000) && near(bill.json.cost_recognized, 7000) && near(bill.json.margin, 3000), JSON.stringify({ m: bill.json.margin }));

  // ── 5. GL after bill: 1100 AR dr 10000; 4200 rev cr 10000; 5800 COGS dr 7000; 1260 WIP back to 0; TB balanced ──
  const tb2 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r2 = (c: string) => (tb2.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Bill GL: AR 10000, Revenue 10000, COGS 7000, WIP balance 0, TB balanced',
    tb2.json.totals?.balanced === true && near(r2('1100')?.debit, 10000) && near(r2('4200')?.credit, 10000) &&
    near(r2('5800')?.debit, 7000) && near(r2('1260')?.balance, 0),
    JSON.stringify({ bal: tb2.json.totals?.balanced, ar: r2('1100')?.debit, rev: r2('4200')?.credit, wip: r2('1260')?.balance }));

  // ── 6. project summary: wip 0, margin 3000 ──
  const get = await inj('GET', '/api/projects/PRJ-A', admin);
  ok('Project summary: wip 0, margin 3000, 2 entries', near(get.json.wip, 0) && near(get.json.margin, 3000) && get.json.entries?.length === 2, JSON.stringify({ w: get.json.wip, m: get.json.margin }));

  // ── 7. non-billable cost: expensed straight to 5800 (NOT capitalised in WIP 1260) ──
  const nbCost = await inj('POST', '/api/projects/PRJ-A/cost', admin, { entry_type: 'expense', amount: 800, billable: false, description: 'ค่าใช้จ่ายที่เบิกลูกค้าไม่ได้' });
  ok('Non-billable cost → expensed now, NOT capitalised; cost_to_date unchanged (7000)', near(nbCost.json.cost_to_date, 7000) && nbCost.json.billable === false, JSON.stringify({ c: nbCost.json.cost_to_date, b: nbCost.json.billable }));
  const tb3 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r3 = (c: string) => (tb3.json.rows ?? []).find((r: any) => r.account_code === c);
  ok('Non-billable GL: 5800 dr 7800 (7000 COGS + 800 non-billable), 1260 WIP still 0, TB balanced',
    tb3.json.totals?.balanced === true && near(r3('5800')?.debit, 7800) && near(r3('1260')?.balance, 0),
    JSON.stringify({ bal: tb3.json.totals?.balanced, cogs: r3('5800')?.debit, wip: r3('1260')?.balance }));
  const get2 = await inj('GET', '/api/projects/PRJ-A', admin);
  ok('Project summary reflects non-billable: non_billable_cost 800, total_cost 7800, margin 2200 (10000−7000−800)',
    near(get2.json.non_billable_cost, 800) && near(get2.json.total_cost, 7800) && near(get2.json.margin, 2200),
    JSON.stringify({ nb: get2.json.non_billable_cost, tc: get2.json.total_cost, m: get2.json.margin }));

  // ── 8. milestone / % billing on a Fixed-price contract + the over-bill guard ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-F', name: 'งานเหมาราคาคงที่', customer_name: 'BETA', billing_type: 'Fixed', contract_amount: 100000 });
  const mb1 = await inj('POST', '/api/projects/PRJ-F/bill', admin, { percent: 30 });
  ok('Milestone billing: 30% of a 100000 contract → revenue 30000', near(mb1.json.revenue, 30000) && /^JE-/.test(mb1.json.entry_no ?? ''), JSON.stringify({ r: mb1.json.revenue }));
  const mbGet = await inj('GET', '/api/projects/PRJ-F', admin);
  ok('Fixed project progress: billed_pct 30, remaining_to_bill 70000', near(mbGet.json.billed_pct, 30) && near(mbGet.json.remaining_to_bill, 70000), JSON.stringify({ p: mbGet.json.billed_pct, rem: mbGet.json.remaining_to_bill }));
  const mbOver = await inj('POST', '/api/projects/PRJ-F/bill', admin, { percent: 80 }); // 30 + 80 = 110% > contract
  ok('Over-bill a Fixed contract beyond 100% → 400 BILL_EXCEEDS_CONTRACT', mbOver.status === 400 && mbOver.json.error?.code === 'BILL_EXCEEDS_CONTRACT', `${mbOver.status} ${mbOver.json.error?.code}`);

  // ── 9. budget-overrun variance: a cost beyond budget flags over_budget + a negative variance ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-G', name: 'งานมีงบจำกัด', billing_type: 'TM', budget_amount: 5000 });
  await inj('POST', '/api/projects/PRJ-G/cost', admin, { entry_type: 'time', amount: 6000 });
  const bg = await inj('GET', '/api/projects/PRJ-G', admin);
  ok('Budget overrun: total 6000 vs budget 5000 → over_budget, variance −1000, used 120%',
    bg.json.over_budget === true && near(bg.json.budget_variance, -1000) && near(bg.json.budget_used_pct, 120), JSON.stringify({ ob: bg.json.over_budget, v: bg.json.budget_variance, u: bg.json.budget_used_pct }));

  // ── 10. opportunity → project conversion (CRM-WL): a WON deal seeds a project with customer + contract ──
  const opp = await inj('POST', '/api/crm/pipeline/opportunities', admin, { name: 'ดีลใหญ่ ACME', customer_no: 'CUS-X', amount: 250000 });
  const oppNo = opp.json.opp_no;
  await inj('PATCH', `/api/crm/pipeline/opportunities/${oppNo}/stage`, admin, { stage: 'won' });
  const conv = await inj('POST', `/api/projects/from-opportunity/${oppNo}`, admin, { project_code: 'PRJ-WON', billing_type: 'Fixed' });
  ok('Won opportunity → project: contract seeded 250000, crm_opp_no linked, status Open',
    conv.status < 300 && conv.json.project_code === 'PRJ-WON' && near(conv.json.contract_amount, 250000) && conv.json.crm_opp_no === oppNo && conv.json.status === 'Open',
    JSON.stringify({ s: conv.status, c: conv.json.contract_amount, link: conv.json.crm_opp_no }));
  // Idempotency: the same opportunity converts to at most one project (re-submit returns the same project).
  const conv2 = await inj('POST', `/api/projects/from-opportunity/${oppNo}`, admin, {});
  ok('Re-convert same opportunity → idempotent (already), no duplicate project',
    conv2.json.already === true && conv2.json.project_code === 'PRJ-WON', JSON.stringify({ a: conv2.json.already }));
  // Control: an OPEN (not-won) opportunity cannot convert.
  const oppOpen = await inj('POST', '/api/crm/pipeline/opportunities', admin, { name: 'ดีลยังไม่ปิด', amount: 5000 });
  const conv3 = await inj('POST', `/api/projects/from-opportunity/${oppOpen.json.opp_no}`, admin, {});
  ok('Open (not-won) opportunity → conversion rejected (400 OPP_NOT_WON)',
    conv3.status === 400 && conv3.json.error?.code === 'OPP_NOT_WON', `${conv3.status} ${conv3.json.error?.code}`);
  // Control: an unknown opportunity is rejected.
  const conv4 = await inj('POST', '/api/projects/from-opportunity/OPP-NOPE', admin, {});
  ok('Unknown opportunity → 404 OPP_NOT_FOUND', conv4.status === 404 && conv4.json.error?.code === 'OPP_NOT_FOUND', `${conv4.status} ${conv4.json.error?.code}`);

  // ── 11. WBS tasks: planned-hours-weighted % complete roll-up (P1) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-WBS', name: 'งานแบ่ง WBS', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-WBS/tasks', admin, { name: 'ออกแบบ', planned_hours: 10, pct_complete: 50 });
  const tList = await inj('POST', '/api/projects/PRJ-WBS/tasks', admin, { name: 'พัฒนา', planned_hours: 30, pct_complete: 0 });
  ok('WBS roll-up: tasks 10h@50% + 30h@0% → project 12.5% complete', near(tList.json.pct_complete, 12.5) && tList.json.count === 2, JSON.stringify({ p: tList.json.pct_complete, c: tList.json.count }));
  // Mark the 30h task done → 100%; roll-up = (10×50 + 30×100)/40 = 87.5
  const taskB = (tList.json.tasks ?? []).find((t: any) => t.name === 'พัฒนา');
  const pt = await inj('PATCH', `/api/projects/tasks/${taskB.id}`, admin, { status: 'done' });
  ok('Mark 30h task done → 100%; project roll-up 87.5%', near(pt.json.pct_complete, 87.5), JSON.stringify({ p: pt.json.pct_complete }));
  const wbsGet = await inj('GET', '/api/projects/PRJ-WBS', admin);
  ok('Project detail exposes pct_complete 87.5 + task_count 2', near(wbsGet.json.pct_complete, 87.5) && wbsGet.json.task_count === 2, JSON.stringify({ p: wbsGet.json.pct_complete, tc: wbsGet.json.task_count }));
  const ptBad = await inj('PATCH', '/api/projects/tasks/999999', admin, { status: 'done' });
  ok('Patch unknown task → 404 TASK_NOT_FOUND', ptBad.status === 404 && ptBad.json.error?.code === 'TASK_NOT_FOUND', `${ptBad.status} ${ptBad.json.error?.code}`);

  // ── 12. Milestones: completion of a billing milestone raises the Fixed-price progress bill (PROJ-02) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-MS', name: 'งานมีหมุดหมาย', billing_type: 'Fixed', contract_amount: 100000 });
  const ms1 = await inj('POST', '/api/projects/PRJ-MS/milestones', admin, { name: 'เฟส 1 ส่งมอบ', billing_percent: 40 });
  const mId = ms1.json.milestones[0].id;
  const reach = await inj('POST', `/api/projects/milestones/${mId}/reach`, admin, {});
  ok('Reach a 40%-billing milestone → Fixed bill 40000 via PRJ-BILL (PROJ-02)',
    reach.json.status === 'reached' && near(reach.json.billing?.revenue, 40000) && /^JE-/.test(reach.json.billing?.entry_no ?? ''), JSON.stringify({ s: reach.json.status, r: reach.json.billing?.revenue }));
  const reach2 = await inj('POST', `/api/projects/milestones/${mId}/reach`, admin, {});
  ok('Re-reach the same milestone → 400 MILESTONE_REACHED (no double bill)', reach2.status === 400 && reach2.json.error?.code === 'MILESTONE_REACHED', `${reach2.status} ${reach2.json.error?.code}`);
  // A non-billing milestone reaches without raising a bill.
  const ms2 = await inj('POST', '/api/projects/PRJ-MS/milestones', admin, { name: 'kickoff' });
  const reach3 = await inj('POST', `/api/projects/milestones/${ms2.json.milestones.find((m: any) => m.name === 'kickoff').id}/reach`, admin, {});
  ok('Reach a non-billing milestone → reached, no billing', reach3.json.status === 'reached' && reach3.json.billing == null, JSON.stringify({ s: reach3.json.status, b: reach3.json.billing }));
  const reachBad = await inj('POST', '/api/projects/milestones/999999/reach', admin, {});
  ok('Reach unknown milestone → 404 MILESTONE_NOT_FOUND', reachBad.status === 404 && reachBad.json.error?.code === 'MILESTONE_NOT_FOUND', `${reachBad.status} ${reachBad.json.error?.code}`);

  // ── 13. Resourcing: rate card governs the snapshot rate; utilization flags over-allocation (PROJ-05, P2) ──
  await inj('POST', '/api/projects/rate-cards', admin, { role: 'Senior Dev', cost_rate: 1000, bill_rate: 2000, effective_from: '2026-01-01' });
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-RES', name: 'งานจัดสรรคน', billing_type: 'TM' });
  const asg = await inj('POST', '/api/projects/PRJ-RES/resources', admin, { resource_name: 'Alice', role: 'Senior Dev', alloc_pct: 60, period_start: '2026-02-01' });
  const alice = (asg.json.resources ?? []).find((r: any) => r.resource_name === 'Alice');
  ok('Assign resource → rate-card rates snapshotted (cost 1000, bill 2000)', near(alice?.cost_rate, 1000) && near(alice?.bill_rate, 2000) && near(alice?.alloc_pct, 60), JSON.stringify({ c: alice?.cost_rate, b: alice?.bill_rate }));
  // Same resource booked 60% on a second project → 120% total → over-allocated.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-RES2', name: 'งานคู่ขนาน', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-RES2/resources', admin, { resource_name: 'Alice', role: 'Senior Dev', alloc_pct: 60, period_start: '2026-02-01' });
  const util = await inj('GET', '/api/projects/resources/utilization', admin);
  const au = (util.json.utilization ?? []).find((u: any) => u.resource_name === 'Alice');
  ok('Utilization: Alice 60%+60% = 120% → over_allocated', near(au?.allocated_pct, 120) && au?.over_allocated === true && util.json.over_allocated_count >= 1, JSON.stringify({ a: au?.allocated_pct, o: au?.over_allocated }));
  // A role with no rate card → zero snapshot rates (no guessed rate).
  const asgBob = await inj('POST', '/api/projects/PRJ-RES/resources', admin, { resource_name: 'Bob', role: 'Unknown' });
  const bob = (asgBob.json.resources ?? []).find((r: any) => r.resource_name === 'Bob');
  ok('Assign with no rate card → cost/bill rate 0 (not guessed)', near(bob?.cost_rate, 0) && near(bob?.bill_rate, 0), JSON.stringify({ c: bob?.cost_rate }));
  // Allocation guard.
  const asgBad = await inj('POST', '/api/projects/PRJ-RES/resources', admin, { resource_name: 'Carol', alloc_pct: 0 });
  ok('Assign with alloc_pct 0 → 400 BAD_ALLOC', asgBad.status === 400 && asgBad.json.error?.code === 'BAD_ALLOC', `${asgBad.status} ${asgBad.json.error?.code}`);

  // ── 14. Timesheet → project labor: maker-checker approval posts labor to project WIP (PROJ-04, P3) ──
  const emp = await inj('POST', '/api/payroll/employees', admin, { name: 'Somchai', national_id: '1234567890123', monthly_salary: 30000, hourly_rate: 200, pf_rate: 0.05 });
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-TS', name: 'งานคิดชั่วโมง', billing_type: 'TM' });
  const ts = await inj('POST', '/api/hcm/timesheets', admin, { emp_code: emp.json.emp_code, work_date: '2026-06-15', regular_hours: 8, project_code: 'PRJ-TS', billable: true });
  ok('Timesheet logged Pending with submitter', ts.json.status === 'Pending' && ts.json.id > 0, JSON.stringify({ s: ts.json.status, id: ts.json.id }));
  // SoD: the submitter (admin) cannot approve their own timesheet.
  const selfApprove = await inj('POST', `/api/hcm/timesheets/${ts.json.id}/approve`, admin, {});
  ok('Self-approve own timesheet → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', `${selfApprove.status} ${selfApprove.json.error?.code}`);
  // Independent approver (mgr) approves → 8h × ฿200 = ฿1600 labor posts to project WIP via PRJ-COST.
  const appr = await inj('POST', `/api/hcm/timesheets/${ts.json.id}/approve`, mgr, {});
  ok('Independent approve → labor 1600 posts to project (PRJ-COST), entry JE-…',
    appr.json.status === 'Approved' && near(appr.json.labor_cost, 1600) && appr.json.project_posted === true && /^JE-/.test(appr.json.entry_no ?? ''), JSON.stringify({ s: appr.json.status, c: appr.json.labor_cost }));
  const tsProj = await inj('GET', '/api/projects/PRJ-TS', admin);
  ok('Project WIP reflects approved timesheet labor: cost_to_date 1600', near(tsProj.json.cost_to_date, 1600) && near(tsProj.json.wip, 1600), JSON.stringify({ c: tsProj.json.cost_to_date, w: tsProj.json.wip }));
  // Idempotent: re-approving an approved timesheet does not double-post.
  const appr2 = await inj('POST', `/api/hcm/timesheets/${ts.json.id}/approve`, mgr, {});
  const tsProj2 = await inj('GET', '/api/projects/PRJ-TS', admin);
  ok('Re-approve → already, no double-post (cost_to_date still 1600)', appr2.json.already === true && near(tsProj2.json.cost_to_date, 1600), JSON.stringify({ a: appr2.json.already, c: tsProj2.json.cost_to_date }));
  const apprBad = await inj('POST', '/api/hcm/timesheets/999999/approve', mgr, {});
  ok('Approve unknown timesheet → 404 TIMESHEET_NOT_FOUND', apprBad.status === 404 && apprBad.json.error?.code === 'TIMESHEET_NOT_FOUND', `${apprBad.status} ${apprBad.json.error?.code}`);

  // ── 15. Earned-value management + task dependencies (PROJ-06, P4) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-EVM', name: 'งานวัด EVM', billing_type: 'TM' });
  const t1r = await inj('POST', '/api/projects/PRJ-EVM/tasks', admin, { name: 'EV-T1', planned_cost: 1000, planned_end: '2026-01-31', pct_complete: 100 });
  const t1 = t1r.json.tasks.find((t: any) => t.name === 'EV-T1');
  const t2r = await inj('POST', '/api/projects/PRJ-EVM/tasks', admin, { name: 'EV-T2', planned_cost: 1000, planned_end: '2099-12-31', pct_complete: 0, depends_on: [t1.id] });
  const t2 = t2r.json.tasks.find((t: any) => t.name === 'EV-T2');
  ok('Task dependency stored: EV-T2 depends_on [EV-T1]', Array.isArray(t2.depends_on) && t2.depends_on.includes(t1.id), JSON.stringify({ d: t2.depends_on }));
  await inj('POST', '/api/projects/PRJ-EVM/cost', admin, { entry_type: 'time', amount: 900, billable: true }); // actual cost
  const evm = await inj('GET', '/api/projects/PRJ-EVM/evm', admin);
  ok('EVM: BAC 2000, EV 1000, PV 1000 (T1 past/T2 future), AC 900 → CPI 1.1111, SPI 1.0, CV 100, SV 0, EAC ~1800',
    near(evm.json.bac, 2000) && near(evm.json.ev, 1000) && near(evm.json.pv, 1000) && near(evm.json.ac, 900) &&
    near(evm.json.cpi, 1.1111) && near(evm.json.spi, 1.0) && near(evm.json.cost_variance, 100) && near(evm.json.schedule_variance, 0) && Math.abs(evm.json.eac - 1800) < 0.5,
    JSON.stringify({ cpi: evm.json.cpi, spi: evm.json.spi, ev: evm.json.ev, pv: evm.json.pv, ac: evm.json.ac, eac: evm.json.eac }));
  // Self-dependency guard.
  const badDep = await inj('PATCH', `/api/projects/tasks/${t1.id}`, admin, { depends_on: [t1.id] });
  ok('Task depends on itself → 400 BAD_DEPENDENCY', badDep.status === 400 && badDep.json.error?.code === 'BAD_DEPENDENCY', `${badDep.status} ${badDep.json.error?.code}`);

  // ── 16. critical-path schedule, EVM S-curve series, and win/loss analytics (PPM web backend) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-CPM', name: 'งานหา critical path', billing_type: 'TM' });
  const cA = await inj('POST', '/api/projects/PRJ-CPM/tasks', admin, { name: 'CP-A', planned_hours: 16 }); // 2d
  const cAid = cA.json.tasks[0].id;
  await inj('POST', '/api/projects/PRJ-CPM/tasks', admin, { name: 'CP-B', planned_hours: 24, depends_on: [cAid] }); // 3d
  const cC = await inj('POST', '/api/projects/PRJ-CPM/tasks', admin, { name: 'CP-C', planned_hours: 8, depends_on: [cAid] }); // 1d
  const cBid = cC.json.tasks.find((t: any) => t.name === 'CP-B').id, cCid = cC.json.tasks.find((t: any) => t.name === 'CP-C').id;
  await inj('POST', '/api/projects/PRJ-CPM/tasks', admin, { name: 'CP-D', planned_hours: 16, depends_on: [cBid, cCid] }); // 2d
  const sched = await inj('GET', '/api/projects/PRJ-CPM/schedule', admin);
  const onCP = (name: string) => (sched.json.tasks ?? []).find((t: any) => t.name === name)?.on_critical_path;
  ok('Critical path: A→B→D (slack 0) on path, C (slack 2) off; project duration 7 days',
    sched.json.project_duration_days === 7 && onCP('CP-A') && onCP('CP-B') && onCP('CP-D') && onCP('CP-C') === false,
    JSON.stringify({ dur: sched.json.project_duration_days, cp: sched.json.critical_path }));

  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-SC', name: 'งาน S-curve', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-SC/tasks', admin, { name: 'SC-1', planned_cost: 1000, planned_end: '2026-01-31', pct_complete: 100 });
  await inj('POST', '/api/projects/PRJ-SC/tasks', admin, { name: 'SC-2', planned_cost: 1000, planned_end: '2026-02-28', pct_complete: 0 });
  const series = await inj('GET', '/api/projects/PRJ-SC/evm/series', admin);
  ok('EVM S-curve: cumulative planned 1000→2000 across 2 months; current BAC 2000',
    series.json.series?.length === 2 && near(series.json.series[1].cumulative_planned, 2000) && near(series.json.bac, 2000),
    JSON.stringify({ n: series.json.series?.length, cum: series.json.series?.[1]?.cumulative_planned }));

  const oppLost = await inj('POST', '/api/crm/pipeline/opportunities', admin, { name: 'ดีลที่เสีย', amount: 50000, owner: 'sales1' });
  await inj('PATCH', `/api/crm/pipeline/opportunities/${oppLost.json.opp_no}/stage`, admin, { stage: 'lost', lost_reason: 'ราคาสูงเกินไป (price)' });
  const wl = await inj('GET', '/api/crm/pipeline/win-loss', admin);
  ok('Win/loss analytics: loss reason captured (50000), by-owner + summary win_rate present',
    (wl.json.loss_reasons ?? []).some((r: any) => near(r.amount, 50000)) && Array.isArray(wl.json.by_owner) && wl.json.summary?.win_rate != null,
    JSON.stringify({ lr: wl.json.loss_reasons?.length, ow: wl.json.by_owner?.length }));

  // ── 17. schedulable BI report types: project_evm + crm_win_loss generate successfully ──
  const evmSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Portfolio EVM', report_type: 'project_evm', frequency: 'weekly' });
  const evmRun = await inj('POST', `/api/bi/subscriptions/${evmSub.json.id}/run`, admin, {});
  ok('BI report project_evm runs success (portfolio EVM)', evmRun.json.status === 'success' && /Portfolio EVM/.test(evmRun.json.summary ?? ''), JSON.stringify({ s: evmRun.json.status, sum: (evmRun.json.summary ?? '').slice(0, 40) }));
  const wlSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Win/Loss', report_type: 'crm_win_loss', frequency: 'weekly' });
  const wlRun = await inj('POST', `/api/bi/subscriptions/${wlSub.json.id}/run`, admin, {});
  ok('BI report crm_win_loss runs success (win/loss analytics)', wlRun.json.status === 'success' && /[Ww]in\/loss/.test(wlRun.json.summary ?? ''), JSON.stringify({ s: wlRun.json.status }));
  const rtypes = await inj('GET', '/api/bi/report-types', admin);
  ok('report-types catalog exposes project_evm + crm_win_loss', JSON.stringify(rtypes.json).includes('project_evm') && JSON.stringify(rtypes.json).includes('crm_win_loss'), '');

  // ── 18. portfolio command center: cross-project rollup (A1) ──
  const pf = await inj('GET', '/api/projects/portfolio', admin);
  ok('Portfolio: count + EVM totals + health buckets + financials + capacity + pipeline funnel',
    pf.status < 300 && pf.json.count > 0 && !!pf.json.totals && typeof pf.json.health?.on_track === 'number' &&
    !!pf.json.financials && typeof pf.json.capacity?.over_allocated_count === 'number' &&
    pf.json.funnel?.won_count >= 1 && pf.json.funnel?.converted_count >= 1 && Array.isArray(pf.json.at_risk),
    JSON.stringify({ c: pf.json.count, won: pf.json.funnel?.won_count, conv: pf.json.funnel?.converted_count, oa: pf.json.capacity?.over_allocated_count }));

  // ── 19. baselines & variance: change-controlled re-baselining + scope/cost creep (PROJ-07, B1) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-BL', name: 'งานมีเส้นฐาน', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-BL/tasks', admin, { name: 'BL-1', planned_cost: 1000, planned_hours: 8 });
  await inj('POST', '/api/projects/PRJ-BL/tasks', admin, { name: 'BL-2', planned_cost: 1000, planned_hours: 8 });
  const bl1 = await inj('POST', '/api/projects/PRJ-BL/baseline', admin, { label: 'v1' });
  ok('Capture baseline → BAC 2000, active, history 1', near(bl1.json.baseline?.baseline_bac, 2000) && bl1.json.baseline?.status === 'active' && bl1.json.history?.length === 1, JSON.stringify({ b: bl1.json.baseline?.baseline_bac }));
  // Add scope (another 500) → variance vs baseline shows +500 / +25%.
  await inj('POST', '/api/projects/PRJ-BL/tasks', admin, { name: 'BL-3', planned_cost: 500, planned_hours: 4 });
  const blv = await inj('GET', '/api/projects/PRJ-BL/baseline', admin);
  ok('Plan drift vs baseline → bac_delta 500, bac_pct 25', near(blv.json.variance?.bac_delta, 500) && near(blv.json.variance?.bac_pct, 25), JSON.stringify({ d: blv.json.variance?.bac_delta, p: blv.json.variance?.bac_pct }));
  // Re-baseline without a reason → blocked (PROJ-07 change governance).
  const blBad = await inj('POST', '/api/projects/PRJ-BL/baseline', admin, { label: 'v2' });
  ok('Re-baseline without reason → 400 BASELINE_REASON_REQUIRED', blBad.status === 400 && blBad.json.error?.code === 'BASELINE_REASON_REQUIRED', `${blBad.status} ${blBad.json.error?.code}`);
  const bl2 = await inj('POST', '/api/projects/PRJ-BL/baseline', admin, { label: 'v2', reason: 'อนุมัติขยายขอบเขต' });
  ok('Re-baseline with reason → new active BAC 2500, variance 0, history 2', near(bl2.json.baseline?.baseline_bac, 2500) && near(bl2.json.variance?.bac_delta, 0) && bl2.json.history?.length === 2, JSON.stringify({ b: bl2.json.baseline?.baseline_bac, h: bl2.json.history?.length }));

  // ── 20. project templates: reusable WBS/milestone scaffold → one-step apply (B2) ──
  const tpl = await inj('POST', '/api/projects/templates', admin, {
    code: 'IMPL-STD', name: 'แม่แบบติดตั้งมาตรฐาน', description: 'Kickoff → Build → Go-live',
    items: [
      { seq: 1, name: 'Kickoff', planned_hours: 8, planned_cost: 1000, offset_start_days: 0, offset_end_days: 1 },
      { seq: 2, name: 'Build', planned_hours: 40, planned_cost: 5000, offset_start_days: 1, offset_end_days: 10, depends_on_seq: [1] },
      { seq: 3, name: 'Build — config', parent_seq: 2, planned_hours: 16, planned_cost: 2000, offset_start_days: 1, offset_end_days: 5 },
      { item_type: 'milestone', seq: 4, name: 'Go-live', offset_end_days: 12, billing_percent: 50, owner: 'pm1' },
    ],
  });
  ok('Create template IMPL-STD → 4 items (3 task + 1 milestone)', tpl.json.count === 4 && tpl.json.items?.filter((i: any) => i.item_type === 'milestone').length === 1, JSON.stringify({ c: tpl.json.count }));
  const tdup = await inj('POST', '/api/projects/templates', admin, { code: 'IMPL-STD', name: 'ซ้ำ' });
  ok('Duplicate template code → 400 TEMPLATE_EXISTS', tdup.status === 400 && tdup.json.error?.code === 'TEMPLATE_EXISTS', `${tdup.status} ${tdup.json.error?.code}`);
  const tlist = await inj('GET', '/api/projects/templates', admin);
  ok('List templates → IMPL-STD present with item_count 4', (tlist.json.templates ?? []).some((t: any) => t.code === 'IMPL-STD' && t.item_count === 4), '');

  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-TPL', name: 'งานใช้แม่แบบ', billing_type: 'Fixed', contract_amount: 100000, start_date: '2026-03-01' });
  const applied = await inj('POST', '/api/projects/PRJ-TPL/apply-template/IMPL-STD', admin, {});
  ok('Apply template → 3 tasks + 1 milestone scaffolded', applied.json.tasks_created === 3 && applied.json.milestones_created === 1 && applied.json.tasks?.length === 3, JSON.stringify({ t: applied.json.tasks_created, m: applied.json.milestones_created }));
  const buildTask = (applied.json.tasks ?? []).find((t: any) => t.name === 'Build');
  const configTask = (applied.json.tasks ?? []).find((t: any) => t.name === 'Build — config');
  const kickoffTask = (applied.json.tasks ?? []).find((t: any) => t.name === 'Kickoff');
  ok('Applied tasks: relative dates off start 2026-03-01 (Kickoff ends 2026-03-02)', kickoffTask?.planned_start === '2026-03-01' && kickoffTask?.planned_end === '2026-03-02', JSON.stringify({ s: kickoffTask?.planned_start, e: kickoffTask?.planned_end }));
  ok('Applied tasks: depends_on + parent wired by seq (Build←Kickoff, config parent=Build)',
    (buildTask?.depends_on ?? []).includes(kickoffTask?.id) && configTask?.parent_id === buildTask?.id,
    JSON.stringify({ dep: buildTask?.depends_on, par: configTask?.parent_id, bid: buildTask?.id }));
  const tplMs = await inj('GET', '/api/projects/PRJ-TPL/milestones', admin);
  ok('Applied milestone: Go-live due 2026-03-13, billing 50%', (tplMs.json.milestones ?? []).some((m: any) => m.name === 'Go-live' && m.due_date === '2026-03-13' && near(m.billing_percent, 50)), JSON.stringify({ ms: (tplMs.json.milestones ?? []).map((m: any) => m.due_date) }));
  const reapply = await inj('POST', '/api/projects/PRJ-TPL/apply-template/IMPL-STD', admin, {});
  ok('Re-apply to a project with tasks → 400 PROJECT_HAS_TASKS', reapply.status === 400 && reapply.json.error?.code === 'PROJECT_HAS_TASKS', `${reapply.status} ${reapply.json.error?.code}`);

  // ── 21. RACI accountability + "my tasks" (B3) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-RACI', name: 'งาน RACI', billing_type: 'TM' });
  const rt1 = await inj('POST', '/api/projects/PRJ-RACI/tasks', admin, { name: 'RACI-A', planned_hours: 8, accountable: 'admin', responsible: ['mgr', 'dev1'], consulted: ['arch'], informed: ['exec'] });
  const rTaskA = rt1.json.tasks.find((t: any) => t.name === 'RACI-A');
  ok('Task RACI stored: A=admin, R=[mgr,dev1], C=[arch], I=[exec]',
    rTaskA?.accountable === 'admin' && JSON.stringify(rTaskA?.responsible) === JSON.stringify(['mgr', 'dev1']) && JSON.stringify(rTaskA?.consulted) === JSON.stringify(['arch']),
    JSON.stringify({ a: rTaskA?.accountable, r: rTaskA?.responsible }));
  // A second task with mgr accountable and no consulted; one task left without an accountable owner.
  await inj('POST', '/api/projects/PRJ-RACI/tasks', admin, { name: 'RACI-B', planned_hours: 4, accountable: 'mgr', responsible: ['admin'] });
  await inj('POST', '/api/projects/PRJ-RACI/tasks', admin, { name: 'RACI-C', planned_hours: 2, responsible: ['dev1'] }); // no accountable → gap
  const patchR = await inj('PATCH', `/api/projects/tasks/${rTaskA.id}`, admin, { consulted: ['arch', 'qa'] });
  const rTaskA2 = patchR.json.tasks.find((t: any) => t.id === rTaskA.id);
  ok('Patch RACI: consulted updated to [arch,qa] (dedup/trim)', JSON.stringify(rTaskA2?.consulted) === JSON.stringify(['arch', 'qa']), JSON.stringify({ c: rTaskA2?.consulted }));
  const raci = await inj('GET', '/api/projects/PRJ-RACI/raci', admin);
  ok('RACI matrix: 3 tasks, admin accountable on 1 + responsible on 1, gap flagged (RACI-C)',
    raci.json.count === 3 && raci.json.missing_accountable?.length === 1 && raci.json.complete === false &&
    raci.json.people?.find((p: any) => p.name === 'admin')?.accountable === 1 && raci.json.people?.find((p: any) => p.name === 'admin')?.responsible === 1,
    JSON.stringify({ c: raci.json.count, gap: raci.json.missing_accountable }));
  const mine = await inj('GET', '/api/projects/my-tasks', admin);
  // admin: accountable on RACI-A, responsible on RACI-B → 2 of their open tasks (plus any from earlier projects where admin is A/R — none set elsewhere).
  ok('My tasks (admin): RACI-A (accountable) + RACI-B (responsible) present with my_role',
    (mine.json.tasks ?? []).some((t: any) => t.name === 'RACI-A' && t.my_role === 'accountable') &&
    (mine.json.tasks ?? []).some((t: any) => t.name === 'RACI-B' && t.my_role === 'responsible'),
    JSON.stringify({ n: (mine.json.tasks ?? []).map((t: any) => `${t.name}:${t.my_role}`) }));
  const mineMgr = await inj('GET', '/api/projects/my-tasks', mgr);
  ok('My tasks (mgr): RACI-A (responsible) + RACI-B (accountable); excludes RACI-C',
    (mineMgr.json.tasks ?? []).some((t: any) => t.name === 'RACI-A' && t.my_role === 'responsible') &&
    (mineMgr.json.tasks ?? []).some((t: any) => t.name === 'RACI-B' && t.my_role === 'accountable') &&
    !(mineMgr.json.tasks ?? []).some((t: any) => t.name === 'RACI-C'),
    JSON.stringify({ n: (mineMgr.json.tasks ?? []).map((t: any) => t.name) }));

  // ── 22. risk & issue register + portfolio top-risks (PROJ-08, B4) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-RISK', name: 'งานมีความเสี่ยง', billing_type: 'TM' });
  const rk1 = await inj('POST', '/api/projects/PRJ-RISK/risks', admin, { title: 'Key vendor may slip', probability: 5, impact: 5, owner: 'pm1' }); // 25 red, no mitigation
  ok('Add HIGH risk (5×5=25, red), no mitigation → summary high_open 1, unmitigated_high 1',
    rk1.json.summary?.high_open === 1 && rk1.json.summary?.unmitigated_high === 1 && rk1.json.risks?.[0]?.score === 25 && rk1.json.risks?.[0]?.rag === 'red',
    JSON.stringify({ h: rk1.json.summary?.high_open, u: rk1.json.summary?.unmitigated_high, s: rk1.json.risks?.[0]?.score }));
  const highId = rk1.json.risks.find((r: any) => r.title === 'Key vendor may slip').id;
  await inj('POST', '/api/projects/PRJ-RISK/risks', admin, { kind: 'issue', title: 'Env outage', impact: 4, mitigation: 'Failover to DR', owner: 'ops' }); // issue 5×4=20 red, mitigated
  const rk3 = await inj('POST', '/api/projects/PRJ-RISK/risks', admin, { title: 'Minor doc gap', probability: 1, impact: 2 }); // 2 green
  ok('Issue scored 5×impact (20, red); low risk green; register summary risks 2 / issues 1',
    rk3.json.summary?.risks === 2 && rk3.json.summary?.issues === 1 && rk3.json.risks?.some((r: any) => r.kind === 'issue' && r.score === 20 && r.rag === 'red') && rk3.json.risks?.some((r: any) => r.rag === 'green'),
    JSON.stringify({ r: rk3.json.summary?.risks, i: rk3.json.summary?.issues }));
  const mit = await inj('PATCH', `/api/projects/risks/${highId}`, admin, { mitigation: 'Dual-source the vendor', status: 'mitigating' });
  ok('Mitigate the HIGH risk → unmitigated_high falls to 0 (still high_open 2)',
    mit.json.summary?.unmitigated_high === 0 && mit.json.summary?.high_open === 2, JSON.stringify({ u: mit.json.summary?.unmitigated_high, h: mit.json.summary?.high_open }));
  const top = await inj('GET', '/api/projects/risks/top', admin);
  ok('Portfolio top-risks: open red item ranked first, high_count 2, unmitigated_high_count 0',
    top.json.top?.[0]?.score === 25 && top.json.high_count === 2 && top.json.unmitigated_high_count === 0 && top.json.top?.every((r: any) => r.project_code),
    JSON.stringify({ first: top.json.top?.[0]?.score, hc: top.json.high_count, uh: top.json.unmitigated_high_count }));
  const closeIssue = rk3.json.risks.find((r: any) => r.kind === 'issue').id;
  const closed = await inj('PATCH', `/api/projects/risks/${closeIssue}`, admin, { status: 'closed' });
  ok('Close the issue → open count drops, closed 1, closed_at stamped',
    closed.json.summary?.closed === 1 && closed.json.risks?.find((r: any) => r.id === closeIssue)?.closed_at != null, JSON.stringify({ c: closed.json.summary?.closed }));
  const rkBad = await inj('PATCH', '/api/projects/risks/999999', admin, { status: 'closed' });
  ok('Patch unknown risk → 404 RISK_NOT_FOUND', rkBad.status === 404 && rkBad.json.error?.code === 'RISK_NOT_FOUND', `${rkBad.status} ${rkBad.json.error?.code}`);

  // ── 23. POC over-time revenue recognition (PROJ-09) ──
  // Fixed-price POC project: contract 100000, estimated total cost 60000.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-POC', name: 'งานรับรู้รายได้ตามความคืบหน้า', billing_type: 'Fixed', contract_amount: 100000, rev_method: 'poc', estimated_cost: 60000 });
  await inj('POST', '/api/projects/PRJ-POC/cost', admin, { amount: 30000, billable: true });
  const rec1 = await inj('POST', '/api/projects/PRJ-POC/recognize', admin, {});
  ok('POC recognize @ 50% (cost 30000 / est 60000) → revenue 50000, cost 30000, margin 20000',
    near(rec1.json.poc_pct, 50) && near(rec1.json.revenue_recognized, 50000) && near(rec1.json.cost_recognized, 30000) && near(rec1.json.margin, 20000),
    JSON.stringify({ p: rec1.json.poc_pct, r: rec1.json.revenue_recognized, c: rec1.json.cost_recognized }));
  const pPoc = await inj('GET', '/api/projects/PRJ-POC', admin);
  ok('POC project: recognized_revenue 50000, contract_asset 50000 (earned, unbilled), margin 20000',
    near(pPoc.json.recognized_revenue, 50000) && near(pPoc.json.contract_asset, 50000) && near(pPoc.json.margin, 20000), JSON.stringify({ rr: pPoc.json.recognized_revenue, ca: pPoc.json.contract_asset }));
  const recIdem = await inj('POST', '/api/projects/PRJ-POC/recognize', admin, {});
  ok('POC re-recognize with no new progress → already (no double revenue)', recIdem.json.already === true, JSON.stringify({ a: recIdem.json.already }));
  const billPoc = await inj('POST', '/api/projects/PRJ-POC/bill', admin, { amount: 40000 });
  ok('POC bill 40000 → invoice clears contract asset (revenue 0, asset cleared 40000)',
    near(billPoc.json.billed, 40000) && near(billPoc.json.revenue, 0) && near(billPoc.json.contract_asset_cleared, 40000), JSON.stringify({ b: billPoc.json.billed, c: billPoc.json.contract_asset_cleared }));
  await inj('POST', '/api/projects/PRJ-POC/cost', admin, { amount: 30000, billable: true });
  const rec2 = await inj('POST', '/api/projects/PRJ-POC/recognize', admin, {});
  ok('POC recognize @ 100% → remaining revenue 50000, recognized-to-date 100000',
    near(rec2.json.poc_pct, 100) && near(rec2.json.revenue_recognized, 50000) && near(rec2.json.recognized_revenue_to_date, 100000), JSON.stringify({ p: rec2.json.poc_pct, r: rec2.json.revenue_recognized }));
  await inj('POST', '/api/projects/PRJ-POC/bill', admin, { amount: 60000 });
  const pDone = await inj('GET', '/api/projects/PRJ-POC', admin);
  ok('POC complete: recognized_revenue 100000 = billed 100000, contract_asset 0, WIP 0',
    near(pDone.json.recognized_revenue, 100000) && near(pDone.json.billed_to_date, 100000) && near(pDone.json.contract_asset, 0) && near(pDone.json.wip, 0), JSON.stringify({ rr: pDone.json.recognized_revenue, ca: pDone.json.contract_asset, wip: pDone.json.wip }));
  const tbPoc = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('POC postings keep the GL balanced (Σdr = Σcr)', tbPoc.json.totals?.balanced === true, JSON.stringify({ bal: tbPoc.json.totals?.balanced }));
  // Billings-in-excess path: bill BEFORE recognising → contract liability (2410); later recognition releases it.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-POC2', name: 'งานวางบิลล่วงหน้า', billing_type: 'Fixed', contract_amount: 100000, rev_method: 'poc', estimated_cost: 50000 });
  const billAhead = await inj('POST', '/api/projects/PRJ-POC2/bill', admin, { amount: 30000 });
  ok('POC bill ahead of work → billings in excess 30000 (no revenue)', near(billAhead.json.billings_in_excess, 30000) && near(billAhead.json.revenue, 0), JSON.stringify({ e: billAhead.json.billings_in_excess }));
  await inj('POST', '/api/projects/PRJ-POC2/cost', admin, { amount: 10000, billable: true });
  const recRel = await inj('POST', '/api/projects/PRJ-POC2/recognize', admin, {});
  const pPoc2 = await inj('GET', '/api/projects/PRJ-POC2', admin);
  ok('POC2 recognize @ 20% → revenue 20000 releases the liability; billings_in_excess falls to 10000',
    near(recRel.json.revenue_recognized, 20000) && near(pPoc2.json.billings_in_excess, 10000) && near(pPoc2.json.contract_asset, 0), JSON.stringify({ r: recRel.json.revenue_recognized, e: pPoc2.json.billings_in_excess }));
  // Guard: a billing-method project cannot recognise over-time.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-TMX', name: 'งานตามเวลา', billing_type: 'TM' });
  const recBad = await inj('POST', '/api/projects/PRJ-TMX/recognize', admin, {});
  ok('Recognise on a billing-method project → 400 NOT_POC', recBad.status === 400 && recBad.json.error?.code === 'NOT_POC', `${recBad.status} ${recBad.json.error?.code}`);

  // ── 24. change orders / contract variations (maker-checker, PROJ-10) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-CO', name: 'งานมีการเปลี่ยนแปลง', billing_type: 'Fixed', contract_amount: 100000, budget_amount: 60000 });
  const coEmpty = await inj('POST', '/api/projects/PRJ-CO/change-orders', admin, { description: 'no-op' });
  ok('Empty change order (no deltas) → 400 EMPTY_CHANGE_ORDER', coEmpty.status === 400 && coEmpty.json.error?.code === 'EMPTY_CHANGE_ORDER', `${coEmpty.status} ${coEmpty.json.error?.code}`);
  const coReq = await inj('POST', '/api/projects/PRJ-CO/change-orders', admin, { description: 'ขยายขอบเขต', contract_delta: 20000, budget_delta: 12000, reason: 'ลูกค้าขอเพิ่มงาน' });
  const coId = coReq.json.change_orders?.find((c: any) => c.status === 'pending')?.id;
  ok('Request change order → pending, posts nothing (contract still 100000)', coReq.json.summary?.pending === 1 && coId != null, JSON.stringify({ p: coReq.json.summary?.pending }));
  const coProjBefore = await inj('GET', '/api/projects/PRJ-CO', admin);
  ok('Change order pending → contract unchanged (still 100000)', near(coProjBefore.json.contract_amount, 100000), JSON.stringify({ c: coProjBefore.json.contract_amount }));
  const coSelf = await inj('POST', `/api/projects/change-orders/${coId}/approve`, admin, {});
  ok('Self-approve own change order → 400 SOD_SELF_APPROVAL', coSelf.status === 400 && coSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${coSelf.status} ${coSelf.json.error?.code}`);
  const coApp = await inj('POST', `/api/projects/change-orders/${coId}/approve`, mgr, {});
  ok('Independent approve → contract 120000, budget 72000, a baseline captured',
    coApp.json.status === 'approved' && near(coApp.json.contract_amount, 120000) && near(coApp.json.budget_amount, 72000) && coApp.json.baseline != null,
    JSON.stringify({ s: coApp.json.status, c: coApp.json.contract_amount, b: !!coApp.json.baseline }));
  const coList = await inj('GET', '/api/projects/PRJ-CO/change-orders', admin);
  ok('Change-order register: approved 1, approved_contract_delta 20000', coList.json.summary?.approved === 1 && near(coList.json.summary?.approved_contract_delta, 20000), JSON.stringify({ a: coList.json.summary?.approved }));
  const coReApp = await inj('POST', `/api/projects/change-orders/${coId}/approve`, mgr, {});
  ok('Re-approve a decided change order → 400 CHANGE_ORDER_DECIDED', coReApp.status === 400 && coReApp.json.error?.code === 'CHANGE_ORDER_DECIDED', `${coReApp.status} ${coReApp.json.error?.code}`);

  // ── 25. time-phased resource capacity calendar (PPM upgrade) ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-CAP', name: 'งานวางกำลังคน', billing_type: 'TM' });
  // Bob: 60% Jul–Aug, +60% Aug–Sep → August double-booked to 120%.
  await inj('POST', '/api/projects/PRJ-CAP/resources', admin, { resource_name: 'CapZed', alloc_pct: 60, period_start: '2026-07-01', period_end: '2026-08-31' });
  await inj('POST', '/api/projects/PRJ-CAP/resources', admin, { resource_name: 'CapZed', alloc_pct: 60, period_start: '2026-08-01', period_end: '2026-09-30' });
  const cap = await inj('GET', '/api/projects/resources/capacity?from=2026-07&months=3', admin);
  const bobCap = (cap.json.resources ?? []).find((r: any) => r.resource_name === 'CapZed');
  const mAt = (mm: string) => bobCap?.months?.find((c: any) => c.month === mm);
  ok('Capacity calendar: Bob Jul 60 / Aug 120 (over) / Sep 60 — peak 120, 1 over-month',
    near(mAt('2026-07')?.allocated_pct, 60) && near(mAt('2026-08')?.allocated_pct, 120) && mAt('2026-08')?.over_allocated === true && near(mAt('2026-09')?.allocated_pct, 60) && near(bobCap?.peak_pct, 120) && bobCap?.over_months === 1,
    JSON.stringify({ jul: mAt('2026-07')?.allocated_pct, aug: mAt('2026-08')?.allocated_pct, sep: mAt('2026-09')?.allocated_pct, peak: bobCap?.peak_pct }));
  const augRow = (cap.json.monthly ?? []).find((m: any) => m.month === '2026-08');
  ok('Capacity calendar monthly rollup: August flags ≥1 over-allocated resource', augRow && augRow.resources_over >= 1 && augRow.total_demand_pct >= 120, JSON.stringify({ over: augRow?.resources_over, demand: augRow?.total_demand_pct }));

  // ── 26. project health history (EVM/RAG snapshots over time, PPM upgrade) ──
  // PRJ-EVM has CPI 1.1111 / SPI 1.0 → both ≥ 1 → green.
  const h1 = await inj('POST', '/api/projects/PRJ-EVM/health', admin, { as_of: '2026-02-15' });
  ok('Capture health snapshot → rag green (CPI 1.11 / SPI 1.0)', h1.json.rag === 'green' && near(h1.json.cpi, 1.1111), JSON.stringify({ rag: h1.json.rag, cpi: h1.json.cpi }));
  await inj('POST', '/api/projects/PRJ-EVM/health', admin, { as_of: '2026-03-15' });
  await inj('POST', '/api/projects/PRJ-EVM/health', admin, { as_of: '2026-03-15' }); // idempotent per (project, date)
  const hist = await inj('GET', '/api/projects/PRJ-EVM/health', admin);
  ok('Health history: 2 dated snapshots (ascending), same-day re-capture is idempotent',
    hist.json.count === 2 && hist.json.history?.[0]?.snapshot_date === '2026-02-15' && hist.json.history?.[1]?.snapshot_date === '2026-03-15' && hist.json.history.every((s: any) => s.rag === 'green'),
    JSON.stringify({ n: hist.json.count, dates: (hist.json.history ?? []).map((s: any) => s.snapshot_date) }));
  // Scheduled action job: project_health_capture snapshots every project.
  const phSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Project health', report_type: 'project_health_capture', frequency: 'weekly' });
  const phRun = await inj('POST', `/api/bi/subscriptions/${phSub.json.id}/run`, admin, {});
  ok('BI project_health_capture runs success (snapshots all projects)', phRun.json.status === 'success' && /captured/.test(phRun.json.summary ?? ''), JSON.stringify({ s: phRun.json.status, sum: (phRun.json.summary ?? '').slice(0, 40) }));

  console.log('\n── Phase 18 — Projects/PPM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} projects checks failed` : `\n✅ All ${checks.length} projects checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
