/**
 * POS Tier 1 — Menu / Catalog master validation (real Nest app over PGlite, RLS-enforced):
 * categories, items (SKU/86/KDS routing), priced modifier groups + options, and the
 * resolve-priced-line contract that POS / dine-in / portal order entry consumes.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover menu
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'menu-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 }, // T1 shop manager (pricelist/exec → manage)
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const sales1 = await login('sales1', 'pw1');
  const sales2 = await login('sales2', 'pw2');

  // ── category + item (created by the T1 shop → tenant-scoped) ──
  const cat = await inj('POST', '/api/menu/categories', sales1, { code: 'rice', name: 'ข้าว/เส้น', sort: 1 });
  ok('Menu: category created', (cat.status === 200 || cat.status === 201) && cat.json.code === 'rice', `${cat.status} ${JSON.stringify(cat.json).slice(0, 70)}`);
  const item = await inj('POST', '/api/menu/items', sales1, { sku: 'KP01', name: 'ผัดกะเพราหมู', price: 60, category_id: cat.json.id, station_code: 'hot', prep_minutes: 12 });
  ok('Menu: item created (KP01, price 60, station hot)', item.status === 201 || item.status === 200, `${item.status} ${JSON.stringify(item.json).slice(0, 80)}`);
  ok('Menu: new item is available by default', item.json.is_available === true && near(item.json.price, 60));
  const dupSku = await inj('POST', '/api/menu/items', sales1, { sku: 'KP01', name: 'dup', price: 1 });
  ok('Menu: duplicate SKU per tenant rejected (400)', dupSku.status === 400, `${dupSku.status}`);

  // ── modifier groups (size = required pick-1; addon = optional pick-up-to-3) ──
  const size = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'size', name: 'ขนาด', required: true, min_select: 1, max_select: 1, options: [{ name: 'ธรรมดา', price_delta: 0, is_default: true }, { name: 'พิเศษ', price_delta: 20 }] });
  ok('Menu: required size group + 2 options', (size.status === 200 || size.status === 201) && size.json.options?.length === 2 && size.json.required === true, `${size.status}`);
  const addon = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'addon', name: 'เพิ่มเติม', min_select: 0, max_select: 3, options: [{ name: 'ไข่ดาว', price_delta: 10 }, { name: 'ไข่เจียว', price_delta: 15 }, { name: 'ข้าวเพิ่ม', price_delta: 10 }] });
  ok('Menu: optional addon group + 3 options', addon.json.options?.length === 3 && addon.json.max_select === 3);
  const badRange = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'bad', name: 'x', min_select: 2, max_select: 1 });
  ok('Menu: group min>max rejected (400)', badRange.status === 400, `${badRange.status}`);

  // attach both groups to the item
  await inj('POST', '/api/menu/items/KP01/modifier-groups', sales1, { group_id: size.json.group_id });
  const attached = await inj('POST', '/api/menu/items/KP01/modifier-groups', sales1, { group_id: addon.json.group_id });
  ok('Menu: item has 2 modifier groups attached', attached.json.modifier_groups?.length === 2, JSON.stringify((attached.json.modifier_groups ?? []).map((g: any) => g.code)));

  const opt = (g: any, name: string) => g.options.find((o: any) => o.name === name).option_id;
  const sizeNormal = opt(size.json, 'ธรรมดา'), sizeSpecial = opt(size.json, 'พิเศษ'), eggDao = opt(addon.json, 'ไข่ดาว');

  // ── resolve a priced line (the POS/dine-in contract) ──
  const r1 = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 2, modifier_option_ids: [sizeSpecial, eggDao] });
  ok('Resolve: KP01 พิเศษ(+20) + ไข่ดาว(+10) → unit 90, amount 180 (qty 2)', near(r1.json.unit_price, 90) && near(r1.json.amount, 180) && r1.json.station_code === 'hot', `${r1.status} ${JSON.stringify(r1.json).slice(0, 110)}`);
  ok('Resolve: modifiers echoed with names + deltas', (r1.json.modifiers ?? []).length === 2 && r1.json.modifiers.some((m: any) => m.option_name === 'พิเศษ' && near(m.price_delta, 20)));
  const r2 = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [sizeNormal] });
  ok('Resolve: default size only → unit 60, amount 60', near(r2.json.unit_price, 60) && near(r2.json.amount, 60));
  const rReq = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [eggDao] });
  ok('Resolve: missing required size group → 400 MODIFIER_REQUIRED', rReq.status === 400 && rReq.json.error?.code === 'MODIFIER_REQUIRED', `${rReq.status} ${rReq.json.error?.code}`);
  const rMax = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [sizeNormal, sizeSpecial] });
  ok('Resolve: >max in size group → 400 TOO_MANY_MODIFIERS', rMax.status === 400 && rMax.json.error?.code === 'TOO_MANY_MODIFIERS', `${rMax.status} ${rMax.json.error?.code}`);
  const rBad = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [sizeNormal, 999999] });
  ok('Resolve: option not on this item → 400 INVALID_MODIFIER', rBad.status === 400 && rBad.json.error?.code === 'INVALID_MODIFIER', `${rBad.status} ${rBad.json.error?.code}`);

  // ── 86 (out of stock) ──
  const off = await inj('PATCH', '/api/menu/items/KP01/availability', sales1, { available: false });
  ok('Menu: 86 item → is_available false', off.json.is_available === false);
  const rOff = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [sizeNormal] });
  ok('Resolve: 86\'d item → 400 ITEM_UNAVAILABLE', rOff.status === 400 && rOff.json.error?.code === 'ITEM_UNAVAILABLE', `${rOff.status} ${rOff.json.error?.code}`);
  const menuOff = await inj('GET', '/api/menu', sales1);
  ok('Menu: list reflects 86 flag', (menuOff.json.categories ?? []).flatMap((c: any) => c.items).find((i: any) => i.sku === 'KP01')?.is_available === false);
  await inj('PATCH', '/api/menu/items/KP01/availability', sales1, { available: true });
  const rOn = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [sizeNormal] });
  ok('Resolve: un-86 → resolves again', rOn.status === 200 || rOn.status === 201, `${rOn.status}`);

  // ── menu render + RLS isolation ──
  const menu1 = await inj('GET', '/api/menu', sales1);
  ok('Menu: full menu grouped by category (rice → KP01)', (menu1.json.categories ?? []).find((c: any) => c.code === 'rice')?.items?.some((i: any) => i.sku === 'KP01' && i.has_modifiers === true), JSON.stringify((menu1.json.categories ?? []).map((c: any) => c.code)));
  const menu2 = await inj('GET', '/api/menu', sales2);
  ok('RLS: T2 shop does not see T1 menu', !(menu2.json.categories ?? []).some((c: any) => c.code === 'rice') && !(menu2.json.categories ?? []).flatMap((c: any) => c.items).some((i: any) => i.sku === 'KP01'), `T2 cats=${(menu2.json.categories ?? []).length}`);
  const r2cross = await inj('POST', '/api/menu/resolve', sales2, { sku: 'KP01', qty: 1 });
  ok('RLS: T2 cannot resolve T1 SKU → 404', r2cross.status === 404, `${r2cross.status}`);

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 Menu / Catalog (เมนู + ตัวเลือก + 86 + resolve) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} menu checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} menu checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
