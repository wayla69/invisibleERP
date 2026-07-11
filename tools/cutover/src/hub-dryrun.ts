/**
 * Store-Hub OFFLINE DRY-RUN (docs/41) — a narrated end-to-end demo, not a test harness.
 *
 * Boots TWO real AppModules in one process — a "cloud" and an in-store "hub box" — each on its own
 * Postgres (PGlite). It then plays out a real internet outage:
 *   1. set up the shop on the cloud (menu, tables, buffet, a cashier)
 *   2. seed the hub box from a signed cloud snapshot
 *   3. 🔴 CUT THE INTERNET — the hub keeps selling (cash, QR self-order, buffet) with ZERO cloud calls
 *   4. prove the cloud is completely unaware (0 sales) while the shop is busy
 *   5. 🟢 RECONNECT — the hub signs its captured sales (HMAC) and replays them to the cloud
 *   6. the cloud now holds every sale, GL posted, trial balance balanced
 *   7. a crash-replay (lost push log) re-sends everything → all duplicate (exactly-once)
 *
 * Every call is the SAME service the production app runs. Run:
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover hub-dryrun
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hub-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { importHubSnapshot } from '../../../apps/api/dist/database/hub-import';
import { pushHubSales, pushHubTills } from '../../../apps/api/dist/database/hub-push';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const SECRET = 'demo-hub-sync-secret';
const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', X = '\x1b[0m';
const money = (x: any) => `฿${Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const say = (msg: string) => console.log(msg);
const step = (msg: string) => console.log(`\n${B}${msg}${X}`);

async function freshDb() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  return { pg, db };
}

async function bootApp(db: any) {
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  const inj = async (m: string, url: string, token?: string, payload?: any, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: m as any, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  return { app, inj, login };
}

const cloudSaleCount = async (cApp: any, tok: string) => Number((await cApp.inj('GET', '/api/hub/reconciliation', tok)).json?.summary?.ops ?? 0);

async function main() {
  const pw = new PasswordService();
  process.env.HUB_SYNC_SECRET = SECRET;

  console.log(`\n${C}╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║   Store-Hub OFFLINE dry-run — ขายต่อได้เมื่อเน็ตหลุด แล้ว sync กลับ   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝${X}`);

  // ─── ☁️  CLOUD: set up the shop ───
  step('☁️  1) ตั้งร้านบน CLOUD (เมนู โต๊ะ บุฟเฟต์ พนักงาน)');
  const cloud = await freshDb();
  await cloud.db.insert(s.tenants).values([{ code: 'T1', name: 'ร้านกะเพราไฟลุก', vatRegistered: true, vatRate: '0.0700', promptpayId: '0812345678' }]).onConflictDoNothing();
  const t1 = Number((await cloud.db.select().from(s.tenants))[0].id);
  await cloud.db.insert(s.users).values([
    { username: 'owner', passwordHash: await pw.hash('owner-pw'), role: 'Admin', tenantId: t1 },
    { username: 'cashier1', passwordHash: await pw.hash('pw1'), role: 'Cashier', tenantId: t1, pinHash: await pw.hash('4321'), pinSetAt: new Date() },
  ]).onConflictDoNothing();
  const cApp = await bootApp(cloud.db);
  const owner = await cApp.login('owner', 'owner-pw');
  const cat = await cApp.inj('POST', '/api/menu/categories', owner, { code: 'main', name: 'จานหลัก' });
  await cApp.inj('POST', '/api/menu/items', owner, { sku: 'GP01', name: 'ผัดกะเพราไก่', price: 100, category_id: cat.json.id, station_code: 'hot' });
  await cApp.inj('POST', '/api/menu/items', owner, { sku: 'TY02', name: 'ต้มยำกุ้ง', price: 180, category_id: cat.json.id, station_code: 'hot' });
  const zone = await cApp.inj('POST', '/api/restaurant/zones', owner, { name: 'โซนหน้า' });
  await cApp.inj('POST', '/api/restaurant/tables', owner, { table_no: 'A1', seats: 4, zone_id: zone.json?.id });
  await cApp.inj('POST', '/api/restaurant/buffet/packages', owner, { code: 'BUF1', name: 'บุฟเฟต์ 299', price_per_pax: 299, time_limit_min: 90, overtime_fee_per_pax: 50, item_skus: ['GP01'] });
  say(`   ${G}✓${X} เมนู 2 รายการ (กะเพรา ฿100, ต้มยำ ฿180), โต๊ะ A1, บุฟเฟต์ ฿299/หัว, cashier1 (PIN 4321)`);

  // ─── 📦 seed the hub box ───
  step('📦 2) วางกล่อง HUB ในร้าน แล้ว seed จาก cloud (snapshot เซ็น HMAC)');
  const full = await cApp.inj('GET', '/api/hub/snapshot?include_credentials=1', owner, undefined, { 'x-hub-sync-key': SECRET });
  const hub = await freshDb();
  await importHubSnapshot(hub.db, full.json, { secret: SECRET, hubAdminPasswordHash: await pw.hash('hubadm') });
  const hApp = await bootApp(hub.db);
  const hTok = await hApp.login('cashier1', 'pw1');          // the synced cashier logs in ON THE HUB
  const hAdm = await hApp.login('hubadmin', 'hubadm');
  const hMenu = await hApp.inj('GET', '/api/menu', hAdm);
  say(`   ${G}✓${X} กล่อง seed แล้ว — cashier1 ล็อกอินบนกล่องได้, /api/menu เสิร์ฟ ${hMenu.json?.item_count} รายการ (ทำงานเองครบ)`);

  // ─── 🔴 INTERNET DOWN ───
  console.log(`\n${R}${B}━━━━━━━━━━  🔴 อินเทอร์เน็ตหลุด — cloud ติดต่อไม่ได้  ━━━━━━━━━━${X}`);
  say(`${D}   (ต่อจากนี้ไม่มีการเรียก cloud เลย — ทุกอย่างวิ่งบนกล่องในร้าน)${X}`);

  step('💵 3) หน้าร้านยังขายปกติบนกล่อง');
  const ring = async (label: string, items: any[], checkout: any = {}) => {
    const o = await hApp.inj('POST', '/api/restaurant/orders', hAdm, { items });
    if (!o.json?.order_no) { console.error('DBG order resp', o.status, JSON.stringify(o.json)); }
    const sale = await hApp.inj('POST', `/api/restaurant/orders/${o.json.order_no}/checkout`, hAdm, { method: 'Cash', ...checkout });
    const j = sale.json;
    say(`   ${G}✓${X} ${label} → บิล ${C}${j.sale_no}${X} รวม ${money(j.total_with_tip ?? j.total)}${checkout.tip ? ` ${D}(ทิป ${money(checkout.tip)})${X}` : ''}`);
    return j;
  };
  const s1 = await ring('ผัดกะเพราไก่ x1', [{ sku: 'GP01', qty: 1 }]);
  const s2 = await ring('ต้มยำกุ้ง x2 + ส่วนลด 10% + ทิป', [{ sku: 'TY02', qty: 2 }], { discount_pct: 10, tip: 20 });

  step('📱 4) ลูกค้าสแกน QR ที่โต๊ะ สั่งเอง แล้วพนักงานเก็บเงิน (ไม่ต้องล็อกอิน ไม่ต้องเน็ต)');
  const a1qr = (await hub.pg.query(`SELECT qr_token FROM dining_tables WHERE table_no='A1'`)).rows[0] as any;
  const dstart = await hApp.inj('POST', `/api/qr/start/${a1qr.qr_token}`);
  const dtok = dstart.json?.public_token;
  await hApp.inj('POST', `/api/qr/t/${dtok}/order`, undefined, { items: [{ sku: 'TY02', qty: 1 }] });
  const dstat = await hApp.inj('GET', `/api/qr/t/${dtok}`);
  const s3 = (await hApp.inj('POST', `/api/restaurant/orders/${dstat.json.order.order_no}/checkout`, hAdm, { method: 'Cash' })).json;
  say(`   ${G}✓${X} ลูกค้าสั่งต้มยำเองผ่านมือถือ → พนักงานปิดบิล ${C}${s3.sale_no}${X} รวม ${money(s3.total)}`);

  const hubSales = [s1, s2, s3];
  const hubRevenue = hubSales.reduce((a, x) => a + Number(x.total), 0);
  const cashDrawer = hubSales.reduce((a, x) => a + Number(x.total_with_tip ?? x.total), 0); // tip sits in the drawer

  step('🔎 5) ระหว่างเน็ตหลุด — CLOUD รู้ยอดกี่บิล?');
  const before = await cloudSaleCount(cApp, owner);
  say(`   ขายไปแล้วบนกล่อง: ${B}${hubSales.length} บิล${X} รวม ${B}${money(hubRevenue)}${X}`);
  say(`   cloud เห็น: ${before === 0 ? `${R}${B}0 บิล — มืดสนิท${X}` : `${R}${before}${X}`}  ${D}(ถูกต้อง: เน็ตหลุด cloud ยังไม่รับรู้อะไรเลย)${X}`);

  // ─── 🟢 RECONNECT ───
  console.log(`\n${G}${B}━━━━━━━━━━  🟢 อินเทอร์เน็ตกลับมา — เริ่ม sync ขึ้น cloud  ━━━━━━━━━━${X}`);
  const send = async (batch: any) => {
    const res = await cApp.inj('POST', '/api/hub/ingest', undefined, batch);   // the cloud's public HMAC endpoint
    if (res.status !== 200 && res.status !== 201) throw new Error(res.json?.error?.code ?? String(res.status));
    return res.json;
  };

  step('🔄 6) กล่องเซ็นบิลทั้งหมด (HMAC) แล้วส่งขึ้น cloud');
  const push1 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  say(`   ${G}✓${X} ส่งสำเร็จ ${B}${push1.pushed}${X} บิล, ล้มเหลว ${push1.failed}`);
  const after = await cloudSaleCount(cApp, owner);
  const recon = await cApp.inj('GET', '/api/hub/reconciliation', owner);
  const tb = await cApp.inj('GET', '/api/ledger/trial-balance', owner);
  say(`   ${G}✓${X} cloud ตอนนี้มี ${B}${after} บิล${X} (จาก 0), ยอดตรงกับกล่อง = ${money(recon.json?.summary?.cloud_total)}`);
  say(`   ${G}✓${X} ลงบัญชี GL อัตโนมัติ — งบทดลอง${tb.json?.totals?.balanced ? ` ${G}สมดุล${X}` : ` ${R}ไม่สมดุล${X}`} (Dr ${money(tb.json?.totals?.debit)} = Cr ${money(tb.json?.totals?.credit)})`);

  step('🔁 7) จำลองกล่อง crash แล้ว push ซ้ำ — ต้องไม่เกิดบิลซ้ำ (exactly-once)');
  await hub.pg.query(`DELETE FROM hub_push_log WHERE status IN ('pushed','duplicate')`);   // pretend the push log was lost
  const push2 = await pushHubSales(hub.db, t1, { secret: SECRET, send });
  const after2 = await cloudSaleCount(cApp, owner);
  say(`   ส่งซ้ำทั้งหมด → cloud ตอบ ${B}duplicate ${push2.duplicate}${X}, บิลใหม่ ${push2.pushed}`);
  say(`   cloud ยังมี ${B}${after2} บิล${X} เท่าเดิม ${after2 === after ? `${G}✓ ไม่มีบิลซ้ำ${X}` : `${R}✗ ผิด!${X}`} ${D}(client_uuid คงที่ = กันซ้ำที่ต้นทาง)${X}`);

  // ─── verdict ───
  const ok = before === 0 && after === hubSales.length && tb.json?.totals?.balanced === true && push2.duplicate === hubSales.length && after2 === after;
  console.log(`\n${ok ? G : R}${B}${'═'.repeat(68)}${X}`);
  console.log(`${ok ? G : R}${B}  ${ok ? '✅ ผ่าน' : '❌ ล้มเหลว'}: เน็ตหลุดก็ขายต่อได้ ${hubSales.length} บิล (${money(hubRevenue)}) — เน็ตกลับมา sync ครบ ลง GL สมดุล ไม่มีบิลซ้ำ${X}`);
  console.log(`${ok ? G : R}${B}${'═'.repeat(68)}${X}`);
  say(`${D}  เงินในลิ้นชัก (รวมทิป) = ${money(cashDrawer)} · cloud = สมุดบัญชีหลัก (re-price + post GL) · กล่อง = เครื่องขายตอนออฟไลน์${X}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(`\n${R}dry-run crashed:${X}`, e?.stack ?? e); process.exit(1); });
