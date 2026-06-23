/**
 * Review W6 — coverage for the customer-360 endpoint (GET /api/customers/:name) and the analytics HTTP
 * layer (replenishment / dashboard-summary) through the real guard stack (auth + @Permissions + RLS).
 * These were previously untested at the HTTP layer.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover customers
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'customers-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },
    { username: 'crmT2', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t2 }, // + crm grant → RLS test
    { username: 'noperm', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t1 }, // no crm/dashboard/ar
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  for (const p of ['crm', 'dashboard', 'ar']) await db.insert(s.userPermissions).values({ userId: await uid('crmT2'), perm: p }).onConflictDoNothing();

  // T1 sales: 2 Completed (100 + 200) + 1 Voided (excluded from stats); one unpaid AR invoice (outstanding 150)
  await db.insert(s.custPosSales).values([
    { saleNo: 'SALE-C1', saleDate: '2026-06-01', tenantId: t1, status: 'Completed', total: '100' },
    { saleNo: 'SALE-C2', saleDate: '2026-06-02', tenantId: t1, status: 'Completed', total: '200' },
    { saleNo: 'SALE-C3', saleDate: '2026-06-03', tenantId: t1, status: 'Voided', total: '999' },
  ]);
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-C1', tenantId: t1, amount: '150', paidAmount: '0', status: 'Unpaid' }).onConflictDoNothing();

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
  const [admin, crmT2, noperm] = [await login('admin'), await login('crmT2'), await login('noperm')];

  // ── customer-360 ──
  const c = await inj('GET', '/api/customers/T1', admin);
  ok('Customer 360: stats exclude Voided (count 2, lifetime 300)', c.status === 200 && c.json.stats?.order_count === 2 && near(c.json.stats?.lifetime_value, 300), JSON.stringify(c.json.stats));
  ok('Customer 360: AR balance (outstanding 150, 1 open invoice)', near(c.json.ar_balance?.outstanding, 150) && c.json.ar_balance?.open_invoices === 1, JSON.stringify(c.json.ar_balance));
  ok('Customer 360: recent orders listed (2 non-… all statuses incl Voided)', Array.isArray(c.json.orders) && c.json.orders.length === 3, `orders=${c.json.orders?.length}`);

  // ── permission gate: a user without crm/dashboard/ar is denied ──
  const denied = await inj('GET', '/api/customers/T1', noperm);
  ok('Customer 360 permission gate → 403 without crm/dashboard/ar', denied.status === 403, `status=${denied.status}`);

  // ── RLS: a T2 user resolving T1's code sees NONE of T1's data (count 0) ──
  const cross = await inj('GET', '/api/customers/T1', crmT2);
  ok('Customer 360 RLS: T2 user gets 0 of T1 sales/AR', cross.status === 200 && cross.json.stats?.order_count === 0 && near(cross.json.ar_balance?.outstanding, 0), JSON.stringify({ n: cross.json.stats?.order_count, ar: cross.json.ar_balance?.outstanding }));

  // ── analytics HTTP layer through the guard stack ──
  const repl = await inj('GET', '/api/analytics/replenishment', admin);
  ok('Analytics replenishment → 200 through guard stack', repl.status === 200, `status=${repl.status}`);
  const dash = await inj('GET', '/api/analytics/dashboard-summary', admin);
  ok('Analytics dashboard-summary → 200', dash.status === 200, `status=${dash.status}`);
  const anom = await inj('GET', '/api/analytics/anomalies?days=abc', admin);
  ok('Analytics anomalies with bad days → 400 BAD_QUERY (qint)', anom.status === 400 && anom.json.error?.code === 'BAD_QUERY', `${anom.status} ${anom.json.error?.code}`);
  const aDenied = await inj('GET', '/api/analytics/replenishment', noperm);
  ok('Analytics permission gate → 403 without planner/dashboard/warehouse', aDenied.status === 403, `status=${aDenied.status}`);

  await app.close();
  await pg.close();

  console.log('\n── Review W6 — customers-360 + analytics HTTP coverage ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} customers checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} customers checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
