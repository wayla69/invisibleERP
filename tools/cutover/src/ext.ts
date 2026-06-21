/**
 * Extension validation — boot Nest app จริง in-process (PGlite) ยิง HTTP จำลอง ตรวจ module ใหม่:
 * customer-portal, marketing/loyalty/bom, reports (ExcelJS), SSE chat route. (Admin bypass RBAC,
 * tenant=HQ ผ่าน customerName.)  pnpm --filter @ierp/cutover ext
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ext-secret';
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
import { DRIZZLE } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  // seed
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1.0', bahtPerPoint: '0.1' }).onConflictDoNothing();
  for (const [id, desc, qty] of [['A', 'Apple', 5], ['B', 'Banana', -2]] as [string, string, number][]) {
    await db.insert(s.items).values({ itemId: id, itemDescription: desc, uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
    await db.insert(s.stockSnapshots).values({ generateDate: new Date(), itemId: id, itemDescription: desc, uom: 'EA', avQty: String(qty), totalStock: String(qty) });
  }
  // customer_inventory for HQ tenant (portal POS will decrement)
  await db.insert(s.customerInventory).values({ tenantId: hq.id, itemId: 'A', itemDescription: 'Apple', uom: 'EA', currentStock: '10', reorderPoint: '5', reorderQty: '20' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(db).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, raw: res.rawPayload as Buffer };
  };

  const login = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  const token = login.json.token;
  ok('login 200', login.status === 200 && !!token);

  // ── GET smoke: route exists + DI + read query OK (200) ──
  const gets = [
    '/api/marketing/campaigns', '/api/marketing/segments', '/api/marketing/ab-tests', '/api/promotions', '/api/price-list', '/api/surveys',
    '/api/loyalty/config', '/api/loyalty/me',
    '/api/bom/master', '/api/bom/submissions',
    '/api/portal/dashboard', '/api/portal/inventory', '/api/portal/pending-orders', '/api/portal/track', '/api/portal/my/customers', '/api/portal/my/suppliers', '/api/portal/my/purchase-orders', '/api/portal/pos/sales',
  ];
  for (const ep of gets) {
    const r = await inj('GET', ep, token);
    ok(`GET ${ep} → 200`, r.status === 200, `status=${r.status}`);
  }

  // ── ExcelJS report export → valid .xlsx (PK zip magic) ──
  const xlsx = await inj('GET', '/api/reports/stock-summary/export', token);
  ok('reports stock-summary/export → xlsx (PK magic)', xlsx.status === 200 && xlsx.raw && xlsx.raw[0] === 0x50 && xlsx.raw[1] === 0x4b, `status=${xlsx.status} bytes=${xlsx.raw?.length}`);

  // ── Portal POS sale: SALE- + VAT 7% + inventory decrement + loyalty ──
  const sale = await inj('POST', '/api/portal/pos/sales', token, { items: [{ item_id: 'A', qty: 2, unit_price: 50 }] });
  ok('portal POS sale → SALE- + total 107 (VAT 7%)', (sale.status === 200 || sale.status === 201) && /^SALE-/.test(sale.json.sale_no ?? sale.json.saleNo ?? '') && near(sale.json.total, 107), `status=${sale.status} ${JSON.stringify(sale.json).slice(0, 120)}`);
  const inv = (await db.select().from(s.customerInventory).where(and(eq(s.customerInventory.tenantId, hq.id), eq(s.customerInventory.itemId, 'A'))))[0];
  ok('portal sale decremented inventory 10→8', Number(inv?.currentStock) === 8, `stock=${inv?.currentStock}`);
  const lp = (await db.select().from(s.loyaltyPoints).where(eq(s.loyaltyPoints.tenantId, hq.id)))[0];
  ok('portal sale earned loyalty points', Number(lp?.balance) > 0, `balance=${lp?.balance}`);

  // ── Mini-ERP write: my/customers create + list ──
  const addC = await inj('POST', '/api/portal/my/customers', token, { customer_name: 'ลูกค้า ก' });
  ok('portal my/customers create 200/201', addC.status === 200 || addC.status === 201, `status=${addC.status}`);
  const listC = await inj('GET', '/api/portal/my/customers', token);
  ok('portal my/customers list has 1', Array.isArray(listC.json) ? listC.json.length >= 1 : (listC.json.customers?.length ?? listC.json.data?.length ?? 0) >= 1, JSON.stringify(listC.json).slice(0, 80));

  // ── SSE chat route exists (no AI key → stream yields a note, not 404) ──
  const sse = await inj('GET', '/api/chat/stream?message=hi', token);
  ok('GET /api/chat/stream exists (not 404)', sse.status !== 404, `status=${sse.status}`);

  await app.close();
  await pg.close();

  console.log('\n── Extensions e2e (portal / marketing / loyalty / bom / reports / sse) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} extension checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} extension checks passed`);
}

const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
main().catch((e) => { console.error(e); process.exit(1); });
