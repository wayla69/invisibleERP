/**
 * POS Tier 2 #9 — Loyalty / membership at POS (สมาชิก/แต้มที่จุดขาย) over PGlite:
 * enroll members per shop, earn on net spend, redeem points as a pre-VAT order discount, RLS isolation.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover loyalty
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'loy-secret';
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

  // enable loyalty: 1 pt / ฿1 earned, ฿0.1 / pt redeemed
  await inj('PUT', '/api/loyalty/config', admin, { enabled: true, points_per_baht: 1, baht_per_point: 0.1, min_redeem: 0 });

  let tn = 0;
  const makeOrder = async (items: any[]) => {
    const t = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `L${++tn}`, seats: 4 });
    return (await inj('POST', '/api/restaurant/orders', sales1, { table_id: t.json.id, items })).json;
  };
  const checkout = (orderNo: string, body: any) => inj('POST', `/api/restaurant/orders/${orderNo}/checkout`, sales1, body);
  const one = (price: number) => [{ name: 'จานเดียว', qty: 1, unit_price: price, station_code: 'hot' }];
  const glOf = async (saleNo: string) => (await pg.query(`SELECT account_code, debit, credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='${saleNo}'`)).rows as any[];
  const leg = (gl: any[], code: string, side: string) => Number(gl.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side] || 0), 0));

  // ── 1. enroll ──
  const en = await inj('POST', '/api/loyalty/members', sales1, { name: 'สมชาย', phone: '0810000001' });
  const m1 = Number(en.json.id);
  ok('Enroll member → M-###### code, balance 0', (en.status === 200 || en.status === 201) && /^M-\d{6}$/.test(en.json.member_code ?? '') && near(en.json.balance, 0), JSON.stringify(en.json).slice(0, 90));

  // ── 2. duplicate phone rejected ──
  const dup = await inj('POST', '/api/loyalty/members', sales1, { name: 'ซ้ำ', phone: '0810000001' });
  ok('Duplicate phone → 409 MEMBER_EXISTS', dup.status === 409 && dup.json.error?.code === 'MEMBER_EXISTS', `${dup.status} ${dup.json.error?.code}`);

  // ── 3. lookup by phone ──
  const lk = await inj('GET', '/api/loyalty/members/lookup?phone=0810000001', sales1);
  ok('Lookup by phone → same member id', lk.status === 200 && Number(lk.json.id) === m1, JSON.stringify(lk.json).slice(0, 70));

  // ── 4 + 5. earn on a ฿200 net sale (no redeem) — VAT/total untouched ──
  const o4 = await makeOrder(one(200));
  const c4 = await checkout(o4.order_no, { member_id: m1 });
  const bal4 = await inj('GET', `/api/loyalty/members/${m1}`, sales1);
  ok('Earn: ฿200 net → balance 200, lifetime 200', near(bal4.json.balance, 200) && near(bal4.json.lifetime, 200), `bal=${bal4.json.balance} life=${bal4.json.lifetime}`);
  const led4 = (await pg.query(`SELECT txn_type, points, ref_doc FROM pos_member_ledger WHERE member_id=${m1} AND txn_type='Earn' AND ref_doc='${c4.json.sale_no}'`)).rows as any[];
  ok('Earn ledger: +200 Earn row tied to SALE-', led4.length === 1 && near(led4[0].points, 200), JSON.stringify(led4));
  const gl5 = await glOf(c4.json.sale_no);
  ok('Earn does NOT touch VAT/total: total 214, Cr4000=200, Cr2100=14', near(c4.json.total, 214) && near(leg(gl5, '4000', 'credit'), 200) && near(leg(gl5, '2100', 'credit'), 14), `total=${c4.json.total}`);

  // ── 6. redeem 100 pts → ฿10 pre-VAT discount ──
  const o6 = await makeOrder(one(200));
  const c6 = await checkout(o6.order_no, { member_id: m1, redeem_points: 100 });
  const gl6 = await glOf(c6.json.sale_no);
  const bal6 = (leg(gl6, '1000', 'debit') === leg(gl6, '4000', 'credit') + leg(gl6, '2100', 'credit'));
  ok('Redeem 100 → discount ฿10, subtotal 200, total 203.30', near(c6.json.subtotal, 200) && near(c6.json.discount, 10) && near(c6.json.total, 203.30), JSON.stringify(c6.json).slice(0, 110));
  ok('Redeem GL on reduced base: Cr4000=190, Cr2100=13.30, Dr1000=203.30, balanced', near(leg(gl6, '4000', 'credit'), 190) && near(leg(gl6, '2100', 'credit'), 13.30) && near(leg(gl6, '1000', 'debit'), 203.30) && bal6, JSON.stringify(gl6));

  // ── 7. balance after earn(190)+redeem(100): 200+190-100 = 290; points_used=100 ──
  const bal7 = await inj('GET', `/api/loyalty/members/${m1}`, sales1);
  const led7 = (await pg.query(`SELECT points, redeem_value FROM pos_member_ledger WHERE member_id=${m1} AND txn_type='Redeem' AND ref_doc='${c6.json.sale_no}'`)).rows as any[];
  const pu = (await pg.query(`SELECT points_used, points_earned FROM cust_pos_sales WHERE sale_no='${c6.json.sale_no}'`)).rows as any[];
  ok('Balance 290; Redeem row -100/฿10; points_used=100', near(bal7.json.balance, 290) && near(led7[0]?.points, -100) && near(led7[0]?.redeem_value, 10) && near(pu[0]?.points_used, 100), `bal=${bal7.json.balance} ${JSON.stringify(led7)} pu=${pu[0]?.points_used}`);

  // ── 8. points_earned stored on the redeem sale = floor(190) = 190 ──
  ok('points_earned stored on sale #6 = 190', near(pu[0]?.points_earned, 190), `pe=${pu[0]?.points_earned}`);

  // ── 9. over-redeem rejected, no sale created ──
  const o9 = await makeOrder(one(200));
  const c9 = await checkout(o9.order_no, { member_id: m1, redeem_points: 99999 });
  const noSale = (await pg.query(`SELECT count(*)::int n FROM cust_pos_sales WHERE notes='Dine-in ${o9.order_no}'`)).rows as any[];
  ok('Over-redeem → 409 INSUFFICIENT_POINTS, no sale row', c9.status === 409 && c9.json.error?.code === 'INSUFFICIENT_POINTS' && noSale[0].n === 0, `${c9.status} ${c9.json.error?.code} n=${noSale[0].n}`);

  // ── 10. redeem clamps to bill: balance 2000, ฿50 bill, redeem 1000 → discount ฿50, total 0, only 500 pts used ──
  const en2 = await inj('POST', '/api/loyalty/members', sales1, { name: 'มานี', phone: '0810000002' });
  const m2 = Number(en2.json.id);
  await db.update(s.posMembers).set({ balance: '2000', lifetime: '2000' }).where(eq(s.posMembers.id, m2));
  const o10 = await makeOrder(one(50));
  const c10 = await checkout(o10.order_no, { member_id: m2, redeem_points: 1000 });
  const bal10 = await inj('GET', `/api/loyalty/members/${m2}`, sales1);
  const pu10 = (await pg.query(`SELECT points_used FROM cust_pos_sales WHERE sale_no='${c10.json.sale_no}'`)).rows as any[];
  ok('Clamp: ฿50 bill vs 1000pts → discount 50, total 0, points_used 500, balance 1500', near(c10.json.discount, 50) && near(c10.json.total, 0) && near(pu10[0]?.points_used, 500) && near(bal10.json.balance, 1500), `disc=${c10.json.discount} total=${c10.json.total} pu=${pu10[0]?.points_used} bal=${bal10.json.balance}`);

  // ── 11. history ──
  const hist = await inj('GET', `/api/loyalty/members/${m1}/history`, sales1);
  const types = (hist.json.history ?? []).map((h: any) => h.txn_type);
  ok('History: Earn + Redeem rows with balance_after', hist.status === 200 && types.includes('Earn') && types.includes('Redeem') && (hist.json.history ?? []).every((h: any) => h.balance_after != null), JSON.stringify(types));

  // ── 12. RLS: T2 staff cannot see T1 member ──
  const xlk = await inj('GET', '/api/loyalty/members/lookup?phone=0810000001', sales2);
  ok('RLS: T2 lookup of T1 member phone → 404 MEMBER_NOT_FOUND', xlk.status === 404 && xlk.json.error?.code === 'MEMBER_NOT_FOUND', `${xlk.status} ${xlk.json.error?.code}`);

  // ── 13. program disabled guard ──
  await inj('PUT', '/api/loyalty/config', admin, { enabled: false });
  const o13 = await makeOrder(one(200));
  const c13 = await checkout(o13.order_no, { member_id: m1, redeem_points: 10 });
  ok('Disabled program: redeem checkout → 409 LOYALTY_DISABLED', c13.status === 409 && c13.json.error?.code === 'LOYALTY_DISABLED', `${c13.status} ${c13.json.error?.code}`);
  await inj('PUT', '/api/loyalty/config', admin, { enabled: true });

  // ── 14. trial balance balanced overall ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced at end', near(Number(tb.totals?.debit ?? tb.total_debit), Number(tb.totals?.credit ?? tb.total_credit)), JSON.stringify(tb.totals ?? {}).slice(0, 80));

  // ── report ──
  console.log('\n── POS Tier 2 #9 Loyalty / Membership at POS (สมาชิก/แต้มที่จุดขาย) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} loyalty checks failed` : `\n✅ All ${checks.length} loyalty checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
