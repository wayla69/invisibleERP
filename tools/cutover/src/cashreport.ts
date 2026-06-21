/**
 * POS Tier 1 #3 — Cash management + X/Z shift report (จัดการเงินสด + รายงานปิดกะ) over PGlite:
 * paid-in/out/drop drawer movements (GL for in/out, drawer-only drop), expected-cash reconciliation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cashreport
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cash-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', taxId: '0105556000017', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
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
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const sales1 = await login('sales1', 'pw1');
  const admin = await login('admin', 'admin123');

  // open till float 1000
  const till = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 1000 });
  const tillId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, till.json.session_no)))[0].id);

  // 2 cash sales via dine-in checkout (now links the tender to the open till) — each total 107
  let tn = 0;
  const cashSale = async () => {
    const t = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `C${++tn}`, seats: 2 });
    const o = await inj('POST', '/api/restaurant/orders', sales1, { table_id: t.json.id, items: [{ name: 'กะเพรา', qty: 1, unit_price: 100, station_code: 'hot' }] });
    return inj('POST', `/api/restaurant/orders/${o.json.order_no}/checkout`, sales1, { method: 'Cash' });
  };
  const sA = await cashSale(); // 107
  await cashSale();            // 107  → cash sales 214

  // paid-out 200 (petty cash) → GL Dr5100/Cr1000
  const po = await inj('POST', `/api/payments/till/${tillId}/cash-movement`, sales1, { type: 'paid_out', amount: 200, reason: 'ค่าน้ำแข็ง' });
  ok('CashMov: paid_out posts CASHMOV- + JE-', /^CASHMOV-/.test(po.json.movement_no ?? '') && /^JE-/.test(po.json.journal_no ?? ''), JSON.stringify(po.json).slice(0, 80));

  // refund one cash sale (drawer cash out 107)
  await inj('POST', '/api/payments/refunds', sales1, { payment_no: sA.json.payment_no, amount: sA.json.total, reason: 'คืนเงิน' });

  // X-report (mid-shift): expected = 1000 + 214 - 200 - 107 = 907
  const x = await inj('GET', `/api/payments/till/${tillId}/x-report`, sales1);
  ok('X-report: non-resetting, Open, counted=null', x.json.report === 'X' && x.json.status === 'Open' && x.json.counted_cash === null, JSON.stringify(x.json).slice(0, 90));
  ok('X-report: expected = float+cashSales+paidIn-paidOut-drops-cashRefunds = 907', near(x.json.expected_cash, 907), `exp=${x.json.expected_cash}`);
  ok('X-report: by-method Cash count 2', (x.json.by_method ?? []).some((m: any) => m.method === 'Cash' && m.count === 2), JSON.stringify(x.json.by_method));
  ok('X-report: paid_out 200 + cash_refunds 107 aggregated', near(x.json.paid_out, 200) && near(x.json.cash_refunds, 107), `po=${x.json.paid_out} cr=${x.json.cash_refunds}`);
  ok('X-report: txn_count = 2', x.json.txn_count === 2, `n=${x.json.txn_count}`);

  // Z-report on close: counted 900 → variance -7
  const z = await inj('POST', '/api/payments/till/close', sales1, { session_no: till.json.session_no, closing_count: 900, denominations: { '1000': 0, '500': 1, '100': 4 } });
  ok('Z-report close: expected 907, variance -7', near(z.json.expected_cash, 907) && near(z.json.variance, -7), JSON.stringify(z.json).slice(0, 110));
  const zr = await inj('GET', `/api/payments/till/${tillId}/z-report`, sales1);
  ok('Z-report GET: Closed + counted 900 + variance -7 + denominations', zr.json.report === 'Z' && zr.json.status === 'Closed' && near(zr.json.counted_cash, 900) && near(zr.json.variance, -7) && zr.json.denominations?.['100'] === 4, JSON.stringify(zr.json).slice(0, 110));

  // guard: cash-movement on a closed till → 400
  const closedMv = await inj('POST', `/api/payments/till/${tillId}/cash-movement`, sales1, { type: 'drop', amount: 50 });
  ok('CashMov: rejected on closed till (400 TILL_CLOSED)', closedMv.status === 400 && closedMv.json.error?.code === 'TILL_CLOSED', `${closedMv.status} ${closedMv.json.error?.code}`);

  // drop does NOT post GL
  const till2 = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 500 });
  const t2id = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, till2.json.session_no)))[0].id);
  const drop = await inj('POST', `/api/payments/till/${t2id}/cash-movement`, sales1, { type: 'drop', amount: 300, reason: 'ฝากเซฟ' });
  ok('CashMov: drop is drawer-only (no journal_no)', drop.json.journal_no == null && /^CASHMOV-/.test(drop.json.movement_no ?? ''), JSON.stringify(drop.json).slice(0, 70));

  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('GL: trial balance balanced after cash movements', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 70));

  // ── Finding #1: cross-till refund attribution. A cash sale rung on till A (then CLOSED) and refunded
  //    while a different till B is open must reduce B's drawer (cash physically leaves B), NOT the
  //    already-closed A. (Single-connection PGlite can't reproduce the concurrent shifts, so we assert
  //    the observable attribution: which till the refund's cash is debited from.) ──
  const tillA = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 1000 });
  const tillAId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, tillA.json.session_no)))[0].id);
  const saleX = await cashSale(); // 107 cash, tender linked to till A (most-recent open till for T1)
  await inj('POST', '/api/payments/till/close', sales1, { session_no: tillA.json.session_no, closing_count: 1107 }); // A balances (float 1000 + cash 107)
  const tillB = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 500 });
  const tillBId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, tillB.json.session_no)))[0].id);
  const refX = await inj('POST', '/api/payments/refunds', sales1, { payment_no: saleX.json.payment_no, amount: saleX.json.total, reason: 'คืนข้ามกะ' });
  const rt = (await pg.query(`SELECT till_session_id FROM payment_refunds WHERE refund_no='${refX.json.refund_no}'`)).rows as any[];
  ok('Refund-till: refund booked against the OPEN till B (not sale A)', Number(rt[0]?.till_session_id) === tillBId, `${JSON.stringify(rt)} B=${tillBId}`);
  const xB = await inj('GET', `/api/payments/till/${tillBId}/x-report`, sales1);
  ok('Refund-till: till B drawer reduced by refund (cash_refunds 107, expected 500−107=393)', near(xB.json.cash_refunds, 107) && near(xB.json.expected_cash, 393), `cr=${xB.json.cash_refunds} exp=${xB.json.expected_cash}`);
  const zA = await inj('GET', `/api/payments/till/${tillAId}/z-report`, sales1);
  ok('Refund-till: closed till A unaffected (cash_refunds 0, expected stays 1107 — no phantom variance)', near(zA.json.cash_refunds, 0) && near(zA.json.expected_cash, 1107), `cr=${zA.json.cash_refunds} exp=${zA.json.expected_cash}`);

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 #3 Cash management + X/Z report (จัดการเงินสด + ปิดกะ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} cash-report checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} cash-report checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
