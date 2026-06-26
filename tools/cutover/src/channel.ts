/**
 * POS Tier 2 #10 — Online ordering + Delivery + Kiosk (สั่งออนไลน์ + เดลิเวอรี + คีออสก์) over PGlite:
 * public takeaway/delivery ordering (create → PromptPay pay → confirm), delivery-fee GL (4100),
 * fulfillment state machine, kiosk checkout, idempotent 3rd-party ingest, RLS.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover channel
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chan-secret';
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

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านอาหารหนึ่ง', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pw3'), role: 'Warehouse', tenantId: t1 }, // no 'pos'
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 })); // long HMAC tokens in path
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
  const wh1 = await login('wh1', 'pw3');
  const admin = await login('admin', 'admin123');
  const item = (price: number) => ({ name: 'ผัดไทย', qty: 1, unit_price: price, station_code: 'hot' });
  const glOf = async (src: string, refNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${src}' AND je.source_ref='${refNo}'`)).rows as any[];
  const leg = (gl: any[], c: string, side: string) => Number(gl.filter((l) => l.account_code === c).reduce((a, l) => a + Number(l[side] || 0), 0));
  const bal = (gl: any[]) => near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0));

  // ── 1. COA 4100 ──
  const accts = (await inj('GET', '/api/ledger/accounts', admin)).json.accounts ?? [];
  ok('COA: 4100 Delivery Income seeded (Revenue)', accts.some((a: any) => a.code === '4100' && a.type === 'Revenue'));

  // ── 2-4. public takeaway: create → pay → confirm ──
  const c2 = await inj('POST', '/api/order/T1', undefined, { fulfillment_type: 'takeaway', items: [item(100)] });
  const tok = c2.json.token as string;
  ok('Public takeaway create → DIN- + token + total 107', /^DIN-/.test(c2.json.order_no ?? '') && !!tok && near(c2.json.total, 107), JSON.stringify({ no: c2.json.order_no, total: c2.json.total }));
  const st = await inj('GET', `/api/order/t/${tok}`, undefined);
  const tableNull = (await pg.query(`SELECT table_id, fulfillment_status, channel FROM dine_in_orders WHERE order_no='${c2.json.order_no}'`)).rows as any[];
  ok('Status: fulfillment received, channel web, no table', st.json.fulfillment_status === 'received' && tableNull[0].table_id === null && tableNull[0].channel === 'web', JSON.stringify(tableNull[0]));
  const pay2 = await inj('POST', `/api/order/t/${tok}/pay`, undefined, {});
  ok('Public pay → PromptPay Pending', pay2.json.status === 'Pending' && /^PAY-/.test(pay2.json.payment_no ?? '') && near(pay2.json.total, 107), JSON.stringify(pay2.json).slice(0, 90));
  const cf2 = await inj('POST', `/api/order/t/${tok}/confirm`, undefined, { payment_no: pay2.json.payment_no });
  const gl2 = await glOf('POS', cf2.json.sale_no);
  ok('Public confirm → food GL Dr1000=107, Cr4000=100, Cr2100=7, balanced', cf2.json.paid === true && near(leg(gl2, '1000', 'debit'), 107) && near(leg(gl2, '4000', 'credit'), 100) && near(leg(gl2, '2100', 'credit'), 7) && bal(gl2), JSON.stringify(gl2.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));

  // ── 5-6. delivery order + delivery-fee GL ──
  const c5 = await inj('POST', '/api/order/T1', undefined, { fulfillment_type: 'delivery', items: [item(100)], delivery_fee: 50, delivery: { contact_name: 'สมชาย', contact_phone: '0810000001', address_line: '123 ถนนสุขุมวิท' } });
  const tok5 = c5.json.token as string;
  const ddRow = (await pg.query(`SELECT count(*)::int n FROM order_delivery_details WHERE order_id=(SELECT id FROM dine_in_orders WHERE order_no='${c5.json.order_no}')`)).rows as any[];
  ok('Delivery order: total = food 107 + fee 50 = 157, delivery_details row', near(c5.json.total, 157) && near(c5.json.delivery_fee, 50) && ddRow[0].n === 1, JSON.stringify({ total: c5.json.total, dd: ddRow[0].n }));
  const pay5 = await inj('POST', `/api/order/t/${tok5}/pay`, undefined, {});
  ok('Delivery pay: one PromptPay tender covers food + fee (157)', near(pay5.json.total, 157), `total=${pay5.json.total}`);
  const cf5 = await inj('POST', `/api/order/t/${tok5}/confirm`, undefined, { payment_no: pay5.json.payment_no });
  const glD = await glOf('POS-DELIV', cf5.json.sale_no);
  const glF = await glOf('POS', cf5.json.sale_no);
  ok('Delivery GL: Dr1000=50, Cr4100=46.73, Cr2100=3.27 (incl 7%), balanced; 4100≠4000', near(leg(glD, '1000', 'debit'), 50) && near(leg(glD, '4100', 'credit'), 46.73) && near(leg(glD, '2100', 'credit'), 3.27) && bal(glD) && near(leg(glF, '4000', 'credit'), 100), JSON.stringify(glD.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));

  // ── 7. fulfillment state machine ──
  const c7 = await inj('POST', '/api/order/T1', undefined, { fulfillment_type: 'delivery', items: [item(80)], delivery_fee: 20, delivery: { address_line: 'x' } });
  const o7 = c7.json.order_no;
  const steps = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed'];
  let allOk = true; for (const a of steps) { const r = await inj('PATCH', `/api/restaurant/orders/${o7}/fulfillment`, sales1, { action: a }); if (r.status !== 200) allOk = false; }
  const c7b = await inj('POST', '/api/order/T1', undefined, { fulfillment_type: 'takeaway', items: [item(80)] });
  const jump = await inj('PATCH', `/api/restaurant/orders/${c7b.json.order_no}/fulfillment`, sales1, { action: 'completed' });
  const stamps = (await pg.query(`SELECT dispatched_at, delivered_at FROM order_delivery_details WHERE order_id=(SELECT id FROM dine_in_orders WHERE order_no='${o7}')`)).rows as any[];
  ok('Fulfillment machine: full path 200; illegal jump → 400; dispatched/delivered stamped', allOk && jump.status === 400 && jump.json.error?.code === 'BAD_TRANSITION' && stamps[0].dispatched_at && stamps[0].delivered_at, `path=${allOk} jump=${jump.status} stamps=${!!stamps[0].dispatched_at}/${!!stamps[0].delivered_at}`);

  // ── 8. kiosk checkout (tender at create) ──
  await inj('POST', '/api/payments/till/open', sales1, { opening_float: 500 });
  const k8 = await inj('POST', '/api/restaurant/kiosk/checkout', sales1, { fulfillment_type: 'takeaway', items: [item(100)], method: 'Cash' });
  const glK = await glOf('POS', k8.json.sale_no);
  ok('Kiosk checkout → sale_no + POS GL Dr1000=107', /^SALE-/.test(k8.json.sale_no ?? '') && near(leg(glK, '1000', 'debit'), 107) && bal(glK), JSON.stringify({ sale: k8.json.sale_no }));
  // B4: kiosk takeaway returns a public track token; the customer can follow the order with no login.
  const kTrack = k8.json.track_token ? await inj('GET', `/api/order/t/${k8.json.track_token}`, undefined) : { json: {} };
  ok('Kiosk: returns track_url + public tracker resolves the order (received)', typeof k8.json.track_url === 'string' && k8.json.track_url.startsWith('/track/') && kTrack.json.order_no === k8.json.order_no && kTrack.json.fulfillment_status === 'received', JSON.stringify({ url: k8.json.track_url, st: kTrack.json.fulfillment_status }));

  // ── 9. third-party ingest idempotent ──
  const wbody = { store_ref: 'T1', ext_order_id: 'G-1', ext_event_id: 'E-1', fulfillment_type: 'delivery', items: [{ name: 'ข้าวมันไก่', qty: 2, unit_price: 60 }], customer: { name: 'ลูกค้า Grab', phone: '0899999999', address: 'คอนโด ABC' } };
  const w1 = await inj('POST', '/api/channel/webhook/grab', undefined, wbody);
  const w2 = await inj('POST', '/api/channel/webhook/grab', undefined, wbody); // replay
  const grabRows = (await pg.query(`SELECT count(*)::int n FROM dine_in_orders WHERE ext_source='grab' AND ext_order_id='G-1'`)).rows as any[];
  ok('3rd-party ingest idempotent: processed then duplicate, same order_no, exactly 1 order', w1.json.status === 'processed' && /^DIN-/.test(w1.json.order_no ?? '') && w2.json.status === 'duplicate' && w2.json.order_no === w1.json.order_no && grabRows[0].n === 1, JSON.stringify({ s1: w1.json.status, s2: w2.json.status, n: grabRows[0].n }));

  // ── 10. permission: Warehouse (no pos) cannot kiosk-checkout ──
  const noPerm = await inj('POST', '/api/restaurant/kiosk/checkout', wh1, { items: [item(100)] });
  ok('Permission: Warehouse (no pos) kiosk checkout → 403', noPerm.status === 403, `${noPerm.status}`);

  // ── 11. RLS: T2 ingest invisible to T1 fulfillment board ──
  await inj('POST', '/api/channel/webhook/lineman', undefined, { store_ref: 'T2', ext_order_id: 'L-9', ext_event_id: 'E-9', items: [{ name: 'ก๋วยเตี๋ยว', qty: 1, unit_price: 50 }] });
  const boardT1 = await inj('GET', '/api/restaurant/fulfillment/board', sales1);
  const boardT2 = await inj('GET', '/api/restaurant/fulfillment/board', sales2);
  const t1HasL9 = (boardT1.json.orders ?? []).some((o: any) => o.channel === 'lineman');
  const t2HasL9 = (boardT2.json.orders ?? []).some((o: any) => o.channel === 'lineman');
  ok('RLS: T2 lineman order on T2 board only, invisible to T1', !t1HasL9 && t2HasL9, `t1=${t1HasL9} t2=${t2HasL9}`);

  // ── 12. pay() idempotency — repeated pay returns the SAME tender (no orphan tenders / sale-nos) ──
  const ci = await inj('POST', '/api/order/T1', undefined, { fulfillment_type: 'takeaway', items: [item(90)] });
  const p1 = await inj('POST', `/api/order/t/${ci.json.token}/pay`, undefined, {});
  const p2 = await inj('POST', `/api/order/t/${ci.json.token}/pay`, undefined, {});
  const pendCnt = (await pg.query(`SELECT count(*)::int n FROM payments WHERE sale_no=(SELECT sale_no FROM dine_in_orders WHERE order_no='${ci.json.order_no}') AND status='Pending'`)).rows as any[];
  ok('pay() idempotent: repeated pay → same payment_no, exactly 1 Pending tender', p1.json.payment_no === p2.json.payment_no && pendCnt[0].n === 1, `p1=${p1.json.payment_no} p2=${p2.json.payment_no} pend=${pendCnt[0].n}`);

  // ── 13. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after all channel activity', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  console.log('\n── POS Tier 2 #10 Online ordering + Delivery + Kiosk (สั่งออนไลน์ + เดลิเวอรี + คีออสก์) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} channel checks failed` : `\n✅ All ${checks.length} channel checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
