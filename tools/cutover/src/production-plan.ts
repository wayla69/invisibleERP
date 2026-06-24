/**
 * C10 — Predictive prep + auto-replenishment (production plan): dish velocity → forecast → BOM explosion
 * → prep list + ingredient buy list (requirement vs stock + reorder point). Over PGlite.
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
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.001;
const ymd = (d: Date) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); // Asia/Bangkok day

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

  // dishes + recipes: PADTHAI uses prawn 3 + noodle 100; TOMYUM uses prawn 5 (shared scarce ingredient)
  const mk = async (sku: string, name: string) => Number((await db.insert(s.menuItems).values({ tenantId: t1, sku, name, price: '100', active: true, isAvailable: true }).returning({ id: s.menuItems.id }))[0].id);
  const padthai = await mk('PADTHAI', 'ผัดไทยกุ้ง'), tomyum = await mk('TOMYUM', 'ต้มยำกุ้ง');
  const recipe = async (menuItemId: number, sku: string, lines: { id: string; qty: number }[]) => {
    const recId = Number((await db.insert(s.menuRecipes).values({ tenantId: t1, menuItemId, sku, yieldQty: '1', postCogs: false, active: true }).returning({ id: s.menuRecipes.id }))[0].id);
    for (const l of lines) await db.insert(s.menuRecipeLines).values({ tenantId: t1, recipeId: recId, ingredientItemId: l.id, ingredientDescription: l.id, qtyPer: String(l.qty), unitCost: '1' });
  };
  await recipe(padthai, 'PADTHAI', [{ id: 'prawn', qty: 3 }, { id: 'noodle', qty: 100 }]);
  await recipe(tomyum, 'TOMYUM', [{ id: 'prawn', qty: 5 }]);
  // ingredient stock: prawn scarce (40, reorder 10, pack 25); noodle plentiful
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'prawn', itemDescription: 'กุ้ง', currentStock: '40', reorderPoint: '10', reorderQty: '25' },
    { tenantId: t1, itemId: 'noodle', itemDescription: 'เส้นจันท์', currentStock: '5000', reorderPoint: '200', reorderQty: '0' },
  ]);
  // sales history inside a 10-day lookback: PADTHAI 50 sold, TOMYUM 20 sold → velocity 5/day and 2/day
  const day = ymd(new Date(Date.now() - 3 * 86400_000)); // 3 days ago, within the 10-day window
  const [sale] = await db.insert(s.custPosSales).values({ saleNo: 'SALE-PP-1', saleDate: day, tenantId: t1, status: 'Completed', subtotal: '0', total: '0' }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values([
    { saleId: Number(sale.id), itemId: 'PADTHAI', itemDescription: 'ผัดไทย', qty: '50', unitPrice: '100', amount: '5000' },
    { saleId: Number(sale.id), itemId: 'TOMYUM', itemDescription: 'ต้มยำ', qty: '20', unitPrice: '100', amount: '2000' },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  // horizon 2 days, lookback 10 days → velocity = sold/10, forecast = ceil(velocity × 2)
  const plan = (await app.inject({ method: 'GET', url: '/api/menu/production-plan?days=2&lookback=10', headers: { authorization: `Bearer ${token}` } })).json();
  const prep = Object.fromEntries((plan.prep ?? []).map((p: any) => [p.sku, p]));
  const ing = Object.fromEntries((plan.ingredients ?? []).map((i: any) => [i.item_id, i]));
  const po = Object.fromEntries((plan.purchase_orders ?? []).map((p: any) => [p.item_id, p]));

  // ── 1. demand forecast from velocity ──
  ok('forecast: PADTHAI 50/10d → 5/day → 10 for 2 days; TOMYUM 20/10d → 2/day → 4',
    near(prep.PADTHAI?.velocity_per_day, 5) && prep.PADTHAI?.forecast_qty === 10 && near(prep.TOMYUM?.velocity_per_day, 2) && prep.TOMYUM?.forecast_qty === 4,
    JSON.stringify({ p: prep.PADTHAI?.forecast_qty, t: prep.TOMYUM?.forecast_qty }));

  // ── 2. prep list = forecast (pre-make to meet demand) ──
  ok('prep list: prep_suggestion = forecast for each dish (2 to prep)',
    prep.PADTHAI?.prep_suggestion === 10 && prep.TOMYUM?.prep_suggestion === 4 && plan.summary?.dishes_to_prep === 2,
    JSON.stringify(plan.summary));

  // ── 3. BOM explosion → combined ingredient requirement ──
  ok('ingredient requirement: prawn 3×10 + 5×4 = 50; noodle 100×10 = 1000',
    near(ing.prawn?.required, 50) && near(ing.noodle?.required, 1000),
    JSON.stringify({ prawn: ing.prawn?.required, noodle: ing.noodle?.required }));

  // ── 4. buy list: prawn short (40 stock vs 50 need) → order to pack size; noodle fine ──
  ok('buy list: prawn projected −10 < reorder → order 25 (pack-rounded); noodle no order',
    ing.prawn?.needs_order === true && near(ing.prawn?.projected_balance, -10) && near(po.prawn?.order_qty, 25) && ing.noodle?.needs_order === false && !po.noodle,
    JSON.stringify({ prawnOrder: po.prawn?.order_qty, noodleNeeds: ing.noodle?.needs_order }));

  // ── 5. summary ──
  ok('summary: 2 dishes, 2 ingredients, 1 to order', plan.summary?.dishes === 2 && plan.summary?.ingredients === 2 && plan.summary?.ingredients_to_order === 1, JSON.stringify(plan.summary));

  console.log('\n── C10 — Production plan (predictive prep + auto-replenishment) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} production-plan checks failed` : `\n✅ All ${checks.length} production-plan checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
