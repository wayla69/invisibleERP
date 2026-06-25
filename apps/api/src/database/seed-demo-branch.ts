/**
 * Demo multi-branch for the Oshinei tenant: 2-3 physical outlets, with the
 * existing POS sales tagged to a branch (weighted to the flagship) so the
 * consolidation / per-branch revenue report shows real numbers. Idempotent.
 *
 * Requires sales: `pnpm --filter @ierp/api db:seed:demo:sales`
 * Run: `pnpm --filter @ierp/api db:seed:demo:branch`  (run AFTER :sales — sales re-seed clears branch tags)
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import * as schema from './schema';

for (const p of ['.env', resolve(process.cwd(), '../../.env')]) {
  try { (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(p); } catch { /* ignore */ }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(135790);

const BRANCHES = [
  { code: 'TH-THL', name: 'สาขาทองหล่อ (Thonglor Flagship)', hq: true, weight: 0.45, address: '88 ทองหล่อ ซ.10 เขตวัฒนา กรุงเทพฯ', phone: '02-712-0010' },
  { code: 'TH-SIAM', name: 'สาขาสยามพารากอน (Siam Paragon)', hq: false, weight: 0.32, address: 'ชั้น 4 สยามพารากอน เขตปทุมวัน กรุงเทพฯ', phone: '02-610-0020' },
  { code: 'TH-EKM', name: 'สาขาเอกมัย (Ekkamai)', hq: false, weight: 0.23, address: '120 สุขุมวิท 63 เขตวัฒนา กรุงเทพฯ', phone: '02-714-0030' },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    const tenant = (await tx.select().from(schema.tenants).where(eq(schema.tenants.code, 'OSHINEI')))[0];
    if (!tenant) throw new Error('OSHINEI tenant not found — run db:seed:demo first');
    const T = tenant.id;

    // ── branches (recreate) ──
    await tx.delete(schema.branches).where(eq(schema.branches.tenantId, T));
    await tx.insert(schema.branches).values(BRANCHES.map((b) => ({ tenantId: T, code: b.code, name: b.name, isHq: b.hq, address: b.address, phone: b.phone, active: true, createdBy: 'branch-demo' })));
    const rows = await tx.select().from(schema.branches).where(eq(schema.branches.tenantId, T));
    const idByCode = new Map(rows.map((r) => [r.code, r.id]));

    // ── tag existing POS sales to a branch (weighted) ──
    const sales = await tx.select({ id: schema.custPosSales.id }).from(schema.custPosSales).where(eq(schema.custPosSales.tenantId, T));
    const buckets = new Map<string, number[]>(BRANCHES.map((b) => [b.code, []]));
    const cum: [string, number][] = []; let acc = 0;
    for (const b of BRANCHES) { acc += b.weight; cum.push([b.code, acc]); }
    for (const s of sales) { const r = rnd() * acc; const code = cum.find(([, c]) => r <= c)![0]; buckets.get(code)!.push(s.id); }
    const dist: Record<string, number> = {};
    for (const [code, ids] of buckets) {
      dist[code] = ids.length;
      const bid = idByCode.get(code)!;
      for (let i = 0; i < ids.length; i += 500) await tx.update(schema.custPosSales).set({ branchId: bid }).where(inArray(schema.custPosSales.id, ids.slice(i, i + 500)));
    }

    console.log(`✅ Multi-branch seeded into tenant ${T}:`);
    console.log(`   ${BRANCHES.length} branches · ${sales.length} sales tagged`);
    console.log(`   ${BRANCHES.map((b) => `${b.code} ${dist[b.code]}`).join(' · ')}`);
  });
  await client.end();
}

main().catch((e) => { console.error('Branch seed failed:', e); process.exit(1); });
