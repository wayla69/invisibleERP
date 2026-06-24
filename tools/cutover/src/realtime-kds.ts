/**
 * C9 — Multi-terminal realtime: a KDS item transition fans out an SSE event (type kds_item) on the shared
 * realtime bus, tenant-scoped, so other terminals refresh at once. Verified via the buffered
 * /api/pos/scale/events/recent feed (same source the SSE stream pushes). Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover realtime-kds
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rt-secret';
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'cook1', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },
    { username: 'cook2', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const cook1 = await login('cook1'), cook2 = await login('cook2');

  // T1 creates a dine-in order with one item → fire to KDS → it's queued
  await inj('POST', '/api/restaurant/orders', cook1, { items: [{ name: 'ผัดไทย', unit_price: 100, qty: 1, station_code: 'main' }] });
  const orders = (await inj('GET', '/api/restaurant/orders', cook1)).json;
  const orderNo = (orders.orders ?? orders)[0]?.order_no ?? (orders.orders ?? orders)[0]?.orderNo;
  await inj('POST', `/api/restaurant/orders/${orderNo}/fire`, cook1);
  const feed = (await inj('GET', '/api/restaurant/kds/feed', cook1)).json;
  const itemId = feed.stations?.[0]?.items?.[0]?.item_id;
  ok('setup: order fired to KDS, item present', !!orderNo && !!itemId, JSON.stringify({ orderNo, itemId }));

  // ── 1. transition the item (start) → a kds_item realtime event is buffered for T1 ──
  await inj('PATCH', `/api/restaurant/kds/items/${itemId}`, cook1, { action: 'start' });
  const recent1 = (await inj('GET', '/api/pos/scale/events/recent', cook1)).json;
  const ev = (recent1.events ?? []).find((e: any) => e.type === 'kds_item' && e.item_id === itemId);
  ok('KDS start → kds_item event published (item_id + kds_status preparing)',
    !!ev && ev.kds_status === 'preparing' && Number(ev.order_id) > 0,
    JSON.stringify(ev ? { type: ev.type, kds: ev.kds_status } : null));

  // ── 2. a second transition (ready) pushes another event ──
  await inj('PATCH', `/api/restaurant/kds/items/${itemId}`, cook1, { action: 'ready' });
  const recent2 = (await inj('GET', '/api/pos/scale/events/recent', cook1)).json;
  const readyEv = (recent2.events ?? []).filter((e: any) => e.type === 'kds_item' && e.item_id === itemId).find((e: any) => e.kds_status === 'ready');
  ok('KDS ready → second kds_item event (status ready)', !!readyEv, JSON.stringify({ count: (recent2.events ?? []).filter((e: any) => e.type === 'kds_item').length }));

  // ── 3. tenant isolation: T2 never sees T1's kds_item events on its recent feed ──
  const recentT2 = (await inj('GET', '/api/pos/scale/events/recent', cook2)).json;
  ok('tenant isolation: T2 does not receive T1 kds_item events', !(recentT2.events ?? []).some((e: any) => e.type === 'kds_item' && e.item_id === itemId), `t2events=${(recentT2.events ?? []).length}`);

  console.log('\n── C9 — Realtime KDS multi-terminal sync (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} realtime checks failed` : `\n✅ All ${checks.length} realtime checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
