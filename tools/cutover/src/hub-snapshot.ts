/**
 * Store-hub snapshot round-trip (LAN-first Phase 1, docs/41 — extends BRANCH-02/BRANCH-03):
 * a "cloud" AppModule exports the signed hub snapshot (fail-closed secret, credential gating,
 * FoH-only users, tenant isolation) → a SECOND fresh PGlite ("the hub box") imports it
 * (signature verify, tamper reject, id-stable, idempotent re-import) → a "hub" AppModule boots
 * over the imported DB and the front-of-house actually WORKS there: staff password + PIN login,
 * menu reads, floor-plan tables with their original ids/qr_tokens, local inserts past the
 * imported id range.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hub-snapshot
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hub-secret';
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
import { importHubSnapshot } from '../../../apps/api/dist/database/hub-import';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

const SECRET = 'hub-sync-secret-for-harness';

async function freshDb() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  // what db:sync-catalog does on every boot (cloud AND hub)
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  return { pg, db };
}

async function bootApp(db: any) {
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: m as any, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  return { app, inj, login };
}

async function main() {
  const pw = new PasswordService();

  // ═══ CLOUD side ═══
  const cloud = await freshDb();
  await cloud.db.insert(s.tenants).values([
    { code: 'T1', name: 'ร้านหนึ่ง', vatRegistered: true, vatRate: '0.0700', promptpayId: '0812345678' },
    { code: 'T2', name: 'ร้านสอง', vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await cloud.db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await cloud.db.insert(s.users).values([
    { username: 't1admin', passwordHash: await pw.hash('adm1'), role: 'Admin', tenantId: t1 },       // MFA-required role → never exported
    { username: 'cashier1', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: t1, pinHash: await pw.hash('4321'), pinSetAt: new Date() },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  const cApp = await bootApp(cloud.db);
  const t1admin = await cApp.login('t1admin', 'adm1');

  // seed T1 front-of-house via the real APIs (menu + modifier + buffet + floor plan)
  const cat = await cApp.inj('POST', '/api/menu/categories', t1admin, { code: 'main', name: 'จานหลัก' });
  await cApp.inj('POST', '/api/menu/items', t1admin, { sku: 'GP01', name: 'ผัดกะเพราไก่', price: 100, category_id: cat.json.id, station_code: 'hot' });
  await cApp.inj('POST', '/api/menu/items', t1admin, { sku: 'TY02', name: 'ต้มยำกุ้ง', price: 180, category_id: cat.json.id, station_code: 'hot' });
  await cApp.inj('POST', '/api/menu/modifier-groups', t1admin, { code: 'egg', name: 'ไข่', min_select: 0, max_select: 1, options: [{ name: 'ไข่ดาว', price_delta: 10 }] });
  const zone = await cApp.inj('POST', '/api/restaurant/zones', t1admin, { name: 'โซนหน้า' });
  const tbl = await cApp.inj('POST', '/api/restaurant/tables', t1admin, { table_no: 'A1', seats: 4, zone_id: zone.json?.id });
  // T2 noise — must NOT leak into T1's snapshot
  const t2tok = await cApp.login('sales2', 'pw2');
  await cApp.inj('POST', '/api/menu/items', t2tok, { sku: 'XX99', name: 'ของร้านสอง', price: 50 });

  // ── export gates ──
  delete process.env.HUB_SYNC_SECRET;
  const disabled = await cApp.inj('GET', '/api/hub/snapshot', t1admin);
  ok('Fail-closed: no HUB_SYNC_SECRET → 403 HUB_SYNC_DISABLED', disabled.status === 403 && disabled.json?.error?.code === 'HUB_SYNC_DISABLED', JSON.stringify(disabled.json?.error ?? disabled.status));
  process.env.HUB_SYNC_SECRET = SECRET;

  const cashierTok = await cApp.login('cashier1', 'pw1');
  const noPerm = await cApp.inj('GET', '/api/hub/snapshot', cashierTok);
  ok('Perm gate: Cashier (no branch/exec) → 403', noPerm.status === 403, String(noPerm.status));

  const plain = await cApp.inj('GET', '/api/hub/snapshot', t1admin);
  const pd = plain.json;
  ok('Catalog snapshot: 200 + signed + counts', plain.status === 200 && typeof pd.signature === 'string' && pd.counts?.menu_items === 2 && pd.counts?.dining_tables === 1 && pd.counts?.modifier_options === 1, JSON.stringify(pd.counts ?? plain.status));
  ok('Tenant isolation: T2 item not in T1 snapshot', (pd.data?.menu_items ?? []).every((m: any) => m.sku !== 'XX99'), '');
  const plainUsers = pd.data?.users ?? [];
  ok('FoH-only users: cashier exported, Admin (MFA role) excluded', plainUsers.length === 1 && plainUsers[0].username === 'cashier1', JSON.stringify(plainUsers.map((u: any) => u.username)));
  ok('No credentials without the sync key', plainUsers[0] && plainUsers[0].password_hash === undefined && plainUsers[0].pin_hash === undefined, '');

  const noKey = await cApp.inj('GET', '/api/hub/snapshot?include_credentials=1', t1admin);
  ok('Credential export without X-Hub-Sync-Key → 403 HUB_SYNC_KEY_REQUIRED', noKey.status === 403 && noKey.json?.error?.code === 'HUB_SYNC_KEY_REQUIRED', JSON.stringify(noKey.json?.error ?? noKey.status));

  const full = await cApp.inj('GET', '/api/hub/snapshot?include_credentials=1', t1admin, undefined, { 'x-hub-sync-key': SECRET });
  const fd = full.json;
  ok('Credentialed snapshot carries password+PIN hashes', full.status === 200 && fd.includes_credentials === true && !!fd.data.users[0].password_hash && !!fd.data.users[0].pin_hash, String(full.status));
  ok('Snapshot never carries TOTP/SSO secrets', JSON.stringify(fd.data.users).includes('totp') === false && JSON.stringify(fd.data.users).includes('sso_subject') === false, '');

  // ═══ HUB side (a second fresh box) ═══
  const hub = await freshDb();

  // tamper → reject before any write
  const tampered = JSON.parse(JSON.stringify(fd));
  tampered.data.menu_items[0].price = '1.00';
  let tamperErr = '';
  try { await importHubSnapshot(hub.db, tampered, { secret: SECRET }); } catch (e: any) { tamperErr = String(e.message); }
  ok('Tampered snapshot rejected (BAD_SIGNATURE)', tamperErr.startsWith('BAD_SIGNATURE'), tamperErr);
  ok('Tamper rejected BEFORE any write', Number((await hub.pg.query('SELECT count(*)::int n FROM menu_items')).rows.map((r: any) => r.n)[0]) === 0, '');

  const hubAdminHash = await pw.hash('hubadm-pw');
  const res1 = await importHubSnapshot(hub.db, fd, { secret: SECRET, hubAdminPasswordHash: hubAdminHash });
  ok('Import: counts (2 items, 1 table, 1 option, 1 user)', res1.imported.menu_items === 2 && res1.imported.dining_tables === 1 && res1.imported.modifier_options === 1 && res1.imported.users === 1 && res1.hub_admin === 'hubadmin', JSON.stringify(res1.imported));
  const res2 = await importHubSnapshot(hub.db, fd, { secret: SECRET, hubAdminPasswordHash: hubAdminHash });
  ok('Re-import is idempotent (upsert, no dup crash)', res2.imported.menu_items === 2, JSON.stringify(res2.imported));

  // ids preserved verbatim (printed QR / Phase-2 sync depend on this)
  const cloudTbl = (pd.data.dining_tables ?? [])[0];
  const hubTblRow = (await hub.pg.query('SELECT id, table_no, qr_token, status FROM dining_tables')).rows[0] as any;
  ok('Table id + qr_token preserved verbatim; runtime status reset', hubTblRow && Number(hubTblRow.id) === Number(cloudTbl.id) && String(hubTblRow.qr_token ?? '') === String(cloudTbl.qrToken ?? '') && hubTblRow.status === 'available', JSON.stringify(hubTblRow));

  // ── the hub actually WORKS: boot the real app over the imported DB ──
  const hApp = await bootApp(hub.db);
  const hCashier = await hApp.login('cashier1', 'pw1');
  ok('Hub: cashier password login works (synced hash)', !!hCashier, '');
  const pin = await hApp.inj('POST', '/api/login/pin', undefined, { username: 'cashier1', pin: '4321' });
  ok('Hub: cashier PIN quick-login works (ITGC-AC-17 hash synced)', pin.status === 200 || pin.status === 201, JSON.stringify(pin.json?.error ?? pin.status));
  const hAdmTok = await hApp.login('hubadmin', 'hubadm-pw');
  ok('Hub: local hubadmin can log in (no cloud credential copied)', !!hAdmTok, '');
  // reads as hubadmin (a Cashier's pos_sell doesn't carry the coarse read perms — same as on the cloud)
  const hMenu = await hApp.inj('GET', '/api/menu', hAdmTok);
  ok('Hub: /api/menu serves the imported catalog', hMenu.json?.item_count === 2, JSON.stringify(hMenu.json ?? {}).slice(0, 120));
  const hTables = await hApp.inj('GET', '/api/restaurant/tables', hAdmTok);
  ok('Hub: floor plan lists A1', (hTables.json?.tables ?? []).some((x: any) => x.table_no === 'A1'), JSON.stringify(hTables.json ?? {}).slice(0, 120));
  // sequences bumped: a hub-local insert must not collide with imported ids
  const newItem = await hApp.inj('POST', '/api/menu/items', hAdmTok, { sku: 'LOCAL1', name: 'เมนูเพิ่มบนฮับ', price: 60 });
  const maxImported = Math.max(...(fd.data.menu_items as any[]).map((m: any) => Number(m.id)));
  ok('Hub: local insert gets a fresh id past the imported range', (newItem.status === 200 || newItem.status === 201) && Number(newItem.json?.id) > maxImported, JSON.stringify({ got: newItem.json?.id, maxImported }));

  await cApp.app.close();
  await hApp.app.close();

  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} hub-snapshot checks failed` : `\n✅ All ${checks.length} hub-snapshot checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
