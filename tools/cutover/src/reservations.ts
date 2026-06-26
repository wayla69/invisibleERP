/**
 * POS — Table reservations + walk-in waitlist (จองโต๊ะ + รอคิว) over PGlite:
 * book a table for a future time / queue a walk-in, notify the guest when ready (message_log),
 * seat them (table → occupied), cancel / no-show (release the held table). Tenant-scoped (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover reservations
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'resv-secret';
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
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const sales1 = await login('sales1', 'pw1');
  const sales2 = await login('sales2', 'pw2');
  const cnt = async (sql: string) => Number(((await pg.query(sql)).rows as any[])[0].n);

  // a table to assign
  const tbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'R1', seats: 4 });
  const tableId = tbl.json.id;

  // ── 1. create a reservation (future booking) → booked + holds the table as 'reserved' ──
  const resv = await inj('POST', '/api/restaurant/reservations', sales1, { table_id: tableId, reserved_for: '2026-07-01T19:00:00.000Z', party_size: 4, customer_name: 'สมชาย', customer_phone: '0810000001' });
  ok('Reservation: created → booked, table held reserved', resv.json.status === 'booked' && resv.json.kind === 'reservation', JSON.stringify(resv.json).slice(0, 90));
  const tStatus1 = (await pg.query(`SELECT status FROM dining_tables WHERE id=${tableId}`)).rows as any[];
  ok('Reservation: pre-assigned table held as reserved', tStatus1[0]?.status === 'reserved', `table=${tStatus1[0]?.status}`);

  // ── 2. reservation requires a time ──
  const noTime = await inj('POST', '/api/restaurant/reservations', sales1, { party_size: 2 });
  ok('Reservation: missing reserved_for rejected (400)', noTime.status === 400, `${noTime.status} ${noTime.json.error?.code}`);

  // ── 3. walk-in waitlist (no time) → waiting ──
  const wl = await inj('POST', '/api/restaurant/reservations', sales1, { kind: 'waitlist', party_size: 2, customer_name: 'อร', customer_phone: '0810000002', quoted_wait_min: 20 });
  ok('Waitlist: walk-in created → waiting, no table held', wl.json.status === 'waiting' && wl.json.kind === 'waitlist' && wl.json.table_id === null, JSON.stringify(wl.json).slice(0, 90));

  // ── 4. notify the waitlist guest → ready + a message_log row written ──
  const notify = await inj('POST', `/api/restaurant/reservations/${wl.json.id}/notify`, sales1);
  const msgRows = await cnt(`SELECT count(*)::int n FROM message_log WHERE campaign='reservation_ready' AND tenant_id=${t1}`);
  ok('Waitlist: notify → ready + message_log row (SMS)', notify.json.status === 'ready' && msgRows === 1, `st=${notify.json.status} msgs=${msgRows} ch=${notify.json.channel}`);

  // ── 5. list: counts waiting/booked + pending covers ──
  const list = await inj('GET', '/api/restaurant/reservations', sales1);
  ok('List: booked 1, covers_pending = 4 (booked) + 2 (ready) = 6', list.json.booked === 1 && list.json.covers_pending === 6, JSON.stringify({ b: list.json.booked, w: list.json.waiting, c: list.json.covers_pending }));

  // ── 6. seat the reservation → seated + table occupied ──
  const seat = await inj('POST', `/api/restaurant/reservations/${resv.json.id}/seat`, sales1);
  const tStatus2 = (await pg.query(`SELECT status FROM dining_tables WHERE id=${tableId}`)).rows as any[];
  ok('Reservation: seat → seated + table occupied', seat.json.status === 'seated' && tStatus2[0]?.status === 'occupied', `st=${seat.json.status} table=${tStatus2[0]?.status}`);

  // ── 7. cannot seat/notify a seated entry ──
  const reseat = await inj('POST', `/api/restaurant/reservations/${resv.json.id}/seat`, sales1);
  ok('Reservation: re-seat rejected (400 BAD_STATUS)', reseat.status === 400 && reseat.json.error?.code === 'BAD_STATUS', `${reseat.status} ${reseat.json.error?.code}`);

  // ── 8. cancel a booking releases its held table ──
  const tbl2 = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'R2', seats: 2 });
  const resv2 = await inj('POST', '/api/restaurant/reservations', sales1, { table_id: tbl2.json.id, reserved_for: '2026-07-02T19:00:00.000Z', party_size: 2 });
  const cancel = await inj('POST', `/api/restaurant/reservations/${resv2.json.id}/cancel`, sales1);
  const tStatus3 = (await pg.query(`SELECT status FROM dining_tables WHERE id=${tbl2.json.id}`)).rows as any[];
  ok('Reservation: cancel releases the held table (reserved → available)', cancel.json.status === 'cancelled' && tStatus3[0]?.status === 'available', `st=${cancel.json.status} table=${tStatus3[0]?.status}`);

  // ── 9. RLS: T2 cannot see / act on T1's reservations ──
  const t2list = await inj('GET', '/api/restaurant/reservations', sales2);
  const t2seat = await inj('POST', `/api/restaurant/reservations/${wl.json.id}/seat`, sales2);
  ok('RLS: T2 sees none of T1 reservations + cannot seat T1 (404)', t2list.json.count === 0 && t2seat.status === 404, `t2count=${t2list.json.count} seat=${t2seat.status}`);

  await app.close();
  await pg.close();
  console.log('\n── POS Table reservations + waitlist (จองโต๊ะ + รอคิว) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} reservation checks failed` : `\n✅ All ${checks.length} reservation checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
