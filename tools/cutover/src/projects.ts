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

  // ── 9b. Bill of Quantities (BoQ) — M0 (docs/32): rate-built lines → maker-checker approve → budget baseline ──
  const boqCreate = await inj('POST', '/api/projects/PRJ-A/boq', admin, {
    title: 'BoQ งานติดตั้ง', lines: [
      { category: 'material', item_no: 'CEMENT', description: 'ปูนซีเมนต์', uom: 'ถุง', budget_qty: 100, rate: 150 }, // 15000
      { category: 'labor', description: 'ค่าแรงติดตั้ง', budget_qty: 20, rate: 500 },                                 // 10000
    ],
  });
  ok('BoQ create → draft, 2 lines, budget_total 25000',
    boqCreate.status < 300 && boqCreate.json.boq?.status === 'draft' && boqCreate.json.count === 2 && near(boqCreate.json.budget_total, 25000),
    JSON.stringify({ s: boqCreate.status, st: boqCreate.json.boq?.status, t: boqCreate.json.budget_total }));
  const boqId = boqCreate.json.boq?.id;
  const matLineId = (boqCreate.json.lines ?? []).find((l: any) => l.item_no === 'CEMENT')?.id;

  const boqAdd = await inj('POST', `/api/projects/boq/${boqId}/lines`, admin, { category: 'subcon', description: 'งานรับเหมาช่วง', budget_amount: 5000 });
  ok('BoQ add line to draft → 3 lines, budget_total 30000', boqAdd.json.count === 3 && near(boqAdd.json.budget_total, 30000), JSON.stringify({ c: boqAdd.json.count, t: boqAdd.json.budget_total }));

  const boqSelf = await inj('POST', `/api/projects/boq/${boqId}/approve`, admin); // author = admin
  ok('BoQ self-approve by author → 400 SOD_SELF_APPROVAL', boqSelf.status === 400 && boqSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${boqSelf.status} ${boqSelf.json.error?.code}`);

  const boqAppr = await inj('POST', `/api/projects/boq/${boqId}/approve`, mgr); // independent checker
  ok('BoQ approve by independent checker → approved, project budget synced 30000',
    boqAppr.status < 300 && boqAppr.json.boq?.status === 'approved' && near(boqAppr.json.budget_synced, 30000),
    JSON.stringify({ s: boqAppr.status, st: boqAppr.json.boq?.status, sync: boqAppr.json.budget_synced }));
  const boqProjGet = await inj('GET', '/api/projects/PRJ-A', admin);
  ok('Project budget_amount reflects approved BoQ total (30000) + boq summary present',
    near(boqProjGet.json.budget_amount, 30000) && boqProjGet.json.boq?.status === 'approved' && near(boqProjGet.json.boq?.budget_total, 30000),
    JSON.stringify({ b: boqProjGet.json.budget_amount, boq: boqProjGet.json.boq?.budget_total }));

  const boqAddLocked = await inj('POST', `/api/projects/boq/${boqId}/lines`, admin, { description: 'x', budget_amount: 1 });
  ok('Add line to an approved BoQ → 400 BOQ_NOT_DRAFT', boqAddLocked.status === 400 && boqAddLocked.json.error?.code === 'BOQ_NOT_DRAFT', `${boqAddLocked.status} ${boqAddLocked.json.error?.code}`);

  const boqRe = await inj('POST', `/api/projects/boq/lines/${matLineId}/remeasure`, admin, { remeasured_qty: 110 });
  const reLine = (boqRe.json.lines ?? []).find((l: any) => l.id === matLineId);
  ok('Re-measure material line 100→110 → variance +10', boqRe.status < 300 && near(reLine?.remeasured_qty, 110) && near(reLine?.remeasure_variance_qty, 10), JSON.stringify({ rq: reLine?.remeasured_qty, v: reLine?.remeasure_variance_qty }));

  const boqLock = await inj('POST', `/api/projects/boq/${boqId}/lock`, mgr);
  ok('BoQ lock (approved→locked)', boqLock.status < 300 && boqLock.json.boq?.status === 'locked', JSON.stringify({ st: boqLock.json.boq?.status }));
  const boqReLocked = await inj('POST', `/api/projects/boq/lines/${matLineId}/remeasure`, admin, { remeasured_qty: 120 });
  ok('Re-measure a locked BoQ → 400 BOQ_LOCKED', boqReLocked.status === 400 && boqReLocked.json.error?.code === 'BOQ_LOCKED', `${boqReLocked.status} ${boqReLocked.json.error?.code}`);

  // ── 9c. project-dimensioned procurement (M0): a PR tagged to a project + BoQ line persists the dimension ──
  const prTagged = await inj('POST', '/api/procurement/prs', admin, {
    project_code: 'PRJ-A', remarks: 'ขอวัสดุเข้าโครงการ',
    items: [{ item_id: 'CEMENT', request_qty: 50, uom: 'ถุง', boq_line_id: matLineId }],
  });
  ok('PR raised against project + BoQ line → 2xx', prTagged.status < 300 && !!prTagged.json.pr_no, JSON.stringify({ s: prTagged.status, pr: prTagged.json.pr_no }));
  const prRow = (await db.select().from(s.purchaseRequests).where(eq(s.purchaseRequests.prNo, prTagged.json.pr_no)))[0];
  const prjRow = (await db.select().from(s.projects).where(eq(s.projects.projectCode, 'PRJ-A')))[0];
  const prLineRow = prRow ? (await db.select().from(s.prItems).where(eq(s.prItems.prId, prRow.id)))[0] : null;
  ok('PR carries project_id (PRJ-A) + line carries boq_line_id',
    !!prRow && Number(prRow.projectId) === Number(prjRow?.id) && Number(prLineRow?.boqLineId) === Number(matLineId),
    JSON.stringify({ prj: prRow?.projectId, boq: prLineRow?.boqLineId }));
  const prBadProj = await inj('POST', '/api/procurement/prs', admin, { project_code: 'PRJ-NOPE', items: [{ item_id: 'X', request_qty: 1 }] });
  ok('PR with unknown project_code → 404 PROJECT_NOT_FOUND', prBadProj.status === 404 && prBadProj.json.error?.code === 'PROJECT_NOT_FOUND', `${prBadProj.status} ${prBadProj.json.error?.code}`);

  // ── 9d. Commitment ledger + budget enforcement (M1, PROJ-12): a project PO encumbers its BoQ line budget ──
  // matLineId (CEMENT) budget = 100×150 = 15000; no commitments yet (the M0 PR does not reserve).
  const po1 = await inj('POST', '/api/procurement/pos', admin, {
    project_code: 'PRJ-A', vendor_name: 'ACME Supply',
    items: [{ item_id: 'CEMENT', order_qty: 50, unit_price: 150, boq_line_id: matLineId }], // 7500
  });
  ok('Project PO within BoQ line budget → created (7500 of 15000)', po1.status < 300 && !!po1.json.po_no, JSON.stringify({ s: po1.status, po: po1.json.po_no }));
  const boqAfterPo1 = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const ml1 = (boqAfterPo1.json.lines ?? []).find((l: any) => l.id === matLineId);
  ok('BoQ line shows committed 7500 / remaining 7500 after the PO', near(ml1?.committed, 7500) && near(ml1?.remaining, 7500), JSON.stringify({ c: ml1?.committed, r: ml1?.remaining }));

  // a second PO that would push the line past its budget → BUDGET_EXCEEDED, and the PO is NOT created (atomic).
  const poCountBefore = (await db.select().from(s.purchaseOrders)).length;
  const po2 = await inj('POST', '/api/procurement/pos', admin, {
    project_code: 'PRJ-A', vendor_name: 'ACME Supply',
    items: [{ item_id: 'CEMENT', order_qty: 60, unit_price: 150, boq_line_id: matLineId }], // 9000 > 7500 remaining
  });
  ok('Over-budget project PO → 400 BUDGET_EXCEEDED', po2.status === 400 && po2.json.error?.code === 'BUDGET_EXCEEDED', `${po2.status} ${po2.json.error?.code}`);
  const poCountAfter = (await db.select().from(s.purchaseOrders)).length;
  ok('Rejected over-budget PO rolled back atomically (no PO row created)', poCountAfter === poCountBefore, JSON.stringify({ b: poCountBefore, a: poCountAfter }));

  // a PO that exactly fills the remaining budget → created; line now fully committed.
  const po3 = await inj('POST', '/api/procurement/pos', admin, {
    project_code: 'PRJ-A', vendor_name: 'ACME Supply',
    items: [{ item_id: 'CEMENT', order_qty: 50, unit_price: 150, boq_line_id: matLineId }], // 7500
  });
  ok('PO filling the remaining budget → created (line fully committed)', po3.status < 300 && !!po3.json.po_no, JSON.stringify({ s: po3.status }));
  const boqFull = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const mlFull = (boqFull.json.lines ?? []).find((l: any) => l.id === matLineId);
  ok('BoQ line committed 15000 / remaining 0', near(mlFull?.committed, 15000) && near(mlFull?.remaining, 0), JSON.stringify({ c: mlFull?.committed, r: mlFull?.remaining }));

  // cancelling PO1 releases its encumbrance → the line's remaining is restored.
  const cancel1 = await inj('PATCH', `/api/procurement/pos/${po1.json.po_no}/cancel`, admin, { reason: 'ทดสอบคืนงบ' });
  ok('Cancel PO1 → 2xx', cancel1.status < 300, JSON.stringify({ s: cancel1.status }));
  const boqRel = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const mlRel = (boqRel.json.lines ?? []).find((l: any) => l.id === matLineId);
  ok('Cancelled PO releases budget → committed 7500 / remaining 7500 restored', near(mlRel?.committed, 7500) && near(mlRel?.remaining, 7500), JSON.stringify({ c: mlRel?.committed, r: mlRel?.remaining }));

  const commits = await inj('GET', '/api/projects/PRJ-A/commitments', admin);
  ok('Commitments ledger: open 7500 (PO3) + released 7500 (PO1) → committed 7500',
    near(commits.json.summary?.open, 7500) && near(commits.json.summary?.released, 7500) && near(commits.json.summary?.committed, 7500),
    JSON.stringify(commits.json.summary));

  // ── 9e. Project Material Requisition (PMR) — M2 (PROJ-13): within-budget → PR; over-budget → LINE approval → Draft PO ──
  // matLineId (CEMENT) budget 15000, committed 7500 (PO3), remaining 7500.
  const pmrIn = await inj('POST', '/api/pmr', admin, { project_code: 'PRJ-A', items: [{ boq_line_id: matLineId, item_no: 'CEMENT', qty: 10, unit_cost: 100 }] }); // 1000 ≤ 7500
  ok('PMR within budget → routed, project-tagged PR raised', pmrIn.status < 300 && pmrIn.json.status === 'routed' && pmrIn.json.over_budget === false && /^PR-/.test(pmrIn.json.linked_doc_no ?? ''), JSON.stringify({ s: pmrIn.status, st: pmrIn.json.status, doc: pmrIn.json.linked_doc_no }));

  const pmrOver = await inj('POST', '/api/pmr', admin, { project_code: 'PRJ-A', items: [{ boq_line_id: matLineId, item_no: 'CEMENT', qty: 100, unit_cost: 100 }] }); // 10000 > 7500 remaining → over by 2500
  const pmrNo = pmrOver.json.pmr_no;
  ok('PMR over budget → pending, over_amount 2500, no PO yet', pmrOver.json.status === 'pending' && pmrOver.json.over_budget === true && near(pmrOver.json.over_amount, 2500) && !pmrOver.json.linked_doc_no, JSON.stringify({ st: pmrOver.json.status, over: pmrOver.json.over_amount }));

  const acPmr = await inj('GET', '/api/projects/action-center', admin);
  const pmrItem = (acPmr.json.items ?? []).find((i: any) => i.kind === 'pmr_over_budget' && i.ref === pmrNo);
  ok('Action center surfaces pmr_over_budget (high) for the pending PMR', !!pmrItem && pmrItem.severity === 'high', JSON.stringify({ found: !!pmrItem, sev: pmrItem?.severity }));

  const pmrSelf = await inj('POST', `/api/pmr/${pmrNo}/approve`, admin); // requester = admin
  ok('PMR self-approve by requester → 400 SOD_SELF_APPROVAL', pmrSelf.status === 400 && pmrSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${pmrSelf.status} ${pmrSelf.json.error?.code}`);

  const pmrAppr = await inj('POST', `/api/pmr/${pmrNo}/approve`, mgr); // independent authoriser
  ok('PMR approve by authoriser → approved + Draft PO auto-drafted', pmrAppr.status < 300 && pmrAppr.json.status === 'approved' && /^PO-/.test(pmrAppr.json.linked_doc_no ?? ''), JSON.stringify({ s: pmrAppr.status, st: pmrAppr.json.status, doc: pmrAppr.json.linked_doc_no }));
  const draftPo = (await db.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.poNo, pmrAppr.json.linked_doc_no)))[0];
  ok('Auto-drafted PO is Draft + project-tagged', draftPo?.status === 'Draft' && Number(draftPo?.projectId) === Number(prjRow?.id), JSON.stringify({ st: draftPo?.status, prj: draftPo?.projectId }));
  const boqOver = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const mlOver = (boqOver.json.lines ?? []).find((l: any) => l.id === matLineId);
  ok('Authorised overage booked: BoQ line committed 17500 / remaining −2500', near(mlOver?.committed, 17500) && near(mlOver?.remaining, -2500), JSON.stringify({ c: mlOver?.committed, r: mlOver?.remaining }));
  const acAfter = await inj('GET', '/api/projects/action-center', admin);
  ok('Action center clears pmr_over_budget after approval', !(acAfter.json.items ?? []).some((i: any) => i.kind === 'pmr_over_budget' && i.ref === pmrNo), 'cleared');

  // ── 9e-bis. Shop-for-a-project reads (pr_raise-safe): shoppable projects + approved-BoQ shelf with remaining ──
  // These thin reads back the /shop project mode: a requester browses ONLY what the approved BoQ allows.
  const shopProjs = await inj('GET', '/api/pmr/projects', admin);
  ok('Shoppable projects lists PRJ-A (has an approved/locked BoQ)', (shopProjs.json.projects ?? []).some((p: any) => p.code === 'PRJ-A'), JSON.stringify({ count: shopProjs.json.count }));
  const shelf = await inj('GET', '/api/pmr/project/PRJ-A/boq', admin);
  const shelfCement = (shelf.json.lines ?? []).find((l: any) => l.item_no === 'CEMENT');
  ok('Project shelf serves the approved BoQ material line CEMENT with remaining budget (−2500 after the overage)',
    !!shelfCement && ['approved', 'locked'].includes(shelf.json.boq_status) && near(shelfCement.remaining, -2500) && near(shelfCement.budget, 15000),
    JSON.stringify({ st: shelf.json.boq_status, r: shelfCement?.remaining, b: shelfCement?.budget }));

  // ── 9f. Stock reservation → issue-to-project (M3, INV-13): reserve on-hand stock, issue into project WIP ──
  await db.insert(s.invBalances).values({ tenantId: hq, itemId: 'STEEL', itemDescription: 'เหล็ก', locationId: 'WH-MAIN', onHandQty: '100', avgCost: '50', totalValue: '5000', costingMethod: 'moving_avg' });
  const avail0 = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('Reservation available = on_hand 100, held 0, available 100', near(avail0.json.on_hand, 100) && near(avail0.json.available, 100), JSON.stringify(avail0.json));
  const res1 = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 30, boq_line_id: matLineId });
  ok('Reserve 30 to project → held, available_after 70', res1.status < 300 && res1.json.status === 'held' && near(res1.json.available_after, 70), JSON.stringify({ s: res1.status, aa: res1.json.available_after }));
  const availHeld = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('Available reflects the hold: on_hand 100, held 30, available 70', near(availHeld.json.held, 30) && near(availHeld.json.available, 70), JSON.stringify(availHeld.json));
  const resOver = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 80 }); // > 70 available
  ok('Reserve beyond available → 400 INSUFFICIENT_STOCK', resOver.status === 400 && resOver.json.error?.code === 'INSUFFICIENT_STOCK', `${resOver.status} ${resOver.json.error?.code}`);

  const bal = (tb: any, c: string) => (tb.json.rows ?? []).find((x: any) => x.account_code === c);
  const tbBefore = await inj('GET', '/api/ledger/trial-balance', admin);
  const wipBefore = Number(bal(tbBefore, '1260')?.balance ?? 0), invBefore = Number(bal(tbBefore, '1200')?.balance ?? 0);
  const issue1 = await inj('POST', `/api/reservations/${res1.json.reservation_id}/issue`, admin);
  ok('Issue reservation to project → consumed + WIP posting (value 1500)', issue1.status < 300 && issue1.json.status === 'consumed' && near(issue1.json.value, 1500), JSON.stringify({ s: issue1.status, v: issue1.json.value }));
  const tbAfter = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('Issue-to-project GL: 1260 WIP +1500, 1200 Inventory −1500, TB balanced',
    tbAfter.json.totals?.balanced === true && near(Number(bal(tbAfter, '1260')?.balance ?? 0) - wipBefore, 1500) && near(invBefore - Number(bal(tbAfter, '1200')?.balance ?? 0), 1500),
    JSON.stringify({ bal: tbAfter.json.totals?.balanced, dWip: Number(bal(tbAfter, '1260')?.balance ?? 0) - wipBefore }));
  const availPost = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('After issue: on_hand 70, available 70', near(availPost.json.on_hand, 70) && near(availPost.json.available, 70), JSON.stringify(availPost.json));
  const res2 = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 20 });
  const relRes = await inj('POST', `/api/reservations/${res2.json.reservation_id}/release`, admin);
  ok('Release a held reservation → freed', relRes.status < 300 && relRes.json.status === 'released', JSON.stringify({ s: relRes.status }));
  const availRel = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('Released reservation restores availability → available 70', near(availRel.json.available, 70), JSON.stringify(availRel.json));

  // ── 9g. Project-linked advances & reimbursements (M4, PROJ-14): site cash managed on the project ──
  const adv = await inj('POST', '/api/finance/advances', admin, { payee: 'ช่างสมชาย', amount: 2000, purpose: 'ค่าเดินทางหน้างาน', project_code: 'PRJ-A' });
  ok('Issue project-tagged advance → 2xx + project_id set', adv.status < 300 && !!adv.json.advance_no && Number(adv.json.project_id) === Number(prjRow?.id), JSON.stringify({ s: adv.status, prj: adv.json.project_id }));
  const projLines1 = await db.select().from(s.journalLines).where(eq(s.journalLines.projectId, Number(prjRow?.id)));
  const advLine = projLines1.find((l: any) => l.accountCode === '1180');
  ok('Advance GL: Dr 1180 line carries the project dimension', !!advLine && near(advLine.debit, 2000), JSON.stringify({ acct: '1180', dr: advLine?.debit }));
  const stl = await inj('POST', `/api/finance/advances/${adv.json.advance_no}/settle`, admin, { settled_expense: 2000 });
  ok('Settle advance → settled', stl.status < 300 && stl.json.status === 'settled', JSON.stringify({ s: stl.status }));
  const projLines2 = await db.select().from(s.journalLines).where(eq(s.journalLines.projectId, Number(prjRow?.id)));
  const expLine = projLines2.find((l: any) => l.accountCode === '5100');
  ok('Settled spend GL: Dr 5100 expense line carries the project dimension', !!expLine && near(expLine.debit, 2000), JSON.stringify({ dr: expLine?.debit }));
  const sc = await inj('GET', '/api/projects/PRJ-A/site-cash', admin);
  ok('Project site-cash rollup: advance listed, advances total 2000', (sc.json.advances ?? []).some((a: any) => a.advance_no === adv.json.advance_no) && near(sc.json.totals?.advances, 2000), JSON.stringify({ n: sc.json.advances?.length, t: sc.json.totals?.advances }));
  const advBad = await inj('POST', '/api/finance/advances', admin, { payee: 'x', amount: 100, project_code: 'PRJ-NOPE' });
  ok('Advance with unknown project_code → 404 PROJECT_NOT_FOUND', advBad.status === 404 && advBad.json.error?.code === 'PROJECT_NOT_FOUND', `${advBad.status} ${advBad.json.error?.code}`);

  // ── 9h. FU1 — over-budget TOLERANCE + site cash CONSUMES BoQ budget ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-TOL', name: 'งานเผื่องบ', billing_type: 'TM', budget_tolerance_pct: 10 });
  const tboq = await inj('POST', '/api/projects/PRJ-TOL/boq', admin, { lines: [
    { category: 'material', item_no: 'SAND', description: 'ทราย', budget_qty: 100, rate: 100 }, // 10000
    { category: 'labor', description: 'ค่าแรง', budget_qty: 50, rate: 100 },                    // 5000
  ] });
  const tBoqId = tboq.json.boq?.id;
  const tLineId = (tboq.json.lines ?? []).find((l: any) => l.item_no === 'SAND')?.id;
  const laborLineId = (tboq.json.lines ?? []).find((l: any) => l.category === 'labor')?.id;
  await inj('POST', `/api/projects/boq/${tBoqId}/approve`, mgr); // author admin → approve by mgr (SoD)
  // tolerance 10% on a 10000 line → ceiling 11000. A PO for 10500 (5% over budget) is WITHIN tolerance.
  const poTol = await inj('POST', '/api/procurement/pos', admin, { project_code: 'PRJ-TOL', vendor_name: 'ACME', items: [{ item_id: 'SAND', order_qty: 105, unit_price: 100, boq_line_id: tLineId }] }); // 10500
  ok('PO within tolerance (10500 ≤ 11000 ceiling on a 10000 line) → created', poTol.status < 300 && !!poTol.json.po_no, JSON.stringify({ s: poTol.status }));
  const poTolOver = await inj('POST', '/api/procurement/pos', admin, { project_code: 'PRJ-TOL', vendor_name: 'ACME', items: [{ item_id: 'SAND', order_qty: 10, unit_price: 100, boq_line_id: tLineId }] }); // +1000 → 11500 > 11000
  ok('PO beyond the tolerance ceiling → 400 BUDGET_EXCEEDED', poTolOver.status === 400 && poTolOver.json.error?.code === 'BUDGET_EXCEEDED', `${poTolOver.status} ${poTolOver.json.error?.code}`);
  const pmrTol = await inj('POST', '/api/pmr', admin, { project_code: 'PRJ-TOL', items: [{ boq_line_id: tLineId, item_no: 'SAND', qty: 4, unit_cost: 100 }] }); // 400 ≤ headroom 500
  ok('PMR within tolerance → routed, not pending', pmrTol.json.status === 'routed' && pmrTol.json.over_budget === false, JSON.stringify({ st: pmrTol.json.status }));

  // site cash consumes BoQ budget: a project-tagged advance on the (fresh) labor line reduces its remaining on settle.
  const advSC = await inj('POST', '/api/finance/advances', admin, { payee: 'สมชาย', amount: 1000, project_code: 'PRJ-TOL', boq_line_id: laborLineId });
  await inj('POST', `/api/finance/advances/${advSC.json.advance_no}/settle`, admin, { settled_expense: 1000 });
  const scBoq = await inj('GET', '/api/projects/PRJ-TOL/boq', admin);
  const laborLine = (scBoq.json.lines ?? []).find((l: any) => l.id === laborLineId);
  ok('Site cash consumes BoQ budget: settled advance 1000 → labor line committed 1000 / remaining 4000', near(laborLine?.committed, 1000) && near(laborLine?.remaining, 4000), JSON.stringify({ c: laborLine?.committed, r: laborLine?.remaining }));

  // ── 9i. FU2 — a within-budget PMR prefers ON-HAND STOCK (reserve+issue to project) over raising a PR ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-STK', name: 'งานมีสต๊อก', billing_type: 'TM' });
  const stkBoq = await inj('POST', '/api/projects/PRJ-STK/boq', admin, { lines: [{ category: 'material', item_no: 'STEEL', description: 'เหล็ก', budget_qty: 100, rate: 50 }] }); // 5000
  const stkBoqId = stkBoq.json.boq?.id;
  const stkLineId = (stkBoq.json.lines ?? []).find((l: any) => l.item_no === 'STEEL')?.id;
  await inj('POST', `/api/projects/boq/${stkBoqId}/approve`, mgr);
  const stkAvailBefore = await inj('GET', '/api/reservations/available?item_id=STEEL', admin); // STEEL has on-hand stock (M3 block)
  const pmrStk = await inj('POST', '/api/pmr', admin, { project_code: 'PRJ-STK', items: [{ boq_line_id: stkLineId, item_no: 'STEEL', qty: 10, unit_cost: 50 }] });
  ok('Within-budget PMR with stock on hand → route issue (not a PR)', pmrStk.json.status === 'routed' && pmrStk.json.route === 'issue' && !/^PR-/.test(pmrStk.json.linked_doc_no ?? ''), JSON.stringify({ st: pmrStk.json.status, route: pmrStk.json.route, doc: pmrStk.json.linked_doc_no }));
  const stkAvailAfter = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('PMR stock fulfil consumed 10 STEEL from on-hand', near(Number(stkAvailBefore.json.on_hand) - Number(stkAvailAfter.json.on_hand), 10), JSON.stringify({ b: stkAvailBefore.json.on_hand, a: stkAvailAfter.json.on_hand }));
  const stkBoqAfter = await inj('GET', '/api/projects/PRJ-STK/boq', admin);
  const stkLine = (stkBoqAfter.json.lines ?? []).find((l: any) => l.id === stkLineId);
  ok('PMR stock fulfil booked the issued value against the BoQ line (committed 500)', near(stkLine?.committed, 500), JSON.stringify({ c: stkLine?.committed }));

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

  // ── 27. action center / exception inbox (PMO-1, PROJ-11) ──
  // Seed PRJ-ACT with one of every exception kind, then assert the worklist surfaces them with the right
  // severity, that the highest-severity items sort first, that resolving an exception clears it, and that the
  // proactive SSE bus carries a project_action event for the red snapshot + the unmitigated-high risk.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-ACT', name: 'งานศูนย์รวมงานค้าง', billing_type: 'TM', budget_amount: 1000 });
  await inj('POST', '/api/projects/PRJ-ACT/tasks', admin, { name: 'Build', planned_cost: 1000, pct_complete: 0 });
  await inj('POST', '/api/projects/PRJ-ACT/cost', admin, { entry_type: 'expense', description: 'overrun', amount: 5000, billable: true }); // AC 5000 vs BAC 1000 → CPI 0 (red) + over budget
  await inj('POST', '/api/projects/PRJ-ACT/milestones', admin, { name: 'Kickoff', due_date: '2020-01-01' }); // past due, not reached → slipping
  const actCo = await inj('POST', '/api/projects/PRJ-ACT/change-orders', admin, { description: 'scope+', contract_delta: 100 }); // pending → awaiting approval
  const actCoId = actCo.json.change_orders?.[0]?.id;
  await inj('POST', '/api/hcm/timesheets', admin, { emp_code: emp.json.emp_code, work_date: '2026-06-20', regular_hours: 8, project_code: 'PRJ-ACT', billable: true }); // Pending → awaiting approval
  await inj('POST', '/api/projects/PRJ-ACT/risks', admin, { title: 'Unmitigated showstopper', probability: 5, impact: 5 }); // 25 red, no mitigation → SSE emit
  await inj('POST', '/api/projects/PRJ-ACT/health', admin, {}); // today's snapshot → rag red → SSE emit + not stale

  const ac = await inj('GET', '/api/projects/action-center', admin);
  const acMine = (ac.json.items ?? []).filter((i: any) => i.project_code === 'PRJ-ACT');
  const acKinds = new Set<string>(acMine.map((i: any) => i.kind));
  ok('Action center surfaces every seeded exception kind for PRJ-ACT (7 kinds, stale_health absent — just snapshotted)',
    acKinds.has('over_budget') && acKinds.has('project_red') && acKinds.has('no_baseline') && acKinds.has('change_order_pending') && acKinds.has('milestone_slipping') && acKinds.has('timesheet_pending') && acKinds.has('risk_unmitigated_high') && !acKinds.has('stale_health'),
    JSON.stringify({ kinds: [...acKinds] }));
  ok('Action center severity: over_budget / project_red / risk_unmitigated_high are HIGH; first item overall is high',
    acMine.filter((i: any) => i.severity === 'high').map((i: any) => i.kind).sort().join(',') === 'over_budget,project_red,risk_unmitigated_high' && ac.json.items?.[0]?.severity === 'high',
    JSON.stringify({ high: acMine.filter((i: any) => i.severity === 'high').map((i: any) => i.kind) }));
  ok('Action center items deep-link to the offending project tab + summary counts reconcile',
    acMine.every((i: any) => typeof i.href === 'string' && i.href.startsWith('/projects/PRJ-ACT?tab=')) && ac.json.summary?.total === (ac.json.items ?? []).length && ac.json.summary?.high >= 3,
    JSON.stringify({ total: ac.json.summary?.total, high: ac.json.summary?.high }));

  // Proactive SSE: the red health snapshot and the unmitigated-high risk pushed project_action events.
  const live = await inj('GET', '/api/bi/live/recent?limit=100', admin);
  const evs = (live.json.events ?? []).filter((e: any) => e.type === 'project_action' && e.project_code === 'PRJ-ACT');
  ok('SSE bus carries a project_red + a risk_unmitigated_high project_action event for PRJ-ACT',
    evs.some((e: any) => e.kind === 'project_red') && evs.some((e: any) => e.kind === 'risk_unmitigated_high'),
    JSON.stringify({ kinds: evs.map((e: any) => e.kind) }));

  // Resolve an exception → it clears (PROJ-11 ToE). Independent approval of the change order removes the
  // change_order_pending item (and auto-captures a baseline, so no_baseline clears too).
  await inj('POST', `/api/projects/change-orders/${actCoId}/approve`, mgr, {});
  const ac2 = await inj('GET', '/api/projects/action-center', admin);
  const acMine2 = (ac2.json.items ?? []).filter((i: any) => i.project_code === 'PRJ-ACT');
  const acKinds2 = new Set<string>(acMine2.map((i: any) => i.kind));
  ok('Resolving the change order clears change_order_pending + no_baseline from the worklist',
    !acKinds2.has('change_order_pending') && !acKinds2.has('no_baseline'),
    JSON.stringify({ kinds: [...acKinds2] }));
  // stale_days override is honoured (a 0-tolerance window would flag today's snapshot — but >0 only).
  const acStale = await inj('GET', '/api/projects/action-center?stale_days=1', admin);
  ok('Action center accepts ?stale_days override (echoed in payload)', acStale.json.stale_days === 1, JSON.stringify({ s: acStale.json.stale_days }));

  // ── 28. pipeline-weighted forward resource & cash forecast (PMO-2) ──
  // PRJ-FC (Fixed, contract 100000) with a pending 25%-billing milestone due 2026-08-15 → 25000 committed in Aug.
  // An OPEN opportunity 200000 @ 50% expected-close 2026-09-10 → 100000 weighted pipeline in Sep.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-FC', name: 'งานพยากรณ์', billing_type: 'Fixed', contract_amount: 100000 });
  await inj('POST', '/api/projects/PRJ-FC/milestones', admin, { name: 'Phase gate', due_date: '2026-08-15', billing_percent: 25 });
  await inj('POST', '/api/crm/pipeline/opportunities', admin, { name: 'ดีลพยากรณ์', amount: 200000, probability: 50, expected_close_date: '2026-09-10' });
  const fc = await inj('GET', '/api/projects/forecast?from=2026-07&months=6', admin);
  const fcAt = (mm: string) => (fc.json.billing?.monthly ?? []).find((m: any) => m.month === mm);
  ok('Forecast: committed milestone billing 25000 in 2026-08 (25% of 100000 contract)',
    near(fcAt('2026-08')?.committed_billing, 25000) && near(fcAt('2026-08')?.total_expected, 25000),
    JSON.stringify({ aug: fcAt('2026-08') }));
  ok('Forecast: probability-weighted pipeline 100000 in 2026-09 (200000 × 50%) + headline weighted_forecast ≥ that',
    near(fcAt('2026-09')?.weighted_pipeline, 100000) && fc.json.pipeline?.weighted_forecast >= 100000 && fc.json.pipeline?.open_count >= 1,
    JSON.stringify({ sep: fcAt('2026-09'), wf: fc.json.pipeline?.weighted_forecast }));
  ok('Forecast: billing totals reconcile (committed 25000 + weighted 100000 = expected 125000) + horizon length',
    near(fc.json.billing?.committed_total, 25000) && near(fc.json.billing?.weighted_pipeline_total, 100000) && near(fc.json.billing?.expected_total, 125000) && fc.json.horizon?.length === 6,
    JSON.stringify({ c: fc.json.billing?.committed_total, w: fc.json.billing?.weighted_pipeline_total, e: fc.json.billing?.expected_total }));
  ok('Forecast: resourcing band carries committed_demand_pct per month + over-allocated count',
    (fc.json.resourcing?.monthly ?? []).length === 6 && fc.json.resourcing?.monthly?.every((m: any) => typeof m.committed_demand_pct === 'number') && typeof fc.json.resourcing?.over_allocated_count === 'number',
    JSON.stringify({ n: (fc.json.resourcing?.monthly ?? []).length, over: fc.json.resourcing?.over_allocated_count }));
  // PMO-5: the weighted pipeline projects FTE demand at the default value→FTE rate (200000/FTE-month).
  const rcAt = (mm: string) => (fc.json.resourcing?.monthly ?? []).find((m: any) => m.month === mm);
  ok('Forecast (PMO-5): default rev_per_fte_month 200000 → Sep pipeline_demand_fte 0.5 (100000 weighted / 200000)',
    fc.json.rev_per_fte_month === 200000 && near(rcAt('2026-09')?.pipeline_demand_fte, 0.5) && near(rcAt('2026-09')?.total_demand_fte, (rcAt('2026-09')?.committed_demand_fte ?? 0) + 0.5),
    JSON.stringify({ rate: fc.json.rev_per_fte_month, sep: rcAt('2026-09') }));
  const fcRate = await inj('GET', '/api/projects/forecast?from=2026-07&months=6&rev_per_fte_month=100000', admin);
  const sepRate = (fcRate.json.resourcing?.monthly ?? []).find((m: any) => m.month === '2026-09');
  ok('Forecast (PMO-5): configurable rate honoured → at 100000/FTE the Sep pipeline demand doubles to 1.0 FTE',
    fcRate.json.rev_per_fte_month === 100000 && near(sepRate?.pipeline_demand_fte, 1.0) && typeof fcRate.json.resourcing?.peak_total_demand_fte === 'number',
    JSON.stringify({ rate: fcRate.json.rev_per_fte_month, sepFte: sepRate?.pipeline_demand_fte, peak: fcRate.json.resourcing?.peak_total_demand_fte }));

  // ── 29. period governance / status pack (PMO-3) ──
  // Single-project pack on PRJ-EVM (green, CPI 1.11; 2+ health snapshots captured in §26).
  const gp = await inj('GET', '/api/projects/PRJ-EVM/governance-pack', admin);
  const pk = gp.json.project;
  ok('Governance pack (project): EVM + health trend + baseline/risks/milestones/change-order sections assembled',
    gp.json.scope === 'project' && pk?.project_code === 'PRJ-EVM' && pk?.rag === 'green' && near(pk?.evm?.cpi, 1.1111) && Array.isArray(pk?.health_trend) && pk.health_trend.length >= 2 && !!pk?.risks?.summary && !!pk?.milestones && !!pk?.change_orders && 'baseline' in pk,
    JSON.stringify({ scope: gp.json.scope, rag: pk?.rag, cpi: pk?.evm?.cpi, trend: pk?.health_trend?.length }));
  // Portfolio pack: a RAG-ranked status row per project + a roll-up; PRJ-ACT (red, unmitigated-high, overdue ms) is present.
  const gpp = await inj('GET', '/api/projects/governance-pack', admin);
  ok('Governance pack (portfolio): RAG-ranked rows + roll-up (≥1 red, unmitigated-high & overdue-milestone surfaced); red sorts first',
    gpp.json.scope === 'portfolio' && gpp.json.count > 0 && gpp.json.summary?.red >= 1 && gpp.json.summary?.unmitigated_high >= 1 && gpp.json.summary?.overdue_milestones >= 1 && gpp.json.projects?.[0]?.rag === 'red',
    JSON.stringify({ count: gpp.json.count, red: gpp.json.summary?.red, uh: gpp.json.summary?.unmitigated_high, first: gpp.json.projects?.[0]?.rag }));
  // Schedulable BI action job: project_governance_pack.
  const gpSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Governance pack', report_type: 'project_governance_pack', frequency: 'monthly' });
  const gpRun = await inj('POST', `/api/bi/subscriptions/${gpSub.json.id}/run`, admin, {});
  ok('BI project_governance_pack runs success (portfolio status summary)', gpRun.json.status === 'success' && /Governance pack/.test(gpRun.json.summary ?? ''), JSON.stringify({ s: gpRun.json.status, sum: (gpRun.json.summary ?? '').slice(0, 48) }));

  // ── 30. program (cross-project) critical path (PMO-4) ──
  // Program PG-1 of 4 projects, each one task giving a duration: A=10d, B=5d, C=3d, D=2d.
  // Dependencies A→B→C (chain) and A→D. Program critical path = A→B→C (18d); D has slack (off the path).
  for (const [pc, end] of [['PRG-A', '2026-01-10'], ['PRG-B', '2026-01-05'], ['PRG-C', '2026-01-03'], ['PRG-D', '2026-01-02']] as const) {
    await inj('POST', '/api/projects', admin, { project_code: pc, name: `โปรแกรม ${pc}`, billing_type: 'TM' });
    await inj('POST', `/api/projects/${pc}/tasks`, admin, { name: 'work', planned_start: '2026-01-01', planned_end: end });
    await inj('PATCH', `/api/projects/${pc}/program`, admin, { program_code: 'PG-1' });
  }
  await inj('PATCH', '/api/projects/PRG-B/program', admin, { depends_on_projects: ['PRG-A'] });
  await inj('PATCH', '/api/projects/PRG-C/program', admin, { depends_on_projects: ['PRG-B'] });
  const setD = await inj('PATCH', '/api/projects/PRG-D/program', admin, { depends_on_projects: ['PRG-A'] });
  ok('Set program + cross-project dependency (reflected on the project)', setD.json.program_code === 'PG-1' && Array.isArray(setD.json.depends_on_projects) && setD.json.depends_on_projects.includes('PRG-A'), JSON.stringify({ prog: setD.json.program_code, deps: setD.json.depends_on_projects }));
  const pcp = await inj('GET', '/api/projects/program-critical-path?program=PG-1', admin);
  const at = (code: string) => (pcp.json.projects ?? []).find((p: any) => p.project_code === code);
  ok('Program critical path: A→B→C is the path, duration 18d; D is off-path with slack',
    pcp.json.program_duration_days === 18 && JSON.stringify(pcp.json.critical_path) === JSON.stringify(['PRG-A', 'PRG-B', 'PRG-C']) && at('PRG-A')?.es === 0 && at('PRG-B')?.es === 10 && at('PRG-C')?.es === 15 && at('PRG-D')?.on_critical_path === false && at('PRG-D')?.slack === 6,
    JSON.stringify({ dur: pcp.json.program_duration_days, cp: pcp.json.critical_path, dSlack: at('PRG-D')?.slack }));
  const progs = await inj('GET', '/api/projects/programs', admin);
  ok('Programs list: PG-1 present with 4 members and program duration 18',
    (progs.json.programs ?? []).some((p: any) => p.program_code === 'PG-1' && p.member_count === 4 && p.program_duration_days === 18),
    JSON.stringify({ programs: (progs.json.programs ?? []).map((p: any) => [p.program_code, p.member_count, p.program_duration_days]) }));
  const selfDep = await inj('PATCH', '/api/projects/PRG-A/program', admin, { depends_on_projects: ['PRG-A'] });
  ok('Self-dependency rejected → 400 BAD_DEPENDENCY', selfDep.status === 400 && selfDep.json.error?.code === 'BAD_DEPENDENCY', `${selfDep.status} ${selfDep.json.error?.code}`);
  const progBadDep = await inj('PATCH', '/api/projects/PRG-A/program', admin, { depends_on_projects: ['NOPE'] });
  ok('Unknown dependency project rejected → 400 DEP_PROJECT_NOT_FOUND', progBadDep.status === 400 && progBadDep.json.error?.code === 'DEP_PROJECT_NOT_FOUND', `${progBadDep.status} ${progBadDep.json.error?.code}`);

  // ── PROJ-03: period-end WIP(1260)/clearing(2390) close review + maker-checker sign-off ──
  // Billable costs logged above have posted Dr 1260 WIP / Cr 2390, so there's unbilled WIP to review.
  const ccPrep = await inj('POST', '/api/projects/close-review?period=2026-06', admin);
  ok('PROJ-03: close review prepared → captures WIP(1260) total + clearing(2390) + open projects',
    (ccPrep.status === 200 || ccPrep.status === 201) && ccPrep.json.status === 'Prepared' && ccPrep.json.wip_total > 0 && ccPrep.json.open_projects > 0 && ccPrep.json.prepared_by === 'admin',
    JSON.stringify({ st: ccPrep.json.status, wip: ccPrep.json.wip_total, clr: ccPrep.json.clearing_balance, op: ccPrep.json.open_projects }));
  const ccSelf = await inj('POST', '/api/projects/close-review/2026-06/approve', admin);
  ok('PROJ-03: preparer self-approval blocked → 403 SOD_VIOLATION (maker-checker)', ccSelf.status === 403 && ccSelf.json.error?.code === 'SOD_VIOLATION', `${ccSelf.status} ${ccSelf.json.error?.code}`);
  const ccAppr = await inj('POST', '/api/projects/close-review/2026-06/approve', mgr);
  ok('PROJ-03: independent approver signs off → Approved + approved_by recorded',
    (ccAppr.status === 200 || ccAppr.status === 201) && ccAppr.json.status === 'Approved' && ccAppr.json.approved_by === 'mgr', JSON.stringify({ st: ccAppr.json.status, by: ccAppr.json.approved_by }));
  const ccList = await inj('GET', '/api/projects/close-reviews', admin);
  ok('PROJ-03: the close review is recorded in the register (Approved)', (ccList.json.reviews ?? []).some((r: any) => r.period === '2026-06' && r.status === 'Approved'), `n=${ccList.json.count}`);

  // ── P0 (docs/35) — shared retention sub-ledger + retention GL accounts (Construction/RE vertical, Phase 0) ──
  // The primitive Tracks A (customer progress billing / งวดงาน) and B (subcontractor valuations) build on:
  // withhold retention on certification, release in tranches; balances only (A/B post the matching GL).
  const coa = await inj('GET', '/api/ledger/accounts', admin);
  const acct = (c: string) => (coa.json.accounts ?? []).find((a: any) => a.code === c);
  ok('docs/35 P0: retention GL accounts seeded — 1170 Retention Receivable (Asset), 2440 Retention Payable (Liability)',
    acct('1170')?.type === 'Asset' && acct('2440')?.type === 'Liability',
    JSON.stringify({ r1170: acct('1170')?.type, r2440: acct('2440')?.type }));

  const rcCust = await inj('POST', '/api/retention/withhold', admin, { party_type: 'customer', project_code: 'PRJ-A', source_doc_type: 'CLAIM', source_doc_no: 'CLAIM-1', amount: 500 });
  ok('Retention withhold (customer/งวดงาน) → gl 1170, withheld 500', rcCust.status < 300 && rcCust.json.gl_account === '1170' && near(rcCust.json.withheld, 500), JSON.stringify({ s: rcCust.status, gl: rcCust.json.gl_account }));
  const custRetId = rcCust.json.id;

  const rcSub = await inj('POST', '/api/retention/withhold', admin, {
    party_type: 'subcontractor', project_code: 'PRJ-A', source_doc_type: 'SUBVAL', source_doc_no: 'SUBVAL-1', amount: 1000,
    schedule: [{ due_basis: 'date', due_date: '2020-01-01', pct: 50 }, { due_basis: 'dlp_end', pct: 50 }],
  });
  ok('Retention withhold (subcontractor) → gl 2440, withheld 1000, 2-tranche schedule', rcSub.status < 300 && rcSub.json.gl_account === '2440' && near(rcSub.json.withheld, 1000), JSON.stringify({ s: rcSub.status, gl: rcSub.json.gl_account }));
  const subRetId = rcSub.json.id;

  const rbal1 = await inj('GET', '/api/retention/project/PRJ-A', admin);
  ok('Retention balance: receivable outstanding 500, payable outstanding 1000',
    near(rbal1.json.receivable?.outstanding, 500) && near(rbal1.json.payable?.outstanding, 1000),
    JSON.stringify({ recv: rbal1.json.receivable?.outstanding, pay: rbal1.json.payable?.outstanding }));

  const rel1 = await inj('POST', `/api/retention/${custRetId}/release`, admin, { amount: 200 });
  ok('Retention partial release 200 (customer) → partially_released, released 200, outstanding 300',
    rel1.status < 300 && rel1.json.status === 'partially_released' && near(rel1.json.released_amount, 200) && near(rel1.json.outstanding, 300),
    JSON.stringify({ st: rel1.json.status, rel: rel1.json.released_amount, out: rel1.json.outstanding }));

  const relOver = await inj('POST', `/api/retention/${custRetId}/release`, admin, { amount: 5000 });
  ok('Over-release beyond outstanding → 400 RETENTION_OVER_RELEASE', relOver.status === 400 && relOver.json.error?.code === 'RETENTION_OVER_RELEASE', `${relOver.status} ${relOver.json.error?.code}`);

  const rbal2 = await inj('GET', '/api/retention/project/PRJ-A', admin);
  ok('Retention balance after partial release: receivable outstanding 300', near(rbal2.json.receivable?.outstanding, 300), JSON.stringify({ recv: rbal2.json.receivable?.outstanding }));

  const due = await inj('GET', '/api/retention/due', admin); // as_of defaults to today (2020 tranche is overdue; dlp_end is not date-based)
  const dueSub = (due.json.due ?? []).find((d: any) => d.source_doc_no === 'SUBVAL-1');
  ok('Retention due worklist: the overdue date-tranche (500) is due; the dlp_end tranche is excluded',
    dueSub && near(dueSub.amount, 500) && (due.json.due ?? []).length === 1,
    JSON.stringify({ count: due.json.count, first: dueSub?.amount }));

  const relTranche = await inj('POST', `/api/retention/${subRetId}/release`, admin, { tranche_id: dueSub?.tranche_id });
  ok('Release a scheduled tranche by id → subcontract retention released 500, outstanding 500',
    relTranche.status < 300 && near(relTranche.json.released_amount, 500) && near(relTranche.json.outstanding, 500),
    JSON.stringify({ rel: relTranche.json.released_amount, out: relTranche.json.outstanding }));
  const dueAfter = await inj('GET', '/api/retention/due', admin);
  ok('After releasing the tranche it drops off the due worklist (0 due)', (dueAfter.json.due ?? []).length === 0, `count=${dueAfter.json.count}`);

  // SCF classification: a posted JE touching 1170/2440 must bucket into OPERATING working capital (not unclassified).
  const rje = await inj('POST', '/api/ledger/journal', admin, { date: '2026-06-15', memo: 'retention SCF classify test', lines: [{ account_code: '1170', debit: 500 }, { account_code: '2440', credit: 500 }] });
  await inj('POST', `/api/ledger/journal/${rje.json.entry_no}/approve`, mgr); // maker-checker: mgr ≠ admin
  const scf = await inj('GET', '/api/ledger/cash-flow?from=2026-06-01&to=2026-06-30', admin);
  const wc = scf.json.operating?.working_capital ?? [];
  ok('SCF: retention receivable (1170) & payable (2440) classify as OPERATING working capital, not unclassified',
    !(scf.json.unclassified_accounts ?? []).includes('1170') && !(scf.json.unclassified_accounts ?? []).includes('2440') &&
    wc.some((l: any) => l.account_code === '1170') && wc.some((l: any) => l.account_code === '2440'),
    JSON.stringify({ uncl: scf.json.unclassified_accounts, codes: wc.map((l: any) => l.account_code) }));

  console.log('\n── Phase 18 — Projects/PPM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} projects checks failed` : `\n✅ All ${checks.length} projects checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
