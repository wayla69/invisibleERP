/**
 * Phase D3 — multi-level MRP over PGlite.
 * Proves the MRP run now explodes BOMs RECURSIVELY (multi-level), nets every level against on-hand,
 * emits planned Make orders at each level + Buy orders for leaves, turns the planned Buy into a real PR
 * (plan-to-pr), and guards against circular BOMs.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover mrp
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mrp-secret';
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
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

  // ── 2-level BOM: CAKE → SPONGE (make) + FROSTING (buy); SPONGE → FLOUR + EGG (buy) ──
  const cake = await db.insert(s.bomMaster).values({ bomCode: 'BOM-CAKE', productName: 'เค้ก', yieldQty: '1', yieldUom: 'ชิ้น' }).returning({ id: s.bomMaster.id });
  await db.insert(s.bomMasterLines).values([
    { bomId: Number(cake[0].id), itemId: 'SPONGE', itemDescription: 'เนื้อเค้ก', useUom: 'ชิ้น', qtyUseUom: '1', unitCost: '0', lineCost: '0' },
    { bomId: Number(cake[0].id), itemId: 'FROSTING', itemDescription: 'ครีม', useUom: 'kg', qtyUseUom: '1', unitCost: '0', lineCost: '0' },
  ]);
  const sponge = await db.insert(s.bomMaster).values({ bomCode: 'SPONGE', productName: 'เนื้อเค้ก', yieldQty: '1', yieldUom: 'ชิ้น' }).returning({ id: s.bomMaster.id });
  await db.insert(s.bomMasterLines).values([
    { bomId: Number(sponge[0].id), itemId: 'FLOUR', itemDescription: 'แป้ง', useUom: 'kg', qtyUseUom: '2', unitCost: '0', lineCost: '0' },
    { bomId: Number(sponge[0].id), itemId: 'EGG', itemDescription: 'ไข่', useUom: 'ฟอง', qtyUseUom: '3', unitCost: '0', lineCost: '0' },
  ]);
  // circular BOM: BOM-X ↔ BOM-Y
  const bx = await db.insert(s.bomMaster).values({ bomCode: 'BOM-X', productName: 'X', yieldQty: '1' }).returning({ id: s.bomMaster.id });
  const by = await db.insert(s.bomMaster).values({ bomCode: 'BOM-Y', productName: 'Y', yieldQty: '1' }).returning({ id: s.bomMaster.id });
  await db.insert(s.bomMasterLines).values([{ bomId: Number(bx[0].id), itemId: 'BOM-Y', qtyUseUom: '1', unitCost: '0', lineCost: '0' }]);
  await db.insert(s.bomMasterLines).values([{ bomId: Number(by[0].id), itemId: 'BOM-X', qtyUseUom: '1', unitCost: '0', lineCost: '0' }]);

  // on-hand snapshot: SPONGE 4, FLOUR 5 (net at sub-assembly + leaf levels)
  const snapDate = new Date('2026-06-20T00:00:00Z');
  await db.insert(s.stockSnapshots).values([
    { generateDate: snapDate, itemId: 'SPONGE', itemDescription: 'เนื้อเค้ก', uom: 'ชิ้น', avQty: '4', totalStock: '4' },
    { generateDate: snapDate, itemId: 'FLOUR', itemDescription: 'แป้ง', uom: 'kg', avQty: '5', totalStock: '5' },
  ]);
  // item master with lot-sizing policies: FLOUR=min-order, EGG=order-multiple, FROSTING=EOQ
  await db.insert(s.items).values([
    { itemId: 'FLOUR', itemDescription: 'แป้ง', minOrderQty: '20', orderMultiple: '0', avgDailyUsage: '0', orderCost: '0', holdingCost: '0' },
    { itemId: 'EGG', itemDescription: 'ไข่', minOrderQty: '0', orderMultiple: '12', avgDailyUsage: '0', orderCost: '0', holdingCost: '0' },
    { itemId: 'FROSTING', itemDescription: 'ครีม', minOrderQty: '0', orderMultiple: '0', avgDailyUsage: '1', orderCost: '40', holdingCost: '5' },
  ]).onConflictDoNothing();
  // routing for BOM-CAKE: MIX (setup 30 + 5/unit) + BAKE (10/unit) — for rough-cut capacity
  const rt = await db.insert(s.routings).values({ routingCode: 'RT-CAKE', productItemId: 'BOM-CAKE', name: 'Cake routing' }).returning({ id: s.routings.id });
  await db.insert(s.routingOperations).values([
    { routingId: Number(rt[0].id), opNo: '10', workCenter: 'MIX', setupMin: '30', runMinPerUnit: '5' },
    { routingId: Number(rt[0].id), opNo: '20', workCenter: 'BAKE', setupMin: '0', runMinPerUnit: '10' },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'pw' })).json.token as string;

  // ── 1. multi-level run: demand 10 CAKE (on-hand 0) ──
  const run = await inj('POST', '/api/mrp/run', admin, { demand: [{ item_id: 'BOM-CAKE', qty: 10 }] });
  const make = (id: string) => (run.json.planned_make ?? []).find((m: any) => m.item_id === id);
  const buy = (id: string) => (run.json.planned_buy ?? []).find((b: any) => b.item_id === id);
  ok('Make orders at 2 levels: CAKE (L0) + SPONGE (L1)', make('BOM-CAKE')?.level === 0 && make('SPONGE')?.level === 1, JSON.stringify(run.json.planned_make));
  ok('Multi-level explosion: SPONGE net 6 (10 − on-hand 4)', near(make('SPONGE')?.qty, 6), `sponge=${make('SPONGE')?.qty}`);
  ok('Leaf buy netted at sub-level: FLOUR 7 (gross 12 − on-hand 5)', near(buy('FLOUR')?.qty, 7) && near(buy('FLOUR')?.gross_qty, 12), JSON.stringify(buy('FLOUR')));
  ok('Leaf buy: EGG 18 (6×3)', near(buy('EGG')?.qty, 18), `egg=${buy('EGG')?.qty}`);
  ok('Leaf buy: FROSTING 10 (10×1)', near(buy('FROSTING')?.qty, 10), `frosting=${buy('FROSTING')?.qty}`);
  ok('Summary max_level = 1', run.json.summary?.max_level === 1, JSON.stringify(run.json.summary));

  // ── 2. plan-to-pr: planned Buy → a real PR ──
  const ptp = await inj('POST', '/api/mrp/plan-to-pr', admin, { demand: [{ item_id: 'BOM-CAKE', qty: 10 }] });
  ok('plan-to-pr → PR created (PR-…)', /^PR-/.test(ptp.json.pr_no ?? ''), `${ptp.status} ${ptp.json.pr_no}`);
  ok('plan-to-pr → 3 buy lines on the plan', (ptp.json.planned_buy?.length ?? 0) === 3, JSON.stringify(ptp.json.planned_buy?.map((b: any) => b.item_id)));
  const prLines = (await pg.query(`SELECT pi.item_id, pi.request_qty FROM pr_items pi JOIN purchase_requests pr ON pi.pr_id=pr.id WHERE pr.pr_no='${ptp.json.pr_no}'`)).rows as any[];
  ok('PR persisted with the planned buy lines (FLOUR/EGG/FROSTING)', prLines.length === 3 && prLines.some((l) => l.item_id === 'FLOUR'), JSON.stringify(prLines));

  // ── 3. circular BOM guarded ──
  const circ = await inj('POST', '/api/mrp/run', admin, { demand: [{ item_id: 'BOM-X', qty: 1 }] });
  ok('Circular BOM → 400 CIRCULAR_BOM', circ.status === 400 && circ.json.error?.code === 'CIRCULAR_BOM', `${circ.status} ${circ.json.error?.code}`);

  // ── 4. lot-sizing: net qty raised to min-order / order-multiple / EOQ ──
  const ls = await inj('POST', '/api/mrp/run', admin, { demand: [{ item_id: 'BOM-CAKE', qty: 10 }], lot_sizing: true });
  const lb = (id: string) => (ls.json.planned_buy ?? []).find((b: any) => b.item_id === id);
  ok('Lot-size FLOUR → min-order 20 (net 7 < min)', near(lb('FLOUR')?.ordered_qty, 20) && lb('FLOUR')?.lot_policy === 'min', JSON.stringify(lb('FLOUR')));
  ok('Lot-size EGG → round up to multiple 24 (net 18, mult 12)', near(lb('EGG')?.ordered_qty, 24) && lb('EGG')?.lot_policy === 'multiple', JSON.stringify(lb('EGG')));
  ok('Lot-size FROSTING → EOQ 77 (net 10 < eoq)', near(lb('FROSTING')?.ordered_qty, 77) && near(lb('FROSTING')?.eoq, 77) && lb('FROSTING')?.lot_policy === 'eoq', JSON.stringify(lb('FROSTING')));

  // ── 5. rough-cut capacity: load per work-centre vs available minutes ──
  const cap = await inj('POST', '/api/mrp/capacity', admin, { demand: [{ item_id: 'BOM-CAKE', qty: 10 }], work_centers: [{ code: 'MIX', available_minutes: 100 }, { code: 'BAKE', available_minutes: 60 }] });
  const wc = (code: string) => (cap.json.work_centers ?? []).find((w: any) => w.work_center === code);
  ok('Capacity MIX load 80 (30 setup + 5×10), not overloaded', near(wc('MIX')?.load_minutes, 80) && wc('MIX')?.overloaded === false, JSON.stringify(wc('MIX')));
  ok('Capacity BAKE load 100 (10×10) > 60 → overloaded', near(wc('BAKE')?.load_minutes, 100) && wc('BAKE')?.overloaded === true, JSON.stringify(wc('BAKE')));
  ok('Capacity summary: 1 overloaded centre', cap.json.summary?.overloaded === 1, JSON.stringify(cap.json.summary));

  await app.close();
  await pg.close();

  console.log('\n── Phase D3 — multi-level MRP (เผื่อ BOM หลายชั้น → PR) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} mrp checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} mrp checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
