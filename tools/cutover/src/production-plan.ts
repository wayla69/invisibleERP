/**
 * C10 — Production plan: demand-ML forecast (auto-selected model + WAPE) with a day-of-week fallback for
 * thin history → BOM → prep list + ingredient buy list, and one-click draft PO. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover production-plan
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pp-secret';
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
const ALGOS = ['sma', 'ses', 'holt', 'seasonal_naive', 'croston'];
const dayAgo = (n: number) => new Date(Date.now() + 7 * 3600 * 1000 - n * 86400_000).toISOString().slice(0, 10); // Asia/Bangkok day, n days ago

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'boss', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }]).onConflictDoNothing();

  const mk = async (sku: string, name: string) => Number((await db.insert(s.menuItems).values({ tenantId: t1, sku, name, price: '100', active: true, isAvailable: true }).returning({ id: s.menuItems.id }))[0].id);
  const steady = await mk('STEADY', 'เมนูขายสม่ำเสมอ'), thin = await mk('THIN', 'เมนูใหม่');
  const recipe = async (menuItemId: number, sku: string, lines: { id: string; qty: number; cost: number }[]) => {
    const recId = Number((await db.insert(s.menuRecipes).values({ tenantId: t1, menuItemId, sku, yieldQty: '1', postCogs: false, active: true }).returning({ id: s.menuRecipes.id }))[0].id);
    for (const l of lines) await db.insert(s.menuRecipeLines).values({ tenantId: t1, recipeId: recId, ingredientItemId: l.id, ingredientDescription: l.id, qtyPer: String(l.qty), unitCost: String(l.cost) });
  };
  await recipe(steady, 'STEADY', [{ id: 'beef', qty: 2, cost: 50 }]);
  await recipe(thin, 'THIN', [{ id: 'rice', qty: 1, cost: 5 }]);
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'beef', itemDescription: 'เนื้อ', currentStock: '5', reorderPoint: '4', reorderQty: '10' },
    { tenantId: t1, itemId: 'rice', itemDescription: 'ข้าว', currentStock: '9999', reorderPoint: '0', reorderQty: '0' },
  ]);
  // STEADY: 40 consecutive days of qty 10 (a constant series → every model forecasts 10 → enough to model)
  const seed = async (sku: string, date: string, qty: number) => {
    const [sale] = await db.insert(s.custPosSales).values({ saleNo: `S-${sku}-${date}`, saleDate: date, tenantId: t1, status: 'Completed', subtotal: '0', total: '0' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(sale.id), itemId: sku, itemDescription: sku, qty: String(qty), unitPrice: '100', amount: String(qty * 100) });
  };
  for (let i = 0; i <= 39; i++) await seed('STEADY', dayAgo(i), 10); // incl. today → a clean constant series
  for (let i = 1; i <= 3; i++) await seed('THIN', dayAgo(i), 4);     // only 3 days → below the modelling threshold

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init(); // booting the full AppModule also validates the demand-ML wiring into the menu module (DI / no cycle)
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).json();
  const post = async (url: string, payload: any) => { const r = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload }); return { status: r.statusCode, json: r.json() }; };

  const plan = await get(`/api/menu/production-plan?days=1&lookback=28`);
  const prep = Object.fromEntries((plan.prep ?? []).map((p: any) => [p.sku, p]));

  // ── 1. demand-ML forecast: STEADY (constant 10/day) → an auto-selected model forecasts 10, with a WAPE ──
  ok('demand-ML: STEADY → forecast 10 via an auto-selected model (with measured WAPE)',
    String(plan.forecast_method).includes('demand-ML') && prep.STEADY?.forecast_qty === 10 && ALGOS.includes(prep.STEADY?.model) && typeof prep.STEADY?.forecast_wape === 'number',
    JSON.stringify({ method: plan.forecast_method, fc: prep.STEADY?.forecast_qty, model: prep.STEADY?.model, wape: prep.STEADY?.forecast_wape }));

  // ── 2. thin-history dish falls back to the transparent day-of-week model ──
  ok('thin history: THIN (3 days) → day-of-week fallback model', prep.THIN?.model === 'day-of-week', JSON.stringify({ model: prep.THIN?.model }));

  // ── 3. BOM explosion off the ML forecast: beef 2×10 = 20 needed ──
  const beef = (plan.ingredients ?? []).find((i: any) => i.item_id === 'beef');
  ok('BOM off the forecast: beef required 2×10 = 20', near(beef?.required, 20), JSON.stringify({ req: beef?.required }));

  // ── 4. buy list: beef short (stock 5 vs 20) → pack-rounded order with unit cost ──
  const po = (plan.purchase_orders ?? []).find((i: any) => i.item_id === 'beef');
  ok('buy list: beef order 20 (pack 10), unit_price 50; rice not ordered',
    near(po?.order_qty, 20) && near(po?.unit_price, 50) && !(plan.purchase_orders ?? []).some((i: any) => i.item_id === 'rice'),
    JSON.stringify({ order: po?.order_qty, price: po?.unit_price }));

  // ── 5. one-click draft PO from the buy list ──
  const poRes = await post('/api/procurement/pos', { vendor_name: 'ตลาดเนื้อ', remarks: 'auto from production plan', items: plan.purchase_orders.map((i: any) => ({ item_id: i.item_id, item_description: i.description, order_qty: i.order_qty, unit_price: i.unit_price, ...(i.uom ? { uom: i.uom } : {}) })) });
  ok('one-click PO: buy list → POST /api/procurement/pos (PO-…, total 20×50=1000)',
    (poRes.status === 200 || poRes.status === 201) && /^PO-/.test(poRes.json.po_no ?? '') && near(poRes.json.total_amount, 1000),
    JSON.stringify({ po: poRes.json.po_no, total: poRes.json.total_amount }));

  console.log('\n── C10 — Production plan (demand-ML forecast + one-click PO) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} production-plan checks failed` : `\n✅ All ${checks.length} production-plan checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
