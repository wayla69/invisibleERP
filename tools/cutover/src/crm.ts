/**
 * POS CRM Update — online-order loyalty sync, CRM/360 profile, RFM segmentation,
 * personalized promo targeting, branch KPI dashboard over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover crm
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'ร้านชาหนึ่ง', vatRegistered: true },
    { code: 'T2', name: 'ร้านชาสอง', vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'mgr1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'mgr2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  // Loyalty config — enabled for T1
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1', bahtPerPoint: '0.1', minRedeem: '100' }).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const [admin, mgr1, mgr2] = [await login('admin', 'admin123'), await login('mgr1', 'pw1'), await login('mgr2', 'pw2')];

  // ── 1. Enroll member for T1 ──
  const enroll = await inj('POST', '/api/loyalty/members', mgr1, { name: 'สมชาย ชาดี', phone: '0801234567' });
  const memberId = enroll.json.id as number;
  ok('Enroll member → member_code M-000XXX, id assigned', enroll.status === 201 && /^M-/.test(enroll.json.member_code ?? '') && memberId > 0, JSON.stringify(enroll.json));

  // ── 2. Channel order with member_id → pay → confirm → points earned ──
  const ord = await inj('POST', '/api/order/T1', undefined, {
    fulfillment_type: 'takeaway', member_id: memberId,
    items: [{ name: 'ชาไทย', qty: 2, unit_price: 50, station_code: 'drinks' }],
  });
  ok('Channel order create with member_id → DIN- + token', /^DIN-/.test(ord.json.order_no ?? '') && !!ord.json.token, JSON.stringify({ no: ord.json.order_no }));

  const pay = await inj('POST', `/api/order/t/${ord.json.token}/pay`, undefined, {});
  ok('Channel pay → PromptPay Pending', pay.json.status === 'Pending' && /^PAY-/.test(pay.json.payment_no ?? ''), `status=${pay.json.status}`);

  const confirm = await inj('POST', `/api/order/t/${ord.json.token}/confirm`, undefined, { payment_no: pay.json.payment_no });
  ok('Channel confirm → paid=true, points_earned > 0 (loyalty sync)', confirm.json.paid === true && Number(confirm.json.points_earned) > 0, JSON.stringify({ paid: confirm.json.paid, pts: confirm.json.points_earned }));

  // ── 3. posMemberLedger has Earn row for this sale ──
  const ledgerRows = (await pg.query(`SELECT txn_type, points, ref_doc FROM pos_member_ledger WHERE member_id=${memberId} AND txn_type='Earn'`)).rows as any[];
  const earnRow = ledgerRows.find((r: any) => r.ref_doc === confirm.json.sale_no);
  ok('posMemberLedger: Earn row linked to sale_no, points > 0', !!earnRow && Number(earnRow.points) > 0, JSON.stringify(earnRow));

  // ── 4. member_id stored on dine_in_orders ──
  const dinRow = (await pg.query(`SELECT member_id FROM dine_in_orders WHERE order_no='${ord.json.order_no}'`)).rows as any[];
  ok('dine_in_orders.member_id = enrolled member id', Number(dinRow[0]?.member_id) === memberId, `member_id=${dinRow[0]?.member_id} expected=${memberId}`);

  // ── 5. Loyalty earn idempotent — re-confirm cannot double-earn points ──
  await inj('POST', `/api/order/t/${ord.json.token}/confirm`, undefined, { payment_no: pay.json.payment_no });
  const earnRows2 = (await pg.query(`SELECT count(*)::int n FROM pos_member_ledger WHERE member_id=${memberId} AND txn_type='Earn' AND ref_doc='${confirm.json.sale_no}'`)).rows as any[];
  ok('Loyalty earn idempotent (re-confirm → still 1 ledger row, no double-earn)', earnRows2[0].n === 1, `n=${earnRows2[0].n}`);

  // ── 6. Refresh CRM profile → RFM computed ──
  const refresh = await inj('POST', `/api/crm/profile/${memberId}/refresh`, mgr1);
  ok('Refresh profile → total_orders=1, rfm_segment=New', refresh.status === 200 && refresh.json.total_orders === 1 && refresh.json.rfm_segment === 'New', JSON.stringify(refresh.json));

  // ── 7. 360-degree customer view ──
  const view = await inj('GET', `/api/crm/profile/${memberId}`, mgr1);
  ok('360 view: member + crm profile + recent_orders', view.json.member?.id === memberId && view.json.crm?.rfm_segment === 'New' && Array.isArray(view.json.recent_orders) && view.json.recent_orders.length === 1, JSON.stringify({ seg: view.json.crm?.rfm_segment, orders: view.json.recent_orders?.length }));

  // ── 7a2. Real-time loyalty tick: the earn (channel confirm) published a loyalty_points event to BiLive ──
  const live1 = await inj('GET', '/api/bi/live/recent?limit=50', mgr1);
  const earnEv = (live1.json.events ?? []).find((e: any) => e.type === 'loyalty_points' && e.kind === 'earn' && e.member_id === memberId);
  ok('Real-time: earn published a loyalty_points tick (kind=earn, member_id, points>0) to the live feed',
    live1.status === 200 && !!earnEv && earnEv.points > 0, JSON.stringify({ found: !!earnEv, points: earnEv?.points }));
  // RLS: T2 (exec on its own tenant) never sees T1's loyalty tick on the tenant-filtered feed.
  const liveT2 = await inj('GET', '/api/bi/live/recent?limit=50', mgr2);
  ok('Real-time: T2 live feed excludes T1 loyalty_points ticks (tenant-filtered)',
    liveT2.status === 200 && !(liveT2.json.events ?? []).some((e: any) => e.type === 'loyalty_points' && e.member_id === memberId),
    JSON.stringify({ t2: (liveT2.json.events ?? []).filter((e: any) => e.type === 'loyalty_points').length }));

  // ── 7b. RFM segment distribution (Customer Segmentation / Insights) ──
  const segs = await inj('GET', '/api/loyalty/analytics/segments', mgr1);
  const segList = (segs.json.segments ?? []) as { segment: string; members: number }[];
  const canon = ['Champions', 'Loyal', 'At Risk', 'Lost', 'New'];
  const hasCanon = canon.every((c) => segList.some((s) => s.segment === c));
  const newSeg = segList.find((s) => s.segment === 'New');
  ok('Segment mix: 5 canonical segments present, New has ≥1 member, profiled ≥1',
    segs.status === 200 && hasCanon && (newSeg?.members ?? 0) >= 1 && segs.json.profiled_members >= 1,
    JSON.stringify({ profiled: segs.json.profiled_members, new: newSeg?.members }));

  // ── 7c. RLS: T2 cannot see T1's segment aggregate ──
  const segs2 = await inj('GET', '/api/loyalty/analytics/segments', mgr2);
  ok('RLS: T2 segment mix excludes T1 members (profiled=0)', segs2.status === 200 && segs2.json.profiled_members === 0, JSON.stringify({ profiled: segs2.json.profiled_members }));

  // ── 8. Personalized promos ──
  // Seed a promo + audience rule directly (no promo creation API in test scope)
  const [promo] = await db.insert(s.promotions).values({ tenantId: t1, promoId: 'NEWMEMBER10', promoName: 'ส่วนลดสมาชิกใหม่ 10%', promoType: 'percent', discountPct: '10', active: true }).returning({ id: s.promotions.id });
  const ruleRes = await inj('POST', '/api/crm/audience-rules', mgr1, { promo_id: Number(promo.id), rfm_segment: 'New' });
  ok('Audience rule created for New segment', ruleRes.status === 201 && ruleRes.json.rfm_segment === 'New', JSON.stringify(ruleRes.json));

  const promos = await inj('GET', `/api/crm/promos/${memberId}`, mgr1);
  ok('Personalized promos: segment=New, 1 promo returned (NEWMEMBER10)', promos.json.segment === 'New' && (promos.json.promos ?? []).length >= 1, JSON.stringify({ seg: promos.json.segment, n: promos.json.promos?.length }));

  // ── 9. Branch KPI dashboard ──
  const kpi = await inj('GET', '/api/crm/branch-kpi', mgr1);
  ok('Branch KPI: today.orders >= 1, revenue > 0', kpi.json.today?.orders >= 1 && kpi.json.today?.revenue > 0 && kpi.json.by_channel && Array.isArray(kpi.json.hourly_revenue), JSON.stringify({ orders: kpi.json.today?.orders, rev: kpi.json.today?.revenue }));

  // ── 10. RLS: T2 cannot see T1 member profile ──
  const t2View = await inj('GET', `/api/crm/profile/${memberId}`, mgr2);
  // T2 manager cannot see T1's member (member belongs to T1) — expect 404 or empty
  const t2Sees = t2View.json.member?.id === memberId;
  ok('RLS: T2 manager cannot see T1 member 360 profile', !t2Sees, `T2 saw T1 member: ${t2Sees}`);

  // ── 11. GL balanced (trial balance Dr=Cr) ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  ok('Trial balance balanced after CRM order (Dr==Cr)', tb.json.totals?.balanced === true, JSON.stringify(tb.json.totals ?? {}));

  // ── Results ──
  await app.close();
  let pass = 0;
  for (const c of checks) {
    const sym = c.ok ? 'PASS' : 'FAIL';
    console.log(`  [${sym}] ${c.name}${c.detail ? `  →  ${c.detail}` : ''}`);
    if (c.ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} checks passed`);
  if (pass < checks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
