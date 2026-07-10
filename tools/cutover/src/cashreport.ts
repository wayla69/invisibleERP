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

  // ── POS-07: sign + archive the Z-report (tamper-evident, manager-attested) ──
  const sign = await inj('POST', `/api/payments/till/${till.json.session_no}/z-report/sign`, sales1, {});
  ok('POS-07: sign Z-report → SIGNED + content_hash', sign.json.status === 'SIGNED' && sign.json.already === false && /^[0-9a-f]{64}$/.test(sign.json.content_hash ?? ''), JSON.stringify(sign.json).slice(0, 120));
  ok('POS-07: signed Z snapshots totals (counted 900, variance -7) + denominations (500×1,100×4)', near(sign.json.cash_counted, 900) && near(sign.json.variance, -7) && sign.json.denominations?.find((d: any) => d.denomination === 100)?.count === 4, JSON.stringify(sign.json.denominations));
  const reSign = await inj('POST', `/api/payments/till/${till.json.session_no}/z-report/sign`, sales1, {});
  ok('POS-07: re-sign is idempotent (already=true, same hash)', reSign.json.already === true && reSign.json.content_hash === sign.json.content_hash, `${reSign.json.already} ${reSign.json.content_hash === sign.json.content_hash}`);
  // Pending-list feed for the /pos/close-of-day session dropdown (doc-reference dropdowns).
  const sessList = await inj('GET', '/api/payments/till/sessions?status=Closed', sales1);
  ok('till/sessions pending list returns the closed TILL-… session_no', sessList.status === 200 && (sessList.json.sessions ?? []).some((x: any) => x.session_no === till.json.session_no && x.status === 'Closed'), JSON.stringify((sessList.json.sessions ?? []).slice(0, 2)));
  const xzList = await inj('GET', '/api/payments/xz-reports', sales1);
  ok('POS-07: xz-reports list includes the signed Z', (xzList.json.reports ?? []).some((r: any) => r.id === sign.json.id && r.report_type === 'Z'), `n=${xzList.json.count}`);
  const fetched = await inj('GET', `/api/payments/xz-reports/${sign.json.id}`, sales1);
  ok('POS-07: fresh fetch verifies hash_valid=true', fetched.json.hash_valid === true, JSON.stringify({ hv: fetched.json.hash_valid }));
  // tamper: mutate a persisted total directly → recomputed hash no longer matches → hash_valid=false
  await pg.query(`UPDATE xz_reports SET gross_sales = gross_sales + 999 WHERE id = ${sign.json.id}`);
  const tampered = await inj('GET', `/api/payments/xz-reports/${sign.json.id}`, sales1);
  ok('POS-07: tampered row detected (hash_valid=false)', tampered.json.hash_valid === false, JSON.stringify({ hv: tampered.json.hash_valid }));
  // guard: cannot sign a Z for an open till
  const tillOpenForSign = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 100 });
  const signOpen = await inj('POST', `/api/payments/till/${tillOpenForSign.json.session_no}/z-report/sign`, sales1, {});
  ok('POS-07: sign rejected for an open till (400 TILL_NOT_CLOSED)', signOpen.status === 400 && signOpen.json.error?.code === 'TILL_NOT_CLOSED', `${signOpen.status} ${signOpen.json.error?.code}`);
  // permission: a sell-only Cashier (no pos_close/ar) cannot sign
  await db.insert(s.users).values({ username: 'cashier1', passwordHash: await pw.hash('pc1'), role: 'Cashier', tenantId: t1 }).onConflictDoNothing();
  const cashier1 = await login('cashier1', 'pc1');
  const cashierSign = await inj('POST', `/api/payments/till/${till.json.session_no}/z-report/sign`, cashier1, {});
  ok('POS-07: Cashier (pos_sell only) cannot sign Z (403)', cashierSign.status === 403, `${cashierSign.status}`);

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

  // ── REV-13: cash over/short → GL + maker-checker ──
  // Immaterial short (-7, the close above) posts to GL immediately (5830 Dr / 1000 Cr), no approval.
  ok('REV-13: immaterial variance status NotRequired + JE posted', z.json.variance_status === 'NotRequired' && /^JE-/.test(z.json.variance_journal_no ?? ''), `st=${z.json.variance_status} je=${z.json.variance_journal_no}`);
  const short7 = (await pg.query(`SELECT coalesce(sum(jl.debit),0) d FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.source='TILL_CLOSE' AND je.entry_no='${z.json.variance_journal_no}' AND jl.account_code='5830'`)).rows as any[];
  ok('REV-13: immaterial short books Dr 5830 Cash Over/Short = 7', near(short7[0]?.d, 7), `d=${short7[0]?.d}`);

  // Material short: open float 0, one cash sale (107), close counting 0 → variance -107 (> 100) → Draft JE + PendingApproval.
  const tillM = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 0 });
  await cashSale(); // 107 cash, links to tillM (most-recent open till)
  const zM = await inj('POST', '/api/payments/till/close', sales1, { session_no: tillM.json.session_no, closing_count: 0 });
  ok('REV-13: material short parks PendingApproval', zM.json.variance_status === 'PendingApproval' && near(zM.json.variance, -107) && /^JE-/.test(zM.json.variance_journal_no ?? ''), JSON.stringify(zM.json).slice(0, 120));
  const jeM = (await pg.query(`SELECT status, created_by FROM journal_entries WHERE entry_no='${zM.json.variance_journal_no}'`)).rows as any[];
  ok('REV-13: material variance JE is Draft (excluded from balances)', jeM[0]?.status === 'Draft' && jeM[0]?.created_by === 'sales1', JSON.stringify(jeM[0]));

  // SoD: the cashier who closed cannot approve their own variance.
  const selfApprove = await inj('POST', `/api/payments/till/variance/${tillM.json.session_no}/approve`, sales1);
  ok('REV-13: self-approval blocked (403 SOD_VIOLATION)', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_VIOLATION', `${selfApprove.status} ${selfApprove.json.error?.code}`);

  // A different user (manager/admin) approves → JE becomes Posted, till variance Approved.
  const appr = await inj('POST', `/api/payments/till/variance/${tillM.json.session_no}/approve`, admin);
  ok('REV-13: manager approves material variance', appr.json.variance_status === 'Approved' && appr.json.approved_by === 'admin', JSON.stringify(appr.json).slice(0, 110));
  const jeM2 = (await pg.query(`SELECT status FROM journal_entries WHERE entry_no='${zM.json.variance_journal_no}'`)).rows as any[];
  ok('REV-13: approved variance JE now Posted', jeM2[0]?.status === 'Posted', JSON.stringify(jeM2[0]));

  // Re-approving a settled variance is rejected.
  const reAppr = await inj('POST', `/api/payments/till/variance/${tillM.json.session_no}/approve`, admin);
  ok('REV-13: re-approval rejected (NOT_PENDING)', reAppr.status === 400 && reAppr.json.error?.code === 'NOT_PENDING', `${reAppr.status} ${reAppr.json.error?.code}`);

  const tb2 = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('REV-13: trial balance still balanced after variance postings', near(tb2.debit ?? tb2.total_debit, tb2.credit ?? tb2.total_credit), JSON.stringify(tb2).slice(0, 70));

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

  // ── REV-13: a CASH tip lands in the drawer, so expected_cash must include it ──
  // `payments.amount` excludes the tip (2300 liability) while the sale's GL debits 1000 for total+tip.
  // Omitting it made every close with a cash tip read "over" by exactly the tip — a false variance that
  // could trip the maker-checker. A tip on a CARD tender never reaches the drawer and must be excluded.
  const tillT = await inj('POST', '/api/payments/till/open', sales1, { opening_float: 0 });
  const tipTable = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `C${++tn}`, seats: 2 });
  const tipOrder = await inj('POST', '/api/restaurant/orders', sales1, { table_id: tipTable.json.id, items: [{ name: 'กะเพรา', qty: 1, unit_price: 100, station_code: 'hot' }] });
  await inj('POST', `/api/restaurant/orders/${tipOrder.json.order_no}/checkout`, sales1, { method: 'Cash', tip: 20 });
  const cardTable = await inj('POST', '/api/restaurant/tables', sales1, { table_no: `C${++tn}`, seats: 2 });
  const cardOrder = await inj('POST', '/api/restaurant/orders', sales1, { table_id: cardTable.json.id, items: [{ name: 'กะเพรา', qty: 1, unit_price: 100, station_code: 'hot' }] });
  await inj('POST', `/api/restaurant/orders/${cardOrder.json.order_no}/checkout`, sales1, { method: 'Card', tip: 30 });
  const tillTId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, tillT.json.session_no)))[0].id);
  const xt = await inj('GET', `/api/payments/till/${tillTId}/x-report`, sales1);
  ok('Tip: expected_cash includes the CASH tip (107+20=127) and excludes the CARD tip', near(xt.json.expected_cash, 127), `exp=${xt.json.expected_cash}`);
  const zt = await inj('POST', '/api/payments/till/close', sales1, { session_no: tillT.json.session_no, closing_count: 127 });
  ok('Tip: counting the real drawer (127) closes with variance 0 — no phantom "over"', near(zt.json.variance, 0) && zt.json.variance_status === 'NotRequired', JSON.stringify({ v: zt.json.variance, st: zt.json.variance_status }));

  await app.close();
  await pg.close();

  console.log('\n── POS Tier 1 #3 Cash management + X/Z report (จัดการเงินสด + ปิดกะ) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} cash-report checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} cash-report checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
