/**
 * docs/52 Phase 3a — lot/expiry capture on the POS sale line. A lot-tracked item (`items.is_lot_tracked`)
 * sells only from a real, non-expired, non-held lot: the sale picks FEFO (earliest expiry) by default or an
 * explicit `lot_no`, stamps the consumed lot + expiry on the `cust_pos_items` line, and writes a qty_out row
 * to `lot_ledger` (recall/forward traceability). A non-tracked item captures no lot → byte-identical. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-lot
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
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านขายยา', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  // item master: a lot-tracked drug WIDGET, a tracked drug with only an expired lot (WEXP), a tracked drug
  // with no lots at all (WNONE), and a NON-tracked good PLAIN.
  await db.insert(s.items).values([
    { itemId: 'WIDGET', itemDescription: 'ยา A', supplyType: 'goods', uom: 'กล่อง', unitPrice: '100', isLotTracked: true },
    { itemId: 'WEXP', itemDescription: 'ยา B (หมดอายุ)', supplyType: 'goods', uom: 'กล่อง', unitPrice: '100', isLotTracked: true },
    { itemId: 'WNONE', itemDescription: 'ยา C (ไม่มีล็อต)', supplyType: 'goods', uom: 'กล่อง', unitPrice: '100', isLotTracked: true },
    { itemId: 'PLAIN', itemDescription: 'สินค้าทั่วไป', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100', isLotTracked: false },
  ]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'WIDGET', itemDescription: 'ยา A', uom: 'กล่อง', currentStock: '100' },
    { tenantId: t, itemId: 'WEXP', itemDescription: 'ยา B', uom: 'กล่อง', currentStock: '100' },
    { tenantId: t, itemId: 'WNONE', itemDescription: 'ยา C', uom: 'กล่อง', currentStock: '100' },
    { tenantId: t, itemId: 'PLAIN', itemDescription: 'สินค้าทั่วไป', uom: 'ชิ้น', currentStock: '100' },
  ]).onConflictDoNothing();
  // lot_ledger: WIDGET has LOT-A (exp 2027) + LOT-B (exp 2028) both good, and LOT-OLD (exp 2020, expired);
  // WEXP has only an expired lot. FEFO picks earliest NON-expired = LOT-A. (lot_ledger has no tenant_id.)
  await db.insert(s.lotLedger).values([
    { lotNo: 'LOT-OLD', itemId: 'WIDGET', itemDescription: 'ยา A', uom: 'กล่อง', qtyIn: '5', qtyOut: '0', balance: '5', expiryDate: '2020-01-01', status: 'Active', grNo: 'GR-0' },
    { lotNo: 'LOT-A', itemId: 'WIDGET', itemDescription: 'ยา A', uom: 'กล่อง', qtyIn: '10', qtyOut: '0', balance: '10', expiryDate: '2027-06-01', status: 'Active', grNo: 'GR-1' },
    { lotNo: 'LOT-B', itemId: 'WIDGET', itemDescription: 'ยา A', uom: 'กล่อง', qtyIn: '10', qtyOut: '0', balance: '10', expiryDate: '2028-06-01', status: 'Active', grNo: 'GR-2' },
    { lotNo: 'LOT-X', itemId: 'WEXP', itemDescription: 'ยา B', uom: 'กล่อง', qtyIn: '10', qtyOut: '0', balance: '10', expiryDate: '2020-01-01', status: 'Active', grNo: 'GR-3' },
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
  const sale = (items: any[]) => inj('POST', '/api/pos/sales', admin, { items });
  const stockOf = async (itemId: string) => Number((await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, t), eq(s.customerInventory.itemId, itemId))))[0]?.currentStock ?? 0);
  const lineLot = async (saleNo: string, itemId: string) => (await pg.query(`SELECT cpi.lot_no, cpi.expiry_date FROM cust_pos_items cpi JOIN cust_pos_sales s ON cpi.sale_id=s.id WHERE s.sale_no='${saleNo}' AND cpi.item_id='${itemId}'`)).rows[0] as any;
  const ledgerOut = async (saleNo: string, lot: string) => (await pg.query(`SELECT COALESCE(SUM(qty_out::numeric),0)::float AS o FROM lot_ledger WHERE ref_doc='${saleNo}' AND lot_no='${lot}'`)).rows[0].o as number;
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);

  // ── 1. lot-tracked FEFO: WIDGET 3 → picks LOT-A (earliest non-expired, skips LOT-OLD); line stamped; ledger qty_out ──
  const s1 = await sale([{ item_id: 'WIDGET', qty: 3, unit_price: 100 }]);
  const l1 = await lineLot(s1.json.sale_no, 'WIDGET');
  const g1 = await glOf(s1.json.sale_no);
  ok('FEFO lot-tracked sale: WIDGET ×3 picks LOT-A (skips expired LOT-OLD), line stamped lot+expiry, lot_ledger qty_out 3',
    l1?.lot_no === 'LOT-A' && new Date(l1?.expiry_date).toISOString().startsWith('2027-06-01') && near(await ledgerOut(s1.json.sale_no, 'LOT-A'), 3),
    JSON.stringify({ lot: l1?.lot_no, exp: l1?.expiry_date, out: await ledgerOut(s1.json.sale_no, 'LOT-A') }));
  ok('lot-tracked sale GL byte-identical: stock 100→97, revenue → 4000, VAT → 2100',
    near(await stockOf('WIDGET'), 97) && near(cr(g1, '4000'), 300) && near(cr(g1, '2100'), 21),
    JSON.stringify({ stock: await stockOf('WIDGET'), gl: g1 }));

  // ── 2. explicit lot override: WIDGET 2 on LOT-B → stamped LOT-B ──
  const s2 = await sale([{ item_id: 'WIDGET', qty: 2, unit_price: 100, lot_no: 'LOT-B' }]);
  const l2 = await lineLot(s2.json.sale_no, 'WIDGET');
  ok('explicit lot override: WIDGET ×2 on LOT-B → line stamped LOT-B, ledger qty_out 2 on LOT-B',
    l2?.lot_no === 'LOT-B' && near(await ledgerOut(s2.json.sale_no, 'LOT-B'), 2), JSON.stringify({ lot: l2?.lot_no }));

  // ── 3. expired-only item → blocked ──
  const s3 = await sale([{ item_id: 'WEXP', qty: 1, unit_price: 100 }]);
  ok('expired-only lot → 400 LOT_EXPIRED (cannot sell expired stock)', s3.status === 400 && s3.json.error?.code === 'LOT_EXPIRED', `${s3.status} ${s3.json.error?.code}`);

  // ── 4. tracked item with no lots → blocked ──
  const s4 = await sale([{ item_id: 'WNONE', qty: 1, unit_price: 100 }]);
  ok('lot-tracked with no lots → 400 NO_LOT_AVAILABLE', s4.status === 400 && s4.json.error?.code === 'NO_LOT_AVAILABLE', `${s4.status} ${s4.json.error?.code}`);

  // ── 5. insufficient lot stock → blocked ──
  const s5 = await sale([{ item_id: 'WIDGET', qty: 999, unit_price: 100 }]);
  ok('insufficient lot stock → 400 LOT_INSUFFICIENT', s5.status === 400 && s5.json.error?.code === 'LOT_INSUFFICIENT', `${s5.status} ${s5.json.error?.code}`);

  // ── 6. explicit unknown lot → blocked ──
  const s6 = await sale([{ item_id: 'WIDGET', qty: 1, unit_price: 100, lot_no: 'LOT-ZZZ' }]);
  ok('explicit unknown lot → 400 LOT_NOT_FOUND', s6.status === 400 && s6.json.error?.code === 'LOT_NOT_FOUND', `${s6.status} ${s6.json.error?.code}`);

  // ── 7. held lot excluded from FEFO: hold LOT-A, then WIDGET 1 picks LOT-B ──
  await db.insert(s.lotHolds).values({ tenantId: t, holdNo: 'HOLD-1', lotNo: 'LOT-A', itemId: 'WIDGET', status: 'Held', reason: 'recall' }).onConflictDoNothing();
  const s7 = await sale([{ item_id: 'WIDGET', qty: 1, unit_price: 100 }]);
  const l7 = await lineLot(s7.json.sale_no, 'WIDGET');
  ok('held lot excluded from FEFO: after holding LOT-A, WIDGET ×1 picks LOT-B', l7?.lot_no === 'LOT-B', JSON.stringify({ lot: l7?.lot_no }));

  // ── 8. non-tracked item is byte-identical: no lot stamp, stock decrements, revenue 4000 ──
  const s8 = await sale([{ item_id: 'PLAIN', qty: 1, unit_price: 100 }]);
  const l8 = await lineLot(s8.json.sale_no, 'PLAIN');
  ok('non-tracked item byte-identical: no lot stamp (null), stock 100→99, revenue → 4000',
    (l8?.lot_no == null) && near(await stockOf('PLAIN'), 99) && near(cr(await glOf(s8.json.sale_no), '4000'), 100),
    JSON.stringify({ lot: l8?.lot_no, stock: await stockOf('PLAIN') }));

  // ── 9. permission: a non-selling role cannot ring a sale ──
  const wh = await inj('POST', '/api/pos/sales', await login('wh'), { items: [{ item_id: 'PLAIN', qty: 1, unit_price: 100 }] });
  ok('non-selling role (Warehouse) → 403', wh.status === 403, `${wh.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 3a — lot/expiry capture on the POS sale line (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-lot checks failed` : `\n✅ All ${checks.length} pos-lot checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
