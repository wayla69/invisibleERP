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
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE } from '../../../apps/api/dist/database/database.module';
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
  const today = now.toISOString().slice(0, 10);
  const [sale] = await db.insert(s.custPosSales).values({ saleNo: 'SALE-T1-1', saleDate: today, tenantId: t1.id, total: '107', subtotal: '100', taxAmount: '7', status: 'Completed', paymentMethod: 'Cash', createdBy: 'admin' }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values({ saleId: Number(sale.id), itemId: 'A', itemDescription: 'Apple', qty: '10', amount: '100' });
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(db)
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

  // write over HTTP (transaction + doc number + loyalty)
  const create = await inj('POST', '/api/pos/orders', token, { customer_name: 'T1', items: [{ item_id: 'A', order_qty: 2, unit_price: 10 }] });
  ok('POST /api/pos/orders 201 + SO-', (create.status === 200 || create.status === 201) && /^SO-\d{8}-\d{4}$/.test(create.json.order_no), `status=${create.status} no=${create.json.order_no}`);
  const orders = await inj('GET', '/api/pos/orders', token);
  ok('new order appears in list', Array.isArray(orders.json.orders) && orders.json.orders.length >= 1);

  // procurement chain over HTTP
  const po = await inj('POST', '/api/procurement/pos', token, { vendor_name: 'V1', items: [{ item_id: 'A', order_qty: 5, unit_price: 4 }] });
  ok('POST /procurement/pos → PO- total 20', /^PO-\d{8}-\d{3}$/.test(po.json.po_no) && po.json.total_amount === 20, `${po.json.po_no} ${po.json.total_amount}`);

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
