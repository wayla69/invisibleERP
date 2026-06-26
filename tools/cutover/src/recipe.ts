/**
 * POS Tier 2 #6 — Recipe / BOM ingredient deduction (ตัดวัตถุดิบตามสูตร) over PGlite:
 * selling a dish deducts its ingredients from customer_inventory + optional COGS GL; returns reverse it.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover recipe
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'recipe-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near3 = (a: any, b: number) => Math.abs(Number(a) - b) < 0.001;
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'cust1', passwordHash: await pw.hash('pc1'), role: 'Customer', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pwh'), role: 'Warehouse', tenantId: t1 },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t1, itemId: 'PORK', itemDescription: 'หมู', uom: 'กก.', currentStock: '1000' },
    { tenantId: t1, itemId: 'CHILI', itemDescription: 'พริก', uom: 'กก.', currentStock: '500' },
    { tenantId: t1, itemId: 'RICE', itemDescription: 'ข้าว', uom: 'กก.', currentStock: '800' },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, sales1, cust1, sales2, wh1] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('cust1', 'pc1'), await login('sales2', 'pw2'), await login('wh1', 'pwh')];
  const stockOf = async (item: string) => Number((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t1), eq(s.customerInventory.itemId, item))))[0]?.currentStock ?? 0);

  // ── setup: menu item KP01 + recipe (PORK 0.15, CHILI 0.02, RICE 0.25; post_cogs) ──
  await inj('POST', '/api/menu/categories', sales1, { code: 'main', name: 'จานหลัก' });
  await inj('POST', '/api/menu/items', sales1, { sku: 'KP01', name: 'ผัดกะเพรา', price: 60, station_code: 'hot' });
  await inj('POST', '/api/menu/items', sales1, { sku: 'COLA', name: 'โค้ก', price: 20, station_code: 'drinks' });
  const rcp = await inj('POST', '/api/menu/items/KP01/recipe', sales1, { post_cogs: true, lines: [{ ingredient_item_id: 'PORK', qty_per: 0.15, unit_cost: 50 }, { ingredient_item_id: 'CHILI', qty_per: 0.02, unit_cost: 10 }, { ingredient_item_id: 'RICE', qty_per: 0.25, unit_cost: 5 }] });
  ok('Define recipe KP01 (3 lines, recipe_cost 8.95)', rcp.json.lines?.length === 3 && near(rcp.json.recipe_cost, 8.95) && rcp.json.post_cogs === true, JSON.stringify({ n: rcp.json.lines?.length, c: rcp.json.recipe_cost }));
  ok('GET recipe → 3 lines', (await inj('GET', '/api/menu/items/KP01/recipe', sales1)).json.lines?.length === 3);
  const noPerm = await inj('POST', '/api/menu/items/KP01/recipe', cust1, { lines: [{ ingredient_item_id: 'PORK', qty_per: 1 }] });
  ok('Permission: Customer (no bom_master/masterdata/exec) → 403', noPerm.status === 403, `${noPerm.status}`);

  // ── dine-in 2×KP01 → checkout → deduct ingredients + COGS ──
  const tbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'R1', seats: 2 });
  const o1 = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tbl.json.id, items: [{ sku: 'KP01', qty: 2 }] });
  const co1 = await inj('POST', `/api/restaurant/orders/${o1.json.order_no}/checkout`, sales1, { method: 'Cash' });
  ok('Dine-in 2×KP01 checkout → SALE-', /^SALE-/.test(co1.json.sale_no ?? ''), `${co1.status}`);
  ok('Ingredient stock deducted: PORK 999.70, CHILI 499.96, RICE 799.50', near3(await stockOf('PORK'), 999.70) && near3(await stockOf('CHILI'), 499.96) && near3(await stockOf('RICE'), 799.50), `pork=${await stockOf('PORK')}`);
  const clog = (await pg.query(`SELECT log_type, qty_change FROM cust_stock_log WHERE ref_doc='${co1.json.sale_no}' AND log_type='Consume'`)).rows as any[];
  ok('cust_stock_log: 3 Consume rows for the sale', clog.length === 3 && clog.every((r) => Number(r.qty_change) < 0), `n=${clog.length}`);
  const cogs = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS-COGS' AND je.source_ref='${co1.json.sale_no}'`)).rows as any[];
  const legc = (c: string, side: string) => Number(cogs.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('COGS GL: Dr5300=17.90 / Cr1200=17.90 (8.95×2)', near(legc('5300', 'debit'), 17.90) && near(legc('1200', 'credit'), 17.90), JSON.stringify(cogs));
  ok('Trial balance balanced after sale+COGS', near((await inj('GET', '/api/ledger/trial-balance', admin)).json.totals?.debit, (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals?.credit));

  // ── return the 2×KP01 sale → restore ingredients + COGS reversal ──
  const r1 = await inj('POST', '/api/pos/returns', sales1, { sale_no: co1.json.sale_no, items: [{ item_id: 'KP01', qty: 2 }] });
  ok('Return 2×KP01 → ingredients restored (PORK 1000, RICE 800)', /^RTN-/.test(r1.json.return_no ?? '') && near3(await stockOf('PORK'), 1000) && near3(await stockOf('RICE'), 800), `pork=${await stockOf('PORK')}`);
  const rcogs = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='RTN-COGS' AND je.source_ref='${r1.json.return_no}'`)).rows as any[];
  ok('COGS reversal GL: Dr1200=17.90 / Cr5300=17.90', near(rcogs.filter((l) => l.account_code === '1200').reduce((a, l) => a + Number(l.debit || 0), 0), 17.90) && near(rcogs.filter((l) => l.account_code === '5300').reduce((a, l) => a + Number(l.credit || 0), 0), 17.90), JSON.stringify(rcogs));

  // ── no-recipe passthrough (COLA) ──
  const o2 = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tbl.json.id, items: [{ sku: 'COLA', qty: 1 }] });
  const co2 = await inj('POST', `/api/restaurant/orders/${o2.json.order_no}/checkout`, sales1, { method: 'Cash' });
  const colaLog = (await pg.query(`SELECT count(*)::int AS c FROM cust_stock_log WHERE ref_doc='${co2.json.sale_no}' AND log_type='Consume'`)).rows as any[];
  const colaCogs = (await pg.query(`SELECT count(*)::int AS c FROM journal_entries WHERE source='POS-COGS' AND source_ref='${co2.json.sale_no}'`)).rows as any[];
  ok('No-recipe item (COLA): no Consume log, no COGS entry', colaLog[0].c === 0 && colaCogs[0].c === 0, JSON.stringify({ log: colaLog[0].c, cogs: colaCogs[0].c }));

  // ── portal retail sale deducts ingredients ──
  const porkBefore = await stockOf('PORK');
  await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'KP01', qty: 1, unit_price: 60 }] });
  ok('Portal sale 1×KP01 → PORK drops by 0.15', near3(await stockOf('PORK'), porkBefore - 0.15), `before=${porkBefore} after=${await stockOf('PORK')}`);

  // ── Step 3: BOM yield/waste factors — gross consumption inflates over the edible qty_per ──
  // YP01 needs 0.10kg edible PORK at 50% yield (yield_factor 0.5) → gross 0.20kg raw per serving; unit_cost 50.
  await inj('POST', '/api/menu/items', sales1, { sku: 'YP01', name: 'หมูยอ', price: 40, station_code: 'hot' });
  const yrcp = await inj('POST', '/api/menu/items/YP01/recipe', sales1, { post_cogs: true, lines: [{ ingredient_item_id: 'PORK', qty_per: 0.10, unit_cost: 50, yield_factor: 0.5 }] });
  ok('Yield: recipe cost on GROSS (0.10/0.5×50 = 10.00, not 5.00)', near(yrcp.json.recipe_cost, 10) && near(yrcp.json.lines?.[0]?.gross_qty, 0.20) && near(yrcp.json.lines?.[0]?.yield_factor, 0.5), JSON.stringify(yrcp.json.lines?.[0]));
  const porkB4 = await stockOf('PORK');
  const ysale = await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'YP01', qty: 1, unit_price: 40 }] });
  ok('Yield: sale of 1×YP01 deducts GROSS 0.20kg PORK (not 0.10)', near3(await stockOf('PORK'), porkB4 - 0.20), `before=${porkB4} after=${await stockOf('PORK')}`);
  const ycogs = (await pg.query(`SELECT coalesce(sum(jl.debit),0) d FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.source='POS-COGS' AND je.source_ref='${ysale.json.sale_no}' AND jl.account_code='5300'`)).rows as any[];
  ok('Yield: COGS booked on gross (Dr5300 = 10.00)', near(ycogs[0]?.d, 10), `d=${ycogs[0]?.d}`);

  // ── Step 1: modifier COGS delta — "extra pork" (+฿20 price, +฿12 COGS) folds into the sold line's COGS ──
  const grp = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'ADDS', name: 'เพิ่มเติม', min_select: 0, max_select: 2, options: [{ name: 'หมูเพิ่ม', price_delta: 20, cogs_delta: 12 }, { name: 'ไข่ดาว', price_delta: 10, cogs_delta: 4 }] });
  const extraPorkId = grp.json.options?.[0]?.option_id;
  ok('Create modifier group with cogs_delta (extra pork 12, egg 4)', grp.json.options?.length === 2 && near(grp.json.options[0].cogs_delta, 12), JSON.stringify(grp.json.options));
  await inj('POST', '/api/menu/items/KP01/modifier-groups', sales1, { group_id: grp.json.group_id });
  // resolve surfaces unit modifier_cogs for menu-engineering margin
  const rl = await inj('POST', '/api/menu/resolve', sales1, { sku: 'KP01', qty: 1, modifier_option_ids: [extraPorkId] });
  ok('resolveLine returns unit_price 80, modifier_cogs 12', near(rl.json.unit_price, 80) && near(rl.json.modifier_cogs, 12), JSON.stringify({ p: rl.json.unit_price, c: rl.json.modifier_cogs }));
  // sale of 2×KP01 + extra pork → recipe COGS 8.95×2 + modifier 12×2 = 17.90 + 24.00 = 41.90
  const sm = await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'KP01', qty: 2, unit_price: 80, modifier_option_ids: [extraPorkId] }] });
  ok('Portal sale 2×KP01+extra-pork → SALE-', /^SALE-/.test(sm.json.sale_no ?? ''), `${sm.status}`);
  const mcogs = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS-COGS' AND je.source_ref='${sm.json.sale_no}'`)).rows as any[];
  const mleg = (c: string, side: string) => Number(mcogs.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('Modifier COGS folded into GL: Dr5300=41.90 / Cr1200=41.90 (8.95×2 + 12×2)', near(mleg('5300', 'debit'), 41.90) && near(mleg('1200', 'credit'), 41.90), JSON.stringify(mcogs));
  // zero-cogs modifier (egg has cogs 4 but COLA is non-recipe) → only the modifier cost posts
  const sm2 = await inj('POST', '/api/portal/pos/sales', cust1, { items: [{ item_id: 'COLA', qty: 1, unit_price: 30, modifier_option_ids: [grp.json.options[1].option_id] }] });
  const m2 = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS-COGS' AND je.source_ref='${sm2.json.sale_no}'`)).rows as any[];
  ok('Non-recipe COLA + egg modifier → COGS just the modifier (Dr5300=4 / Cr1200=4)', near(Number(m2.filter((l) => l.account_code === '5300').reduce((a, l) => a + Number(l.debit || 0), 0)), 4), JSON.stringify(m2));

  // ── negative stock (allow + flag) ──
  await db.update(s.customerInventory).set({ currentStock: '0.10' }).where(and(eq(s.customerInventory.tenantId, t1), eq(s.customerInventory.itemId, 'PORK')));
  const o3 = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tbl.json.id, items: [{ sku: 'KP01', qty: 1 }] });
  const co3 = await inj('POST', `/api/restaurant/orders/${o3.json.order_no}/checkout`, sales1, { method: 'Cash' });
  const oversold = (await pg.query(`SELECT notes FROM cust_stock_log WHERE ref_doc='${co3.json.sale_no}' AND item_id='PORK'`)).rows as any[];
  ok('Negative stock allowed + flagged: PORK -0.05, notes OVERSOLD', /^SALE-/.test(co3.json.sale_no ?? '') && near3(await stockOf('PORK'), -0.05) && oversold[0]?.notes === 'OVERSOLD', `pork=${await stockOf('PORK')} notes=${oversold[0]?.notes}`);

  // ── RLS ──
  const t2recipe = await inj('GET', '/api/menu/items/KP01/recipe', sales2);
  ok('RLS: T2 cannot read T1 recipe → 404', t2recipe.status === 404, `${t2recipe.status}`);
  ok('Trial balance balanced at end', near((await inj('GET', '/api/ledger/trial-balance', admin)).json.totals?.debit, (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals?.credit));

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 2 #6 Recipe / BOM ingredient deduction (ตัดวัตถุดิบตามสูตร) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} recipe checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} recipe checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
