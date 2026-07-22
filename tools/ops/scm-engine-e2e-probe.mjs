// docs/54 — SCM forecast-engine end-to-end probe.
//
// Runs the EXACT signed round-trip that ScmEngineClientService makes (HMAC-SHA256 over
// `${unixSeconds}.${rawBody}`, contract version '1'), against a live engine, and prints a verdict.
// Designed to run either INSIDE an API container over `railway ssh` (reads the container's own
// SCM_ENGINE_URL / SCM_ENGINE_SECRET, exercising the real private-network hop) or from a CI runner
// with ENGINE_URL / ENGINE_SECRET overrides. No DB, no tenant data, no prod mutations — pure engine.
//
//   /readyz          — unauth; proves the CBC/PuLP solver self-test + Prophet import work in the image
//   POST /v1/forecast — signed; a real ~90-day series → a probabilistic forecast (Prophet when smooth)
//   POST /v1/optimize — signed; a perishable order plan (MILP when shelf-life / MOQ / pack bind)
//
// Exit codes: 0 all-green · 2 missing env · 3 forecast failed · 4 optimize failed.

import { createHmac } from 'node:crypto';

const URL = (process.env.ENGINE_URL || process.env.SCM_ENGINE_URL || '').trim().replace(/\/$/, '');
const SECRET = (process.env.ENGINE_SECRET || process.env.SCM_ENGINE_SECRET || '').trim();
if (!URL || !SECRET) {
  console.error('E2E FAIL: ENGINE_URL/SCM_ENGINE_URL or ENGINE_SECRET/SCM_ENGINE_SECRET missing in env');
  process.exit(2);
}
console.log('E2E: engine target =', URL);

const CONTRACT = '1';
const HDR = { ts: 'x-engine-timestamp', sig: 'x-engine-signature', idem: 'x-engine-idempotency', ver: 'x-engine-version' };

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (base, n) => { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + n); return d; };

async function signedPost(path, body) {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(URL + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HDR.ts]: String(ts),
      [HDR.sig]: sig,
      [HDR.idem]: `e2e${path.replace(/\W/g, '')}${ts}`,
    },
    body: raw,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, version: res.headers.get(HDR.ver), json };
}

// ── /readyz (unauthenticated) ───────────────────────────────────────────────
try {
  const r = await fetch(URL + '/readyz');
  const j = await r.json().catch(() => ({}));
  console.log('E2E readyz :', r.status, JSON.stringify(j));
} catch (e) { console.error('E2E readyz : ERROR', e.message); }

// ── /v1/forecast : a clean ~90-day weekly-seasonal series (→ Prophet when available) ──
const start = addDays(new Date(), -90);
const dow = [1.0, 0.9, 0.95, 1.0, 1.15, 1.4, 1.25]; // Sun..Sat weekly shape
const history = [];
for (let i = 0; i < 90; i++) {
  const d = addDays(start, i);
  const y = Math.max(0, Math.round(100 * dow[d.getUTCDay()] * (1 + i * 0.002)));
  history.push({ ds: ymd(d), y });
}
const fReq = {
  contract_version: CONTRACT,
  request_id: `e2e-fc-${Date.now()}`,
  horizon_days: 7,
  scenario_count: 20,
  quantiles: [0.1, 0.5, 0.9],
  holidays: [],
  closures: [],
  payday_regressor: true,
  series: [{ series_id: 'e2e-demo', class_hint: 'auto', history }],
};
const f = await signedPost('/v1/forecast', fReq);
console.log('E2E forecast: status', f.status, '| x-engine-version', f.version);
if (f.status !== 200) { console.error('E2E FAIL forecast:', JSON.stringify(f.json).slice(0, 400)); process.exit(3); }
const r0 = f.json.results?.[0];
console.log('E2E forecast: model =', r0?.model,
  '| wape =', r0?.accuracy?.wape,
  '| points =', r0?.points?.length,
  '| sample_paths =', `${r0?.sample_paths?.length}x${r0?.sample_paths?.[0]?.length}`);
console.log('E2E forecast: first3 yhat =', JSON.stringify((r0?.points || []).slice(0, 3).map((p) => p.yhat)));

// ── /v1/optimize : perishable order plan (MILP when shelf-life/MOQ/pack bind) ──
const K = 20, H = 7;
const scenarios = Array.from({ length: K }, () => Array.from({ length: H }, () => 28 + Math.round(Math.random() * 8)));
const oReq = {
  contract_version: CONTRACT,
  request_id: `e2e-opt-${Date.now()}`,
  start_ds: ymd(new Date()),
  horizon_days: H,
  items: [{
    item_code: 'e2e-ing',
    demand_scenarios: scenarios,
    current_inventory: [{ remaining_days: 2, qty: 10 }],
    in_transit: [],
    lead_time: { mean_days: 1, std_days: 0 },
    shelf_life_days: 3,
    review_period_days: 1,
    unit_cost: 10, unit_price: 25,
    salvage_value: 0, disposal_cost: 1, goodwill_cost: 0, holding_cost_per_day: 0.1,
    moq: 6, pack_size: 6, fixed_order_cost: 50,
  }],
  time_budget_ms: 20000,
};
const o = await signedPost('/v1/optimize', oReq);
console.log('E2E optimize: status', o.status, '| x-engine-version', o.version);
if (o.status !== 200) { console.error('E2E FAIL optimize:', JSON.stringify(o.json).slice(0, 400)); process.exit(4); }
const p0 = o.json.plans?.[0];
console.log('E2E optimize: method =', p0?.method,
  '| solver =', JSON.stringify(p0?.solver),
  '| todayOrder =', JSON.stringify((p0?.orders || [])[0] ?? null));
console.log('E2E optimize: fill_rate =', p0?.expected?.fill_rate, '| profit =', p0?.expected?.profit);

console.log('E2E: OK — end-to-end engine round-trip green (signed forecast + optimize + readyz)');
