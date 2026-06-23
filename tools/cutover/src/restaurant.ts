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

  // ── security / RLS ──
  const t2tables = await inj('GET', '/api/restaurant/tables', sales2);
  const t1tables = await inj('GET', '/api/restaurant/tables', sales1);
  ok('RLS: cross-tenant table isolation (T2 not sees A1, T1 not sees B1)', (t2tables.json.tables ?? []).every((x: any) => x.table_no !== 'A1') && (t1tables.json.tables ?? []).every((x: any) => x.table_no !== 'B1'), `T2=${t2tables.json.tables?.length} T1=${t1tables.json.tables?.length}`);
  const forged = dinerTok.slice(0, 10) + (dinerTok[10] === 'A' ? 'B' : 'A') + dinerTok.slice(11); // flip one char
  const forgedRes = await inj('GET', `/api/qr/t/${forged}`, undefined);
  ok('Security: forged/tampered token → 401', forgedRes.status === 401, `${forgedRes.status}`);

  await app.close();
  await pg.close();

  console.log('\n── Phase 11 Restaurant POS (dine-in + KDS + ผังโต๊ะ + QR self-order + buffet + QR pay) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} restaurant checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} restaurant checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
