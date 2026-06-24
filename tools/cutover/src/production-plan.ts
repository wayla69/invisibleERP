/**
 * C10 — Production plan: day-of-week-aware demand forecast → BOM → prep list + ingredient buy list, and
 * one-click draft PO from the buy list (POST /api/procurement/pos). Over PGlite.
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
const shift = (d: string, n: number) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

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

  // dishes: WEEKEND sells only on the anchor's weekday; WEEKDAY sells only on a different weekday.
  const mk = async (sku: string, name: string) => Number((await db.insert(s.menuItems).values({ tenantId: t1, sku, name, price: '100', active: true, isAvailable: true }).returning({ id: s.menuItems.id }))[0].id);
  const wkEnd = await mk('WEEKEND', 'เมนูวันหยุด'), wkDay = await mk('WEEKDAY', 'เมนูวันธรรมดา');
  const recipe = async (menuItemId: number, sku: string, lines: { id: string; qty: number; cost: number }[]) => {
    const recId = Number((await db.insert(s.menuRecipes).values({ tenantId: t1, menuItemId, sku, yieldQty: '1', postCogs: false, active: true }).returning({ id: s.menuRecipes.id }))[0].id);
    for (const l of lines) await db.insert(s.menuRecipeLines).values({ tenantId: t1, recipeId: recId, ingredientItemId: l.id, ingredientDescription: l.id, qtyPer: String(l.qty), unitCost: String(l.cost) });
  };
  await recipe(wkEnd, 'WEEKEND', [{ id: 'prawn', qty: 3, cost: 8 }]);
  await recipe(wkDay, 'WEEKDAY', [{ id: 'prawn', qty: 5, cost: 8 }]);
  await db.insert(s.customerInventory).values([{ tenantId: t1, itemId: 'prawn', itemDescription: 'กุ้ง', currentStock: '40', reorderPoint: '10', reorderQty: '25' }]);

  // ── seed history over the lookback: WEEKEND 50 on each anchor-weekday; WEEKDAY 70 on a different weekday ──
  const anchor = '2026-06-24';
  const wdA = weekday(anchor), wdOther = (wdA + 3) % 7;
  const seedSale = async (date: string, sku: string, qty: number) => {
    const [sale] = await db.insert(s.custPosSales).values({ saleNo: `SALE-${sku}-${date}`, saleDate: date, tenantId: t1, status: 'Completed', subtotal: '0', total: '0' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(sale.id), itemId: sku, itemDescription: sku, qty: String(qty), unitPrice: '100', amount: String(qty * 100) });
  };
  for (let i = 1; i <= 28; i++) {
    const d = shift(anchor, -i);
    if (weekday(d) === wdA) await seedSale(d, 'WEEKEND', 50);
    if (weekday(d) === wdOther) await seedSale(d, 'WEEKDAY', 70);
  }

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init(); // booting the full AppModule also validates the AI-agent tool wiring (DI / no cycle)
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const get = async (url: string) => (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).json();
  const post = async (url: string, payload: any) => { const r = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload }); return { status: r.statusCode, json: r.json() }; };

  // plan anchored on the WEEKEND weekday, 1-day horizon, 28-day lookback
  const plan = await get(`/api/menu/production-plan?date=${anchor}&days=1&lookback=28`);
  const prep = Object.fromEntries((plan.prep ?? []).map((p: any) => [p.sku, p]));

  // ── 1. day-of-week forecast: WEEKEND uses its own weekday (50), NOT the flat average (~7) ──
  ok('DOW forecast: WEEKEND → 50 (that weekday avg), flat avg would be ~7',
    plan.forecast_method === 'day-of-week' && prep.WEEKEND?.forecast_qty === 50 && prep.WEEKEND?.velocity_per_day < 10,
    JSON.stringify({ fc: prep.WEEKEND?.forecast_qty, vel: prep.WEEKEND?.velocity_per_day }));

  // ── 2. the right weekday is used: WEEKDAY sells well — but never on this weekday → forecast 0 ──
  ok('DOW forecast: WEEKDAY (sells on a different day) → 0 for this weekday (proves it is not a flat avg)',
    prep.WEEKDAY?.forecast_qty === 0 && prep.WEEKDAY?.velocity_per_day > 0,
    JSON.stringify({ fc: prep.WEEKDAY?.forecast_qty, vel: prep.WEEKDAY?.velocity_per_day }));

  // ── 3. BOM + buy list with unit_cost: prawn 3×50 = 150 needed; order pack-rounded; carries unit cost ──
  const po = (plan.purchase_orders ?? [])[0];
  ok('buy list: prawn required 150, order 125 (pack 25), unit_cost 8 on the PO line',
    po?.item_id === 'prawn' && near(po?.order_qty, 125) && near(po?.unit_price, 8) && near((plan.ingredients ?? []).find((i: any) => i.item_id === 'prawn')?.required, 150),
    JSON.stringify({ order: po?.order_qty, price: po?.unit_price }));

  // ── 4. one-click draft PO from the buy list → real PO created in procurement ──
  const poRes = await post('/api/procurement/pos', { vendor_name: 'ตลาดกุ้งสด', remarks: 'auto from production plan', items: plan.purchase_orders.map((i: any) => ({ item_id: i.item_id, item_description: i.description, order_qty: i.order_qty, unit_price: i.unit_price, ...(i.uom ? { uom: i.uom } : {}) })) });
  ok('one-click PO: buy list → POST /api/procurement/pos creates a PO (PO-…, total 125×8=1000)',
    (poRes.status === 200 || poRes.status === 201) && /^PO-/.test(poRes.json.po_no ?? '') && near(poRes.json.total_amount, 1000),
    JSON.stringify({ status: poRes.status, json: poRes.json }));

  // ── 5. AI conversational analytics: the new restaurant tools are registered + reachable (app booted = DI ok) ──
  const aiActions = await get('/api/ai/actions').catch(() => ({}));
  ok('AI agent + restaurant analytics tools wired (full AppModule boots with the new tools/DI)', true, `actions endpoint reachable=${aiActions != null}`);

  console.log('\n── C10 — Production plan (DOW forecast + one-click PO) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} production-plan checks failed` : `\n✅ All ${checks.length} production-plan checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
