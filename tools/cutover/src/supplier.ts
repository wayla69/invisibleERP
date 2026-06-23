/**
 * Phase D3 — Supplier portal over PGlite.
 * Proves a vendor self-scopes to ONLY their own vendor record: sees their POs (not other vendors'),
 * acknowledges a PO, submits an invoice (→ pending AP), and cannot submit against another vendor's PO;
 * an unlinked user is refused.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover supplier
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sup-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'sup1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
    { username: 'ghost', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
  ]).onConflictDoNothing();
  // two vendors; sup1 is linked to V1 only
  await db.insert(s.vendors).values([
    { tenantId: t1, vendorCode: 'V1', name: 'Acme Supply', userName: 'sup1', currency: 'THB' },
    { tenantId: t1, vendorCode: 'V2', name: 'Other Vendor', currency: 'THB' },
  ]).onConflictDoNothing();
  const vid = async (code: string) => Number((await db.select().from(s.vendors).where(eq(s.vendors.vendorCode, code)))[0].id);
  const [v1, v2] = [await vid('V1'), await vid('V2')];
  // a PO for V1 and one for V2 (purchase_orders is keyed by vendor, not tenant)
  const po1 = await db.insert(s.purchaseOrders).values({ poNo: 'PO-T-001', poDate: '2026-06-20', vendorId: v1, vendorName: 'Acme Supply', status: 'Pending', totalAmount: '1000' }).returning({ id: s.purchaseOrders.id });
  await db.insert(s.poItems).values({ poId: Number(po1[0].id), itemId: 'WIDGET', itemDescription: 'Widget', orderQty: '10', unitPrice: '100', amount: '1000' });
  await db.insert(s.purchaseOrders).values({ poNo: 'PO-T-002', poDate: '2026-06-20', vendorId: v2, vendorName: 'Other Vendor', status: 'Pending', totalAmount: '500' });

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
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const sup1 = await login('sup1'); const ghost = await login('ghost');

  // 1. vendor sees only their own POs
  const pos = await inj('GET', '/api/supplier/purchase-orders', sup1);
  ok('Supplier sees only own PO (PO-T-001, not V2)', pos.json.count === 1 && pos.json.purchase_orders?.[0]?.po_no === 'PO-T-001', JSON.stringify(pos.json).slice(0, 100));

  // 2. PO detail with items
  const det = await inj('GET', '/api/supplier/purchase-orders/PO-T-001', sup1);
  ok('PO detail returns line items', det.json.items?.length === 1 && det.json.items[0].item_id === 'WIDGET', JSON.stringify(det.json).slice(0, 90));

  // 3. cannot see another vendor's PO
  const other = await inj('GET', '/api/supplier/purchase-orders/PO-T-002', sup1);
  ok("Cannot view another vendor's PO → 404", other.status === 404, `${other.status}`);

  // 4. acknowledge
  const ack = await inj('POST', '/api/supplier/purchase-orders/PO-T-001/acknowledge', sup1);
  ok('Acknowledge PO → sets acknowledged_at', !!ack.json.acknowledged_at, JSON.stringify(ack.json).slice(0, 80));

  // 5. submit invoice against own PO → pending AP
  const inv = await inj('POST', '/api/supplier/invoices', sup1, { po_no: 'PO-T-001', invoice_no: 'INV-ACME-1', amount: 1000, vat_amount: 70 });
  ok('Submit invoice → AP- pending (Unpaid)', /^AP-/.test(inv.json.txn_no ?? '') && inv.json.status === 'Unpaid', `${inv.status} ${JSON.stringify(inv.json)}`);
  const invList = await inj('GET', '/api/supplier/invoices', sup1);
  ok('Invoice appears in own list', invList.json.count === 1 && invList.json.invoices?.[0]?.invoice_no === 'INV-ACME-1', JSON.stringify(invList.json).slice(0, 80));

  // 6. cannot submit invoice against another vendor's PO
  const bad = await inj('POST', '/api/supplier/invoices', sup1, { po_no: 'PO-T-002', invoice_no: 'X', amount: 1 });
  ok("Invoice against another vendor's PO → 400 PO_NOT_YOURS", bad.status === 400 && bad.json.error?.code === 'PO_NOT_YOURS', `${bad.status} ${bad.json.error?.code}`);

  // 7. unlinked user refused
  const g = await inj('GET', '/api/supplier/purchase-orders', ghost);
  ok('Unlinked user → 403 VENDOR_NOT_LINKED', g.status === 403 && g.json.error?.code === 'VENDOR_NOT_LINKED', `${g.status} ${g.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── Phase D3 — Supplier portal ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} supplier checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} supplier checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
