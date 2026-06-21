/**
 * POS Tier 1 #2 — Split bill + multi-tender (แยกบิล / แยกจ่าย) validation (Nest over PGlite, RLS):
 * multi-tender (1 sale, N tenders, GL once), equal/by-item split (N checks = N sales+GL+invoices).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover splitbill
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'split-secret';
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
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

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

  let tn = 0;
  const makeOrder = async (token: string, items: any[]) => {
    const t = await inj('POST', '/api/restaurant/tables', token, { table_no: `S${++tn}`, seats: 4 });
    const o = await inj('POST', '/api/restaurant/orders', token, { table_id: t.json.id, items });
    return o.json;
  };
  const kapow = (qty: number) => ({ name: 'กะเพรา', qty, unit_price: 100, station_code: 'hot' });

  // ── multi-tender: all captured (cash 200 + card 121 = 321) → paid in one call, GL once ──
  const o1 = await makeOrder(sales1, [kapow(3)]); // net 300, total 321
  const m1 = await inj('POST', `/api/pos/orders/${o1.order_no}/pay-multi`, sales1, { tenders: [{ method: 'Cash', amount: 200 }, { method: 'Card', amount: 121 }] });
  ok('Multi-tender: cash+card sums to 321 → paid + ATV invoice', m1.json.paid === true && m1.json.payment_state === 'paid' && /^ATV-/.test(m1.json.tax_invoice_no ?? '') && m1.json.tenders?.length === 2, `${m1.status} ${JSON.stringify(m1.json).slice(0, 120)}`);
  const glCount = (await pg.query(`SELECT count(*)::int AS c FROM journal_entries WHERE source='POS' AND source_ref='${m1.json.sale_no}'`)).rows as any[];
  ok('Multi-tender: GL posted exactly ONCE for the sale', glCount[0].c === 1, JSON.stringify(glCount));
  ok('Multi-tender: both tenders Captured', (m1.json.tenders ?? []).every((t: any) => t.status === 'Captured'));

  // ── multi-tender mismatch rejected (and tx rolls back, no orphan sale) ──
  const o2 = await makeOrder(sales1, [kapow(3)]);
  const m2 = await inj('POST', `/api/pos/orders/${o2.order_no}/pay-multi`, sales1, { tenders: [{ method: 'Cash', amount: 100 }, { method: 'Cash', amount: 100 }] });
  ok('Multi-tender: Σtenders != total → 400 SPLIT_MISMATCH', m2.status === 400 && m2.json.error?.code === 'SPLIT_MISMATCH', `${m2.status} ${m2.json.error?.code}`);

  // ── multi-tender with a Pending PromptPay leg → partially_paid → settle → finalize → paid ──
  const o3 = await makeOrder(sales1, [kapow(3)]);
  const m3 = await inj('POST', `/api/pos/orders/${o3.order_no}/pay-multi`, sales1, { tenders: [{ method: 'Cash', amount: 221 }, { method: 'PromptPay', amount: 100, gateway: 'promptpay' }] });
  ok('Multi-tender: Pending leg → partially_paid (no invoice yet)', m3.json.payment_state === 'partially_paid' && !m3.json.tax_invoice_no, `${m3.status} ${JSON.stringify(m3.json).slice(0, 90)}`);
  const qrPay = (m3.json.tenders ?? []).find((t: any) => t.status !== 'Captured');
  await inj('PATCH', `/api/payments/${qrPay?.payment_no}/settle`, sales1);
  const fin = await inj('POST', `/api/pos/orders/${o3.order_no}/finalize`, sales1);
  ok('Multi-tender: settle Pending + finalize → paid + invoice', fin.json.paid === true && /^ATV-/.test(fin.json.tax_invoice_no ?? ''), `${fin.status} ${JSON.stringify(fin.json).slice(0, 90)}`);

  // ── equal split 3-way on 321 → [107,107,107], settle → 3 sales + 3 invoices + 3 JE ──
  const o4 = await makeOrder(sales1, [kapow(3)]);
  const pv = await inj('POST', `/api/pos/orders/${o4.order_no}/split/preview`, sales1, { method: 'equal', ways: 3 });
  const totals = (pv.json.checks ?? []).map((c: any) => c.total);
  ok('Split equal 3-way preview: [107,107,107], Σ=321', totals.length === 3 && totals.every((t: number) => near(t, 107)) && near(sum(totals), 321), JSON.stringify(totals));
  const set4 = await inj('POST', `/api/pos/orders/${o4.order_no}/split/settle`, sales1, { method: 'equal', ways: 3 });
  const c4 = set4.json.checks ?? [];
  ok('Split equal settle: 3 sales + 3 ATV + 3 JE, distinct sale_nos', c4.length === 3 && new Set(c4.map((c: any) => c.sale_no)).size === 3 && c4.every((c: any) => /^SALE-/.test(c.sale_no) && /^ATV-/.test(c.tax_invoice_no) && /^JE-/.test(c.journal_no)) && set4.json.order_status === 'paid', `${set4.status} ${JSON.stringify(c4).slice(0, 120)}`);
  ok('Split equal settle: Σ check totals = 321', near(sum(c4.map((c: any) => c.total)), 321));
  const splitRows = (await pg.query(`SELECT count(*)::int AS c FROM pos_check_splits WHERE order_no='${o4.order_no}'`)).rows as any[];
  ok('Split: pos_check_splits audit = 3', splitRows[0].c === 3, JSON.stringify(splitRows));
  const co4 = await inj('POST', `/api/restaurant/orders/${o4.order_no}/checkout`, sales1, { method: 'Cash' });
  ok('Split: no double-post — checkout after settle → 400 ALREADY_PAID', co4.status === 400, `${co4.status} ${co4.json.error?.code}`);

  // ── equal split remainder: order total 107, 3-way → last absorbs remainder, Σ=107 ──
  const o5 = await makeOrder(sales1, [kapow(1)]); // net 100, total 107
  const pv5 = await inj('POST', `/api/pos/orders/${o5.order_no}/split/preview`, sales1, { method: 'equal', ways: 3 });
  const t5 = (pv5.json.checks ?? []).map((c: any) => c.total);
  ok('Split equal remainder: Σ=107 exactly (no satang lost)', near(sum(t5), 107) && t5.length === 3, JSON.stringify(t5));

  // ── by-item split: A(net100) check1, B(net200) check2 ──
  const o6 = await makeOrder(sales1, [{ name: 'A', qty: 1, unit_price: 100, station_code: 'hot' }, { name: 'B', qty: 1, unit_price: 200, station_code: 'hot' }]);
  const A = o6.items[0].item_id, B = o6.items[1].item_id;
  const set6 = await inj('POST', `/api/pos/orders/${o6.order_no}/split/settle`, sales1, { method: 'by_items', assignments: [{ item_id: A, check: 1 }, { item_id: B, check: 2 }] });
  const c6 = set6.json.checks ?? [];
  ok('Split by-item: check1=107 (A), check2=214 (B), 2 distinct sales', c6.length === 2 && near(c6[0].total, 107) && near(c6[1].total, 214) && new Set(c6.map((c: any) => c.sale_no)).size === 2, JSON.stringify(c6.map((c: any) => c.total)));

  // ── by-item incomplete assignment rejected ──
  const o7 = await makeOrder(sales1, [{ name: 'A', qty: 1, unit_price: 100, station_code: 'hot' }, { name: 'B', qty: 1, unit_price: 200, station_code: 'hot' }]);
  const set7 = await inj('POST', `/api/pos/orders/${o7.order_no}/split/settle`, sales1, { method: 'by_items', assignments: [{ item_id: o7.items[0].item_id, check: 1 }] });
  ok('Split by-item: unassigned item → 400 SPLIT_INCOMPLETE', set7.status === 400 && set7.json.error?.code === 'SPLIT_INCOMPLETE', `${set7.status} ${set7.json.error?.code}`);

  // ── RLS: T2 staff cannot split/settle T1's order ──
  const o8 = await makeOrder(sales1, [kapow(1)]);
  const cross = await inj('POST', `/api/pos/orders/${o8.order_no}/split/preview`, sales2, { method: 'equal', ways: 2 });
  ok('RLS: T2 cannot preview T1 order → 404', cross.status === 404, `${cross.status}`);

  // ── trial balance still balances after all the split/multi-tender GL ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', await login('admin', 'admin123'))).json.totals ?? {};
  ok('GL: trial balance balanced after split/multi-tender', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 70));

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 #2 Split bill + multi-tender (แยกบิล/แยกจ่าย) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} split-bill checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} split-bill checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
