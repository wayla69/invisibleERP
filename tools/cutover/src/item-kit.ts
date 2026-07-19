/**
 * docs/52 Phase 2c — kits/bundles + non-inventory items. A kit/bundle PARENT sells as ONE sale line at ONE
 * price, but on sale its COMPONENT stock (and costed COGS) is consumed — the kit SKU itself is never
 * decremented or costed. Components are tenant-scoped item_relationships (rel_type='kit_component') carrying a
 * per-kit qty. A 'non_inventory' item (delivery fee, gift-wrap) sells with NO stock move / NO COGS but posts
 * to the GOODS revenue event (unlike a 'service' item → SALE.SERVICE). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover item-kit
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'is-secret';
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
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านค้าปลีก', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  // shared item master: a kit PARENT (GIFTSET, sold at 500), two goods COMPONENTS (MUG, SPOON), a plain good
  // (WIDGET) and a non-inventory line (DELIVERY fee).
  await db.insert(s.items).values([
    { itemId: 'GIFTSET', itemDescription: 'ชุดของขวัญ', supplyType: 'goods', uom: 'ชุด', unitPrice: '500' },
    { itemId: 'MUG', itemDescription: 'แก้ว', supplyType: 'goods', uom: 'ใบ', unitPrice: '120' },
    { itemId: 'SPOON', itemDescription: 'ช้อน', supplyType: 'goods', uom: 'คัน', unitPrice: '40' },
    { itemId: 'WIDGET', itemDescription: 'สินค้าเดี่ยว', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100' },
    { itemId: 'DELIVERY', itemDescription: 'ค่าจัดส่ง', supplyType: 'non_inventory', uom: 'ครั้ง', unitPrice: '50' },
  ]).onConflictDoNothing();
  const idOf = async (code: string) => Number((await db.select().from(s.items).where(eq(s.items.itemId, code)))[0].id);
  // kit BOM: GIFTSET = 1×MUG + 2×SPOON.
  await db.insert(s.itemRelationships).values([
    { tenantId: t, fromItemId: await idOf('GIFTSET'), toItemId: await idOf('MUG'), relType: 'kit_component', qty: '1' },
    { tenantId: t, fromItemId: await idOf('GIFTSET'), toItemId: await idOf('SPOON'), relType: 'kit_component', qty: '2' },
  ]).onConflictDoNothing();
  // per-tenant stock: components + the kit SKU itself (to prove the kit's own stock is NOT touched) + WIDGET.
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'GIFTSET', itemDescription: 'ชุดของขวัญ', uom: 'ชุด', currentStock: '100' },
    { tenantId: t, itemId: 'MUG', itemDescription: 'แก้ว', uom: 'ใบ', currentStock: '10' },
    { tenantId: t, itemId: 'SPOON', itemDescription: 'ช้อน', uom: 'คัน', currentStock: '20' },
    { tenantId: t, itemId: 'WIDGET', itemDescription: 'สินค้าเดี่ยว', uom: 'ชิ้น', currentStock: '10' },
    { tenantId: t, itemId: 'DELIVERY', itemDescription: 'ค่าจัดส่ง', uom: 'ครั้ง', currentStock: '10' },
  ]).onConflictDoNothing();
  // STD costing for the components → the kit sale books component COGS (Dr cogs / Cr 1200) under POS-COGS-V.
  await db.insert(s.itemCosting).values([
    { tenantId: t, itemId: 'MUG', method: 'STD', standardCost: '30.0000' },
    { tenantId: t, itemId: 'SPOON', method: 'STD', standardCost: '10.0000' },
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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin');
  const stockOf = async (itemId: string) => Number((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t), eq(s.customerInventory.itemId, itemId))))[0]?.currentStock ?? 0);
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const cogsVOf = async (saleNo: string) => (await pg.query(`SELECT COALESCE(SUM(jl.debit),0)::float AS d FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS-COGS-V' AND je.source_ref='${saleNo}'`)).rows[0].d as number;
  const stockLogOf = async (saleNo: string, itemId: string) => (await pg.query(`SELECT count(*)::int AS c FROM cust_stock_log WHERE ref_doc='${saleNo}' AND item_id='${itemId}'`)).rows[0].c as number;
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);
  const bal = (gl: any[]) => near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0));
  const sale = (items: any[]) => inj('POST', '/api/pos/sales', admin, { items });

  // ── 1. sell 1 kit → components consumed (MUG 10→9, SPOON 20→18); kit SKU stock UNCHANGED (100) ──
  const k1 = await sale([{ item_id: 'GIFTSET', qty: 1, unit_price: 500 }]);
  ok('kit sale ×1: components consumed MUG 10→9 + SPOON 20→18; kit SKU GIFTSET stock UNCHANGED (100)',
    near(await stockOf('MUG'), 9) && near(await stockOf('SPOON'), 18) && near(await stockOf('GIFTSET'), 100),
    JSON.stringify({ mug: await stockOf('MUG'), spoon: await stockOf('SPOON'), giftset: await stockOf('GIFTSET') }));
  // ── 2. stock-log rows are for the COMPONENTS, not the kit SKU ──
  ok('kit sale ×1: stock-log rows for MUG & SPOON, NONE for the kit SKU GIFTSET',
    (await stockLogOf(k1.json.sale_no, 'MUG')) === 1 && (await stockLogOf(k1.json.sale_no, 'SPOON')) === 1 && (await stockLogOf(k1.json.sale_no, 'GIFTSET')) === 0,
    JSON.stringify({ mug: await stockLogOf(k1.json.sale_no, 'MUG'), spoon: await stockLogOf(k1.json.sale_no, 'SPOON'), giftset: await stockLogOf(k1.json.sale_no, 'GIFTSET') }));
  // ── 3. revenue = the KIT price (500), one goods leg → 4000 (not the component-price sum); balanced ──
  const k1Gl = await glOf(k1.json.sale_no);
  ok('kit sale ×1: revenue = kit price 500 → 4000 (one goods leg, not component sum), VAT 35 → 2100, balanced',
    near(k1.json.total, 535) && near(cr(k1Gl, '4000'), 500) && near(cr(k1Gl, '4100'), 0) && near(cr(k1Gl, '2100'), 35) && bal(k1Gl),
    JSON.stringify({ total: k1.json.total, gl: k1Gl }));
  // ── 4. COGS explodes to the components: 1×30 + 2×10 = 50 (POS-COGS-V), NOT the kit SKU ──
  ok('kit sale ×1: costed COGS = components 1×30 + 2×10 = 50 (POS-COGS-V)',
    near(await cogsVOf(k1.json.sale_no), 50),
    JSON.stringify({ cogs: await cogsVOf(k1.json.sale_no) }));

  // ── 5. sell 2 kits → qty multiplies through the BOM: MUG 9→7, SPOON 18→14 ──
  const k2 = await sale([{ item_id: 'GIFTSET', qty: 2, unit_price: 500 }]);
  ok('kit sale ×2: qty multiplies through BOM — MUG 9→7 (−2), SPOON 18→14 (−4)',
    near(await stockOf('MUG'), 7) && near(await stockOf('SPOON'), 14) && near(k2.json.total, 1070),
    JSON.stringify({ mug: await stockOf('MUG'), spoon: await stockOf('SPOON'), total: k2.json.total }));

  // ── 6. a plain (non-kit) goods line is byte-identical — decrements its OWN SKU ──
  const w = await sale([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  ok('non-kit goods line byte-identical: WIDGET 10→9 + own stock-log, revenue → 4000',
    near(await stockOf('WIDGET'), 9) && (await stockLogOf(w.json.sale_no, 'WIDGET')) === 1 && near(cr(await glOf(w.json.sale_no), '4000'), 100),
    JSON.stringify({ stock: await stockOf('WIDGET') }));

  // ── 7. a non_inventory line moves NO stock / books NO COGS, revenue → 4000 (goods event, not SALE.SERVICE) ──
  const d = await sale([{ item_id: 'DELIVERY', qty: 1, unit_price: 50 }]);
  const dGl = await glOf(d.json.sale_no);
  ok('non_inventory line (DELIVERY): stock UNCHANGED (10), no stock-log, no COGS; revenue → 4000, not 4100',
    near(await stockOf('DELIVERY'), 10) && (await stockLogOf(d.json.sale_no, 'DELIVERY')) === 0 && near(await cogsVOf(d.json.sale_no), 0) && near(cr(dGl, '4000'), 50) && near(cr(dGl, '4100'), 0) && bal(dGl),
    JSON.stringify({ stock: await stockOf('DELIVERY'), gl: dGl }));

  // ── 8. manage the BOM via the API: add a kit_component with qty, then it lists with that qty ──
  const addRes = await inj('POST', '/api/item-setup/items/GIFTSET/relationships', admin, { to_item_id: 'WIDGET', rel_type: 'kit_component', qty: 3 });
  const listRes = await inj('GET', '/api/item-setup/items/GIFTSET/relationships', admin);
  const widgetRel = (listRes.json.relationships ?? []).find((r: any) => r.direction === 'outgoing' && r.rel_type === 'kit_component' && r.party.item_id === 'WIDGET');
  ok('API: add kit_component WIDGET ×3 → lists back with qty 3',
    addRes.status === 201 && !!widgetRel && near(widgetRel.qty, 3),
    JSON.stringify({ status: addRes.status, qty: widgetRel?.qty }));

  // ── 9. permission: a non-selling role cannot ring a sale ──
  const wh = await inj('POST', '/api/pos/sales', await login('wh'), { items: [{ item_id: 'GIFTSET', qty: 1, unit_price: 500 }] });
  ok('non-selling role (Warehouse) → 403', wh.status === 403, `${wh.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 2c — kits/bundles + non-inventory items (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} item-kit checks failed` : `\n✅ All ${checks.length} item-kit checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
