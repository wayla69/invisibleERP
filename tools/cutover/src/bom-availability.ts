/**
 * C7 — BOM availability forecast: servings-remaining per dish from the limiting ingredient + low-stock
 * warnings (the proactive layer over the reactive auto-86). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover bom-availability
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bom-secret';
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

  // dishes
  const mk = async (sku: string, name: string) => Number((await db.insert(s.menuItems).values({ tenantId: t1, sku, name, price: '100.00', active: true, isAvailable: true }).returning({ id: s.menuItems.id }))[0].id);
  const rice = await mk('RICE', 'ข้าวสวย'), padthai = await mk('PADTHAI', 'ผัดไทยกุ้ง'), soldout = await mk('SOLDOUT', 'ไข่เจียว');
  // ingredient stock (prawn is scarce + below reorder; egg is empty)
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'rice', itemDescription: 'ข้าวสาร', currentStock: '5000', reorderPoint: '0' },
    { tenantId: t1, itemId: 'noodle', itemDescription: 'เส้นจันท์', currentStock: '1000', reorderPoint: '0' },
    { tenantId: t1, itemId: 'prawn', itemDescription: 'กุ้ง', currentStock: '12', reorderPoint: '15' },
    { tenantId: t1, itemId: 'egg', itemDescription: 'ไข่', currentStock: '0', reorderPoint: '5' },
  ]);
  // recipes (yield 1)
  const recipe = async (menuItemId: number, sku: string, lines: { id: string; desc: string; qty: number }[]) => {
    const recId = Number((await db.insert(s.menuRecipes).values({ tenantId: t1, menuItemId, sku, yieldQty: '1', postCogs: false, active: true }).returning({ id: s.menuRecipes.id }))[0].id);
    for (const l of lines) await db.insert(s.menuRecipeLines).values({ tenantId: t1, recipeId: recId, ingredientItemId: l.id, ingredientDescription: l.desc, qtyPer: String(l.qty), unitCost: '1' });
  };
  await recipe(rice, 'RICE', [{ id: 'rice', desc: 'ข้าวสาร', qty: 50 }]);                                  // 5000/50 = 100 → ok
  await recipe(padthai, 'PADTHAI', [{ id: 'noodle', desc: 'เส้นจันท์', qty: 100 }, { id: 'prawn', desc: 'กุ้ง', qty: 3 }]); // min(10, 4)=4 → low, prawn-limited
  await recipe(soldout, 'SOLDOUT', [{ id: 'egg', desc: 'ไข่', qty: 1 }]);                                   // 0/1 = 0 → out

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const get = async (url: string) => { const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }); return { status: r.statusCode, json: r.json() }; };

  // ── 1. forecast (low=5 default): 1 ok / 1 low / 1 out ──
  const f = await get('/api/menu/availability/forecast');
  const byItem = Object.fromEntries((f.json.items ?? []).map((i: any) => [i.sku, i]));
  ok('forecast summary: 3 dishes → 1 out, 1 low, 1 ok',
    f.status === 200 && f.json.summary?.dishes === 3 && f.json.summary?.out === 1 && f.json.summary?.low === 1 && f.json.summary?.ok === 1,
    JSON.stringify(f.json.summary));

  // ── 2. servings-remaining from the limiting ingredient ──
  ok('PADTHAI → 4 servings left, limited by prawn (the bottleneck, not noodle)',
    byItem.PADTHAI?.servings_left === 4 && byItem.PADTHAI?.status === 'low' && byItem.PADTHAI?.limiting_ingredient?.item_id === 'prawn' && byItem.PADTHAI?.limiting_ingredient?.qty_per_serving === 3,
    JSON.stringify({ left: byItem.PADTHAI?.servings_left, lim: byItem.PADTHAI?.limiting_ingredient?.item_id }));
  ok('SOLDOUT → 0 servings (status out, should be 86d); RICE → plenty (status ok)',
    byItem.SOLDOUT?.servings_left === 0 && byItem.SOLDOUT?.status === 'out' && byItem.RICE?.servings_left === 100 && byItem.RICE?.status === 'ok',
    JSON.stringify({ sold: byItem.SOLDOUT?.servings_left, rice: byItem.RICE?.servings_left }));

  // ── 3. low-stock ingredient warnings (≤ reorder point, feeding a recipe) ──
  const lowIds = (f.json.low_ingredients ?? []).map((i: any) => i.item_id).sort();
  ok('low-stock ingredients flagged: prawn (12≤15) + egg (0≤5)', JSON.stringify(lowIds) === JSON.stringify(['egg', 'prawn']), JSON.stringify(lowIds));

  // ── 4. threshold parameter changes the low/ok boundary ──
  const f1 = await get('/api/menu/availability/forecast?low=1');
  const p1 = (f1.json.items ?? []).find((i: any) => i.sku === 'PADTHAI');
  ok('low=1 → PADTHAI (4 left) reclassified ok; out still 1', p1?.status === 'ok' && f1.json.summary?.out === 1 && f1.json.summary?.low === 0, JSON.stringify(f1.json.summary));

  console.log('\n── C7 — BOM availability forecast (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} BOM-availability checks failed` : `\n✅ All ${checks.length} BOM-availability checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
