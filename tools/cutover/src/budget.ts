/**
 * Accounting Tier 3 — Budget vs Actual (งบประมาณเทียบจริง) over PGlite:
 * monthly/annual budgets (annual split into 12), variance vs GL actuals, favorable/unfavorable, cost-center scope.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover budget
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'budget-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // GL-05 maker-checker approver
    { username: 'plan1', passwordHash: await pw.hash('pw1'), role: 'Planner', tenantId: t1 },
    { username: 'plan2', passwordHash: await pw.hash('pw2'), role: 'Planner', tenantId: t2 },
  ]).onConflictDoNothing();
  // Planner role is now SoD-clean; plan1/plan2 keep the old bundled perms via per-user override
  // so this harness (budget posting, variance) continues to pass without modification.
  for (const un of ['plan1', 'plan2']) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(
      ['dashboard', 'exec', 'warehouse', 'procurement', 'planner', 'masterdata', 'approvals'].map((perm) => ({ userId: uid, perm })),
    ).onConflictDoNothing();
  }

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, plan1, plan2] = [await login('admin', 'admin123'), await login('plan1', 'pw1'), await login('plan2', 'pw2')];
  const approver = await login('approver', 'admin123');
  // GL-05 maker-checker: a manual JE posts as Draft; a DIFFERENT user must approve it to affect balances.
  const postJE = async (preparer: string, payload: any) => {
    const r = await inj('POST', '/api/ledger/journal', preparer, payload);
    if (r.json?.entry_no && r.json?.pending) await inj('POST', `/api/ledger/journal/${r.json.entry_no}/approve`, preparer === approver ? admin : approver, {});
    return r;
  };
  const J = (date: string, lines: any[]) => postJE(admin, { date, source: 'Manual', lines });
  const row = (rep: any, code: string) => (rep.json.rows ?? []).find((r: any) => r.account_code === code);
  // BUD-01 maker-checker: a budget upsert is PendingApproval; a DIFFERENT user must approve it before it counts
  // in budget-vs-actual. setBudget upserts (admin) then approves (approver) so the variance assertions see it.
  const setBudget = async (payload: any) => {
    const r = await inj('POST', '/api/ledger/budgets', admin, payload);
    await inj('POST', '/api/ledger/budgets/approve', approver, { fiscal_year: payload.fiscal_year, account_code: payload.account_code, cost_center_code: payload.cost_center_code, period: payload.mode === 'monthly' ? payload.period : undefined });
    return r;
  };

  // ── BUD-01 maker-checker: a budget is PendingApproval (excluded from B/A) until a DIFFERENT user approves ──
  const bmReq = await inj('POST', '/api/ledger/budgets', admin, { fiscal_year: 2030, account_code: '5105', mode: 'monthly', period: '2030-01', amount: 300 });
  ok('BUD-01: budget upsert lands as PendingApproval', bmReq.json.status === 'PendingApproval', JSON.stringify(bmReq.json));
  const repPend = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2030&period=2030-01', admin);
  ok('BUD-01: a PendingApproval budget is EXCLUDED from budget-vs-actual', !row(repPend, '5105'), JSON.stringify(row(repPend, '5105')));
  const budSelf = await inj('POST', '/api/ledger/budgets/approve', admin, { fiscal_year: 2030, account_code: '5105', period: '2030-01' });
  ok('BUD-01: preparer self-approval blocked → 403 SOD_VIOLATION (binds even Admin)', budSelf.status === 403 && budSelf.json.error?.code === 'SOD_VIOLATION', `${budSelf.status} ${budSelf.json.error?.code}`);
  const budAppr = await inj('POST', '/api/ledger/budgets/approve', approver, { fiscal_year: 2030, account_code: '5105', period: '2030-01' });
  ok('BUD-01: independent approver approves the budget → Approved', budAppr.status === 200 && budAppr.json.status === 'Approved', JSON.stringify(budAppr.json));
  const repAppr = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2030&period=2030-01', admin);
  ok('BUD-01: approved budget now appears in budget-vs-actual (5105 budget 300)', near(row(repAppr, '5105')?.budget, 300), JSON.stringify(row(repAppr, '5105')));

  // ── Phase 1: monthly budgets + actuals (tenant-wide, untagged) ──
  const bm = await setBudget({ fiscal_year: 2030, account_code: '5100', mode: 'monthly', period: '2030-01', amount: 1000 });
  ok('Budget monthly upsert (5100 = 1000 for 2030-01)', bm.json.lines === 1 && near(bm.json.total, 1000), JSON.stringify(bm.json));
  await setBudget({ fiscal_year: 2030, account_code: '4000', mode: 'monthly', period: '2030-01', amount: 2000 });
  await J('2030-01-10', [{ account_code: '5100', debit: 1200 }, { account_code: '1000', credit: 1200 }]); // actual OpEx 1200
  await J('2030-01-11', [{ account_code: '1000', debit: 1500 }, { account_code: '4000', credit: 1500 }]); // actual Sales 1500

  const rep = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2030&period=2030-01', admin);
  const r5100 = row(rep, '5100'), r4000 = row(rep, '4000');
  ok('B/A: expense 5100 budget 1000 / actual 1200 / variance 200 Unfavorable', near(r5100?.budget, 1000) && near(r5100?.actual, 1200) && near(r5100?.variance, 200) && r5100?.status === 'Unfavorable', JSON.stringify(r5100));
  ok('B/A: revenue 4000 budget 2000 / actual 1500 / under budget Unfavorable', near(r4000?.budget, 2000) && near(r4000?.actual, 1500) && r4000?.status === 'Unfavorable', JSON.stringify(r4000));
  ok('B/A rollup: net (rev-exp) budget 1000 / actual 300 / Unfavorable', near(rep.json.rollup?.net?.budget, 1000) && near(rep.json.rollup?.net?.actual, 300) && rep.json.rollup?.net?.favorable === false, JSON.stringify(rep.json.rollup?.net));

  // ── Phase 2: annual budget splits into 12 months ──
  const ann = await setBudget({ fiscal_year: 2030, account_code: '5200', mode: 'annual', amount: 1200 });
  ok('Budget annual upsert splits into 12 months (total 1200)', ann.json.lines === 12 && near(ann.json.total, 1200), JSON.stringify(ann.json));
  const list = await inj('GET', '/api/ledger/budgets?fiscal_year=2030&account_code=5200', admin);
  ok('Budget list: 12 monthly lines of 100, sum 1200', list.json.count === 12 && near(list.json.total, 1200) && (list.json.budgets ?? []).every((b: any) => near(b.amount, 100)), `count=${list.json.count} total=${list.json.total}`);
  const repYtd = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2030', admin); // full-year YTD
  ok('B/A full-year: 5200 annual budget 1200 (no actual → variance -1200 favorable)', near(row(repYtd, '5200')?.budget, 1200), JSON.stringify(row(repYtd, '5200')));

  // ── Phase 3: cost-center-scoped budget + actual ──
  await setBudget({ fiscal_year: 2030, account_code: '5100', cost_center_code: 'CC-X', mode: 'monthly', period: '2030-01', amount: 500 });
  await J('2030-01-12', [{ account_code: '5100', debit: 600, cost_center: 'CC-X' }, { account_code: '1000', credit: 600, cost_center: 'CC-X' }]);
  const repCc = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2030&period=2030-01&cost_center=CC-X', admin);
  ok('B/A cost_center=CC-X: 5100 budget 500 / actual 600 (scoped, excludes tenant-wide)', near(row(repCc, '5100')?.budget, 500) && near(row(repCc, '5100')?.actual, 600), JSON.stringify(row(repCc, '5100')));

  // ── upsert overwrites (not duplicates) + delete ──
  await inj('POST', '/api/ledger/budgets', admin, { fiscal_year: 2030, account_code: '5100', mode: 'monthly', period: '2030-01', amount: 1100 }); // overwrite 1000→1100
  const l5100 = await inj('GET', '/api/ledger/budgets?fiscal_year=2030&account_code=5100', admin);
  const tw = (l5100.json.budgets ?? []).filter((b: any) => b.period === '2030-01' && b.cost_center_code == null);
  ok('Budget upsert overwrites (tenant-wide 5100/2030-01 = single row 1100, not duplicated)', tw.length === 1 && near(tw[0].amount, 1100), JSON.stringify(tw));
  const del = await inj('DELETE', '/api/ledger/budgets?fiscal_year=2030&account_code=4000&period=2030-01', admin);
  ok('Budget delete', del.json.deleted >= 1, JSON.stringify(del.json));

  // ── RLS: budgets tenant-scoped ──
  await inj('POST', '/api/ledger/budgets', plan1, { fiscal_year: 2031, account_code: '5100', mode: 'monthly', period: '2031-01', amount: 111 });
  await inj('POST', '/api/ledger/budgets', plan2, { fiscal_year: 2031, account_code: '5100', mode: 'monthly', period: '2031-01', amount: 222 });
  const l1 = await inj('GET', '/api/ledger/budgets?fiscal_year=2031', plan1);
  ok('RLS: T1 sees only its 2031 budget (111, not 222)', l1.json.count === 1 && near(l1.json.budgets?.[0]?.amount, 111), JSON.stringify(l1.json.budgets));

  // ── ELC-06: budget-variance management review — materiality flag + recorded sign-off ──
  await setBudget({ fiscal_year: 2032, account_code: '5100', mode: 'monthly', period: '2032-06', amount: 5000 });
  await J('2032-06-10', [{ account_code: '5100', debit: 7000 }, { account_code: '1000', credit: 7000 }]); // actual 7000 vs budget 5000 → +2000 (40%)
  const elc = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2032&period=2032-06', admin);
  const elc5100 = row(elc, '5100');
  ok('ELC-06: a material unfavourable variance is flagged (material + requires_review); review summary counts it',
    elc5100?.material === true && elc5100?.requires_review === true && elc.json.review?.material_count >= 1 && elc.json.review?.requires_review_count >= 1 && elc.json.review?.last_signoff === null,
    JSON.stringify({ m: elc5100?.material, rr: elc5100?.requires_review, mc: elc.json.review?.material_count, ls: elc.json.review?.last_signoff }));
  const soNoNotes = await inj('POST', '/api/ledger/budget-review/sign-off', admin, { fiscal_year: 2032, period: '2032-06' });
  ok('ELC-06: sign-off requires a review note (400)', soNoNotes.status === 400, `${soNoNotes.status} ${soNoNotes.json?.error?.code}`);
  const so = await inj('POST', '/api/ledger/budget-review/sign-off', admin, { fiscal_year: 2032, period: '2032-06', notes: 'สอบทานแล้ว 5100 เกินงบ 40% — ติดตามกับฝ่ายผลิต' });
  ok('ELC-06: management sign-off records the review (material_count captured, reviewer set)',
    so.status === 200 && so.json.material_count >= 1 && so.json.reviewed_by === 'admin' && near(so.json.unfavorable_total, 2000),
    JSON.stringify({ mc: so.json.material_count, by: so.json.reviewed_by, uf: so.json.unfavorable_total }));
  const elc2 = await inj('GET', '/api/ledger/budget-vs-actual?fiscal_year=2032&period=2032-06', admin);
  ok('ELC-06: the report now shows the latest sign-off (review evidence on the period)',
    elc2.json.review?.last_signoff?.reviewed_by === 'admin' && elc2.json.review?.last_signoff?.material_count >= 1,
    JSON.stringify(elc2.json.review?.last_signoff));
  const revList = await inj('GET', '/api/ledger/budget-reviews?fiscal_year=2032', admin);
  ok('ELC-06: review history lists the sign-off', revList.json.count >= 1 && (revList.json.reviews ?? []).some((r: any) => r.reviewed_by === 'admin'), JSON.stringify({ n: revList.json.count }));

  // ── BUD-02 (FIN-3): budgetary control / encumbrance gate on PR/PO approval ─────────────────────────────
  // The gate keys on the CURRENT business month (Asia/Bangkok) — compute it the same way the API does.
  const period = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date()).slice(0, 7);
  const fy = Number(period.slice(0, 4));
  await db.insert(s.vendors).values({ name: 'BC Vendor' }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'BC-ITEM', itemDescription: 'Budget-gated item', uom: 'ea', unitPrice: '100', cogsAccount: '5100' }).onConflictDoNothing();
  // buyer = procurement duty WITHOUT exec — can approve POs but must NOT be able to override the block.
  await db.insert(s.users).values([{ username: 'buyer', passwordHash: await pw.hash('pw3'), role: 'Planner', tenantId: hq }]).onConflictDoNothing();
  const buyerId = Number((await db.select().from(s.users).where(eq(s.users.username, 'buyer')))[0].id);
  await db.insert(s.userPermissions).values(['procurement', 'pr_raise', 'dashboard'].map((perm) => ({ userId: buyerId, perm }))).onConflictDoNothing();
  const buyer = await login('buyer', 'pw3');
  const mkPo = async (qty: number) => (await inj('POST', '/api/procurement/pos', admin, { vendor_name: 'BC Vendor', items: [{ item_id: 'BC-ITEM', order_qty: qty, unit_price: 100 }] })).json.po_no as string;
  const apPo = (poNo: string, who: string, extra: any = {}) => inj('PATCH', `/api/procurement/pos/${poNo}/approve`, who, { approve: true, ...extra });

  const ctl0 = await inj('GET', '/api/budget/control-settings', admin);
  ok('BUD-02: budget-control policy defaults to OFF (report-only — pre-FIN-3 behaviour)', ctl0.json.policy === 'off', JSON.stringify(ctl0.json));
  const poOff = await mkPo(2);
  const apOff = await apPo(poOff, admin);
  ok('BUD-02: with policy OFF the approve response is unchanged (no budget annotation, no commitment)', apOff.status === 200 && apOff.json.status === 'Approved' && apOff.json.budget === undefined, JSON.stringify(apOff.json));

  const ctlDenied = await inj('PUT', '/api/budget/control-settings', buyer, { policy: 'advise' });
  ok('BUD-02: policy change is restricted (procurement-only user → 403, mirrors EXP-04 change control)', ctlDenied.status === 403, `${ctlDenied.status}`);
  const ctl1 = await inj('PUT', '/api/budget/control-settings', admin, { policy: 'advise' });
  ok('BUD-02: exec sets policy=advise', ctl1.json.policy === 'advise' && ctl1.json.updated_by === 'admin', JSON.stringify(ctl1.json));
  await setBudget({ fiscal_year: fy, account_code: '5100', mode: 'monthly', period, amount: 1000 });

  const poA = await mkPo(3); // 300 vs budget 1000 → within
  const apA = await apPo(poA, admin);
  ok('BUD-02 advise: within budget → Approved with the availability annotation', apA.json.status === 'Approved' && apA.json.budget?.policy === 'advise' && apA.json.budget?.exceeded === false, JSON.stringify(apA.json.budget));
  const avA = await inj('GET', `/api/budget/availability?account=5100&period=${period}`, admin);
  ok('BUD-02: the approval ENCUMBERS the budget (open commitment 300 → available 700)', near(avA.json.open_commitments, 300) && near(avA.json.available, 700), JSON.stringify(avA.json));

  const poB = await mkPo(8); // 800 > available 700
  const apB = await apPo(poB, admin);
  ok('BUD-02 advise: an over-budget approval still passes but is FLAGGED exceeded', apB.json.status === 'Approved' && apB.json.budget?.exceeded === true, JSON.stringify(apB.json.budget));

  await inj('PUT', '/api/budget/control-settings', admin, { policy: 'warn' });
  const poC = await mkPo(1); // available is now negative → exceeded
  const apC1 = await apPo(poC, admin);
  ok('BUD-02 warn: over budget without confirmation → 422 BUDGET_CONFIRM_REQUIRED', apC1.status === 422 && apC1.json.error?.code === 'BUDGET_CONFIRM_REQUIRED', `${apC1.status} ${apC1.json.error?.code}`);
  const apC2 = await apPo(poC, admin, { confirm_over_budget: true });
  ok('BUD-02 warn: the approver CONFIRMS the overage → Approved', apC2.json.status === 'Approved' && apC2.json.budget?.exceeded === true, JSON.stringify(apC2.json.budget));

  await inj('PUT', '/api/budget/control-settings', admin, { policy: 'block' });
  const poD = await mkPo(1);
  const apD1 = await apPo(poD, admin);
  ok('BUD-02 block: over budget → 422 BUDGET_EXCEEDED', apD1.status === 422 && apD1.json.error?.code === 'BUDGET_EXCEEDED', `${apD1.status} ${apD1.json.error?.code}`);
  const apD2 = await apPo(poD, buyer, { override_budget: true, override_reason: 'need it' });
  ok('BUD-02 block: override by a NON-exec approver → 403 BUDGET_OVERRIDE_DENIED (distinct duty)', apD2.status === 403 && apD2.json.error?.code === 'BUDGET_OVERRIDE_DENIED', `${apD2.status} ${apD2.json.error?.code}`);
  const apD3 = await apPo(poD, admin, { override_budget: true });
  ok('BUD-02 block: exec override without a reason → 400 BUDGET_OVERRIDE_REASON_REQUIRED', apD3.status === 400 && apD3.json.error?.code === 'BUDGET_OVERRIDE_REASON_REQUIRED', `${apD3.status} ${apD3.json.error?.code}`);
  const apD4 = await apPo(poD, admin, { override_budget: true, override_reason: 'ด่วน — เครื่องเสียหน้างาน' });
  ok('BUD-02 block: exec override WITH a reason → Approved (overridden flagged)', apD4.json.status === 'Approved' && apD4.json.budget?.overridden === true, JSON.stringify(apD4.json.budget));
  const audD = await inj('GET', `/api/budget/commitments?doc_no=${poD}`, admin);
  const audRow = (audD.json.commitments ?? [])[0];
  ok('BUD-02: the override is AUDITED on the commitment (over_budget + override_by + reason)', audRow?.over_budget === true && audRow?.override_by === 'admin' && String(audRow?.override_reason ?? '').includes('ด่วน'), JSON.stringify(audRow));

  const avBefore = await inj('GET', `/api/budget/availability?account=5100&period=${period}`, admin);
  const rcv = await inj('POST', `/api/procurement/pos/${poA}/receive-all`, admin);
  const avAfter = await inj('GET', `/api/budget/availability?account=5100&period=${period}`, admin);
  ok('BUD-02: a FULLY RECEIVED PO\'s commitment is consumed (drops out of open commitments)', rcv.status === 201 || rcv.status === 200 ? near(avAfter.json.open_commitments, Number(avBefore.json.open_commitments) - 300) : false, `rcv=${rcv.status} before=${avBefore.json.open_commitments} after=${avAfter.json.open_commitments}`);

  // PR path: the requester ASKS freely (createPr is ungated); the gate binds at approval, priced from the
  // item master; the approved PR's estimate stays encumbered until it converts to POs.
  const prR = await inj('POST', '/api/procurement/prs', buyer, { items: [{ item_id: 'BC-ITEM', request_qty: 5 }] });
  ok('BUD-02: raising a PR is never blocked by the gate (asking ≠ authorising)', prR.status === 201 || prR.status === 200, `${prR.status}`);
  const prNo = prR.json.pr_no as string;
  const apPr1 = await inj('PATCH', `/api/procurement/prs/${prNo}/approve`, admin, { approve: true });
  ok('BUD-02 block: PR approval over budget → 422 BUDGET_EXCEEDED (estimate = qty × item-master price)', apPr1.status === 422 && apPr1.json.error?.code === 'BUDGET_EXCEEDED', `${apPr1.status} ${apPr1.json.error?.code}`);
  const apPr2 = await inj('PATCH', `/api/procurement/prs/${prNo}/approve`, admin, { approve: true, override_budget: true, override_reason: 'อนุมัติเกินงบตามมติผู้บริหาร' });
  const avPr = await inj('GET', `/api/budget/availability?account=5100&period=${period}`, admin);
  ok('BUD-02: an approved PR encumbers its ESTIMATE (open commitments +500)', apPr2.json.status === 'Approved' && near(avPr.json.open_commitments, Number(avAfter.json.open_commitments) + 500), `${apPr2.json.status} open=${avPr.json.open_commitments}`);
  const conv = await inj('POST', `/api/procurement/prs/${prNo}/to-po`, admin, { vendor_name: 'BC Vendor', lines: [{ item_id: 'BC-ITEM', order_qty: 5, unit_price: 100 }] });
  const avConv = await inj('GET', `/api/budget/availability?account=5100&period=${period}`, admin);
  ok('BUD-02: converting the PR to a PO RELEASES the PR commitment (the PO carries it from ITS approval)', (conv.status === 200 || conv.status === 201) && near(avConv.json.open_commitments, Number(avPr.json.open_commitments) - 500), `conv=${conv.status} open=${avConv.json.open_commitments}`);

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — Budget vs Actual (งบประมาณเทียบจริง) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} budget checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} budget checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
