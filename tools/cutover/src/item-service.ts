/**
 * docs/52 Phase 2a — sale-line resolve + service items. A POS sale now resolves each item_id against the
 * shared `items` master: a supplyType='service' line sells with NO stock move and NO COGS, and its revenue
 * posts to SALE.SERVICE; a 'goods' line (or an unknown free-text item_id) is unchanged. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover item-service
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
  // shared item master: a SERVICE item + a GOODS item.
  await db.insert(s.items).values([
    { itemId: 'HAIRCUT', itemDescription: 'ตัดผม', supplyType: 'service', uom: 'ครั้ง', unitPrice: '100' },
    { itemId: 'SHAMPOO', itemDescription: 'แชมพู', supplyType: 'goods', uom: 'ขวด', unitPrice: '100' },
  ]).onConflictDoNothing();
  // per-tenant stock for BOTH — so we can prove the service item is NOT decremented even though it has a row.
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'HAIRCUT', itemDescription: 'ตัดผม', uom: 'ครั้ง', currentStock: '10' },
    { tenantId: t, itemId: 'SHAMPOO', itemDescription: 'แชมพู', uom: 'ขวด', currentStock: '10' },
    { tenantId: t, itemId: 'FREE1', itemDescription: 'สินค้าอิสระ', uom: 'ชิ้น', currentStock: '10' },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  // GL-24 override: remap SALE.SERVICE revenue → 4100 for this tenant, so the service/goods split is
  // observable by ACCOUNT (goods stay at SALE.GOODS default 4000). 0439 registered the event type.
  await db.insert(s.postingRules).values({ tenantId: t, eventType: 'SALE.SERVICE', legOrder: 1, role: 'revenue', side: 'CR', accountCode: '4100', status: 'Approved', active: true }).onConflictDoNothing();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw1' })).json.token as string;
  const admin = await login('admin');
  const stockOf = async (itemId: string) => Number((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t), eq(s.customerInventory.itemId, itemId))))[0]?.currentStock ?? 0);
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const cogsOf = async (saleNo: string) => (await pg.query(`SELECT count(*)::int AS c FROM journal_entries WHERE source='POS-COGS' AND source_ref='${saleNo}'`)).rows[0].c as number;
  const stockLogOf = async (saleNo: string, itemId: string) => (await pg.query(`SELECT count(*)::int AS c FROM cust_stock_log WHERE ref_doc='${saleNo}' AND item_id='${itemId}'`)).rows[0].c as number;
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);
  const sale = (items: any[]) => inj('POST', '/api/pos/sales', admin, { items });

  // ── 1. SERVICE-only sale → no stock move, no COGS, revenue to 4100 (SALE.SERVICE) ──
  const svc = await sale([{ item_id: 'HAIRCUT', qty: 1, unit_price: 100 }]);
  const svcGl = await glOf(svc.json.sale_no);
  ok('service sale: created, total 107, HAIRCUT stock UNCHANGED (10), no stock-log, no COGS',
    /^SALE-/.test(svc.json.sale_no ?? '') && near(svc.json.total, 107) && near(await stockOf('HAIRCUT'), 10) && (await stockLogOf(svc.json.sale_no, 'HAIRCUT')) === 0 && (await cogsOf(svc.json.sale_no)) === 0,
    JSON.stringify({ total: svc.json.total, stock: await stockOf('HAIRCUT') }));
  ok('service sale: revenue posts to 4100 (SALE.SERVICE remap), NOT 4000; VAT 7 → 2100; balanced',
    near(cr(svcGl, '4100'), 100) && near(cr(svcGl, '4000'), 0) && near(cr(svcGl, '2100'), 7) && near(svcGl.reduce((a, l) => a + Number(l.debit || 0), 0), svcGl.reduce((a, l) => a + Number(l.credit || 0), 0)),
    JSON.stringify(svcGl));

  // ── 2. GOODS-only sale → stock decrement + stock-log, revenue to 4000 (SALE.GOODS) ──
  const gds = await sale([{ item_id: 'SHAMPOO', qty: 1, unit_price: 100 }]);
  const gdsGl = await glOf(gds.json.sale_no);
  ok('goods sale: SHAMPOO stock 10→9 + stock-log row, revenue → 4000 (SALE.GOODS)',
    near(await stockOf('SHAMPOO'), 9) && (await stockLogOf(gds.json.sale_no, 'SHAMPOO')) === 1 && near(cr(gdsGl, '4000'), 100) && near(cr(gdsGl, '4100'), 0),
    JSON.stringify({ stock: await stockOf('SHAMPOO'), gl: gdsGl }));

  // ── 3. MIXED cart → only the goods line moves stock; revenue splits goods→4000 + service→4100 ──
  const mix = await sale([{ item_id: 'HAIRCUT', qty: 1, unit_price: 100 }, { item_id: 'SHAMPOO', qty: 1, unit_price: 100 }]);
  const mixGl = await glOf(mix.json.sale_no);
  ok('mixed cart: total 214, SHAMPOO 9→8, HAIRCUT still 10 (service untouched)',
    near(mix.json.total, 214) && near(await stockOf('SHAMPOO'), 8) && near(await stockOf('HAIRCUT'), 10),
    JSON.stringify({ total: mix.json.total, shampoo: await stockOf('SHAMPOO'), haircut: await stockOf('HAIRCUT') }));
  ok('mixed cart: revenue split goods 100→4000 + service 100→4100, VAT 14→2100, balanced',
    near(cr(mixGl, '4000'), 100) && near(cr(mixGl, '4100'), 100) && near(cr(mixGl, '2100'), 14) && near(mixGl.reduce((a, l) => a + Number(l.debit || 0), 0), mixGl.reduce((a, l) => a + Number(l.credit || 0), 0)),
    JSON.stringify(mixGl));

  // ── 4. an UNKNOWN free-text item_id (no master row) defaults to GOODS (stock moves, revenue 4000) ──
  const free = await sale([{ item_id: 'FREE1', qty: 1, unit_price: 100 }]);
  const freeGl = await glOf(free.json.sale_no);
  ok('unknown item_id (no master row) → treated as goods: stock 10→9, revenue → 4000 (byte-identical default)',
    near(await stockOf('FREE1'), 9) && near(cr(freeGl, '4000'), 100) && near(cr(freeGl, '4100'), 0),
    JSON.stringify({ stock: await stockOf('FREE1') }));

  // ── 5. permission: a non-selling role cannot ring a sale ──
  const wh = await inj('POST', '/api/pos/sales', await login('wh'), { items: [{ item_id: 'SHAMPOO', qty: 1, unit_price: 100 }] });
  ok('non-selling role (Warehouse) → 403', wh.status === 403, `${wh.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 2a — sale-line resolve + service items (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} item-service checks failed` : `\n✅ All ${checks.length} item-service checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
