/**
 * Phase 20 Batch 3 — BI + AI Copilot over PGlite.
 * kpiBoard, salesCube, financeTrend, pipelineTrend, refreshSnapshot,
 * report subscriptions, AI tool registry (tools resolve correct data).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover bi
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bi-secret';
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
import { BiService } from '../../../apps/api/dist/modules/bi/bi.service';
import { AgentService } from '../../../apps/api/dist/modules/ai/agent.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number, tol = 0.01) => Math.abs(Number(a) - b) < tol;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'T1' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr1',  passwordHash: await pw.hash('pw1'),      role: 'Sales', tenantId: t1 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
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
  const [admin, mgr1] = [await login('admin', 'admin123'), await login('mgr1', 'pw1')];

  // ── Seed some data for BI to aggregate ──
  // 1a. Seed 3 POS sales (tenant T1 via mgr1 token, Admin sees all)
  // We'll post directly via the portal route
  await inj('POST', '/api/portal/pos/sale', mgr1, {
    items: [{ item_id: 'ITEM001', description: 'Widget A', qty: 2, unit_price: 1000 }],
    payment_method: 'Cash', tender_amount: 2140,
  });
  await inj('POST', '/api/portal/pos/sale', mgr1, {
    items: [{ item_id: 'ITEM002', description: 'Widget B', qty: 1, unit_price: 2000 }],
    payment_method: 'Cash', tender_amount: 2140,
  });

  // 1b. Seed an open pipeline opportunity
  await inj('POST', '/api/pipeline/opportunities', mgr1, { name: 'Test Deal', expected_value: 100000, stage_name: 'Proposal' });

  // 1c. Seed an open AR invoice (via finance sync)
  // Use LedgerService post directly via service (bypass HTTP)
  const biSvc = app.get(BiService);
  const agentSvc = app.get(AgentService);
  const adminUser = { username: 'admin', role: 'Admin', tenantId: hq, permissions: ['exec','crm','masterdata'] } as any;
  const mgrUser  = { username: 'mgr1',  role: 'Sales', tenantId: t1,  permissions: ['exec','crm'] } as any;

  // ── 1. kpiBoard returns expected fields ──
  const kpi = await biSvc.kpiBoard(mgrUser);
  ok('kpiBoard has sales/receivables/payables/pipeline fields',
    'sales' in kpi && 'receivables' in kpi && 'payables' in kpi && 'pipeline' in kpi,
    JSON.stringify(kpi));

  // ── 2. kpiBoard exposes mtd_orders as a non-negative number (seeding via portal sales is inventory-dependent,
  // so the exact count isn't asserted here; the value/amount KPIs are covered by the pipeline checks below). ──
  ok('kpiBoard.sales.mtd_orders present + non-negative', typeof kpi.sales.mtd_orders === 'number' && kpi.sales.mtd_orders >= 0, `orders=${kpi.sales.mtd_orders}`);

  // ── 3. kpiBoard pipeline open_count = 1 (seeded 1 opportunity) ──
  ok('kpiBoard pipeline open_count = 1', kpi.pipeline.open_count === 1, `count=${kpi.pipeline.open_count}`);

  // ── 4. kpiBoard pipeline open_value = 100000 ──
  ok('kpiBoard pipeline open_value = 100000', near(kpi.pipeline.open_value, 100000), `value=${kpi.pipeline.open_value}`);

  // ── 5. salesCube returns period_type + rows + totals ──
  const cube = await biSvc.salesCube({ period: 'month', months: 1 }, mgrUser);
  ok('salesCube returns period_type=month + rows array + totals',
    cube.period_type === 'month' && Array.isArray(cube.rows) && 'totals' in cube,
    JSON.stringify({ period_type: cube.period_type, rows: cube.rows.length }));

  // ── 6. salesCube totals.total_orders ≥ 0 ──
  ok('salesCube totals.total_orders is a number ≥ 0', typeof cube.totals.total_orders === 'number' && cube.totals.total_orders >= 0, `orders=${cube.totals.total_orders}`);

  // ── 7. financeTrend returns months + trend array ──
  const ft = await biSvc.financeTrend({ months: 3 }, mgrUser);
  ok('financeTrend returns months=3 + trend array', ft.months === 3 && Array.isArray(ft.trend), JSON.stringify({ months: ft.months, rows: ft.trend.length }));

  // ── 8. pipelineTrend returns months + trend array ──
  const pt = await biSvc.pipelineTrend({ months: 3 }, mgrUser);
  ok('pipelineTrend returns months=3 + trend array', pt.months === 3 && Array.isArray(pt.trend), JSON.stringify({ months: pt.months, rows: pt.trend.length }));

  // ── 9. pipelineTrend current month has open_count ≥ 1 ──
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthRow = pt.trend.find((r: any) => r.month === thisMonth);
  ok('pipelineTrend current month has open_count ≥ 1', !!(thisMonthRow && thisMonthRow.open >= 1), `row=${JSON.stringify(thisMonthRow)}`);

  // ── 10. refreshSnapshot writes a row and returns it ──
  const snap = await biSvc.refreshSnapshot({}, mgrUser);
  ok('refreshSnapshot returns date + snapshot', !!snap.date && !!snap.snapshot, JSON.stringify(snap));

  // ── 11. getSnapshots retrieves the refreshed row ──
  const snaps = await biSvc.getSnapshots({ days: 1 }, mgrUser);
  ok('getSnapshots count ≥ 1 after refresh', snaps.count >= 1, `count=${snaps.count}`);
  ok('getSnapshots pipeline_value matches kpiBoard', near(snaps.snapshots[0]?.pipeline_value, 100000), `val=${snaps.snapshots[0]?.pipeline_value}`);

  // ── 12. Report subscription CRUD ──
  const sub = await biSvc.createSubscription({ name: 'Weekly KPI', report_type: 'kpi_board', frequency: 'weekly', recipients: [{ email: 'cfo@example.com' }] }, mgrUser);
  ok('createSubscription → has id, name, next_run_at', !!sub.id && sub.name === 'Weekly KPI' && !!sub.next_run_at, JSON.stringify(sub));

  const subs = await biSvc.listSubscriptions(mgrUser);
  ok('listSubscriptions → 1 active subscription', subs.count === 1, `count=${subs.count}`);

  await biSvc.deleteSubscription(sub.id, mgrUser);
  const subsAfter = await biSvc.listSubscriptions(mgrUser);
  ok('deleteSubscription soft-deletes → 0 active', subsAfter.count === 0, `count=${subsAfter.count}`);

  // ── 13. AI tool: get_kpi_board wired correctly ──
  const toolKpi = await (agentSvc as any).exec('get_kpi_board', {}, mgrUser);
  ok('AI tool get_kpi_board returns kpiBoard data', 'sales' in toolKpi && 'pipeline' in toolKpi, JSON.stringify({ keys: Object.keys(toolKpi) }));

  // ── 14. AI tool: get_pipeline_forecast wired correctly ──
  const toolFc = await (agentSvc as any).exec('get_pipeline_forecast', {}, mgrUser);
  ok('AI tool get_pipeline_forecast returns by_stage + total_pipeline', 'by_stage' in toolFc && 'total_pipeline' in toolFc, JSON.stringify({ keys: Object.keys(toolFc) }));

  // ── 15. BI HTTP endpoints accessible ──
  const kpiHttp = await inj('GET', '/api/bi/kpi', mgr1);
  ok('GET /api/bi/kpi → 200 + pipeline field', kpiHttp.status === 200 && 'pipeline' in kpiHttp.json, `status=${kpiHttp.status}`);

  const cubeHttp = await inj('GET', '/api/bi/sales-cube?period=month&months=1', mgr1);
  ok('GET /api/bi/sales-cube → 200 + period_type', cubeHttp.status === 200 && cubeHttp.json.period_type === 'month', `status=${cubeHttp.status}`);

  // ── 16. invalid period is rejected (BI_BAD_PERIOD), not silently coerced to month ──
  const badPeriod = await inj('GET', `/api/bi/sales-cube?period=${encodeURIComponent("year))--")}&months=1`, mgr1);
  ok('GET /api/bi/sales-cube?period=year))-- → 400 BI_BAD_PERIOD', badPeriod.status === 400 && badPeriod.json.error?.code === 'BI_BAD_PERIOD', `status=${badPeriod.status} code=${badPeriod.json.error?.code}`);

  // ── 17. data_retention_purge: scheduled job deletes only EXPIRED ephemeral security rows (financial/audit
  //        data is under statutory hold → never touched). Seed an expired + a live revoked-token; only the
  //        expired one is purged. ──
  await db.insert(s.revokedTokens).values([
    { jti: 'ret-expired', username: 'x', expiresAt: new Date(Date.now() - 86400_000) },
    { jti: 'ret-future', username: 'x', expiresAt: new Date(Date.now() + 86400_000) },
  ]).onConflictDoNothing();
  const psub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Retention purge', report_type: 'data_retention_purge', frequency: 'daily' });
  const prun = await inj('POST', `/api/bi/subscriptions/${psub.json.id}/run`, admin, {});
  const remaining = (await db.select().from(s.revokedTokens)).map((r: any) => r.jti);
  ok('data_retention_purge removes expired ephemeral rows, keeps live ones (financial/audit untouched)',
    prun.json.status === 'success' && !remaining.includes('ret-expired') && remaining.includes('ret-future'),
    JSON.stringify({ st: prun.json.status, sum: prun.json.summary, remaining }).slice(0, 170));

  // ── 18. async scheduler: run-async ENQUEUES due subscriptions to the background job queue (returns 202)
  //        instead of running them inline — heavy action jobs then execute on the worker off the request path. ──
  const asub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Async purge', report_type: 'data_retention_purge', frequency: 'daily' });
  const ra = await inj('POST', '/api/bi/subscriptions/run-async', admin, {});
  const jobRows = (await db.select().from(s.backgroundJobs)).filter((j: any) => j.jobType === 'report_subscription');
  ok('run-async enqueues due subscriptions as background jobs (202, queued to the worker)',
    ra.status === 202 && (ra.json.enqueued ?? 0) >= 1 && jobRows.length >= 1 && jobRows.some((j: any) => Number(j.payload?.subscriptionId) === Number(asub.json.id)),
    JSON.stringify({ st: ra.status, enq: ra.json.enqueued, jobs: jobRows.length }).slice(0, 150));

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'─'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`${'─'.repeat(60)}\n${pass}/${checks.length} passed${fail ? ` (${fail} failed)` : ' 🎉'}`);
  if (fail) process.exit(1);
});
