/**
 * docs/52 Phase 3b — serial/IMEI capture on the POS sale line. A serial-tracked item (`items.is_serial_tracked`)
 * is sold as a SPECIFIC physical unit: the sale names one in-stock serial/IMEI per unit, each moves InStock →
 * Sold (stamped with the sale) and the (first) serial is stamped on the `cust_pos_items` line. A non-tracked
 * item captures no serial → byte-identical. Registration is `POST /api/serials/items/:id`. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-serial
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
  await db.insert(s.tenants).values([{ code: 'SHOP', name: 'ร้านมือถือ', industry: 'retail' }]).onConflictDoNothing();
  const t = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'SHOP')))[0].id);
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: t },
    { username: 'wh', passwordHash: await pw.hash('pw1'), role: 'Warehouse', tenantId: t },
    { username: 'cash', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: t },
  ]).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: false, pointsPerBaht: '0' }).onConflictDoNothing();
  await db.insert(s.items).values([
    { itemId: 'PHONE', itemDescription: 'มือถือ', supplyType: 'goods', uom: 'เครื่อง', unitPrice: '5000', isSerialTracked: true },
    { itemId: 'PLAIN', itemDescription: 'อุปกรณ์เสริม', supplyType: 'goods', uom: 'ชิ้น', unitPrice: '100', isSerialTracked: false },
  ]).onConflictDoNothing();
  await db.insert(s.customerInventory).values([
    { tenantId: t, itemId: 'PHONE', itemDescription: 'มือถือ', uom: 'เครื่อง', currentStock: '100' },
    { tenantId: t, itemId: 'PLAIN', itemDescription: 'อุปกรณ์เสริม', uom: 'ชิ้น', currentStock: '100' },
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
  const lineSerial = async (saleNo: string, itemId: string) => (await pg.query(`SELECT cpi.serial_no FROM cust_pos_items cpi JOIN cust_pos_sales sa ON cpi.sale_id=sa.id WHERE sa.sale_no='${saleNo}' AND cpi.item_id='${itemId}'`)).rows[0] as any;
  const serialRow = async (serialNo: string) => (await pg.query(`SELECT status, sale_no FROM item_serials WHERE serial_no='${serialNo}'`)).rows[0] as any;
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='POS' AND je.source_ref='${saleNo}'`)).rows as any[];
  const cr = (gl: any[], acct: string) => gl.filter((l) => l.account_code === acct).reduce((a, l) => a + Number(l.credit || 0), 0);

  // ── 0. register serial units (InStock) + idempotency + list ──
  const add1 = await inj('POST', '/api/serials/items/PHONE', admin, { serials: ['IMEI-1', 'IMEI-2', 'IMEI-3'] });
  ok('register 3 serials → added 3', add1.status === 201 && add1.json.added === 3, JSON.stringify(add1.json));
  const add2 = await inj('POST', '/api/serials/items/PHONE', admin, { serials: ['IMEI-1', 'IMEI-4'] });
  ok('idempotent register (IMEI-1 dup + IMEI-4) → added 1', add2.json.added === 1, JSON.stringify(add2.json));
  const list = await inj('GET', '/api/serials/items/PHONE?status=InStock', admin);
  ok('list InStock → 4 units', list.json.count === 4, JSON.stringify({ count: list.json.count }));

  // ── 1. serial-tracked sale: PHONE ×1 with IMEI-1 → line stamped, IMEI-1 Sold, stock 100→99, revenue 4000 ──
  const s1 = await sale([{ item_id: 'PHONE', qty: 1, unit_price: 5000, serial_nos: ['IMEI-1'] }]);
  const l1 = await lineSerial(s1.json.sale_no, 'PHONE');
  const r1 = await serialRow('IMEI-1');
  const g1 = await glOf(s1.json.sale_no);
  ok('serial sale: line stamped IMEI-1; IMEI-1 → Sold + sale_no; stock 100→99; revenue → 4000 (byte-identical)',
    l1?.serial_no === 'IMEI-1' && r1?.status === 'Sold' && r1?.sale_no === s1.json.sale_no && near(await stockOf('PHONE'), 99) && near(cr(g1, '4000'), 5000),
    JSON.stringify({ line: l1?.serial_no, status: r1?.status, stock: await stockOf('PHONE') }));

  // ── 2. a Sold serial cannot be sold again ──
  const s2 = await sale([{ item_id: 'PHONE', qty: 1, unit_price: 5000, serial_nos: ['IMEI-1'] }]);
  ok('re-sell a Sold serial → 400 SERIAL_NOT_AVAILABLE', s2.status === 400 && s2.json.error?.code === 'SERIAL_NOT_AVAILABLE', `${s2.status} ${s2.json.error?.code}`);

  // ── 3. qty 2 with two serials → both Sold, line stamped the first ──
  const s3 = await sale([{ item_id: 'PHONE', qty: 2, unit_price: 5000, serial_nos: ['IMEI-2', 'IMEI-3'] }]);
  const l3 = await lineSerial(s3.json.sale_no, 'PHONE');
  ok('serial sale qty 2 with [IMEI-2, IMEI-3]: both → Sold, line stamped IMEI-2',
    l3?.serial_no === 'IMEI-2' && (await serialRow('IMEI-2'))?.status === 'Sold' && (await serialRow('IMEI-3'))?.status === 'Sold',
    JSON.stringify({ line: l3?.serial_no }));

  // ── 4. count mismatch (qty 2, one serial) ──
  const s4 = await sale([{ item_id: 'PHONE', qty: 2, unit_price: 5000, serial_nos: ['IMEI-4'] }]);
  ok('qty 2 with 1 serial → 400 SERIAL_COUNT_MISMATCH', s4.status === 400 && s4.json.error?.code === 'SERIAL_COUNT_MISMATCH', `${s4.status} ${s4.json.error?.code}`);

  // ── 5. unknown serial ──
  const s5 = await sale([{ item_id: 'PHONE', qty: 1, unit_price: 5000, serial_nos: ['IMEI-ZZZ'] }]);
  ok('unknown serial → 400 SERIAL_NOT_FOUND', s5.status === 400 && s5.json.error?.code === 'SERIAL_NOT_FOUND', `${s5.status} ${s5.json.error?.code}`);

  // ── 6. serial-tracked line with no serials ──
  const s6 = await sale([{ item_id: 'PHONE', qty: 1, unit_price: 5000 }]);
  ok('serial-tracked line with no serials → 400 SERIAL_REQUIRED', s6.status === 400 && s6.json.error?.code === 'SERIAL_REQUIRED', `${s6.status} ${s6.json.error?.code}`);

  // ── 7. non-tracked item is byte-identical (no serial stamp) ──
  const s7 = await sale([{ item_id: 'PLAIN', qty: 1, unit_price: 100 }]);
  const l7 = await lineSerial(s7.json.sale_no, 'PLAIN');
  ok('non-tracked item byte-identical: no serial stamp (null), stock 100→99, revenue → 4000',
    (l7?.serial_no == null) && near(await stockOf('PLAIN'), 99) && near(cr(await glOf(s7.json.sale_no), '4000'), 100),
    JSON.stringify({ serial: l7?.serial_no, stock: await stockOf('PLAIN') }));

  // ── 8. register endpoint is gated: a Cashier (pos_sell only) cannot add serials ──
  const cashAdd = await inj('POST', '/api/serials/items/PHONE', await login('cash'), { serials: ['IMEI-9'] });
  ok('Cashier (no setup/warehouse duty) → 403 on register serials', cashAdd.status === 403, `${cashAdd.status}`);

  // ── 9. a non-selling role cannot ring a sale ──
  const wh = await inj('POST', '/api/pos/sales', await login('wh'), { items: [{ item_id: 'PLAIN', qty: 1, unit_price: 100 }] });
  ok('non-selling role (Warehouse) → 403', wh.status === 403, `${wh.status}`);

  await app.close();
  await pg.close();
  console.log('\n── docs/52 Phase 3b — serial/IMEI capture on the POS sale line (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} pos-serial checks failed` : `\n✅ All ${checks.length} pos-serial checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
