/**
 * Full HTTP smoke test against the live API (http://localhost:8000).
 * Routes verified against actual startup log + response probing.
 *   npx tsx tools/cutover/src/smoke-http.ts
 */
const BASE = 'http://localhost:8000';
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => { checks.push({ name, ok: cond, detail }); if (!cond) console.error(`  ❌ FAIL: ${name} — ${detail}`); };

async function req(method: string, path: string, token?: string, body?: any) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await r.json(); } catch { /**/ }
  return { status: r.status, json };
}

async function main() {
  console.log(`\nSmoke test → ${BASE}\n${'═'.repeat(60)}`);

  // ── Auth ──────────────────────────────────────────────────────
  console.log('\n[Auth]');
  const login = await req('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  ok('POST /api/login → 200 + token', login.status === 200 && !!login.json?.token, `status=${login.status}`);
  const T = login.json?.token as string;
  if (!T) { console.error('Cannot proceed without token'); process.exit(1); }

  const badLogin = await req('POST', '/api/login', undefined, { username: 'admin', password: 'wrong' });
  ok('POST /api/login bad password → 401', badLogin.status === 401, `status=${badLogin.status}`);

  const me = await req('GET', '/api/auth/me', T);
  ok('GET /api/auth/me → 200 + username', me.status === 200 && !!me.json?.username, `status=${me.status} body=${JSON.stringify(me.json)?.slice(0,80)}`);

  // ── Health ────────────────────────────────────────────────────
  console.log('\n[Health]');
  const health = await req('GET', '/');
  ok('GET / → 200', health.status === 200, `status=${health.status}`);

  const config = await req('GET', '/api/config', T);
  ok('GET /api/config → 200', config.status === 200, `status=${config.status}`);

  // ── Inventory ─────────────────────────────────────────────────
  console.log('\n[Inventory]');
  const stock = await req('GET', '/api/inventory/stock', T);
  ok('GET /api/inventory/stock → 200', stock.status === 200, `status=${stock.status}`);

  const suppliers = await req('GET', '/api/inventory/suppliers', T);
  ok('GET /api/inventory/suppliers → 200', suppliers.status === 200, `status=${suppliers.status}`);

  const invPOs = await req('GET', '/api/inventory/purchase-orders', T);
  ok('GET /api/inventory/purchase-orders → 200', invPOs.status === 200, `status=${invPOs.status}`);

  // ── POS ───────────────────────────────────────────────────────
  console.log('\n[POS]');
  const sessions = await req('GET', '/api/pos/sessions', T);
  ok('GET /api/pos/sessions → 200', sessions.status === 200, `status=${sessions.status}`);

  const posOrders = await req('GET', '/api/pos/orders', T);
  ok('GET /api/pos/orders → 200', posOrders.status === 200, `status=${posOrders.status}`);

  const posSummary = await req('GET', '/api/pos/summary?start_date=2026-01-01&end_date=2026-12-31', T);
  ok('GET /api/pos/summary → 200', posSummary.status === 200, `status=${posSummary.status}`);

  // ── Finance ───────────────────────────────────────────────────
  console.log('\n[Finance]');
  const pl = await req('GET', '/api/finance/pl?month=6&year=2026', T);
  ok('GET /api/finance/pl?month=6&year=2026 → 200 + revenue', pl.status === 200 && 'revenue' in (pl.json ?? {}), `status=${pl.status}`);

  const kpi = await req('GET', '/api/finance/kpi', T);
  ok('GET /api/finance/kpi → 200', kpi.status === 200, `status=${kpi.status}`);

  const ar = await req('GET', '/api/finance/ar', T);
  ok('GET /api/finance/ar → 200', ar.status === 200, `status=${ar.status}`);

  const ap = await req('GET', '/api/finance/ap', T);
  ok('GET /api/finance/ap → 200', ap.status === 200, `status=${ap.status}`);

  // ── Ledger ────────────────────────────────────────────────────
  console.log('\n[Ledger]');
  const coa = await req('GET', '/api/ledger/accounts', T);
  ok('GET /api/ledger/accounts → 200', coa.status === 200, `status=${coa.status}`);

  const tb = await req('GET', '/api/ledger/trial-balance', T);
  ok('GET /api/ledger/trial-balance → 200', tb.status === 200, `status=${tb.status}`);

  const journal = await req('GET', '/api/ledger/journal', T);
  ok('GET /api/ledger/journal → 200', journal.status === 200, `status=${journal.status}`);

  const is = await req('GET', '/api/ledger/income-statement?from=2026-01-01&to=2026-06-30', T);
  ok('GET /api/ledger/income-statement → 200', is.status === 200, `status=${is.status}`);

  const bs = await req('GET', '/api/ledger/balance-sheet?as_of=2026-06-30', T);
  ok('GET /api/ledger/balance-sheet → 200', bs.status === 200, `status=${bs.status}`);

  const periods = await req('GET', '/api/ledger/periods', T);
  ok('GET /api/ledger/periods → 200', periods.status === 200, `status=${periods.status}`);

  const budgets = await req('GET', '/api/ledger/budgets', T);
  ok('GET /api/ledger/budgets → 200', budgets.status === 200, `status=${budgets.status}`);

  const costCenters = await req('GET', '/api/ledger/cost-centers', T);
  ok('GET /api/ledger/cost-centers → 200', costCenters.status === 200, `status=${costCenters.status}`);

  // ── Tax Docs ──────────────────────────────────────────────────
  console.log('\n[Tax Docs]');
  const taxInv = await req('GET', '/api/tax-invoices', T);
  ok('GET /api/tax-invoices → 200', taxInv.status === 200, `status=${taxInv.status}`);

  const wht = await req('GET', '/api/wht/certificates', T);
  ok('GET /api/wht/certificates → 200', wht.status === 200, `status=${wht.status}`);

  const taxReports = await req('GET', '/api/tax-reports/output-vat?month=6&year=2026', T);
  ok('GET /api/tax-reports/output-vat → 200', taxReports.status === 200, `status=${taxReports.status}`);

  // ── Bank ──────────────────────────────────────────────────────
  console.log('\n[Bank]');
  const bankAccounts = await req('GET', '/api/bank/accounts', T);
  ok('GET /api/bank/accounts → 200', bankAccounts.status === 200, `status=${bankAccounts.status}`);

  // ── Revenue Rec ───────────────────────────────────────────────
  console.log('\n[Revenue Recognition]');
  const revSched = await req('GET', '/api/revenue/schedules', T);
  ok('GET /api/revenue/schedules → 200', revSched.status === 200, `status=${revSched.status}`);

  const revDeferred = await req('GET', '/api/revenue/deferred', T);
  ok('GET /api/revenue/deferred → 200', revDeferred.status === 200, `status=${revDeferred.status}`);

  // ── FX ────────────────────────────────────────────────────────
  console.log('\n[FX]');
  const fxRates = await req('GET', '/api/fx/rates', T);
  ok('GET /api/fx/rates → 200', fxRates.status === 200, `status=${fxRates.status}`);

  // ── Intercompany ──────────────────────────────────────────────
  console.log('\n[Intercompany]');
  const ic = await req('GET', '/api/intercompany', T);
  ok('GET /api/intercompany → 200', ic.status === 200, `status=${ic.status}`);

  // ── Workflow / SoD ────────────────────────────────────────────
  console.log('\n[Workflow / SoD]');
  const wfDefs = await req('GET', '/api/workflow/definitions', T);
  ok('GET /api/workflow/definitions → 200', wfDefs.status === 200, `status=${wfDefs.status}`);

  const wfApprovals = await req('GET', '/api/workflow/my-approvals', T);
  ok('GET /api/workflow/my-approvals → 200', wfApprovals.status === 200, `status=${wfApprovals.status}`);

  const sodRules = await req('GET', '/api/sod/rules', T);
  ok('GET /api/sod/rules → 200', sodRules.status === 200, `status=${sodRules.status}`);

  // ── 3-way Match ───────────────────────────────────────────────
  console.log('\n[3-way Match]');
  const matchTol = await req('GET', '/api/procurement/match/tolerance', T);
  ok('GET /api/procurement/match/tolerance → 200', matchTol.status === 200, `status=${matchTol.status}`);

  // ── Costing ───────────────────────────────────────────────────
  console.log('\n[Costing]');
  const costCfg = await req('GET', '/api/costing/config', T);
  ok('GET /api/costing/config → 200', costCfg.status === 200, `status=${costCfg.status}`);

  const costVal = await req('GET', '/api/costing/valuation', T);
  ok('GET /api/costing/valuation → 200', costVal.status === 200, `status=${costVal.status}`);

  // ── WMS ───────────────────────────────────────────────────────
  console.log('\n[WMS]');
  const bins = await req('GET', '/api/wms/bins', T);
  ok('GET /api/wms/bins → 200', bins.status === 200, `status=${bins.status}`);

  // ── Procurement ───────────────────────────────────────────────
  console.log('\n[Procurement]');
  const rfqs = await req('GET', '/api/procurement/rfqs', T);
  ok('GET /api/procurement/rfqs → 200', rfqs.status === 200, `status=${rfqs.status}`);

  const replenish = await req('GET', '/api/replenishment/suggestions', T);
  ok('GET /api/replenishment/suggestions → 200', replenish.status === 200, `status=${replenish.status}`);

  // ── CRM ───────────────────────────────────────────────────────
  console.log('\n[CRM]');
  const crmKpi = await req('GET', '/api/crm/branch-kpi', T);
  ok('GET /api/crm/branch-kpi → 200', crmKpi.status === 200, `status=${crmKpi.status}`);

  const mktSegments = await req('GET', '/api/marketing/segments', T);
  ok('GET /api/marketing/segments → 200', mktSegments.status === 200, `status=${mktSegments.status}`);

  const campaigns = await req('GET', '/api/marketing/campaigns', T);
  ok('GET /api/marketing/campaigns → 200', campaigns.status === 200, `status=${campaigns.status}`);

  // ── EPM / Planning ────────────────────────────────────────────
  console.log('\n[EPM Planning]');
  const planVersions = await req('GET', '/api/planning/versions', T);
  ok('GET /api/planning/versions → 200', planVersions.status === 200, `status=${planVersions.status}`);

  // ── Consolidation ─────────────────────────────────────────────
  console.log('\n[Consolidation]');
  const groups = await req('GET', '/api/consolidation/groups', T);
  ok('GET /api/consolidation/groups → 200', groups.status === 200, `status=${groups.status}`);

  // ── Reconciliation ────────────────────────────────────────────
  console.log('\n[Reconciliation]');
  const reconPeriods = await req('GET', '/api/recon/periods', T);
  ok('GET /api/recon/periods → 200', reconPeriods.status === 200, `status=${reconPeriods.status}`);

  // ── Profitability ─────────────────────────────────────────────
  console.log('\n[Profitability]');
  const profitRules = await req('GET', '/api/profitability/rules', T);
  ok('GET /api/profitability/rules → 200', profitRules.status === 200, `status=${profitRules.status}`);

  const profitSegs = await req('GET', '/api/profitability/segments', T);
  ok('GET /api/profitability/segments → 200', profitSegs.status === 200, `status=${profitSegs.status}`);

  // ── Fixed Assets ──────────────────────────────────────────────
  console.log('\n[Fixed Assets]');
  const assets = await req('GET', '/api/assets', T);
  ok('GET /api/assets → 200', assets.status === 200, `status=${assets.status}`);

  const assetCats = await req('GET', '/api/assets/categories', T);
  ok('GET /api/assets/categories → 200', assetCats.status === 200, `status=${assetCats.status}`);

  // ── Pipeline ──────────────────────────────────────────────────
  console.log('\n[Pipeline]');
  // stages is a plain array
  const stages = await req('GET', '/api/pipeline/stages', T);
  ok('GET /api/pipeline/stages → 200 + ≥4 stages', stages.status === 200 && Array.isArray(stages.json) && stages.json.length >= 4, `status=${stages.status} count=${stages.json?.length}`);

  const opps = await req('GET', '/api/pipeline/opportunities', T);
  ok('GET /api/pipeline/opportunities → 200', opps.status === 200, `status=${opps.status}`);

  const fc = await req('GET', '/api/pipeline/forecast', T);
  ok('GET /api/pipeline/forecast → 200 + by_stage', fc.status === 200 && Array.isArray(fc.json?.by_stage), `status=${fc.status}`);

  // create opportunity — response is the opp object directly (not wrapped)
  const newOpp = await req('POST', '/api/pipeline/opportunities', T, { name: 'Smoke Deal', expected_value: 50000, stage_name: 'Qualified' });
  ok('POST /api/pipeline/opportunities → 201 + opp_no', newOpp.status === 201 && !!newOpp.json?.opp_no, `status=${newOpp.status} body=${JSON.stringify(newOpp.json)?.slice(0,80)}`);
  const oppId = newOpp.json?.id;
  if (oppId) {
    const moved = await req('POST', `/api/pipeline/opportunities/${oppId}/move`, T, { stage_name: 'Proposal' });
    ok('POST /api/pipeline/opportunities/:id/move → 200', moved.status === 200, `status=${moved.status}`);
  }

  // ── CPQ ───────────────────────────────────────────────────────
  console.log('\n[CPQ]');
  const configs = await req('GET', '/api/cpq/configs', T);
  ok('GET /api/cpq/configs → 200', configs.status === 200, `status=${configs.status}`);

  const quotes = await req('GET', '/api/cpq/quotes', T);
  ok('GET /api/cpq/quotes → 200', quotes.status === 200, `status=${quotes.status}`);

  // ── Service ───────────────────────────────────────────────────
  console.log('\n[Service]');
  const contracts = await req('GET', '/api/service/contracts', T);
  ok('GET /api/service/contracts → 200', contracts.status === 200, `status=${contracts.status}`);

  const svcSubs = await req('GET', '/api/service/subscriptions', T);
  ok('GET /api/service/subscriptions → 200', svcSubs.status === 200, `status=${svcSubs.status}`);

  // create contract — response is contract object directly
  const newContract = await req('POST', '/api/service/contracts', T, {
    customer_name: 'Smoke Corp', sla_tier: 'Gold', start_date: '2026-01-01', end_date: '2026-12-31', monthly_value: 10000,
  });
  ok('POST /api/service/contracts → 201 + contract_no', newContract.status === 201 && !!newContract.json?.contract_no, `status=${newContract.status}`);
  const cid = newContract.json?.id;
  if (cid) {
    const evt = await req('POST', `/api/service/contracts/${cid}/events`, T, { title: 'Smoke Incident', priority: 'P2' });
    ok('POST /api/service/contracts/:id/events → 201', evt.status === 201, `status=${evt.status}`);
  }

  // ── BI ────────────────────────────────────────────────────────
  console.log('\n[BI]');
  const biKpi = await req('GET', '/api/bi/kpi', T);
  ok('GET /api/bi/kpi → 200 + pipeline field', biKpi.status === 200 && 'pipeline' in (biKpi.json ?? {}), `status=${biKpi.status}`);

  const salesCube = await req('GET', '/api/bi/sales-cube?period=month&months=3', T);
  ok('GET /api/bi/sales-cube → 200 + period_type=month', salesCube.status === 200 && salesCube.json?.period_type === 'month', `status=${salesCube.status}`);

  const finTrend = await req('GET', '/api/bi/finance-trend?months=3', T);
  ok('GET /api/bi/finance-trend → 200 + months=3', finTrend.status === 200 && finTrend.json?.months === 3, `status=${finTrend.status}`);

  const pipeTrend = await req('GET', '/api/bi/pipeline-trend?months=3', T);
  ok('GET /api/bi/pipeline-trend → 200', pipeTrend.status === 200, `status=${pipeTrend.status}`);

  const snap = await req('POST', '/api/bi/snapshots/refresh', T, {});
  ok('POST /api/bi/snapshots/refresh → 200 + date', snap.status === 200 && !!snap.json?.date, `status=${snap.status}`);

  const snaps = await req('GET', '/api/bi/snapshots?days=1', T);
  ok('GET /api/bi/snapshots → 200 + count ≥ 1', snaps.status === 200 && snaps.json?.count >= 1, `status=${snaps.status} count=${snaps.json?.count}`);

  const subCreate = await req('POST', '/api/bi/subscriptions', T, { name: 'Smoke Sub', report_type: 'kpi_board', frequency: 'daily', recipients: [{ email: 'test@example.com' }] });
  ok('POST /api/bi/subscriptions → 201', subCreate.status === 201 && !!subCreate.json?.id, `status=${subCreate.status}`);
  if (subCreate.json?.id) {
    const subDel = await req('DELETE', `/api/bi/subscriptions/${subCreate.json.id}`, T);
    ok('DELETE /api/bi/subscriptions/:id → 200', subDel.status === 200, `status=${subDel.status}`);
  }

  // ── AI Copilot ────────────────────────────────────────────────
  console.log('\n[AI Copilot]');
  // POST /api/chat is the copilot endpoint (requires message body)
  const chatHealth = await req('POST', '/api/chat', T, { message: 'ping' });
  ok('POST /api/chat → not 404 (copilot endpoint exists)', chatHealth.status !== 404, `status=${chatHealth.status}`);

  // ── Dashboard ─────────────────────────────────────────────────
  console.log('\n[Dashboard]');
  const dash = await req('GET', '/api/dashboard', T);
  ok('GET /api/dashboard → 200', dash.status === 200, `status=${dash.status}`);

  const salesTrend = await req('GET', '/api/dashboard/sales-trend', T);
  ok('GET /api/dashboard/sales-trend → 200', salesTrend.status === 200, `status=${salesTrend.status}`);

  // ── Menu / Restaurant ─────────────────────────────────────────
  console.log('\n[Restaurant / Menu]');
  const menuList = await req('GET', '/api/menu', T);
  ok('GET /api/menu → 200', menuList.status === 200, `status=${menuList.status}`);

  const menuCats = await req('GET', '/api/menu/categories', T);
  ok('GET /api/menu/categories → 200', menuCats.status === 200, `status=${menuCats.status}`);

  const tables = await req('GET', '/api/restaurant/tables', T);
  ok('GET /api/restaurant/tables → 200', tables.status === 200, `status=${tables.status}`);

  const kds = await req('GET', '/api/restaurant/kds/feed', T);
  ok('GET /api/restaurant/kds/feed → 200', kds.status === 200, `status=${kds.status}`);

  // ── Loyalty ───────────────────────────────────────────────────
  console.log('\n[Loyalty]');
  const loyaltyConfig = await req('GET', '/api/loyalty/config', T);
  ok('GET /api/loyalty/config → 200', loyaltyConfig.status === 200, `status=${loyaltyConfig.status}`);

  // ── Platform ──────────────────────────────────────────────────
  console.log('\n[Platform]');
  const apiKeys = await req('GET', '/api/platform/api-keys', T);
  ok('GET /api/platform/api-keys → 200', apiKeys.status === 200, `status=${apiKeys.status}`);

  const webhooks = await req('GET', '/api/platform/webhooks', T);
  ok('GET /api/platform/webhooks → 200', webhooks.status === 200, `status=${webhooks.status}`);

  // ── Analytics ─────────────────────────────────────────────────
  console.log('\n[Analytics]');
  const replenList = await req('GET', '/api/analytics/replenishment', T);
  ok('GET /api/analytics/replenishment → 200', replenList.status === 200, `status=${replenList.status}`);

  // ── Reports ───────────────────────────────────────────────────
  console.log('\n[Reports]');
  const dailySales = await req('GET', '/api/reports/daily-sales', T);
  ok('GET /api/reports/daily-sales → 200', dailySales.status === 200, `status=${dailySales.status}`);

  const stockSummary = await req('GET', '/api/reports/stock-summary', T);
  ok('GET /api/reports/stock-summary → 200', stockSummary.status === 200, `status=${stockSummary.status}`);

  // ── Auth guard ────────────────────────────────────────────────
  console.log('\n[Auth guard]');
  const noAuth = await req('GET', '/api/ledger/accounts');
  ok('GET /api/ledger/accounts without token → 401', noAuth.status === 401, `status=${noAuth.status}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => {
  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.filter((c) => !c.ok).length;
  console.log(`\n${'═'.repeat(60)}`);
  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
  console.log(`${'═'.repeat(60)}\n${pass}/${checks.length} passed${fail ? `  ← ${fail} FAILED` : ' 🎉'}\n`);
  if (fail) process.exit(1);
});
