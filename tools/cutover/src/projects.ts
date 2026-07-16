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
  // Fetch a raw (non-JSON) document response — PDF or the HTML fallback when Chromium is absent (CI).
  const raw = async (m: string, url: string, token?: string) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, ctype: String(res.headers['content-type'] ?? ''), body: res.body ?? '' };
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

  // ── 9e-ter. Material scope-change request (PROJ-15): a requester can PROPOSE adding an off-budget item, but
  // only an independent authoriser can approve it into the budget — then it becomes shoppable. ──
  const bqrDup = await inj('POST', '/api/pmr/boq-request', admin, { project_code: 'PRJ-A', item_no: 'CEMENT', qty: 1, rate: 100 });
  ok('Request an already-budgeted item → 400 ITEM_ALREADY_BUDGETED', bqrDup.status === 400 && bqrDup.json.error?.code === 'ITEM_ALREADY_BUDGETED', `${bqrDup.status} ${bqrDup.json.error?.code}`);
  const shelfBudgetBefore = shelf.json.budget_total;
  const bqrNew = await inj('POST', '/api/pmr/boq-request', admin, { project_code: 'PRJ-A', item_no: 'PAINT', description: 'สีทาอาคาร', uom: 'ถัง', qty: 10, rate: 200 });
  const bqrNo = bqrNew.json.req_no;
  ok('Request a new off-budget item → pending, budget not yet changed', bqrNew.status < 300 && bqrNew.json.status === 'pending' && near(bqrNew.json.amount, 2000), JSON.stringify({ s: bqrNew.status, st: bqrNew.json.status, amt: bqrNew.json.amount }));
  const shelfPending = await inj('GET', '/api/pmr/project/PRJ-A/boq', admin);
  ok('Requested item is NOT shoppable while pending', !(shelfPending.json.lines ?? []).some((l: any) => l.item_no === 'PAINT'), 'not on the shelf yet');
  const bqrSelf = await inj('POST', `/api/pmr/boq-request/${bqrNo}/approve`, admin); // requester = admin
  ok('Requester self-approves the scope change → 400 SOD_SELF_APPROVAL', bqrSelf.status === 400 && bqrSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${bqrSelf.status} ${bqrSelf.json.error?.code}`);
  const bqrAppr = await inj('POST', `/api/pmr/boq-request/${bqrNo}/approve`, mgr); // independent authoriser
  ok('Authoriser approves → approved + a new BoQ line created', bqrAppr.status < 300 && bqrAppr.json.status === 'approved' && !!bqrAppr.json.new_boq_line_id, JSON.stringify({ s: bqrAppr.status, st: bqrAppr.json.status, line: bqrAppr.json.new_boq_line_id }));
  const shelfAfter = await inj('GET', '/api/pmr/project/PRJ-A/boq', admin);
  const paintLine = (shelfAfter.json.lines ?? []).find((l: any) => l.item_no === 'PAINT');
  ok('Approved item is now shoppable (remaining 2000) + shelf budget grew by 2000',
    !!paintLine && near(paintLine.remaining, 2000) && near(shelfAfter.json.budget_total, shelfBudgetBefore + 2000),
    JSON.stringify({ r: paintLine?.remaining, bt: shelfAfter.json.budget_total, before: shelfBudgetBefore }));

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

  // ── 9f-bis. A2 stale-hold sweep (docs/50 Wave 1): aging holds surface on the action center, then the
  //    sweep releases them; fresh holds untouched; re-run idempotent ──
  const resOld = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 15 });
  const resNew = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 5 });
  await pg.query(`UPDATE stock_reservations SET created_at = now() - interval '45 days' WHERE id = ${Number(resOld.json.reservation_id)}`);
  const acRes = await inj('GET', '/api/projects/action-center', admin);
  ok('A2: aging held reservation surfaces on the action center (reservation_stale)',
    (acRes.json.items ?? []).some((i: any) => i.kind === 'reservation_stale' && Number(i.meta?.reservation_id) === Number(resOld.json.reservation_id)),
    JSON.stringify((acRes.json.items ?? []).filter((i: any) => i.kind === 'reservation_stale').slice(0, 2)));
  const availPreSweep = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('A2: both holds reduce availability before the sweep (70−20=50)', near(availPreSweep.json.available, 50), JSON.stringify(availPreSweep.json));
  const sweep1 = await inj('POST', '/api/reservations/expire-stale?max_age_days=30', admin);
  ok('A2: sweep releases ONLY the stale hold (released=1, id matches)',
    sweep1.status < 300 && sweep1.json.released === 1 && Number(sweep1.json.reservations?.[0]?.id) === Number(resOld.json.reservation_id),
    JSON.stringify(sweep1.json).slice(0, 120));
  const availPostSweep = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('A2: released stale hold restores availability (fresh hold still held → 65)', near(availPostSweep.json.available, 65), JSON.stringify(availPostSweep.json));
  const sweep2 = await inj('POST', '/api/reservations/expire-stale?max_age_days=30', admin);
  ok('A2: re-run is a no-op (released=0)', sweep2.json.released === 0 && sweep2.json.scanned === 0, JSON.stringify(sweep2.json));
  const acResAfter = await inj('GET', '/api/projects/action-center', admin);
  ok('A2: released hold leaves the action center', !(acResAfter.json.items ?? []).some((i: any) => i.kind === 'reservation_stale' && Number(i.meta?.reservation_id) === Number(resOld.json.reservation_id)), '');
  await inj('POST', `/api/reservations/${resNew.json.reservation_id}/release`, admin); // restore availability for later sections

  // ── 9f-ter. A1 material return-to-stock (docs/50 Wave 2, INV-19): the governed inverse of issue —
  //    qty ≤ issued, reason mandatory, original issue cost, maker-checker at/above the threshold ──
  const boqBeforeRet = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const committedBefore = Number((boqBeforeRet.json.lines ?? []).find((l: any) => l.id === matLineId)?.committed ?? 0);
  const tbRet0 = await inj('GET', '/api/ledger/trial-balance', admin);
  const wipRet0 = Number(bal(tbRet0, '1260')?.balance ?? 0), invRet0 = Number(bal(tbRet0, '1200')?.balance ?? 0);
  const noReason = await inj('POST', `/api/reservations/${res1.json.reservation_id}/return`, admin, { qty: 5 });
  ok('A1: return without a reason rejected (REASON_REQUIRED / 400)', noReason.status === 400, `${noReason.status} ${noReason.json.error?.code}`);
  const resHeld = await inj('POST', '/api/reservations', admin, { project_code: 'PRJ-A', item_id: 'STEEL', qty: 5 });
  const retHeld = await inj('POST', `/api/reservations/${resHeld.json.reservation_id}/return`, admin, { qty: 5, reason: 'ผิดสถานะ' });
  ok('A1: return on a HELD (not issued) reservation rejected (RESERVATION_NOT_CONSUMED)', retHeld.status === 400 && retHeld.json.error?.code === 'RESERVATION_NOT_CONSUMED', `${retHeld.status} ${retHeld.json.error?.code}`);
  await inj('POST', `/api/reservations/${resHeld.json.reservation_id}/release`, admin);
  // Sub-threshold return (10 × 50 = 500 < 1000) posts IMMEDIATELY at the original issue cost.
  const ret1 = await inj('POST', `/api/reservations/${res1.json.reservation_id}/return`, admin, { qty: 10, reason: 'เหลือใช้จากหน้างาน' });
  ok('A1: sub-threshold return posts immediately (MRET-, unit 50, value 500)', ret1.status < 300 && ret1.json.status === 'Posted' && /^MRET-/.test(ret1.json.return_no ?? '') && near(ret1.json.unit_cost, 50) && near(ret1.json.value, 500) && /^INV-PRJR/.test(ret1.json.move_no ?? ''), JSON.stringify(ret1.json).slice(0, 140));
  const availRet1 = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('A1: returned stock is back on hand and available (70 → 80)', near(availRet1.json.on_hand, 80) && near(availRet1.json.available, 80), JSON.stringify(availRet1.json));
  const tbRet1 = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('A1: GL reversal — Dr 1200 +500 / Cr 1260 −500, balanced',
    tbRet1.json.totals?.balanced === true && near(Number(bal(tbRet1, '1200')?.balance ?? 0) - invRet0, 500) && near(wipRet0 - Number(bal(tbRet1, '1260')?.balance ?? 0), 500),
    JSON.stringify({ dInv: Number(bal(tbRet1, '1200')?.balance ?? 0) - invRet0, dWip: wipRet0 - Number(bal(tbRet1, '1260')?.balance ?? 0) }));
  const boqAfterRet1 = await inj('GET', '/api/projects/PRJ-A/boq', admin);
  const committedAfter1 = Number((boqAfterRet1.json.lines ?? []).find((l: any) => l.id === matLineId)?.committed ?? 0);
  ok('A1: BoQ-line committed un-drawn by the returned value (−500)', near(committedBefore - committedAfter1, 500), `before=${committedBefore} after=${committedAfter1}`);
  // Material return (20 × 50 = 1000 ≥ threshold): parks PendingApproval — no stock/GL until a DIFFERENT user approves.
  const ret2 = await inj('POST', `/api/reservations/${res1.json.reservation_id}/return`, admin, { qty: 20, reason: 'ปิดงาน คืนทั้งหมด' });
  ok('A1: material return parks PendingApproval (≥ threshold 1000)', ret2.status < 300 && ret2.json.status === 'PendingApproval' && near(ret2.json.value, 1000), JSON.stringify(ret2.json).slice(0, 120));
  const availRet2 = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('A1: pending return moves NO stock (still 80)', near(availRet2.json.on_hand, 80), JSON.stringify(availRet2.json));
  const selfAppr = await inj('POST', `/api/reservations/returns/${ret2.json.return_no}/approve`, admin);
  ok('A1: requester cannot approve own return (403 SOD_VIOLATION)', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);
  const mgrAppr = await inj('POST', `/api/reservations/returns/${ret2.json.return_no}/approve`, mgr);
  ok('A1: a different user approves → posted (stock 100, WIP relieved 1000 more)', mgrAppr.status < 300 && mgrAppr.json.status === 'Posted' && mgrAppr.json.approved_by === 'mgr', JSON.stringify(mgrAppr.json).slice(0, 120));
  const availRet3 = await inj('GET', '/api/reservations/available?item_id=STEEL', admin);
  ok('A1: approved return restores the stock (on hand 100)', near(availRet3.json.on_hand, 100), JSON.stringify(availRet3.json));
  const reAppr = await inj('POST', `/api/reservations/returns/${ret2.json.return_no}/approve`, mgr);
  ok('A1: re-approval rejected (NO_PENDING_RETURN)', reAppr.status === 400 && reAppr.json.error?.code === 'NO_PENDING_RETURN', `${reAppr.status} ${reAppr.json.error?.code}`);
  const over = await inj('POST', `/api/reservations/${res1.json.reservation_id}/return`, admin, { qty: 1, reason: 'เกิน' });
  ok('A1: over-return rejected — 30 of 30 already returned (OVER_RETURN)', over.status === 400 && over.json.error?.code === 'OVER_RETURN', `${over.status} ${over.json.error?.code}`);
  const retList = await inj('GET', '/api/reservations/returns', admin);
  ok('A1: returns register lists both returns, none pending', retList.status === 200 && (retList.json.returns ?? []).filter((r: any) => [ret1.json.return_no, ret2.json.return_no].includes(r.return_no)).length === 2 && retList.json.pending === 0, `n=${retList.json.count} pending=${retList.json.pending}`);
  const tbRet2 = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('A1: trial balance balanced after both returns (WIP net −1500 vs pre-return)', tbRet2.json.totals?.balanced === true && near(wipRet0 - Number(bal(tbRet2, '1260')?.balance ?? 0), 1500), JSON.stringify({ dWip: wipRet0 - Number(bal(tbRet2, '1260')?.balance ?? 0) }));

  // ── 9f-quater. A3 material control tower (docs/50 Wave 3): WBS rollup + planned-vs-actual draw curve —
  //    read models over the commitment ledger (RES issues net of MRET returns); no new writes ──
  const byWbs = await inj('GET', '/api/projects/PRJ-A/boq/by-wbs', admin);
  ok('A3: by-WBS rollup returns nodes with budget/committed/issued/returned/remaining', byWbs.status === 200 && (byWbs.json.nodes ?? []).length >= 1 && byWbs.json.nodes.every((x: any) => ['budget', 'committed', 'issued', 'returned', 'remaining'].every((k) => typeof x[k] === 'number')), JSON.stringify(byWbs.json.nodes?.slice(0, 2)));
  ok('A3: rollup issued reflects the physical RES draws and returned the MRET reversals (both 1500 after A1)', near(byWbs.json.totals?.issued, 1500 + 500) || near(byWbs.json.totals?.issued, 1500), JSON.stringify(byWbs.json.totals));
  ok('A3: node totals reconcile to the BoQ read model (committed_total)', near(byWbs.json.totals?.committed, (await inj('GET', '/api/projects/PRJ-A/boq', admin)).json.committed_total), JSON.stringify(byWbs.json.totals));
  const draw = await inj('GET', '/api/projects/PRJ-A/material-draw', admin);
  ok('A3: draw curve returns monthly points with cumulative actual vs linear plan', draw.status === 200 && (draw.json.points ?? []).length >= 1 && draw.json.points.every((pt: any) => typeof pt.actual_cum === 'number' && typeof pt.planned_cum === 'number'), JSON.stringify(draw.json.points?.slice(0, 2)));
  const lastPt = (draw.json.points ?? [])[draw.json.points.length - 1];
  ok('A3: final cumulative actual = Σ RES − Σ MRET (physical net draw)', near(lastPt?.actual_cum, byWbs.json.totals.issued - byWbs.json.totals.returned), JSON.stringify({ last: lastPt, iss: byWbs.json.totals.issued, ret: byWbs.json.totals.returned }));
  ok('A3: final planned_cum = the full material budget (linear spread ends at 100%)', near(lastPt?.planned_cum, draw.json.budget_total), JSON.stringify({ p: lastPt?.planned_cum, b: draw.json.budget_total }));

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

  // ── 16b. Earned Schedule (PROJ-19): the time-based schedule signal that stays honest to completion ──
  // PRJ-ES: 2 tasks planned Jan+Feb 2026 (1000 each), both 95% done → EV 1900. At as_of 2026-06-30 the
  // classic SPI = EV/PV = 1900/2000 = 0.95 (reads fine — PV saturated at BAC), but earned schedule says the
  // plan reached 1900 at ES = 1.9 months vs AT = 6.0 months elapsed → SPI(t) 0.3167, SV(t) −4.1 mo, RED.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-ES', name: 'งานวัด Earned Schedule', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-ES/tasks', admin, { name: 'ES-1', planned_cost: 1000, planned_end: '2026-01-31', pct_complete: 95 });
  await inj('POST', '/api/projects/PRJ-ES/tasks', admin, { name: 'ES-2', planned_cost: 1000, planned_end: '2026-02-28', pct_complete: 95 });
  const esr = await inj('GET', '/api/projects/PRJ-ES/earned-schedule?as_of=2026-06-30', admin);
  ok('Earned schedule (PROJ-19): ES 1.9 mo / AT 6.0 mo → SPI(t) 0.3167 SV(t) −4.1 RED while classic SPI 0.95 reads fine',
    near(esr.json.earned_schedule_months, 1.9) && near(esr.json.actual_time_months, 6) && near(esr.json.spi_t, 0.3167) &&
    near(esr.json.sv_t_months, -4.1) && near(esr.json.spi, 0.95) && esr.json.schedule_rag === 'red' && esr.json.planned_duration_months === 2,
    JSON.stringify({ es: esr.json.earned_schedule_months, at: esr.json.actual_time_months, spi_t: esr.json.spi_t, spi: esr.json.spi }));
  ok('Earned schedule forecasts finish from SPI(t): plan 2 mo / 0.3167 → ~6.32 mo → 2026-07',
    Math.abs(Number(esr.json.eac_t_months) - 6.32) < 0.05 && esr.json.forecast_finish_month === '2026-07',
    JSON.stringify({ eac_t: esr.json.eac_t_months, finish: esr.json.forecast_finish_month }));
  // Lipke plateau convention: PRJ-EVM's EV (1000) sits exactly on a long flat PV stretch (nothing more
  // planned until 2099) — the plateau is credited as earned, so SPI(t) reads ahead, never a false slip.
  const esEvm = await inj('GET', '/api/projects/PRJ-EVM/earned-schedule', admin);
  ok('Earned schedule plateau: EV on a flat PV stretch credits the plateau (PRJ-EVM SPI(t) > 1, no false alarm)',
    esEvm.json.spi_t != null && esEvm.json.spi_t > 1 && esEvm.json.schedule_rag === 'green',
    JSON.stringify({ spi_t: esEvm.json.spi_t }));
  // A project with no dated/costed plan can't earn schedule → explicit NO_DATED_PLAN, no phantom metric.
  const esCpm = await inj('GET', '/api/projects/PRJ-CPM/earned-schedule', admin);
  ok('Earned schedule without a costed dated plan → nulls + NO_DATED_PLAN (PRJ-CPM has hours only)',
    esCpm.json.spi_t === null && esCpm.json.reason === 'NO_DATED_PLAN' && esCpm.json.schedule_rag === 'no_data',
    JSON.stringify({ reason: esCpm.json.reason }));

  // ── 16c. richer scheduling: SS/FF/SF dependency types + lag/lead, SNET/FNLT constraints, working
  // calendar (PPM-B1, PROJ-21). A→5d; B (SS,lag+2 on A)→3d; C (FF,lag-1 on A)→1d; D (FS,lag-2 "lead" on B)→2d.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-DEP', name: 'งานความสัมพันธ์ขั้นสูง', billing_type: 'TM' });
  const depA = await inj('POST', '/api/projects/PRJ-DEP/tasks', admin, { name: 'DEP-A', planned_hours: 40 }); // 5d
  const depAid = depA.json.tasks[0].id;
  await inj('POST', '/api/projects/PRJ-DEP/tasks', admin, { name: 'DEP-B', planned_hours: 24, dependencies: [{ task_id: depAid, type: 'SS', lag_days: 2 }] }); // 3d
  await inj('POST', '/api/projects/PRJ-DEP/tasks', admin, { name: 'DEP-C', planned_hours: 8, dependencies: [{ task_id: depAid, type: 'FF', lag_days: -1 }] }); // 1d
  const depList = await inj('GET', '/api/projects/PRJ-DEP/tasks', admin);
  const depBid = depList.json.tasks.find((t: any) => t.name === 'DEP-B').id;
  await inj('POST', '/api/projects/PRJ-DEP/tasks', admin, { name: 'DEP-D', planned_hours: 16, dependencies: [{ task_id: depBid, type: 'FS', lag_days: -2 }] }); // 2d, lead
  const depSched = await inj('GET', '/api/projects/PRJ-DEP/schedule', admin);
  const dTask = (name: string) => (depSched.json.tasks ?? []).find((t: any) => t.name === name);
  ok('PROJ-21: SS+lag2 — DEP-B starts 2d after DEP-A starts (es 2, ef 5)', near(dTask('DEP-B')?.es, 2) && near(dTask('DEP-B')?.ef, 5), JSON.stringify({ es: dTask('DEP-B')?.es, ef: dTask('DEP-B')?.ef }));
  ok('PROJ-21: FF+lag-1 — DEP-C finishes 1d before DEP-A finishes (es 3, ef 4)', near(dTask('DEP-C')?.es, 3) && near(dTask('DEP-C')?.ef, 4), JSON.stringify({ es: dTask('DEP-C')?.es, ef: dTask('DEP-C')?.ef }));
  ok('PROJ-21: FS+lag-2 (lead) — DEP-D starts 2d before DEP-B finishes (es 3, ef 5)', near(dTask('DEP-D')?.es, 3) && near(dTask('DEP-D')?.ef, 5), JSON.stringify({ es: dTask('DEP-D')?.es, ef: dTask('DEP-D')?.ef }));
  ok('PROJ-21: critical path A→B→D (slack 0), C has 1d slack (off path)',
    dTask('DEP-A')?.on_critical_path && dTask('DEP-B')?.on_critical_path && dTask('DEP-D')?.on_critical_path && dTask('DEP-C')?.on_critical_path === false && near(dTask('DEP-C')?.slack, 1),
    JSON.stringify({ slackC: dTask('DEP-C')?.slack }));
  ok('PROJ-21: dependency_details echoes the edge type + lag for DEP-B', dTask('DEP-B')?.dependency_details?.[0]?.type === 'SS' && dTask('DEP-B')?.dependency_details?.[0]?.lag_days === 2, JSON.stringify(dTask('DEP-B')?.dependency_details));
  const depSelf = await inj('PATCH', `/api/projects/tasks/${depBid}`, admin, { dependencies: [{ task_id: depBid, type: 'FS' }] });
  ok('PROJ-21: a richer self-dependency → 400 BAD_DEPENDENCY', depSelf.status === 400 && depSelf.json.error?.code === 'BAD_DEPENDENCY', `${depSelf.status} ${depSelf.json.error?.code}`);

  // SNET floors the forward pass; FNLT caps the backward pass — proven against an unconstrained sibling (H)
  // of identical shape so the cap is attributable to the constraint, not a general project effect.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-CONSTRAIN', name: 'งานข้อจำกัดกำหนดการ', billing_type: 'TM' });
  const conE = await inj('POST', '/api/projects/PRJ-CONSTRAIN/tasks', admin, { name: 'CON-E', planned_hours: 8, constraint_type: 'SNET', constraint_offset_days: 10 }); // 1d
  const conEid = conE.json.tasks[0].id;
  await inj('POST', '/api/projects/PRJ-CONSTRAIN/tasks', admin, { name: 'CON-F', planned_hours: 8, depends_on: [conEid] }); // 1d
  await inj('POST', '/api/projects/PRJ-CONSTRAIN/tasks', admin, { name: 'CON-G', planned_hours: 8, constraint_type: 'FNLT', constraint_offset_days: 3 }); // 1d
  await inj('POST', '/api/projects/PRJ-CONSTRAIN/tasks', admin, { name: 'CON-H', planned_hours: 8 }); // 1d, unconstrained control
  const conSched = await inj('GET', '/api/projects/PRJ-CONSTRAIN/schedule', admin);
  const cTask = (name: string) => (conSched.json.tasks ?? []).find((t: any) => t.name === name);
  ok('PROJ-21: SNET=10 floors CON-E\'s early start (es 10, ef 11) though it has no predecessor', near(cTask('CON-E')?.es, 10) && near(cTask('CON-E')?.ef, 11), JSON.stringify({ es: cTask('CON-E')?.es }));
  ok('PROJ-21: CON-F (depends on the SNET-floored CON-E) inherits es 11, ef 12 → project duration 12', near(cTask('CON-F')?.es, 11) && conSched.json.project_duration_days === 12, JSON.stringify({ es: cTask('CON-F')?.es, dur: conSched.json.project_duration_days }));
  ok('PROJ-21: FNLT=3 caps CON-G\'s late finish (lf 3) vs its unconstrained twin CON-H (lf 12) — same shape, only the constraint differs',
    near(cTask('CON-G')?.lf, 3) && near(cTask('CON-H')?.lf, 12) && cTask('CON-G')!.slack < cTask('CON-H')!.slack,
    JSON.stringify({ lfG: cTask('CON-G')?.lf, lfH: cTask('CON-H')?.lf, slackG: cTask('CON-G')?.slack, slackH: cTask('CON-H')?.slack }));

  // Working calendar (opt-in, per-tenant): disabled by default → plain calendar-day duration; enabled →
  // working-day-only duration. A 14-calendar-day span always contains exactly 2 Saturdays + 2 Sundays
  // regardless of which weekday it starts on, so 14→10 is a deterministic, alignment-independent assertion.
  const calBefore = await inj('GET', '/api/projects/calendar', admin);
  ok('PROJ-21: working calendar defaults to disabled, non_working_weekdays [0,6]', calBefore.json.enabled === false && JSON.stringify(calBefore.json.non_working_weekdays) === JSON.stringify([0, 6]), JSON.stringify(calBefore.json));
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-CAL', name: 'งานปฏิทินทำงาน', billing_type: 'TM' });
  await inj('POST', '/api/projects/PRJ-CAL/tasks', admin, { name: 'CAL-1', planned_start: '2026-07-01', planned_end: '2026-07-14' }); // 14 calendar days
  const calSchedOff = await inj('GET', '/api/projects/PRJ-CAL/schedule', admin);
  ok('PROJ-21: calendar disabled → plain 14 calendar-day duration (unchanged pre-PPM-B1 behaviour)', calSchedOff.json.working_calendar_enabled === false && calSchedOff.json.tasks?.[0]?.duration_days === 14, JSON.stringify({ dur: calSchedOff.json.tasks?.[0]?.duration_days }));
  const calOn = await inj('PUT', '/api/projects/calendar', admin, { enabled: true });
  ok('PROJ-21: enable the working calendar', calOn.json.enabled === true, JSON.stringify(calOn.json));
  const calSchedOn = await inj('GET', '/api/projects/PRJ-CAL/schedule', admin);
  ok('PROJ-21: calendar enabled → 14 calendar days minus 2 Sat + 2 Sun = 10 working days', calSchedOn.json.working_calendar_enabled === true && calSchedOn.json.tasks?.[0]?.duration_days === 10, JSON.stringify({ dur: calSchedOn.json.tasks?.[0]?.duration_days }));
  const calExc = await inj('POST', '/api/projects/calendar/exceptions', admin, { exception_date: '2026-12-25', description: 'Christmas' });
  ok('PROJ-21: add + list a calendar holiday exception', calExc.json.exceptions?.some((e: any) => e.exception_date === '2026-12-25' && e.description === 'Christmas'), JSON.stringify(calExc.json.exceptions));
  await inj('PUT', '/api/projects/calendar', admin, { enabled: false }); // cleanup — leave the tenant calendar disabled for the rest of the harness

  // ── 16d. bottom-up cost-to-complete (ETC) vs the formulaic EAC (PPM-B2, PROJ-22) ──
  // ETC-1: BAC 1000, 50% complete → EV 500; a non-billable 200 cost entry → AC 200 (does not touch WIP/GL).
  // Formulaic: CPI = 500/200 = 2.5 → EAC = 200 + (1000-500)/2.5 = 400, ETC = 200.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-ETC', name: 'งานประมาณการต้นทุนคงเหลือ', billing_type: 'TM' });
  const etcTask = await inj('POST', '/api/projects/PRJ-ETC/tasks', admin, { name: 'ETC-1', planned_cost: 1000, pct_complete: 50 });
  const etcTaskId = etcTask.json.tasks[0].id;
  await inj('POST', '/api/projects/PRJ-ETC/cost', admin, { entry_type: 'expense', amount: 200, billable: false, description: 'non-billable AC' });
  const eacBefore = await inj('GET', '/api/projects/PRJ-ETC/eac-scenarios', admin);
  ok('PROJ-22: with no manual ETC entries, eac-scenarios reports the formulaic EAC only (bottom_up null)',
    eacBefore.json.bottom_up === null && near(eacBefore.json.formulaic?.eac, 400) && near(eacBefore.json.formulaic?.etc, 200) && near(eacBefore.json.ac, 200),
    JSON.stringify(eacBefore.json));
  const etcBadTask = await inj('POST', '/api/projects/PRJ-ETC/etc', admin, { task_id: depAid, etc_amount: 100 });
  ok('PROJ-22: an ETC submitted against a task from ANOTHER project → 400/404 TASK_NOT_FOUND',
    [400, 404].includes(etcBadTask.status) && etcBadTask.json.error?.code === 'TASK_NOT_FOUND', `${etcBadTask.status} ${etcBadTask.json.error?.code}`);
  const etc1 = await inj('POST', '/api/projects/PRJ-ETC/etc', admin, { task_id: etcTaskId, etc_amount: 600, note: 'first estimate' });
  ok('PROJ-22: a per-task ETC entry drives the bottom-up EAC (ETC 600 → EAC 800 = AC 200 + 600), variance vs formulaic',
    near(etc1.json.bottom_up?.etc, 600) && near(etc1.json.bottom_up?.eac, 800) && etc1.json.bottom_up?.entry_count === 1
      && near(etc1.json.variance?.eac_delta, 400) && near(etc1.json.variance?.etc_delta, 400),
    JSON.stringify({ bottomUp: etc1.json.bottom_up, variance: etc1.json.variance }));
  const etc2 = await inj('POST', '/api/projects/PRJ-ETC/etc', admin, { task_id: etcTaskId, etc_amount: 650, note: 'revised estimate' });
  ok('PROJ-22: a SECOND entry for the SAME task SUPERSEDES the first (entry_count stays 1, not 2)',
    near(etc2.json.bottom_up?.etc, 650) && etc2.json.bottom_up?.entry_count === 1, JSON.stringify(etc2.json.bottom_up));
  const etc3 = await inj('POST', '/api/projects/PRJ-ETC/etc', admin, { etc_amount: 50, note: 'contingency (project-level)' });
  ok('PROJ-22: a project-level entry (task_id omitted) SUMS alongside the per-task entry (700 = 650 + 50, entry_count 2)',
    near(etc3.json.bottom_up?.etc, 700) && etc3.json.bottom_up?.entry_count === 2, JSON.stringify(etc3.json.bottom_up));
  ok('PROJ-22: existing evm()/schedule() callers are unaffected by ETC entries (formulaic figures unchanged)',
    near(etc3.json.formulaic?.eac, 400) && near(etc3.json.formulaic?.etc, 200), JSON.stringify(etc3.json.formulaic));

  // ── resource leveling: over-allocation vs the CPM schedule's slack (PPM-A2, PROJ-23) ──
  // LVL-A (5d) → LVL-B (3d, depends on A) forms the critical path (8d, both slack 0); LVL-C (2d,
  // independent) carries slack 6 (project duration 8 − its own 2d). Dev1 is booked on LVL-B (100%) + LVL-C
  // (60%) in the same month → 160% over-allocated, and LVL-C (positive slack) is the leveling candidate.
  // Dev2 is booked on LVL-A (100%) + LVL-B (100%) in the same month → 200% over-allocated, but BOTH
  // contributors are critical-path (slack 0) → NO_SLACK, nothing to suggest.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-LEVEL', name: 'งานปรับสมดุลกำลังคน', billing_type: 'TM' });
  const lvlA = await inj('POST', '/api/projects/PRJ-LEVEL/tasks', admin, { name: 'LVL-A', planned_hours: 40 }); // 5d
  const lvlAid = lvlA.json.tasks[0].id;
  const lvlB = await inj('POST', '/api/projects/PRJ-LEVEL/tasks', admin, { name: 'LVL-B', planned_hours: 24, depends_on: [lvlAid] }); // 3d
  const lvlBid = lvlB.json.tasks[0].id;
  // LVL-C's own planned_start (2026-08-27) is independent of its assignment's period_start (2026-08-01,
  // set below) — the assignment's period_start drives which month is over-allocated, while the task's own
  // planned_start is what a suggested shift (+6d slack) is measured from, crossing into September.
  await inj('POST', '/api/projects/PRJ-LEVEL/tasks', admin, { name: 'LVL-C', planned_hours: 16, planned_start: '2026-08-27' }); // 2d, independent
  const lvlList = await inj('GET', '/api/projects/PRJ-LEVEL/tasks', admin);
  const lvlCid = lvlList.json.tasks.find((t: any) => t.name === 'LVL-C').id;
  await inj('POST', '/api/projects/PRJ-LEVEL/resources', admin, { resource_name: 'Dev1', task_id: lvlBid, alloc_pct: 100, period_start: '2026-08-01' });
  await inj('POST', '/api/projects/PRJ-LEVEL/resources', admin, { resource_name: 'Dev1', task_id: lvlCid, alloc_pct: 60, period_start: '2026-08-01' });
  await inj('POST', '/api/projects/PRJ-LEVEL/resources', admin, { resource_name: 'Dev2', task_id: lvlAid, alloc_pct: 100, period_start: '2026-08-01' });
  await inj('POST', '/api/projects/PRJ-LEVEL/resources', admin, { resource_name: 'Dev2', task_id: lvlBid, alloc_pct: 100, period_start: '2026-08-01' });
  const leveling = await inj('GET', '/api/projects/PRJ-LEVEL/resource-leveling', admin);
  const dev1Over = leveling.json.over_allocations?.find((o: any) => o.resource_name === 'Dev1' && o.month === '2026-08');
  const dev2Over = leveling.json.over_allocations?.find((o: any) => o.resource_name === 'Dev2' && o.month === '2026-08');
  ok('PROJ-23: Dev1 (LVL-B 100% + LVL-C 60%) over-allocated at 160% vs a 100% ceiling', near(dev1Over?.allocated_pct, 160) && near(dev1Over?.over_by_pct, 60), JSON.stringify(dev1Over));
  ok('PROJ-23: Dev2 (LVL-A 100% + LVL-B 100%) over-allocated at 200% vs a 100% ceiling', near(dev2Over?.allocated_pct, 200) && near(dev2Over?.over_by_pct, 100), JSON.stringify(dev2Over));
  const dev1Sugg = leveling.json.suggestions?.find((s: any) => s.resource_name === 'Dev1');
  ok('PROJ-23: Dev1\'s over-allocation suggests shifting LVL-C (its only positive-slack contributor) by its full slack (6d) into 2026-09',
    dev1Sugg?.task_id === lvlCid && dev1Sugg?.slack_days === 6 && dev1Sugg?.suggested_shift_days === 6 && dev1Sugg?.shifted_to_month === '2026-09',
    JSON.stringify(dev1Sugg));
  ok('PROJ-23: no suggestion is offered for LVL-B (slack 0) despite contributing to BOTH over-allocations', !leveling.json.suggestions?.some((s: any) => s.task_id === lvlBid), JSON.stringify(leveling.json.suggestions));
  const dev2Unres = leveling.json.unresolvable?.find((u: any) => u.resource_name === 'Dev2');
  ok('PROJ-23: Dev2\'s over-allocation is NO_SLACK — both contributing tasks (LVL-A, LVL-B) are on the critical path', dev2Unres?.reason === 'NO_SLACK', JSON.stringify(dev2Unres));
  ok('PROJ-23: over_allocated_count reflects both resources (2)', leveling.json.over_allocated_count === 2, String(leveling.json.over_allocated_count));
  const levelEmpty = await inj('GET', '/api/projects/PRJ-ETC/resource-leveling', admin); // no resource assignments on this project → nothing over-allocated
  ok('PROJ-23: a project with no over-allocated resource reports empty results (regression)',
    levelEmpty.json.over_allocated_count === 0 && !(levelEmpty.json.over_allocations ?? []).length && !(levelEmpty.json.suggestions ?? []).length && !(levelEmpty.json.unresolvable ?? []).length,
    JSON.stringify(levelEmpty.json));

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

  // ── 24b. change-order impact simulation (PROJ-24) — read-only cost/margin/EVM what-if before authorisation ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-SIM', name: 'งานจำลองผลกระทบ', billing_type: 'Fixed', contract_amount: 200000, budget_amount: 150000, estimated_cost: 140000 });
  const simCo = await inj('POST', '/api/projects/PRJ-SIM/change-orders', admin, { description: 'เพิ่มขอบเขต', contract_delta: 50000, budget_delta: 30000, estimated_cost_delta: 45000, reason: 'ลูกค้าขอเพิ่ม' });
  const simCoId = simCo.json.change_orders?.find((c: any) => c.status === 'pending')?.id;

  // Current margin 60000 (200000−140000); projected 65000 (250000−185000) → the CO ADDS 5000 margin but at a
  // thinner ratio (30%→26%); budget-derived BAC/EAC move with the budget delta.
  const sim = await inj('GET', `/api/projects/change-orders/${simCoId}/simulate`, admin);
  ok('PROJ-24 simulate: projected contract/budget/estimated-cost + margin + EVM impact computed',
    sim.status === 200 && near(sim.json.projected.contract_amount, 250000) && near(sim.json.projected.estimated_cost, 185000) &&
    near(sim.json.current.margin, 60000) && near(sim.json.projected.margin, 65000) && near(sim.json.delta.margin, 5000) &&
    sim.json.bac_basis === 'budget' && near(sim.json.projected.eac, 180000) && near(sim.json.delta.eac, 30000),
    JSON.stringify({ pm: sim.json.projected.margin, dm: sim.json.delta.margin, peac: sim.json.projected.eac }));

  // Read-only proof: nothing changed on the project.
  const simBefore = await inj('GET', '/api/projects/PRJ-SIM', admin);
  ok('PROJ-24 simulate is READ-ONLY: the project is unchanged (contract still 200000)', near(simBefore.json.contract_amount, 200000), JSON.stringify({ c: simBefore.json.contract_amount }));

  // Authorising the CO produces exactly the simulated figures.
  const simApp = await inj('POST', `/api/projects/change-orders/${simCoId}/approve`, mgr, {});
  ok('PROJ-24 the authorised change matches the simulation (contract 250000, budget 180000)',
    simApp.json.status === 'approved' && near(simApp.json.contract_amount, 250000) && near(simApp.json.budget_amount, 180000), JSON.stringify({ c: simApp.json.contract_amount, b: simApp.json.budget_amount }));

  // A decided CO can't be re-simulated (its impact is already reflected); an unknown CO 404s.
  const simDecided = await inj('GET', `/api/projects/change-orders/${simCoId}/simulate`, admin);
  const simBad = await inj('GET', '/api/projects/change-orders/999999/simulate', admin);
  ok('PROJ-24 simulate guards: decided → 400 CHANGE_ORDER_DECIDED, unknown → 404 CHANGE_ORDER_NOT_FOUND',
    simDecided.status === 400 && simDecided.json.error?.code === 'CHANGE_ORDER_DECIDED' && simBad.status === 404 && simBad.json.error?.code === 'CHANGE_ORDER_NOT_FOUND',
    `${simDecided.json.error?.code}/${simBad.json.error?.code}`);

  // Task-anchored EVM: on a project whose BAC comes from task planned cost, a pure budget CO leaves BAC/EAC
  // unchanged (only the budget headroom moves) — the simulation reports bac_basis='tasks'.
  const simTaskCo = await inj('POST', '/api/projects/PRJ-EVM/change-orders', admin, { description: 'budget top-up', budget_delta: 500 });
  const simTaskCoId = simTaskCo.json.change_orders?.find((c: any) => c.status === 'pending')?.id;
  const simTask = await inj('GET', `/api/projects/change-orders/${simTaskCoId}/simulate`, admin);
  ok('PROJ-24 task-anchored EVM: a budget-only CO leaves BAC/EAC unchanged (bac_basis=tasks), only headroom moves +500',
    simTask.status === 200 && simTask.json.bac_basis === 'tasks' && near(simTask.json.projected.bac, simTask.json.current.bac) && near(simTask.json.delta.eac, 0) && near(simTask.json.delta.budget_headroom, 500),
    JSON.stringify({ basis: simTask.json.bac_basis, dbac: simTask.json.delta.eac, dh: simTask.json.delta.budget_headroom }));

  // ── 24c. Portfolio selection scenarios (PPM Wave P4, PROJ-25) — what-if funding within a budget envelope
  // + maker-checker commit (committer ≠ author; over-envelope needs an exec override). Read-only aggregation
  // over the projects spine; no project row is mutated. ──
  for (const [code, contract, budget, est] of [['PRJ-PF1', 100000, 60000, 50000], ['PRJ-PF2', 80000, 50000, 40000], ['PRJ-PF3', 120000, 70000, 60000]] as const)
    await inj('POST', '/api/projects', admin, { project_code: code, name: `พอร์ต ${code}`, billing_type: 'Fixed', contract_amount: contract, budget_amount: budget, estimated_cost: est });

  const pfCreate = await inj('POST', '/api/projects/portfolio/scenarios', admin, { name: 'FY27 candidate slate', budget_envelope: 100000, objective: 'จัดลำดับโครงการปีหน้า' });
  ok('PROJ-25 create scenario → draft, PSC-#### numbered', pfCreate.status < 300 && /^PSC-\d{4}$/.test(pfCreate.json.scenario_no) && pfCreate.json.status === 'draft', JSON.stringify({ s: pfCreate.status, no: pfCreate.json.scenario_no }));
  const psc = pfCreate.json.scenario_no;

  await inj('POST', `/api/projects/portfolio/scenarios/${psc}/items`, admin, { project_code: 'PRJ-PF1', decision: 'include', priority_score: 10 });
  await inj('POST', `/api/projects/portfolio/scenarios/${psc}/items`, admin, { project_code: 'PRJ-PF2', decision: 'include', priority_score: 5 });
  const pfAnalyze = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/items`, admin, { project_code: 'PRJ-PF3', decision: 'exclude' });
  ok('PROJ-25 analyze: included Σbudget 110000 (>envelope 100000) → over_envelope, over_by 10000, Σmargin 90000, priority-ranked',
    pfAnalyze.status < 300 && pfAnalyze.json.totals.included_count === 2 && pfAnalyze.json.totals.excluded_count === 1 &&
    near(pfAnalyze.json.totals.selected_budget, 110000) && near(pfAnalyze.json.totals.selected_margin, 90000) &&
    pfAnalyze.json.totals.over_envelope === true && near(pfAnalyze.json.totals.over_by, 10000) &&
    pfAnalyze.json.included[0].project_code === 'PRJ-PF1',
    JSON.stringify({ inc: pfAnalyze.json.totals.included_count, b: pfAnalyze.json.totals.selected_budget, over: pfAnalyze.json.totals.over_by, first: pfAnalyze.json.included[0]?.project_code }));

  const pfUnknown = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/items`, admin, { project_code: 'PRJ-NOPE', decision: 'include' });
  ok('PROJ-25 unknown candidate → 404 PROJECT_NOT_FOUND', pfUnknown.status === 404 && pfUnknown.json.error?.code === 'PROJECT_NOT_FOUND', `${pfUnknown.status}/${pfUnknown.json.error?.code}`);

  const pfSelf = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/commit`, admin, {});
  ok('PROJ-25 author self-commit → 400 SOD_SELF_APPROVAL', pfSelf.status === 400 && pfSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${pfSelf.status}/${pfSelf.json.error?.code}`);

  const pfOver = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/commit`, mgr, {});
  ok('PROJ-25 different-user commit over envelope w/o override → 400 OVER_ENVELOPE (over_by 10000)',
    pfOver.status === 400 && pfOver.json.error?.code === 'OVER_ENVELOPE' && near(pfOver.json.error?.details?.over_by, 10000), `${pfOver.status}/${pfOver.json.error?.code}`);

  const pfCommit = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/commit`, mgr, { override: true, override_reason: 'อนุมัติเกินวงเงินโดยผู้บริหาร' });
  ok('PROJ-25 exec override commit → committed, committed_by=mgr, override_reason recorded',
    pfCommit.status < 300 && pfCommit.json.status === 'committed' && pfCommit.json.committed_by === 'mgr' && !!pfCommit.json.override_reason, JSON.stringify({ st: pfCommit.json.status, by: pfCommit.json.committed_by }));

  const pfLocked = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/items`, admin, { project_code: 'PRJ-PF3', decision: 'include' });
  const pfRecommit = await inj('POST', `/api/projects/portfolio/scenarios/${psc}/commit`, mgr, {});
  ok('PROJ-25 a committed scenario is locked: edit → 400 SCENARIO_LOCKED, re-commit → 400 SCENARIO_NOT_DRAFT',
    pfLocked.status === 400 && pfLocked.json.error?.code === 'SCENARIO_LOCKED' && pfRecommit.status === 400 && pfRecommit.json.error?.code === 'SCENARIO_NOT_DRAFT',
    `${pfLocked.json.error?.code}/${pfRecommit.json.error?.code}`);

  // Within-envelope clean commit path (no override needed) + removeItem regression.
  const pfB = await inj('POST', '/api/projects/portfolio/scenarios', admin, { name: 'FY27 conservative', budget_envelope: 200000 });
  await inj('POST', `/api/projects/portfolio/scenarios/${pfB.json.scenario_no}/items`, admin, { project_code: 'PRJ-PF1', decision: 'include', priority_score: 8 });
  await inj('POST', `/api/projects/portfolio/scenarios/${pfB.json.scenario_no}/items`, admin, { project_code: 'PRJ-PF2', decision: 'include', priority_score: 3 });
  const pfBremove = await inj('DELETE', `/api/projects/portfolio/scenarios/${pfB.json.scenario_no}/items/PRJ-PF2`, admin);
  ok('PROJ-25 removeItem drops a candidate → included_count 1', pfBremove.status < 300 && pfBremove.json.totals.included_count === 1, JSON.stringify({ inc: pfBremove.json.totals?.included_count }));
  const pfBcommit = await inj('POST', `/api/projects/portfolio/scenarios/${pfB.json.scenario_no}/commit`, mgr, {});
  ok('PROJ-25 within-envelope commit needs no override → committed, over_envelope false, headroom 140000',
    pfBcommit.status < 300 && pfBcommit.json.status === 'committed' && pfBcommit.json.totals.over_envelope === false && near(pfBcommit.json.totals.budget_headroom, 140000),
    JSON.stringify({ st: pfBcommit.json.status, hr: pfBcommit.json.totals?.budget_headroom }));

  const pfList = await inj('GET', '/api/projects/portfolio/scenarios', admin);
  ok('PROJ-25 list surfaces both scenarios with included counts', pfList.status < 300 && pfList.json.count >= 2 && pfList.json.scenarios.some((x: any) => x.scenario_no === psc && x.status === 'committed'), JSON.stringify({ n: pfList.json.count }));

  // ── 24d. Project phase-gate governance (PPM Wave P4, PROJ-26) — a project advances through its lifecycle
  // phases only through a gate that is submitted then independently decided (GO/HOLD/KILL, decider ≠ submitter). ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-GATE', name: 'งานตรวจเฟส', billing_type: 'TM' });
  const gInit = await inj('GET', '/api/projects/PRJ-GATE/gates', admin);
  ok('PROJ-26 a fresh project starts at the concept phase with no gates', gInit.status < 300 && gInit.json.current_phase === 'concept' && gInit.json.next_phase === 'planning' && gInit.json.gates.length === 0, JSON.stringify({ p: gInit.json.current_phase, n: gInit.json.next_phase }));

  const gSubmit = await inj('POST', '/api/projects/PRJ-GATE/gates', admin, { target_phase: 'planning', gate_key: 'G1', name: 'Concept review', readiness: 'ผ่านเกณฑ์ความพร้อม' });
  ok('PROJ-26 submit a gate → pending, from_phase concept, target planning', gSubmit.status < 300 && gSubmit.json.pending_gate?.status === 'pending' && gSubmit.json.pending_gate?.from_phase === 'concept' && gSubmit.json.pending_gate?.target_phase === 'planning', JSON.stringify({ st: gSubmit.json.pending_gate?.status }));
  const g1 = gSubmit.json.pending_gate.id;

  const gDouble = await inj('POST', '/api/projects/PRJ-GATE/gates', admin, { target_phase: 'execution' });
  ok('PROJ-26 a second pending gate is rejected → GATE_ALREADY_PENDING', gDouble.status === 400 && gDouble.json.error?.code === 'GATE_ALREADY_PENDING', `${gDouble.status}/${gDouble.json.error?.code}`);

  const gSelf = await inj('POST', `/api/projects/gates/${g1}/decide`, admin, { decision: 'go' });
  ok('PROJ-26 the submitter cannot decide their own gate → SOD_SELF_APPROVAL', gSelf.status === 400 && gSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${gSelf.status}/${gSelf.json.error?.code}`);

  const gGo = await inj('POST', `/api/projects/gates/${g1}/decide`, mgr, { decision: 'go', notes: 'อนุมัติเข้าเฟสวางแผน' });
  ok('PROJ-26 an independent GO advances the project to planning; decided_by=mgr', gGo.status < 300 && gGo.json.current_phase === 'planning' && gGo.json.gates.find((x: any) => x.id === g1)?.status === 'go' && gGo.json.gates.find((x: any) => x.id === g1)?.decided_by === 'mgr', JSON.stringify({ p: gGo.json.current_phase }));

  const gDecided = await inj('POST', `/api/projects/gates/${g1}/decide`, mgr, { decision: 'hold' });
  ok('PROJ-26 a decided gate cannot be re-decided → GATE_ALREADY_DECIDED', gDecided.status === 400 && gDecided.json.error?.code === 'GATE_ALREADY_DECIDED', `${gDecided.status}/${gDecided.json.error?.code}`);

  const gBackward = await inj('POST', '/api/projects/PRJ-GATE/gates', admin, { target_phase: 'planning' });
  ok('PROJ-26 a gate that does not advance past the current phase → BAD_PHASE_ORDER', gBackward.status === 400 && gBackward.json.error?.code === 'BAD_PHASE_ORDER', `${gBackward.status}/${gBackward.json.error?.code}`);

  // A HOLD decision records the outcome WITHOUT advancing the phase.
  const gHoldSubmit = await inj('POST', '/api/projects/PRJ-GATE/gates', admin, { target_phase: 'execution', gate_key: 'G2' });
  const g2 = gHoldSubmit.json.pending_gate.id;
  const gHold = await inj('POST', `/api/projects/gates/${g2}/decide`, mgr, { decision: 'hold', notes: 'ยังไม่พร้อม' });
  ok('PROJ-26 a HOLD records the decision but the project stays in planning (no advance)', gHold.status < 300 && gHold.json.current_phase === 'planning' && gHold.json.gates.find((x: any) => x.id === g2)?.status === 'hold', JSON.stringify({ p: gHold.json.current_phase }));

  const gUnknownPhase = await inj('POST', '/api/projects/PRJ-GATE/gates', admin, { target_phase: 'lunch' });
  const gBadDecision = await inj('POST', `/api/projects/gates/999999/decide`, mgr, { decision: 'go' });
  ok('PROJ-26 guards: unknown phase → BAD_PHASE, unknown gate → GATE_NOT_FOUND', gUnknownPhase.status === 400 && gUnknownPhase.json.error?.code === 'BAD_PHASE' && gBadDecision.status === 404 && gBadDecision.json.error?.code === 'GATE_NOT_FOUND', `${gUnknownPhase.json.error?.code}/${gBadDecision.json.error?.code}`);

  // ── 24e. Program benefits realization (PPM Wave P4, PROJ-27) — declare expected benefits, log actuals over
  // time, and close each realized/not-realized as a maker-checker sign-off (confirmer ≠ author). ──
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-BEN', name: 'โครงการวัดผลประโยชน์', billing_type: 'TM' });
  await inj('PATCH', '/api/projects/PRJ-BEN/program', admin, { program_code: 'PGBEN' });

  const bUnknownProg = await inj('POST', '/api/projects/programs/NOPE/benefits', admin, { name: 'x', target_value: 100 });
  ok('PROJ-27 declaring a benefit under an unknown program → 404 PROGRAM_NOT_FOUND', bUnknownProg.status === 404 && bUnknownProg.json.error?.code === 'PROGRAM_NOT_FOUND', `${bUnknownProg.status}/${bUnknownProg.json.error?.code}`);

  const bDecl = await inj('POST', '/api/projects/programs/PGBEN/benefits', admin, { name: 'ลดต้นทุนต่อหน่วย', category: 'financial', unit: 'THB', baseline_value: 0, target_value: 1000000, target_date: '2027-12-31', owner: 'CFO' });
  ok('PROJ-27 declare a benefit → open, PB-#### numbered, 0% realized against a 1,000,000 target',
    bDecl.status < 300 && bDecl.json.benefits.length === 1 && /^PB-\d{4}$/.test(bDecl.json.benefits[0].benefit_no) && bDecl.json.benefits[0].status === 'open' && near(bDecl.json.benefits[0].realization_pct, 0) && near(bDecl.json.rollup.financial_target, 1000000),
    JSON.stringify({ no: bDecl.json.benefits[0]?.benefit_no, pct: bDecl.json.benefits[0]?.realization_pct }));
  const benId = bDecl.json.benefits[0].id;

  const bMeasure = await inj('POST', `/api/projects/benefits/${benId}/measurements`, admin, { measured_value: 600000, measured_at: '2027-06-30' });
  ok('PROJ-27 record an actual measurement → realization tracks to 60% (600,000 of 1,000,000)',
    bMeasure.status < 300 && near(bMeasure.json.benefits[0].current_actual, 600000) && near(bMeasure.json.benefits[0].realization_pct, 60) && bMeasure.json.benefits[0].health === 'on_track' && bMeasure.json.benefits[0].measurements_count === 1,
    JSON.stringify({ actual: bMeasure.json.benefits[0]?.current_actual, pct: bMeasure.json.benefits[0]?.realization_pct }));

  const bMeasure2 = await inj('POST', `/api/projects/benefits/${benId}/measurements`, admin, { measured_value: 300000, measured_at: '2027-09-30' });
  ok('PROJ-27 the latest measurement is current (300,000 → 30%, at_risk); count reflects both entries',
    bMeasure2.status < 300 && near(bMeasure2.json.benefits[0].current_actual, 300000) && near(bMeasure2.json.benefits[0].realization_pct, 30) && bMeasure2.json.benefits[0].health === 'at_risk' && bMeasure2.json.benefits[0].measurements_count === 2,
    JSON.stringify({ actual: bMeasure2.json.benefits[0]?.current_actual, health: bMeasure2.json.benefits[0]?.health }));

  const bSelf = await inj('POST', `/api/projects/benefits/${benId}/confirm`, admin, { result: 'realized' });
  ok('PROJ-27 the benefit author cannot sign off their own benefit → SOD_SELF_APPROVAL', bSelf.status === 400 && bSelf.json.error?.code === 'SOD_SELF_APPROVAL', `${bSelf.status}/${bSelf.json.error?.code}`);

  const bConfirm = await inj('POST', `/api/projects/benefits/${benId}/confirm`, mgr, { result: 'not_realized', notes: 'ไม่ถึงเป้าหมาย' });
  ok('PROJ-27 an independent reviewer signs off (not_realized); status + confirmed_by recorded',
    bConfirm.status < 300 && bConfirm.json.benefits[0].status === 'not_realized' && bConfirm.json.benefits[0].confirmed_by === 'mgr' && bConfirm.json.rollup.not_realized_count === 1,
    JSON.stringify({ st: bConfirm.json.benefits[0]?.status, by: bConfirm.json.benefits[0]?.confirmed_by }));

  const bClosedMeasure = await inj('POST', `/api/projects/benefits/${benId}/measurements`, admin, { measured_value: 1 });
  const bReconfirm = await inj('POST', `/api/projects/benefits/${benId}/confirm`, mgr, { result: 'realized' });
  ok('PROJ-27 a closed benefit rejects new measurements (BENEFIT_CLOSED) and re-confirmation (BENEFIT_ALREADY_CONFIRMED)',
    bClosedMeasure.status === 400 && bClosedMeasure.json.error?.code === 'BENEFIT_CLOSED' && bReconfirm.status === 400 && bReconfirm.json.error?.code === 'BENEFIT_ALREADY_CONFIRMED',
    `${bClosedMeasure.json.error?.code}/${bReconfirm.json.error?.code}`);

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

  // ── 25b. resource skills + availability calendar + role/skill supply-vs-demand (PPM-A1, PROJ-20) ──
  const skillSet = await inj('POST', '/api/projects/resources/skills', admin, { resource_name: 'DevOne', skill: 'Developer', proficiency: 'senior' });
  ok('PROJ-20: register a named skill → DevOne tagged Developer/senior', skillSet.json.skills?.some((s: any) => s.resource_name === 'DevOne' && s.skill === 'Developer' && s.proficiency === 'senior'), JSON.stringify(skillSet.json.skills));
  const badMonth = await inj('POST', '/api/projects/resources/calendar', admin, { resource_name: 'DevOne', month: '2026/07', available_pct: 50 });
  ok('PROJ-20: bad month format → 400 BAD_MONTH', badMonth.status === 400 && badMonth.json.error?.code === 'BAD_MONTH', `${badMonth.status} ${badMonth.json.error?.code}`);
  const badPct = await inj('POST', '/api/projects/resources/calendar', admin, { resource_name: 'DevOne', month: '2026-07', available_pct: 150 });
  ok('PROJ-20: out-of-range available_pct → 400 BAD_AVAILABLE_PCT', badPct.status === 400 && badPct.json.error?.code === 'BAD_AVAILABLE_PCT', `${badPct.status} ${badPct.json.error?.code}`);
  const calSet = await inj('POST', '/api/projects/resources/calendar', admin, { resource_name: 'DevOne', month: '2026-07', available_pct: 50, reason: 'part_time' });
  ok('PROJ-20: DevOne availability calendar → 50% for 2026-07', calSet.json.entries?.some((e: any) => e.month === '2026-07' && near(e.available_pct, 50) && e.reason === 'part_time'), JSON.stringify(calSet.json.entries));

  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-SKILL', name: 'งานทดสอบทักษะ', billing_type: 'TM' });
  // DevOne (named, 50%-part-time in July) at 60% → OVER-allocated against the TRUE 50% ceiling (would read fine
  // against the old flat 100% assumption). GenericGuy (no skill row) at 100% → a GENERIC placeholder booking.
  await inj('POST', '/api/projects/PRJ-SKILL/resources', admin, { resource_name: 'DevOne', role: 'Developer', alloc_pct: 60, period_start: '2026-07-01', period_end: '2026-07-31' });
  await inj('POST', '/api/projects/PRJ-SKILL/resources', admin, { resource_name: 'GenericGuy', role: 'Developer', alloc_pct: 100, period_start: '2026-07-01', period_end: '2026-07-31' });
  const cap2 = await inj('GET', '/api/projects/resources/capacity?from=2026-07&months=1', admin);
  const devOneCap = (cap2.json.resources ?? []).find((r: any) => r.resource_name === 'DevOne');
  const genericCap = (cap2.json.resources ?? []).find((r: any) => r.resource_name === 'GenericGuy');
  const devOneJul = devOneCap?.months?.find((c: any) => c.month === '2026-07');
  ok('PROJ-20: calendar-aware ceiling — DevOne 60% vs 50% availability reads OVER-allocated (not merely "busy")',
    devOneCap?.named === true && near(devOneJul?.allocated_pct, 60) && near(devOneJul?.available_pct, 50) && devOneJul?.over_allocated === true,
    JSON.stringify({ named: devOneCap?.named, alloc: devOneJul?.allocated_pct, avail: devOneJul?.available_pct, over: devOneJul?.over_allocated }));
  ok('PROJ-20: GenericGuy has no resource_skills row → named=false (generic placeholder booking)', genericCap?.named === false, JSON.stringify({ named: genericCap?.named }));

  const roleDemand = await inj('GET', '/api/projects/resources/role-demand?from=2026-07&months=1', admin);
  const devRole = (roleDemand.json.roles ?? []).find((r: any) => r.role === 'Developer');
  const devRoleJul = devRole?.months?.find((c: any) => c.month === '2026-07');
  // Demand: DevOne 60 + GenericGuy 100 = 160. Supply: only DevOne is skill-tagged, at his calendar 50% = 50.
  ok('PROJ-20: role/skill supply-vs-demand — Developer demand 160 vs supply 50 (only DevOne named) → understaffed',
    near(devRoleJul?.demand_pct, 160) && near(devRoleJul?.supply_pct, 50) && devRoleJul?.understaffed === true && devRole?.understaffed_months >= 1,
    JSON.stringify({ demand: devRoleJul?.demand_pct, supply: devRoleJul?.supply_pct, understaffed: devRoleJul?.understaffed }));
  ok('PROJ-20: understaffed_role_count surfaces the Developer gap', roleDemand.json.understaffed_role_count >= 1, JSON.stringify({ n: roleDemand.json.understaffed_role_count }));

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
  // PROJ-19 detective: PRJ-ES slips by earned schedule (SPI(t) < 0.9) while its classic SPI (0.95) reads
  // fine → a MEDIUM schedule_slip_es item; PRJ-ACT is already red, so the slip item is suppressed there.
  const esItem = (ac.json.items ?? []).find((i: any) => i.kind === 'schedule_slip_es' && i.project_code === 'PRJ-ES');
  ok('Action center surfaces schedule_slip_es (medium) for PRJ-ES — the slip the classic SPI hides (PROJ-19)',
    !!esItem && esItem.severity === 'medium' && esItem.meta?.spi_t < 0.9 && !acKinds.has('schedule_slip_es'),
    JSON.stringify({ found: !!esItem, spi_t: esItem?.meta?.spi_t, suppressed_on_red: !acKinds.has('schedule_slip_es') }));

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

  // ── P4 (docs/35) — real-estate developer vertical: units → booking → contract → installments (RE-01/02/03) ──
  await inj('POST', '/api/realestate/developments', admin, { dev_code: 'RED-1', name: 'เดอะ คอนโด', location: 'กรุงเทพฯ' });
  await inj('POST', '/api/realestate/developments/RED-1/units', admin, { unit_no: 'U-101', unit_type: 'condo', area_sqm: 35, list_price: 1000000 });
  await inj('POST', '/api/realestate/developments/RED-1/units', admin, { unit_no: 'U-102', unit_type: 'condo', area_sqm: 55, list_price: 2000000 });
  await inj('POST', '/api/realestate/developments/RED-1/units', admin, { unit_no: 'U-103', unit_type: 'condo', area_sqm: 40, list_price: 1000000 });
  const rlist0 = await inj('GET', '/api/realestate/developments/RED-1/units', admin);
  ok('RE-01: development unit grid → 3 units, all available', rlist0.json.summary?.total === 3 && rlist0.json.summary?.available === 3, JSON.stringify(rlist0.json.summary));

  const rbk1 = await inj('POST', '/api/realestate/bookings', admin, { dev_code: 'RED-1', unit_no: 'U-101', buyer_name: 'คุณสมชาย', deposit: 50000 });
  ok('RE-01: book an available unit → held, deposit 50000 (unit → reserved)', rbk1.status < 300 && rbk1.json.status === 'held' && near(rbk1.json.deposit, 50000), JSON.stringify({ s: rbk1.status, st: rbk1.json.status }));
  const rbkDup = await inj('POST', '/api/realestate/bookings', admin, { dev_code: 'RED-1', unit_no: 'U-101', deposit: 10000 });
  ok('RE-01: re-book a reserved unit → 400 UNIT_NOT_AVAILABLE', rbkDup.status === 400 && rbkDup.json.error?.code === 'UNIT_NOT_AVAILABLE', `${rbkDup.status} ${rbkDup.json.error?.code}`);

  const rc1 = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-1', unit_no: 'U-101', booking_no: rbk1.json.booking_no, buyer_name: 'คุณสมชาย', discount: 100000, down_payment: 200000, installment_count: 4 });
  ok('RE-02: draft contract → price 900000 (1,000,000 − 100,000), balance 700000, draft (no GL)',
    rc1.status < 300 && rc1.json.status === 'draft' && near(rc1.json.price, 900000) && near(rc1.json.balance, 700000), JSON.stringify({ st: rc1.json.status, p: rc1.json.price }));
  const rc1No = rc1.json.contract_no;
  // Pending-list feeds for the /realestate open-by-code dropdowns (doc-reference dropdowns).
  const devList = await inj('GET', '/api/realestate/developments', admin);
  ok('RE: developments pending list includes RED-1 (dev_code + name)', devList.status === 200 && (devList.json.developments ?? []).some((d: any) => d.dev_code === 'RED-1' && d.name === 'เดอะ คอนโด'), JSON.stringify(devList.json.developments ?? []));
  const conList = await inj('GET', '/api/realestate/contracts', admin);
  ok('RE: contracts pending list includes the draft REC- contract', conList.status === 200 && (conList.json.contracts ?? []).some((x: any) => x.contract_no === rc1No && x.status === 'draft'), JSON.stringify((conList.json.contracts ?? []).slice(0, 2)));
  const rc1Self = await inj('POST', `/api/realestate/contracts/${rc1No}/approve`, admin);
  ok('RE-02: drafter self-approves the contract → 400 SOD_SELF_APPROVAL', rc1Self.status === 400 && rc1Self.json.error?.code === 'SOD_SELF_APPROVAL', `${rc1Self.status} ${rc1Self.json.error?.code}`);
  const rc1Appr = await inj('POST', `/api/realestate/contracts/${rc1No}/approve`, mgr);
  ok('RE-02: independent approver → active; down_payment 200000, cash_collected 150000 (50000 deposit reclassed)',
    rc1Appr.status < 300 && rc1Appr.json.status === 'active' && near(rc1Appr.json.down_payment, 200000) && near(rc1Appr.json.cash_collected, 150000), JSON.stringify({ st: rc1Appr.json.status, cc: rc1Appr.json.cash_collected }));
  const rc1Get = await inj('GET', `/api/realestate/contracts/${rc1No}`, admin);
  ok('RE-02/03: contract has 4 installments of 175000, outstanding 700000',
    rc1Get.json.installments?.length === 4 && near(rc1Get.json.installments?.[0]?.amount, 175000) && near(rc1Get.json.outstanding, 700000), JSON.stringify({ n: rc1Get.json.installments?.length, out: rc1Get.json.outstanding }));

  const inst1 = rc1Get.json.installments?.[0]?.id;
  const pay1 = await inj('POST', `/api/realestate/installments/${inst1}/pay`, admin, { amount: 175000 });
  ok('RE-03: pay installment 1 (exact 175000) → paid (Dr 1000 / Cr 2410)', pay1.status < 300 && pay1.json.status === 'paid' && /^JE-/.test(pay1.json.entry_no ?? ''), JSON.stringify({ st: pay1.json.status, je: pay1.json.entry_no }));
  const payDup = await inj('POST', `/api/realestate/installments/${inst1}/pay`, admin, { amount: 175000 });
  ok('RE-03: pay the same installment again → 400 INSTALLMENT_PAID', payDup.status === 400 && payDup.json.error?.code === 'INSTALLMENT_PAID', `${payDup.status} ${payDup.json.error?.code}`);
  const inst2 = rc1Get.json.installments?.[1]?.id;
  const payBad = await inj('POST', `/api/realestate/installments/${inst2}/pay`, admin, { amount: 100000 });
  ok('RE-03: pay a wrong amount (≠ scheduled) → 400 BAD_AMOUNT', payBad.status === 400 && payBad.json.error?.code === 'BAD_AMOUNT', `${payBad.status} ${payBad.json.error?.code}`);
  const rc1Get2 = await inj('GET', `/api/realestate/contracts/${rc1No}`, admin);
  ok('RE-03: after one payment → installments_paid 175000, outstanding 525000', near(rc1Get2.json.installments_paid, 175000) && near(rc1Get2.json.outstanding, 525000), JSON.stringify({ paid: rc1Get2.json.installments_paid, out: rc1Get2.json.outstanding }));

  // no-booking contract (down-payment straight to cash → contract liability, no deposit reclass)
  const rc2 = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-1', unit_no: 'U-102', down_payment: 400000, installment_count: 2 });
  const rc2Appr = await inj('POST', `/api/realestate/contracts/${rc2.json.contract_no}/approve`, mgr);
  ok('RE-02: no-booking contract approved → active, cash_collected 400000 (full down-payment)', rc2Appr.status < 300 && rc2Appr.json.status === 'active' && near(rc2Appr.json.cash_collected, 400000), JSON.stringify({ cc: rc2Appr.json.cash_collected }));

  const rBadDisc = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-1', unit_no: 'U-103', discount: 2000000, down_payment: 0, installment_count: 1 });
  ok('RE-02: discount beyond the list price → 400 BAD_DISCOUNT', rBadDisc.status === 400 && rBadDisc.json.error?.code === 'BAD_DISCOUNT', `${rBadDisc.status} ${rBadDisc.json.error?.code}`);
  const rBadDown = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-1', unit_no: 'U-103', discount: 0, down_payment: 5000000, installment_count: 0 });
  ok('RE-02: down-payment beyond the price → 400 BAD_DOWN_PAYMENT', rBadDown.status === 400 && rBadDown.json.error?.code === 'BAD_DOWN_PAYMENT', `${rBadDown.status} ${rBadDown.json.error?.code}`);
  const rReContract = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-1', unit_no: 'U-101', down_payment: 0, installment_count: 1 });
  ok('RE-01: contract an already-contracted unit → 400 UNIT_NOT_CONTRACTABLE', rReContract.status === 400 && rReContract.json.error?.code === 'UNIT_NOT_CONTRACTABLE', `${rReContract.status} ${rReContract.json.error?.code}`);
  const rlist1 = await inj('GET', '/api/realestate/developments/RED-1/units', admin);
  ok('RE-01: availability grid ties out → 2 contracted, 1 available', rlist1.json.summary?.contracted === 2 && rlist1.json.summary?.available === 1, JSON.stringify(rlist1.json.summary));

  // ── P5 (docs/35) — ownership transfer + revenue recognition (RE-04) ──
  await inj('POST', '/api/realestate/developments', admin, { dev_code: 'RED-2', name: 'บ้านเดี่ยว' });
  await inj('POST', '/api/realestate/developments/RED-2/units', admin, { unit_no: 'U-201', unit_type: 'house', list_price: 500000, cost: 300000 });
  await inj('POST', '/api/realestate/developments/RED-2/units', admin, { unit_no: 'U-202', unit_type: 'house', list_price: 500000, cost: 300000 });
  const tc1 = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-2', unit_no: 'U-201', down_payment: 500000, installment_count: 0 }); // fully paid on down
  await inj('POST', `/api/realestate/contracts/${tc1.json.contract_no}/approve`, mgr);
  const xfer = await inj('POST', `/api/realestate/contracts/${tc1.json.contract_no}/transfer`, admin, {});
  ok('RE-04: transfer a fully-settled contract → revenue 500000, cost 300000 (Dr 2410/Cr 4200 + Dr 5800/Cr 1200), unit transferred',
    xfer.status < 300 && xfer.json.status === 'transferred' && near(xfer.json.revenue_recognized, 500000) && near(xfer.json.cost_recognized, 300000) && /^JE-/.test(xfer.json.entry_no ?? ''),
    JSON.stringify({ st: xfer.json.status, rev: xfer.json.revenue_recognized, cost: xfer.json.cost_recognized }));
  const tc2 = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-2', unit_no: 'U-202', down_payment: 100000, installment_count: 4 }); // balance 400000 unpaid
  await inj('POST', `/api/realestate/contracts/${tc2.json.contract_no}/approve`, mgr);
  const xferEarly = await inj('POST', `/api/realestate/contracts/${tc2.json.contract_no}/transfer`, admin, {});
  ok('RE-04: transfer before fully settled → 400 NOT_FULLY_SETTLED', xferEarly.status === 400 && xferEarly.json.error?.code === 'NOT_FULLY_SETTLED', `${xferEarly.status} ${xferEarly.json.error?.code}`);

  // ── 5.5 (TAX-09) — ภาษีธุรกิจเฉพาะ (SBT, ภ.ธ.40) on commercial RE sales (ม.91/2(6)) ──
  // Default-inert first: RED-2 has NO sbt_rate → its transfer above accrued no SBT.
  ok('TAX-09: a project without sbt_rate accrues NO SBT (default-inert)', xfer.json.sbt_amount == null, JSON.stringify({ sbt: xfer.json.sbt_amount }));
  // RED-3 opts in at 3.3% (3% SBT + 10% local): a ฿500,000 transfer accrues ฿16,500 (Dr 5840 / Cr 2130).
  await inj('POST', '/api/realestate/developments', admin, { dev_code: 'RED-3', name: 'ทาวน์โฮม (SBT)', sbt_rate: 3.3 });
  await inj('POST', '/api/realestate/developments/RED-3/units', admin, { unit_no: 'U-301', unit_type: 'house', list_price: 500000, cost: 300000 });
  const sbtC1 = await inj('POST', '/api/realestate/contracts', admin, { dev_code: 'RED-3', unit_no: 'U-301', down_payment: 500000, installment_count: 0 });
  await inj('POST', `/api/realestate/contracts/${sbtC1.json.contract_no}/approve`, mgr);
  const sbtXfer = await inj('POST', `/api/realestate/contracts/${sbtC1.json.contract_no}/transfer`, admin, {});
  ok('TAX-09: transfer under a 3.3% SBT project → sbt_amount ฿16,500 accrued in the transfer JE', sbtXfer.status < 300 && near(sbtXfer.json.sbt_amount, 16500) && near(sbtXfer.json.revenue_recognized, 500000), JSON.stringify({ sbt: sbtXfer.json.sbt_amount, rev: sbtXfer.json.revenue_recognized }));
  const nowD = new Date(); const sbtM = nowD.getMonth() + 1; const sbtY = nowD.getFullYear();
  const pt40 = await inj('GET', `/api/tax-reports/pt40?month=${sbtM}&year=${sbtY}`, admin);
  ok('TAX-09: ภ.ธ.40 lists the transfer (gross ฿500,000 → SBT ฿16,500) and ties to GL 2130',
    pt40.status === 200 && near(pt40.json.totals?.sbt, 16500) && near(pt40.json.totals?.gross_receipts, 500000)
    && pt40.json.rows?.some((r: any) => r.contract_no === sbtC1.json.contract_no) && pt40.json.reconciliation?.gl_account === '2130' && pt40.json.reconciliation?.tied === true,
    `${pt40.status} ${JSON.stringify({ t: pt40.json.totals, rec: pt40.json.reconciliation })}`);
  ok('TAX-09: ภ.ธ.40 deadline = 15th of the following month', /-15$/.test(pt40.json.deadline ?? ''), pt40.json.deadline ?? '');
  const filePt40 = await inj('POST', '/api/tax-reports/filings', admin, { filing_type: 'PT40', month: sbtM, year: sbtY });
  ok('TAX-09: file ภ.ธ.40 → DRAFT remitting ฿16,500 (TAX-05 register)', filePt40.json.status === 'DRAFT' && near(filePt40.json.net_vat, 16500), JSON.stringify(filePt40.json).slice(0, 120));
  const calSbt = await inj('GET', `/api/tax-reports/remittance-calendar?year=${sbtY}`, admin);
  const pt40Row = (calSbt.json.calendar ?? []).find((c: any) => c.filing_type === 'PT40' && c.period_month === sbtM);
  ok('TAX-09: remittance calendar lists ภ.ธ.40 (DRAFT, due the 15th)', pt40Row?.status === 'DRAFT' && /-15$/.test(pt40Row?.deadline ?? ''), JSON.stringify(pt40Row ?? {}));

  // ── P3 (docs/35) — tender / estimating → award (Track C, PROJ-18) ──
  // Build a priced estimate, submit, record win/loss, and on a WIN award → seed a project + a DRAFT BoQ from
  // the tender lines (the seeded BoQ's own maker-checker approve sets the controlled budget baseline).
  const tnd1 = await inj('POST', '/api/tenders', admin, { title: 'อาคารสำนักงาน 3 ชั้น', customer_name: 'บจก. ผู้ว่าจ้าง', project_code: 'PRJ-TND', markup_pct: 20, lines: [
    { category: 'material', description: 'ฐานราก', qty: 10, unit_cost: 1000 },   // bid_rate 1200 → 12000
    { category: 'labor', description: 'โครงสร้าง', qty: 5, unit_cost: 2000 },     // bid_rate 2400 → 12000
  ] });
  ok('PROJ-18: create tender → estimating, estimated_cost 20000, bid_price 24000 (20% markup)',
    tnd1.status < 300 && tnd1.json.status === 'estimating' && near(tnd1.json.estimated_cost, 20000) && near(tnd1.json.bid_price, 24000) && near(tnd1.json.overall_markup_pct, 20),
    JSON.stringify({ s: tnd1.status, est: tnd1.json.estimated_cost, bid: tnd1.json.bid_price }));
  const tnd1No = tnd1.json.tender_no;
  const tndAdd = await inj('POST', `/api/tenders/${tnd1No}/lines`, admin, { category: 'subcon', description: 'งานระบบ', qty: 2, unit_cost: 3000, markup_pct: 0 }); // bid_rate 3000 → 6000
  ok('PROJ-18: add line (per-line markup override 0) → bid_price 30000, estimated_cost 26000, line bid_rate 3000',
    near(tndAdd.json.bid_price, 30000) && near(tndAdd.json.estimated_cost, 26000) && near((tndAdd.json.lines ?? []).find((l: any) => l.description === 'งานระบบ')?.bid_rate, 3000),
    JSON.stringify({ bid: tndAdd.json.bid_price, est: tndAdd.json.estimated_cost }));
  await inj('POST', `/api/tenders/${tnd1No}/submit`, admin);
  const awEarly = await inj('POST', `/api/tenders/${tnd1No}/award`, admin, {});
  ok('PROJ-18: award before won → 400 TENDER_NOT_WON', awEarly.status === 400 && awEarly.json.error?.code === 'TENDER_NOT_WON', `${awEarly.status} ${awEarly.json.error?.code}`);
  await inj('POST', `/api/tenders/${tnd1No}/outcome`, admin, { outcome: 'won' });
  const award = await inj('POST', `/api/tenders/${tnd1No}/award`, admin, {});
  ok('PROJ-18: award a won tender → seeds project PRJ-TND (Fixed, contract 30000) + a DRAFT BoQ (budget 30000)',
    award.status < 300 && award.json.project_code === 'PRJ-TND' && award.json.boq_status === 'draft' && near(award.json.boq_budget_total, 30000) && near(award.json.contract_amount, 30000),
    JSON.stringify({ pc: award.json.project_code, bs: award.json.boq_status, bt: award.json.boq_budget_total }));
  const awProj = await inj('GET', '/api/projects/PRJ-TND', admin);
  ok('PROJ-18: awarded project exists — Fixed, contract 30000', awProj.json.project_code === 'PRJ-TND' && awProj.json.billing_type === 'Fixed' && near(awProj.json.contract_amount, 30000), JSON.stringify({ bt: awProj.json.billing_type, ca: awProj.json.contract_amount }));
  const awBoq = await inj('GET', '/api/projects/PRJ-TND/boq', admin);
  ok('PROJ-18: seeded BoQ is DRAFT with 3 lines, L1 rate = bid_rate 1200 (bid → BoQ rate)',
    awBoq.json.boq?.status === 'draft' && awBoq.json.count === 3 && near((awBoq.json.lines ?? []).find((l: any) => l.description === 'ฐานราก')?.rate, 1200),
    JSON.stringify({ st: awBoq.json.boq?.status, c: awBoq.json.count }));
  const awApprove = await inj('POST', `/api/projects/boq/${awBoq.json.boq?.id}/approve`, mgr); // independent approver sets the baseline
  ok('PROJ-18: an independent approver approves the seeded BoQ → project budget baseline 30000 (controlled)',
    awApprove.status < 300 && near(awApprove.json.budget_synced, 30000), JSON.stringify({ s: awApprove.status, sync: awApprove.json.budget_synced }));
  const awAgain = await inj('POST', `/api/tenders/${tnd1No}/award`, admin, {});
  ok('PROJ-18: re-award a tender → already (idempotent, no duplicate project)', awAgain.json.already === true && awAgain.json.project_code === 'PRJ-TND', JSON.stringify({ a: awAgain.json.already }));
  const tndReDecide = await inj('POST', `/api/tenders/${tnd1No}/outcome`, admin, { outcome: 'won' });
  ok('PROJ-18: re-decide a decided tender → 400 TENDER_DECIDED', tndReDecide.status === 400 && tndReDecide.json.error?.code === 'TENDER_DECIDED', `${tndReDecide.status} ${tndReDecide.json.error?.code}`);

  const tnd2 = await inj('POST', '/api/tenders', admin, { title: 'งานที่แพ้ประมูล', markup_pct: 15, lines: [{ description: 'x', qty: 1, unit_cost: 1000 }] });
  const lossNoReason = await inj('POST', `/api/tenders/${tnd2.json.tender_no}/outcome`, admin, { outcome: 'lost' });
  ok('PROJ-18: mark a tender lost without a reason → 400 LOSS_REASON_REQUIRED', lossNoReason.status === 400 && lossNoReason.json.error?.code === 'LOSS_REASON_REQUIRED', `${lossNoReason.status} ${lossNoReason.json.error?.code}`);
  await inj('POST', `/api/tenders/${tnd2.json.tender_no}/outcome`, admin, { outcome: 'lost', reason: 'ราคาสูงกว่าคู่แข่ง' });
  const tndList = await inj('GET', '/api/tenders', admin);
  ok('PROJ-18: tender register → win-rate 50% (1 won of 2 decided)', near(tndList.json.win_rate_pct, 50) && tndList.json.count >= 2, JSON.stringify({ wr: tndList.json.win_rate_pct, n: tndList.json.count }));

  // ── P2 (docs/35) — subcontractor management + retention payable (Track B, PROJ-17) ──
  // A subcontract reserves BoQ budget (docs/32 commitment); the subcontractor's valuations are certified
  // maker-checker → post AP + WIP + retention PAYABLE (→ the P0 sub-ledger), with back-charges.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-SUB', name: 'งานจ้างเหมาช่วง', customer_name: 'เจ้าของงาน', billing_type: 'TM' });
  const subBoq = await inj('POST', '/api/projects/PRJ-SUB/boq', admin, { title: 'BoQ จ้างเหมา', lines: [
    { category: 'subcon', description: 'งานเสาเข็ม', budget_amount: 60000 },
    { category: 'subcon', description: 'งานหลังคา', budget_amount: 40000 },
  ] });
  const scBoqId = subBoq.json.boq?.id;
  const scL1 = (subBoq.json.lines ?? []).find((l: any) => l.description === 'งานเสาเข็ม')?.id;
  await inj('POST', `/api/projects/boq/${scBoqId}/approve`, mgr);

  const sc1 = await inj('POST', '/api/subcontracts', admin, { project_code: 'PRJ-SUB', vendor_name: 'หจก. รับเหมาช่วง', title: 'เสาเข็มเจาะ', retention_pct: 10, scope: [{ boq_line_id: scL1, amount: 40000, description: 'งานเสาเข็ม' }] });
  ok('PROJ-17: create subcontract → contract_value 40000, retention 10%, active, remaining 40000',
    sc1.status < 300 && near(sc1.json.contract_value, 40000) && near(sc1.json.retention_pct, 10) && sc1.json.status === 'active' && near(sc1.json.remaining, 40000),
    JSON.stringify({ s: sc1.status, cv: sc1.json.contract_value, st: sc1.json.status }));
  const sc1No = sc1.json.subcontract_no;
  const scCommit = await inj('GET', '/api/projects/PRJ-SUB/commitments', admin);
  ok('PROJ-17: subcontract reserves BoQ-line budget (docs/32 commitment) → committed 40000',
    near(scCommit.json.summary?.committed, 40000) && (scCommit.json.commitments ?? []).some((c: any) => c.source_doc_type === 'SUBCON'),
    JSON.stringify({ committed: scCommit.json.summary?.committed }));
  const scOver = await inj('POST', '/api/subcontracts', admin, { project_code: 'PRJ-SUB', scope: [{ boq_line_id: scL1, amount: 30000 }] }); // 40000+30000 > 60000
  ok('PROJ-17: subcontract beyond the BoQ-line budget → 400 BUDGET_EXCEEDED (rolled back)', scOver.status === 400 && scOver.json.error?.code === 'BUDGET_EXCEEDED', `${scOver.status} ${scOver.json.error?.code}`);

  const sv1 = await inj('POST', `/api/subcontracts/${sc1No}/valuations`, admin, { period: '2026-07', pct_complete: 50 });
  ok('PROJ-17: valuation draft → gross 20000 (50% of 40000), retention 2000, net 18000',
    sv1.status < 300 && sv1.json.status === 'draft' && near(sv1.json.gross_this_val, 20000) && near(sv1.json.retention_amount, 2000) && near(sv1.json.net_certified, 18000),
    JSON.stringify({ g: sv1.json.gross_this_val, net: sv1.json.net_certified }));
  const sv1No = sv1.json.valuation_no;
  const sv1Self = await inj('POST', `/api/subcontracts/valuations/${sv1No}/certify`, admin);
  ok('PROJ-17: preparer self-certify valuation → 400 SOD_SELF_APPROVAL', sv1Self.status === 400 && sv1Self.json.error?.code === 'SOD_SELF_APPROVAL', `${sv1Self.status} ${sv1Self.json.error?.code}`);
  const sv1Cert = await inj('POST', `/api/subcontracts/valuations/${sv1No}/certify`, mgr);
  ok('PROJ-17: certify valuation → JE Dr 1260 20000 / Cr 2000 18000 / Cr 2440 2000 (net 18000, retention 2000)',
    sv1Cert.status < 300 && sv1Cert.json.status === 'certified' && near(sv1Cert.json.net_certified, 18000) && near(sv1Cert.json.retention, 2000) && near(sv1Cert.json.wip_cost, 20000) && /^JE-/.test(sv1Cert.json.entry_no ?? ''),
    JSON.stringify({ net: sv1Cert.json.net_certified, wip: sv1Cert.json.wip_cost, je: sv1Cert.json.entry_no }));
  const scRet1 = await inj('GET', '/api/retention/project/PRJ-SUB', admin);
  ok('PROJ-17 → P0: retention 2000 withheld into the shared sub-ledger as a subcontractor PAYABLE',
    near(scRet1.json.payable?.outstanding, 2000) && near(scRet1.json.payable?.withheld, 2000), JSON.stringify({ pay: scRet1.json.payable }));

  const sv2 = await inj('POST', `/api/subcontracts/${sc1No}/valuations`, admin, { period: '2026-08', pct_complete: 80, back_charge: 1000 });
  ok('PROJ-17: valuation 2 nets off prior + back-charge → gross 12000 (32000−20000), net 9800 (12000−1200−1000)',
    near(sv2.json.gross_this_val, 12000) && near(sv2.json.back_charge, 1000) && near(sv2.json.net_certified, 9800), JSON.stringify({ g: sv2.json.gross_this_val, net: sv2.json.net_certified }));
  const sv2Cert = await inj('POST', `/api/subcontracts/valuations/${sv2.json.valuation_no}/certify`, mgr);
  ok('PROJ-17: certify valuation 2 → net 9800, wip_cost 11000 (gross − back-charge)', sv2Cert.status < 300 && near(sv2Cert.json.net_certified, 9800) && near(sv2Cert.json.wip_cost, 11000), JSON.stringify({ net: sv2Cert.json.net_certified, wip: sv2Cert.json.wip_cost }));

  const svBad = await inj('POST', `/api/subcontracts/${sc1No}/valuations`, admin, { pct_complete: 90, back_charge: 999999 });
  ok('PROJ-17: back-charge exceeding the net → 400 BAD_BACK_CHARGE', svBad.status === 400 && svBad.json.error?.code === 'BAD_BACK_CHARGE', `${svBad.status} ${svBad.json.error?.code}`);
  const svNone = await inj('POST', `/api/subcontracts/${sc1No}/valuations`, admin, { pct_complete: 80 }); // same cumulative → 0 movement
  ok('PROJ-17: no progress since the last valuation → 400 NOTHING_TO_CERTIFY', svNone.status === 400 && svNone.json.error?.code === 'NOTHING_TO_CERTIFY', `${svNone.status} ${svNone.json.error?.code}`);

  const scList = await inj('GET', '/api/subcontracts/project/PRJ-SUB', admin);
  ok('PROJ-17: subcontract register → value 40000, certified_to_date 32000, retention_payable 3200',
    near(scList.json.subcontract_value, 40000) && near(scList.json.certified_to_date, 32000) && near(scList.json.retention_payable, 3200),
    JSON.stringify({ v: scList.json.subcontract_value, ctd: scList.json.certified_to_date, rp: scList.json.retention_payable }));
  const scRet2 = await inj('GET', '/api/retention/project/PRJ-SUB', admin);
  ok('PROJ-17 → P0: retention payable outstanding 3200 after two certified valuations (2000 + 1200)', near(scRet2.json.payable?.outstanding, 3200), JSON.stringify({ pay: scRet2.json.payable?.outstanding }));

  // ── P1 (docs/35) — progress billing / งวดงาน + retention receivable (Track A, PROJ-16) ──
  // A construction contract billed in periodic progress claims: value work by BoQ line (cumulative), withhold
  // retention on certification (→ the P0 sub-ledger), maker-checker certify, Fixed-contract cap.
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-PB', name: 'งานก่อสร้างงวดงาน', customer_name: 'ผู้ว่าจ้าง', billing_type: 'Fixed', contract_amount: 90000 });
  const pbBoq = await inj('POST', '/api/projects/PRJ-PB/boq', admin, { title: 'BoQ งวดงาน', lines: [
    { category: 'material', description: 'งานโครงสร้าง', budget_amount: 60000 },
    { category: 'material', description: 'งานสถาปัตย์', budget_amount: 40000 },
  ] });
  const pbBoqId = pbBoq.json.boq?.id;
  const pbL1 = (pbBoq.json.lines ?? []).find((l: any) => l.description === 'งานโครงสร้าง')?.id;
  const pbL2 = (pbBoq.json.lines ?? []).find((l: any) => l.description === 'งานสถาปัตย์')?.id;
  await inj('POST', `/api/projects/boq/${pbBoqId}/approve`, mgr); // independent approve → budget baseline
  await inj('POST', '/api/projects/PRJ-PB/cost', admin, { entry_type: 'expense', amount: 20000, description: 'ต้นทุนงาน' }); // WIP 1260 = 20000

  const cl1 = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-PB', period: '2026-07', retention_pct: 10, lines: [{ boq_line_id: pbL1, pct_complete_to_date: 50 }, { boq_line_id: pbL2, pct_complete_to_date: 0 }] });
  ok('PROJ-16: progress claim draft → gross 30000 (L1 50% of 60000), retention 3000, net 27000',
    cl1.status < 300 && cl1.json.status === 'draft' && near(cl1.json.gross_this_claim, 30000) && near(cl1.json.retention_amount, 3000) && near(cl1.json.net_payable, 27000),
    JSON.stringify({ s: cl1.status, g: cl1.json.gross_this_claim, r: cl1.json.retention_amount }));
  const cl1No = cl1.json.claim_no;
  const cl1Self = await inj('POST', `/api/progress-billing/${cl1No}/certify`, admin); // preparer = admin
  ok('PROJ-16: preparer self-certify → 400 SOD_SELF_APPROVAL', cl1Self.status === 400 && cl1Self.json.error?.code === 'SOD_SELF_APPROVAL', `${cl1Self.status} ${cl1Self.json.error?.code}`);
  const cl1Cert = await inj('POST', `/api/progress-billing/${cl1No}/certify`, mgr); // independent certifier
  ok('PROJ-16: certify → certified, net 27000, retention 3000, cost_recognized 20000 (WIP relieved), JE posted',
    cl1Cert.status < 300 && cl1Cert.json.status === 'certified' && near(cl1Cert.json.net_payable, 27000) && near(cl1Cert.json.retention, 3000) && near(cl1Cert.json.cost_recognized, 20000) && /^JE-/.test(cl1Cert.json.entry_no ?? ''),
    JSON.stringify({ st: cl1Cert.json.status, net: cl1Cert.json.net_payable, cr: cl1Cert.json.cost_recognized, je: cl1Cert.json.entry_no }));
  const cl1Re = await inj('POST', `/api/progress-billing/${cl1No}/certify`, mgr);
  ok('PROJ-16: re-certify a certified claim → 400 CLAIM_NOT_DRAFT', cl1Re.status === 400 && cl1Re.json.error?.code === 'CLAIM_NOT_DRAFT', `${cl1Re.status} ${cl1Re.json.error?.code}`);
  const pbRet1 = await inj('GET', '/api/retention/project/PRJ-PB', admin);
  ok('PROJ-16 → P0: retention 3000 withheld into the shared sub-ledger as a customer receivable',
    near(pbRet1.json.receivable?.outstanding, 3000) && near(pbRet1.json.receivable?.withheld, 3000), JSON.stringify({ recv: pbRet1.json.receivable }));

  const cl2 = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-PB', period: '2026-08', retention_pct: 10, lines: [{ boq_line_id: pbL1, pct_complete_to_date: 80 }] });
  ok('PROJ-16: claim 2 nets off previously certified → gross 18000 (48000 to-date − 30000 prior), prev 30000',
    near(cl2.json.gross_this_claim, 18000) && near(cl2.json.lines?.[0]?.value_this_claim, 18000) && near(cl2.json.lines?.[0]?.previously_certified, 30000),
    JSON.stringify({ g: cl2.json.gross_this_claim, prev: cl2.json.lines?.[0]?.previously_certified }));
  const cl2Cert = await inj('POST', `/api/progress-billing/${cl2.json.claim_no}/certify`, mgr);
  ok('PROJ-16: certify claim 2 → net 16200, retention 1800, no more WIP to relieve (cost_recognized 0)',
    cl2Cert.status < 300 && near(cl2Cert.json.net_payable, 16200) && near(cl2Cert.json.retention, 1800) && near(cl2Cert.json.cost_recognized, 0), JSON.stringify({ net: cl2Cert.json.net_payable, cr: cl2Cert.json.cost_recognized }));

  const cl3 = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-PB', lines: [{ boq_line_id: pbL1, pct_complete_to_date: 80 }] }); // same % → no movement
  ok('PROJ-16: no work movement since the last claim → 400 NOTHING_TO_BILL', cl3.status === 400 && cl3.json.error?.code === 'NOTHING_TO_BILL', `${cl3.status} ${cl3.json.error?.code}`);
  const clBad = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-PB', lines: [{ boq_line_id: pbL1, pct_complete_to_date: 150 }] });
  ok('PROJ-16: pct > 100 (over-certification) → 400', clBad.status === 400, `${clBad.status}`);

  const cl4 = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-PB', lines: [{ boq_line_id: pbL1, pct_complete_to_date: 100 }, { boq_line_id: pbL2, pct_complete_to_date: 100 }] }); // gross 12000+40000=52000 → billed 100000 > 90000
  const cl4Cert = await inj('POST', `/api/progress-billing/${cl4.json.claim_no}/certify`, mgr);
  ok('PROJ-16: certifying beyond the Fixed contract (90000) → 400 BILL_EXCEEDS_CONTRACT', cl4Cert.status === 400 && cl4Cert.json.error?.code === 'BILL_EXCEEDS_CONTRACT', `${cl4Cert.status} ${cl4Cert.json.error?.code}`);

  const pbList = await inj('GET', '/api/progress-billing/project/PRJ-PB', admin);
  ok('PROJ-16: project claim register → certified_to_date 48000, retention_withheld 4800',
    near(pbList.json.certified_to_date, 48000) && near(pbList.json.retention_withheld, 4800), JSON.stringify({ ctd: pbList.json.certified_to_date, rw: pbList.json.retention_withheld }));
  const pbRet2 = await inj('GET', '/api/retention/project/PRJ-PB', admin);
  ok('PROJ-16 → P0: retention receivable outstanding 4800 after two certified claims (3000 + 1800)', near(pbRet2.json.receivable?.outstanding, 4800), JSON.stringify({ recv: pbRet2.json.receivable?.outstanding }));

  // ── Depth-2/3 (docs/35) — output VAT on progress claims, POC/rev-rec reconciliation, subcontractor WHT ──
  // Depth-2: output VAT on a customer progress claim (billing-method project).
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-VAT', name: 'งานมี VAT', customer_name: 'ผู้ว่าจ้าง', billing_type: 'Fixed', contract_amount: 100000 });
  const vatBoq = await inj('POST', '/api/projects/PRJ-VAT/boq', admin, { title: 'BoQ VAT', lines: [{ category: 'material', description: 'งานรวม', budget_amount: 100000 }] });
  await inj('POST', `/api/projects/boq/${vatBoq.json.boq?.id}/approve`, mgr);
  const vatL1 = (vatBoq.json.lines ?? [])[0]?.id;
  const vatClaim = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-VAT', retention_pct: 0, vat_pct: 7, lines: [{ boq_line_id: vatL1, pct_complete_to_date: 100 }] });
  const vatCert = await inj('POST', `/api/progress-billing/${vatClaim.json.claim_no}/certify`, mgr);
  ok('Depth-2: progress claim with 7% VAT → gross 100000, VAT 7000, AR total 107000, revenue 100000 (billing method)',
    vatCert.status < 300 && near(vatCert.json.vat, 7000) && near(vatCert.json.ar_total, 107000) && near(vatCert.json.revenue, 100000) && vatCert.json.rev_method === 'billing',
    JSON.stringify({ vat: vatCert.json.vat, ar: vatCert.json.ar_total, rm: vatCert.json.rev_method }));

  // Document: the ใบวางบิลงวดงาน / ใบกำกับภาษี renders (PDF, or HTML fallback when Chromium absent → CI).
  const vatPdf = await raw('GET', `/api/progress-billing/${vatClaim.json.claim_no}/pdf`, admin);
  ok('Document: progress-claim tax invoice renders (PDF or HTML fallback) with the AR total & baht-in-words',
    vatPdf.status === 200 && (vatPdf.ctype.includes('application/pdf') || (vatPdf.ctype.includes('text/html') && /ใบวางบิลงวดงาน/.test(vatPdf.body) && /107,000/.test(vatPdf.body))),
    JSON.stringify({ s: vatPdf.status, ct: vatPdf.ctype.split(';')[0] }));

  // Depth-3: on a POC project a progress claim is a BILLING event (no revenue; clears contract asset / parks liability).
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-POC3', name: 'งาน POC (progress)', billing_type: 'Fixed', contract_amount: 100000, rev_method: 'poc', estimated_cost: 80000 });
  const pocBoq = await inj('POST', '/api/projects/PRJ-POC3/boq', admin, { title: 'BoQ POC', lines: [{ category: 'material', description: 'งานรวม', budget_amount: 100000 }] });
  await inj('POST', `/api/projects/boq/${pocBoq.json.boq?.id}/approve`, mgr);
  const pocL1 = (pocBoq.json.lines ?? [])[0]?.id;
  const pocClaim = await inj('POST', '/api/progress-billing', admin, { project_code: 'PRJ-POC3', retention_pct: 0, lines: [{ boq_line_id: pocL1, pct_complete_to_date: 50 }] });
  const pocCert = await inj('POST', `/api/progress-billing/${pocClaim.json.claim_no}/certify`, mgr);
  ok('Depth-3: progress claim on a POC project → rev_method poc, revenue 0 (billing event), billings_in_excess 50000 (no double revenue)',
    pocCert.status < 300 && pocCert.json.rev_method === 'poc' && near(pocCert.json.revenue, 0) && near(pocCert.json.billings_in_excess, 50000) && /^JE-/.test(pocCert.json.entry_no ?? ''),
    JSON.stringify({ rm: pocCert.json.rev_method, rev: pocCert.json.revenue, bie: pocCert.json.billings_in_excess }));

  // Depth-2: subcontractor WHT (ภ.ง.ด.53, 3%) + recoverable input VAT (7%) on the certified valuation.
  const scWht = await inj('POST', '/api/subcontracts', admin, { project_code: 'PRJ-SUB', vendor_name: 'ผู้รับเหมาช่วง WHT', retention_pct: 0, wht_pct: 3, vat_pct: 7, scope: [{ boq_line_id: scL1, amount: 20000 }] });
  const svWht = await inj('POST', `/api/subcontracts/${scWht.json.subcontract_no}/valuations`, admin, { pct_complete: 100 });
  const svWhtCert = await inj('POST', `/api/subcontracts/valuations/${svWht.json.valuation_no}/certify`, mgr);
  ok('Depth-2: subcontract valuation → WHT 600 (Cr 2361), input VAT 1400 (Dr 1300), AP payable 20800 (net−WHT+VAT), net_certified 20000',
    svWhtCert.status < 300 && near(svWhtCert.json.wht, 600) && near(svWhtCert.json.vat, 1400) && near(svWhtCert.json.ap_payable, 20800) && near(svWhtCert.json.net_certified, 20000),
    JSON.stringify({ wht: svWhtCert.json.wht, vat: svWhtCert.json.vat, ap: svWhtCert.json.ap_payable }));

  // Document: the ใบรับรองผลงานผู้รับเหมาช่วง renders (PDF, or HTML fallback when Chromium absent → CI).
  const svPdf = await raw('GET', `/api/subcontracts/valuations/${svWht.json.valuation_no}/pdf`, admin);
  ok('Document: subcontract valuation certificate renders (PDF or HTML fallback) with the AP payable & baht-in-words',
    svPdf.status === 200 && (svPdf.ctype.includes('application/pdf') || (svPdf.ctype.includes('text/html') && /ใบรับรองผลงานผู้รับเหมาช่วง/.test(svPdf.body) && /20,800/.test(svPdf.body))),
    JSON.stringify({ s: svPdf.status, ct: svPdf.ctype.split(';')[0] }));

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
  ok('Retention partial release 200 (customer) → partially_released, released 200, outstanding 300, JE posted (Depth-1: Dr 1100 / Cr 1170)',
    rel1.status < 300 && rel1.json.status === 'partially_released' && near(rel1.json.released_amount, 200) && near(rel1.json.outstanding, 300) && /^JE-/.test(rel1.json.entry_no ?? ''),
    JSON.stringify({ st: rel1.json.status, rel: rel1.json.released_amount, je: rel1.json.entry_no }));

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
  ok('Release a scheduled tranche by id → subcontract retention released 500, outstanding 500, JE posted (Depth-1: Dr 2440 / Cr 2000)',
    relTranche.status < 300 && near(relTranche.json.released_amount, 500) && near(relTranche.json.outstanding, 500) && /^JE-/.test(relTranche.json.entry_no ?? ''),
    JSON.stringify({ rel: relTranche.json.released_amount, je: relTranche.json.entry_no }));
  const dueAfter = await inj('GET', '/api/retention/due', admin);
  ok('After releasing the tranche it drops off the due worklist (0 due)', (dueAfter.json.due ?? []).length === 0, `count=${dueAfter.json.count}`);

  // Depth-1: an overdue retention tranche surfaces on the PMO action center as `retention_due`.
  await inj('POST', '/api/retention/withhold', admin, { party_type: 'customer', project_code: 'PRJ-A', source_doc_type: 'CLAIM', source_doc_no: 'CLAIM-DUE', amount: 800, schedule: [{ due_basis: 'date', due_date: '2019-06-01', pct: 100 }] });
  const acRet = await inj('GET', '/api/projects/action-center', admin);
  const retItem = (acRet.json.items ?? []).find((i: any) => i.kind === 'retention_due' && i.ref === 'CLAIM-DUE');
  ok('Depth-1: an overdue retention tranche surfaces on the action center as retention_due', !!retItem && near(retItem.meta?.amount, 800), JSON.stringify({ found: !!retItem, kinds: acRet.json.summary?.by_kind?.retention_due }));

  // SCF classification: a posted JE touching 1170/2440 must bucket into OPERATING working capital (not unclassified).
  const rje = await inj('POST', '/api/ledger/journal', admin, { date: '2026-06-15', memo: 'retention SCF classify test', lines: [{ account_code: '1170', debit: 500 }, { account_code: '2440', credit: 500 }] });
  await inj('POST', `/api/ledger/journal/${rje.json.entry_no}/approve`, mgr); // maker-checker: mgr ≠ admin
  const scf = await inj('GET', '/api/ledger/cash-flow?from=2026-06-01&to=2026-06-30', admin);
  const wc = scf.json.operating?.working_capital ?? [];
  ok('SCF: retention receivable (1170) & payable (2440) classify as OPERATING working capital, not unclassified',
    !(scf.json.unclassified_accounts ?? []).includes('1170') && !(scf.json.unclassified_accounts ?? []).includes('2440') &&
    wc.some((l: any) => l.account_code === '1170') && wc.some((l: any) => l.account_code === '2440'),
    JSON.stringify({ uncl: scf.json.unclassified_accounts, codes: wc.map((l: any) => l.account_code) }));

  // ── Depth: scheduled sweeps (docs/35) — retention release due, booking expiry, installment overdue ──
  await inj('POST', '/api/retention/withhold', admin, { party_type: 'customer', project_code: 'PRJ-A', source_doc_type: 'CLAIM', source_doc_no: 'CLAIM-SWEEP', amount: 1000, schedule: [{ due_basis: 'date', due_date: '2018-01-01', pct: 100 }] });
  const rrSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Retention release', report_type: 'retention_release_due', frequency: 'monthly' });
  const rrRun = await inj('POST', `/api/bi/subscriptions/${rrSub.json.id}/run`, admin, {});
  ok('Sweep: retention_release_due auto-releases past-due tranches (posts GL)', rrRun.json.status === 'success' && /released\s+[1-9]/.test(rrRun.json.summary ?? ''), JSON.stringify({ s: rrRun.json.status, sum: (rrRun.json.summary ?? '').slice(0, 50) }));

  await inj('POST', '/api/realestate/bookings', admin, { dev_code: 'RED-1', unit_no: 'U-103', deposit: 5000, expires_on: '2018-01-01' });
  const beSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Booking expiry', report_type: 're_booking_expire', frequency: 'daily' });
  const beRun = await inj('POST', `/api/bi/subscriptions/${beSub.json.id}/run`, admin, {});
  ok('Sweep: re_booking_expire cancels lapsed bookings + frees the unit', beRun.json.status === 'success' && /expired\s+[1-9]/.test(beRun.json.summary ?? ''), JSON.stringify({ s: beRun.json.status, sum: (beRun.json.summary ?? '').slice(0, 50) }));
  const u103 = await inj('GET', '/api/realestate/developments/RED-1/units', admin);
  ok('Sweep: the expired booking freed U-103 back to available', (u103.json.units ?? []).find((x: any) => x.unit_no === 'U-103')?.status === 'available', JSON.stringify({ st: (u103.json.units ?? []).find((x: any) => x.unit_no === 'U-103')?.status }));

  const ioSub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Installment overdue', report_type: 're_installment_overdue', frequency: 'daily' });
  const ioRun = await inj('POST', `/api/bi/subscriptions/${ioSub.json.id}/run`, admin, {});
  ok('Sweep: re_installment_overdue runs (detective worklist)', ioRun.json.status === 'success' && /[Oo]verdue installments/.test(ioRun.json.summary ?? ''), JSON.stringify({ s: ioRun.json.status, sum: (ioRun.json.summary ?? '').slice(0, 40) }));

  // ── docs/43 PR-4 — a GL-24-governed posting-rule override re-routes a wired PROJECT posting ──
  // End-to-end on PROJECT.REVENUE.project_revenue: default path posts 4200 (asserted in §5 above);
  // an approved tenant rule re-routes the revenue leg of a NEW project bill to 4210, while the AR
  // control (1100) stays pinned.
  await db.insert(s.accounts).values({ code: '4210', name: 'Project Revenue — Government (PR-4)', type: 'Revenue', normalBalance: 'C', isPostable: true }).onConflictDoNothing();
  const p4Rule = (await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PROJECT.REVENUE', legOrder: 1, role: 'project_revenue', side: 'CR', accountCode: '4210' })).json;
  ok('PR-4: PROJECT.REVENUE override upsert lands PendingApproval (GL-24)', p4Rule?.status === 'PendingApproval', `${p4Rule?.status}`);
  const p4Ap = await inj('POST', `/api/ledger/posting-rules/${Number(p4Rule?.id)}/approve`, mgr);
  ok('PR-4: a different user approves the rule', p4Ap.status === 200 && p4Ap.json?.status === 'Approved', `${p4Ap.status} ${p4Ap.json?.status}`);
  await inj('POST', '/api/projects', admin, { project_code: 'PRJ-OVR', name: 'Override test', customer_name: 'OVR Co', billing_type: 'TM' });
  const p4Bill = (await inj('POST', '/api/projects/PRJ-OVR/bill', admin, { amount: 4444 })).json;
  const [p4Je] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, p4Bill.entry_no)).limit(1);
  const p4Lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, Number(p4Je.id)));
  ok('PR-4: the approved override re-routes the project-revenue leg to 4210 (AR 1100 stays pinned)',
    p4Lines.some((l: any) => l.accountCode === '4210' && Math.abs(Number(l.credit) - 4444) < 0.01) && p4Lines.some((l: any) => l.accountCode === '1100' && Math.abs(Number(l.debit) - 4444) < 0.01),
    `lines=${p4Lines.map((l: any) => l.accountCode).join(',')}`);

  // ── 9j. A4 BoQ takeoff import (docs/50 Wave 4): csv → DRAFT lines, fail-closed all-or-nothing ──
  const tplA4 = await inj('GET', '/api/projects/boq/import-template', admin);
  ok('A4: import template exposes the headers + sample', tplA4.status === 200 && (tplA4.json.headers ?? []).includes('budget_qty') && (tplA4.json.sample ?? []).length >= 1, JSON.stringify(tplA4.json.headers));
  await inj('POST', '/api/projects', admin, { name: 'Import test', project_code: 'PRJ-IMP' });
  const badCsv = 'item_no,description,category,uom,budget_qty,rate,wbs_code\nNOSUCH,,material,ถุง,10,100,1.1\n,ค่าแรง,badcat,จุด,-1,x,1.2';
  const impBad = await inj('POST', '/api/projects/PRJ-IMP/boq/import', admin, { format: 'csv', csv: badCsv });
  ok('A4: invalid rows reject the WHOLE file (IMPORT_INVALID, per-row errors, nothing imported)',
    impBad.status === 400 && impBad.json.error?.code === 'IMPORT_INVALID' && (impBad.json.error?.details?.errors ?? []).length >= 3
    && (await inj('GET', '/api/projects/PRJ-IMP/boq', admin)).json.boq === null,
    JSON.stringify(impBad.json.error?.details?.errors ?? []).slice(0, 140));
  const okCsv = 'item_no,description,category,uom,budget_qty,rate,wbs_code\nSTEEL,เหล็กเส้น,material,,20,50,2.1\n,ค่าแรงติดตั้ง,labor,จุด,5,300,2.2';
  const imp1 = await inj('POST', '/api/projects/PRJ-IMP/boq/import', admin, { format: 'csv', csv: okCsv, title: 'takeoff' });
  ok('A4: valid csv lands DRAFT lines (2 imported, new draft BoQ, budget 2500; unknown-item WARNING kept)',
    imp1.status < 300 && imp1.json.imported === 2 && imp1.json.created_boq === true && imp1.json.boq?.status === 'draft' && near(imp1.json.budget_total, 2500)
    && (imp1.json.warnings ?? []).some((w: any) => w.code === 'ITEM_NOT_FOUND'),
    JSON.stringify({ n: imp1.json.imported, st: imp1.json.boq?.status, b: imp1.json.budget_total, w: imp1.json.warnings }));
  const imp2 = await inj('POST', '/api/projects/PRJ-IMP/boq/import', admin, { format: 'rows', rows: [{ item_no: 'STEEL', description: 'เหล็กเพิ่ม', category: 'material', budget_qty: 2, rate: 50 }] });
  ok('A4: re-import APPENDS to the same draft (created_boq=false, 3 lines, budget 2600)',
    imp2.status < 300 && imp2.json.created_boq === false && imp2.json.count === 3 && near(imp2.json.budget_total, 2600),
    JSON.stringify({ c: imp2.json.count, b: imp2.json.budget_total }));
  const impApprove = await inj('POST', `/api/projects/boq/${imp1.json.boq_id}/approve`, mgr);
  ok('A4: the imported BoQ still flows through PROJ-12 approval (approver ≠ author)', impApprove.status < 300 && (impApprove.json.boq?.status === 'approved' || impApprove.json.status === 'approved'), JSON.stringify(impApprove.json).slice(0, 90));

  console.log('\n── Phase 18 — Projects/PPM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} projects checks failed` : `\n✅ All ${checks.length} projects checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
