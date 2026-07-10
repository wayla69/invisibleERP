/**
 * Store-hub round-trip (LAN-first, docs/41 — BRANCH-02 extension + BRANCH-04):
 * Phase 1 — a "cloud" AppModule exports the signed hub snapshot (fail-closed secret, credential
 * gating, FoH-only users, tenant isolation) → a SECOND fresh PGlite ("the hub box") imports it
 * (signature verify, tamper reject, id-stable, idempotent re-import) → a "hub" AppModule boots
 * over the imported DB and the front-of-house actually WORKS there: staff password + PIN login,
 * menu reads, floor-plan tables with their original ids/qr_tokens, local inserts past the
 * imported id range.
 * Phase 2a (BRANCH-04) — sales rung ON the hub replay to the cloud: pushHubSales → HMAC-signed
 * batch → POST /api/hub/ingest → cloud sale + GL (TB balanced); log-loss re-push is all-duplicate
 * (deterministic client_uuid = exactly-once); tampered batch 403s; an unsupported sale surfaces
 * as skipped_unsupported with its reason; GET /api/hub/reconciliation ties values.
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
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { importHubSnapshot } from '../../../apps/api/dist/database/hub-import';
import { pushHubSales, pushHubTills, sendHubHeartbeat, signHubBatch } from '../../../apps/api/dist/database/hub-push';
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
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } })); // diner session tokens exceed the 100-char default
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts(); // checkout posts GL on both cloud and hub
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
  await cApp.inj('POST', '/api/restaurant/buffet/packages', t1admin, { code: 'BUF1', name: 'บุฟเฟต์มาตรฐาน', price_per_pax: 299, time_limit_min: 90, overtime_fee_per_pax: 50, item_skus: ['GP01'] });
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

  // ═══ Phase 2a — hub → cloud sales replay (BRANCH-04) ═══
  // ring two sales ON THE HUB via the real order→checkout path (GL posts on the hub's own ledger)
  const ring = async (items: any[], checkout: any) => {
    const o = await hApp.inj('POST', '/api/restaurant/orders', hAdmTok, { items });
    const sale = await hApp.inj('POST', `/api/restaurant/orders/${o.json.order_no}/checkout`, hAdmTok, { method: 'Cash', ...checkout });
    return sale.json;
  };
  const hs1 = await ring([{ sku: 'GP01', qty: 1 }], {});                                  // 100 + VAT
  const hs2 = await ring([{ sku: 'TY02', qty: 2 }], { discount_pct: 10, tip: 20 });        // discount + tip pass-through
  ok('Hub: two sales rung on the hub ledger', !!hs1.sale_no && !!hs2.sale_no && Number(hs2.total_with_tip ?? hs2.total) > 0, JSON.stringify({ hs1: hs1.sale_no, hs2: hs2.sale_no }));
  // an unsupported shape: a hub sale with no order linkage (portal/split path) must be SKIPPED VISIBLY
  await hub.db.insert(s.custPosSales).values({ saleNo: 'SALE-HUB-MANUAL', tenantId: t1, subtotal: '50', total: '53.5', taxAmount: '3.5', status: 'Completed' as any });

  // the pusher signs with the shared secret and delivers to the CLOUD's public HMAC ingest endpoint
  const send = async (batch: any) => {
    const res = await cApp.inj('POST', '/api/hub/ingest', undefined, batch);
    if (res.status !== 200 && res.status !== 201) throw new Error(res.json?.error?.code ?? String(res.status));
    return res.json;
  };
  const push1 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  ok('Push: 2 pushed, unsupported sale skipped (visible), none failed', push1.pushed === 2 && push1.skipped === 1 && push1.failed === 0, JSON.stringify(push1));

  const logRows = (await hub.pg.query(`SELECT hub_sale_no, status, cloud_sale_no, skip_reason FROM hub_push_log ORDER BY id`)).rows as any[];
  ok('hub_push_log: pushed rows map hub→cloud sale_no; skip carries its reason', logRows.filter((r) => r.status === 'pushed' && /^SALE-/.test(r.cloud_sale_no ?? '')).length === 2 && logRows.some((r) => r.status === 'skipped_unsupported' && /NO_ORDER_LINK/.test(r.skip_reason ?? '')), JSON.stringify(logRows));

  // cloud side: sales exist with hub-matching value, GL balanced, reconciliation ties out
  const recon = await cApp.inj('GET', '/api/hub/reconciliation', t1admin);
  // tie on sale `total` (revenue + VAT + SC) — tip is a 2300 liability outside the sale total on both sides
  const hubTotal = Number(hs1.total) + Number(hs2.total);
  ok('Cloud reconciliation: 2 synced ops, value ties to the hub-side totals', recon.json?.summary?.synced === 2 && Math.abs(Number(recon.json?.summary?.cloud_total) - hubTotal) < 0.02, JSON.stringify({ status: recon.status, summary: recon.json?.summary, hubTotal }));
  const tb1 = await cApp.inj('GET', '/api/ledger/trial-balance', t1admin);
  ok('Cloud trial balance balanced after ingest', tb1.json?.totals?.balanced === true, JSON.stringify(tb1.json?.totals ?? {}));

  // exactly-once: a full re-push (deterministic client_uuid) yields only duplicates — no new sales, no new GL
  const cloudSales1 = Number((await cApp.inj('GET', '/api/hub/reconciliation', t1admin)).json?.summary?.ops);
  await hub.pg.query(`DELETE FROM hub_push_log WHERE status IN ('pushed','duplicate')`); // simulate a lost log / crash-replay
  const push2 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  const recon2 = await cApp.inj('GET', '/api/hub/reconciliation', t1admin);
  ok('Re-push after log loss: all duplicate, zero new cloud ops (exactly-once)', push2.duplicate === 2 && push2.pushed === 0 && Number(recon2.json?.summary?.ops) === cloudSales1, JSON.stringify({ push2, ops: recon2.json?.summary?.ops }));

  // authenticity: a tampered batch (bad signature) is rejected before any replay
  const badBatch = { tenant_id: t1, sent_at: new Date().toISOString(), sales: [{ client_uuid: 'hub:evil', captured_at: new Date().toISOString(), lines: [{ sku: 'GP01', qty: 1 }] }], signature: signHubBatch(t1, 'other', [], SECRET) };
  const badRes = await cApp.inj('POST', '/api/hub/ingest', undefined, badBatch);
  ok('Ingest rejects a bad signature (403 HUB_SYNC_BAD_SIGNATURE)', badRes.status === 403 && badRes.json?.error?.code === 'HUB_SYNC_BAD_SIGNATURE', JSON.stringify(badRes.json?.error ?? badRes.status));

  // ═══ Phase 3 — diner QR self-order ON THE HUB (no login, no internet) ═══
  const a1qr = (await hub.pg.query(`SELECT qr_token FROM dining_tables WHERE table_no='A1'`)).rows[0] as any;
  ok('Hub: imported table kept its printed QR token', !!a1qr?.qr_token, JSON.stringify(a1qr));
  const dstart = await hApp.inj('POST', `/api/qr/start/${a1qr.qr_token}`);
  const dtok = dstart.json?.public_token;
  ok('Hub diner: scanning the table QR opens a session (public)', (dstart.status === 200 || dstart.status === 201) && !!dtok, JSON.stringify(dstart.json ?? dstart.status).slice(0, 120));
  const dmenu = await hApp.inj('GET', `/api/qr/t/${dtok}/menu`);
  ok('Hub diner: menu served to the phone', (dmenu.json?.item_count ?? 0) >= 2, JSON.stringify(dmenu.json?.item_count));
  const dorder = await hApp.inj('POST', `/api/qr/t/${dtok}/order`, undefined, { items: [{ sku: 'TY02', qty: 1 }] });
  ok('Hub diner: self-order accepted', dorder.status === 200 || dorder.status === 201, JSON.stringify(dorder.json ?? dorder.status).slice(0, 120));
  const dstat = await hApp.inj('GET', `/api/qr/t/${dtok}`);
  const dOrderNo = dstat.json?.order?.order_no;
  ok('Hub diner: order visible on the table session (KDS-bound)', !!dOrderNo, JSON.stringify(dstat.json ?? {}).slice(0, 120));
  const dsale = await hApp.inj('POST', `/api/restaurant/orders/${dOrderNo}/checkout`, hAdmTok, { method: 'Cash' });
  ok('Hub diner: staff settles the diner order on the hub', !!dsale.json?.sale_no, JSON.stringify(dsale.json?.sale_no ?? dsale.json?.error));

  // ═══ Phase 2b — buffet session on the hub replays to the cloud (priced from the CLOUD master) ═══
  await hApp.inj('POST', '/api/restaurant/tables', hAdmTok, { table_no: 'B1', seats: 6 });
  const b1qr = (await hub.pg.query(`SELECT qr_token FROM dining_tables WHERE table_no='B1'`)).rows[0] as any;
  const bstart = await hApp.inj('POST', `/api/qr/start/${b1qr.qr_token}`);
  const btok = bstart.json?.public_token;
  const btiers = await hApp.inj('GET', `/api/qr/t/${btok}/buffet/tiers`);
  ok('Hub diner: imported buffet tier offered', JSON.stringify(btiers.json ?? {}).includes('BUF1'), JSON.stringify(btiers.json ?? {}).slice(0, 120));
  const bufPkgId = Number((fd.data.buffet_packages as any[])[0]?.id);
  const bgo = await hApp.inj('POST', `/api/qr/t/${btok}/buffet/start`, undefined, { package_id: bufPkgId, pax: 2 });
  ok('Hub diner: buffet tier started for 2 pax', bgo.status === 200 || bgo.status === 201, JSON.stringify(bgo.json ?? bgo.status).slice(0, 120));
  await hApp.inj('POST', `/api/qr/t/${btok}/order`, undefined, { items: [{ sku: 'GP01', qty: 3 }] }); // ฿0 buffet food
  const bstat = await hApp.inj('GET', `/api/qr/t/${btok}`);
  const bOrderNo = bstat.json?.order?.order_no;
  const bsale = await hApp.inj('POST', `/api/restaurant/orders/${bOrderNo}/checkout`, hAdmTok, { method: 'Cash' });
  const bufExpected = Math.round(2 * 299 * 1.07 * 100) / 100; // 2 pax × 299 + VAT7% (food bills ฿0)
  ok('Hub: buffet sale bills per-pax charge only (2×299 + VAT)', Math.abs(Number(bsale.json?.total) - bufExpected) < 0.02, JSON.stringify({ got: bsale.json?.total, bufExpected }));

  // push the two new hub sales (diner a-la-carte + buffet) to the cloud
  const push3 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  ok('Push: diner + buffet sales replay (no skips, no failures)', push3.pushed === 2 && push3.failed === 0 && push3.skipped === 0, JSON.stringify(push3));
  const recon3 = await cApp.inj('GET', '/api/hub/reconciliation', t1admin);
  const bufRow = (recon3.json?.rows ?? []).find((r: any) => r.hub_sale_no === bsale.json?.sale_no);
  ok('Cloud: buffet replay re-priced from the CLOUD package master, value ties', bufRow && Math.abs(Number(bufRow.cloud_total) - bufExpected) < 0.02, JSON.stringify(bufRow ?? recon3.json?.summary));
  const tb2 = await cApp.inj('GET', '/api/ledger/trial-balance', t1admin);
  ok('Cloud trial balance still balanced after buffet ingest', tb2.json?.totals?.balanced === true, JSON.stringify(tb2.json?.totals ?? {}));
  const push4 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  ok('Re-run push: nothing re-collected (push_log excludes terminal rows), nothing fails', push4.collected === 0 && push4.pushed === 0 && push4.failed === 0, JSON.stringify(push4));

  // ═══ Phase 2c — till / Z-report up-sync (BRANCH-05) ═══
  const sendTill = async (body: any) => {
    const res = await cApp.inj('POST', '/api/hub/ingest-till', undefined, body);
    if (res.status !== 200 && res.status !== 201) { const e: any = new Error(res.json?.error?.code ?? String(res.status)); e.code = res.json?.error?.code; e.missing = res.json?.error?.missing; throw e; }
    return res.json;
  };
  // a hub till session that COVERS the already-replayed sales, counted short by exactly ฿40
  // a CARD sale inside the same session — its money never enters the drawer, so it must be EXCLUDED
  const cardSale = await ring([{ sku: 'GP01', qty: 1 }], { method: 'Card' });
  const pushCard = await pushHubSales(hub.db, t1, { secret: SECRET, send }); // replay it before the till closes
  ok('Hub: a card sale is rung in the same session and replays', !!cardSale.sale_no && pushCard.pushed === 1, JSON.stringify({ sale: cardSale.sale_no, pushCard }));
  // drawer takings = Σ(cash tender amount + tip) — the TENDER says what entered the drawer, not the sale
  const hubCash = (await hub.pg.query(`SELECT amount, tip FROM payments WHERE method='Cash' AND status IN ('Captured','Refunded')`)).rows as any[];
  const cashTotal = Math.round(hubCash.reduce((s, r) => s + Number(r.amount) + Number(r.tip ?? 0), 0) * 100) / 100;
  const OPEN_FLOAT = 1000;
  await hub.pg.query(`INSERT INTO till_sessions (session_no, tenant_id, opened_by, opened_at, opening_float, closed_by, closed_at, closing_count, status)
    VALUES ('TILL-HUB-1', ${t1}, 'cashier1', now() - interval '3 hours', ${OPEN_FLOAT}, 'cashier1', now(), ${OPEN_FLOAT + cashTotal - 40}, 'Closed')`);
  // an UNSUPPORTED sale still un-replayed → the till must be BLOCKED, never certified on a partial population
  await hub.pg.query(`INSERT INTO dine_in_orders (order_no, tenant_id, status, sale_no, opened_at, paid_at) VALUES ('DIN-BLOCK', ${t1}, 'paid', 'SALE-HUB-MANUAL', now() - interval '1 hour', now() - interval '1 hour')`);
  const blocked = await pushHubTills(hub.db, t1, { secret: SECRET, sendTill });
  ok('Till blocked while a covered sale has not replayed (TILL_SALES_NOT_SYNCED)', blocked.blocked === 1 && blocked.pushed === 0, JSON.stringify(blocked));
  const blockedLog = (await hub.pg.query(`SELECT status, error_code FROM hub_push_log WHERE hub_sale_no='TILL-HUB-1'`)).rows[0] as any;
  ok('Blocked till is logged with its reason (visible, retryable)', blockedLog?.error_code?.includes('TILL_SALES_NOT_SYNCED'), JSON.stringify(blockedLog));

  // resolve it (the manual sale is out of scope for the session) → the till certifies
  await hub.pg.query(`DELETE FROM dine_in_orders WHERE order_no='DIN-BLOCK'`);
  const tillPush = await pushHubTills(hub.db, t1, { secret: SECRET, sendTill });
  ok('Till pushed once its sales are all on the cloud', tillPush.pushed === 1 && tillPush.blocked === 0 && tillPush.failed === 0, JSON.stringify(tillPush));

  const cloudTill = (await cloud.pg.query(`SELECT expected_cash, closing_count, variance, variance_status, variance_journal_no FROM till_sessions WHERE session_no='TILL-HUB-1'`)).rows[0] as any;
  ok('Cloud recomputed expected cash from ITS OWN cash TENDERS (float + cash + tips)', Math.abs(Number(cloudTill?.expected_cash) - (OPEN_FLOAT + cashTotal)) < 0.02, JSON.stringify({ got: cloudTill?.expected_cash, want: OPEN_FLOAT + cashTotal }));
  const cardTotal = Number((await cloud.pg.query(`SELECT coalesce(sum(amount),0) v FROM payments WHERE method='Card'`)).rows[0]?.v ?? 0);
  ok('Card sale in the session does NOT inflate the drawer expectation', cardTotal > 0 && Number(cloudTill?.expected_cash) < OPEN_FLOAT + cashTotal + cardTotal - 0.01, JSON.stringify({ expected: cloudTill?.expected_cash, cardTotal }));
  ok('Immaterial short (฿40 < ฿100) posts 5830 immediately, no approval needed', Math.abs(Number(cloudTill?.variance) + 40) < 0.02 && cloudTill?.variance_status === 'NotRequired' && /^JE-/.test(cloudTill?.variance_journal_no ?? ''), JSON.stringify(cloudTill));
  const os = (await cloud.pg.query(`SELECT sum(debit)::numeric d FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='5830' AND je.status='Posted'`)).rows[0] as any;
  ok('Cash Over/Short 5830 debited by the short amount', Math.abs(Number(os?.d ?? 0) - 40) < 0.02, JSON.stringify(os));
  const tbTill = await cApp.inj('GET', '/api/ledger/trial-balance', t1admin);
  ok('Cloud trial balance balanced after till ingest', tbTill.json?.totals?.balanced === true, JSON.stringify(tbTill.json?.totals ?? {}));

  const tillDup = await pushHubTills(hub.db, t1, { secret: SECRET, sendTill });
  ok('Till re-push is idempotent (nothing re-collected)', tillDup.collected === 0, JSON.stringify(tillDup));
  // and a forced re-send of the same session returns duplicate (no second JE)
  const again = await sendTill({ tenant_id: t1, sent_at: new Date().toISOString(), till: { session_no: 'TILL-HUB-1', opened_at: new Date().toISOString(), closed_at: new Date().toISOString(), opening_float: 0, closing_count: 0, sale_nos: [] }, signature: 'deadbeef' }).catch((e: any) => ({ err: e.code }));
  ok('Forced re-send with a bad signature is rejected (not silently duplicated)', (again as any).err === 'HUB_SYNC_BAD_SIGNATURE', JSON.stringify(again));

  // ═══ Phase 4a — hub heartbeat + fleet view ═══
  const sendHeartbeat = async (body: any) => {
    const res = await cApp.inj('POST', '/api/hub/heartbeat', undefined, body);
    if (res.status !== 200 && res.status !== 201) throw new Error(res.json?.error?.code ?? String(res.status));
    return res.json;
  };
  const hb = await sendHubHeartbeat(hub.db, t1, { secret: SECRET, hubId: 'store-1', appVersion: 'test', sendHeartbeat });
  ok('Heartbeat reports the real backlog (1 skipped sale, 0 pending)', hb.skipped_docs === 1 && hb.pending_sales === 0 && hb.pending_tills === 0, JSON.stringify(hb));
  const fleet = await cApp.inj('GET', '/api/hub/fleet', t1admin);
  const h0 = fleet.json?.hubs?.[0];
  ok('Fleet view lists the hub, fresh, flagged for attention (skipped docs)', h0?.hub_id === 'store-1' && h0.stale === false && h0.needs_attention === true && fleet.json?.summary?.hubs === 1, JSON.stringify(fleet.json?.summary ?? fleet.status));
  const hbBad = await cApp.inj('POST', '/api/hub/heartbeat', undefined, { tenant_id: t1, sent_at: new Date().toISOString(), hub: { hub_id: 'evil' }, signature: 'deadbeef' });
  ok('Heartbeat rejects a bad signature', hbBad.status === 403, String(hbBad.status));
  const fleetT2 = await cApp.inj('GET', '/api/hub/fleet', await cApp.login('sales2', 'pw2'));
  ok('Fleet is tenant-isolated (T2 sees no T1 hub)', (fleetT2.json?.hubs ?? []).length === 0, JSON.stringify(fleetT2.json?.summary ?? fleetT2.status));

  // ═══ Phase 4c — the heartbeat is the version channel ═══
  process.env.APP_VERSION = '2.5.0';
  const hbBehind = await sendHubHeartbeat(hub.db, t1, { secret: SECRET, hubId: 'store-1', appVersion: '2.4.9', sendHeartbeat });
  ok('Version: a hub BEHIND the cloud is told an upgrade is available', hbBehind.advice?.version_status === 'behind' && hbBehind.advice?.upgrade_available === true && hbBehind.advice?.cloud_version === '2.5.0', JSON.stringify(hbBehind.advice));
  const hbAhead = await sendHubHeartbeat(hub.db, t1, { secret: SECRET, hubId: 'store-1', appVersion: '2.6.0', sendHeartbeat });
  ok('Version: a hub AHEAD of the cloud is flagged (upgrade the cloud first)', hbAhead.advice?.version_status === 'ahead' && hbAhead.advice?.upgrade_available === false, JSON.stringify(hbAhead.advice));
  const fleetAhead = await cApp.inj('GET', '/api/hub/fleet', t1admin);
  ok('Fleet: an ahead-of-cloud hub needs attention and is counted', fleetAhead.json?.summary?.ahead_of_cloud === 1 && fleetAhead.json?.hubs?.[0]?.needs_attention === true && fleetAhead.json?.cloud_version === '2.5.0', JSON.stringify(fleetAhead.json?.summary));
  const hbSame = await sendHubHeartbeat(hub.db, t1, { secret: SECRET, hubId: 'store-1', appVersion: '2.5.0', sendHeartbeat });
  ok('Version: a hub on the cloud version is current (no upgrade noise)', hbSame.advice?.version_status === 'current' && hbSame.advice?.upgrade_available === false, JSON.stringify(hbSame.advice));
  const hbUnknown = await sendHubHeartbeat(hub.db, t1, { secret: SECRET, hubId: 'store-1', sendHeartbeat }); // no app_version
  ok('Version: an unversioned hub is "unknown", never spuriously flagged', hbUnknown.advice?.version_status === 'unknown' && hbUnknown.advice?.upgrade_available === false, JSON.stringify(hbUnknown.advice));
  delete process.env.APP_VERSION;

  await cApp.app.close();
  await hApp.app.close();

  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} hub-snapshot checks failed` : `\n✅ All ${checks.length} hub-snapshot checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
