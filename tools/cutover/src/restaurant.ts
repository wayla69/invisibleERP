/**
 * Phase 11 — Restaurant/F&B POS validation (real Nest app over PGlite, RLS-enforced):
 * dine-in orders + KDS lifecycle + wait-time, floor-plan tables, public QR diner (HMAC token) +
 * diner self-ordering (public menu + menu-driven order auto-fired to KDS) +
 * buffet self-ordering (per-pax tier + time window, ฿0 food, overtime surcharge) +
 * PromptPay pay → cust_pos_sales + GL + abbreviated tax invoice.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover restaurant
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'resto-secret';
process.env.PROMPTPAY_WEBHOOK_SECRET = process.env.PROMPTPAY_WEBHOOK_SECRET || 'whsec';
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
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
const taxId = (p12: string) => { let sum = 0; for (let i = 0; i < 12; i++) sum += Number(p12[i]) * (13 - i); return p12 + String((11 - (sum % 11)) % 10); };

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'ร้านอาหารหนึ่ง', legalName: 'บจก. ร้านหนึ่ง', taxId: taxId('010555600001'), vatRegistered: true, branchCode: '00000', addressLine1: '1 ถนนอาหาร', province: 'กรุงเทพมหานคร', postalCode: '10110' },
    { code: 'T2', name: 'ร้านอาหารสอง', taxId: taxId('010555600002'), vatRegistered: true },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, body: res.body };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const sales1 = await login('sales1', 'pw1');
  const sales2 = await login('sales2', 'pw2');

  // ── floor-plan: create + open a table ──
  const tbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A1', seats: 4, pos_x: 10, pos_y: 20 });
  ok('Table created (available)', (tbl.status === 200 || tbl.status === 201) && tbl.json.table_no === 'A1' && tbl.json.status === 'available' && !!tbl.json.qr_token, `${tbl.status}`);
  const open1 = await inj('POST', `/api/restaurant/tables/${tbl.json.id}/open`, sales1, { party_size: 2 });
  ok('Open table → session + diner token', (open1.status === 200 || open1.status === 201) && !!open1.json.public_token && /^TS-/.test(open1.json.session_no ?? ''), `${open1.status}`);

  // ── dine-in order + KDS lifecycle ──
  const ord = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tbl.json.id, session_id: open1.json.session_id, guest_count: 2, items: [{ name: 'ผัดกะเพราหมู', qty: 2, unit_price: 60, station_code: 'hot' }, { name: 'ชาเย็น', qty: 2, unit_price: 25, station_code: 'drinks' }] });
  ok('Order created (DIN-) + live totals', /^DIN-\d{8}-\d{3}$/.test(ord.json.order_no ?? '') && ord.json.items?.length === 2 && near(ord.json.subtotal, 170), `${ord.status} ${JSON.stringify(ord.json).slice(0, 80)}`);
  const fired = await inj('POST', `/api/restaurant/orders/${ord.json.order_no}/fire`, sales1);
  ok('Fire → items queued + order sent_to_kitchen', fired.json.status === 'sent_to_kitchen' && (fired.json.items ?? []).every((i: any) => i.kds_status === 'queued'), `${fired.status} ${JSON.stringify(fired.json).slice(0, 90)}`);
  const feed = await inj('GET', '/api/restaurant/kds/feed', sales1);
  const feedItems = (feed.json.stations ?? []).flatMap((st: any) => st.items);
  ok('KDS feed shows fired items grouped by station', feed.json.stations?.length === 2 && feedItems.length === 2 && feedItems.every((i: any) => i.elapsed_min >= 0), `stations=${feed.json.stations?.length}`);
  const item1 = ord.json.items[0].item_id;
  const badJump = await inj('PATCH', `/api/restaurant/kds/items/${item1}`, sales1, { action: 'serve' }); // queued→serve illegal
  ok('KDS rejects illegal transition (queued→serve) 400', badJump.status === 400, `${badJump.status}`);
  await inj('PATCH', `/api/restaurant/kds/items/${item1}`, sales1, { action: 'start' });
  const ready1 = await inj('PATCH', `/api/restaurant/kds/items/${item1}`, sales1, { action: 'ready' });
  ok('KDS bump queued→preparing→ready', ready1.json.kds_status === 'ready' && ready1.json.order_status === 'partially_ready', `${ready1.json.order_status}`);

  // ── wait-time on the diner status (via QR token) ──
  const dinerTok = open1.json.public_token;
  const st1 = await inj('GET', `/api/qr/t/${dinerTok}`, undefined);
  ok('Diner status (QR token) shows order + wait-time', st1.status === 200 && st1.json.order?.items?.length === 2 && st1.json.order.waited_min >= 0 && st1.json.table_no === 'A1', `${st1.status} ${JSON.stringify(st1.json).slice(0, 80)}`);
  ok('Diner status per-item statusTh present', (st1.json.order?.items ?? []).some((i: any) => i.status_th === 'พร้อมเสิร์ฟ' || i.status_th === 'รอคิว'));

  // ── staff cash checkout → sale + GL + abbreviated invoice ──
  await inj('POST', `/api/restaurant/orders/${ord.json.order_no}/bill`, sales1);
  const co = await inj('POST', `/api/restaurant/orders/${ord.json.order_no}/checkout`, sales1, { method: 'Cash' });
  ok('Checkout → sale + GL + abbreviated invoice', /^SALE-/.test(co.json.sale_no ?? '') && /^JE-/.test(co.json.journal_no ?? '') && /^ATV-/.test(co.json.tax_invoice_no ?? '') && near(co.json.total, 181.9), `${co.status} ${JSON.stringify(co.json).slice(0, 110)}`);
  const saleRow = (await pg.query(`SELECT total FROM cust_pos_sales WHERE sale_no = '${co.json.sale_no}'`)).rows as any[];
  ok('Checkout created cust_pos_sales row', saleRow.length === 1 && near(saleRow[0].total, 181.9), JSON.stringify(saleRow));
  const tblAfter = (await pg.query(`SELECT status FROM dining_tables WHERE id = ${tbl.json.id}`)).rows as any[];
  ok('Table → cleaning after checkout', tblAfter[0].status === 'cleaning', tblAfter[0].status);

  // ── QR diner PromptPay flow on a second tenant's table (its own SALE-T2- series → no same-second collision) ──
  const tbl2 = await inj('POST', '/api/restaurant/tables', sales2, { table_no: 'B1', seats: 2 });
  const open2 = await inj('POST', `/api/restaurant/tables/${tbl2.json.id}/open`, sales2, {});
  const tok2 = open2.json.public_token;
  await inj('POST', '/api/restaurant/orders', sales2, { table_id: tbl2.json.id, session_id: open2.json.session_id, items: [{ name: 'ข้าวผัดกุ้ง', qty: 1, unit_price: 100, station_code: 'hot' }] });
  const billD = await inj('POST', `/api/qr/t/${tok2}/bill`, undefined);
  ok('Diner request bill (public)', (billD.status === 200 || billD.status === 201) && billD.json.status === 'bill_requested', `${billD.status}`);
  const payD = await inj('POST', `/api/qr/t/${tok2}/pay`, undefined);
  ok('Diner PromptPay pay → Pending', (payD.status === 200 || payD.status === 201) && /^PAY-/.test(payD.json.payment_no ?? '') && payD.json.status === 'Pending' && near(payD.json.total, 107), `${payD.status} ${JSON.stringify(payD.json).slice(0, 80)}`);
  const confirmD = await inj('POST', `/api/qr/t/${tok2}/confirm`, undefined, { payment_no: payD.json.payment_no });
  ok('Diner confirm → settled + sale + invoice + closed', confirmD.json.paid === true && /^SALE-/.test(confirmD.json.sale_no ?? '') && /^ATV-/.test(confirmD.json.tax_invoice_no ?? ''), `${confirmD.status} ${JSON.stringify(confirmD.json).slice(0, 110)}`);
  const tokAfter = await inj('GET', `/api/qr/t/${tok2}`, undefined);
  ok('Diner token rejected after session closed (401)', tokAfter.status === 401, `${tokAfter.status}`);

  // ── menu-driven ordering: dine-in entry resolves the catalog (price/station/modifiers/86) ──
  await inj('POST', '/api/menu/categories', sales1, { code: 'main', name: 'จานหลัก' });
  await inj('POST', '/api/menu/items', sales1, { sku: 'GP01', name: 'ผัดกะเพราไก่', price: 60, station_code: 'hot', prep_minutes: 12 });
  const mSpice = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'spice', name: 'ความเผ็ด', required: true, min_select: 1, max_select: 1, options: [{ name: 'เผ็ดน้อย', price_delta: 0 }, { name: 'เผ็ดมาก', price_delta: 0 }] });
  const mEgg = await inj('POST', '/api/menu/modifier-groups', sales1, { code: 'egg', name: 'ไข่', min_select: 0, max_select: 1, options: [{ name: 'ไข่ดาว', price_delta: 10 }] });
  await inj('POST', '/api/menu/items/GP01/modifier-groups', sales1, { group_id: mSpice.json.group_id });
  await inj('POST', '/api/menu/items/GP01/modifier-groups', sales1, { group_id: mEgg.json.group_id });
  const spicy = mSpice.json.options.find((o: any) => o.name === 'เผ็ดมาก').option_id;
  const eggDao = mEgg.json.options.find((o: any) => o.name === 'ไข่ดาว').option_id;
  const tblM = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'C1', seats: 2 });
  const ordM = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tblM.json.id, items: [{ sku: 'GP01', qty: 2, modifier_option_ids: [spicy, eggDao] }] });
  const lineM = ordM.json.items?.[0];
  ok('Menu-order: dine-in resolves name/price/station from catalog (60+ไข่10 → 70×2=140)', lineM?.name === 'ผัดกะเพราไก่' && near(lineM?.unit_price, 70) && near(lineM?.amount, 140), JSON.stringify(lineM).slice(0, 120));
  ok('Menu-order: resolved modifiers attached to KDS line', (lineM?.modifiers ?? []).some((m: any) => m.option_name === 'ไข่ดาว'), JSON.stringify(lineM?.modifiers));
  const ordBad = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tblM.json.id, items: [{ sku: 'GP01', qty: 1 }] });
  ok('Menu-order: missing required modifier → order rejected (400)', ordBad.status === 400 && ordBad.json.error?.code === 'MODIFIER_REQUIRED', `${ordBad.status} ${ordBad.json.error?.code}`);
  await inj('PATCH', '/api/menu/items/GP01/availability', sales1, { available: false });
  const ord86 = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tblM.json.id, items: [{ sku: 'GP01', qty: 1, modifier_option_ids: [spicy] }] });
  ok('Menu-order: 86\'d item blocked at order entry (400 ITEM_UNAVAILABLE)', ord86.status === 400 && ord86.json.error?.code === 'ITEM_UNAVAILABLE', `${ord86.status} ${ord86.json.error?.code}`);
  const ordFree = await inj('POST', '/api/restaurant/orders', sales1, { items: [{ name: 'น้ำเปล่า', qty: 1, unit_price: 15, station_code: 'drinks' }] });
  ok('Menu-order: freeform custom item still supported (backward-compat)', /^DIN-/.test(ordFree.json.order_no ?? '') && ordFree.json.items?.[0]?.name === 'น้ำเปล่า', `${ordFree.status}`);

  // ── diner QR SELF-ORDERING: public menu + menu-driven order that AUTO-FIRES to the KDS ──
  const tblQ = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A2', seats: 2 });
  const openQ = await inj('POST', `/api/restaurant/tables/${tblQ.json.id}/open`, sales1, {});
  const qTok = openQ.json.public_token;
  await inj('POST', '/api/menu/items', sales1, { sku: 'QR01', name: 'ข้าวมันไก่', price: 50, station_code: 'hot', prep_minutes: 8 });
  const dMenu = await inj('GET', `/api/qr/t/${qTok}/menu`, undefined);
  const dMenuItems = [...(dMenu.json.categories ?? []).flatMap((c: any) => c.items), ...(dMenu.json.uncategorized ?? [])];
  ok('Diner self-order: public menu lists the available item', dMenu.status === 200 && dMenuItems.some((i: any) => i.sku === 'QR01' && i.is_available), `${dMenu.status} items=${dMenuItems.length}`);
  const dOrder = await inj('POST', `/api/qr/t/${qTok}/order`, undefined, { items: [{ sku: 'QR01', qty: 2 }] });
  ok('Diner self-order: submit → order auto-fired to kitchen (items queued)', (dOrder.status === 200 || dOrder.status === 201) && dOrder.json.order?.items?.length === 1 && dOrder.json.order.items[0].kds_status === 'queued', `${dOrder.status} ${JSON.stringify(dOrder.json.order?.items?.[0] ?? {}).slice(0, 70)}`);
  const dFeed = await inj('GET', '/api/restaurant/kds/feed', sales1);
  const dFeedItems = (dFeed.json.stations ?? []).flatMap((s: any) => s.items);
  ok('Diner self-order: item appears on the KDS feed', dFeedItems.some((i: any) => i.name === 'ข้าวมันไก่' && i.order_no === dOrder.json.order.order_no));
  const dFeedItem = dFeedItems.find((i: any) => i.name === 'ข้าวมันไก่');
  ok('KDS badges: à la carte diner item flagged from_diner (not buffet); staff items unflagged', dFeedItem?.from_diner === true && dFeedItem?.is_buffet === false && dFeedItems.filter((i: any) => i.order_no === ord.json.order_no).every((i: any) => i.from_diner === false), JSON.stringify({ d: dFeedItem?.from_diner, b: dFeedItem?.is_buffet }));
  const dAdd = await inj('POST', `/api/qr/t/${qTok}/order`, undefined, { items: [{ sku: 'QR01', qty: 1 }] });
  ok('Diner self-order: a second submit appends to the same open order', (dAdd.status === 200 || dAdd.status === 201) && dAdd.json.order.order_no === dOrder.json.order.order_no && dAdd.json.order.items.length === 2, `${dAdd.status} lines=${dAdd.json.order?.items?.length}`);
  const dFree = await inj('POST', `/api/qr/t/${qTok}/order`, undefined, { items: [{ name: 'ของแถมฟรี', unit_price: 0, qty: 1 }] });
  ok('Diner self-order: freeform/priced line rejected — must be menu-driven (no price tampering)', dFree.status === 400, `${dFree.status}`);
  await inj('PATCH', '/api/menu/items/QR01/availability', sales1, { available: false });
  const d86 = await inj('POST', `/api/qr/t/${qTok}/order`, undefined, { items: [{ sku: 'QR01', qty: 1 }] });
  ok('Diner self-order: 86\'d item blocked at submit (400 ITEM_UNAVAILABLE)', d86.status === 400 && d86.json.error?.code === 'ITEM_UNAVAILABLE', `${d86.status} ${d86.json.error?.code}`);
  const dClosed = await inj('GET', `/api/qr/t/${dinerTok}/menu`, undefined);
  ok('Diner self-order: menu/order on an ended session → 401', dClosed.status === 401, `${dClosed.status}`);

  // ── BUFFET self-ordering: per-pax tier + dining time window, ฿0 food, overtime surcharge ──
  await inj('POST', '/api/menu/items', sales1, { sku: 'BF01', name: 'หมูสไลด์', price: 0, station_code: 'hot', prep_minutes: 5 });
  await inj('POST', '/api/menu/items', sales1, { sku: 'BF02', name: 'เนื้อวากิว', price: 0, station_code: 'hot', prep_minutes: 5 }); // NOT in the tier
  await inj('POST', '/api/menu/items', sales1, { sku: 'AL01', name: 'ต้มยำกุ้ง', price: 120, station_code: 'hot' });               // à la carte
  const pkg = await inj('POST', '/api/restaurant/buffet/packages', sales1, { code: 'STD', name: 'บุฟเฟต์มาตรฐาน', price_per_pax: 299, time_limit_min: 90, overtime_fee_per_pax: 100, item_skus: ['BF01'] });
  ok('Buffet: admin creates a tier (price/pax + eligible items)', (pkg.status === 200 || pkg.status === 201) && pkg.json.price_per_pax === 299 && (pkg.json.item_skus ?? []).includes('BF01'), `${pkg.status}`);

  const tblB = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A3', seats: 4 });
  const openB = await inj('POST', `/api/restaurant/tables/${tblB.json.id}/open`, sales1, {});
  const bTok = openB.json.public_token;
  const tiers = await inj('GET', `/api/qr/t/${bTok}/buffet/tiers`, undefined);
  ok('Buffet: diner sees the offered tiers', tiers.status === 200 && (tiers.json.tiers ?? []).some((t: any) => t.id === pkg.json.id), `${tiers.status}`);
  const startB = await inj('POST', `/api/qr/t/${bTok}/buffet/start`, undefined, { package_id: pkg.json.id, pax: 4 });
  ok('Buffet: start sets mode + per-pax charge (299×4=1196) + time window', (startB.status === 200 || startB.status === 201) && startB.json.order_mode === 'buffet' && near(startB.json.bill?.subtotal, 1196) && startB.json.buffet?.pax === 4 && startB.json.buffet?.minutes_left > 0, `${startB.status} sub=${startB.json.bill?.subtotal} left=${startB.json.buffet?.minutes_left}`);

  const ordB = await inj('POST', `/api/qr/t/${bTok}/order`, undefined, { items: [{ sku: 'BF01', qty: 3 }] });
  const foodLine = (ordB.json.order?.items ?? []).find((i: any) => i.name === 'หมูสไลด์');
  ok('Buffet: eligible food → ฿0 line, is_buffet, auto-fired', (ordB.status === 200 || ordB.status === 201) && foodLine && foodLine.amount === 0 && foodLine.is_buffet === true && foodLine.kds_status === 'queued', `${ordB.status} ${JSON.stringify(foodLine ?? {}).slice(0, 80)}`);
  ok('Buffet: ฿0 food does not change the bill (still 1196)', near(ordB.json.bill?.subtotal, 1196), `sub=${ordB.json.bill?.subtotal}`);
  const feedB = await inj('GET', '/api/restaurant/kds/feed', sales1);
  const feedItemsB = (feedB.json.stations ?? []).flatMap((s: any) => s.items);
  ok('Buffet: ฿0 food still routes to the KDS feed', feedItemsB.some((i: any) => i.name === 'หมูสไลด์'));
  ok('Buffet: per-pax charge line stays OFF the KDS feed', !feedItemsB.some((i: any) => String(i.name).startsWith('บุฟเฟต์')));
  const bfFeedItem = feedItemsB.find((i: any) => i.name === 'หมูสไลด์');
  ok('KDS badges: diner-ordered buffet item flagged (from_diner + is_buffet)', bfFeedItem?.from_diner === true && bfFeedItem?.is_buffet === true, JSON.stringify({ d: bfFeedItem?.from_diner, b: bfFeedItem?.is_buffet }));
  const ordIneligible = await inj('POST', `/api/qr/t/${bTok}/order`, undefined, { items: [{ sku: 'BF02', qty: 1 }] });
  ok('Buffet: ineligible item rejected (400 NOT_IN_PACKAGE)', ordIneligible.status === 400 && ordIneligible.json.error?.code === 'NOT_IN_PACKAGE', `${ordIneligible.status} ${ordIneligible.json.error?.code}`);

  // one mode per session: à la carte first then buffet → rejected
  const tblL = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A4', seats: 2 });
  const openL = await inj('POST', `/api/restaurant/tables/${tblL.json.id}/open`, sales1, {});
  const lTok = openL.json.public_token;
  await inj('POST', `/api/qr/t/${lTok}/order`, undefined, { items: [{ sku: 'AL01', qty: 1 }] });
  const lockB = await inj('POST', `/api/qr/t/${lTok}/buffet/start`, undefined, { package_id: pkg.json.id, pax: 2 });
  ok('Buffet: cannot start after à la carte ordering (400 MODE_LOCKED)', lockB.status === 400 && lockB.json.error?.code === 'MODE_LOCKED', `${lockB.status} ${lockB.json.error?.code}`);

  // force the time window to have elapsed → orders blocked, overtime billed
  await db.update(s.tableSessions).set({ buffetExpiresAt: new Date(Date.now() - 60000) }).where(eq(s.tableSessions.id, Number(openB.json.session_id)));
  const ordExpired = await inj('POST', `/api/qr/t/${bTok}/order`, undefined, { items: [{ sku: 'BF01', qty: 1 }] });
  ok('Buffet: ordering after the window blocked (400 BUFFET_EXPIRED)', ordExpired.status === 400 && ordExpired.json.error?.code === 'BUFFET_EXPIRED', `${ordExpired.status} ${ordExpired.json.error?.code}`);
  await inj('POST', `/api/qr/t/${bTok}/bill`, undefined);
  const afterBill = await inj('GET', `/api/qr/t/${bTok}`, undefined);
  const overLine = (afterBill.json.order?.items ?? []).find((i: any) => String(i.name).includes('เกินเวลา'));
  ok('Buffet: overtime surcharge (100×4=400) added at bill → subtotal 1596', near(afterBill.json.bill?.subtotal, 1596), `sub=${afterBill.json.bill?.subtotal}`);
  ok('Buffet: overtime is a charge line (off-kitchen)', !!overLine && overLine.charge === true && near(overLine.amount, 400), JSON.stringify(overLine ?? {}).slice(0, 80));

  // ── buffet behaviour analytics (per-tier menu mix, covers, consumption, revenue) ──
  const an = await inj('GET', '/api/restaurant/buffet/analytics', sales1);
  const stdTier = (an.json.tiers ?? []).find((t: any) => t.tier?.code === 'STD');
  ok('Buffet analytics: per-tier sessions/covers + top item + items-per-head', an.status === 200 && stdTier?.sessions === 1 && stdTier?.covers === 4 && stdTier?.top_items?.[0]?.name === 'หมูสไลด์' && near(stdTier?.top_items?.[0]?.qty, 3) && near(stdTier?.items_per_head, 0.75), `${an.status} ${JSON.stringify(stdTier ?? {}).slice(0, 130)}`);
  ok('Buffet analytics: per-tier revenue (charge+overtime) + overtime rate', near(stdTier?.revenue, 1596) && near(stdTier?.avg_bill_per_session, 1596) && stdTier?.overtime_sessions === 1 && near(stdTier?.overtime_rate_pct, 100), `rev=${stdTier?.revenue} avg=${stdTier?.avg_bill_per_session} otRate=${stdTier?.overtime_rate_pct}`);

  // ── printed-QR entry + real PromptPay (webhook settlement) ──
  const tblX = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A6', seats: 2 });
  const stk = await inj('GET', `/api/restaurant/tables/${tblX.json.id}/qr?base=${encodeURIComponent('https://app.example')}`, sales1);
  ok('Printed QR: sticker endpoint returns landing URL + image', stk.status === 200 && stk.json.url === `https://app.example/qr/start/${tblX.json.qr_token}` && String(stk.json.qr_image).startsWith('data:image'), `${stk.status} ${String(stk.json.url).slice(0, 60)}`);
  const startX = await inj('POST', `/api/qr/start/${tblX.json.qr_token}`, undefined, {});
  ok('Printed QR: scanning the stable token opens/joins a session', (startX.status === 200 || startX.status === 201) && !!startX.json.public_token, `${startX.status}`);
  const xTok = startX.json.public_token;
  await inj('POST', `/api/qr/t/${xTok}/order`, undefined, { items: [{ sku: 'AL01', qty: 1 }] });
  const payX = await inj('POST', `/api/qr/t/${xTok}/pay`, undefined, {});
  ok('PromptPay pay: returns a scannable QR image + real-settle mode (secret configured)', (payX.status === 200 || payX.status === 201) && String(payX.json.qr_image).startsWith('data:image') && payX.json.mock_settle === false, `${payX.status} mock=${payX.json.mock_settle}`);

  const wh = (secret: string | undefined) => app.inject({ method: 'POST', url: '/api/qr/webhook/promptpay', headers: secret ? { 'x-webhook-secret': secret } : {}, payload: { payment_no: payX.json.payment_no, status: 'paid' } });
  const whBad = await wh('nope');
  ok('PromptPay webhook: bad/missing secret rejected (401)', whBad.statusCode === 401, `${whBad.statusCode}`);
  const whOk = await wh('whsec'); const whJson: any = (() => { try { return whOk.json(); } catch { return {}; } })();
  ok('PromptPay webhook: valid secret settles + finalises (sale + invoice + paid)', whOk.statusCode < 300 && whJson.paid === true && /^SALE-/.test(whJson.sale_no ?? '') && !!whJson.tax_invoice_no, `${whOk.statusCode} ${JSON.stringify(whJson).slice(0, 90)}`);
  const psX = await inj('GET', `/api/qr/t/${xTok}/payment-status`, undefined);
  ok('Diner payment-status reflects the settled bill (tolerates closed session)', psX.status === 200 && psX.json.settled === true, `${psX.status} ${JSON.stringify(psX.json).slice(0, 70)}`);
  const whAgain = await wh('whsec'); const whAgainJson: any = (() => { try { return whAgain.json(); } catch { return {}; } })();
  ok('PromptPay webhook: idempotent on re-delivery (no double-post)', whAgain.statusCode < 300 && (whAgainJson.paid === true || whAgainJson.settled === true), `${whAgain.statusCode}`);

  // ── staff-initiated buffet (from POS/floor) ──
  const tblSb = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A7', seats: 4 });
  const sbStart = await inj('POST', `/api/restaurant/tables/${tblSb.json.id}/buffet`, sales1, { package_id: pkg.json.id, pax: 2 });
  ok('Staff buffet: start from POS opens session + tier (299×2 charge)', (sbStart.status === 200 || sbStart.status === 201) && sbStart.json.package?.code === 'STD' && sbStart.json.pax === 2 && !!sbStart.json.expires_at, `${sbStart.status} ${JSON.stringify(sbStart.json).slice(0, 90)}`);
  const sbOrders = await inj('GET', '/api/restaurant/orders', sales1);
  ok('Staff buffet: per-pax charge order is open on the table', (sbOrders.json.orders ?? []).some((o: any) => o.table_id === tblSb.json.id && near(o.total, 598 * 1.07)), `${(sbOrders.json.orders ?? []).filter((o: any) => o.table_id === tblSb.json.id).map((o: any) => o.total)}`);

  // ── anti-abuse: public order endpoint is rate-limited per session ──
  const tblRl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A8', seats: 2 });
  const openRl = await inj('POST', `/api/restaurant/tables/${tblRl.json.id}/open`, sales1, {});
  let limited = false, okCount = 0;
  for (let i = 0; i < 16; i++) { const r = await inj('POST', `/api/qr/t/${openRl.json.public_token}/order`, undefined, { items: [{ sku: 'AL01', qty: 1 }] }); if (r.status === 429) limited = true; else if (r.status < 300) okCount++; }
  ok('Anti-abuse: diner order endpoint throttled per session (429 after burst)', limited && okCount <= 15, `ok=${okCount} limited=${limited}`);

  // ── table operations: move a live tab to another table ──
  const mvFrom = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A10', seats: 2 });
  const mvOpen = await inj('POST', `/api/restaurant/tables/${mvFrom.json.id}/open`, sales1, {});
  const mvOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: mvFrom.json.id, session_id: mvOpen.json.session_id, items: [{ name: 'น้ำส้ม', qty: 1, unit_price: 40, station_code: 'drinks' }] });
  const mvTo = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A11', seats: 4 });
  const moved = await inj('POST', `/api/restaurant/tables/${mvFrom.json.id}/move`, sales1, { to_table_id: mvTo.json.id });
  ok('Table move: relocates the live tab to a free table', (moved.status === 200 || moved.status === 201) && moved.json.to_table_no === 'A11' && moved.json.session_no === mvOpen.json.session_no, `${moved.status} ${JSON.stringify(moved.json).slice(0, 80)}`);
  const mvBoard = await inj('GET', '/api/restaurant/tables/status', sales1);
  const a11 = (mvBoard.json.tables ?? []).find((t: any) => t.table_no === 'A11');
  const a10 = (mvBoard.json.tables ?? []).find((t: any) => t.table_no === 'A10');
  ok('Table move: target occupied + carries the order; source freed', a11?.status === 'occupied' && a11?.order?.order_no === mvOrd.json.order_no && a10?.status === 'available', `to=${a11?.status}/${a11?.order?.order_no} from=${a10?.status}`);
  const occ = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A12', seats: 2 });
  await inj('POST', `/api/restaurant/tables/${occ.json.id}/open`, sales1, {});
  const moveBusy = await inj('POST', `/api/restaurant/tables/${mvTo.json.id}/move`, sales1, { to_table_id: occ.json.id });
  ok('Table move: onto an occupied table rejected (400 TABLE_BUSY)', moveBusy.status === 400 && moveBusy.json.error?.code === 'TABLE_BUSY', `${moveBusy.status} ${moveBusy.json.error?.code}`);

  // ── table operations: transfer items between tables ──
  const tfFrom = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A13', seats: 4 });
  const tfOpen = await inj('POST', `/api/restaurant/tables/${tfFrom.json.id}/open`, sales1, {});
  const tfOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tfFrom.json.id, session_id: tfOpen.json.session_id, items: [{ name: 'สเต๊ก', qty: 1, unit_price: 200, station_code: 'hot' }, { name: 'สลัด', qty: 1, unit_price: 80, station_code: 'cold' }] });
  const tfTo = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A14', seats: 2 });
  await inj('POST', `/api/restaurant/tables/${tfTo.json.id}/open`, sales1, {});
  const steakId = (tfOrd.json.items ?? []).find((i: any) => i.name === 'สเต๊ก')?.item_id;
  const tf = await inj('POST', `/api/restaurant/orders/${tfOrd.json.order_no}/transfer-items`, sales1, { item_ids: [steakId], to_table_id: tfTo.json.id });
  ok('Transfer items: moves a line to another table', (tf.status === 200 || tf.status === 201) && tf.json.moved === 1 && tf.json.to_table_id === tfTo.json.id, `${tf.status} ${JSON.stringify(tf.json).slice(0, 90)}`);
  const tfSrc = await inj('GET', `/api/restaurant/orders/${tfOrd.json.order_no}`, sales1);
  ok('Transfer items: source keeps the remaining line (80); target carries the moved one (200)', tfSrc.json.items?.length === 1 && near(tfSrc.json.subtotal, 80) && (await inj('GET', '/api/restaurant/orders', sales1)).json.orders.some((o: any) => o.table_id === tfTo.json.id && near(o.total, 214)), `src=${tfSrc.json.items?.length}/${tfSrc.json.subtotal}`);

  // ── table operations: merge two tabs into one (combined bill) ──
  const mgT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A15', seats: 4 });
  const mgTo = await inj('POST', `/api/restaurant/tables/${mgT.json.id}/open`, sales1, {});
  const mgTord = await inj('POST', '/api/restaurant/orders', sales1, { table_id: mgT.json.id, session_id: mgTo.json.session_id, items: [{ name: 'ข้าวผัด', qty: 1, unit_price: 100, station_code: 'hot' }] });
  const mgF = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A16', seats: 2 });
  const mgFo = await inj('POST', `/api/restaurant/tables/${mgF.json.id}/open`, sales1, {});
  await inj('POST', '/api/restaurant/orders', sales1, { table_id: mgF.json.id, session_id: mgFo.json.session_id, items: [{ name: 'น้ำเปล่า', qty: 1, unit_price: 50, station_code: 'drinks' }] });
  const merged = await inj('POST', `/api/restaurant/tables/${mgT.json.id}/merge`, sales1, { from_table_id: mgF.json.id });
  ok('Merge tables: absorbs the other tab into one order', (merged.status === 200 || merged.status === 201) && merged.json.into_order_no === mgTord.json.order_no && merged.json.moved === 1, `${merged.status} ${JSON.stringify(merged.json).slice(0, 90)}`);
  const mgCombined = await inj('GET', `/api/restaurant/orders/${mgTord.json.order_no}`, sales1);
  ok('Merge tables: combined bill = sum of both tabs (subtotal 150)', mgCombined.json.items?.length === 2 && near(mgCombined.json.subtotal, 150), `lines=${mgCombined.json.items?.length} sub=${mgCombined.json.subtotal}`);
  const mgBoard = await inj('GET', '/api/restaurant/tables/status', sales1);
  const a16 = (mgBoard.json.tables ?? []).find((t: any) => t.table_no === 'A16');
  ok('Merge tables: source table freed after merge', a16?.status === 'available' && !a16?.session, `${a16?.status} session=${!!a16?.session}`);

  // ── floor-plan edit: reposition (drag) + delete (soft) + busy-guard ──
  const fpT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'F1', seats: 2, pos_x: 0, pos_y: 0 });
  const fpMoved = await inj('PATCH', `/api/restaurant/tables/${fpT.json.id}`, sales1, { pos_x: 240, pos_y: 130 });
  ok('Floor-plan: drag persists new x/y (PATCH pos_x/pos_y)', (fpMoved.status === 200 || fpMoved.status === 201) && near(fpMoved.json.pos_x, 240) && near(fpMoved.json.pos_y, 130), `${fpMoved.status} ${fpMoved.json.pos_x},${fpMoved.json.pos_y}`);
  const fpBoard = await inj('GET', '/api/restaurant/tables/status', sales1);
  ok('Floor-plan: status board reflects the moved position', near((fpBoard.json.tables ?? []).find((t: any) => t.id === fpT.json.id)?.pos_x, 240), `x=${(fpBoard.json.tables ?? []).find((t: any) => t.id === fpT.json.id)?.pos_x}`);

  const delT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'F2', seats: 2 });
  const delRes = await inj('DELETE', `/api/restaurant/tables/${delT.json.id}`, sales1);
  ok('Floor-plan: delete a free table (soft-delete → active=false)', (delRes.status === 200 || delRes.status === 201) && delRes.json.deleted === true, `${delRes.status} ${JSON.stringify(delRes.json).slice(0, 60)}`);
  const afterDel = await inj('GET', '/api/restaurant/tables', sales1);
  ok('Floor-plan: deleted table drops off the list', !(afterDel.json.tables ?? []).some((t: any) => t.id === delT.json.id), `n=${(afterDel.json.tables ?? []).length}`);
  const delGone = await inj('DELETE', `/api/restaurant/tables/${delT.json.id}`, sales1);
  ok('Floor-plan: deleting an already-removed table → 404', delGone.status === 404, `${delGone.status}`);

  const busyT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'F3', seats: 2 });
  await inj('POST', `/api/restaurant/tables/${busyT.json.id}/open`, sales1, {});
  const delBusy = await inj('DELETE', `/api/restaurant/tables/${busyT.json.id}`, sales1);
  ok('Floor-plan: deleting a table with a live session rejected (400 TABLE_BUSY)', delBusy.status === 400 && delBusy.json.error?.code === 'TABLE_BUSY', `${delBusy.status} ${delBusy.json.error?.code}`);

  // ── floor-plan zones / rooms (a VIP room is just a zone) ──
  const zoneRes = await inj('POST', '/api/restaurant/zones', sales1, { name: 'ห้อง VIP', color: '#caa53d', pos_x: 40, pos_y: 24, width: 300, height: 180 });
  ok('Zones: create a room (VIP) with geometry + accent colour', (zoneRes.status === 200 || zoneRes.status === 201) && !!zoneRes.json.id && zoneRes.json.name === 'ห้อง VIP' && zoneRes.json.color === '#caa53d' && near(zoneRes.json.width, 300), `${zoneRes.status} ${JSON.stringify(zoneRes.json).slice(0, 90)}`);
  const zoneId = zoneRes.json.id;
  const zoneMoved = await inj('PATCH', `/api/restaurant/zones/${zoneId}`, sales1, { pos_x: 120, pos_y: 60, width: 360, height: 220, name: 'ห้อง VIP 1' });
  ok('Zones: drag/resize/rename persists (PATCH)', zoneMoved.status === 200 && near(zoneMoved.json.pos_x, 120) && near(zoneMoved.json.width, 360) && zoneMoved.json.name === 'ห้อง VIP 1', `${zoneMoved.status} ${JSON.stringify(zoneMoved.json).slice(0, 90)}`);
  const zoneList = await inj('GET', '/api/restaurant/zones', sales1);
  ok('Zones: list returns the room with geometry', (zoneList.json.zones ?? []).some((z: any) => z.id === zoneId && near(z.pos_x, 120) && z.color === '#caa53d'), `n=${(zoneList.json.zones ?? []).length}`);
  const t2zones = await inj('GET', '/api/restaurant/zones', sales2);
  ok('Zones: rooms are tenant-isolated (T2 cannot see T1’s room)', !(t2zones.json.zones ?? []).some((z: any) => z.id === zoneId), `T2 zones=${(t2zones.json.zones ?? []).length}`);

  const zTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'V1', seats: 6 });
  const assign = await inj('PATCH', `/api/restaurant/tables/${zTbl.json.id}`, sales1, { zone_id: zoneId });
  ok('Zones: assign a table to the room (zone_id)', assign.status === 200 && assign.json.zone_id === zoneId, `${assign.status} zone=${assign.json.zone_id}`);
  const unassign = await inj('PATCH', `/api/restaurant/tables/${zTbl.json.id}`, sales1, { zone_id: null });
  ok('Zones: un-assign a table from a room (zone_id=null)', unassign.status === 200 && unassign.json.zone_id == null, `${unassign.status} zone=${unassign.json.zone_id}`);

  await inj('PATCH', `/api/restaurant/tables/${zTbl.json.id}`, sales1, { zone_id: zoneId });   // re-assign before deleting the room
  const zoneDel = await inj('DELETE', `/api/restaurant/zones/${zoneId}`, sales1);
  ok('Zones: delete a room (soft-delete)', (zoneDel.status === 200 || zoneDel.status === 201) && zoneDel.json.deleted === true, `${zoneDel.status} ${JSON.stringify(zoneDel.json).slice(0, 60)}`);
  const zoneListAfter = await inj('GET', '/api/restaurant/zones', sales1);
  ok('Zones: deleted room drops off the list', !(zoneListAfter.json.zones ?? []).some((z: any) => z.id === zoneId), `n=${(zoneListAfter.json.zones ?? []).length}`);
  const tblAfterZoneDel = await inj('GET', '/api/restaurant/tables', sales1);
  ok('Zones: deleting a room keeps its tables (un-grouped, zone_id=null)', (tblAfterZoneDel.json.tables ?? []).some((t: any) => t.id === zTbl.json.id && t.zone_id == null), `${(tblAfterZoneDel.json.tables ?? []).find((t: any) => t.id === zTbl.json.id)?.zone_id}`);
  const zoneGone = await inj('DELETE', `/api/restaurant/zones/${zoneId}`, sales1);
  ok('Zones: deleting an already-removed room → 404', zoneGone.status === 404, `${zoneGone.status}`);

  // ── floor-plan table appearance: shape + rotation + resize + seats ──
  const apT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'S1', seats: 2 });
  const apShape = await inj('PATCH', `/api/restaurant/tables/${apT.json.id}`, sales1, { shape: 'circle', width: 90, height: 90, rotation: 45, seats: 8 });
  ok('Table appearance: shape/size/rotation/seats persist (PATCH)', apShape.status === 200 && apShape.json.shape === 'circle' && near(apShape.json.width, 90) && apShape.json.rotation === 45 && apShape.json.seats === 8, `${apShape.status} ${JSON.stringify(apShape.json).slice(0, 100)}`);
  const apBoard = await inj('GET', '/api/restaurant/tables/status', sales1);
  const apRow = (apBoard.json.tables ?? []).find((t: any) => t.id === apT.json.id);
  ok('Table appearance: status board carries shape + rotation', apRow?.shape === 'circle' && apRow?.rotation === 45 && near(apRow?.height, 90), `shape=${apRow?.shape} rot=${apRow?.rotation}`);
  const apBadShape = await inj('PATCH', `/api/restaurant/tables/${apT.json.id}`, sales1, { shape: 'triangle' });
  ok('Table appearance: unknown shape rejected (400)', apBadShape.status === 400, `${apBadShape.status}`);
  const apBadRot = await inj('PATCH', `/api/restaurant/tables/${apT.json.id}`, sales1, { rotation: 400 });
  ok('Table appearance: out-of-range rotation rejected (400)', apBadRot.status === 400, `${apBadRot.status}`);

  // ── optimistic concurrency: rev-gated table updates ──
  const cT = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'C9', seats: 2 });
  const cRev0 = cT.json.rev;
  ok('Optimistic lock: a new table carries rev=0', cRev0 === 0, `rev=${cRev0}`);
  const cOk = await inj('PATCH', `/api/restaurant/tables/${cT.json.id}`, sales1, { pos_x: 50, rev: cRev0 });
  ok('Optimistic lock: PATCH with the current rev applies + bumps rev', cOk.status === 200 && cOk.json.rev === cRev0 + 1 && near(cOk.json.pos_x, 50), `${cOk.status} rev ${cRev0}->${cOk.json.rev}`);
  const cStale = await inj('PATCH', `/api/restaurant/tables/${cT.json.id}`, sales1, { pos_x: 80, rev: cRev0 });   // reuse the now-stale rev
  ok('Optimistic lock: PATCH with a stale rev rejected (409 STALE_WRITE)', cStale.status === 409 && cStale.json.error?.code === 'STALE_WRITE', `${cStale.status} ${cStale.json.error?.code}`);
  const cForce = await inj('PATCH', `/api/restaurant/tables/${cT.json.id}`, sales1, { pos_x: 80 });   // no rev → last-write-wins (e.g. an undo)
  ok('Optimistic lock: PATCH without rev still applies (last-write-wins)', cForce.status === 200 && near(cForce.json.pos_x, 80) && cForce.json.rev === cRev0 + 2, `${cForce.status} rev=${cForce.json.rev}`);

  // create accepts the full initial appearance (shape/rotation/size/seats) — the "duplicate table" path
  const dupSrc = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'C10', shape: 'square', rotation: 90, width: 70, height: 70, seats: 6 });
  ok('Create: table accepts initial shape/rotation/size/seats (duplicate path)', (dupSrc.status === 200 || dupSrc.status === 201) && dupSrc.json.shape === 'square' && dupSrc.json.rotation === 90 && dupSrc.json.seats === 6 && near(dupSrc.json.width, 70), `${dupSrc.status} ${JSON.stringify(dupSrc.json).slice(0, 90)}`);

  // ── per-room revenue analytics (sale → order → table → zone) ──
  const rvZone = await inj('POST', '/api/restaurant/zones', sales1, { name: 'โซนรายได้' });
  const rvTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'R1', seats: 2, zone_id: rvZone.json.id });
  const rvOpen = await inj('POST', `/api/restaurant/tables/${rvTbl.json.id}/open`, sales1, {});
  const rvOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: rvTbl.json.id, session_id: rvOpen.json.session_id, items: [{ name: 'สเต๊กห้อง', qty: 1, unit_price: 300, station_code: 'hot' }] });
  await inj('POST', `/api/restaurant/orders/${rvOrd.json.order_no}/bill`, sales1);
  const rvCo = await inj('POST', `/api/restaurant/orders/${rvOrd.json.order_no}/checkout`, sales1, { method: 'Cash' });
  const rvRev = await inj('GET', '/api/restaurant/zones/revenue', sales1);
  const rvRoom = (rvRev.json.rooms ?? []).find((r: any) => r.zone_id === rvZone.json.id);
  ok('Zone revenue: attributes a dine-in sale to its room (gross incl. VAT)', rvRev.status === 200 && !!rvRoom && rvRoom.sales === 1 && near(rvRoom.revenue, rvCo.json.total) && near(rvRoom.avg_sale, rvRoom.revenue), `${rvRev.status} ${JSON.stringify(rvRoom ?? {}).slice(0, 100)}`);
  ok('Zone revenue: grand total reconciles rooms + unzoned', near(rvRev.json.total?.revenue, (rvRev.json.rooms ?? []).reduce((s: number, r: any) => s + r.revenue, 0) + (rvRev.json.unzoned?.revenue ?? 0)), `total=${rvRev.json.total?.revenue}`);
  const rvT2 = await inj('GET', '/api/restaurant/zones/revenue', sales2);
  ok('Zone revenue: tenant-isolated (T2 cannot see T1’s room)', !(rvT2.json.rooms ?? []).some((r: any) => r.zone_id === rvZone.json.id), `T2 rooms=${(rvT2.json.rooms ?? []).length}`);
  // snapshot proof: move R1 to a different room AFTER the sale → the sale stays in the room it was sold in
  const rvZone2 = await inj('POST', '/api/restaurant/zones', sales1, { name: 'โซนใหม่' });
  await inj('PATCH', `/api/restaurant/tables/${rvTbl.json.id}`, sales1, { zone_id: rvZone2.json.id });
  const rvRev2 = await inj('GET', '/api/restaurant/zones/revenue', sales1);
  const rvStill = (rvRev2.json.rooms ?? []).find((r: any) => r.zone_id === rvZone.json.id);
  const rvMovedTo = (rvRev2.json.rooms ?? []).find((r: any) => r.zone_id === rvZone2.json.id);
  ok('Zone revenue: room snapshot — moving the table later keeps the sale in the original room', near(rvStill?.revenue, rvCo.json.total) && (rvMovedTo?.revenue ?? 0) === 0, `orig=${rvStill?.revenue} movedTo=${rvMovedTo?.revenue}`);
  await inj('DELETE', `/api/restaurant/zones/${rvZone.json.id}`, sales1);   // delete the room that earned the sale
  const rvRev3 = await inj('GET', '/api/restaurant/zones/revenue', sales1);
  const rvDeleted = (rvRev3.json.rooms ?? []).find((r: any) => r.zone_id === rvZone.json.id);
  ok('Zone revenue: a deleted room keeps its past takings (flagged inactive) + total still reconciles', !!rvDeleted && rvDeleted.active === false && near(rvDeleted.revenue, rvCo.json.total) && near(rvRev3.json.total?.revenue, (rvRev3.json.rooms ?? []).reduce((s: number, r: any) => s + r.revenue, 0) + (rvRev3.json.unzoned?.revenue ?? 0)), `del=${JSON.stringify(rvDeleted ?? {}).slice(0, 80)}`);

  // ── KDS course firing (hold-and-fire course-by-course) ──
  const csTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A17', seats: 4 });
  const csOpen = await inj('POST', `/api/restaurant/tables/${csTbl.json.id}/open`, sales1, {});
  const csOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: csTbl.json.id, session_id: csOpen.json.session_id, items: [{ name: 'ปอเปี๊ยะ', qty: 1, unit_price: 60, station_code: 'hot', course: 1 }, { name: 'สเต๊กปลา', qty: 1, unit_price: 220, station_code: 'hot', course: 2 }] });
  ok('Course firing: lines carry their course number', csOrd.json.items?.find((i: any) => i.name === 'ปอเปี๊ยะ')?.course === 1 && csOrd.json.items?.find((i: any) => i.name === 'สเต๊กปลา')?.course === 2, JSON.stringify((csOrd.json.items ?? []).map((i: any) => [i.name, i.course])));
  const fc1 = await inj('POST', `/api/restaurant/orders/${csOrd.json.order_no}/fire?course=1`, sales1);
  const c1 = fc1.json.items?.find((i: any) => i.name === 'ปอเปี๊ยะ'); const c2 = fc1.json.items?.find((i: any) => i.name === 'สเต๊กปลา');
  ok('Course firing: fire course 1 queues only course 1 (course 2 held)', c1?.kds_status === 'queued' && c2?.kds_status === 'new', `c1=${c1?.kds_status} c2=${c2?.kds_status}`);
  const csFeed = (await inj('GET', '/api/restaurant/kds/feed', sales1)).json;
  const csFeedItems = (csFeed.stations ?? []).flatMap((s: any) => s.items);
  ok('Course firing: only the fired course hits the KDS feed, tagged with course', csFeedItems.some((i: any) => i.name === 'ปอเปี๊ยะ' && i.course === 1) && !csFeedItems.some((i: any) => i.name === 'สเต๊กปลา'), `feed=${csFeedItems.filter((i: any) => ['ปอเปี๊ยะ', 'สเต๊กปลา'].includes(i.name)).map((i: any) => i.name)}`);
  const fc2 = await inj('POST', `/api/restaurant/orders/${csOrd.json.order_no}/fire?course=2`, sales1);
  ok('Course firing: firing the next course queues the held items', fc2.json.items?.find((i: any) => i.name === 'สเต๊กปลา')?.kds_status === 'queued', `${fc2.json.items?.find((i: any) => i.name === 'สเต๊กปลา')?.kds_status}`);
  const fcBad = await inj('POST', `/api/restaurant/orders/${csOrd.json.order_no}/fire?course=5`, sales1);
  ok('Course firing: firing an empty course rejected (400 NO_COURSE_ITEMS)', fcBad.status === 400 && fcBad.json.error?.code === 'NO_COURSE_ITEMS', `${fcBad.status} ${fcBad.json.error?.code}`);

  // ── POS-4: KDS depth — prep-time SLA aging + expo (order-ready pass) + station load + bump/recall counts ──
  const kdTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'K1', seats: 4 });
  const kdOpen = await inj('POST', `/api/restaurant/tables/${kdTbl.json.id}/open`, sales1, {});
  const kdOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: kdTbl.json.id, session_id: kdOpen.json.session_id, items: [
    { name: 'SLA-OK', qty: 1, unit_price: 50, station_code: 'hot' },
    { name: 'SLA-WARN', qty: 1, unit_price: 50, station_code: 'hot' },
    { name: 'SLA-LATE', qty: 2, unit_price: 50, station_code: 'hot' },
  ] });
  await inj('POST', `/api/restaurant/orders/${kdOrd.json.order_no}/fire`, sales1);
  const kdId = (nm: string) => kdOrd.json.items.find((i: any) => i.name === nm).item_id;
  // Pin prep target to 10 min and backdate fired_at to force each SLA band: <10=ok, <15=warn, ≥15=late.
  await pg.query(`UPDATE dine_in_order_items SET est_prep_minutes = 10 WHERE order_id = (SELECT id FROM dine_in_orders WHERE order_no = '${kdOrd.json.order_no}')`);
  await pg.query(`UPDATE dine_in_order_items SET fired_at = now() - interval '2 minutes'  WHERE id = ${kdId('SLA-OK')}`);
  await pg.query(`UPDATE dine_in_order_items SET fired_at = now() - interval '12 minutes' WHERE id = ${kdId('SLA-WARN')}`);
  await pg.query(`UPDATE dine_in_order_items SET fired_at = now() - interval '20 minutes' WHERE id = ${kdId('SLA-LATE')}`);
  const kdFeed = (await inj('GET', '/api/restaurant/kds/feed', sales1)).json;
  const kdFeedItems = (kdFeed.stations ?? []).flatMap((s: any) => s.items);
  const fOk = kdFeedItems.find((i: any) => i.name === 'SLA-OK'); const fWarn = kdFeedItems.find((i: any) => i.name === 'SLA-WARN'); const fLate = kdFeedItems.find((i: any) => i.name === 'SLA-LATE');
  ok('POS-4 SLA aging: feed returns a per-item sla band (ok/warn/late) by elapsed vs prep target', fOk?.sla === 'ok' && fWarn?.sla === 'warn' && fLate?.sla === 'late', `ok=${fOk?.sla} warn=${fWarn?.sla} late=${fLate?.sla} prep=${fOk?.prep_min}`);

  // Expo: ready one line → order shows on the pass but not all-ready; ready the rest → all_ready.
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-OK')}`, sales1, { action: 'start' });
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-OK')}`, sales1, { action: 'ready' });
  const expo1 = (await inj('GET', '/api/restaurant/kds/expo', sales1)).json;
  const tk1 = (expo1.tickets ?? []).find((t: any) => t.order_no === kdOrd.json.order_no);
  ok('POS-4 expo: order with a ready line appears on the pass, not yet all-ready', !!tk1 && tk1.ready_count === 1 && tk1.all_ready === false && tk1.pending_count === 2 && tk1.ready_items.some((it: any) => it.name === 'SLA-OK'), `${JSON.stringify(tk1 ? { r: tk1.ready_count, p: tk1.pending_count, all: tk1.all_ready } : null)}`);
  // Snapshot the hot station's all-day counts before bump/recall, then act.
  const loadBefore = (await inj('GET', '/api/restaurant/kds/load', sales1)).json;
  const hotBefore = (loadBefore.stations ?? []).find((s: any) => s.station_code === 'hot') ?? { bumped_today: 0, recalls_today: 0 };
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-WARN')}`, sales1, { action: 'start' });
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-WARN')}`, sales1, { action: 'ready' });
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-LATE')}`, sales1, { action: 'start' });
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-LATE')}`, sales1, { action: 'ready' });
  const expo2 = (await inj('GET', '/api/restaurant/kds/expo', sales1)).json;
  const tk2 = (expo2.tickets ?? []).find((t: any) => t.order_no === kdOrd.json.order_no);
  ok('POS-4 expo: once nothing is cooking the ticket is all_ready (ready for pass)', !!tk2 && tk2.all_ready === true && tk2.ready_count === 3 && tk2.pending_count === 0, `${JSON.stringify(tk2 ? { r: tk2.ready_count, all: tk2.all_ready } : null)}`);
  // Recall SLA-WARN off the pass (bump/recall), bump SLA-OK to served.
  const recalled = await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-WARN')}`, sales1, { action: 'recall' });
  ok('POS-4 recall: ready→queued transition succeeds', recalled.json.kds_status === 'queued', `${recalled.status} ${recalled.json.kds_status}`);
  await inj('PATCH', `/api/restaurant/kds/items/${kdId('SLA-OK')}`, sales1, { action: 'serve' });
  const loadAfter = (await inj('GET', '/api/restaurant/kds/load', sales1)).json;
  const hotAfter = (loadAfter.stations ?? []).find((s: any) => s.station_code === 'hot');
  ok('POS-4 station load: all-day recall count per station increments on recall', !!hotAfter && hotAfter.recalls_today === hotBefore.recalls_today + 1, `recalls ${hotBefore.recalls_today}→${hotAfter?.recalls_today}`);
  ok('POS-4 station load: all-day bump (served) count per station increments on serve', !!hotAfter && hotAfter.bumped_today === hotBefore.bumped_today + 1, `bumped ${hotBefore.bumped_today}→${hotAfter?.bumped_today}`);
  ok('POS-4 station load: overdue + all-day qty roll-up per station (SLA-LATE qty 2 still cooking)', !!hotAfter && hotAfter.overdue >= 1 && hotAfter.all_day.some((a: any) => a.name === 'SLA-LATE' && a.qty === 2) && hotAfter.avg_elapsed_min >= 0, `overdue=${hotAfter?.overdue} allday=${JSON.stringify(hotAfter?.all_day?.find((a: any) => a.name === 'SLA-LATE'))}`);

  // ── day-parting / menu scheduling (Asia/Bangkok) ──
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  const nowMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
  const closedStart = (nowMin + 120) % 1440, closedEnd = (closedStart + 1) % 1440;        // 1-min window ~2h from now → closed now
  const dayMaskClosed = Array.from({ length: 7 }, (_, i) => (i === bkk.getUTCDay() ? '0' : '1')).join(''); // today off
  await inj('POST', '/api/menu/items', sales1, { sku: 'BRK1', name: 'ข้าวต้มเช้า', price: 50, station_code: 'hot', avail_start_min: closedStart, avail_end_min: closedEnd });
  await inj('POST', '/api/menu/items', sales1, { sku: 'DAYX', name: 'เมนูเฉพาะวัน', price: 60, station_code: 'hot', avail_days: dayMaskClosed });
  const menuNow = (await inj('GET', '/api/menu', sales1)).json;
  const dpItems = [...(menuNow.categories ?? []).flatMap((c: any) => c.items), ...(menuNow.uncategorized ?? [])];
  const brk = dpItems.find((i: any) => i.sku === 'BRK1'); const dayx = dpItems.find((i: any) => i.sku === 'DAYX'); const al = dpItems.find((i: any) => i.sku === 'AL01');
  ok('Day-parting: menu flags available_now per schedule (time window + day mask + always)', brk?.available_now === false && dayx?.available_now === false && al?.available_now === true, `brk=${brk?.available_now} dayx=${dayx?.available_now} al=${al?.available_now}`);
  const dpTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'A18', seats: 2 });
  const dpOpen = await inj('POST', `/api/restaurant/tables/${dpTbl.json.id}/open`, sales1, {});
  const dpBad = await inj('POST', `/api/qr/t/${dpOpen.json.public_token}/order`, undefined, { items: [{ sku: 'BRK1', qty: 1 }] });
  ok('Day-parting: ordering outside the time window rejected (400 OUTSIDE_HOURS)', dpBad.status === 400 && dpBad.json.error?.code === 'OUTSIDE_HOURS', `${dpBad.status} ${dpBad.json.error?.code}`);
  const dpDay = await inj('POST', `/api/qr/t/${dpOpen.json.public_token}/order`, undefined, { items: [{ sku: 'DAYX', qty: 1 }] });
  ok('Day-parting: ordering on an excluded day rejected (400 OUTSIDE_HOURS)', dpDay.status === 400 && dpDay.json.error?.code === 'OUTSIDE_HOURS', `${dpDay.status} ${dpDay.json.error?.code}`);
  const dpOk = await inj('POST', `/api/qr/t/${dpOpen.json.public_token}/order`, undefined, { items: [{ sku: 'AL01', qty: 1 }] });
  ok('Day-parting: an always-available item is still orderable', dpOk.status === 200 || dpOk.status === 201, `${dpOk.status}`);

  // ── CRM messaging + birthdays (Phase 6) ──
  const bkkNow = new Date(Date.now() + 7 * 3600 * 1000);
  const todayBday = `1990-${String(bkkNow.getUTCMonth() + 1).padStart(2, '0')}-${String(bkkNow.getUTCDate()).padStart(2, '0')}`;
  const mem1 = await inj('POST', '/api/loyalty/members', sales1, { name: 'คุณวันเกิด', phone: '0810000001', birthday: todayBday, marketing_opt_in: true });
  ok('CRM: enroll member with birthday + marketing consent', (mem1.status === 200 || mem1.status === 201) && !!mem1.json.id, `${mem1.status}`);
  const send1 = await inj('POST', '/api/messaging/send', sales1, { member_id: mem1.json.id, channel: 'sms', body: 'สวัสดีค่ะ' });
  ok('CRM messaging: send to a member logged as sent (mock provider)', (send1.status === 200 || send1.status === 201) && send1.json.status === 'sent' && send1.json.provider === 'mock', `${send1.status} ${send1.json.status}/${send1.json.provider}`);
  const mem2 = await inj('POST', '/api/loyalty/members', sales1, { name: 'คุณไม่รับโปร', phone: '0810000002', birthday: todayBday, marketing_opt_in: false });
  const send2 = await inj('POST', '/api/messaging/send', sales1, { member_id: mem2.json.id, channel: 'sms', body: 'โปรโมชั่น' });
  ok('CRM messaging: opted-out member is skipped (consent respected)', send2.json.status === 'skipped', `${send2.json.status}`);
  const bdays = await inj('GET', '/api/loyalty/members/birthdays?window=today', sales1);
  ok('CRM: birthdays-today lists the opted-in member, excludes opted-out', (bdays.json.members ?? []).some((m: any) => m.id === mem1.json.id) && !(bdays.json.members ?? []).some((m: any) => m.id === mem2.json.id), `count=${bdays.json.count}`);
  const blast = await inj('POST', '/api/messaging/blast', sales1, { audience: 'birthdays_today', channel: 'sms', body: 'สุขสันต์วันเกิด 🎂' });
  ok('CRM messaging: birthday blast sends to opted-in only (skips opted-out)', blast.status < 300 && blast.json.sent >= 1 && blast.json.skipped >= 1, `sent=${blast.json.sent} skipped=${blast.json.skipped} targeted=${blast.json.targeted}`);
  const mlog = await inj('GET', '/api/messaging/log', sales1);
  ok('CRM messaging: deliveries recorded in the message log', (mlog.json.messages ?? []).length >= 3, `${(mlog.json.messages ?? []).length}`);
  const updMem = await inj('PATCH', `/api/loyalty/members/${mem1.json.id}`, sales1, { marketing_opt_in: false });
  ok('CRM: member consent can be updated', updMem.json.marketing_opt_in === false, `${updMem.json.marketing_opt_in}`);

  // ── food-cost / margin analytics (Phase 7) ──
  await inj('POST', '/api/menu/items', sales1, { sku: 'FC01', name: 'ก๋วยเตี๋ยวต้มยำ', price: 100, station_code: 'hot' });
  await inj('POST', '/api/menu/items/FC01/recipe', sales1, { yield_qty: 1, lines: [{ ingredient_item_id: 'NOODLE', ingredient_description: 'เส้น', qty_per: 2, unit_cost: 15 }] });
  const fc = await inj('GET', '/api/menu/food-cost', sales1);
  const fc01 = (fc.json.items ?? []).find((i: any) => i.sku === 'FC01');
  ok('Food-cost: per-item margin from recipe (cost 30, margin 70, food-cost 30%)', !!fc01 && near(fc01.cost, 30) && near(fc01.margin, 70) && near(fc01.margin_pct, 70) && near(fc01.food_cost_pct, 30) && fc01.has_recipe === true, `${JSON.stringify(fc01 ?? {}).slice(0, 130)}`);
  ok('Food-cost: menu summary reports avg food-cost % + costed count', fc.status === 200 && fc.json.summary?.costed >= 1 && fc.json.summary?.avg_food_cost_pct >= 0, `${JSON.stringify(fc.json.summary ?? {})}`);
  const ic = await inj('GET', '/api/menu/ingredient-cost', sales1);
  ok('Food-cost: ingredient cost-contribution lists the ingredient (30/serving)', (ic.json.ingredients ?? []).some((g: any) => g.ingredient_item_id === 'NOODLE' && near(g.cost, 30) && g.recipes_using >= 1), `${JSON.stringify((ic.json.ingredients ?? []).slice(0, 2))}`);

  // ── actual-vs-theoretical food-cost variance (costed EOD-count roll-up) ──
  await db.insert(s.items).values([
    { itemId: 'NOODLE', itemDescription: 'เส้น', unitPrice: '15' },
    { itemId: 'OIL', itemDescription: 'น้ำมัน', unitPrice: '50' },
  ]).onConflictDoNothing();
  await db.insert(s.custVariance).values([
    { varDate: '2026-06-23', tenantId: t1, itemId: 'NOODLE', itemDescription: 'เส้น', theoreticalUse: '10', actualUse: '12', variance: '2', variancePct: '20', uom: 'kg', reasonCode: 'PORTIONING', station: 'Sauce' },   // over-portioned at the sauce station
    { varDate: '2026-06-23', tenantId: t1, itemId: 'OIL', itemDescription: 'น้ำมัน', theoreticalUse: '5', actualUse: '4', variance: '-1', variancePct: '-20', uom: 'L', reasonCode: 'WASTE', station: 'Fry' },        // used 1 less → favorable
    { varDate: '2026-06-23', tenantId: t2, itemId: 'NOODLE', itemDescription: 'เส้น', theoreticalUse: '99', actualUse: '99', variance: '0', variancePct: '0', uom: 'kg', reasonCode: 'OTHER' },       // T2 — must not leak into T1's report
  ]);
  const fcv = await inj('GET', '/api/menu/food-cost/variance?from=2020-01-01&to=2099-12-31', sales1);
  const vNoodle = (fcv.json.items ?? []).find((i: any) => i.item_id === 'NOODLE');
  ok('Food-cost variance: per-ingredient variance valued at cost (NOODLE +2 × ฿15 = +฿30 unfavorable, High)', !!vNoodle && near(vNoodle.variance_cost, 30) && near(vNoodle.theoretical_cost, 150) && vNoodle.anomaly === 'High', `${JSON.stringify(vNoodle ?? {}).slice(0, 150)}`);
  ok('Food-cost variance: summary nets unfavorable/favorable (+30 / −50 = −20) and is tenant-isolated', fcv.status === 200 && near(fcv.json.summary?.variance_cost, -20) && near(fcv.json.summary?.unfavorable_cost, 30) && near(fcv.json.summary?.favorable_cost, -50) && fcv.json.summary?.items === 2, `${JSON.stringify(fcv.json.summary ?? {})}`);
  // Step 4 — by-reason + by-station breakdown (the actionable "why / where" lever)
  const byPort = (fcv.json.by_reason ?? []).find((r: any) => r.reason_code === 'PORTIONING');
  const byWaste = (fcv.json.by_reason ?? []).find((r: any) => r.reason_code === 'WASTE');
  ok('Food-cost variance: by_reason rolls cost up (PORTIONING +฿30 / WASTE −฿50)', near(byPort?.variance_cost, 30) && near(byWaste?.variance_cost, -50), `${JSON.stringify(fcv.json.by_reason ?? [])}`);
  const sauce = (fcv.json.by_station ?? []).find((st: any) => st.station === 'Sauce');
  ok('Food-cost variance: by_station flags Sauce +฿30 over theoretical (20%)', near(sauce?.variance_cost, 30) && near(sauce?.variance_pct, 20), `${JSON.stringify(fcv.json.by_station ?? [])}`);

  // ── receipts & printing (Phase 4) ──
  const rcSale = co.json.sale_no; // sale settled at checkout above
  const jobsAfterCheckout = await inj('GET', '/api/print/jobs', sales1);
  ok('Printing: checkout auto-queues a receipt print job for the sale', (jobsAfterCheckout.json.jobs ?? []).some((j: any) => j.sale_no === rcSale && j.job_type === 'receipt' && j.status === 'queued'), `jobs=${(jobsAfterCheckout.json.jobs ?? []).length}`);
  const tie = await inj('GET', `/api/print/tie-out/${rcSale}`, sales1);
  ok('Printing: receipt ties out to the fiscal sale (REST-10 control)', tie.status === 200 && tie.json.matched === true && near(tie.json.total, 181.9), `matched=${tie.json.matched} total=${tie.json.total}`);
  const rcData = await inj('GET', `/api/print/receipt/${rcSale}/data`, sales1);
  ok('Printing: receipt data renders seller header + VAT line + items', rcData.json.data?.seller?.vat_registered === true && (rcData.json.data?.items ?? []).length === 2 && near(rcData.json.data?.vat, 11.9), `${JSON.stringify(rcData.json.data?.seller ?? {}).slice(0, 80)}`);
  const rcHtml = await inj('GET', `/api/print/receipt/${rcSale}`, sales1);
  ok('Printing: HTML receipt document served', rcHtml.status === 200 && typeof rcHtml.body === 'string' && rcHtml.body.includes(rcSale) && rcHtml.body.includes('ใบเสร็จ'), `${rcHtml.status}`);
  const pull1 = await inj('GET', '/api/print/jobs/next', sales1);
  ok('Printing: agent pulls the next queued job (claimed → sent, payload present)', !!pull1.json.job && pull1.json.job.sale_no === rcSale && pull1.json.job.format === 'escpos' && !!pull1.json.job.payload, `${JSON.stringify(pull1.json.job ?? {}).slice(0, 60)}`);
  const ackOk = await inj('POST', `/api/print/jobs/${pull1.json.job.id}/ack`, sales1, { ok: true });
  ok('Printing: agent acks job printed', ackOk.json.status === 'printed', `${ackOk.json.status}`);
  const reprint = await inj('POST', `/api/print/reprint/${rcSale}`, sales1);
  ok('Printing: reprint enqueues a fresh (copy) receipt job', (reprint.status === 200 || reprint.status === 201) && !!reprint.json.id, `${reprint.status}`);
  const reData = await inj('GET', `/api/print/receipt/${rcSale}/data`, sales1);
  ok('Printing: a re-render after the original is flagged as a COPY (สำเนา)', reData.json.data?.is_copy === true, `is_copy=${reData.json.data?.is_copy}`);
  const sendRc = await inj('POST', `/api/print/receipt/${rcSale}/send`, sales1, { channel: 'email', to: 'guest@example.com' });
  ok('Printing: receipt delivered out-of-band via messaging gateway', (sendRc.status === 200 || sendRc.status === 201) && sendRc.json.status === 'sent', `${sendRc.status} ${sendRc.json.status}`);
  const t2pull = await inj('GET', '/api/print/jobs', sales2);
  ok('Printing: print jobs are tenant-isolated (T2 sees none of T1’s)', (t2pull.json.jobs ?? []).every((j: any) => j.sale_no !== rcSale), `T2 jobs=${(t2pull.json.jobs ?? []).length}`);

  // ── i18n: bilingual receipts + per-tenant locale (Phase 9) ──
  const rcThai = await inj('GET', `/api/print/receipt/${rcSale}/data`, sales1);
  ok('i18n: receipt defaults to the tenant language (TH)', rcThai.json.data?.lang === 'th', `lang=${rcThai.json.data?.lang}`);
  const rcEn = await inj('GET', `/api/print/receipt/${rcSale}?lang=en`, sales1);
  ok('i18n: receipt renders in English on ?lang=en (Subtotal/Total/Thank you, no Thai total)', rcEn.status === 200 && typeof rcEn.body === 'string' && rcEn.body.includes('Subtotal') && rcEn.body.includes('Total') && rcEn.body.includes('Thank you') && !rcEn.body.includes('รวมสุทธิ'), `${rcEn.status}`);
  const rcBoth = await inj('GET', `/api/print/receipt/${rcSale}?lang=both`, sales1);
  ok('i18n: bilingual receipt shows TH / EN labels', !!rcBoth.body && rcBoth.body.includes('ยอดรวม') && rcBoth.body.includes('Subtotal') && rcBoth.body.includes('รวมสุทธิ / Total'), `${rcBoth.status}`);
  const adminTok = await login('admin', 'admin123');
  const setLang = await inj('PATCH', '/api/tenant/profile', adminTok, { default_language: 'en' });
  const getLang = await inj('GET', '/api/tenant/profile', adminTok);
  ok('i18n: per-tenant default language is saved + returned on the profile', (setLang.status === 200 || setLang.status === 201) && getLang.json.default_language === 'en', `set=${setLang.status} got=${getLang.json.default_language}`);

  // ── hardware peripherals (Phase 5): cash drawer + customer display + weighing scale ──
  const dev = await inj('POST', '/api/peripherals/devices', sales1, { device_code: 'DRW1', kind: 'cash_drawer', terminal: 'T01', printer_id: 'PRN1' });
  ok('Peripherals: register a cash-drawer device', (dev.status === 200 || dev.status === 201) && !!dev.json.id, `${dev.status}`);
  const devList = await inj('GET', '/api/peripherals/devices', sales1);
  ok('Peripherals: device registry lists the drawer', (devList.json.devices ?? []).some((d: any) => d.device_code === 'DRW1' && d.kind === 'cash_drawer'), `${(devList.json.devices ?? []).length}`);
  // the cash checkout above (co) should have auto-popped the drawer as a 'sale' open
  const drawerEvts = await inj('GET', '/api/peripherals/drawer/events', sales1);
  ok('Cash drawer: cash checkout auto-logged a sale open', (drawerEvts.json.events ?? []).some((e: any) => e.reason === 'sale' && e.sale_no === rcSale), `events=${(drawerEvts.json.events ?? []).length}`);
  const kick = await inj('POST', '/api/peripherals/drawer/kick', sales1, { terminal: 'T01', reason: 'no_sale' });
  ok('Cash drawer: no-sale open kicks the drawer (via print queue) + audits it', (kick.status === 200 || kick.status === 201) && kick.json.reason === 'no_sale' && kick.json.kicked === true && !!kick.json.print_job_id, `${kick.status} kicked=${kick.json.kicked}`);
  const drawerJob = await inj('GET', '/api/print/jobs', sales1);
  ok('Cash drawer: the kick is a drawer print job (escpos)', (drawerJob.json.jobs ?? []).some((j: any) => j.id === kick.json.print_job_id && j.job_type === 'drawer' && j.format === 'escpos'), `job=${kick.json.print_job_id}`);
  const recon = await inj('GET', '/api/peripherals/drawer/reconciliation', sales1);
  ok('Cash drawer: reconciliation counts opens by reason incl. no-sale (REST-11 control)', recon.status === 200 && recon.json.no_sale_opens >= 1 && recon.json.total_opens >= 2, `total=${recon.json.total_opens} no_sale=${recon.json.no_sale_opens}`);

  const disp = await inj('POST', '/api/peripherals/display/T01', sales1, { message: 'ชำระเงิน', total: 181.9, amount_due: 200, change: 18.1, lines: [{ name: 'ผัดกะเพรา', qty: 2, amount: 120 }] });
  ok('Customer display: set per-terminal state', (disp.status === 200 || disp.status === 201) && disp.json.ok === true, `${disp.status}`);
  const dispGet = await inj('GET', '/api/peripherals/display/T01', sales1);
  ok('Customer display: device polls the current state', dispGet.json.state?.total === 181.9 && near(dispGet.json.state?.change, 18.1) && (dispGet.json.state?.lines ?? []).length === 1, `${JSON.stringify(dispGet.json.state ?? {}).slice(0, 80)}`);

  await inj('POST', '/api/menu/items', sales1, { sku: 'WGH1', name: 'หมูสามชั้น', price: 180, station_code: 'main' }); // price = per kg once weighed
  const setW = await inj('PATCH', '/api/peripherals/scale/items/WGH1', sales1, { sold_by_weight: true, weight_unit: 'kg' });
  ok('Scale: mark a catalog item sold-by-weight', setW.json.sold_by_weight === true && setW.json.weight_unit === 'kg', `${setW.status}`);
  const wread = await inj('POST', '/api/peripherals/scale/read', sales1, { sku: 'WGH1', gross_weight: 1.25, tare_weight: 0.05, terminal: 'T01' });
  ok('Scale: net weight × catalog unit price computed server-side (1.2kg × 180 = 216)', wread.status === 200 || wread.status === 201 ? (near(wread.json.net_weight, 1.2) && near(wread.json.amount, 216) && near(wread.json.line?.unit_price, 216)) : false, `net=${wread.json.net_weight} amt=${wread.json.amount}`);
  const wbad = await inj('POST', '/api/peripherals/scale/read', sales1, { sku: 'AL01', gross_weight: 1 }); // AL01 is not sold by weight
  ok('Scale: reading a non-weighed item rejected (400 NOT_WEIGHED)', wbad.status === 400 && wbad.json.error?.code === 'NOT_WEIGHED', `${wbad.status} ${wbad.json.error?.code}`);

  const t2dev = await inj('GET', '/api/peripherals/devices', sales2);
  ok('Peripherals: device registry is tenant-isolated (T2 sees none of T1’s)', (t2dev.json.devices ?? []).every((d: any) => d.device_code !== 'DRW1'), `T2 devices=${(t2dev.json.devices ?? []).length}`);

  // ── payments depth (Phase 8): deposits + house accounts (+ FX settle) + card surcharge ──
  const dep = await inj('POST', '/api/payments/deposits', sales1, { amount: 500, customer_name: 'คุณจอง', purpose: 'booking' });
  ok('Deposits: take a deposit posts a balanced JE (Dr 1000 / Cr 2210)', (dep.status === 200 || dep.status === 201) && /^DEP-/.test(dep.json.deposit_no ?? '') && /^JE-/.test(dep.json.journal_no ?? '') && near(dep.json.amount, 500), `${dep.status} ${JSON.stringify(dep.json).slice(0, 80)}`);
  const apply = await inj('POST', `/api/payments/deposits/${dep.json.deposit_no}/apply`, sales1, { amount: 200, sale_no: rcSale });
  ok('Deposits: apply recognises revenue (Dr 2210 / Cr 4000+2100); remaining 300', apply.json.remaining != null && near(apply.json.remaining, 300) && /^JE-/.test(apply.json.journal_no ?? ''), `applied=${apply.json.applied} remaining=${apply.json.remaining}`);
  const overApply = await inj('POST', `/api/payments/deposits/${dep.json.deposit_no}/apply`, sales1, { amount: 400 });
  ok('Deposits: over-apply rejected (400 OVER_APPLY)', overApply.status === 400 && overApply.json.error?.code === 'OVER_APPLY', `${overApply.status} ${overApply.json.error?.code}`);
  const refund = await inj('POST', `/api/payments/deposits/${dep.json.deposit_no}/refund`, sales1, {});
  ok('Deposits: refund the unused balance closes the deposit (Dr 2210 / Cr 1000)', (refund.status === 200 || refund.status === 201) && near(refund.json.refunded, 300) && refund.json.status === 'closed', `${refund.status} refunded=${refund.json.refunded} status=${refund.json.status}`);

  const ha = await inj('POST', '/api/payments/house-accounts', sales1, { name: 'บริษัท เครดิต จำกัด', credit_limit: 1000 });
  ok('House account: open with a credit limit', (ha.status === 200 || ha.status === 201) && /^HA-/.test(ha.json.account_no ?? '') && near(ha.json.credit_limit, 1000), `${ha.status} ${JSON.stringify(ha.json).slice(0, 80)}`);
  const charge1 = await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/charge`, sales1, { amount: 600, sale_no: rcSale });
  ok('House account: charge a credit sale (Dr 1100 AR / Cr 4000+2100); balance 600', (charge1.status === 200 || charge1.status === 201) && near(charge1.json.balance, 600) && /^JE-/.test(charge1.json.journal_no ?? ''), `bal=${charge1.json.balance}`);
  const overLimit = await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/charge`, sales1, { amount: 600 });
  ok('House account: charge over the credit limit rejected (400 CREDIT_LIMIT_EXCEEDED) — REST-12 control', overLimit.status === 400 && overLimit.json.error?.code === 'CREDIT_LIMIT_EXCEEDED', `${overLimit.status} ${overLimit.json.error?.code}`);
  const settle1 = await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/settle`, sales1, { amount: 600 });
  ok('House account: THB settlement pays down the balance to 0 (Dr 1000 / Cr 1100)', near(settle1.json.balance, 0) && near(settle1.json.fx_gain_loss, 0) && /^JE-/.test(settle1.json.journal_no ?? ''), `bal=${settle1.json.balance}`);
  await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/charge`, sales1, { amount: 340 });
  const fxSettle = await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/settle`, sales1, { amount: 340, currency: 'USD', fx_rate: 34, foreign_tendered: 10.5 });
  ok('House account: FX settlement books realised FX gain (10.5 USD × 34 = 357 vs 340 → +17 to 5410)', near(fxSettle.json.received_thb, 357) && near(fxSettle.json.fx_gain_loss, 17) && near(fxSettle.json.balance, 0), `recv=${fxSettle.json.received_thb} fx=${fxSettle.json.fx_gain_loss}`);
  const stmt = await inj('GET', `/api/payments/house-accounts/${ha.json.account_no}/statement`, sales1);
  ok('House account: statement reconciles entries to a zero balance', stmt.status === 200 && near(stmt.json.balance, 0) && (stmt.json.entries ?? []).length === 4 && near(stmt.json.available_credit, 1000), `bal=${stmt.json.balance} entries=${(stmt.json.entries ?? []).length}`);
  const overSettle = await inj('POST', `/api/payments/house-accounts/${ha.json.account_no}/settle`, sales1, { amount: 100 });
  ok('House account: settling more than owed rejected (400 OVER_SETTLE)', overSettle.status === 400 && overSettle.json.error?.code === 'OVER_SETTLE', `${overSettle.status} ${overSettle.json.error?.code}`);

  await inj('POST', '/api/payments/surcharges', sales1, { method: 'Card', pct: 3 });
  const quote = await inj('GET', '/api/payments/surcharges/quote?method=Card&amount=1000', sales1);
  ok('Card surcharge: quote computes 3% (1000 → 30, total 1030)', near(quote.json.surcharge, 30) && near(quote.json.total, 1030), `${JSON.stringify(quote.json)}`);
  const scCharge = await inj('POST', '/api/payments/surcharges/charge', sales1, { method: 'Card', amount: 1000, sale_no: rcSale });
  ok('Card surcharge: charge posts VATable income (Dr 1000 / Cr 4500+2100)', (scCharge.status === 200 || scCharge.status === 201) && near(scCharge.json.surcharge, 30) && near(scCharge.json.net, 28.04) && near(scCharge.json.vat, 1.96) && /^JE-/.test(scCharge.json.journal_no ?? ''), `${JSON.stringify(scCharge.json).slice(0, 90)}`);

  const t2ha = await inj('GET', '/api/payments/house-accounts', sales2);
  const t2dep = await inj('GET', '/api/payments/deposits', sales2);
  ok('Payments depth: deposits + house accounts are tenant-isolated (T2 sees none of T1’s)', (t2ha.json.accounts ?? []).every((a: any) => a.account_no !== ha.json.account_no) && (t2dep.json.deposits ?? []).every((d: any) => d.deposit_no !== dep.json.deposit_no), `T2 ha=${(t2ha.json.accounts ?? []).length} dep=${(t2dep.json.deposits ?? []).length}`);

  // ── security / RLS ──
  const t2tables = await inj('GET', '/api/restaurant/tables', sales2);
  const t1tables = await inj('GET', '/api/restaurant/tables', sales1);
  ok('RLS: cross-tenant table isolation (T2 not sees A1, T1 not sees B1)', (t2tables.json.tables ?? []).every((x: any) => x.table_no !== 'A1') && (t1tables.json.tables ?? []).every((x: any) => x.table_no !== 'B1'), `T2=${t2tables.json.tables?.length} T1=${t1tables.json.tables?.length}`);
  const forged = dinerTok.slice(0, 10) + (dinerTok[10] === 'A' ? 'B' : 'A') + dinerTok.slice(11); // flip one char
  const forgedRes = await inj('GET', `/api/qr/t/${forged}`, undefined);
  ok('Security: forged/tampered token → 401', forgedRes.status === 401, `${forgedRes.status}`);

  // ── service charge on the receipt (large-party dine-in) — REST-10 extension ──
  // Placed last so the fresh checkout's auto-enqueued receipt + drawer events never shift the hardcoded
  // job-id / event-count assertions above. Subtotal 1000, party 6 ≥ min 6, 10% → sc 100, VAT on 1100 = 77,
  // total 1177. The receipt must itemise the ค่าบริการ line and the tie-out must reconcile it.
  const scTbl = await inj('POST', '/api/restaurant/tables', sales1, { table_no: 'SC9', seats: 8, pos_x: 60, pos_y: 60 });
  const scOpen = await inj('POST', `/api/restaurant/tables/${scTbl.json.id}/open`, sales1, { party_size: 6 });
  const scOrd = await inj('POST', '/api/restaurant/orders', sales1, { table_id: scTbl.json.id, session_id: scOpen.json.session_id, guest_count: 6, items: [{ name: 'เซ็ตอาหารกลุ่ม', qty: 1, unit_price: 1000, station_code: 'hot' }] });
  await inj('POST', `/api/restaurant/orders/${scOrd.json.order_no}/bill`, sales1);
  const scCo = await inj('POST', `/api/restaurant/orders/${scOrd.json.order_no}/checkout`, sales1, { method: 'Cash', apply_pricing_rules: true, party_size: 6, service_charge_pct: 10, service_min_party: 6 });
  ok('Service charge: large-party checkout charges 10% (sc=100, total 1177)', near(scCo.json.service_charge, 100) && near(scCo.json.total, 1177), `sc=${scCo.json.service_charge} total=${scCo.json.total}`);
  const scData = await inj('GET', `/api/print/receipt/${scCo.json.sale_no}/data`, sales1);
  ok('Service charge: persisted on the sale + present in receipt data', near(scData.json.data?.service_charge, 100), `sc=${scData.json.data?.service_charge}`);
  const scHtml = await inj('GET', `/api/print/receipt/${scCo.json.sale_no}`, sales1);
  ok('Service charge: receipt slip itemises a ค่าบริการ line', scHtml.status === 200 && typeof scHtml.body === 'string' && scHtml.body.includes('ค่าบริการ'), `${scHtml.status}`);
  const scTie = await inj('GET', `/api/print/tie-out/${scCo.json.sale_no}`, sales1);
  ok('Service charge: receipt still ties out with the charge included (REST-10)', scTie.status === 200 && scTie.json.matched === true && near(scTie.json.service_charge, 100) && near(scTie.json.total, 1177), `matched=${scTie.json.matched} sc=${scTie.json.service_charge}`);
  const scLine = await inj('POST', `/api/print/receipt/${scCo.json.sale_no}/send`, sales1, { channel: 'line', to: 'Uffffffffffffffffffffffffffffffff' });
  ok('E-receipt: send via the LINE channel (mock provider when no token)', (scLine.status === 200 || scLine.status === 201) && scLine.json.channel === 'line' && scLine.json.status === 'sent', `${scLine.status} ${scLine.json.channel}/${scLine.json.status}`);

  // ── POS-5b: menu-engineering matrix (Kasavana–Smith star/plowhorse/puzzle/dog) ──
  // 4 costed items engineered one-per-quadrant + 1 uncosted, on an isolated past business day so the
  // harness's own checkouts (today) never shift the mix. Branch 1 carries the high-volume dishes and
  // branch 2 the slow ones, so ?branch_id= must re-derive N, the 70% threshold and the weighted-avg CM.
  const ME_DAY = '2026-05-05';
  await db.insert(s.menuItems).values([
    { tenantId: t1, sku: 'ME-A', name: 'ME กะเพราไก่', price: '200.00', cost: '40.00', active: true },     // CM 160 × 40 → Star
    { tenantId: t1, sku: 'ME-B', name: 'ME ข้าวผัดปู', price: '100.00', cost: '80.00', active: true },     // CM 20 × 40 → Plowhorse
    { tenantId: t1, sku: 'ME-C', name: 'ME สเต๊กพรีเมียม', price: '300.00', cost: '60.00', active: true }, // CM 240 × 5 → Puzzle
    { tenantId: t1, sku: 'ME-D', name: 'ME น้ำสมุนไพร', price: '90.00', cost: '70.00', active: true },     // CM 20 × 5 → Dog
    { tenantId: t1, sku: 'ME-X', name: 'ME เมนูไม่มีสูตร', price: '50.00', active: true },                 // no recipe/cost → listed, not classified
  ]);
  const [meS1] = await db.insert(s.custPosSales).values({ saleNo: 'SALE-ME5B-1', saleDate: ME_DAY, tenantId: t1, branchId: 1, status: 'Completed', subtotal: '12000', total: '12000' }).returning({ id: s.custPosSales.id });
  const [meS2] = await db.insert(s.custPosSales).values({ saleNo: 'SALE-ME5B-2', saleDate: ME_DAY, tenantId: t1, branchId: 2, status: 'Completed', subtotal: '2050', total: '2050' }).returning({ id: s.custPosSales.id });
  await db.insert(s.custPosItems).values([
    { saleId: meS1.id, itemId: 'ME-A', itemDescription: 'ME กะเพราไก่', qty: '40', unitPrice: '200.00', amount: '8000.00' },
    { saleId: meS1.id, itemId: 'ME-B', itemDescription: 'ME ข้าวผัดปู', qty: '40', unitPrice: '100.00', amount: '4000.00' },
    { saleId: meS2.id, itemId: 'ME-C', itemDescription: 'ME สเต๊กพรีเมียม', qty: '5', unitPrice: '300.00', amount: '1500.00' },
    { saleId: meS2.id, itemId: 'ME-D', itemDescription: 'ME น้ำสมุนไพร', qty: '5', unitPrice: '90.00', amount: '450.00' },
    { saleId: meS2.id, itemId: 'ME-X', itemDescription: 'ME เมนูไม่มีสูตร', qty: '2', unitPrice: '50.00', amount: '100.00' },
  ]);
  const me = await inj('GET', `/api/analytics/menu-engineering?from=${ME_DAY}&to=${ME_DAY}`, sales1);
  const meBy = Object.fromEntries((me.json.items ?? []).map((i: any) => [i.item_id, i]));
  ok('Menu engineering: 4 costed items, 90 units → exactly 1 Star + 1 Plowhorse + 1 Puzzle + 1 Dog (A/B/C/D)',
    me.status === 200 && me.json.summary?.items === 4 && me.json.summary?.units_sold === 90 &&
    meBy['ME-A']?.quadrant === 'Star' && meBy['ME-B']?.quadrant === 'Plowhorse' && meBy['ME-C']?.quadrant === 'Puzzle' && meBy['ME-D']?.quadrant === 'Dog',
    `${me.status} ${JSON.stringify({ A: meBy['ME-A']?.quadrant, B: meBy['ME-B']?.quadrant, C: meBy['ME-C']?.quadrant, D: meBy['ME-D']?.quadrant })}`);
  ok('Menu engineering: CM math exact — A margin 160 (200−40), contribution 6400; total contribution 8500; mix share A 44.44%',
    near(meBy['ME-A']?.unit_margin, 160) && near(meBy['ME-A']?.contribution, 6400) && near(me.json.summary?.total_contribution, 8500) && Math.abs(Number(meBy['ME-A']?.mix_share) - 0.4444) < 0.0002,
    JSON.stringify({ margin: meBy['ME-A']?.unit_margin, contrib: meBy['ME-A']?.contribution, share: meBy['ME-A']?.mix_share }));
  ok('Menu engineering: thresholds returned — popularity 0.175 (70% of 1/4) + weighted-average CM 94.44 (8500/90), not the unweighted mean 110',
    Math.abs(Number(me.json.thresholds?.popularity_share_threshold) - 0.175) < 0.0002 && near(me.json.thresholds?.avg_unit_margin, 94.44),
    JSON.stringify(me.json.thresholds));
  ok('Menu engineering: uncosted item (no recipe/cost) listed but excluded from classification',
    me.json.summary?.uncosted === 1 && (me.json.uncosted_items ?? []).some((u: any) => u.item_id === 'ME-X' && Number(u.qty) === 2) && !meBy['ME-X'],
    JSON.stringify(me.json.uncosted_items));
  const me2 = await inj('GET', `/api/analytics/menu-engineering?from=${ME_DAY}&to=${ME_DAY}&branch_id=2`, sales1);
  const me2By = Object.fromEntries((me2.json.items ?? []).map((i: any) => [i.item_id, i]));
  ok('Menu engineering: ?branch_id=2 re-scopes the mix — N=2 (thr 0.35, weighted ACM 130=1300/10): C flips Puzzle→Star, D→Plowhorse',
    me2.status === 200 && me2.json.branch_id === 2 && me2.json.summary?.items === 2 && me2.json.summary?.units_sold === 10 &&
    near(me2.json.thresholds?.popularity_share_threshold, 0.35) && near(me2.json.thresholds?.avg_unit_margin, 130) &&
    me2By['ME-C']?.quadrant === 'Star' && me2By['ME-D']?.quadrant === 'Plowhorse' && !me2By['ME-A'],
    `${me2.status} ${JSON.stringify({ n: me2.json.summary?.items, thr: me2.json.thresholds, C: me2By['ME-C']?.quadrant, D: me2By['ME-D']?.quadrant })}`);

  // ── PN-20: the restaurant sale is in the fiscal hash chain (RD tamper-evidence) ──
  // The restaurant path used to append NOTHING: dine-in / diner-QR / register sales — the bulk of a
  // restaurant's revenue — were absent from the chain the portal POS + refund/void paths already wrote.
  {
    const jrows = (await pg.query(`SELECT seq, doc_type, doc_no, prev_hash, hash FROM pos_journal WHERE doc_no='${co.json.sale_no}' AND doc_type='SALE'`)).rows as any[];
    ok('Fiscal chain: the dine-in sale appended a SALE row (doc_no = sale_no)', jrows.length === 1 && !!jrows[0].hash, JSON.stringify(jrows[0] ?? {}));
    const ver = await inj('GET', '/api/pos/journal/verify', sales1);
    ok('Fiscal chain: verify() ok after restaurant sales', ver.json?.ok === true, JSON.stringify(ver.json ?? {}).slice(0, 90));
    // tamper: mutate a payload → every later hash breaks; verify() names the first broken seq
    await pg.query(`UPDATE pos_journal SET payload = jsonb_set(payload, '{total}', '999999') WHERE doc_no='${co.json.sale_no}' AND doc_type='SALE'`);
    const bad = await inj('GET', '/api/pos/journal/verify', sales1);
    ok('Fiscal chain: a tampered payload is detected (ok=false + broken_at)', bad.json?.ok === false && Number(bad.json?.broken_at) > 0, JSON.stringify(bad.json ?? {}).slice(0, 90));
  }

  await app.close();
  await pg.close();

  console.log('\n── Phase 11 Restaurant POS (dine-in + KDS + ผังโต๊ะ + QR self-order + buffet + QR pay) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} restaurant checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} restaurant checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
