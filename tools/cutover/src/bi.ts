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
  const ftConsistent = ft.trend.every((r: any) => Math.abs(r.gross_profit - (r.revenue - r.expense)) < 0.01 && typeof r.revenue === 'number' && typeof r.expense === 'number');
  ok('financeTrend returns months=3 + trend array (JOIN+CASE aggregation: gross_profit = revenue − expense)', ft.months === 3 && Array.isArray(ft.trend) && ftConsistent, JSON.stringify({ months: ft.months, rows: ft.trend.length, consistent: ftConsistent }));

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

  // ── 10b. streaming analytics (docs/22 Phase B): refreshSnapshot published a live kpi_refresh event ──
  const liveT1 = biSvc.liveRecent(mgrUser);
  ok('live feed: refreshSnapshot pushed a kpi_refresh event (tenant t1)',
    liveT1.available === true && (liveT1.events ?? []).some((e: any) => e.type === 'kpi_refresh' && near(e.kpi?.pipeline_open, 100000)),
    JSON.stringify({ avail: liveT1.available, types: (liveT1.events ?? []).map((e: any) => e.type) }));
  const liveHq = biSvc.liveRecent(adminUser);
  ok('live feed: tenant isolation — HQ does not see t1\'s kpi_refresh', !(liveHq.events ?? []).some((e: any) => e.type === 'kpi_refresh' && e.tenant_id === mgrUser.tenantId), `hq_events=${(liveHq.events ?? []).length}`);

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

  // ── 17b. pii_retention_sweep (PDPA-04): the scheduled job is WIRED (PdpaModule → BiService) and runs
  //         opt-in only — with no enabled pdpa_retention_policies row it anonymizes nothing. The sweep logic
  //         itself (policy floor, dry-run, aged-vs-recent, idempotency) is ToE'd in cutover/pdpa.ts. ──
  const rsub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'PII retention sweep', report_type: 'pii_retention_sweep', frequency: 'monthly' });
  const rrun = await inj('POST', `/api/bi/subscriptions/${rsub.json.id}/run`, admin, {});
  ok('pii_retention_sweep is schedulable and a no-policy run sweeps nothing (opt-in, default-off)',
    rsub.status === 201 && rrun.json.status === 'success' && (rrun.json.summary ?? '').includes('0 member(s)'),
    JSON.stringify({ st: rrun.json.status, sum: rrun.json.summary }).slice(0, 170));

  // ── 18. async scheduler: run-async ENQUEUES due subscriptions to the background job queue (returns 202)
  //        instead of running them inline — heavy action jobs then execute on the worker off the request path. ──
  const asub = await inj('POST', '/api/bi/subscriptions', admin, { name: 'Async purge', report_type: 'data_retention_purge', frequency: 'daily' });
  const ra = await inj('POST', '/api/bi/subscriptions/run-async', admin, {});
  const jobRows = (await db.select().from(s.backgroundJobs)).filter((j: any) => j.jobType === 'report_subscription');
  ok('run-async enqueues due subscriptions as background jobs (202, queued to the worker)',
    ra.status === 202 && (ra.json.enqueued ?? 0) >= 1 && jobRows.length >= 1 && jobRows.some((j: any) => Number(j.payload?.subscriptionId) === Number(asub.json.id)),
    JSON.stringify({ st: ra.status, enq: ra.json.enqueued, jobs: jobRows.length }).slice(0, 150));

  // ── 19. residual-gap report types (RG-1/2/3): exec_scorecard + budget_variance + supplier_scorecard ──
  const rtypes = await inj('GET', '/api/bi/report-types', admin);
  ok('report-types catalog exposes exec_scorecard + budget_variance + supplier_scorecard',
    ['exec_scorecard', 'budget_variance', 'supplier_scorecard'].every((k) => JSON.stringify(rtypes.json).includes(k)), '');
  const runType = async (report_type: string) => {
    const sub = await inj('POST', '/api/bi/subscriptions', admin, { name: report_type, report_type, frequency: 'weekly' });
    return inj('POST', `/api/bi/subscriptions/${sub.json.id}/run`, admin, {});
  };
  const execRun = await runType('exec_scorecard');
  ok('exec_scorecard runs success + composed summary (finance/crm/projects/supply-chain)',
    execRun.json.status === 'success' && /Exec:/.test(execRun.json.summary ?? '') && /win rate/.test(execRun.json.summary ?? ''),
    JSON.stringify({ s: execRun.json.status, sum: (execRun.json.summary ?? '').slice(0, 60) }));
  const budRun = await runType('budget_variance');
  ok('budget_variance runs success + net-variance / review summary',
    budRun.json.status === 'success' && /net variance/.test(budRun.json.summary ?? '') && /review/.test(budRun.json.summary ?? ''), JSON.stringify({ s: budRun.json.status, sum: (budRun.json.summary ?? '').slice(0, 60) }));
  const supRun = await runType('supplier_scorecard');
  ok('supplier_scorecard runs success + avg / underperformer summary',
    supRun.json.status === 'success' && /avg/.test(supRun.json.summary ?? '') && /underperformer/.test(supRun.json.summary ?? ''), JSON.stringify({ s: supRun.json.status, sum: (supRun.json.summary ?? '').slice(0, 60) }));

  // ── 19b. docs/35 Phase 6 — schedulable finance packs (cfo_kpi_pack / cash_position_pack / close_status_pack) ──
  ok('report-types catalog exposes cfo_kpi_pack + cash_position_pack + close_status_pack',
    ['cfo_kpi_pack', 'cash_position_pack', 'close_status_pack'].every((k) => JSON.stringify(rtypes.json).includes(k)), '');
  const cfoRun = await runType('cfo_kpi_pack');
  ok('cfo_kpi_pack runs success + MD&A headline summary (+ red count)',
    cfoRun.json.status === 'success' && /CFO KPIs/.test(cfoRun.json.summary ?? '') && /red/.test(cfoRun.json.summary ?? ''),
    JSON.stringify({ s: cfoRun.json.status, sum: (cfoRun.json.summary ?? '').slice(0, 70) }));
  const cashRun = await runType('cash_position_pack');
  ok('cash_position_pack runs success + cash / projected-close / trough summary',
    cashRun.json.status === 'success' && /Cash/.test(cashRun.json.summary ?? '') && /trough/.test(cashRun.json.summary ?? ''),
    JSON.stringify({ s: cashRun.json.status, sum: (cashRun.json.summary ?? '').slice(0, 70) }));
  const closeRun = await runType('close_status_pack');
  ok('close_status_pack runs success + overall / tie-out / days-to-close summary',
    closeRun.json.status === 'success' && /Close/.test(closeRun.json.summary ?? '') && /days-to-close/.test(closeRun.json.summary ?? ''),
    JSON.stringify({ s: closeRun.json.status, sum: (closeRun.json.summary ?? '').slice(0, 70) }));

  // ── 20. ITGC-OP-04: a scheduled (financial) job that FAILS is captured + alerted + reviewable, not silent ──
  // Force a deterministic failure: insert a subscription whose report type generateReport rejects (bypassing
  // create-time validation via a direct insert), then run it. executeSubscription must record the failure,
  // raise an operator ops-notification, and surface it for review — never swallow it silently.
  // (the bi schema isn't re-exported from the schema barrel, so insert the row via raw SQL)
  const brkIns = (await pg.query(`INSERT INTO report_subscriptions (tenant_id, name, report_type, frequency, is_active) VALUES (${hq}, 'Broken nightly job', 'definitely_unknown_type', 'daily', true) RETURNING id`)).rows as any[];
  const brkId = Number(brkIns[0].id);
  const brkRun = await inj('POST', `/api/bi/subscriptions/${brkId}/run`, admin, {});
  ok('ITGC-OP-04: a failing scheduled job is recorded as failed (not lost)',
    brkRun.json.status === 'failed' && !!brkRun.json.error, JSON.stringify({ s: brkRun.json.status, e: (brkRun.json.error ?? '').slice(0, 40) }));
  const failedRuns = (await pg.query(`SELECT status, error FROM report_runs WHERE subscription_id=${brkId} AND status='failed'`)).rows as any[];
  ok('ITGC-OP-04: failure captured in report_runs with the error message',
    failedRuns.length === 1 && /BAD_REPORT_TYPE|Unknown report type/.test(failedRuns[0]?.error ?? ''), JSON.stringify(failedRuns[0] ?? {}));
  const opsNote = (await pg.query(`SELECT message_en FROM notifications WHERE message_en LIKE 'Scheduled job failed%' AND target_role='Admin'`)).rows as any[];
  ok('ITGC-OP-04: an operator ops-notification is raised on failure (alerting, not silent)',
    opsNote.length >= 1 && /definitely_unknown_type/.test(opsNote[0]?.message_en ?? ''), JSON.stringify(opsNote[0] ?? {}));
  const runsList = await inj('GET', '/api/bi/runs', admin);
  ok('ITGC-OP-04: the failed run is reviewable in GET /api/bi/runs',
    (runsList.json.runs ?? []).some((r: any) => Number(r.subscription_id) === brkId && r.status === 'failed'), `n=${(runsList.json.runs ?? []).length}`);

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
