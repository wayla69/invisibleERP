/**
 * Bank — Cash banking: safe-drop → bank deposit + reconciliation (นำฝากธนาคาร) over PGlite (REC-05):
 * till cash 'drop's into the safe are batched into a bank deposit (Dr bank / Cr 1000 Cash), undeposited
 * drops are tracked (cash-in-safe exposure), and a deposit is reconciled to the bank statement. SoD: banking
 * (exec/ar) is segregated from the cashier (pos_till) who drops the cash.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cash-banking
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bank-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1] = [await tid('HQ'), await tid('T1')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'cash1', passwordHash: await pw.hash('pw1'), role: 'PosSupervisor', tenantId: t1 },   // pos_till (drops) — no exec/ar
    { username: 'fin1', passwordHash: await pw.hash('pw2'), role: 'ArClerk', tenantId: t1 },          // ar (banks)
    { username: 'bankchk', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t1 },         // G9: distinct bank-account approver (exec/approvals)
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
  const cash1 = await login('cash1', 'pw1');
  const fin1 = await login('fin1', 'pw2');
  const bankchk = await login('bankchk', 'pw3');
  const admin = await login('admin', 'admin123');
  const gl = async (code: string) => Number(((await pg.query(`SELECT coalesce(sum(jl.debit)-sum(jl.credit),0) v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_code='${code}' AND je.status='Posted' AND je.tenant_id=${t1}`)).rows as any[])[0].v);

  // a bank account (GL 1010) + a till with two cash drops (300 + 200 = 500 to the safe)
  const bank = await inj('POST', '/api/bank/accounts', fin1, { bank_name: 'KBank', account_no: '123-4-56789', gl_account_code: '1010' });
  // ── G9 maker-checker: a new bank account is created PendingApproval and cannot bank cash until a DISTINCT
  //    approver activates it (the GL mapping / account no it defines is a payment-integrity control). ──
  ok('G9: new bank account is PendingApproval (not usable)', bank.json.status === 'PendingApproval' && bank.json.pending === true, JSON.stringify(bank.json).slice(0, 90));
  const preBank = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id });
  ok('G9: deposit to a pending bank account → 400 BANK_NOT_APPROVED', preBank.status === 400 && preBank.json.error?.code === 'BANK_NOT_APPROVED', `${preBank.status} ${preBank.json.error?.code}`);
  // Self-approval guard: admin (holds the approval duty) creates a throwaway account and tries to approve it
  // itself → 403 SOD_VIOLATION (a perm-holder, so this is the SoD guard firing, not a permission denial).
  const selfAcct = await inj('POST', '/api/bank/accounts', admin, { bank_name: 'SCB', account_no: '999-9-99999', gl_account_code: '1010' });
  const selfAppr = await inj('POST', `/api/bank/accounts/${selfAcct.json.id}/approve`, admin);
  ok('G9: requester cannot self-approve their own bank account → 403 SOD_VIOLATION', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);
  // A DISTINCT approver (bankchk ≠ fin1, same tenant) activates the main account so the flow below can use it.
  const apprBank = await inj('POST', `/api/bank/accounts/${bank.json.id}/approve`, bankchk);
  ok('G9: distinct approver activates the bank account', apprBank.status === 200 && apprBank.json.status === 'Approved' && apprBank.json.approved_by === 'bankchk', JSON.stringify(apprBank.json).slice(0, 90));
  const till = await inj('POST', '/api/payments/till/open', cash1, { opening_float: 1000 });
  const tillId = Number((await db.select().from(s.tillSessions).where(eq(s.tillSessions.sessionNo, till.json.session_no)))[0].id);
  await inj('POST', `/api/payments/till/${tillId}/cash-movement`, cash1, { type: 'drop', amount: 300, reason: 'ฝากเซฟ' });
  await inj('POST', `/api/payments/till/${tillId}/cash-movement`, cash1, { type: 'drop', amount: 200, reason: 'ฝากเซฟ' });

  // ── 1. undeposited drops = cash in the safe (500), drops not yet GL'd ──
  const und = await inj('GET', '/api/bank/deposits/undeposited-drops', fin1);
  ok('Undeposited drops: 2 drops, cash-in-safe 500', und.json.count === 2 && near(und.json.total, 500), JSON.stringify(und.json).slice(0, 90));

  // ── 2. SoD: the cashier (pos_till, no exec/ar) cannot bank the cash ──
  const cashierBank = await inj('POST', '/api/bank/deposits', cash1, { bank_account_id: bank.json.id });
  ok('SoD: cashier (pos_till) cannot create a bank deposit (403)', cashierBank.status === 403, `${cashierBank.status}`);

  // ── 3. FinancialController banks the safe cash → Dr 1010 Bank / Cr 1000 Cash 500 ──
  const dep = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id, deposit_date: '2026-06-26' });
  ok('Deposit: banks 2 drops, amount 500, BDEP- + JE-', /^BDEP-/.test(dep.json.deposit_no ?? '') && near(dep.json.amount, 500) && dep.json.drops_banked === 2 && /^JE-/.test(dep.json.journal_no ?? ''), JSON.stringify(dep.json).slice(0, 110));
  ok('Deposit GL: Dr 1010 Bank 500 / Cr 1000 Cash 500', near(await gl('1010'), 500) && near(await gl('1000'), -500), `1010=${await gl('1010')} 1000=${await gl('1000')}`);

  // ── 4. drops are now banked → cash-in-safe back to 0 ──
  const und2 = await inj('GET', '/api/bank/deposits/undeposited-drops', fin1);
  ok('After banking: cash-in-safe 0 (no undeposited drops)', und2.json.count === 0 && near(und2.json.total, 0), JSON.stringify(und2.json).slice(0, 60));

  // ── 5. re-banking with nothing to bank → 400 NO_DROPS ──
  const empty = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id });
  ok('Re-bank with no drops → 400 NO_DROPS', empty.status === 400 && empty.json.error?.code === 'NO_DROPS', `${empty.status} ${empty.json.error?.code}`);

  // ── 6. reconcile the deposit to the bank statement ──
  const depId = Number((await db.select().from(s.bankDeposits).where(eq(s.bankDeposits.tenantId, t1)))[0].id);
  const rec = await inj('POST', `/api/bank/deposits/${depId}/reconcile`, fin1);
  const reRec = await inj('POST', `/api/bank/deposits/${depId}/reconcile`, fin1);
  ok('Reconcile: deposit → Reconciled; re-reconcile rejected (400)', rec.json.status === 'Reconciled' && reRec.status === 400 && reRec.json.error?.code === 'ALREADY_RECONCILED', `${rec.json.status} / ${reRec.json.error?.code}`);

  // ── 7. list: 1 deposit, 0 unreconciled, cash-in-safe 0 ──
  const list = await inj('GET', '/api/bank/deposits', fin1);
  ok('List: 1 deposit, 0 unreconciled, cash-in-safe 0', list.json.count === 1 && list.json.unreconciled === 0 && near(list.json.cash_in_safe, 0), JSON.stringify({ c: list.json.count, u: list.json.unreconciled }));

  // ── 8. trial balance balanced ──
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json;
  ok('Trial balance balanced after banking', tb.totals?.balanced === true, JSON.stringify(tb.totals ?? {}));

  // ── 9. PR0.1 SQLi regression: subset banking via movement_nos binds values (inArray), never a raw ──
  //      ARRAY literal. A movement_no containing an apostrophe would have broken the old `'${..}'` build.
  const evilNo = "CASHMOV-EVIL-1' OR '1'='1";
  await db.insert(s.cashMovements).values([
    { movementNo: evilNo, tenantId: t1, tillSessionId: tillId, type: 'drop', amount: '111.0000', reason: 'inj', createdBy: 'cash1' },
    { movementNo: 'CASHMOV-NORMAL-2', tenantId: t1, tillSessionId: tillId, type: 'drop', amount: '222.0000', reason: 'ฝากเซฟ', createdBy: 'cash1' },
  ]);
  // bank ONLY the apostrophe-bearing drop by its movement_no — must bank exactly it (111), not all.
  const subset = await inj('POST', '/api/bank/deposits', fin1, { bank_account_id: bank.json.id, movement_nos: [evilNo] });
  ok('Subset bank with apostrophe movement_no: only chosen drop banked (111, n=1)', near(subset.json.amount, 111) && subset.json.drops_banked === 1, JSON.stringify({ a: subset.json.amount, n: subset.json.drops_banked }));
  // no injection: the other drop is untouched and the table is intact (cash-in-safe = 222, 1 drop).
  const undAfter = (await inj('GET', '/api/bank/deposits/undeposited-drops', fin1)).json;
  ok('No SQLi: untargeted drop survives, table intact (1 drop, 222 in safe)', undAfter.count === 1 && near(undAfter.total, 222), JSON.stringify({ c: undAfter.count, t: undAfter.total }));

  // ── POS-8 (control POS-08): PromptPay store-level auto-reconciliation ──
  // Match the store's PromptPay tenders to the bank-statement INFLOWS on its settlement account (reusing the
  // bank auto-match engine), surfacing unmatched tenders as a till exception (mirrors the till-variance surface).
  // Store-tenant actors: gl1 (recon_prep) prepares the reconciliation; cash1 (pos_close) clears exceptions;
  // sell1 (pos_sell only) is denied. All in t1 — this is a store-level control (admin is HQ, wrong tenant).
  await db.insert(s.users).values([
    { username: 'sell1', passwordHash: await pw.hash('ps1'), role: 'Cashier', tenantId: t1 },
    { username: 'gl1', passwordHash: await pw.hash('pg1'), role: 'GlAccountant', tenantId: t1 },
  ]).onConflictDoNothing();
  const sell1 = await login('sell1', 'ps1');
  const gl1 = await login('gl1', 'pg1');

  // Configure the store's PromptPay settlement account = the approved KBank account (GL 1010).
  const setAcct = await inj('PUT', '/api/pos/promptpay-recon/settlement-account', gl1, { bank_account_id: bank.json.id });
  ok('POS-8: settlement account mapped for the store', setAcct.status === 200 && setAcct.json.bank_account_id === bank.json.id, JSON.stringify(setAcct.json).slice(0, 80));
  // a sell-only cashier (pos_sell, no recon_prep/pos_close/exec) cannot run the reconciliation
  const denyRun = await inj('POST', '/api/pos/promptpay-recon/run', sell1, { recon_date: '2026-06-27' });
  ok('POS-8: a pos_sell-only cashier cannot run the reconciliation (403)', denyRun.status === 403, `${denyRun.status}`);

  // Seed 2 PromptPay tenders on 2026-06-27: 500 (will settle) + 300 (no inflow yet → exception).
  await db.insert(s.payments).values([
    { paymentNo: 'PAY-PP-500', saleNo: 'SALE-PP-500', tenantId: t1, method: 'PromptPay', amount: '500.0000', gateway: 'promptpay', gatewayRef: 'PPREF500', status: 'Pending', createdBy: 'cash1', createdAt: new Date('2026-06-27T04:00:00Z') },
    { paymentNo: 'PAY-PP-300', saleNo: 'SALE-PP-300', tenantId: t1, method: 'PromptPay', amount: '300.0000', gateway: 'promptpay', gatewayRef: 'PPREF300', status: 'Pending', createdBy: 'cash1', createdAt: new Date('2026-06-27T05:00:00Z') },
  ]);
  // Import the bank statement: one inflow (500) whose narration carries the payer-ref; the 300 has none.
  await inj('POST', `/api/bank/accounts/${bank.json.id}/statements`, fin1, { statement_date: '2026-06-27', opening_bal: 0, closing_bal: 500, lines: [
    { date: '2026-06-27', amount: 500, description: 'PromptPay รับโอน PPREF500' },
  ] });

  // Run 1 — 1 matched (500), 1 unmatched tender (300) → 1 open exception.
  const run1 = await inj('POST', '/api/pos/promptpay-recon/run', gl1, { recon_date: '2026-06-27' });
  ok('POS-8: inflow→sale match — 1 PromptPay tender matched (500), 1 unmatched (300)',
    run1.status === 200 && run1.json.matched === 1 && near(run1.json.matched_amount, 500) && run1.json.unmatched_tenders === 1,
    JSON.stringify({ m: run1.json.matched, ma: run1.json.matched_amount, u: run1.json.unmatched_tenders }));
  ok('POS-8: unmatched→exception — the 300 tender is surfaced as an exception', (run1.json.exceptions ?? []).some((e: any) => e.payment_no === 'PAY-PP-300' && near(e.amount, 300)), JSON.stringify(run1.json.exceptions));
  // the matched inflow line is now reconciled against the tender's payment_no (bank engine recorded the match)
  const recPP = await inj('GET', `/api/bank/accounts/${bank.json.id}/reconciliation`, fin1);
  ok('POS-8: matched inflow line reconciled (no unmatched 500 statement line left)', !(recPP.json.unmatched_statement ?? []).some((l: any) => near(l.amount, 500)), JSON.stringify((recPP.json.unmatched_statement ?? []).map((l: any) => l.amount)));
  const exList = await inj('GET', '/api/pos/promptpay-recon/exceptions?status=Open', gl1);
  ok('POS-8: open-exception worklist lists the unsettled 300 tender', exList.json.open === 1 && (exList.json.exceptions ?? []).some((e: any) => e.payment_no === 'PAY-PP-300'), JSON.stringify({ open: exList.json.open }));

  // Late inflow arrives for the 300 → re-run auto-matches it and auto-resolves its open exception.
  await inj('POST', `/api/bank/accounts/${bank.json.id}/statements`, fin1, { statement_date: '2026-06-28', opening_bal: 500, closing_bal: 800, lines: [
    { date: '2026-06-28', amount: 300, description: 'PromptPay รับโอน PPREF300' },
  ] });
  const run2 = await inj('POST', '/api/pos/promptpay-recon/run', gl1, { recon_date: '2026-06-27' });
  ok('POS-8: late inflow re-run matches the 300 (idempotent — 500 not re-matched)', run2.json.matched === 1 && near(run2.json.matched_amount, 300), JSON.stringify({ m: run2.json.matched, ma: run2.json.matched_amount }));
  const exOpen2 = await inj('GET', '/api/pos/promptpay-recon/exceptions?status=Open', gl1);
  ok('POS-8: the 300 open exception auto-resolves once its inflow lands (0 open)', exOpen2.json.open === 0, JSON.stringify({ open: exOpen2.json.open }));

  // Manual clear path: a fresh unmatched tender → a manager (pos_close) clears the exception.
  await db.insert(s.payments).values({ paymentNo: 'PAY-PP-700', saleNo: 'SALE-PP-700', tenantId: t1, method: 'PromptPay', amount: '700.0000', gateway: 'promptpay', gatewayRef: 'PPREF700', status: 'Pending', createdBy: 'cash1', createdAt: new Date('2026-06-27T06:00:00Z') });
  await inj('POST', '/api/pos/promptpay-recon/run', gl1, { recon_date: '2026-06-27' });
  const openBefore = (await inj('GET', '/api/pos/promptpay-recon/exceptions?status=Open', cash1)).json;
  const exId = openBefore.exceptions.find((e: any) => e.payment_no === 'PAY-PP-700').id;
  const cleared = await inj('POST', `/api/pos/promptpay-recon/exceptions/${exId}/clear`, cash1, { note: 'confirmed off-system' });
  ok('POS-8: a manager (pos_close) clears a PromptPay till exception → Resolved', cleared.status === 200 && cleared.json.status === 'Resolved' && cleared.json.resolved_by === 'cash1', JSON.stringify(cleared.json).slice(0, 90));
  const openAfter = (await inj('GET', '/api/pos/promptpay-recon/exceptions?status=Open', cash1)).json;
  ok('POS-8: cleared exception drops off the open worklist', openAfter.open === 0, JSON.stringify({ open: openAfter.open }));

  await app.close();
  await pg.close();
  console.log('\n── Bank Cash banking: safe-drop → deposit + reconciliation (นำฝากธนาคาร) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} cash-banking checks failed` : `\n✅ All ${checks.length} cash-banking checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
