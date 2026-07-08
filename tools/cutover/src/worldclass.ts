/**
 * Phase 9 world-class foundations validation — real Nest app over PGlite (RLS-enforced),
 * tests all 7 moves: RLS isolation, General Ledger, payments/tender, currency/tax,
 * self-serve billing, public-API/MFA, audit + edge.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover worldclass
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wc-secret';
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
import { registerEdge } from '../../../apps/api/dist/common/edge';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { BillingService } from '../../../apps/api/dist/modules/billing/billing.service';
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

  // seed (as superuser — bypasses RLS)
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'Shop One' }, { code: 'T2', name: 'Shop Two' }]).onConflictDoNothing();
  const tid = async (code: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, code)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr', passwordHash: await pw.hash('mgr123'), role: 'Admin', tenantId: hq }, // FA-09: a different approver for asset disposal
    { username: 'cust1', passwordHash: await pw.hash('pw1'), role: 'Customer', tenantId: t1 },
    { username: 'cust2', passwordHash: await pw.hash('pw2'), role: 'Customer', tenantId: t2 },
    { username: 'sales1', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t1 }, // non-Admin staff bound to shop T1
    { username: 'posT2', passwordHash: await pw.hash('pw4'), role: 'PosSupervisor', tenantId: t2 }, // T2 till operator (pos_till) — SoD sub-perm split moved till ops off cust_pos
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1.0' }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '50' }).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'A', itemDescription: 'Apple (T1)', uom: 'EA', currentStock: '100', reorderPoint: '5', reorderQty: '20' },
    { tenantId: t2, itemId: 'B', itemDescription: 'Banana (T2)', uom: 'EA', currentStock: '50', reorderPoint: '5', reorderQty: '10' },
  ]);

  // ── RLS at the DATABASE level (definitive) ──
  await pg.exec(`BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id','${t1}',true); SELECT set_config('app.bypass_rls','off',true);`);
  const scoped = (await pg.query(`SELECT item_id FROM customer_inventory`)).rows as any[];
  await pg.exec('ROLLBACK');
  ok('RLS(db): tenant T1 sees only its rows (no WHERE)', scoped.length === 1 && scoped[0].item_id === 'A', JSON.stringify(scoped.map((r) => r.item_id)));
  await pg.exec(`BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.bypass_rls','on',true);`);
  const all = (await pg.query(`SELECT item_id FROM customer_inventory`)).rows as any[];
  await pg.exec('ROLLBACK');
  ok('RLS(db): staff bypass sees all tenants', all.length === 2);
  // 0003: the `tenants` table itself is now RLS-protected (was leaking every shop's credit/tax data)
  await pg.exec(`BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id','${t1}',true); SELECT set_config('app.bypass_rls','off',true);`);
  const tRows = (await pg.query(`SELECT code FROM tenants`)).rows as any[];
  await pg.exec('ROLLBACK');
  ok('RLS(db): tenants table scoped to own row only (0003)', tRows.length === 1 && tRows[0].code === 'T1', JSON.stringify(tRows.map((r) => r.code)));

  // ── boot app ──
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await registerEdge(app); // helmet + rate-limit
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  // startup seeds (main.ts does this in prod)
  await app.get(LedgerService).seedChartOfAccounts();
  await app.get(BillingService).seedPlans();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, headers: res.headers };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const mgr = await login('mgr', 'mgr123');
  const c1 = await login('cust1', 'pw1');
  const c2 = await login('cust2', 'pw2');
  const sales1 = await login('sales1', 'pw3');
  const posT2 = await login('posT2', 'pw4');

  // ── RLS at the API level (cross-tenant isolation through the full stack) ──
  const inv1 = await inj('GET', '/api/portal/inventory', c1);
  const inv2 = await inj('GET', '/api/portal/inventory', c2);
  ok('RLS(api): cust1 sees only T1 inventory', inv1.json.items?.length === 1 && inv1.json.items[0].item_id === 'A', JSON.stringify(inv1.json.items?.map((i: any) => i.item_id)));
  ok('RLS(api): cust2 sees only T2 inventory', inv2.json.items?.length === 1 && inv2.json.items[0].item_id === 'B');

  // ── General Ledger (move #2) ──
  ok('GL: chart of accounts seeded (>=9)', (await inj('GET', '/api/ledger/accounts', admin)).json.accounts?.length >= 9 || (await inj('GET', '/api/ledger/accounts', admin)).json.length >= 9, '');
  const balanced = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', memo: 't', lines: [{ account_code: '1000', debit: 500 }, { account_code: '4000', credit: 500 }] });
  ok('GL: balanced journal posts (JE-)', (balanced.status === 200 || balanced.status === 201) && /^JE-/.test(balanced.json.entry_no ?? ''), `status=${balanced.status} ${JSON.stringify(balanced.json).slice(0, 80)}`);
  const unbal = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', lines: [{ account_code: '1000', debit: 100 }, { account_code: '4000', credit: 90 }] });
  ok('GL: unbalanced journal rejected (400)', unbal.status === 400, `status=${unbal.status}`);
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const tbTotals = tb.json.totals ?? tb.json;
  ok('GL: trial balance debits == credits', near(tbTotals.debit ?? tbTotals.total_debit ?? tbTotals.totalDebit, tbTotals.credit ?? tbTotals.total_credit ?? tbTotals.totalCredit), JSON.stringify(tbTotals).slice(0, 100));

  // ── Accounting Tier 1: period control + year-end close (Phase 12) ──
  const curMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7); // business-TZ month
  ok('GL: COA includes 3100 Retained Earnings', JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json).includes('3100'));
  await inj('POST', `/api/ledger/periods/${curMonth}/close`, admin, {});
  const blockedJE = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', lines: [{ account_code: '1000', debit: 50 }, { account_code: '4000', credit: 50 }] });
  ok('Period close → posting into closed period rejected (PERIOD_CLOSED)', blockedJE.status === 400 && blockedJE.json.error?.code === 'PERIOD_CLOSED', `${blockedJE.status} ${blockedJE.json.error?.code}`);
  await inj('POST', `/api/ledger/periods/${curMonth}/open`, admin, {}); // re-open so later sale/JE postings work
  const reopenJE = await inj('POST', '/api/ledger/journal', admin, { source: 'Manual', lines: [{ account_code: '1000', debit: 50 }, { account_code: '4000', credit: 50 }] });
  ok('Period re-open → posting works again', reopenJE.status === 201 || reopenJE.status === 200, `${reopenJE.status}`);
  // year-end close on a prior year (2025), isolated from current activity. A manual JE posts as Draft
  // (GL-05 maker-checker) and must be APPROVED by a different user before it hits the books — so post it
  // tenant-scoped (T1) and approve as sales1 (gl_close via exec; ≠ the admin preparer) before closing.
  const fy25je = await inj('POST', '/api/ledger/journal', admin, { date: '2025-03-15', source: 'Manual', tenant_id: t1, memo: 'FY2025', lines: [{ account_code: '1000', debit: 1000 }, { account_code: '4000', credit: 1000 }] });
  const fy25approve = await inj('POST', `/api/ledger/journal/${fy25je.json.entry_no}/approve`, sales1, {});
  ok('Year-end: manual FY2025 JE posts Draft then approved by a different user (GL-05)', fy25je.json.status === 'Draft' && fy25approve.status === 200 && fy25approve.json.status === 'Posted', `draft=${fy25je.json.status} approve=${fy25approve.status}/${fy25approve.json.status}`);
  const cy = await inj('POST', `/api/ledger/close-year?fiscal_year=2025&tenant_id=${t1}`, admin, {});
  ok('Year-end close FY2025 → P&L moved to 3100 (net 1000)', near(cy.json.net_income, 1000) && /^JE-/.test(cy.json.entry_no ?? ''), `${cy.status} ${JSON.stringify(cy.json).slice(0, 70)}`);
  const is2025 = await inj('GET', '/api/ledger/income-statement?from=2025-01-01&to=2025-12-31', admin);
  ok('Year-end: FY2025 P&L zeroed after close (net≈0)', near(is2025.json.net_income, 0), `net=${is2025.json.net_income}`);
  const bs2025 = await inj('GET', '/api/ledger/balance-sheet?as_of=2025-12-31', admin);
  ok('Year-end: balance sheet balanced + retained earnings 1000', bs2025.json.balanced === true && near(bs2025.json.retained_earnings, 1000), `bal=${bs2025.json.balanced} re=${bs2025.json.retained_earnings}`);
  // Balance sheet exposes per-account section lines (Asset/Liability/Equity + signed balance) for the
  // detailed /financial-statements screen — 3100 Retained Earnings must appear in equity after the close.
  ok('Year-end: balance sheet exposes per-account section lines (incl. 3100 RE)',
    Array.isArray(bs2025.json.lines)
      && bs2025.json.lines.length > 0
      && bs2025.json.lines.every((l: any) => ['Asset', 'Liability', 'Equity'].includes(l.account_type) && typeof l.balance === 'number')
      && bs2025.json.lines.some((l: any) => l.account_code === '3100' && near(l.balance, 1000)),
    `lines=${bs2025.json.lines?.length}`);
  const cy2 = await inj('POST', `/api/ledger/close-year?fiscal_year=2025&tenant_id=${t1}`, admin, {});
  ok('Year-end close idempotent (2nd run no-op)', cy2.json.already === true, JSON.stringify(cy2.json).slice(0, 40));
  ok('Finance: sub-ledger ↔ GL reconciliation endpoint', (await inj('GET', '/api/finance/reconciliation', admin)).json.ar?.reconciled === true);

  // ── Accounting Tier 2: Fixed Assets + Depreciation (FI-AA, Phase 13) ──
  // Use 2027 (open, isolated from the closed FY2025 + curMonth churn above).
  const leg = (j: any, code: string, side: 'debit' | 'credit') => (j?.lines ?? []).filter((l: any) => l.account_code === code).reduce((a: number, l: any) => a + Number(l[side]), 0);
  const acc2 = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('FA: COA includes 1500/1590/5200/1510', ['1500', '1590', '5200', '1510'].every((c) => acc2.includes(c)));
  const acq = await inj('POST', '/api/assets', admin, { name: 'Laptop', acquire_date: '2027-01-05', acquire_cost: 12000, salvage_value: 0, useful_life_months: 12, acquire_source: 'cash' });
  ok('FA: acquisition posts FA- + JE-', /^FA-/.test(acq.json.asset_no ?? '') && /^JE-/.test(acq.json.journal_no ?? ''), JSON.stringify(acq.json).slice(0, 90));
  const jAcq = (await inj('GET', '/api/ledger/journal?limit=8', admin)).json.entries.find((e: any) => e.source === 'ASSET' && e.source_ref === acq.json.asset_no);
  ok('FA: acquisition Dr1500 / Cr1000 = 12000', near(leg(jAcq, '1500', 'debit'), 12000) && near(leg(jAcq, '1000', 'credit'), 12000));
  const run = await inj('POST', '/api/assets/depreciation/run', admin, { period: '2027-01' });
  ok('FA: depreciation run posts DEP- + total 1000', /^DEP-/.test(run.json.run_no ?? '') && near(run.json.total_depreciation, 1000), JSON.stringify(run.json).slice(0, 90));
  const jDep = (await inj('GET', '/api/ledger/journal?limit=8', admin)).json.entries.find((e: any) => e.source === 'DEP');
  ok('FA: run Dr5200 / Cr1590 = 1000', near(leg(jDep, '5200', 'debit'), 1000) && near(leg(jDep, '1590', 'credit'), 1000));
  const reg = (await inj('GET', '/api/assets', admin)).json;
  ok('FA: asset nbv decreased to 11000 after 1 month', near(reg.assets.find((a: any) => a.asset_no === acq.json.asset_no)?.net_book_value, 11000), JSON.stringify(reg.assets?.[0]).slice(0, 80));
  const run2 = await inj('POST', '/api/assets/depreciation/run', admin, { period: '2027-01' });
  ok('FA: depreciation run idempotent per period', run2.json.already === true || near(run2.json.total_depreciation, 0), JSON.stringify(run2.json).slice(0, 60));
  // FA-09 maker-checker: dispose request → Draft + pending; a different user approves → effective.
  const disp = await inj('PATCH', `/api/assets/${acq.json.asset_no}/dispose`, admin, { disposal_date: '2027-02-10', proceeds: 11500 });
  ok('FA: disposal request computes gain 500, pending approval', near(disp.json.gain_loss, 500) && disp.json.status === 'pending_disposal', JSON.stringify(disp.json).slice(0, 90));
  const dispAppr = await inj('POST', `/api/assets/${acq.json.asset_no}/dispose/approve`, mgr);
  ok('FA: disposal approved by a different user → disposed', dispAppr.json.status === 'disposed' && dispAppr.json.approved_by === 'mgr', JSON.stringify(dispAppr.json).slice(0, 90));
  const jDis = (await inj('GET', '/api/ledger/journal?limit=8', admin)).json.entries.find((e: any) => e.source === 'DISP');
  ok('FA: disposal Dr1590 1000 + Cr1500 12000 + Cr1510 gain 500', near(leg(jDis, '1590', 'debit'), 1000) && near(leg(jDis, '1500', 'credit'), 12000) && near(leg(jDis, '1510', 'credit'), 500));
  const tbZ = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('FA: trial balance balanced after acq+dep+disposal', near(tbZ.debit ?? tbZ.total_debit, tbZ.credit ?? tbZ.total_credit), JSON.stringify(tbZ).slice(0, 80));

  // ── FA per-tenant depreciation split (adversarial-verify fix #3): runDepreciation must post ONE GL
  //    entry PER owning tenant (keyed `${tenant}:${period}`), so each shop's trial balance ties — not one
  //    consolidated entry co-mingling every tenant's assets under the caller's id. Seed assets in T1 + T2
  //    (acquire_date in a fresh, open period), depreciate, assert the GL splits per tenant. ──
  const seedAsset = (tenantId: number, no: string, cost: number) =>
    db.insert(s.fixedAssets).values({ tenantId, assetNo: no, name: no, acquireDate: '2028-01-03', acquireCost: String(cost), salvageValue: '0', usefulLifeMonths: 12, status: 'active', accumulatedDepreciation: '0', netBookValue: String(cost), acquireSource: 'cash', createdBy: 'seed' });
  await seedAsset(t1, 'FA-T1-DEP', 12000); // 1000/mo
  await seedAsset(t2, 'FA-T2-DEP', 6000);  //  500/mo
  const runMt = await inj('POST', '/api/assets/depreciation/run', admin, { period: '2028-01' });
  ok('FA(multi-tenant): depreciation splits into 2 per-tenant runs (T1 1000 + T2 500 = 1500)', Array.isArray(runMt.json.runs) && runMt.json.runs.length === 2 && near(runMt.json.total_depreciation, 1500), JSON.stringify(runMt.json).slice(0, 150));
  const depEntries = (await pg.query(`SELECT je.tenant_id, je.source_ref, (SELECT coalesce(sum(jl.debit),0) FROM journal_lines jl WHERE jl.entry_id=je.id AND jl.account_code='5200') AS dep FROM journal_entries je WHERE je.source='DEP' AND je.period='2028-01'`)).rows as any[];
  const depOf = (tid: number) => depEntries.find((e) => Number(e.tenant_id) === tid);
  ok('FA(multi-tenant): T1 GL entry tagged tenant T1, Dr5200=1000, source_ref t1:2028-01', !!depOf(t1) && near(depOf(t1).dep, 1000) && depOf(t1).source_ref === `${t1}:2028-01`, JSON.stringify(depEntries));
  ok('FA(multi-tenant): T2 GL entry tagged tenant T2, Dr5200=500, source_ref t2:2028-01', !!depOf(t2) && near(depOf(t2).dep, 500) && depOf(t2).source_ref === `${t2}:2028-01`, JSON.stringify(depEntries));
  ok('FA(multi-tenant): no consolidated/co-mingled entry — exactly 2 DEP entries for the period', depEntries.length === 2, `n=${depEntries.length}`);
  const runMt2 = await inj('POST', '/api/assets/depreciation/run', admin, { period: '2028-01' });
  ok('FA(multi-tenant): re-run idempotent per tenant+period (no new postings)', runMt2.json.already === true || near(runMt2.json.total_depreciation, 0), JSON.stringify(runMt2.json).slice(0, 80));

  // ── Tenancy model: "HQ sees all, staff bound to shop" (Phase 9.2 bypass allowlist) ──
  await inj('POST', '/api/ledger/journal', admin, { source: 'TEST', source_ref: 'SCOPE-T1', tenant_id: t1, lines: [{ account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 }] });
  await inj('POST', '/api/ledger/journal', admin, { source: 'TEST', source_ref: 'SCOPE-T2', tenant_id: t2, lines: [{ account_code: '1000', debit: 20 }, { account_code: '4000', credit: 20 }] });
  const refsOf = (j: any) => ((j.json.entries ?? []) as any[]).map((e) => e.source_ref);
  const salesJ = refsOf(await inj('GET', '/api/ledger/journal?limit=100', sales1));
  const adminJ = refsOf(await inj('GET', '/api/ledger/journal?limit=100', admin));
  ok('RLS(api): non-Admin staff (Sales) scoped to own shop T1', salesJ.includes('SCOPE-T1') && !salesJ.includes('SCOPE-T2'), JSON.stringify(salesJ));
  ok('RLS(api): Admin (HQ) bypasses — sees all shops', adminJ.includes('SCOPE-T1') && adminJ.includes('SCOPE-T2'));

  // ── Payments (move #3) ──
  const pay = await inj('POST', '/api/payments', admin, { sale_no: 'TEST-1', method: 'Cash', amount: 100, currency: 'THB' });
  ok('Payments: tender captured (PAY-)', (pay.status === 200 || pay.status === 201) && /^PAY-/.test(pay.json.payment_no ?? '') && pay.json.status === 'Captured', `${JSON.stringify(pay.json).slice(0, 90)}`);
  const refund = await inj('POST', '/api/payments/refunds', admin, { payment_no: pay.json.payment_no, amount: 100, reason: 'test' });
  ok('Payments: refund (REF-)', (refund.status === 200 || refund.status === 201) && /^REF-/.test(refund.json.refund_no ?? ''), `${refund.status}`);
  // over-refund guard (Phase 9.2): 60 + 50 > 100 must be rejected; 60 + 40 = 100 allowed
  const pay2 = await inj('POST', '/api/payments', admin, { sale_no: 'TEST-2', method: 'Cash', amount: 100, currency: 'THB' });
  await inj('POST', '/api/payments/refunds', admin, { payment_no: pay2.json.payment_no, amount: 60, reason: 'partial' });
  const over = await inj('POST', '/api/payments/refunds', admin, { payment_no: pay2.json.payment_no, amount: 50, reason: 'over' });
  ok('Payments: over-refund rejected (60+50 > 100)', over.status === 400, `status=${over.status} ${JSON.stringify(over.json?.error?.code ?? over.json).slice(0, 50)}`);
  const rest = await inj('POST', '/api/payments/refunds', admin, { payment_no: pay2.json.payment_no, amount: 40, reason: 'rest' });
  ok('Payments: remaining partial refund allowed (60+40=100, fully)', (rest.status === 200 || rest.status === 201) && rest.json.fully_refunded === true, `${rest.status}`);
  // Till reconciliation (move #5): POS cash links to the open till; a full refund nets to 0 variance
  // (proves cash-IN includes 'Refunded' so the refund-OUT doesn't double-count). Uses cust2/item B so
  // its SALE-T2-<ts> number can't collide with cust1's sale in the same second.
  // Till ops require pos_till (SoD sub-perm split — no longer covered by cust_pos): a T2 staff member
  // (posT2) opens/closes the till; the customer-portal sale (c2) still links its cash to that open till.
  const tillOpen = await inj('POST', '/api/payments/till/open', posT2, { opening_float: 100 });
  const tillSale = await inj('POST', '/api/portal/pos/sales', c2, { items: [{ item_id: 'B', qty: 1, unit_price: 50 }] }); // total 53.5 cash
  await inj('POST', '/api/payments/refunds', admin, { payment_no: tillSale.json.payment_no, amount: tillSale.json.total, reason: 'till-test' });
  const tillClose = await inj('POST', '/api/payments/till/close', posT2, { session_no: tillOpen.json.session_no, closing_count: 100 });
  ok('Till: POS cash linked + full refund nets to 0 variance', near(tillClose.json.variance, 0) && near(tillClose.json.expected_cash, 100), `var=${tillClose.json.variance} exp=${tillClose.json.expected_cash}`);
  // Async tender settlement: PromptPay returns Pending, then /settle → Captured (no dead-end).
  const pp = await inj('POST', '/api/payments', admin, { sale_no: 'PP-1', method: 'QR', amount: 50, currency: 'THB', gateway: 'promptpay' });
  const settled = await inj('PATCH', `/api/payments/${pp.json.payment_no}/settle`, admin, {});
  ok('Payments: PromptPay Pending → settle → Captured', pp.json.status === 'Pending' && settled.json.status === 'Captured', `pp=${pp.json.status} settled=${settled.json.status}`);

  // ── Currency + Tax (move #5) ──
  const tax = await inj('GET', '/api/tax/calc?net=100&country=TH', admin);
  ok('Tax: TH VAT on 100 = 7', near(tax.json.tax, 7), JSON.stringify(tax.json).slice(0, 90));
  const cur = await inj('GET', '/api/tax/currencies', admin);
  ok('Tax: currencies include THB + USD', JSON.stringify(cur.json).includes('THB') && JSON.stringify(cur.json).includes('USD'));
  // currency-aware rounding: JPY has 0 minor units → 105×7% = 7.35 must round to 7 (not 7.35)
  const jpy = await inj('GET', '/api/tax/calc?net=105&country=TH&currency=JPY', admin);
  ok('Tax: JPY 0-decimal rounding (105×7% → 7, not 7.35)', jpy.json.tax === 7, JSON.stringify(jpy.json).slice(0, 80));

  // ── Portal POS now wires payment + GL (moves #2,#3,#5 in the live flow) ──
  const sale = await inj('POST', '/api/portal/pos/sales', c1, { items: [{ item_id: 'A', qty: 2, unit_price: 50 }] });
  ok('Portal POS sale wires payment_no(PAY-) + journal_no(JE-)', /^PAY-/.test(sale.json.payment_no ?? '') && /^JE-/.test(sale.json.journal_no ?? ''), `${JSON.stringify(sale.json).slice(0, 120)}`);
  ok('Portal POS sale VAT via TaxService (107)', near(sale.json.total, 107) && near(sale.json.vat, 7));

  // ── Self-serve billing/signup (move #6) ──
  const signup = await inj('POST', '/api/auth/signup', undefined, { company_name: 'New Co', tenant_code: 'NEWCO', admin_username: 'newadmin', admin_password: 'secret12', email: 'a@b.com' });
  ok('Billing: public signup provisions tenant', (signup.status === 200 || signup.status === 201) && (signup.json.tenant_code === 'NEWCO' || signup.json.tenant?.code === 'NEWCO'), `${signup.status} ${JSON.stringify(signup.json).slice(0, 90)}`);
  const newLogin = await inj('POST', '/api/login', undefined, { username: 'newadmin', password: 'secret12' });
  ok('Billing: provisioned admin can log in', newLogin.status === 200 && !!newLogin.json.token);
  ok('Billing: plans listed (public)', Array.isArray((await inj('GET', '/api/billing/plans')).json.plans ?? (await inj('GET', '/api/billing/plans')).json), '');
  // duplicate tenant_code must be a clean 409 (was a 500 stack-trace on raced unique-violation)
  const dup = await inj('POST', '/api/auth/signup', undefined, { company_name: 'Dup Co', tenant_code: 'NEWCO', admin_username: 'dupadmin', admin_password: 'secret12', email: 'd@e.com' });
  ok('Billing: duplicate tenant_code signup → 409 (not 500)', dup.status === 409, `status=${dup.status}`);

  // ── Public API platform + MFA (move #7) ──
  const key = await inj('POST', '/api/platform/api-keys', admin, { name: 'ci', scopes: ['read'] });
  ok('Platform: API key issued (ierp_)', (key.status === 200 || key.status === 201) && /^ierp_/.test(key.json.key ?? ''), `${key.status}`);
  // the issued key must actually AUTHENTICATE a request (was dead code before 9.3) → Bearer ierp_...
  // H-2 (security review): the key principal now ADOPTS its minter's identity for maker-checker/SoD, so
  // /api/auth/me reports the minting human ('admin' here), not the old `apikey:<prefix>` machine string.
  const meViaKey = await inj('GET', '/api/auth/me', key.json.key);
  ok('Platform: API key authenticates a request (Bearer ierp_), bound to its minter (H-2)', meViaKey.status === 200 && meViaKey.json?.username === 'admin', `status=${meViaKey.status} ${JSON.stringify(meViaKey.json).slice(0, 70)}`);
  const mfa = await inj('POST', '/api/platform/mfa/setup', admin, {});
  ok('Platform: MFA setup returns secret', (mfa.status === 200 || mfa.status === 201) && !!(mfa.json.secret ?? mfa.json.otpauth_url), `${mfa.status}`);

  // ── Audit + edge (move #4) ──
  const auditRows = (await pg.query(`SELECT count(*)::int c FROM audit_log`)).rows as any[];
  ok('Audit: mutations recorded in audit_log', Number(auditRows[0].c) > 0, `rows=${auditRows[0].c}`);
  // tenant_id is now the numeric user.tenantId (was always NULL via customerName parse)
  const auditT1 = (await pg.query(`SELECT count(*)::int c FROM audit_log WHERE tenant_id = ${t1}`)).rows as any[];
  ok('Audit: tenant_id populated for scoped mutations (T1)', Number(auditT1[0].c) > 0, `T1 rows=${auditT1[0].c}`);
  const helmetRes = await inj('GET', '/', admin);
  const hasHelmet = !!(helmetRes.headers['x-frame-options'] || helmetRes.headers['content-security-policy'] || helmetRes.headers['x-content-type-options']);
  ok('Edge: helmet security headers present', hasHelmet, JSON.stringify(Object.keys(helmetRes.headers)).slice(0, 120));

  // Edge: sensitive-auth endpoints have a stricter per-IP rate bucket (defence-in-depth ON TOP of the
  // per-account lockout). Distinct usernames each get their own per-account counter (threshold 10, never
  // reached), so a 429 here is the EDGE per-IP auth limit (default 30/min), not the account lockout.
  let rl429 = false, rlCode = '', attempts = 0;
  for (let i = 0; i < 45; i++) {
    attempts++;
    const r = await inj('POST', '/api/login', undefined, { username: `rl-probe-${i}`, password: 'x' });
    if (r.status === 429) { rl429 = true; rlCode = r.json?.error?.code; break; }
  }
  ok('Edge: sensitive-auth endpoints hit a stricter per-IP rate limit (429 RATE_LIMITED)', rl429 && rlCode === 'RATE_LIMITED', `429=${rl429} code=${rlCode} after ${attempts} attempts`);

  await app.close();
  await pg.close();

  console.log('\n── Phase 9 world-class foundations (RLS · GL · payments · tax · billing · platform · audit/edge) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} world-class checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} world-class checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
