/**
 * C8 — Staff/cashier performance + sales trend (period-over-period). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover analytics-staff
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'staff-secret';
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
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }]).onConflictDoNothing();
  const t1 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'T1')))[0].id);
  await db.insert(s.users).values([{ username: 'boss', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 }]).onConflictDoNothing();

  const DAY = '2026-06-20', PREV = '2026-06-19';
  const sale = (no: string, date: string, total: number, by: string) => ({ saleNo: no, saleDate: date, tenantId: t1, status: 'Completed', subtotal: String(total), total: String(total), createdBy: by });
  await db.insert(s.custPosSales).values([
    sale('S-A1', DAY, 300, 'anna'), sale('S-A2', DAY, 200, 'anna'), sale('S-B1', DAY, 100, 'ben'),  // today: anna 500/2, ben 100/1
    sale('S-P1', PREV, 400, 'anna'),                                                                  // yesterday: 400/1
  ]);
  await db.insert(s.posOverrides).values([
    { tenantId: t1, overrideNo: 'OVR-A1', action: 'void', reasonCode: 'wrong', amount: '50.00', requestedBy: 'anna', createdAt: new Date('2026-06-20T05:00:00Z') },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const get = async (url: string) => { const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } }); return { status: r.statusCode, json: r.json() }; };

  // ── 1. staff performance ──
  const sp = await get(`/api/analytics/staff-performance?from=${DAY}&to=${DAY}`);
  const byStaff = Object.fromEntries((sp.json.staff ?? []).map((x: any) => [x.staff, x]));
  ok('staff perf: anna 2 sales ฿500 (avg 250) + 1 void ฿50; ben 1 sale ฿100',
    sp.status === 200 && byStaff.anna?.sales === 2 && near(byStaff.anna?.revenue, 500) && near(byStaff.anna?.avg_ticket, 250) && byStaff.anna?.voids === 1 && near(byStaff.anna?.void_amount, 50) && byStaff.ben?.sales === 1 && near(byStaff.ben?.revenue, 100),
    JSON.stringify({ anna: byStaff.anna, ben: byStaff.ben }));
  ok('staff perf summary: 2 staff, ฿600 over 3 sales, ranked by revenue (anna first)',
    sp.json.summary?.staff === 2 && near(sp.json.summary?.revenue, 600) && sp.json.summary?.sales === 3 && sp.json.staff?.[0]?.staff === 'anna',
    JSON.stringify(sp.json.summary));

  // ── 2. sales trend vs the prior equal window ──
  const tr = await get(`/api/analytics/sales-trend?from=${DAY}&to=${DAY}`);
  ok('sales trend: today ฿600/3 vs yesterday ฿400/1 → +฿200 (+50%), +2 txns',
    near(tr.json.current?.revenue, 600) && tr.json.current?.txns === 3 && near(tr.json.previous?.revenue, 400) && tr.json.previous?.txns === 1 &&
    near(tr.json.revenue_delta, 200) && near(tr.json.revenue_delta_pct, 50) && tr.json.txn_delta === 2 && tr.json.previous?.from === PREV,
    JSON.stringify({ cur: tr.json.current?.revenue, prev: tr.json.previous?.revenue, dpct: tr.json.revenue_delta_pct }));

  console.log('\n── C8 — Staff performance + sales trend (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} staff/trend checks failed` : `\n✅ All ${checks.length} staff/trend checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
