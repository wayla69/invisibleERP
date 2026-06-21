/**
 * Parallel-run shadow diff — ยิง endpoint เดียวกันไปทั้ง V1 (FastAPI) และ V2 (NestJS) แล้ว diff JSON.
 * ใช้ตอน cutover เพื่อยืนยัน read-parity บนข้อมูล/สภาพแวดล้อมจริง (ดู docs/08-cutover-runbook.md).
 *   V1_URL=http://v1-host V2_URL=http://v2-host V1_TOKEN=... V2_TOKEN=... pnpm --filter @ierp/cutover shadow
 */
const V1 = process.env.V1_URL;
const V2 = process.env.V2_URL;

// read endpoints ที่คงสัญญาเดิม (V1↔V2 ควรเท่ากัน byte-for-byte ยกเว้นที่จงใจแก้)
const ENDPOINTS = [
  '/api/config',
  '/api/dashboard',
  '/api/pos/summary?start_date=2000-01-01&end_date=2100-01-01',
  '/api/pos/orders?limit=20',
  '/api/inventory/stock?limit=50',
  '/api/inventory/suppliers',
  '/api/inventory/purchase-orders?limit=20',
  '/api/finance/kpi',
  '/api/finance/ar?limit=20',
  '/api/reports/stock-summary',
  '/api/notifications',
];
// คีย์ที่จงใจต่าง (เวลา/่token) — ข้ามตอน diff
const IGNORE = new Set(['generated_at', 'as_of', 'token', 'snapshot_date']);

function normalize(x: any): any {
  if (Array.isArray(x)) return x.map(normalize);
  if (x && typeof x === 'object') {
    const o: any = {};
    for (const k of Object.keys(x).sort()) if (!IGNORE.has(k)) o[k] = normalize(x[k]);
    return o;
  }
  return x;
}
function diff(a: any, b: any, path = ''): string[] {
  const an = normalize(a), bn = normalize(b);
  if (JSON.stringify(an) === JSON.stringify(bn)) return [];
  // shallow path drill for readable output
  if (an && bn && typeof an === 'object' && !Array.isArray(an)) {
    const out: string[] = [];
    for (const k of new Set([...Object.keys(an), ...Object.keys(bn)])) out.push(...diff(an[k], bn[k], `${path}.${k}`));
    return out.length ? out : [`${path}: differ`];
  }
  return [`${path}: ${JSON.stringify(an)} ≠ ${JSON.stringify(bn)}`];
}
async function get(base: string, ep: string, token?: string) {
  const res = await fetch(`${base}${ep}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  if (!V1 || !V2) {
    console.log('usage: V1_URL=.. V2_URL=.. [V1_TOKEN=.. V2_TOKEN=..] pnpm --filter @ierp/cutover shadow');
    console.log('  เทียบ', ENDPOINTS.length, 'read endpoints ระหว่าง V1 และ V2 (รันตอน parallel-run, Phase 6)');
    process.exit(2);
  }
  let mismatches = 0;
  for (const ep of ENDPOINTS) {
    const [r1, r2] = await Promise.all([get(V1, ep, process.env.V1_TOKEN), get(V2, ep, process.env.V2_TOKEN)]);
    const d = r1.status !== r2.status ? [`status ${r1.status} ≠ ${r2.status}`] : diff(r1.json, r2.json);
    if (d.length) { mismatches++; console.log(`❌ ${ep}`); d.slice(0, 8).forEach((x) => console.log(`     ${x}`)); }
    else console.log(`✅ ${ep}`);
  }
  console.log(mismatches ? `\n❌ ${mismatches}/${ENDPOINTS.length} endpoints differ` : `\n✅ all ${ENDPOINTS.length} endpoints match`);
  process.exit(mismatches ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
