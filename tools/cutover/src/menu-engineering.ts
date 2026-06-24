/**
 * C4 — Restaurant management analytics: menu-engineering matrix (Kasavana–Smith), daypart/hour demand
 * on the business clock (Asia/Bangkok), and void/discount (shrinkage) analytics — over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover menu-engineering
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'me-secret';
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
const near = (a: any, b: number, eps = 0.01) => Math.abs(Number(a) - b) < eps;

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

  const DAY = '2026-06-20';
  // ── menu items: each engineered to land in a distinct quadrant ──
  // A Star (hi pop, hi margin), B Plowhorse (hi pop, lo margin), C Puzzle (lo pop, hi margin), D Dog (lo pop, lo margin)
  await db.insert(s.menuItems).values([
    { tenantId: t1, sku: 'A', name: 'ผัดไทยกุ้ง', price: '200.00', cost: '40.00', active: true },
    { tenantId: t1, sku: 'B', name: 'ข้าวผัด', price: '100.00', cost: '80.00', active: true },
    { tenantId: t1, sku: 'C', name: 'สเต๊กพรีเมียม', price: '300.00', cost: '60.00', active: true },
    { tenantId: t1, sku: 'D', name: 'น้ำเปล่า', price: '90.00', cost: '70.00', active: true },
  ]);
  // 5 sales on DAY (1 carries the item lines; 4 empty bump sales_count for the void rate)
  const saleIds: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const [row] = await db.insert(s.custPosSales).values({ saleNo: `SALE-ME-${i}`, saleDate: DAY, tenantId: t1, status: 'Completed', subtotal: '0', total: '0' }).returning({ id: s.custPosSales.id });
    saleIds.push(Number(row.id));
  }
  await db.insert(s.custPosItems).values([
    { saleId: saleIds[0], itemId: 'A', itemDescription: 'ผัดไทยกุ้ง', qty: '40', unitPrice: '200.00', amount: '8000.00' },
    { saleId: saleIds[0], itemId: 'B', itemDescription: 'ข้าวผัด', qty: '40', unitPrice: '100.00', amount: '4000.00' },
    { saleId: saleIds[0], itemId: 'C', itemDescription: 'สเต๊กพรีเมียม', qty: '5', unitPrice: '300.00', amount: '1500.00' },
    { saleId: saleIds[0], itemId: 'D', itemDescription: 'น้ำเปล่า', qty: '5', unitPrice: '90.00', amount: '450.00' },
  ]);
  // captured tenders timed by UTC → Bangkok (+7): 01:30→08:30 breakfast, 05:30→12:30 lunch,
  // 12:00/12:30→19:00/19:30 dinner, 19th 18:00→20th 01:00 late.
  await db.insert(s.payments).values([
    { paymentNo: 'PAY-ME-1', saleNo: 'SALE-ME-1', tenantId: t1, method: 'Cash', amount: '100.0000', currency: 'THB', status: 'Captured', createdAt: new Date('2026-06-20T01:30:00Z') },
    { paymentNo: 'PAY-ME-2', saleNo: 'SALE-ME-1', tenantId: t1, method: 'Cash', amount: '200.0000', currency: 'THB', status: 'Captured', createdAt: new Date('2026-06-20T05:30:00Z') },
    { paymentNo: 'PAY-ME-3', saleNo: 'SALE-ME-1', tenantId: t1, method: 'Card', amount: '500.0000', currency: 'THB', status: 'Captured', createdAt: new Date('2026-06-20T12:00:00Z') },
    { paymentNo: 'PAY-ME-4', saleNo: 'SALE-ME-1', tenantId: t1, method: 'Card', amount: '300.0000', currency: 'THB', status: 'Captured', createdAt: new Date('2026-06-20T12:30:00Z') },
    { paymentNo: 'PAY-ME-5', saleNo: 'SALE-ME-1', tenantId: t1, method: 'Cash', amount: '50.0000', currency: 'THB', status: 'Captured', createdAt: new Date('2026-06-19T18:00:00Z') },
  ]);
  // manager overrides (voids + a discount) on DAY (UTC 05:00 → 12:00 Bangkok)
  await db.insert(s.posOverrides).values([
    { tenantId: t1, overrideNo: 'OVR-ME-1', action: 'void', reasonCode: 'wrong_order', amount: '150.00', requestedBy: 'cashier1', createdAt: new Date('2026-06-20T05:00:00Z') },
    { tenantId: t1, overrideNo: 'OVR-ME-2', action: 'void', reasonCode: 'customer_left', amount: '90.00', requestedBy: 'cashier1', createdAt: new Date('2026-06-20T05:00:00Z') },
    { tenantId: t1, overrideNo: 'OVR-ME-3', action: 'discount', reasonCode: 'staff_meal', amount: '50.00', requestedBy: 'mgr1', createdAt: new Date('2026-06-20T05:00:00Z') },
  ]);

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (url: string, token?: string) => {
    const res = await app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'boss', password: 'pw' } })).json().token;
  const win = `from=${DAY}&to=${DAY}`;

  // ── 1. menu-engineering: 4 items → one in each quadrant ──
  const me = await inj(`/api/analytics/menu-engineering?${win}`, token);
  const byItem = Object.fromEntries((me.json.items ?? []).map((i: any) => [i.item_id, i]));
  ok('menu-engineering: 1 Star + 1 Plowhorse + 1 Puzzle + 1 Dog, 90 units',
    me.status === 200 && me.json.summary?.items === 4 && me.json.summary?.units_sold === 90 &&
    me.json.summary?.stars === 1 && me.json.summary?.plowhorses === 1 && me.json.summary?.puzzles === 1 && me.json.summary?.dogs === 1,
    JSON.stringify(me.json.summary));
  ok('quadrant assignment: A=Star B=Plowhorse C=Puzzle D=Dog',
    byItem.A?.quadrant === 'Star' && byItem.B?.quadrant === 'Plowhorse' && byItem.C?.quadrant === 'Puzzle' && byItem.D?.quadrant === 'Dog',
    JSON.stringify({ A: byItem.A?.quadrant, B: byItem.B?.quadrant, C: byItem.C?.quadrant, D: byItem.D?.quadrant }));
  ok('70% popularity threshold = 0.175, total contribution = 8500',
    near(me.json.thresholds?.popularity_share_threshold, 0.175, 0.001) && near(me.json.summary?.total_contribution, 8500, 0.5),
    JSON.stringify({ thr: me.json.thresholds?.popularity_share_threshold, contrib: me.json.summary?.total_contribution }));
  ok('Star A unit margin 160 + actionable recommendation present',
    near(byItem.A?.unit_margin, 160) && typeof byItem.A?.action === 'string' && byItem.A.action.length > 0,
    JSON.stringify({ m: byItem.A?.unit_margin, a: byItem.A?.action?.slice(0, 24) }));

  // ── 2. daypart on the business clock (Asia/Bangkok) ──
  const dp = await inj(`/api/analytics/daypart?${win}`, token);
  const part = Object.fromEntries((dp.json.by_daypart ?? []).map((p: any) => [p.daypart, p]));
  const hour = Object.fromEntries((dp.json.by_hour ?? []).map((h: any) => [h.hour, h]));
  ok('daypart buckets: breakfast 100/1, lunch 200/1, dinner 800/2, late 50/1',
    near(part.breakfast?.revenue, 100) && part.breakfast?.txns === 1 && near(part.lunch?.revenue, 200) &&
    near(part.dinner?.revenue, 800) && part.dinner?.txns === 2 && near(part.late?.revenue, 50),
    JSON.stringify({ b: part.breakfast?.revenue, l: part.lunch?.revenue, d: part.dinner?.revenue, late: part.late?.revenue }));
  ok('hour-of-day on Bangkok clock: 08:00=100, 12:00=200, 19:00=800, 01:00=50 (no UTC drift)',
    near(hour[8]?.revenue, 100) && near(hour[12]?.revenue, 200) && near(hour[19]?.revenue, 800) && hour[19]?.txns === 2 && near(hour[1]?.revenue, 50),
    JSON.stringify({ h8: hour[8]?.revenue, h12: hour[12]?.revenue, h19: hour[19]?.revenue, h1: hour[1]?.revenue }));
  ok('peak = dinner / 19:00; totals revenue 1150 txns 5',
    dp.json.summary?.peak_daypart === 'dinner' && dp.json.summary?.peak_hour === 19 && near(dp.json.summary?.revenue, 1150) && dp.json.summary?.txns === 5,
    JSON.stringify(dp.json.summary));

  // ── 3. void / discount (shrinkage) analytics ──
  const vd = await inj(`/api/analytics/voids-discounts?${win}`, token);
  const act = Object.fromEntries((vd.json.by_action ?? []).map((a: any) => [a.action, a]));
  const actor = Object.fromEntries((vd.json.by_actor ?? []).map((a: any) => [a.requested_by, a]));
  ok('voids: 2 voids (฿240) + 1 discount (฿50); void_rate 40% of 5 sales',
    vd.json.summary?.void_count === 2 && near(act.void?.amount, 240) && act.void?.count === 2 &&
    near(act.discount?.amount, 50) && vd.json.summary?.sales_count === 5 && near(vd.json.summary?.void_rate_pct, 40),
    JSON.stringify(vd.json.summary));
  ok('shrinkage by actor: cashier1 2 events ฿240; reasons broken out',
    actor.cashier1?.count === 2 && near(actor.cashier1?.amount, 240) && (vd.json.by_reason ?? []).length === 3,
    JSON.stringify({ cashier1: actor.cashier1, reasons: (vd.json.by_reason ?? []).length }));

  console.log('\n── C4 — Menu-engineering + daypart + void analytics (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} menu-engineering checks failed` : `\n✅ All ${checks.length} menu-engineering checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
