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
import { blindIndex } from '../../../apps/api/dist/database/encrypted-column';
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

  // ════════ W1 (docs/27) — tier earn multiplier · P2P transfer (LYL-18) · expiry look-ahead ════════
  // T1 staff principal with the 'loyalty' duty (the Customer role carries it) for tenant-scoped calls.
  await db.insert(s.users).values([{ username: 'loystaff', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: t1 }]).onConflictDoNothing();
  const loystaff = await login('loystaff', 'pw');

  // ── 15. tier ladder: Gold ×2 applies on the REAL earn path (m1 lifetime 390 ≥ 250 ⇒ Gold) ──
  await inj('POST', '/api/loyalty/tiers', loystaff, { tier: 'Standard', min_lifetime: 0, earn_mult: 1 });
  await inj('POST', '/api/loyalty/tiers', loystaff, { tier: 'Gold', min_lifetime: 250, earn_mult: 2 });
  const o15 = await makeOrder(one(100));
  await checkout(o15.order_no, { member_id: m1 });
  const bal15 = await inj('GET', `/api/loyalty/members/${m1}`, sales1);
  ok('W1 tier earn: Gold ×2 → ฿100 net earns 200 pts (bal 290→490)', near(bal15.json.balance, 490), `bal=${bal15.json.balance}`);
  const led15 = (await pg.query(`SELECT notes FROM pos_member_ledger WHERE member_id=${m1} AND txn_type='Earn' ORDER BY id DESC LIMIT 1`)).rows as any[];
  ok('W1 tier earn: ledger row audits the multiplier (tier Gold ×2)', String(led15[0]?.notes ?? '').includes('Gold'), JSON.stringify(led15));

  // ── 16. P2P transfer (LYL-18): atomic two-row move, liability net-zero, guards ──
  const liaBefore = (await inj('GET', '/api/loyalty/liability', loystaff)).json;
  const tr = await inj('POST', `/api/loyalty/members/${m2}/transfer`, loystaff, { to_member_id: m1, points: 100, note: 'ให้เพื่อน' });
  ok('W1 P2P: staff transfer 100 m2→m1 → balances 1400/590', tr.status === 201 || tr.status === 200 ? near(tr.json.from_balance, 1400) && near(tr.json.to_balance, 590) : false, `${tr.status} ${JSON.stringify(tr.json).slice(0, 90)}`);
  const trLed = (await pg.query(`SELECT member_id, points FROM pos_member_ledger WHERE txn_type='Transfer' AND ref_doc='P2P-${m2}-${m1}'`)).rows as any[];
  ok('W1 P2P: exactly two Transfer ledger rows netting to zero', trLed.length === 2 && near(trLed.reduce((a, r) => a + Number(r.points), 0), 0), JSON.stringify(trLed));
  const liaAfter = (await inj('GET', '/api/loyalty/liability', loystaff)).json;
  ok('W1 P2P: 2250 liability unchanged (outstanding constant; transfer_net_points 0)',
    near(liaAfter.outstanding_points, Number(liaBefore.outstanding_points)) && near(liaAfter.movements?.transfer_net_points, 0),
    `out ${liaBefore.outstanding_points}→${liaAfter.outstanding_points} net=${liaAfter.movements?.transfer_net_points}`);
  const trSelf = await inj('POST', `/api/loyalty/members/${m2}/transfer`, loystaff, { to_member_id: m2, points: 10 });
  ok('W1 P2P: self-transfer → 400 SELF_TRANSFER', trSelf.status === 400 && trSelf.json.error?.code === 'SELF_TRANSFER', `${trSelf.status} ${trSelf.json.error?.code}`);
  const trOver = await inj('POST', `/api/loyalty/members/${m1}/transfer`, loystaff, { to_member_id: m2, points: 99999 });
  ok('W1 P2P: over-balance transfer → 409 INSUFFICIENT_POINTS', trOver.status === 409 && trOver.json.error?.code === 'INSUFFICIENT_POINTS', `${trOver.status} ${trOver.json.error?.code}`);
  await inj('PUT', '/api/loyalty/config', admin, { transfer_day_cap: 150 });
  const trCap = await inj('POST', `/api/loyalty/members/${m2}/transfer`, loystaff, { to_member_id: m1, points: 100 });
  ok('W1 P2P: daily cap 150 with 100 already sent today → 409 TRANSFER_CAP', trCap.status === 409 && trCap.json.error?.code === 'TRANSFER_CAP', `${trCap.status} ${trCap.json.error?.code}`);
  await inj('PUT', '/api/loyalty/config', admin, { transfer_day_cap: 0 });
  const trOff = await inj('POST', `/api/loyalty/members/${m2}/transfer`, loystaff, { to_member_id: m1, points: 1 });
  ok('W1 P2P: transfer_day_cap 0 disables the feature → 409 TRANSFER_DISABLED', trOff.status === 409 && trOff.json.error?.code === 'TRANSFER_DISABLED', `${trOff.status} ${trOff.json.error?.code}`);
  await inj('PUT', '/api/loyalty/config', admin, { transfer_day_cap: 1000 });
  const en3 = await inj('POST', '/api/loyalty/members', sales2, { name: 'ต่างร้าน', phone: '0890000009' });
  const trX = await inj('POST', `/api/loyalty/members/${m2}/transfer`, loystaff, { to_member_id: Number(en3.json.id), points: 10 });
  ok('W1 P2P: recipient in another tenant → 404 RECIPIENT_NOT_FOUND (no cross-shop leak)', trX.status === 404 && trX.json.error?.code === 'RECIPIENT_NOT_FOUND', `${trX.status} ${trX.json.error?.code}`);

  // ── G13 (maker-checker audit): a staff P2P transfer ABOVE the approval threshold (500) is STAGED for a
  //    DISTINCT approver — one person cannot move point-value (a TFRS-15 liability) to a controlled member
  //    on their own (SoD R15/R16). Sub-threshold transfers (above) still move immediately. ──
  await db.insert(s.users).values([
    { username: 'lpmkr', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 }, // requests + holds approvals (SoD guard, not perm-denial)
    { username: 'lpchk', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 }, // distinct approver
  ]).onConflictDoNothing();
  const [lpmkr, lpchk] = [await login('lpmkr', 'pw'), await login('lpchk', 'pw')];
  const m2Bal = () => (async () => Number((await db.select().from(s.posMembers).where(eq(s.posMembers.id, m2)))[0].balance))();
  const balBefore = await m2Bal();
  const trBig = await inj('POST', `/api/loyalty/members/${m2}/transfer`, lpmkr, { to_member_id: m1, points: 600 });
  ok('G13: over-threshold staff transfer (600 > 500) → staged PendingApproval, no points move', (trBig.status === 200 || trBig.status === 201) && trBig.json.status === 'PendingApproval' && trBig.json.pending === true && /^PPT-/.test(trBig.json.req_no ?? '') && (await m2Bal()) === balBefore, JSON.stringify({ s: trBig.status, st: trBig.json.status, rq: trBig.json.req_no, bal: await m2Bal(), was: balBefore }));
  const trBigSelf = await inj('POST', `/api/loyalty/transfers/${trBig.json.req_no}/approve`, lpmkr);
  ok('G13: requester cannot self-approve their own staged transfer → 403 SOD_VIOLATION', trBigSelf.status === 403 && trBigSelf.json.error?.code === 'SOD_VIOLATION' && (await m2Bal()) === balBefore, `${trBigSelf.status} ${trBigSelf.json.error?.code}`);
  const trBigAppr = await inj('POST', `/api/loyalty/transfers/${trBig.json.req_no}/approve`, lpchk);
  ok('G13: distinct approver releases the transfer → 600 moves, balance drops', (trBigAppr.status === 200 || trBigAppr.status === 201) && trBigAppr.json.status === 'Approved' && trBigAppr.json.approved_by === 'lpchk' && (await m2Bal()) === balBefore - 600, JSON.stringify({ s: trBigAppr.status, by: trBigAppr.json.approved_by, bal: await m2Bal(), exp: balBefore - 600 }));
  const trQ = await inj('GET', '/api/loyalty/transfers/pending', lpchk);
  ok('G13: pending-transfer queue clears after approval', (trQ.json.pending ?? []).length === 0, JSON.stringify({ n: trQ.json.count }));

  // ── 17. expiry look-ahead: loyalty.points_expiring fires once per member × expire-by batch ──
  await inj('PUT', '/api/loyalty/config', admin, { expiry_days: 60 });
  await inj('POST', '/api/automation/rules', admin, { name: 'เตือนแต้มใกล้หมดอายุ', event_type: 'loyalty.points_expiring', action: { type: 'notification', message: 'แต้มของคุณใกล้หมดอายุ' } });
  const [expm] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-EXPIRE1', name: 'ใกล้หมดอายุ', phone: '0810000099', phoneBidx: blindIndex('0810000099'), balance: '500', lifetime: '500', createdBy: 'seed' }).returning();
  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000);
  await db.insert(s.posMemberLedger).values({ tenantId: t1, memberId: expm.id, txnDate: fortyDaysAgo, txnType: 'Earn', points: '500', balanceAfter: '500', refDoc: 'SEED-EXP', createdBy: 'seed' });
  const mt1 = await inj('POST', '/api/loyalty/maintenance/run', admin, { tenant_id: t1 });
  const t1res = (mt1.json.results ?? []).find((r: any) => Number(r.tenant_id) === t1);
  ok('W1 expiring: sweep look-ahead fires the notice (points expiring in ~20d < 30d window)', mt1.status === 201 || mt1.status === 200 ? Number(t1res?.expiry_notices ?? 0) >= 1 : false, JSON.stringify(t1res));
  const notice = (await pg.query(`SELECT member_id, expiring_points, expire_by FROM loyalty_expiry_notices WHERE member_id=${expm.id}`)).rows as any[];
  ok('W1 expiring: notice row records 500 pts + expire-by date', notice.length === 1 && near(notice[0].expiring_points, 500) && !!notice[0].expire_by, JSON.stringify(notice));
  const exec1 = (await pg.query(`SELECT status FROM automation_executions WHERE event_type='loyalty.points_expiring' AND status='executed'`)).rows as any[];
  ok('W1 expiring: automation rule executed (notification action) off the event', exec1.length >= 1, `executed=${exec1.length}`);
  const mt2 = await inj('POST', '/api/loyalty/maintenance/run', admin, { tenant_id: t1 });
  const t1res2 = (mt2.json.results ?? []).find((r: any) => Number(r.tenant_id) === t1);
  ok('W1 expiring: second sweep is idempotent for the same batch (no re-nag)', Number(t1res2?.expiry_notices ?? -1) === 0, JSON.stringify(t1res2));

  // ════════ V4 (docs/29) — paid VIP membership: deferred revenue + tier grant + lapse (LYL-21) ════════
  await db.insert(s.users).values([{ username: 'mkt1', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 }]).onConflictDoNothing();
  const mkt1 = await login('mkt1', 'pw'); // Sales carries legacy exec → plan config + recognition
  const plan = await inj('POST', '/api/loyalty/membership-plans', mkt1, { code: 'VIP12', name: 'บัตรทองรายปี', tier: 'Platinum', price: 1200, period_months: 12 });
  const vipMem = await inj('POST', '/api/loyalty/members', sales1, { name: 'คุณวีไอพี', phone: '0810000777' });
  const vipId = Number(vipMem.json.id);
  const twoMonthsAgo = new Date(Date.now() - 65 * 86400000).toISOString().slice(0, 10);
  const sell = await inj('POST', '/api/loyalty/memberships/sell', loystaff, { member_id: vipId, plan_id: plan.json.id, sale_ref: 'POS-VIP-1', start_date: twoMonthsAgo });
  const sellDup = await inj('POST', '/api/loyalty/memberships/sell', loystaff, { member_id: vipId, plan_id: plan.json.id });
  const vipGl = (await pg.query(`SELECT jl.account_code, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref='VIP-${sell.json.id}'`)).rows as any[];
  const vipHist = (await pg.query(`SELECT reason, to_tier FROM loyalty_tier_history WHERE member_id=${vipId} AND reason='vip'`)).rows as any[];
  const vipBal = await inj('GET', `/api/loyalty/members/${vipId}`, sales1);
  ok('V4 VIP: sell defers the fee (Dr 1000 / Cr 2410 ฿1200), grants the plan tier with a "vip" audit row, one-active enforced (409)',
    (sell.status === 200 || sell.status === 201) && sell.json.status === 'Active' && !!sell.json.entry_no
      && leg(vipGl, '1000', 'debit') === 1200 && leg(vipGl, '2410', 'credit') === 1200
      && vipBal.json.tier === 'Platinum' && vipHist.length === 1 && vipHist[0].to_tier === 'Platinum'
      && sellDup.status === 409 && sellDup.json.error?.code === 'MEMBERSHIP_ACTIVE',
    `sell=${sell.status} gl=${leg(vipGl, '1000', 'debit')}/${leg(vipGl, '2410', 'credit')} tier=${vipBal.json.tier} dup=${sellDup.status}/${sellDup.json.error?.code}`);
  const rec1 = await inj('POST', '/api/loyalty/memberships/recognize', mkt1, {});
  const rec2 = await inj('POST', '/api/loyalty/memberships/recognize', mkt1, {});
  const recGl = (await pg.query(`SELECT jl.account_code, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref LIKE 'VIP-${sell.json.id}:M%'`)).rows as any[];
  ok('V4 VIP: 65 days in → exactly 3 months recognized straight-line (Dr 2410 / Cr 4300 ฿300); a re-run posts nothing',
    rec1.json.posted === 3 && near(rec1.json.amount, 300) && rec2.json.posted === 0
      && near(leg(recGl, '2410', 'debit'), 300) && near(leg(recGl, '4300', 'credit'), 300),
    `rec1=${rec1.json.posted}/${rec1.json.amount} rec2=${rec2.json.posted} gl=${leg(recGl, '2410', 'debit')}/${leg(recGl, '4300', 'credit')}`);
  const tj = await inj('GET', `/api/loyalty/members/${vipId}/tier`, sales1);
  ok('V4 VIP: tier journey carries the membership ("VIP ถึง {end_date}" for the /m card)',
    tj.json.membership?.status === 'Active' && tj.json.membership?.plan === 'VIP12' && tj.json.membership?.recognized_months === 3,
    JSON.stringify(tj.json.membership));
  // Lapse: a membership that ended long ago expires on the sweep and the tier falls back to the EARNED rung.
  const lapMem = await inj('POST', '/api/loyalty/members', sales1, { name: 'หมดอายุ', phone: '0810000778' });
  const lapId = Number(lapMem.json.id);
  const thirteenMonthsAgo = new Date(Date.now() - 396 * 86400000).toISOString().slice(0, 10);
  await inj('POST', '/api/loyalty/memberships/sell', loystaff, { member_id: lapId, plan_id: plan.json.id, start_date: thirteenMonthsAgo });
  const lapBefore = await inj('GET', `/api/loyalty/members/${lapId}`, sales1);
  const sweepV4 = await inj('POST', '/api/loyalty/maintenance/run', admin, { tenant_id: t1 });
  const v4res = (sweepV4.json.results ?? []).find((r: any) => Number(r.tenant_id) === t1);
  const lapAfter = await inj('GET', `/api/loyalty/members/${lapId}`, sales1);
  const lapHist = (await pg.query(`SELECT reason FROM loyalty_tier_history WHERE member_id=${lapId} ORDER BY id`)).rows as any[];
  ok('V4 VIP: a lapsed membership expires on the sweep and the tier falls BACK to the earned rung (no perpetual free VIP)',
    lapBefore.json.tier === 'Platinum' && Number(v4res?.vip_expired ?? 0) >= 1
      && lapAfter.json.tier === 'Standard'
      && lapHist.some((h: any) => h.reason === 'vip') && lapHist.some((h: any) => h.reason === 'vip-expired'),
    `before=${lapBefore.json.tier} after=${lapAfter.json.tier} vip_expired=${v4res?.vip_expired} hist=${JSON.stringify(lapHist)}`);

  // ════════ V5 (docs/29) — wallet passes: mock-first issue, idempotent per member×platform, live tick ════════
  const wpMem = await inj('POST', '/api/loyalty/members', sales1, { name: 'วอลเล็ต', phone: '0810000779' });
  const wpId = Number(wpMem.json.id);
  const wpOtp = await inj('POST', '/api/member/auth/request-otp', undefined, { phone: '0810000779', tenant_code: 'T1' });
  const wpVerify = await inj('POST', '/api/member/auth/verify-otp', undefined, { phone: '0810000779', tenant_code: 'T1', code: String(wpOtp.json.dev_otp) });
  const wpTok = wpVerify.json.token as string;

  // V5a — issue: mock provider, PDPA-minimal payload (code/tier/points — NEVER the phone).
  const iss1 = await inj('POST', '/api/member/wallet-pass', wpTok, { platform: 'apple' });
  const passStr = JSON.stringify(iss1.json.pass ?? {});
  ok('V5 wallet: issue → mock pass carries the member\'s code/tier/points; payload is PDPA-minimal (no phone)',
    iss1.json.provider === 'mock' && iss1.json.repeat === false && !!iss1.json.install_url
      && iss1.json.pass?.member_code === wpMem.json.member_code && iss1.json.pass?.tier === 'Standard'
      && near(Number(iss1.json.pass?.points ?? -1), 0) && !passStr.includes('0810000779'),
    `provider=${iss1.json.provider} serial=${iss1.json.serial} url=${String(iss1.json.install_url).slice(0, 50)}`);

  // V5b — idempotent: a second issue returns the SAME registration (same serial; one row on the staff view).
  const iss2 = await inj('POST', '/api/member/wallet-pass', wpTok, { platform: 'apple' });
  const staffWp = await inj('GET', `/api/loyalty/members/${wpId}/wallet-pass`, sales1);
  ok('V5 wallet: repeat issue is idempotent per member×platform (same serial; still one registration)',
    iss2.json.repeat === true && iss2.json.serial === iss1.json.serial
      && (staffWp.json.registrations ?? []).length === 1 && staffWp.json.registrations?.[0]?.platform === 'apple',
    `repeat=${iss2.json.repeat} regs=${(staffWp.json.registrations ?? []).length}`);

  // V5c — live update: an earn fires the BiLive tick → the registered pass records the refresh.
  const oWp = await makeOrder(one(50));
  await checkout(oWp.order_no, { member_id: wpId });
  const wpBal = Number((await inj('GET', `/api/loyalty/members/${wpId}`, sales1)).json.balance);
  let wpReg: any = null;
  for (let i = 0; i < 20; i++) { // the subscriber write is async — poll briefly
    wpReg = (await inj('GET', `/api/loyalty/members/${wpId}/wallet-pass`, sales1)).json.registrations?.[0];
    if (Number(wpReg?.updates_count ?? 0) >= 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok('V5 wallet: an earn triggers a pass update (updates_count ≥ 1, last_points = live balance)',
    Number(wpReg?.updates_count ?? 0) >= 1 && near(Number(wpReg?.last_points ?? -1), wpBal),
    `updates=${wpReg?.updates_count} last_points=${wpReg?.last_points} bal=${wpBal}`);

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
