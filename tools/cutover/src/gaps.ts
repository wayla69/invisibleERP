/**
 * Cutover check — remaining parity gaps: Claims, Delivery, Lots, AP/AR aging,
 * Scan sessions, Image manager, User CRUD, Portal sub-accounts.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover gaps
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { ymd } from '../../../apps/api/dist/database/queries';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const daysAhead = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'Tenant One' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  const t1 = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  await db.insert(s.items).values({ itemId: 'A', itemDescription: 'Apple', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();

  // Order + line + sales claim
  const [o] = await db.insert(s.orders).values({ orderNo: 'SO-TEST-1', orderDate: ymd(), tenantId: hq.id, status: 'Shipped', createdBy: 'admin' }).returning({ id: s.orders.id });
  const [ol] = await db.insert(s.orderLines).values({ orderId: Number(o.id), itemId: 'A', itemDescription: 'Apple', orderQty: '10', stockUom: 'EA', unitPrice: '10', totalPrice: '100' }).returning({ id: s.orderLines.id });
  await db.insert(s.orderClaims).values({ orderLineId: Number(ol.id), claimedQty: '2', claimReason: 'Damaged', adminStatus: 'Waiting' });

  // EXP-12: a GR claim must reference a REAL receipt inside the claim window (goods_receipts.created_at
  // anchors the 24h cutoff), so seed the GR the claim below targets — a free-text gr_no now 404s.
  await db.insert(s.goodsReceipts).values({ grNo: 'GR-1', grDate: ymd(), vendorName: 'V1', receivedBy: 'admin' });

  // AR overdue ~40d, AP overdue ~70d
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-TEST-1', invoiceDate: daysAgo(70), dueDate: daysAgo(40), tenantId: hq.id, amount: '100', paidAmount: '0', status: 'Unpaid' });
  await db.insert(s.apTransactions).values({ txnNo: 'AP-TEST-1', tenantId: hq.id, vendorName: 'V1', dueDate: daysAgo(70), amount: '200', paidAmount: '0', status: 'Unpaid' });

  // Lot ledger: one expiring in 5d, one in 100d
  await db.insert(s.lotLedger).values({ lotNo: 'L1', itemId: 'A', itemDescription: 'Apple', uom: 'EA', locationId: 'WH-MAIN', qtyIn: '10', qtyOut: '0', balance: '10', expiryDate: daysAhead(5), status: 'Active' });
  await db.insert(s.lotLedger).values({ lotNo: 'L2', itemId: 'A', itemDescription: 'Apple', uom: 'EA', locationId: 'WH-MAIN', qtyIn: '5', qtyOut: '0', balance: '5', expiryDate: daysAhead(100), status: 'Active' });
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, body: res.body as string, ctype: String(res.headers['content-type'] ?? '') };
  };
  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // ── Claims (sales) ──
  const sc = await inj('GET', '/api/claims/sales', token);
  ok('list sales claims (1 Waiting)', sc.status === 200 && sc.json.claims.length === 1 && sc.json.claims[0].admin_status === 'Waiting', `n=${sc.json.claims?.length}`);
  const cid = sc.json.claims[0]?.id;
  const dec = await inj('PATCH', `/api/claims/sales/${cid}`, token, { decision: 'approve' });
  ok('approve sales claim', (dec.status === 200 || dec.status === 201) && dec.json.admin_status === 'Approved');
  const rej = await inj('PATCH', `/api/claims/sales/${cid}`, token, { decision: 'reject' });
  ok('reject without reason → 400', rej.status === 400);

  // ── Claims (GR) ──
  const gc = await inj('POST', '/api/claims/gr', token, { gr_no: 'GR-1', item_id: 'A', claim_qty: 3, reason: 'Short' });
  ok('create GR claim → GRC-', (gc.status === 200 || gc.status === 201) && /^GRC-\d{8}-\d{3}$/.test(gc.json.claim_no), `no=${gc.json.claim_no}`);
  const gl = await inj('GET', '/api/claims/gr', token);
  ok('list GR claims (1)', gl.json.claims.length === 1);
  const gr = await inj('PATCH', `/api/claims/gr/${gc.json.claim_no}`, token, { status: 'Resolved', resolution: 'credit note' });
  ok('resolve GR claim', gr.json.status === 'Resolved');

  // ── Delivery ──
  // Pending-list feed for the /delivery order dropdown: only open (Pending/Processing) SOs appear.
  const hqRow = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.orders).values({ orderNo: 'SO-TEST-2', orderDate: ymd(), tenantId: hqRow.id, status: 'Pending', createdBy: 'admin' });
  const oo = await inj('GET', '/api/delivery/open-orders', token);
  const ooNos = (oo.json.orders ?? []).map((x: any) => x.order_no);
  ok('open-orders lists Pending SO, not Shipped', oo.status === 200 && ooNos.includes('SO-TEST-2') && !ooNos.includes('SO-TEST-1'), JSON.stringify(ooNos));
  const dv = await inj('POST', '/api/delivery', token, { order_no: 'SO-TEST-1', driver: 'Somchai' });
  ok('create delivery from order → DO- (lines derived)', (dv.status === 200 || dv.status === 201) && /^DO-\d{8}-\d{3}$/.test(dv.json.do_no) && dv.json.lines === 1, `no=${dv.json.do_no} lines=${dv.json.lines}`);
  const dd = await inj('GET', `/api/delivery/${dv.json.do_no}`, token);
  ok('delivery detail has items', dd.status === 200 && dd.json.items.length === 1);
  const ds = await inj('PATCH', `/api/delivery/${dv.json.do_no}/status`, token, { status: 'Delivered', pod_image_key: 'pod1' });
  ok('mark delivered', ds.json.status === 'Delivered');

  // ── Lots ──
  const ll = await inj('GET', '/api/lots', token);
  ok('lot ledger lists 2', ll.status === 200 && ll.json.lots.length === 2, `n=${ll.json.lots?.length}`);
  const le = await inj('GET', '/api/lots/expiry', token);
  ok('expiry bucket d0_7 has 1', le.status === 200 && le.json.summary.d0_7 === 1, JSON.stringify(le.json.summary));
  const lf = await inj('GET', '/api/lots/fefo/A', token);
  ok('FEFO sorted soonest-first (L1)', lf.json.lots[0]?.lot_no === 'L1' && lf.json.total_balance === 15);

  // ── Aging ──
  const ara = await inj('GET', '/api/finance/ar/aging', token);
  ok('AR aging 31-60 bucket = 100', ara.status === 200 && ara.json.buckets.d31_60 === 100, JSON.stringify(ara.json.buckets));
  const apa = await inj('GET', '/api/finance/ap/aging', token);
  ok('AP aging 61-90 bucket = 200', apa.status === 200 && apa.json.buckets.d61_90 === 200, JSON.stringify(apa.json.buckets));
  const apx = await inj('GET', '/api/reports/ap-aging/export', token);
  ok('AP-aging xlsx export', apx.status === 200 && apx.body?.slice(0, 2) === 'PK');

  // ── Images ──
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const iu = await inj('POST', '/api/images/A', token, { data_url: png });
  ok('upload item image', (iu.status === 200 || iu.status === 201) && iu.json.ok === true);
  const ig = await inj('GET', '/api/images/A', token);
  ok('get item image data_url', ig.status === 200 && ig.json.data_url.startsWith('data:image/png'));
  const ib = await inj('POST', '/api/images/A', token, { data_url: 'notanimage' });
  ok('bad image → 400', ib.status === 400);

  // ── Scan sessions ──
  const ss = await inj('POST', '/api/scan/sessions', token, { session_type: 'Issue', location_id: 'WH-MAIN' });
  ok('open scan session → SCAN-', (ss.status === 200 || ss.status === 201) && /^SCAN-\d{14}$/.test(ss.json.session_no), `no=${ss.json.session_no}`);
  await inj('POST', `/api/scan/sessions/${ss.json.session_no}/lines`, token, { qr_data: 'ITEM_ID:A|DESC:Apple', qty: 2 });
  const sg = await inj('GET', `/api/scan/sessions/${ss.json.session_no}`, token);
  ok('scan line recorded (item A)', sg.json.lines.length === 1 && sg.json.lines[0].item_id === 'A');
  const sclose = await inj('POST', `/api/scan/sessions/${ss.json.session_no}/close`, token);
  ok('close session commits 1 movement', (sclose.status === 200 || sclose.status === 201) && sclose.json.committed === 1);
  const mv = await db.select().from(s.stockMovements).where(eq(s.stockMovements.docNo, ss.json.session_no));
  ok('scan Issue movement qty=-2', mv.length === 1 && Number(mv[0].qty) === -2, `qty=${mv[0]?.qty}`);

  // ── User CRUD ──
  const uc = await inj('POST', '/api/admin/users', token, { username: 'u1', password: 'secret1', role: 'Sales' });
  ok('create user', (uc.status === 200 || uc.status === 201) && uc.json.created === true);
  const ulist = await inj('GET', '/api/admin/users', token);
  ok('list users includes u1', ulist.json.users.some((x: any) => x.username === 'u1'));
  // SoD redesign: the coarse `warehouse` perm bundles wh_adjust+wh_count (R11 conflict). Assign the
  // single-duty WarehouseOperator perms instead — SoD-clean and the realistic post-redesign grant.
  const uup = await inj('PATCH', '/api/admin/users/u1', token, { role: 'Warehouse', permissions: ['wh_receive', 'wh_custody', 'lots', 'locations'] });
  ok('update user role+perms', uup.json.updated === true);
  const urp = await inj('POST', '/api/admin/users/u1/reset-password', token, { password: 'newpass1' });
  ok('reset password', urp.json.reset === true);
  const ulogin = await inj('POST', '/api/login', undefined, { username: 'u1', password: 'newpass1' });
  ok('reset user can log in', ulogin.status === 200 && !!ulogin.json.token);
  const udel = await inj('DELETE', '/api/admin/users/u1', token);
  ok('delete user', udel.json.deleted === true);
  const uself = await inj('DELETE', '/api/admin/users/admin', token);
  ok('cannot delete self → 400', uself.status === 400);

  // ── Portal sub-accounts (admin tenant = HQ) ──
  const su = await inj('POST', '/api/portal/my/users', token, { username: 'staff1', password: 'secret1', permissions: ['cust_pos', 'cust_inventory'] });
  ok('create sub-account', (su.status === 200 || su.status === 201) && su.json.created === true);
  const sl = await inj('GET', '/api/portal/my/users', token);
  ok('sub-account appears in my-users', sl.json.users.some((x: any) => x.username === 'staff1'));
  const sd = await inj('DELETE', '/api/portal/my/users/staff1', token);
  ok('delete sub-account', sd.json.deleted === true);

  await app.close();
  await pg.close();

  console.log('\n── Remaining gaps (claims/delivery/lots/aging/scan/images/users/sub-accounts) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
