/**
 * INV-5 / INV-18 — lot recall / genealogy traceability + lot hold (quarantine).
 * Proves: backward trace (lot → GR → supplier), forward trace (lot → pick/sale → customer), and a lot HOLD
 * that excludes the lot from BOTH the FEFO pick-suggestion and the WMS wave bin-allocation; release re-enables.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover lot-trace
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lot-trace-secret';
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
const daysAhead = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'wh1', passwordHash: await pw.hash('pw'), role: 'Warehouse', tenantId: t1 },
  ]).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();

  // ── Backward-trace fixture: supplier V1 → PO-L1 → GR-L1 (which stamps lot LOT-A1) ──
  await db.insert(s.vendors).values({ name: 'V1', isSupplier: true, approvalStatus: 'approved' }).onConflictDoNothing();
  const vId = Number((await db.select().from(s.vendors).where(eq(s.vendors.name, 'V1')))[0].id);
  await db.insert(s.purchaseOrders).values({ poNo: 'PO-L1', poDate: daysAhead(-10), vendorId: vId, vendorName: 'V1', status: 'Approved', createdBy: 'admin', tenantId: t1 }).onConflictDoNothing();
  await db.insert(s.goodsReceipts).values({ grNo: 'GR-L1', grDate: daysAhead(-9), poNo: 'PO-L1', vendorId: vId, vendorName: 'V1', receivedBy: 'wh1', tenantId: t1 }).onConflictDoNothing();

  // ── Lot ledger: LOT-A1 received 100 (from GR-L1), LOT-A2 received 50 (later expiry, for FEFO ordering) ──
  await db.insert(s.lotLedger).values([
    { lotNo: 'LOT-A1', itemId: 'A', itemDescription: 'Apple', uom: 'EA', locationId: 'WH-MAIN', grNo: 'GR-L1', qtyIn: '100', qtyOut: '0', balance: '100', expiryDate: daysAhead(30), status: 'Active', moveDate: new Date(), refDoc: 'GR-L1', createdBy: 'wh1' },
    { lotNo: 'LOT-A2', itemId: 'A', itemDescription: 'Apple', uom: 'EA', locationId: 'WH-MAIN', grNo: 'GR-L1', qtyIn: '50', qtyOut: '0', balance: '50', expiryDate: daysAhead(60), status: 'Active', moveDate: new Date(), refDoc: 'GR-L1', createdBy: 'wh1' },
  ]);

  // ── Forward-trace fixture: LOT-A1 issued 10 into PICK-L1 which fulfils sale SALE-L1 (the customer) ──
  await db.insert(s.custPosSales).values({ saleNo: 'SALE-L1', saleDate: daysAhead(-1), tenantId: t1, subtotal: '100', discount: '0', taxAmount: '0', total: '100', paymentMethod: 'Cash', status: 'Completed', createdBy: 'wh1' });
  await db.insert(s.pickLists).values({ tenantId: t1, pickNo: 'PICK-L1', sourceType: 'POS', sourceRef: 'SALE-L1', status: 'Picked', createdBy: 'wh1' });
  await db.insert(s.lotLedger).values({ lotNo: 'LOT-A1', itemId: 'A', itemDescription: 'Apple', uom: 'EA', locationId: 'WH-MAIN', qtyIn: '0', qtyOut: '10', balance: '90', status: 'Active', moveDate: new Date(), refDoc: 'PICK-L1', createdBy: 'wh1' });

  // ── WMS bin fixture: both lots binned so the wave allocator has a real FEFO choice ──
  const mkBin = async (code: string) => { const [b] = await db.insert(s.bins).values({ tenantId: t1, binCode: code, binType: 'storage' }).returning({ id: s.bins.id }); return Number(b.id); };
  const bin1 = await mkBin('LB-01'); const bin2 = await mkBin('LB-02');
  await db.insert(s.binStock).values([
    { tenantId: t1, binId: bin1, itemId: 'A', lotNo: 'LOT-A1', qty: '90', uom: 'EA', expiryDate: daysAhead(30) },
    { tenantId: t1, binId: bin2, itemId: 'A', lotNo: 'LOT-A2', qty: '50', uom: 'EA', expiryDate: daysAhead(60) },
  ]);
  // two POS sales to wave (before-hold picks LOT-A1; after-hold picks LOT-A2)
  const mkSale = async (no: string) => { const [h] = await db.insert(s.custPosSales).values({ saleNo: no, saleDate: daysAhead(0), tenantId: t1, subtotal: '20', discount: '0', taxAmount: '0', total: '20', paymentMethod: 'Cash', status: 'Completed', createdBy: 'wh1' }).returning({ id: s.custPosSales.id }); await db.insert(s.custPosItems).values({ saleId: Number(h.id), itemId: 'A', itemDescription: 'Apple', qty: '1', uom: 'EA', unitPrice: '20', amount: '20', discountPct: '0', isCustom: false }); };
  await mkSale('SALE-W1'); await mkSale('SALE-W2');

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
  const wh1 = await login('wh1', 'pw');
  const waveLot = async (ref: string) => {
    await inj('POST', '/api/wms/waves', wh1, { orders: [{ source_type: 'POS', source_ref: ref }] });
    const rows = (await pg.query(`SELECT pll.lot_no FROM pick_list_lines pll JOIN pick_lists pl ON pll.pick_id=pl.id WHERE pl.source_ref='${ref}'`)).rows as any[];
    return rows[0]?.lot_no ?? null;
  };

  // ── 1. Backward trace: lot → GR → supplier ──
  const back = await inj('GET', '/api/lots/LOT-A1/trace', wh1);
  const grNos = (back.json.backward?.receipts ?? []).map((r: any) => r.gr_no);
  const suppliers = (back.json.backward?.suppliers ?? []).map((v: any) => v.vendor_name);
  ok('Backward trace LOT-A1 → goods receipt GR-L1', back.status === 200 && grNos.includes('GR-L1'), JSON.stringify(grNos));
  ok('Backward trace LOT-A1 → supplier V1', suppliers.includes('V1') && back.json.backward.receipts.some((r: any) => r.po_no === 'PO-L1'), JSON.stringify(suppliers));

  // ── 2. Forward trace: lot → pick/sale → customer ──
  const fwdRefs = (back.json.forward?.shipments ?? []).map((r: any) => r.ref_doc);
  const custRefs = (back.json.forward?.customers ?? []).map((c: any) => c.source_ref);
  ok('Forward trace LOT-A1 → issue/pick PICK-L1', fwdRefs.includes('PICK-L1') && back.json.forward.issues.some((i: any) => i.ref_doc === 'PICK-L1' && i.qty_out === 10), JSON.stringify(fwdRefs));
  ok('Forward trace LOT-A1 → customer sale SALE-L1', custRefs.includes('SALE-L1'), JSON.stringify(custRefs));

  // ── 3. FEFO before hold: both lots available, earliest-expiry LOT-A1 first ──
  const fefo0 = await inj('GET', '/api/lots/fefo/A', wh1);
  const fefoLots0 = (fefo0.json.lots ?? []).map((l: any) => l.lot_no);
  ok('FEFO(A) before hold lists both lots, LOT-A1 first (earliest expiry)', fefo0.json.count === 2 && fefoLots0[0] === 'LOT-A1' && fefo0.json.excluded_held === 0, JSON.stringify(fefoLots0));

  // ── 3b. WMS wave before hold allocates the earliest-expiry LOT-A1 ──
  const waveBefore = await waveLot('SALE-W1');
  ok('WMS wave before hold allocates LOT-A1 (earliest expiry)', waveBefore === 'LOT-A1', `lot=${waveBefore}`);

  // ── 4. HOLD LOT-A1 → excluded from FEFO and WMS wave ──
  const hold = await inj('POST', '/api/lots/LOT-A1/hold', wh1, { reason: 'Recall — supplier contamination notice' });
  ok('POST hold LOT-A1 → Held (HOLD- doc)', hold.status < 300 && hold.json.status === 'Held' && String(hold.json.hold_no).startsWith('HOLD-'), JSON.stringify(hold.json));
  const holdDup = await inj('POST', '/api/lots/LOT-A1/hold', wh1, { reason: 'again' });
  ok('Hold idempotent (already Held → duplicate, no new doc)', holdDup.json.duplicate === true, JSON.stringify(holdDup.json));

  const fefo1 = await inj('GET', '/api/lots/fefo/A', wh1);
  const fefoLots1 = (fefo1.json.lots ?? []).map((l: any) => l.lot_no);
  ok('FEFO(A) after hold EXCLUDES held LOT-A1 (only LOT-A2, excluded_held=1)', fefo1.json.count === 1 && fefoLots1[0] === 'LOT-A2' && fefo1.json.excluded_held === 1, JSON.stringify(fefoLots1));

  const waveAfter = await waveLot('SALE-W2');
  ok('WMS wave after hold SKIPS held LOT-A1 → allocates LOT-A2', waveAfter === 'LOT-A2', `lot=${waveAfter}`);

  const traceHeld = await inj('GET', '/api/lots/LOT-A1/trace', wh1);
  ok('Trace reflects hold_status Held', traceHeld.json.hold?.status === 'Held', JSON.stringify(traceHeld.json.hold ?? {}));

  // ── 5. RELEASE → re-enabled ──
  const rel = await inj('POST', '/api/lots/LOT-A1/release', wh1, { reason: 'Cleared — lab results in spec' });
  ok('POST release LOT-A1 → Released', rel.status < 300 && rel.json.status === 'Released', JSON.stringify(rel.json));
  const fefo2 = await inj('GET', '/api/lots/fefo/A', wh1);
  ok('FEFO(A) after release RE-INCLUDES LOT-A1 (count 2, excluded_held=0)', fefo2.json.count === 2 && fefo2.json.excluded_held === 0, JSON.stringify((fefo2.json.lots ?? []).map((l: any) => l.lot_no)));
  const relAgain = await inj('POST', '/api/lots/LOT-A1/release', wh1, { reason: 'x' });
  ok('Release a non-held lot → 400 LOT_NOT_HELD', relAgain.status === 400 && relAgain.json?.error?.code === 'LOT_NOT_HELD', `st=${relAgain.status} code=${relAgain.json?.error?.code}`);

  // ── 6. Trace an unknown lot → 404 LOT_NOT_FOUND ──
  const nf = await inj('GET', '/api/lots/NOPE/trace', wh1);
  ok('Trace unknown lot → 404 LOT_NOT_FOUND', nf.status === 404 && nf.json?.error?.code === 'LOT_NOT_FOUND', `st=${nf.status}`);

  console.log('\n── INV-5 / INV-18 — lot recall / genealogy trace + lot hold ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} lot-trace checks failed` : `\n✅ All ${checks.length} lot-trace checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
