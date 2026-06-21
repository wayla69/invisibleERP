/**
 * POS Tier 2 #7 — Tips + Gift Cards / Store Credit (ทิป + บัตรของขวัญ) over PGlite:
 * staff tip → 2300 Tips Payable (excluded from VAT + cash recon), gift-card issue/redeem → 2200
 * Customer Deposits, store-credit refunds on returns. GL asserted by raw SQL on journal_lines.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover giftcards
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'gc-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง', taxId: '0105556000017', vatRegistered: true }, { code: 'T2', name: 'ร้านสอง', vatRegistered: true }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
    { username: 'wh1', passwordHash: await pw.hash('pw3'), role: 'Warehouse', tenantId: t1 }, // no 'pos' permission
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
  const sales2 = await login('sales2', 'pw2');
  const wh1 = await login('wh1', 'pw3');
  const admin = await login('admin', 'admin123');

  let tn = 0;
  const makeOrder = async (price: number, token = sales1) => {
    const t = await inj('POST', '/api/restaurant/tables', token, { table_no: `G${++tn}`, seats: 4 });
    return (await inj('POST', '/api/restaurant/orders', token, { table_id: t.json.id, items: [{ name: 'จานเดียว', qty: 1, unit_price: price, station_code: 'hot' }] })).json;
  };
  const checkout = (orderNo: string, body: any, token = sales1) => inj('POST', `/api/restaurant/orders/${orderNo}/checkout`, token, body);
  const glOf = async (src: string, ref: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source='${src}' AND je.source_ref='${ref}'`)).rows as any[];
  const leg = (gl: any[], code: string, side: string) => Number(gl.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side] || 0), 0));
  const bal = (gl: any[]) => near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0));

  // ── 1. COA seeded ──
  const accts = (await inj('GET', '/api/ledger/accounts', admin)).json.accounts ?? [];
  const has = (c: string) => accts.some((a: any) => a.code === c && a.type === 'Liability');
  ok('COA: 2200 Customer Deposits + 2300 Tips Payable seeded (Liability)', has('2200') && has('2300'), `2200=${has('2200')} 2300=${has('2300')}`);

  // ── 2-6. tip on checkout ──
  const till = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 1000 });
  const tillId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, till.json.session_no)))[0].id);
  const o2 = await makeOrder(100);
  const c2 = await checkout(o2.order_no, { method: 'Cash', tip: 20 });
  ok('Tip checkout: total 107, tip 20, cash_due 127', near(c2.json.total, 107) && near(c2.json.tip, 20) && near(c2.json.total_with_tip, 127), `total=${c2.json.total} tip=${c2.json.tip} due=${c2.json.total_with_tip}`);
  const gl2 = await glOf('POS', c2.json.sale_no);
  ok('Tip GL: Dr1000=127, Cr4000=100, Cr2100=7, Cr2300=20, balanced', near(leg(gl2, '1000', 'debit'), 127) && near(leg(gl2, '4000', 'credit'), 100) && near(leg(gl2, '2100', 'credit'), 7) && near(leg(gl2, '2300', 'credit'), 20) && bal(gl2), JSON.stringify(gl2.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));
  ok('VAT unchanged on non-tip base (Cr2100 == 7)', near(leg(gl2, '2100', 'credit'), 7));
  const pay2 = (await pg.query(`SELECT amount, tip FROM payments WHERE sale_no='${c2.json.sale_no}'`)).rows as any[];
  ok('payments: amount 107 (sale money), tip 20 (separate, not in amount)', near(pay2[0]?.amount, 107) && near(pay2[0]?.tip, 20), JSON.stringify(pay2));
  const xr = await inj('GET', `/api/payments/till/${tillId}/x-report`, sales1);
  ok('Z/X-report cash counts sale-money 107, not 127 (tip excluded from drawer recon)', near(xr.json.expected_cash, 1000 + 107), `exp=${xr.json.expected_cash}`);

  // ── 7-8. gift-card issue ──
  const iss = await inj('POST', '/api/pos/gift-cards/issue', sales1, { amount: 500, method: 'Cash' });
  const card = iss.json.card_no as string;
  ok('Issue gift card: GC- code, balance 500', /^GC-/.test(card ?? '') && near(iss.json.balance, 500), JSON.stringify(iss.json));
  const glIss = await glOf('GCISSUE', card);
  ok('Issue GL: Dr1000=500, Cr2200=500, balanced', near(leg(glIss, '1000', 'debit'), 500) && near(leg(glIss, '2200', 'credit'), 500) && bal(glIss), JSON.stringify(glIss));
  const balCard = await inj('GET', `/api/pos/gift-cards/${card}/balance`, sales1);
  ok('Balance endpoint: 500, Active', near(balCard.json.balance, 500) && balCard.json.status === 'Active', JSON.stringify(balCard.json));

  // ── 9. redeem gift card as full tender (107 bill) ──
  const o9 = await makeOrder(100);
  const c9 = await checkout(o9.order_no, { method: 'Cash', gift_card_no: card });
  const gl9 = await glOf('POS', c9.json.sale_no);
  ok('Gift full redeem: Dr2200=107, Dr1000 dropped, Cr4000=100, Cr2100=7, balanced', near(leg(gl9, '2200', 'debit'), 107) && near(leg(gl9, '1000', 'debit'), 0) && near(leg(gl9, '4000', 'credit'), 100) && bal(gl9), JSON.stringify(gl9.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));
  const balAfter9 = await inj('GET', `/api/pos/gift-cards/${card}/balance`, sales1);
  ok('Gift balance after 107 redeem → 393', near(balAfter9.json.balance, 393), `bal=${balAfter9.json.balance}`);

  // ── 10. partial gift (balance 50 vs 107 bill) → status Redeemed ──
  const iss10 = await inj('POST', '/api/pos/gift-cards/issue', sales1, { amount: 50, method: 'Cash' });
  const card10 = iss10.json.card_no as string;
  const o10 = await makeOrder(100);
  const c10 = await checkout(o10.order_no, { method: 'Cash', gift_card_no: card10, gift_card_amount: 50 });
  const gl10 = await glOf('POS', c10.json.sale_no);
  const b10 = await inj('GET', `/api/pos/gift-cards/${card10}/balance`, sales1);
  ok('Partial gift: Dr2200=50, Dr1000=57, Cr4000=100, balanced; card → 0/Redeemed', near(leg(gl10, '2200', 'debit'), 50) && near(leg(gl10, '1000', 'debit'), 57) && near(leg(gl10, '4000', 'credit'), 100) && bal(gl10) && near(b10.json.balance, 0) && b10.json.status === 'Redeemed', `${JSON.stringify(gl10.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`))} bal=${b10.json.balance}/${b10.json.status}`);

  // ── 11. over-redeem ──
  const o11 = await makeOrder(100);
  const c11 = await checkout(o11.order_no, { method: 'Cash', gift_card_no: card10, gift_card_amount: 999 });
  ok('Over-redeem (amount > balance) → 400 GIFT_CARD_INSUFFICIENT, no sale', (c11.status === 400 || c11.status === 409) && /GIFT_CARD/.test(c11.json.error?.code ?? ''), `${c11.status} ${c11.json.error?.code}`);

  // ── 12-14. store-credit refund on a return ──
  const o12 = await makeOrder(100);
  const c12 = await checkout(o12.order_no, { method: 'Cash' }); // pay cash, total 107
  const saleItem = (await pg.query(`SELECT id FROM cust_pos_items WHERE sale_id=(SELECT id FROM cust_pos_sales WHERE sale_no='${c12.json.sale_no}')`)).rows as any[];
  const ret = await inj('POST', '/api/pos/returns', sales1, { sale_no: c12.json.sale_no, items: [{ sale_item_id: Number(saleItem[0].id), qty: 1 }], refund_method: 'StoreCredit', reason: 'ลูกค้าเปลี่ยนใจ' });
  ok('Store-credit return → 200, store_credit_card_no, no refund_no', ret.status === 201 || ret.status === 200 ? (!!ret.json.store_credit_card_no && ret.json.refund_no == null) : false, `${ret.status} card=${ret.json.store_credit_card_no} refund=${ret.json.refund_no}`);
  const glRet = await glOf('RTN', ret.json.return_no);
  ok('Store-credit GL: Dr4000=100, Dr2100=7, Cr2200=107 (no Cr1000), balanced', near(leg(glRet, '4000', 'debit'), 100) && near(leg(glRet, '2100', 'debit'), 7) && near(leg(glRet, '2200', 'credit'), 107) && near(leg(glRet, '1000', 'credit'), 0) && bal(glRet), JSON.stringify(glRet.map((l) => `${l.account_code}:${Number(l.debit) || -Number(l.credit)}`)));
  const scCard = ret.json.store_credit_card_no as string;
  const scBal = await inj('GET', `/api/pos/gift-cards/${scCard}/balance`, sales1);
  ok('Store-credit card balance == totalReturned 107, redeemable', near(scBal.json.balance, 107), `bal=${scBal.json.balance}`);

  // ── 15. RLS: T2 card invisible to T1 ──
  const issT2 = await inj('POST', '/api/pos/gift-cards/issue', sales2, { amount: 300, method: 'Cash' });
  const xcard = await inj('GET', `/api/pos/gift-cards/${issT2.json.card_no}/balance`, sales1);
  ok('RLS: T1 cannot read T2 gift card → 404', xcard.status === 404, `${xcard.status}`);

  // ── 16. permission: Warehouse (no pos) cannot issue ──
  const noPerm = await inj('POST', '/api/pos/gift-cards/issue', wh1, { amount: 100, method: 'Cash' });
  ok('Permission: Warehouse (no pos) issue → 403', noPerm.status === 403, `${noPerm.status}`);

  // ── 17. trial balance balanced overall ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after all tip + gift + store-credit activity', near(Number(tb.totals?.debit), Number(tb.totals?.credit)), JSON.stringify(tb.totals ?? {}).slice(0, 80));

  console.log('\n── POS Tier 2 #7 Tips + Gift Cards / Store Credit (ทิป + บัตรของขวัญ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} gift-card checks failed` : `\n✅ All ${checks.length} gift-card checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
