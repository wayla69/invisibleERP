/**
 * Phase 6 e2e — boot Nest app จริง (full stack: guards/pipes/controllers/services) แบบ in-process
 * โดย override DRIZZLE เป็น PGlite, แล้วยิง HTTP จำลองด้วย app.inject(). พิสูจน์ deployable artifact
 * (login JWT, RBAC, read/write จริงผ่าน HTTP) โดยไม่ต้องมี Postgres/Docker.
 *   pnpm --filter @ierp/cutover e2e
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { blindIndex } from '../../../apps/api/dist/database/encrypted-column';
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

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'Tenant One' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  const t1 = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  const now = new Date();
  for (const [id, desc, qty] of [['A', 'Apple', 5], ['B', 'Banana', -2], ['C', 'Cherry', 0]] as [string, string, number][]) {
    await db.insert(s.items).values({ itemId: id, itemDescription: desc, uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
    await db.insert(s.stockSnapshots).values({ generateDate: now, itemId: id, itemDescription: desc, uom: 'EA', avQty: String(qty), totalStock: String(qty) });
  }
  const today = ymd(); // Bangkok-tz date to match the dashboard's ymd() (UTC slice flaked in the 00:00–07:00 BKK window)
  const [sale] = await db.insert(s.custPosSales).values({ saleNo: 'SALE-T1-1', saleDate: today, tenantId: t1.id, total: '107', subtotal: '100', taxAmount: '7', status: 'Completed', paymentMethod: 'Cash', createdBy: 'admin' }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values({ saleId: Number(sale.id), itemId: 'A', itemDescription: 'Apple', qty: '10', amount: '100' });
  // a loyalty member (for the omni-search member type — its deep-link keys on the numeric id)
  await db.insert(s.posMembers).values({ tenantId: t1.id, memberCode: 'M001', name: 'Alice Member', phone: '0812345678', phoneBidx: blindIndex('0812345678') });
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)) // services get the tenant-aware proxy (RLS tx)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {};
    try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };

  // health (public)
  ok('GET / health 200', (await inj('GET', '/')).status === 200);

  // login
  const login = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  ok('login 200 + token + Admin', login.status === 200 && !!login.json.token && login.json.role === 'Admin', `status=${login.status}`);
  const token = login.json.token;
  ok('login bad password → 401', (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'x' })).status === 401);
  ok('no token → 401', (await inj('GET', '/api/dashboard')).status === 401);

  const me = await inj('GET', '/api/auth/me', token);
  ok('/auth/me 200 + permissions', me.status === 200 && Array.isArray(me.json.permissions) && me.json.permissions.length > 0);

  const dash = await inj('GET', '/api/dashboard', token);
  ok('dashboard today.sales = 107', dash.status === 200 && dash.json.today?.sales === 107, `sales=${dash.json.today?.sales}`);
  ok('dashboard low_stock_count = 2', dash.json.low_stock_count === 2, `low=${dash.json.low_stock_count}`);

  const stock = await inj('GET', '/api/inventory/stock?limit=50', token);
  ok('inventory/stock total = 3', stock.status === 200 && stock.json.total === 3, `total=${stock.json.total}`);
  ok('inventory/stock low_stock_count = 2', stock.json.low_stock_count === 2);

  ok('finance/kpi mtd_revenue = 107', (await inj('GET', '/api/finance/kpi', token)).json.mtd_revenue === 107);
  ok('notifications counts.low_stock = 2', (await inj('GET', '/api/notifications', token)).json.counts?.low_stock === 2);
  ok('analytics/replenishment 200', (await inj('GET', '/api/analytics/replenishment', token)).status === 200);

  // global omni-search (⌘K records): the item master is reachable and deep-links to its detail page
  const searchApp = await inj('GET', '/api/search?q=App', token);
  ok('GET /api/search?q=App → item A deep-links /inventory/A',
    searchApp.status === 200 && (searchApp.json.results ?? []).some((r: any) => r.type === 'item' && r.id === 'A' && r.href === '/inventory/A'),
    `count=${searchApp.json.results?.length}`);
  ok('GET /api/search min-length guard (1 char → empty)', (await inj('GET', '/api/search?q=A', token)).json.results?.length === 0);
  ok('GET /api/search no-match → 200 empty', (await inj('GET', '/api/search?q=zzzznope', token)).json.results?.length === 0);
  // member type: deep-links to the real detail page keyed on the NUMERIC id (/loyalty/members/{id})
  const searchMem = await inj('GET', '/api/search?q=Alice', token);
  ok('GET /api/search?q=Alice → member deep-links /loyalty/members/{id}',
    (searchMem.json.results ?? []).some((r: any) => r.type === 'member' && /^\d+$/.test(r.id) && r.href === `/loyalty/members/${r.id}`),
    `count=${searchMem.json.results?.length}`);
  // document types: the seeded POS sale is found and deep-links to the filtered list
  const searchSale = await inj('GET', '/api/search?q=SALE-T1', token);
  ok('GET /api/search?q=SALE-T1 → sale deep-links /pos?q=',
    (searchSale.json.results ?? []).some((r: any) => r.type === 'sale' && r.id === 'SALE-T1-1' && r.href === '/pos?q=SALE-T1-1'),
    `count=${searchSale.json.results?.length}`);

  // write over HTTP (transaction + doc number + loyalty)
  const create = await inj('POST', '/api/pos/orders', token, { customer_name: 'T1', items: [{ item_id: 'A', order_qty: 2, unit_price: 10 }] });
  ok('POST /api/pos/orders 201 + SO-', (create.status === 200 || create.status === 201) && /^SO-\d{8}-\d{4}$/.test(create.json.order_no), `status=${create.status} no=${create.json.order_no}`);
  const orders = await inj('GET', '/api/pos/orders', token);
  ok('new order appears in list', Array.isArray(orders.json.orders) && orders.json.orders.length >= 1);

  // procurement chain over HTTP
  const po = await inj('POST', '/api/procurement/pos', token, { vendor_name: 'V1', items: [{ item_id: 'A', order_qty: 5, unit_price: 4 }] });
  ok('POST /procurement/pos → PO- total 20', /^PO-\d{8}-\d{3}$/.test(po.json.po_no) && po.json.total_amount === 20, `${po.json.po_no} ${po.json.total_amount}`);
  // omni-search now finds the just-created PO (by po_no and by vendor name) and deep-links to the filtered list
  const searchPo = await inj('GET', `/api/search?q=${po.json.po_no}`, token);
  ok('GET /api/search?q=<po_no> → purchase_order deep-links /inventory/purchase-orders?q=',
    (searchPo.json.results ?? []).some((r: any) => r.type === 'purchase_order' && r.id === po.json.po_no && r.href === `/inventory/purchase-orders?q=${encodeURIComponent(po.json.po_no)}`),
    `count=${searchPo.json.results?.length}`);
  ok('GET /api/search?q=V1 → finds PO by vendor name', (await inj('GET', '/api/search?q=V1', token)).json.results?.some((r: any) => r.type === 'purchase_order'));

  // chat without key → 503 (route + auth ok)
  ok('POST /api/chat → 503 (no AI key)', (await inj('POST', '/api/chat', token, { message: 'hi' })).status === 503);

  await app.close();
  await pg.close();

  console.log('\n── Phase 6 e2e (real Nest app, HTTP via inject, PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} e2e checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} e2e checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
