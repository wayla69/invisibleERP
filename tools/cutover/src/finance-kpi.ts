/**
 * docs/35 Phase 1 — Finance KPI engine (CFO scorecard) over PGlite.
 * Seeds a KNOWN general ledger + sub-ledgers, then asserts every canonical KPI equals the hand-computed
 * value, comparatives + RAG are wired, budget is read from approved budgets, and drill/trend tie to the GL.
 * Also asserts the endpoint is permission-gated (a warehouse-only user is denied).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover finance-kpi
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'finkpi-secret';
process.env.NODE_ENV = 'test';
process.env.BI_CACHE_TTL_MS = '0'; // disable read-cache so each assertion sees fresh seed state

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
const near = (a: any, b: number, tol = 0.01) => Math.abs(Number(a) - b) < tol;

// mirror the service's business-day window math for date-dependent assertions
const ymd = (d = new Date()) => d.toISOString().slice(0, 10);
const monthStartOf = (x: string) => `${x.slice(0, 7)}-01`;
const daysInclusive = (from: string, to: string) =>
  Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1);

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CUS', name: 'Customer Co' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, cus] = [await tid('HQ'), await tid('CUS')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'wh1', passwordHash: await pw.hash('wh1'), role: 'Warehouse', tenantId: hq }, // no finance perms
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const ledger = app.get(LedgerService);
  await ledger.seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /**/ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, wh1] = [await login('admin', 'admin123'), await login('wh1', 'wh1')];

  // ── Seed a KNOWN ledger for tenant HQ, dated in the current month ──────────────────────────────
  //  One balanced compound entry sets the target trial balance exactly (seed, not a realistic flow):
  //    Cash 100k · AR 50k · Inventory 30k · PP&E 200k · Accum-dep (10k) → total assets 370k
  //    AP 40k · Lease liab 60k → total liabilities 100k · Equity 245k (+25k current net income = 270k)
  //    Revenue 100k · COGS 40k · Opex 20k · Depreciation 10k · Interest 5k → net income 25k
  //  Σ debits = Σ credits = 455k. viaSubledger allows the control-account lines (1100/2000/1200).
  const today = ymd();
  await ledger.postEntry({
    date: today, source: 'SEED', sourceRef: 'KPI-TB', tenantId: hq, createdBy: 'seed', viaSubledger: true,
    lines: [
      { account_code: '1000', debit: 100000 }, { account_code: '1100', debit: 50000 }, { account_code: '1200', debit: 30000 },
      { account_code: '1500', debit: 200000 }, { account_code: '5000', debit: 40000 }, { account_code: '5100', debit: 20000 },
      { account_code: '5200', debit: 10000 }, { account_code: '5900', debit: 5000 },
      { account_code: '1590', credit: 10000 }, { account_code: '2000', credit: 40000 }, { account_code: '2600', credit: 60000 },
      { account_code: '3000', credit: 245000 }, { account_code: '4000', credit: 100000 },
    ],
  });

  // Seed AR sub-ledger (aging): one 90+ overdue invoice + one current, total 50k, overdue 20k, 90+ 20k.
  const past = (days: number) => ymd(new Date(Date.now() - days * 86400000));
  await db.insert(s.arInvoices).values([
    { tenantId: cus, invoiceNo: 'INV-90', invoiceDate: past(120), dueDate: past(100), amount: '20000', paidAmount: '0', status: 'Unpaid' },
    { tenantId: cus, invoiceNo: 'INV-CUR', invoiceDate: past(5), dueDate: ymd(new Date(Date.now() + 20 * 86400000)), amount: '30000', paidAmount: '0', status: 'Unpaid' },
  ]).onConflictDoNothing();

  // Seed an APPROVED budget for the current month (revenue 90k, opex 15k) so budget-vs-actual computes.
  const period = today.slice(0, 7);
  const fy = Number(today.slice(0, 4));
  await db.insert(s.budgets).values([
    { tenantId: hq, fiscalYear: fy, accountCode: '4000', period, amount: '90000', status: 'Approved' },
    { tenantId: hq, fiscalYear: fy, accountCode: '5100', period, amount: '15000', status: 'Approved' },
  ]).onConflictDoNothing();

  // ── Assertions ────────────────────────────────────────────────────────────────────────────────
  const packRes = await inj('GET', '/api/finance/metrics/pack', admin);
  ok('GET /api/finance/metrics/pack → 200 with kpis + groups', packRes.status === 200 && Array.isArray(packRes.json.kpis) && Array.isArray(packRes.json.groups), `st=${packRes.status}`);
  const pack = packRes.json;
  const kv = (id: string) => pack.kpis.find((k: any) => k.id === id);
  const val = (id: string) => kv(id)?.value;

  // Date-independent KPIs — exact hand-computed values
  ok('current_ratio = 4.5 (CA 180k / CL 40k)', near(val('current_ratio'), 4.5), `=${val('current_ratio')}`);
  ok('quick_ratio = 3.75 ((180k−30k)/40k)', near(val('quick_ratio'), 3.75), `=${val('quick_ratio')}`);
  ok('cash_ratio = 2.5 (100k/40k)', near(val('cash_ratio'), 2.5), `=${val('cash_ratio')}`);
  ok('working_capital = 140000', near(val('working_capital'), 140000), `=${val('working_capital')}`);
  ok('gross_margin_pct = 60', near(val('gross_margin_pct'), 60), `=${val('gross_margin_pct')}`);
  ok('operating_margin_pct = 30 (EBIT 30k / rev 100k)', near(val('operating_margin_pct'), 30), `=${val('operating_margin_pct')}`);
  ok('net_margin_pct = 25', near(val('net_margin_pct'), 25), `=${val('net_margin_pct')}`);
  ok('ebitda = 40000 (EBIT 30k + dep 10k)', near(val('ebitda'), 40000), `=${val('ebitda')}`);
  ok('ebitda_margin_pct = 40', near(val('ebitda_margin_pct'), 40), `=${val('ebitda_margin_pct')}`);
  ok('debt_to_equity = 0.3704 (total liab 100k / equity 270k)', near(val('debt_to_equity'), 0.3704), `=${val('debt_to_equity')}`);
  ok('interest_coverage = 6 (EBIT 30k / interest 5k)', near(val('interest_coverage'), 6), `=${val('interest_coverage')}`);
  ok('net_debt = -40000 (lease 60k − cash 100k)', near(val('net_debt'), -40000), `=${val('net_debt')}`);

  // Efficiency KPIs — TTM basis (annualized on the trailing-12-month flow, so DATE-INDEPENDENT).
  // Seed flow all falls inside the trailing year ⇒ ttmRevenue 100k, ttmCogs 40k, ttmNetIncome 25k.
  ok('dso = 182.5 (AR 50k / TTM rev 100k × 365)', near(val('dso'), 182.5), `=${val('dso')}`);
  ok('dpo = 365 (AP 40k / TTM COGS 40k × 365)', near(val('dpo'), 365), `=${val('dpo')}`);
  ok('dio = 273.75 (inv 30k / TTM COGS 40k × 365)', near(val('dio'), 273.75), `=${val('dio')}`);
  ok('ar_turnover = 2 (TTM rev 100k / AR 50k)', near(val('ar_turnover'), 2), `=${val('ar_turnover')}`);
  ok('inventory_turnover = 1.3333 (TTM COGS 40k / inv 30k)', near(val('inventory_turnover'), 1.3333), `=${val('inventory_turnover')}`);
  ok('cash_conversion_cycle = 91.25 (DSO 182.5 + DIO 273.75 − DPO 365)', near(val('cash_conversion_cycle'), 91.25), `=${val('cash_conversion_cycle')}`);
  ok('roa_pct = 6.76 (TTM NI 25k / assets 370k)', near(val('roa_pct'), 6.76, 0.02), `=${val('roa_pct')}`);
  ok('roe_pct = 9.26 (TTM NI 25k / equity 270k)', near(val('roe_pct'), 9.26, 0.02), `=${val('roe_pct')}`);
  ok('cash_runway_months = null (TTM profitable, not burning)', val('cash_runway_months') === null, `=${val('cash_runway_months')}`);

  // AR/AP health (from the seeded aging sub-ledger)
  ok('overdue_ar_pct = 40 (20k overdue / 50k)', near(val('overdue_ar_pct'), 40), `=${val('overdue_ar_pct')}`);
  ok('ar_over_90_pct = 40 (20k 90+ / 50k)', near(val('ar_over_90_pct'), 40), `=${val('ar_over_90_pct')}`);

  // Comparatives + RAG wired on every KPI
  const shapeOk = pack.kpis.every((k: any) => 'prior_period' in k && 'prior_year' in k && 'budget' in k && 'rag' in k && 'drill' in k);
  ok('every KPI carries prior_period / prior_year / budget / rag / drill', shapeOk, `n=${pack.kpis.length}`);
  ok('RAG set: current_ratio green, dso graded, overdue_ar_pct red', kv('current_ratio')?.rag === 'green' && ['green', 'amber', 'red'].includes(kv('dso')?.rag) && kv('overdue_ar_pct')?.rag === 'red', `cr=${kv('current_ratio')?.rag} dso=${kv('dso')?.rag} oar=${kv('overdue_ar_pct')?.rag}`);
  ok('KPI count = registry (29) + 2 growth = 31', pack.kpis.length === 31, `n=${pack.kpis.length}`);

  // Budget comparative (approved budget) reaches the pack
  ok('pack.budget.revenue.budget = 90000 (approved budget)', near(pack.budget?.revenue?.budget, 90000), `=${JSON.stringify(pack.budget?.revenue)}`);
  ok('net_margin_pct carries a budget comparative (vs_budget_pct present)', kv('net_margin_pct')?.budget != null, `budget=${kv('net_margin_pct')?.budget}`);

  // Growth (cross-snapshot) — no prior month seeded ⇒ null, but the KPIs exist
  ok('revenue_growth_mom_pct present (null, no prior month)', kv('revenue_growth_mom_pct') != null && kv('revenue_growth_mom_pct').value === null, `=${kv('revenue_growth_mom_pct')?.value}`);

  // Trend endpoint — 3 months, current month value ties to the pack
  const trend = await inj('GET', '/api/finance/metrics/gross_margin_pct/trend?periods=3', admin);
  ok('trend gross_margin_pct → 3-point series, last = 60', trend.status === 200 && trend.json.series?.length === 3 && near(trend.json.series[2].value, 60), `st=${trend.status} last=${trend.json.series?.at(-1)?.value}`);

  // Drill endpoint — current_ratio drills to the balance-sheet account rows incl. cash 1000
  const drill = await inj('GET', '/api/finance/metrics/current_ratio/drill', admin);
  const cashRow = (drill.json.rows ?? []).find((r: any) => r.account_code === '1000');
  ok('drill current_ratio → balance_sheet rows incl. cash 1000 = 100000', drill.status === 200 && drill.json.basis === 'balance_sheet' && cashRow && near(cashRow.amount, 100000), `st=${drill.status} cash=${cashRow?.amount}`);

  // Unknown metric → 400
  const bad = await inj('GET', '/api/finance/metrics/nope/drill', admin);
  ok('unknown metric → 400 UNKNOWN_METRIC', bad.status === 400 && bad.json.error?.code === 'UNKNOWN_METRIC', `st=${bad.status} ${JSON.stringify(bad.json).slice(0, 60)}`);

  // Permission control — a warehouse-only user is denied the CFO scorecard
  const denied = await inj('GET', '/api/finance/metrics/pack', wh1);
  ok('permission control: warehouse-only user denied pack (403)', denied.status === 403, `st=${denied.status}`);

  // ── Treasury / Cash Command (docs/35 Phase 4, TR-01) ───────────────────────────────────────────
  // Seed state (before the close-cockpit block posts AP): GL cash 1000=100k, AR 50k open, no AP ⇒ a clean
  // 13-week forecast. total_cash ties to the trial balance; the liquidity KPI subset rides the pack.
  const cp = await inj('GET', '/api/finance/metrics/cash/position', admin);
  ok('cash/position → 200 with cash_accounts / forecast / liquidity / fx_exposure', cp.status === 200 && Array.isArray(cp.json.cash_accounts) && !!cp.json.forecast && Array.isArray(cp.json.liquidity) && Array.isArray(cp.json.fx_exposure), `st=${cp.status}`);
  ok('cash position: total_cash 100000, GL 1000 = 100000 (ties to trial balance)', near(cp.json.total_cash, 100000) && near(cp.json.cash_accounts.find((a: any) => a.account_code === '1000')?.balance, 100000), `tc=${cp.json.total_cash}`);
  ok('cash forecast: opening 100000, inflow 50000 (AR), outflow 0, closing 150000',
    near(cp.json.forecast?.opening_cash, 100000) && near(cp.json.forecast?.total_expected_inflow, 50000) && near(cp.json.forecast?.total_expected_outflow, 0) && near(cp.json.forecast?.projected_closing_cash, 150000),
    JSON.stringify({ o: cp.json.forecast?.opening_cash, i: cp.json.forecast?.total_expected_inflow, x: cp.json.forecast?.total_expected_outflow, c: cp.json.forecast?.projected_closing_cash }));
  ok('cash forecast: default 13-week horizon → 14 periods; liquidity subset incl. cash_ratio 2.5', cp.json.weeks === 13 && cp.json.forecast?.periods?.length === 14 && near(cp.json.liquidity.find((k: any) => k.id === 'cash_ratio')?.value, 2.5), `wk=${cp.json.weeks} n=${cp.json.forecast?.periods?.length}`);
  ok('cash position: no FX exposure yet (all THB)', cp.json.fx_exposure.length === 0, `fx=${JSON.stringify(cp.json.fx_exposure)}`);
  const cpDenied = await inj('GET', '/api/finance/metrics/cash/position', wh1);
  ok('permission control: warehouse-only user denied cash position (403)', cpDenied.status === 403, `st=${cpDenied.status}`);

  // ── Controller Close Cockpit (docs/35 Phase 3, GL-22) ──────────────────────────────────────────
  // The seed leaves AP + inventory sub-ledgers empty while their GL controls (2000=40k, 1200=30k) carry a
  // balance ⇒ a tie-out break. The cockpit must flag it RED; then we post the matching sub-ledgers and it
  // must go GREEN. (AR already ties: arInvoices 50k = GL 1100 50k.)
  const cs1 = await inj('GET', '/api/finance/metrics/close/status', admin);
  ok('close/status → 200 with tie_out / readiness / approvals / rag', cs1.status === 200 && !!cs1.json.tie_out && !!cs1.json.readiness && !!cs1.json.approvals && !!cs1.json.rag, `st=${cs1.status}`);
  ok('close cockpit: tie-out RED with the seeded break (AP/inventory sub-ledger ≠ GL control)', cs1.json.rag?.tie_out === 'red' && cs1.json.tie_out?.exceptions >= 1, `tie=${cs1.json.rag?.tie_out} exc=${cs1.json.tie_out?.exceptions}`);
  ok('close cockpit: overall RED (a tie-out break blocks the close)', cs1.json.rag?.overall === 'red', `overall=${cs1.json.rag?.overall}`);
  ok('close cockpit: readiness GREEN (no drafts, balanced, snapshot reconciles)', cs1.json.rag?.readiness === 'green' && cs1.json.readiness?.ready === true, `rdy=${cs1.json.rag?.readiness} blockers=${JSON.stringify(cs1.json.readiness?.blockers)}`);
  ok('close cockpit: no close run started ⇒ close_run null; days_to_close numeric', cs1.json.close_run === null && typeof cs1.json.days_to_close === 'number', `run=${cs1.json.close_run} d=${cs1.json.days_to_close}`);

  await db.insert(s.apTransactions).values([{ txnNo: 'AP-TIE', tenantId: hq, vendorName: 'Vendor', txnType: 'Bill', amount: '40000', paidAmount: '0', status: 'Unpaid', dueDate: today }]).onConflictDoNothing();
  await db.insert(s.invBalances).values([{ tenantId: hq, itemId: 'ITEM-TIE', totalValue: '30000', onHandQty: '1', avgCost: '30000' }]).onConflictDoNothing();
  const cs2 = await inj('GET', '/api/finance/metrics/close/status', admin);
  ok('close cockpit: after posting matching AP+inventory sub-ledgers → tie-out GREEN, overall GREEN, 0 exceptions',
    cs2.json.rag?.tie_out === 'green' && cs2.json.rag?.overall === 'green' && cs2.json.tie_out?.exceptions === 0,
    `tie=${cs2.json.rag?.tie_out} overall=${cs2.json.rag?.overall} exc=${cs2.json.tie_out?.exceptions}`);

  // Permission control — a warehouse-only user is denied the close cockpit
  const csDenied = await inj('GET', '/api/finance/metrics/close/status', wh1);
  ok('permission control: warehouse-only user denied close cockpit (403)', csDenied.status === 403, `st=${csDenied.status}`);

  // Treasury FX exposure — a USD payable shows up as a non-THB exposure (run last: it perturbs the AP tie-out).
  await db.insert(s.apTransactions).values([{ txnNo: 'AP-USD', tenantId: hq, vendorName: 'US Vendor', txnType: 'Bill', amount: '1000', paidAmount: '0', status: 'Unpaid', currency: 'USD', dueDate: today }]).onConflictDoNothing();
  const cpFx = await inj('GET', '/api/finance/metrics/cash/position', admin);
  const usd = (cpFx.json.fx_exposure ?? []).find((e: any) => e.currency === 'USD');
  ok('cash position: FX exposure picks up the USD payable (payable 1000, net −1000)', !!usd && near(usd.payable, 1000) && near(usd.net, -1000), `usd=${JSON.stringify(usd)}`);

  await app.close();

  // ── Report ──
  const passed = checks.filter((c) => c.ok).length;
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : `  → ${c.detail}`}`);
  console.log(`\nfinance-kpi: ${passed}/${checks.length} passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
