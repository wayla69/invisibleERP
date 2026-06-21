/**
 * POS Tier 1 #4 — Discounts / promotions at checkout (ส่วนลด/โปรโมชันที่จุดขาย) over PGlite:
 * line/order/percent discounts, promo-code engine + audit, VAT on the discounted base, guard rails.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover pos-discount
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'disc-secret';
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
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 }, // T2 shop staff
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
  const admin = await login('admin', 'admin123');

  let tn = 0;
  const makeOrderAs = async (token: string, items: any[]) => {
    const t = await inj('POST', '/api/restaurant/tables', token, { table_no: `D${++tn}`, seats: 4 });
    return (await inj('POST', '/api/restaurant/orders', token, { table_id: t.json.id, items })).json;
  };
  const makeOrder = (items: any[]) => makeOrderAs(sales1, items);
  const checkout = (orderNo: string, body: any) => inj('POST', `/api/restaurant/orders/${orderNo}/checkout`, sales1, body);
  const one = (price: number) => [{ name: 'จานเดียว', qty: 1, unit_price: price, station_code: 'hot' }];

  // 1. line 10% off → subtotal 90, total 96.30
  const o1 = await makeOrder(one(100));
  const c1 = await checkout(o1.order_no, { line_discounts: { [String(o1.items[0].item_id)]: { discount_pct: 10 } } });
  ok('Line 10% off: subtotal 90, total 96.30', near(c1.json.subtotal, 90) && near(c1.json.total, 96.30), JSON.stringify(c1.json).slice(0, 90));
  const dp = (await pg.query(`SELECT discount_pct FROM cust_pos_items WHERE sale_id=(SELECT id FROM cust_pos_sales WHERE sale_no='${c1.json.sale_no}')`)).rows as any[];
  ok('Line discount stored on item (discount_pct=10)', near(dp[0]?.discount_pct, 10), JSON.stringify(dp));

  // 2. line fixed 15 off → subtotal 85, total 90.95
  const o2 = await makeOrder(one(100));
  const c2 = await checkout(o2.order_no, { line_discounts: { [String(o2.items[0].item_id)]: { discount_amt: 15 } } });
  ok('Line ฿15 off: subtotal 85, total 90.95', near(c2.json.subtotal, 85) && near(c2.json.total, 90.95), JSON.stringify(c2.json).slice(0, 80));

  // 3. order fixed 50 off (subtotal 170) → discount 50, total 128.40
  const o3 = await makeOrder([{ name: 'a', qty: 1, unit_price: 120, station_code: 'hot' }, { name: 'b', qty: 1, unit_price: 50, station_code: 'hot' }]);
  const c3 = await checkout(o3.order_no, { discount: 50 });
  ok('Order ฿50 off: discount 50, total 128.40', near(c3.json.discount, 50) && near(c3.json.total, 128.40), JSON.stringify(c3.json).slice(0, 80));

  // 4. order percent 10 (subtotal 200) → discount 20, total 192.60
  const o4 = await makeOrder(one(200));
  const c4 = await checkout(o4.order_no, { discount_pct: 10 });
  ok('Order 10% off: discount 20, total 192.60', near(c4.json.discount, 20) && near(c4.json.total, 192.60), JSON.stringify(c4.json).slice(0, 80));

  // 5 + 6. VAT on discounted base + GL balanced
  const gl = (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${c4.json.sale_no}'`)).rows as any[];
  const leg = (code: string, side: string) => Number(gl.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side] || 0), 0));
  ok('GL: VAT on discounted base (Cr4000=180, Cr2100=12.60, Dr1000=192.60)', near(leg('4000', 'credit'), 180) && near(leg('2100', 'credit'), 12.60) && near(leg('1000', 'debit'), 192.60), JSON.stringify(gl));
  ok('GL: balanced (Σdebit=Σcredit)', near(gl.reduce((a, l) => a + Number(l.debit || 0), 0), gl.reduce((a, l) => a + Number(l.credit || 0), 0)));

  // 7 + 8. promo code Percent — created by the T1 SHOP (sales1), so the promo is owned by T1 (tenant-scoped).
  const promo = await inj('POST', '/api/promotions', sales1, { promo_name: 'สงกรานต์10', promo_type: 'Percent', discount_pct: 10, min_amount: 100 });
  const code = promo.json.promo_id;
  const promoRow = (await pg.query(`SELECT tenant_id FROM promotions WHERE promo_id='${code}'`)).rows as any[];
  ok('Promo created by shop is tenant-scoped (tenant_id=T1)', Number(promoRow[0]?.tenant_id) === t1, JSON.stringify(promoRow));
  const o7 = await makeOrder(one(200));
  const c7 = await checkout(o7.order_no, { promo_code: code });
  ok('Promo Percent applied: code echoed, total 192.60', c7.json.promo_code === code && near(c7.json.total, 192.60), `${c7.status} ${JSON.stringify(c7.json).slice(0, 90)}`);
  const red = (await pg.query(`SELECT discount_amount, tenant_id FROM promo_redemptions WHERE sale_no='${c7.json.sale_no}'`)).rows as any[];
  const uc = (await pg.query(`SELECT used_count FROM promotions WHERE promo_id='${code}'`)).rows as any[];
  ok('Promo audited: redemption 20 + tenant T1 + used_count 1', near(red[0]?.discount_amount, 20) && Number(red[0]?.tenant_id) === t1 && Number(uc[0]?.used_count) === 1, JSON.stringify(red) + JSON.stringify(uc));

  // Finding #2: promotions are tenant-scoped — a T1-owned promo is invisible to T2. sales2 (T2) redeeming
  // T1's code must 400 PROMO_NOT_FOUND (cross-tenant lookup blocked), and T1's used_count must NOT move.
  const o8b = await makeOrderAs(sales2, one(200));
  const c8b = await inj('POST', `/api/restaurant/orders/${o8b.order_no}/checkout`, sales2, { promo_code: code });
  ok('Promo tenant-scoped: T2 cannot use T1 promo → 400 PROMO_NOT_FOUND', c8b.status === 400 && c8b.json.error?.code === 'PROMO_NOT_FOUND', `${c8b.status} ${c8b.json.error?.code}`);
  const uc2 = (await pg.query(`SELECT used_count FROM promotions WHERE promo_id='${code}'`)).rows as any[];
  ok('Promo tenant-scoped: T2 attempt did not consume T1 promo (used_count still 1)', Number(uc2[0]?.used_count) === 1, JSON.stringify(uc2));

  // 9. promo min-spend rejected
  const o9 = await makeOrder(one(50));
  const c9 = await checkout(o9.order_no, { promo_code: code });
  ok('Promo min-spend not met → 400 PROMO_MIN_SPEND', c9.status === 400 && c9.json.error?.code === 'PROMO_MIN_SPEND', `${c9.status} ${c9.json.error?.code}`);

  // 10. promo expired rejected (seed directly — createPromotion's promoId is same-second stamp, collides with promo #7)
  await db.insert(s.promotions).values({ tenantId: t1, promoId: 'PROMO-EXPIRED', promoName: 'เก่า', promoType: 'Percent', discountPct: '10', endDate: '2020-01-01', usedCount: 0, active: true }).onConflictDoNothing();
  const o10 = await makeOrder(one(200));
  const c10 = await checkout(o10.order_no, { promo_code: 'PROMO-EXPIRED' });
  ok('Promo expired → 400 PROMO_EXPIRED', c10.status === 400 && c10.json.error?.code === 'PROMO_EXPIRED', `${c10.status} ${c10.json.error?.code}`);

  // 11. over-discount rejected
  const o11 = await makeOrder(one(170));
  const c11 = await checkout(o11.order_no, { discount: 9999 });
  ok('Over-discount → 400 DISCOUNT_EXCEEDS_SUBTOTAL', c11.status === 400 && c11.json.error?.code === 'DISCOUNT_EXCEEDS_SUBTOTAL', `${c11.status} ${c11.json.error?.code}`);

  // 12. max-discount-% rejected (80% > 50)
  const o12 = await makeOrder(one(200));
  const c12 = await checkout(o12.order_no, { discount_pct: 80 });
  ok('Discount > max 50% → 400 DISCOUNT_OVER_LIMIT', c12.status === 400 && c12.json.error?.code === 'DISCOUNT_OVER_LIMIT', `${c12.status} ${c12.json.error?.code}`);

  // 13. abbreviated invoice ties to discounted total
  ok('Discounted sale → ATV invoice grand_total ties', /^ATV-/.test(c4.json.tax_invoice_no ?? ''), c4.json.tax_invoice_no);
  const inv = (await pg.query(`SELECT grand_total, discount FROM tax_invoices WHERE doc_no='${c4.json.tax_invoice_no}'`)).rows as any[];
  ok('Invoice grand_total = discounted total 192.60, discount 20', near(inv[0]?.grand_total, 192.60) && near(inv[0]?.discount, 20), JSON.stringify(inv));

  // verify-fix #7: max_uses cap enforced (seed directly to dodge createPromotion's same-second id collision)
  await db.insert(s.promotions).values({ tenantId: t1, promoId: 'PROMO-CAP', promoName: 'จำกัด', promoType: 'Percent', discountPct: '10', maxUses: 1, usedCount: 0, active: true }).onConflictDoNothing();
  const cap1 = await checkout((await makeOrder(one(100))).order_no, { promo_code: 'PROMO-CAP' });
  ok('Fix#7: promo within max_uses applies', cap1.json.promo_code === 'PROMO-CAP', `${cap1.status}`);
  const cap2 = await checkout((await makeOrder(one(100))).order_no, { promo_code: 'PROMO-CAP' });
  ok('Fix#7: promo over max_uses → 400 PROMO_EXHAUSTED', cap2.status === 400 && cap2.json.error?.code === 'PROMO_EXHAUSTED', `${cap2.status} ${cap2.json.error?.code}`);

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 #4 Discounts / promotions (ส่วนลด/โปรโมชันที่จุดขาย) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} pos-discount checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} pos-discount checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
