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

  console.log('\n── Phase 18 — Projects/PPM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} projects checks failed` : `\n✅ All ${checks.length} projects checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
