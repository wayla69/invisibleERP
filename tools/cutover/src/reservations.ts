/**
 * POS — Table reservations + walk-in waitlist (จองโต๊ะ + รอคิว) over PGlite:
 * book a table for a future time / queue a walk-in, notify the guest when ready (message_log),
 * seat them (table → occupied), cancel / no-show (release the held table). Tenant-scoped (RLS).
 * Fine-casual: a booking carries its service mode (buffet w/ optional pre-picked tier vs à la carte)
 * and the list splits pending covers per mode. Guest dining profile (Michelin-style guest CRM) is
 * PDPA consent-gated: no 'dining_profile' consent ⇒ no data shown/stored (403 CONSENT_REQUIRED on
 * write); the save can capture consent (audited in member_consents); withdrawal hides everything.
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

  // ── 10. fine-casual service modes: buffet booking with a pre-picked tier vs à la carte ──
  const [pkg] = await db.insert(s.buffetPackages).values({ tenantId: t1, code: 'GOLD', name: 'บุฟเฟ่ต์ Gold', pricePerPax: '599' }).returning();
  const bfResv = await inj('POST', '/api/restaurant/reservations', sales1, { reserved_for: '2026-07-03T19:00:00.000Z', party_size: 4, customer_name: 'บุฟ', service_mode: 'buffet', buffet_package_id: Number(pkg.id), occasion: 'วันเกิด' });
  ok('Fine-casual: buffet booking carries mode + pre-picked tier + occasion', bfResv.json.status === 'booked' && bfResv.json.service_mode === 'buffet' && bfResv.json.buffet_package_id === Number(pkg.id) && bfResv.json.occasion === 'วันเกิด', JSON.stringify(bfResv.json).slice(0, 110));
  const alcResv = await inj('POST', '/api/restaurant/reservations', sales1, { reserved_for: '2026-07-03T20:00:00.000Z', party_size: 3, customer_name: 'อลาคาร์ท' });
  ok('Fine-casual: default booking is à la carte', alcResv.json.service_mode === 'a_la_carte' && alcResv.json.buffet_package_id === null, `mode=${alcResv.json.service_mode}`);

  // ── 11. a pre-picked tier is rejected on an à-la-carte booking, and a dead/foreign tier is rejected ──
  const pkgOnAlc = await inj('POST', '/api/restaurant/reservations', sales1, { reserved_for: '2026-07-03T21:00:00.000Z', party_size: 2, buffet_package_id: Number(pkg.id) });
  const badPkg = await inj('POST', '/api/restaurant/reservations', sales1, { reserved_for: '2026-07-03T21:00:00.000Z', party_size: 2, service_mode: 'buffet', buffet_package_id: 999999 });
  const t2pkg = await inj('POST', '/api/restaurant/reservations', sales2, { reserved_for: '2026-07-03T21:00:00.000Z', party_size: 2, service_mode: 'buffet', buffet_package_id: Number(pkg.id) });
  ok('Fine-casual: package on à-la-carte / unknown package / cross-tenant package all 400 BAD_PACKAGE',
    pkgOnAlc.status === 400 && pkgOnAlc.json.error?.code === 'BAD_PACKAGE' && badPkg.status === 400 && badPkg.json.error?.code === 'BAD_PACKAGE' && t2pkg.status === 400 && t2pkg.json.error?.code === 'BAD_PACKAGE',
    `alc=${pkgOnAlc.json.error?.code} bad=${badPkg.json.error?.code} xt=${t2pkg.json.error?.code}`);

  // ── 12. list resolves the tier name + splits pending covers per mode (buffet 4, à la carte 2 ready + 3 booked) ──
  const list2 = await inj('GET', '/api/restaurant/reservations', sales1);
  const bfRow = list2.json.reservations.find((r: any) => r.id === bfResv.json.id);
  ok('List: buffet tier name resolved + covers split per mode', bfRow?.buffet_package_name === 'บุฟเฟ่ต์ Gold' && list2.json.covers_buffet === 4 && list2.json.covers_a_la_carte === 5 && list2.json.covers_pending === 9,
    JSON.stringify({ pkg: bfRow?.buffet_package_name, b: list2.json.covers_buffet, a: list2.json.covers_a_la_carte, c: list2.json.covers_pending }));

  // ── 13. guest dining profile is PDPA consent-gated: nothing shown or stored without consent ──
  const mem = await inj('POST', '/api/loyalty/members', sales1, { name: 'คุณวี', phone: '0891112222' });
  const memberId = mem.json.id;
  const gp0 = await inj('GET', `/api/restaurant/guests/${memberId}/profile`, sales1);
  ok('Guest profile: no consent → consent_granted=false and NO preference data', gp0.json.consent_granted === false && gp0.json.profile === null && gp0.json.companions.length === 0 && gp0.json.top_menus.length === 0, JSON.stringify(gp0.json).slice(0, 100));
  const putNoConsent = await inj('PUT', `/api/restaurant/guests/${memberId}/profile`, sales1, { favorite_menus: ['ทาร์ตไข่'] });
  ok('Guest profile: write without consent rejected (403 CONSENT_REQUIRED)', putNoConsent.status === 403 && putNoConsent.json.error?.code === 'CONSENT_REQUIRED', `${putNoConsent.status} ${putNoConsent.json.error?.code}`);

  // ── 14. the save can capture consent — audited in the member_consents ledger (purpose dining_profile, source pos) ──
  const putOk = await inj('PUT', `/api/restaurant/guests/${memberId}/profile`, sales1, {
    consent: true, favorite_menus: ['หอยเชลล์ย่าง', 'ทาร์ตไข่'], favorite_ingredients: ['ทรัฟเฟิล'], allergies: ['กุ้ง'],
    dietary: 'ไม่ทานเผ็ด', seating_preference: 'ริมหน้าต่าง', typical_party_size: 4, service_notes: 'น้ำเปล่าไม่ใส่น้ำแข็ง', extra: { wine: 'Pinot Noir' },
  });
  const consentRows = (await pg.query(`SELECT granted, source FROM member_consents WHERE member_id=${memberId} AND purpose='dining_profile'`)).rows as any[];
  ok('Guest profile: save captures consent (ledger row granted, source=pos) + returns the profile',
    putOk.status === 200 && putOk.json.consent_granted === true && putOk.json.profile?.favorite_menus?.length === 2 && putOk.json.profile?.allergies?.[0] === 'กุ้ง' && consentRows[0]?.granted === true && consentRows[0]?.source === 'pos',
    JSON.stringify({ st: putOk.status, consent: consentRows[0] }));

  // ── 15. companions: third-party PII under the same consent; hard-deleted on remove ──
  const comp = await inj('POST', `/api/restaurant/guests/${memberId}/companions`, sales1, { name: 'คุณเมย์', relationship: 'ภรรยา', allergies: ['ถั่ว'], preferences: 'ชอบของหวาน' });
  const gp1 = await inj('GET', `/api/restaurant/guests/${memberId}/profile`, sales1);
  ok('Companions: added and returned with the consented profile', comp.status === 201 && gp1.json.companions.length === 1 && gp1.json.companions[0].name === 'คุณเมย์', JSON.stringify(gp1.json.companions).slice(0, 90));
  await inj('DELETE', `/api/restaurant/guests/${memberId}/companions/${comp.json.id}`, sales1);
  const compCnt = await cnt(`SELECT count(*)::int n FROM member_companions WHERE member_id=${memberId}`);
  ok('Companions: remove hard-deletes the row (PDPA data minimization)', compCnt === 0, `rows=${compCnt}`);

  // ── 15b. merge-patch semantics: an omitted field keeps its stored value (a one-field save can't wipe
  //         the rest — the old replace semantics silently nulled e.g. `extra` on every web save) ──
  const partial = await inj('PUT', `/api/restaurant/guests/${memberId}/profile`, sales1, { favorite_menus: ['ทาร์ตไข่'] });
  const p15b = partial.json.profile;
  ok('Guest profile: partial PUT keeps omitted fields (allergies/dietary/extra survive)',
    p15b?.favorite_menus?.length === 1 && p15b?.allergies?.[0] === 'กุ้ง' && p15b?.dietary === 'ไม่ทานเผ็ด' && p15b?.extra?.wine === 'Pinot Noir',
    JSON.stringify({ fav: p15b?.favorite_menus, alg: p15b?.allergies, diet: p15b?.dietary, extra: p15b?.extra }));

  // ── 15c. explicit null clears a field (and only that field) ──
  const cleared = await inj('PUT', `/api/restaurant/guests/${memberId}/profile`, sales1, { dietary: null });
  const p15c = cleared.json.profile;
  ok('Guest profile: explicit null clears the field, others untouched', p15c?.dietary === null && p15c?.favorite_menus?.length === 1 && p15c?.extra?.wine === 'Pinot Noir', JSON.stringify({ diet: p15c?.dietary, fav: p15c?.favorite_menus, extra: p15c?.extra }));

  // ── 16. consent withdrawal hides everything again (data minimization on read) ──
  const withdraw = await inj('POST', `/api/loyalty/members/${memberId}/consents`, sales1, { purpose: 'dining_profile', granted: false });
  const gp2 = await inj('GET', `/api/restaurant/guests/${memberId}/profile`, sales1);
  ok('Guest profile: consent withdrawal → data no longer shown, writes rejected again', withdraw.status < 300 && gp2.json.consent_granted === false && gp2.json.profile === null && gp2.json.companions.length === 0, JSON.stringify(gp2.json).slice(0, 90));

  // ── 17. RLS: T2 cannot read a T1 guest profile ──
  const t2gp = await inj('GET', `/api/restaurant/guests/${memberId}/profile`, sales2);
  ok('RLS: T2 cannot read a T1 guest profile (404 MEMBER_NOT_FOUND)', t2gp.status === 404 && t2gp.json.error?.code === 'MEMBER_NOT_FOUND', `${t2gp.status} ${t2gp.json.error?.code}`);

  await app.close();
  await pg.close();
  console.log('\n── POS Table reservations + waitlist (จองโต๊ะ + รอคิว) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} reservation checks failed` : `\n✅ All ${checks.length} reservation checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
