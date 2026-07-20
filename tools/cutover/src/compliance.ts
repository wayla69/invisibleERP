/**
 * COSO / ICFR control test harness — Test of Operating Effectiveness (ToE) evidence for the key
 * SOX controls an external IT auditor will test directly. Boots the real Nest app over PGlite (a real
 * Postgres) and asserts the controls actually PREVENT the risk, not just that the code compiles.
 *
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover compliance
 *
 * Controls covered (see compliance/Oshinei_ERP_SOX_RCM_v1.xlsx):
 *   GL-05  — Manual journal-entry maker-checker: a manual JE posts as Draft (excluded from balances)
 *            and only a DIFFERENT user may approve it; preparer self-approval is blocked even for Admin.
 *   GL-11  — Chart-of-Accounts change control: canonical (`accounts`, shared universe) writes are a platform
 *            Admin/HQ duty (a tenant gl_coa holder is blocked, COA_ADMIN_ONLY); per-tenant chart curation
 *            (`tenant_accounts` overlay) is a gl_coa duty scoped to the caller's own tenant (RLS); duplicate
 *            code (DUPLICATE_ACCOUNT) + deactivate-with-balance (ACCOUNT_HAS_BALANCE) are refused.
 *   EXP-01/EXP-09 — 3-way match HARD-GATES AP payment: a PO-based invoice failing match (price/qty variance)
 *            is blocked from payment (MATCH_BLOCKED) until a DIFFERENT user overrides the variance (SoD).
 *            (PwC panel called this "EXP-03"; see compliance/CONTROL_STATUS_HONEST.md for the ID crosswalk.)
 *   EXP-10 — AP invoice intake: a scanned invoice is auto-mapped to its PO and 3-way matched IN the posting
 *            flow (never books unmatched); a duplicate vendor invoice number is refused (DUPLICATE_INVOICE).
 *   PAY-03 — Payroll run maker-checker: a run posts a Draft JE excluded from balances until a different user approves.
 *   ITGC-AC-09 — SoD preventive block: assigning a permission set that holds both sides of a conflict
 *            rule is blocked unless an explicit override-with-reason is supplied (and logged).
 *   ITGC-AC-08 — User Access Review: effective-permission recertification report, CSV export, sign-off.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'compliance-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { BillingService } from '../../../apps/api/dist/modules/billing/billing.service';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';
import { authenticator } from 'otplib';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'glacct', passwordHash: await pw.hash('pw'), role: 'GlAccountant', tenantId: t1 },      // gl_post (preparer)
    { username: 'fincon', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t1 }, // gl_close + approvals (checker)
    { username: 'execu', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t1 },              // legacy 'exec' → holds BOTH gl_post and gl_close (residual-risk case maker-checker backstops)
    { username: 'finT2', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t2 },        // tenant-2 finance reader (creditors/ar) — RLS isolation probe
    { username: 'fsT2', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t2 }, // tenant-2 fin_report holder — GL-29 RLS isolation probe
    { username: 'apclerk', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: t1 },          // creditors only — AP-PAY maker
    { username: 'apdual', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 },       // creditors + approvals — residual self-approval case
    { username: 'payprep', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },            // PAY-03 payroll preparer (t1)
    { username: 'paychk', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },             // PAY-03 payroll approver (t1, ≠ preparer)
    { username: 'whchk', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },              // INV-07 write-off approver (hq, ≠ admin)
    { username: 'whrecv', passwordHash: await pw.hash('pw'), role: 'WarehouseOperator', tenantId: hq }, // EXP-12 receiver — wh_receive only (no procurement/exec)
    { username: 'staleadmin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq },         // AC-02/03 live-role probe: Admin (HQ) later downgraded mid-token to verify RLS bypass follows the DB
  ]).onConflictDoNothing();
  // The Procurement role default is now SoD-clean (procurement/pr_raise only). These residual-risk
  // fixtures deliberately hold conflicting duties, granted via an explicit per-user override (overrides
  // take precedence over the role default — see resolvePermissions): finT2 = a t2 finance reader
  // (creditors/ar) for the RLS probe; apdual = a single holder of BOTH creditors + approvals.
  for (const [un, perms] of [['finT2', ['creditors', 'ar']], ['apdual', ['creditors', 'approvals']]] as const) {
    const uid = Number((await db.select().from(s.users).where(eq(s.users.username, un)))[0].id);
    await db.insert(s.userPermissions).values(perms.map((perm) => ({ userId: uid, perm }))).onConflictDoNothing();
  }

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  await app.get(BillingService).seedPlans();

  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; let text = '';
    try { text = res.body; } catch { /* */ }
    try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json, text };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const glacct = await login('glacct', 'pw');
  const fincon = await login('fincon', 'pw');
  const execu = await login('execu', 'pw');
  const finT2 = await login('finT2', 'pw');
  const apclerk = await login('apclerk', 'pw');
  const apdual = await login('apdual', 'pw');

  // Trial-balance credit on a given account in a period (read as Admin — bypasses RLS; only our JEs exist).
  const tbCredit = async (period: string, account: string): Promise<number> => {
    const tb = await inj('GET', `/api/ledger/trial-balance?period=${period}`, admin);
    const row = (tb.json.rows ?? []).find((r: any) => r.account_code === account);
    return row ? Number(row.credit) : 0;
  };
  const tbDebit = async (period: string, account: string): Promise<number> => {
    const tb = await inj('GET', `/api/ledger/trial-balance?period=${period}`, admin);
    const row = (tb.json.rows ?? []).find((r: any) => r.account_code === account);
    return row ? Number(row.debit) : 0;
  };

  // ════════════════════════ GL-05 — Manual journal-entry maker-checker ════════════════════════
  const amt = 1234;
  const today = new Date().toISOString().slice(0, 10);
  const period = today.slice(0, 7);

  // 1. A manual JE posts as DRAFT (pending) — not Posted.
  const je = await inj('POST', '/api/ledger/journal', glacct, {
    date: today, memo: 'ToE manual JE', source: 'Manual',
    lines: [{ account_code: '1000', debit: amt }, { account_code: '4000', credit: amt }],
  });
  const entryNo = je.json.entry_no as string;
  ok('GL-05: manual JE posts as Draft (pending approval), not Posted',
    (je.status === 200 || je.status === 201) && je.json.status === 'Draft' && je.json.pending === true && !!entryNo, JSON.stringify(je.json));

  // 2. A Draft JE is EXCLUDED from balances (trial balance) until approved.
  const beforeCredit = await tbCredit(period, '4000');
  ok('GL-05: Draft JE excluded from trial balance (no balance impact until approved)', beforeCredit === 0, `4000 credit=${beforeCredit}`);

  // 3. It appears in the pending-approval queue.
  const pend = await inj('GET', '/api/ledger/journal/pending', fincon);
  ok('GL-05: Draft JE listed in pending-approval queue', (pend.json.entries ?? []).some((e: any) => e.entry_no === entryNo), `pending=${(pend.json.entries ?? []).length}`);

  // 4. Maker cannot approve their OWN entry → 403 SOD_VIOLATION (preparer ≠ approver). Uses an 'exec'
  //    holder who is AUTHORIZED to approve yet is the preparer — the residual case the maker-checker
  //    backstops (a preparer-only role like GlAccountant is already blocked one layer earlier, at the guard).
  const jeSelf = await inj('POST', '/api/ledger/journal', execu, {
    date: today, memo: 'self-approve attempt', source: 'Manual',
    lines: [{ account_code: '1000', debit: 99 }, { account_code: '4000', credit: 99 }],
  });
  const selfApprove = await inj('POST', `/api/ledger/journal/${jeSelf.json.entry_no}/approve`, execu);
  ok('GL-05: preparer self-approval blocked → 403 SOD_VIOLATION (holder of both duties)', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_VIOLATION', `${selfApprove.status} ${selfApprove.json.error?.code}`);

  // 5. A DIFFERENT user (gl_close/approvals) approves → Posted, now hits the balances.
  const approve = await inj('POST', `/api/ledger/journal/${entryNo}/approve`, fincon);
  const afterCredit = await tbCredit(period, '4000');
  ok('GL-05: independent approver posts the JE → Posted + balance now reflected',
    approve.status === 200 && approve.json.status === 'Posted' && approve.json.approved_by === 'fincon' && afterCredit === amt, `${approve.json.status} 4000credit=${afterCredit}`);

  // 6. Reject path: a second draft → Voided, no balance impact.
  const je2 = await inj('POST', '/api/ledger/journal', glacct, {
    date: today, memo: 'ToE reject', source: 'Manual',
    lines: [{ account_code: '1000', debit: 500 }, { account_code: '5100', credit: 500 }],
  });
  const reject = await inj('POST', `/api/ledger/journal/${je2.json.entry_no}/reject`, fincon, { reason: 'unsupported' });
  const rejectedCredit = await tbCredit(period, '5100');
  ok('GL-05: reject → Voided, never affects balances', reject.status === 200 && reject.json.status === 'Voided' && rejectedCredit === 0, `${reject.json.status} 5100credit=${rejectedCredit}`);

  // 7. Maker-checker binds even Admin: Admin cannot approve a JE Admin prepared.
  const adminJe = await inj('POST', '/api/ledger/journal', admin, {
    date: today, memo: 'admin self', source: 'Manual',
    lines: [{ account_code: '1000', debit: 10 }, { account_code: '4000', credit: 10 }],
  });
  const adminSelf = await inj('POST', `/api/ledger/journal/${adminJe.json.entry_no}/approve`, admin);
  ok('GL-05: maker-checker binds even Admin (no self-approve override)', adminSelf.status === 403 && adminSelf.json.error?.code === 'SOD_VIOLATION', `${adminSelf.status} ${adminSelf.json.error?.code}`);

  // ════════════════════════ GL-29 — Financial-statement issuance review & approval (maker-checker) ════════════════════════
  // A preparer submits a fiscal year's statements (snapshot + hash of the key figures); a DIFFERENT user
  // approves; the formatted FS pack then stamps "reviewed & approved" (vs "unaudited"), and flips to
  // "re-review required" if the live GL figures later drift from the approved snapshot. Tenant-scoped (RLS).
  const fsFy = Number(today.slice(0, 4));
  const fsSubmit = await inj('POST', '/api/reports/fs/statement-pack/submit', glacct, { fiscal_year: fsFy });
  ok('GL-29: preparer submits the FS pack → PendingApproval with a figures snapshot',
    fsSubmit.status === 201 && fsSubmit.json.status === 'PendingApproval' && fsSubmit.json.prepared_by === 'glacct' && typeof fsSubmit.json.figures?.total_assets === 'number',
    `${fsSubmit.status} st=${fsSubmit.json.status} by=${fsSubmit.json.prepared_by}`);
  const fsrId = fsSubmit.json.id;
  const fsSelf = await inj('POST', `/api/reports/fs/statement-reviews/${fsrId}/approve`, glacct);
  ok('GL-29: preparer self-approval blocked → 403 SOD_VIOLATION (maker ≠ checker)',
    fsSelf.status === 403 && fsSelf.json.error?.code === 'SOD_VIOLATION', `${fsSelf.status} ${fsSelf.json.error?.code}`);
  const fsAppr = await inj('POST', `/api/reports/fs/statement-reviews/${fsrId}/approve`, fincon);
  ok('GL-29: a DIFFERENT user approves → Approved (approved_by recorded)',
    fsAppr.status === 201 && fsAppr.json.status === 'Approved' && fsAppr.json.approved_by === 'fincon', `${fsAppr.status} st=${fsAppr.json.status} by=${fsAppr.json.approved_by}`);
  const fsReAppr = await inj('POST', `/api/reports/fs/statement-reviews/${fsrId}/approve`, fincon);
  ok('GL-29: re-approving an approved review → 400 FS_REVIEW_NOT_PENDING', fsReAppr.status === 400 && fsReAppr.json.error?.code === 'FS_REVIEW_NOT_PENDING', `${fsReAppr.status} ${fsReAppr.json.error?.code}`);
  const packApproved: string = (await inj('GET', `/api/reports/fs/statement-pack.pdf?fiscal_year=${fsFy}`, fincon)).text ?? '';
  ok('GL-29: the FS pack stamps "reviewed & approved by <checker>" (not "unaudited")',
    /Reviewed &amp; approved by fincon/.test(packApproved) && !/Unaudited — management accounts/.test(packApproved),
    `approvedStamp=${/Reviewed &amp; approved by fincon/.test(packApproved)}`);
  // Tamper: post a further JE into the fiscal year → the approved snapshot no longer matches the live figures.
  const fsTamperJe = await inj('POST', '/api/ledger/journal', glacct, { date: today, memo: 'post-approval movement', source: 'Manual', lines: [{ account_code: '1000', debit: 555 }, { account_code: '4000', credit: 555 }] });
  await inj('POST', `/api/ledger/journal/${fsTamperJe.json.entry_no}/approve`, fincon);
  const packStale: string = (await inj('GET', `/api/reports/fs/statement-pack.pdf?fiscal_year=${fsFy}`, fincon)).text ?? '';
  ok('GL-29: figures drift after approval → the pack flips to "re-review required" (tamper-evident)',
    /re-review required/.test(packStale) && !/Reviewed &amp; approved by fincon/.test(packStale), `reReview=${/re-review required/.test(packStale)}`);
  const fsT2 = await login('fsT2', 'pw');
  ok('GL-29: statement reviews are tenant-isolated — another tenant sees 0 (RLS)',
    Array.isArray((await inj('GET', '/api/reports/fs/statement-reviews', fsT2)).json) && (await inj('GET', '/api/reports/fs/statement-reviews', fsT2)).json.length === 0, 'rls');

  // ════════════════════════ AP-PAY — AP disbursement maker-checker ════════════════════════
  // A vendor payment must be REQUESTED by a `creditors` holder and APPROVED by a DIFFERENT user with
  // approval authority; the bill's paid_amount and the cash GL only move on approval. Mirrors GL-05.
  const apPaid = async (txnNo: string): Promise<number> => Number((await db.select().from(s.apTransactions).where(eq(s.apTransactions.txnNo, txnNo)))[0]?.paidAmount ?? 0);
  const payApDebit = async (): Promise<number> => {
    const jes = await db.select().from(s.journalEntries).where(eq(s.journalEntries.source, 'PAY-AP'));
    if (!jes.length) return 0;
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, jes[0].id));
    return lines.filter((l: any) => l.accountCode === '2000').reduce((a: number, l: any) => a + Number(l.debit), 0);
  };

  // 0. A bill cannot be booked pre-paid in one call (would disburse with no approval).
  const prepaid = await inj('POST', '/api/finance/ap/transactions', apclerk, { vendor_name: 'Acme', amount: 500, paid_amount: 500 });
  ok('AP-PAY: pre-paid bill creation blocked → 400 AP_PREPAID_BLOCKED', prepaid.status === 400 && prepaid.json.error?.code === 'AP_PREPAID_BLOCKED', `${prepaid.status} ${prepaid.json.error?.code}`);

  // 1. Maker creates an Unpaid bill, then requests payment → PendingApproval (no cash/GL effect).
  const bill = await inj('POST', '/api/finance/ap/transactions', apclerk, { vendor_name: 'Acme', amount: 1000 });
  const apNo = bill.json.txn_no as string;
  const reqPay = await inj('PATCH', `/api/finance/ap/transactions/${apNo}/pay`, apclerk, { amount: 1000 });
  const appNo = reqPay.json.payment_no as string;
  ok('AP-PAY: payment request posts as PendingApproval (no disbursement yet)',
    (reqPay.status === 200 || reqPay.status === 201) && reqPay.json.status === 'PendingApproval' && !!appNo && (await apPaid(apNo)) === 0 && (await payApDebit()) === 0, `${reqPay.json.status} paid=${await apPaid(apNo)}`);

  // 2. It appears in the checker queue.
  const queue = await inj('GET', '/api/finance/ap/payments/pending', fincon);
  ok('AP-PAY: pending payment listed in the checker queue', (queue.json.payments ?? []).some((p: any) => p.payment_no === appNo), `pending=${(queue.json.payments ?? []).length}`);

  // 3. Maker (creditors only) lacks approval authority → 403 (FORBIDDEN at the guard).
  const makerApprove = await inj('POST', `/api/finance/ap/payments/${appNo}/approve`, apclerk);
  ok('AP-PAY: maker (creditors only) cannot approve → 403', makerApprove.status === 403, `${makerApprove.status} ${makerApprove.json.error?.code}`);

  // 4. Residual case — a user holding BOTH creditors AND approvals cannot approve their OWN request.
  const dualBill = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_name: 'SelfCo', amount: 200 });
  const dualReq = await inj('PATCH', `/api/finance/ap/transactions/${dualBill.json.txn_no}/pay`, apdual, { amount: 200 });
  const dualSelf = await inj('POST', `/api/finance/ap/payments/${dualReq.json.payment_no}/approve`, apdual);
  ok('AP-PAY: requester self-approval blocked → 403 SOD_VIOLATION (holder of both duties)', dualSelf.status === 403 && dualSelf.json.error?.code === 'SOD_VIOLATION', `${dualSelf.status} ${dualSelf.json.error?.code}`);

  // 5. A DIFFERENT authorized user approves → bill Paid + cash-disbursement GL posts (Dr 2000 / Cr 1000).
  const approveAp = await inj('POST', `/api/finance/ap/payments/${appNo}/approve`, fincon);
  ok('AP-PAY: independent approver disburses → Approved, bill Paid, GL Dr 2000 = 1000',
    approveAp.status === 200 && approveAp.json.status === 'Approved' && approveAp.json.bill_status === 'Paid' && approveAp.json.approved_by === 'fincon' && (await apPaid(apNo)) === 1000 && (await payApDebit()) === 1000,
    `${approveAp.json.status}/${approveAp.json.bill_status} paid=${await apPaid(apNo)} dr2000=${await payApDebit()}`);

  // 6. Reject path — a fresh request rejected → no disbursement.
  const billR = await inj('POST', '/api/finance/ap/transactions', apclerk, { vendor_name: 'RejCo', amount: 300 });
  const reqR = await inj('PATCH', `/api/finance/ap/transactions/${billR.json.txn_no}/pay`, apclerk, { amount: 300 });
  const rejectAp = await inj('POST', `/api/finance/ap/payments/${reqR.json.payment_no}/reject`, fincon, { reason: 'duplicate' });
  ok('AP-PAY: reject → Rejected, bill stays Unpaid (no disbursement)', rejectAp.status === 200 && rejectAp.json.status === 'Rejected' && (await apPaid(billR.json.txn_no)) === 0, `${rejectAp.json.status} paid=${await apPaid(billR.json.txn_no)}`);

  // 7. Maker-checker binds even Admin: Admin cannot approve a payment Admin requested.
  const adminBill = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_name: 'AdminCo', amount: 100 });
  const adminReq = await inj('PATCH', `/api/finance/ap/transactions/${adminBill.json.txn_no}/pay`, admin, { amount: 100 });
  const adminApprove = await inj('POST', `/api/finance/ap/payments/${adminReq.json.payment_no}/approve`, admin);
  ok('AP-PAY: maker-checker binds even Admin (no self-approve override)', adminApprove.status === 403 && adminApprove.json.error?.code === 'SOD_VIOLATION', `${adminApprove.status} ${adminApprove.json.error?.code}`);

  // ════════════════════════ EXP-13 — AP payment run + bank file (maker-checker · match gate · idempotent execute · hash-pinned file · clearing) ════════════════════════
  // A batch disbursement run: propose by due-date cutoff (creditors) → distinct approver (SOD) → execute
  // through the EXISTING per-payment path (same GL + WHT postings, idempotent per line) → bank bulk-transfer
  // file (SHA-256 pinned) → bank-statement auto-match clears the lines.
  const bizToday = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // business day (UTC+7)
  // Fixtures: vendor with bank details (file beneficiary), vendor without (fail-closed negative),
  // an Approved house-bank on GL 1000 (created by execu, approved by fincon — G9 maker-checker).
  const [rv1] = await db.insert(s.vendors).values({ tenantId: t1, vendorCode: 'RUNV1', name: 'บจก. รันเพย์ ซัพพลาย', bankName: 'ธนาคารกสิกรไทย', bankAccount: '0123456789' }).returning({ id: s.vendors.id });
  const [rv2] = await db.insert(s.vendors).values({ tenantId: t1, vendorCode: 'RUNV2', name: 'บจก. ไร้บัญชี' }).returning({ id: s.vendors.id });
  const bankReq = await inj('POST', '/api/bank/accounts', execu, { bank_name: 'KBank', account_no: '012-3-45678-9', gl_account_code: '1000', currency: 'THB', opening_balance: 0 });
  const bankId = Number(bankReq.json.id);
  await inj('POST', `/api/bank/accounts/${bankId}/approve`, fincon);
  // Bills: B1 (no WHT), B2 (WHT set on the line), B3 blocked by a failed 3-way match, B4 (vendor w/o bank).
  const b1 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv1.id), vendor_name: 'บจก. รันเพย์ ซัพพลาย', amount: 1070.11, due_date: bizToday });
  const b2 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv1.id), vendor_name: 'บจก. รันเพย์ ซัพพลาย', amount: 535, due_date: bizToday });
  const b3 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv1.id), vendor_name: 'บจก. รันเพย์ ซัพพลาย', amount: 999, due_date: bizToday });
  const b4 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv2.id), vendor_name: 'บจก. ไร้บัญชี', amount: 250, due_date: bizToday });
  await db.insert(s.invoiceMatchResults).values({ tenantId: t1, matchNo: 'MAT-EXP13', txnNo: b3.json.txn_no, poNo: 'PO-EXP13', matchStatus: 'price_variance', payable: false, override: false, matchedBy: 'glacct' });

  // 1. Propose (maker): B1+B2 selected (B4 filtered out by vendor filter later; B3 skipped MATCH_BLOCKED).
  const r1 = await inj('POST', '/api/finance/ap/payment-runs/propose', apdual, { due_cutoff: bizToday, bank_account_id: bankId, vendor_ids: [Number(rv1.id)] });
  const runNo = r1.json.run_no as string;
  ok('EXP-13: propose selects open approved AP by due-date cutoff; a match-BLOCKED invoice is skipped',
    (r1.status === 200 || r1.status === 201) && r1.json.status === 'Draft' && r1.json.line_count === 2
      && (r1.json.skipped ?? []).some((x: any) => x.txn_no === b3.json.txn_no && x.reason === 'MATCH_BLOCKED'),
    `${r1.status} lines=${r1.json.line_count} skipped=${JSON.stringify(r1.json.skipped)}`);

  // 2. Edit while Draft: put 3% WHT on B2's line (same resolution + formula as a manual payment).
  const l2 = (r1.json.lines ?? []).find((l: any) => l.txn_no === b2.json.txn_no);
  const edit = await inj('PATCH', `/api/finance/ap/payment-runs/${runNo}/lines`, apdual, { update: [{ line_id: l2.line_id, wht_rate: 0.03, wht_income_type: 'ค่าบริการ' }] });
  const l2e = (edit.json.lines ?? []).find((l: any) => l.txn_no === b2.json.txn_no);
  ok('EXP-13: Draft line edit sets WHT on the pre-VAT base (535 gross → base 500 → WHT 15, net 520)',
    edit.status === 200 && l2e?.wht_amount === 15 && l2e?.net_amount === 520 && edit.json.total_net === 1590.11,
    `wht=${l2e?.wht_amount} net=${l2e?.net_amount} total_net=${edit.json.total_net}`);

  // 3. Submit → PendingApproval; lines are LOCKED (edit → 400 NOT_DRAFT).
  await inj('POST', `/api/finance/ap/payment-runs/${runNo}/submit`, apdual);
  const editLocked = await inj('PATCH', `/api/finance/ap/payment-runs/${runNo}/lines`, apdual, { remove_line_ids: [l2.line_id] });
  ok('EXP-13: lines are editable only while Draft (post-submit edit → 400 NOT_DRAFT)', editLocked.status === 400 && editLocked.json.error?.code === 'NOT_DRAFT', `${editLocked.status} ${editLocked.json.error?.code}`);

  // 4. Proposer self-approval blocked (holder of BOTH creditors + approvals) → 403 SOD_VIOLATION.
  const runSelfApprove = await inj('POST', `/api/finance/ap/payment-runs/${runNo}/approve`, apdual);
  ok('EXP-13: proposer cannot approve their own run → 403 SOD_VIOLATION', runSelfApprove.status === 403 && runSelfApprove.json.error?.code === 'SOD_VIOLATION', `${runSelfApprove.status} ${runSelfApprove.json.error?.code}`);

  // 5. A DIFFERENT approver approves; the proposer STILL cannot execute (cash release is a checker act).
  const runApprove = await inj('POST', `/api/finance/ap/payment-runs/${runNo}/approve`, fincon);
  const selfExec = await inj('POST', `/api/finance/ap/payment-runs/${runNo}/execute`, apdual);
  ok('EXP-13: independent approver approves; proposer execute → 403 SOD_VIOLATION',
    runApprove.status === 200 && runApprove.json.status === 'Approved' && selfExec.status === 403 && selfExec.json.error?.code === 'SOD_VIOLATION',
    `${runApprove.json.status} exec=${selfExec.status} ${selfExec.json.error?.code}`);

  // 6. Execute (checker) — each line rides the EXISTING requestApPayment→approveApPayment path:
  //    bills settle, WHT 2361 credited per line, cash out net, TB stays balanced.
  const runPeriod = bizToday.slice(0, 7);
  const wht2361Before = await tbCredit(runPeriod, '2361');
  const exec1 = await inj('POST', `/api/finance/ap/payment-runs/${runNo}/execute`, fincon);
  const wht2361After = await tbCredit(runPeriod, '2361');
  const b1After = await apPaid(b1.json.txn_no);
  const b2After = await apPaid(b2.json.txn_no);
  const tbAll = await inj('GET', `/api/ledger/trial-balance?period=${runPeriod}`, admin);
  const drSum = (tbAll.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.debit), 0);
  const crSum = (tbAll.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.credit), 0);
  ok('EXP-13: execute posts through the manual path — bills Paid, WHT 2361 credited (15), TB balanced',
    exec1.status === 200 && exec1.json.status === 'Executed' && exec1.json.paid === 2 && exec1.json.failed === 0
      && b1After === 1070.11 && b2After === 535 && Math.abs(wht2361After - wht2361Before - 15) < 0.01
      && Math.abs(drSum - crSum) < 0.01,
    `paid=${exec1.json.paid} b1=${b1After} b2=${b2After} d2361=${(wht2361After - wht2361Before).toFixed(2)} tbΔ=${(drSum - crSum).toFixed(2)}`);

  // 7. Double-execute is a NO-OP (idempotent per line): no second PAY-AP posting, paid amounts unchanged.
  const exec2 = await inj('POST', `/api/finance/ap/payment-runs/${runNo}/execute`, fincon);
  const payApJes = await db.select().from(s.journalEntries).where(eq(s.journalEntries.source, 'PAY-AP'));
  const runJes = payApJes.filter((j: any) => String(j.sourceRef ?? '').startsWith(b1.json.txn_no + ':p:') || String(j.sourceRef ?? '').startsWith(b2.json.txn_no + ':p:'));
  ok('EXP-13: re-execute is idempotent — no duplicate disbursement (2 PAY-AP entries stay 2)',
    exec2.status === 200 && exec2.json.idempotent === true && runJes.length === 2 && (await apPaid(b1.json.txn_no)) === 1070.11,
    `idem=${exec2.json.idempotent} payap=${runJes.length}`);

  // 8. Bank bulk-transfer file (kbank preset): H/D/T records, SHA-256 pinned on the run + status-logged.
  const fileRes = await app.inject({ method: 'GET', url: `/api/finance/ap/payment-runs/${runNo}/bank-file?format=kbank`, headers: { authorization: `Bearer ${fincon}` } });
  const fileBody = fileRes.body;
  const fileSha = createHash('sha256').update(fileBody, 'utf8').digest('hex');
  const runAfterFile = await inj('GET', `/api/finance/ap/payment-runs/${runNo}`, fincon);
  const shaLog = await db.select().from(s.docStatusLog).where(eq(s.docStatusLog.docNo, runNo));
  ok('EXP-13: bank file has header/detail/trailer + beneficiary account; SHA-256 pinned on the run and status-logged',
    fileRes.statusCode === 200 && fileBody.startsWith(`H,${runNo},`) && fileBody.includes('0123456789') && fileBody.includes('T,2,1590.11')
      && runAfterFile.json.file_hash === fileSha && runAfterFile.json.file_format === 'kbank'
      && shaLog.some((x: any) => String(x.remarks ?? '').includes(`sha256=${fileSha}`)),
    `st=${fileRes.statusCode} hash_ok=${runAfterFile.json.file_hash === fileSha}`);

  // 9. ISO 20022 pain.001 (optional format) is well-formed with the control sum.
  const isoRes = await app.inject({ method: 'GET', url: `/api/finance/ap/payment-runs/${runNo}/bank-file?format=iso20022`, headers: { authorization: `Bearer ${fincon}` } });
  ok('EXP-13: ISO 20022 pain.001 export carries the control sum + per-line EndToEndId',
    isoRes.statusCode === 200 && isoRes.body.startsWith('<?xml') && isoRes.body.includes('<CtrlSum>1590.11</CtrlSum>') && isoRes.body.includes(`<EndToEndId>${b1.json.txn_no}</EndToEndId>`),
    `st=${isoRes.statusCode}`);

  // 10. Clearing — (a) a statement line matching ONE payment (PAY-AP journal) clears that run line;
  //     (b) a BULK debit equal to the run's net total clears the remaining lines (run-total match).
  await inj('POST', `/api/bank/accounts/${bankId}/statements`, execu, { statement_date: bizToday, opening_bal: 0, closing_bal: -520, lines: [{ date: bizToday, description: 'AP transfer B2', amount: -520 }] });
  const am1 = await inj('POST', `/api/bank/accounts/${bankId}/auto-match`, execu);
  const runC1 = await inj('GET', `/api/finance/ap/payment-runs/${runNo}`, fincon);
  const l2c = (runC1.json.lines ?? []).find((l: any) => l.txn_no === b2.json.txn_no);
  const l1c = (runC1.json.lines ?? []).find((l: any) => l.txn_no === b1.json.txn_no);
  ok('EXP-13: statement auto-match on a single payment clears that run line (others stay open)',
    (am1.status === 200 || am1.status === 201) && l2c?.cleared === true && l1c?.cleared === false && runC1.json.cleared_count === 1,
    `cleared=${runC1.json.cleared_count} l2=${l2c?.cleared} l1=${l1c?.cleared}`);
  await inj('POST', `/api/bank/accounts/${bankId}/statements`, execu, { statement_date: bizToday, opening_bal: -520, closing_bal: -2110.11, lines: [{ date: bizToday, description: 'BULK APRUN', amount: -1590.11 }] });
  const am2 = await inj('POST', `/api/bank/accounts/${bankId}/auto-match`, execu);
  const runC2 = await inj('GET', `/api/finance/ap/payment-runs/${runNo}`, fincon);
  ok('EXP-13: a bulk bank debit equal to the run total clears the remaining lines (run-total match)',
    (am2.status === 200 || am2.status === 201) && (am2.json.run_lines_cleared ?? 0) >= 1 && runC2.json.cleared_count === 2 && runC2.json.cleared_progress === 1,
    `cleared=${runC2.json.cleared_count} run_lines_cleared=${am2.json.run_lines_cleared}`);

  // 11. Fail-closed bank file: a vendor with NO bank account on file → 400 VENDOR_BANK_MISSING.
  const r2 = await inj('POST', '/api/finance/ap/payment-runs/propose', apdual, { due_cutoff: bizToday, bank_account_id: bankId, vendor_ids: [Number(rv2.id)] });
  await inj('POST', `/api/finance/ap/payment-runs/${r2.json.run_no}/submit`, apdual);
  await inj('POST', `/api/finance/ap/payment-runs/${r2.json.run_no}/approve`, fincon);
  const noBank = await inj('GET', `/api/finance/ap/payment-runs/${r2.json.run_no}/bank-file?format=generic`, fincon);
  ok('EXP-13: bank file FAILS CLOSED on a missing vendor bank account → 400 VENDOR_BANK_MISSING',
    noBank.status === 400 && noBank.json.error?.code === 'VENDOR_BANK_MISSING', `${noBank.status} ${noBank.json.error?.code}`);

  // 12. Exhausted selection: paid bills, blocked bills and bills already in an open run are all refused.
  const r3 = await inj('POST', '/api/finance/ap/payment-runs/propose', apdual, { due_cutoff: bizToday, bank_account_id: bankId });
  ok('EXP-13: nothing eligible (paid / blocked / already-in-open-run) → 400 NO_ELIGIBLE_AP',
    r3.status === 400 && r3.json.error?.code === 'NO_ELIGIBLE_AP', `${r3.status} ${r3.json.error?.code}`);

  // ════════════════════════ EXP-14 — Dynamic / early-payment discounting on the AP payment run (FIN-9) ════════════════════════
  // A maker-checked sliding-scale prompt-payment discount policy (ap_discount_terms, per-vendor or global);
  // when a run pays a bill early the discount is captured as income (Cr 4600) and cash out is reduced. The
  // policy is a CHANGE CONTROL: created Draft by 'creditors', activated by a DIFFERENT approvals/gl_close
  // user (self-activation → SOD_VIOLATION); only an Active policy is applied.
  const due30 = new Date(Date.parse(bizToday + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10); // 30 days after bizToday
  // 1. Policy change-control maker-checker: creditors proposes Draft, self-activation blocked, distinct approver activates.
  const polReq = await inj('POST', '/api/finance/ap/discount-terms', apdual, { vendor_id: Number(rv1.id), name: 'ส่วนลด 2/20', discount_pct: 0.02, min_days_early: 1, full_discount_days: 20 });
  const polId = polReq.json.id;
  const polSelf = await inj('POST', `/api/finance/ap/discount-terms/${polId}/approve`, apdual);
  const polApp = await inj('POST', `/api/finance/ap/discount-terms/${polId}/approve`, fincon);
  ok('EXP-14: discount policy is maker-checked — creditors drafts, self-activation → 403 SOD_VIOLATION, a distinct approver activates',
    (polReq.status === 200 || polReq.status === 201) && polReq.json.status === 'Draft'
      && polSelf.status === 403 && polSelf.json.error?.code === 'SOD_VIOLATION'
      && polApp.status === 200 && polApp.json.status === 'Active',
    `draft=${polReq.json.status} self=${polSelf.status}/${polSelf.json.error?.code} app=${polApp.json.status}`);

  // 2. A bill paid 30 days early (≥ full_discount_days=20) earns the full 2% — projected on the proposal.
  const bd1 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv1.id), vendor_name: 'บจก. รันเพย์ ซัพพลาย', amount: 1000, due_date: due30 });
  const rd = await inj('POST', '/api/finance/ap/payment-runs/propose', apdual, { due_cutoff: due30, bank_account_id: bankId, vendor_ids: [Number(rv1.id)], pay_date: bizToday });
  const rdNo = rd.json.run_no as string;
  const ld1 = (rd.json.lines ?? []).find((l: any) => l.txn_no === bd1.json.txn_no);
  ok('EXP-14: propose projects the sliding-scale discount (2% × ฿1000 = ฿20; 30 days early; net cash ฿980)',
    (rd.status === 200 || rd.status === 201) && ld1?.discount_rate === 0.02 && ld1?.discount_amount === 20
      && ld1?.days_early === 30 && ld1?.net_amount === 980 && rd.json.projected_discount === 20,
    `rate=${ld1?.discount_rate} disc=${ld1?.discount_amount} days=${ld1?.days_early} net=${ld1?.net_amount} proj=${rd.json.projected_discount}`);

  // 3. Execute captures the discount: Cr 4600 income, bill fully Paid on the reduced cash, run total_discount, TB balanced.
  await inj('POST', `/api/finance/ap/payment-runs/${rdNo}/submit`, apdual);
  await inj('POST', `/api/finance/ap/payment-runs/${rdNo}/approve`, fincon);
  const disc4600Before = await tbCredit(runPeriod, '4600');
  const execD = await inj('POST', `/api/finance/ap/payment-runs/${rdNo}/execute`, fincon);
  const disc4600After = await tbCredit(runPeriod, '4600');
  const bd1Paid = await apPaid(bd1.json.txn_no);
  const tbD = await inj('GET', `/api/ledger/trial-balance?period=${runPeriod}`, admin);
  const drD = (tbD.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.debit), 0);
  const crD = (tbD.json.rows ?? []).reduce((a: number, r: any) => a + Number(r.credit), 0);
  const rdAfter = await inj('GET', `/api/finance/ap/payment-runs/${rdNo}`, fincon);
  ok('EXP-14: execute captures the discount — Cr 4600 ฿20, bill fully Paid, run total_discount ฿20, TB balanced',
    execD.status === 200 && execD.json.status === 'Executed' && execD.json.discount_taken === 20
      && Math.abs(disc4600After - disc4600Before - 20) < 0.01 && bd1Paid === 1000
      && rdAfter.json.total_discount === 20 && Math.abs(drD - crD) < 0.01,
    `taken=${execD.json.discount_taken} d4600=${(disc4600After - disc4600Before).toFixed(2)} paid=${bd1Paid} total=${rdAfter.json.total_discount} tbΔ=${(drD - crD).toFixed(2)}`);

  // 4. Policy-OFF: a vendor with NO active policy earns no discount (net = gross; nothing posts to 4600).
  const bd2 = await inj('POST', '/api/finance/ap/transactions', apdual, { vendor_id: Number(rv2.id), vendor_name: 'บจก. ไร้บัญชี', amount: 500, due_date: due30 });
  const rd2 = await inj('POST', '/api/finance/ap/payment-runs/propose', apdual, { due_cutoff: due30, bank_account_id: bankId, vendor_ids: [Number(rv2.id)], pay_date: bizToday });
  const ld2 = (rd2.json.lines ?? []).find((l: any) => l.txn_no === bd2.json.txn_no);
  ok('EXP-14: policy-off — a vendor with no active discount policy earns ฿0 discount (net = gross ฿500)',
    (rd2.status === 200 || rd2.status === 201) && (ld2?.discount_amount ?? 0) === 0 && rd2.json.projected_discount === 0 && ld2?.net_amount === 500,
    `disc=${ld2?.discount_amount} proj=${rd2.json.projected_discount} net=${ld2?.net_amount}`);

  // ════════════════════════ PAY-03 — Payroll run maker-checker (SoD) ════════════════════════
  // A payroll run posts its GL entry as a DRAFT; a DIFFERENT user must approve before it hits balances —
  // the run-er can never post their own payroll (ghost-employee / rate-manipulation fraud). Mirrors GL-05.
  const payprep = await login('payprep', 'pw');
  const paychk = await login('paychk', 'pw');
  await inj('POST', '/api/payroll/employees', payprep, { name: 'พนักงานทดสอบ PAY-03', national_id: '1100200300400', monthly_salary: 30000 });
  const payRun = await inj('POST', '/api/payroll/runs?period=2026-09', payprep);
  ok('PAY-03: payroll run posts as Draft (PendingApproval), not Posted', payRun.json.status === 'PendingApproval' && /^JE-/.test(payRun.json.entry_no ?? ''), JSON.stringify({ st: payRun.json.status, e: payRun.json.entry_no }));
  const ssoBefore = await tbCredit('2026-09', '2350');
  ok('PAY-03: Draft payroll JE excluded from trial balance (2350 SSO payable = 0 until approved)', ssoBefore === 0, `2350 credit=${ssoBefore}`);
  const paySelf = await inj('POST', '/api/payroll/runs/2026-09/approve', payprep);
  ok('PAY-03: preparer self-approval blocked → 403 SOD_VIOLATION', paySelf.status === 403 && paySelf.json.error?.code === 'SOD_VIOLATION', `${paySelf.status} ${paySelf.json.error?.code}`);
  const payApprove = await inj('POST', '/api/payroll/runs/2026-09/approve', paychk);
  const ssoAfter = await tbCredit('2026-09', '2350');
  ok('PAY-03: independent approver posts the run → Posted + 2350 SSO payable now reflected',
    payApprove.json.status === 'Posted' && payApprove.json.approved_by === 'paychk' && ssoAfter > 0, JSON.stringify({ st: payApprove.json.status, by: payApprove.json.approved_by, sso: ssoAfter }));

  // ════════════════════════ FA-08 — Asset revaluation maker-checker (SoD) ════════════════════════
  // A revaluation/impairment posts a DRAFT JE and DEFERS the carrying-value change; a different user must
  // approve before the surplus/impairment hits the books — the preparer can never revalue assets alone.
  await db.insert(s.fixedAssets).values({ tenantId: t1, assetNo: 'FA-MC1', name: 'เตาอบ (FA-08)', acquireDate: '2026-01-01', acquireCost: '100000', usefulLifeMonths: 60, netBookValue: '100000', status: 'active' }).onConflictDoNothing();
  const revReq = await inj('POST', '/api/assets/FA-MC1/revalue', payprep, { new_value: 130000, reason: 'fair-value appraisal', reval_date: '2026-09-15' });
  const surplusPre = await tbCredit('2026-09', '3200');
  ok('FA-08: revaluation request posts Draft (PendingApproval); 3200 surplus excluded until approved', revReq.json?.status === 'PendingApproval' && revReq.json?.delta === 30000 && surplusPre === 0, JSON.stringify({ st: revReq.json?.status, d: revReq.json?.delta, s3200: surplusPre }));
  const revSelf2 = await inj('POST', '/api/assets/FA-MC1/revalue/approve', payprep);
  ok('FA-08: preparer self-approval blocked → 403 SOD_VIOLATION', revSelf2.status === 403 && revSelf2.json?.error?.code === 'SOD_VIOLATION', `${revSelf2.status} ${revSelf2.json?.error?.code}`);
  const revAppr2 = await inj('POST', '/api/assets/FA-MC1/revalue/approve', paychk);
  const surplusPost = await tbCredit('2026-09', '3200');
  ok('FA-08: independent approver → revaluation effective, surplus to equity 3200 (+30000)',
    revAppr2.json?.status === 'Posted' && revAppr2.json?.approved_by === 'paychk' && surplusPost === 30000, JSON.stringify({ st: revAppr2.json?.status, by: revAppr2.json?.approved_by, s3200: surplusPost }));

  // ════════════════════════ FA-09 — Asset disposal maker-checker (SoD) ════════════════════════
  // A disposal posts a DRAFT JE and flags the asset disposal_pending; a different user must approve before
  // it is effective (status→disposed) — one person can't write an asset off the books on their own.
  await db.insert(s.fixedAssets).values({ tenantId: t1, assetNo: 'FA-MC2', name: 'รถตู้ (FA-09)', acquireDate: '2026-01-01', acquireCost: '60000', usefulLifeMonths: 60, netBookValue: '60000', status: 'active' }).onConflictDoNothing();
  const dispReq = await inj('PATCH', '/api/assets/FA-MC2/dispose', payprep, { proceeds: 50000, disposal_date: '2026-09-20' });
  ok('FA-09: disposal request → pending_disposal, Draft (asset not yet disposed)', dispReq.json?.status === 'pending_disposal' && /^JE-/.test(dispReq.json?.journal_no ?? ''), JSON.stringify({ st: dispReq.json?.status, je: dispReq.json?.journal_no }));
  const dispSelf2 = await inj('POST', '/api/assets/FA-MC2/dispose/approve', payprep);
  ok('FA-09: requester self-approval blocked → 403 SOD_VIOLATION', dispSelf2.status === 403 && dispSelf2.json?.error?.code === 'SOD_VIOLATION', `${dispSelf2.status} ${dispSelf2.json?.error?.code}`);
  const dispAppr2 = await inj('POST', '/api/assets/FA-MC2/dispose/approve', paychk);
  const faDisposed = (await inj('GET', '/api/assets?status=disposed', payprep)).json;
  ok('FA-09: independent approver → asset disposed (status + approver recorded)',
    dispAppr2.json?.status === 'disposed' && dispAppr2.json?.approved_by === 'paychk' && (faDisposed.assets ?? []).some((x: any) => x.asset_no === 'FA-MC2'), JSON.stringify({ st: dispAppr2.json?.status, by: dispAppr2.json?.approved_by }));

  // ════════════════════════ FA-10 — Capitalization from GR maker-checker (SoD) ════════════════════════
  // A capital goods-receipt line is capitalised onto the asset register only via a maker-checker request: the
  // preparer raises it (NO GL effect) and a DIFFERENT user approves before the asset + acquisition JE
  // (Dr 1500 / Cr 2000) are created — receiving goods and putting them on the books are segregated duties.
  const [grMc] = await db.insert(s.goodsReceipts).values({ grNo: 'GR-MC1', grDate: '2026-09-25', poNo: 'PO-MC1', vendorName: 'Capital Vendor (FA-10)', receivedBy: 'payprep', tenantId: t1 }).returning({ id: s.goodsReceipts.id });
  const [grItemMc] = await db.insert(s.grItems).values({ grId: Number(grMc.id), poNo: 'PO-MC1', itemId: 'SERVER-MC', itemDescription: 'Rack server (FA-10)', poQty: '1', receivedQty: '1', uom: 'EA', unitCost: '40000', isCapital: true, tenantId: t1 }).returning({ id: s.grItems.id });
  const fa1500Pre = await tbDebit('2026-09', '1500');
  const capReq = await inj('POST', '/api/assets/registrations', payprep, { gr_no: 'GR-MC1', gr_item_id: Number(grItemMc.id), name: 'Rack server (capex)', useful_life_months: 60 });
  ok('FA-10: registration request raised as PendingApproval; 1500 unchanged (no GL until approved)', capReq.json?.status === 'PendingApproval' && capReq.json?.acquire_cost === 40000 && (await tbDebit('2026-09', '1500')) === fa1500Pre, JSON.stringify({ st: capReq.json?.status, cost: capReq.json?.acquire_cost, fa1500: fa1500Pre }));
  const capSelf = await inj('POST', `/api/assets/registrations/${capReq.json?.reg_no}/approve`, payprep);
  ok('FA-10: preparer self-approval blocked → 403 SOD_VIOLATION', capSelf.status === 403 && capSelf.json?.error?.code === 'SOD_VIOLATION', `${capSelf.status} ${capSelf.json?.error?.code}`);
  const capAppr = await inj('POST', `/api/assets/registrations/${capReq.json?.reg_no}/approve`, paychk);
  const fa1500Post = await tbDebit('2026-09', '1500');
  ok('FA-10: independent approver → asset created + acquisition JE effective (Dr 1500 +40000)',
    capAppr.json?.status === 'Posted' && /^FA-/.test(capAppr.json?.asset_no ?? '') && capAppr.json?.approved_by === 'paychk' && capAppr.json?.source_gr_no === 'GR-MC1' && fa1500Post === fa1500Pre + 40000, JSON.stringify({ st: capAppr.json?.status, fa: capAppr.json?.asset_no, fa1500: fa1500Post }));

  // ════════════════════ ITGC-AC-09 — SoD preventive block on permission assignment ════════════════════
  // Raise PR / PO (procurement) + approve & pay AP (creditors) is SoD rule R03.
  const conflictPerms = ['procurement', 'creditors'];

  // 1. Assigning a conflicting permission set is BLOCKED (422 SOD_CONFLICT) and nothing is persisted.
  const blocked = await inj('POST', '/api/admin/users', admin, { username: 'sod_blocked', password: 'pw123456', role: 'Sales', permissions: conflictPerms });
  const listAfterBlock = await inj('GET', '/api/admin/users', admin);
  const notCreated = !(listAfterBlock.json.users ?? []).some((u: any) => u.username === 'sod_blocked');
  ok('ITGC-AC-09: conflicting permission set blocked → 422 SOD_CONFLICT, user NOT created',
    blocked.status === 422 && blocked.json.error?.code === 'SOD_CONFLICT' && notCreated, `${blocked.status} ${blocked.json.error?.code} created=${!notCreated}`);

  // 2. The block names the offending rule so the admin understands the conflict (rule id surfaced in message).
  const blockMsg = String(blocked.json.error?.message ?? '');
  ok('ITGC-AC-09: block identifies the violated SoD rule (R03 procurement ✗ creditors)', blockMsg.includes('R03'), blockMsg);

  // 3. Explicit override WITH a reason is STAGED for two-person approval (audit G11) — it is NOT applied by
  //    the grantor. A DIFFERENT admin must approve the exception before the conflicting grant takes effect.
  const overridden = await inj('POST', '/api/admin/users', admin, { username: 'sod_override', password: 'pw123456', role: 'Sales', permissions: conflictPerms, allow_sod_override: true, sod_reason: 'small entity, compensating monthly review by CFO' });
  const excNo = overridden.json.access_exception_req_no;
  const notYet = !((await inj('GET', '/api/admin/users', admin)).json.users ?? []).some((u: any) => u.username === 'sod_override');
  ok('ITGC-AC-09/G11: justified override is STAGED PendingApproval (grantor cannot self-apply — user NOT created)',
    overridden.json.status === 'PendingApproval' && overridden.json.pending === true && !!excNo && (overridden.json.sod_rules ?? []).includes('R03') && notYet, `st=${overridden.json.status} req=${excNo} created=${!notYet}`);
  // 3a. The requester cannot approve their own exception → 403 SOD_VIOLATION.
  const excSelf = await inj('POST', `/api/admin/users/access-exceptions/${excNo}/approve`, admin);
  ok('ITGC-AC-09/G11: requester cannot self-approve the SoD exception → 403 SOD_VIOLATION', excSelf.status === 403 && excSelf.json.error?.code === 'SOD_VIOLATION', `${excSelf.status} ${excSelf.json.error?.code}`);
  // 3b. A DIFFERENT admin (≠ requester, ≠ target) approves → the grant is applied (user created).
  const excApprover = await login('whchk', 'pw'); // a distinct Admin (holds 'users'); whchk ≠ admin ≠ sod_override
  const excAppr = await inj('POST', `/api/admin/users/access-exceptions/${excNo}/approve`, excApprover);
  const nowCreated = ((await inj('GET', '/api/admin/users', admin)).json.users ?? []).some((u: any) => u.username === 'sod_override');
  ok('ITGC-AC-09/G11: a distinct admin approves → exception applied, user created with the (justified) conflicting set',
    excAppr.json.status === 'Approved' && excAppr.json.approved_by === 'whchk' && excAppr.json.requested_by === 'admin' && nowCreated, `st=${excAppr.json.status} by=${excAppr.json.approved_by} created=${nowCreated}`);

  // 4. Override WITHOUT a reason is still rejected (reason is mandatory for the audit trail).
  const noReason = await inj('POST', '/api/admin/users', admin, { username: 'sod_noreason', password: 'pw123456', role: 'Sales', permissions: conflictPerms, allow_sod_override: true });
  ok('ITGC-AC-09: override without a reason is still rejected', noReason.status === 422 && noReason.json.error?.code === 'SOD_CONFLICT', `${noReason.status} ${noReason.json.error?.code}`);

  // 5. The override's WHO/WHY/WHICH-RULES is persisted as tamper-evident evidence in the hash-chained
  //    audit_log meta (round-2 AUD-SEC-04: an ephemeral logger.warn is not audit evidence).
  {
    let evidenceRow: any = null;
    for (let i = 0; i < 10 && !evidenceRow; i++) { // audit write is fire-and-forget → tiny settle loop
      const rows = (await pg.query(`SELECT meta FROM audit_log WHERE action LIKE 'POST /api/admin/users%' AND status = 'success' AND meta::jsonb ? 'sod_override' ORDER BY id DESC LIMIT 1`)).rows as any[];
      evidenceRow = rows[0] ?? null;
      if (!evidenceRow) await new Promise((r) => setTimeout(r, 50));
    }
    const meta = typeof evidenceRow?.meta === 'string' ? JSON.parse(evidenceRow.meta) : evidenceRow?.meta;
    const ev = meta?.sod_override;
    ok('ITGC-AC-09: override reason + rule ids persisted in hash-chained audit_log meta (durable evidence)',
      !!ev && ev.username === 'sod_override' && String(ev.reason).includes('compensating') && (ev.rules ?? []).includes('R03'),
      JSON.stringify(ev ?? 'no audit row'));
  }

  // 6. A clean single-duty set is accepted with no friction.
  const clean = await inj('POST', '/api/admin/users', admin, { username: 'sod_clean', password: 'pw123456', role: 'Sales', permissions: ['ar'] });
  ok('ITGC-AC-09: conflict-free permission set assigned normally', (clean.status === 200 || clean.status === 201), `${clean.status}`);

  // 7. The same guard applies on UPDATE, not just create.
  const updateConflict = await inj('PATCH', '/api/admin/users/sod_clean', admin, { permissions: conflictPerms });
  ok('ITGC-AC-09: preventive block also enforced on permission UPDATE', updateConflict.status === 422 && updateConflict.json.error?.code === 'SOD_CONFLICT', `${updateConflict.status} ${updateConflict.json.error?.code}`);

  // ════════════════════ ITGC-AC-08 — User Access Review (recertification) ════════════════════
  // 1. The review report lists every user with effective permissions + SoD conflict flags.
  const review = await inj('GET', '/api/admin/users/access-review', admin);
  const overrideRow = (review.json.users ?? []).find((u: any) => u.username === 'sod_override');
  ok('ITGC-AC-08: access-review reports effective permissions + SoD conflicts per user',
    (review.json.users ?? []).length >= 1 && review.json.summary?.total_users >= 1 && overrideRow?.sod_conflict_count >= 1, JSON.stringify(review.json.summary));

  // 2. CSV export carries a decision column for the reviewer to annotate keep/revoke (audit evidence).
  const csv = await inj('GET', '/api/admin/users/access-review/export', admin);
  ok('ITGC-AC-08: access-review CSV export with decision/reviewer columns',
    typeof csv.text === 'string' && csv.text.includes('decision_keep_revoke') && csv.text.split('\n').length > 1, `bytes=${csv.text?.length ?? 0}`);

  // 3. A period certification can be recorded and then read back (sign-off evidence).
  const certify = await inj('POST', '/api/admin/users/access-review/certify', admin, { period: '2026-Q2', notes: 'quarterly UAR' });
  const certs = await inj('GET', '/api/admin/users/access-review/certifications', admin);
  ok('ITGC-AC-08: quarterly certification recorded + retrievable',
    (certify.status === 200 || certify.status === 201) && certify.json.certified === true && (certs.json.reviews ?? []).some((r: any) => r.period === '2026-Q2'), `${certify.status} certs=${(certs.json.reviews ?? []).length}`);

  // ════════════════════ GL — closed-period posting lock (period-close control) ════════════════════
  // A closed fiscal period must reject new postings. fincon (gl_close) closes a period; glacct (gl_post)
  // then cannot post into it. This is the system gate behind the financial-close calendar.
  const lockPeriod = '2020-01';
  const closeP = await inj('POST', `/api/ledger/periods/${lockPeriod}/close`, fincon);
  const intoClosed = await inj('POST', '/api/ledger/journal', glacct, {
    date: `${lockPeriod}-15`, memo: 'into closed period', source: 'Manual',
    lines: [{ account_code: '1000', debit: 5 }, { account_code: '4000', credit: 5 }],
  });
  ok('GL period control: posting into a CLOSED period is rejected (PERIOD_CLOSED)',
    (closeP.status === 200 || closeP.status === 201) && intoClosed.status === 400 && intoClosed.json.error?.code === 'PERIOD_CLOSED', `close=${closeP.status} post=${intoClosed.status} ${intoClosed.json.error?.code}`);

  // ════════════════════ ITGC — RLS isolation of financial data (cross-tenant) ════════════════════
  // A tenant-2 finance user (authorized to read the ledger) must NOT see tenant-1's journal entries.
  const t2Journal = await inj('GET', '/api/ledger/journal?limit=100', finT2);
  const leak = (t2Journal.json.entries ?? []).some((e: any) => e.entry_no === entryNo);
  const t2tb = await inj('GET', `/api/ledger/trial-balance?period=${period}`, finT2);
  const t2SeesT1Credit = (t2tb.json.rows ?? []).some((r: any) => r.account_code === '4000' && Number(r.credit) > 0);
  ok('ITGC RLS: tenant-2 finance user cannot see tenant-1 journal entries or balances', !leak && !t2SeesT1Credit, `leak=${leak} sees4000=${t2SeesT1Credit}`);

  // ── ITGC-AC-02/03: the RLS bypass follows the LIVE DB role, not the token's role claim ──
  // An HQ Admin's token bypasses RLS (sees every tenant). If that account is later downgraded to a
  // tenant-scoped role, the SAME (still-valid) token must immediately lose HQ bypass — the guard reads the
  // live `users.role`, not the (now stale) role baked into the JWT. Permissions in the token stay (so the
  // read still passes the permission guard); only the role-driven bypass flips, isolating this control.
  const staleTok = (await inj('POST', '/api/login', undefined, { username: 'staleadmin', password: 'pw' })).json.token as string;
  const beforeSeesT1 = ((await inj('GET', '/api/ledger/journal?limit=100', staleTok)).json.entries ?? []).some((e: any) => e.entry_no === entryNo);
  await db.update(s.users).set({ role: 'Procurement' }).where(eq(s.users.username, 'staleadmin')); // downgrade in DB, token unchanged
  const afterSeesT1 = ((await inj('GET', '/api/ledger/journal?limit=100', staleTok)).json.entries ?? []).some((e: any) => e.entry_no === entryNo);
  ok('ITGC-AC-03: RLS bypass follows live DB role — downgraded Admin token loses HQ cross-tenant visibility', beforeSeesT1 && !afterSeesT1, `beforeSeesT1=${beforeSeesT1} afterSeesT1=${afterSeesT1}`);

  // ════════════════════ REV-08 — credit-limit / credit-hold enforcement on order entry ════════════════════
  // A customer's OUTSTANDING AR + the new order may not exceed its credit limit; a customer on credit hold
  // cannot order at all. The check is in pos.service.createOrder (customer row locked FOR UPDATE).
  const [tcr] = await db.insert(s.tenants).values({ code: 'TCR', name: 'เครดิตจำกัด', creditLimit: '1000', creditHold: false }).returning({ id: s.tenants.id });
  const tcrId = Number(tcr.id);
  await db.insert(s.arInvoices).values({ invoiceNo: 'INV-TCR-OPEN', tenantId: tcrId, amount: '800', paidAmount: '0', status: 'Unpaid' });
  const order = (amount: number) => inj('POST', '/api/pos/orders', admin, { customer_name: 'TCR', items: [{ item_id: 'X', order_qty: 1, unit_price: amount }] });

  // 1. Outstanding 800 + order 150 = 950 ≤ 1000 → allowed.
  const within = await order(150);
  ok('REV-08: order within credit limit (outstanding 800 + 150 ≤ 1000) allowed', (within.status === 200 || within.status === 201) && !!within.json.order_no, `${within.status} ${within.json.order_no ?? within.json.error?.code}`);

  // 2. Outstanding 800 + order 300 = 1100 > 1000 → blocked (CREDIT_LIMIT).
  const over = await order(300);
  ok('REV-08: order breaching credit limit (800 + 300 > 1000) blocked → CREDIT_LIMIT', over.status === 409 && over.json.error?.code === 'CREDIT_LIMIT', `${over.status} ${over.json.error?.code}`);

  // 3. Credit hold blocks any order regardless of amount.
  await db.update(s.tenants).set({ creditHold: true }).where(eq(s.tenants.id, tcrId));
  const held = await order(1);
  ok('REV-08: customer on credit hold cannot order → CREDIT_HOLD', held.status === 409 && held.json.error?.code === 'CREDIT_HOLD', `${held.status} ${held.json.error?.code}`);

  // ════════════════════ ITGC-AC-01 — username identity is canonicalized ════════════════════
  // Usernames are stored trimmed-lowercase; login matches the same way, so a mixed-case account can be
  // reached regardless of casing/whitespace — but the password stays case-sensitive and is never trimmed.
  const mkCase = await inj('POST', '/api/admin/users', admin, { username: 'CaseUser', password: 'pw123456', role: 'Sales' });
  ok('ITGC-AC-01: create stores username canonicalized (trimmed-lowercase)', mkCase.status === 201 && mkCase.json.username === 'caseuser', `${mkCase.status} ${mkCase.json.username}`);
  const caseLogin = await inj('POST', '/api/login', undefined, { username: '  CASEUSER ', password: 'pw123456' });
  ok('ITGC-AC-01: login is case/whitespace-insensitive on username', caseLogin.status === 200 && !!caseLogin.json.token, `${caseLogin.status} token=${!!caseLogin.json.token}`);
  const caseBadPw = await inj('POST', '/api/login', undefined, { username: 'caseuser', password: 'PW123456' });
  ok('ITGC-AC-01: password remains case-sensitive (not normalized)', caseBadPw.status === 401, `${caseBadPw.status} ${caseBadPw.json.error?.code}`);

  // ════════════════════ ITGC-AC-06 — multi-factor authentication (TOTP) ════════════════════
  // 1. A privileged role (Admin) that has not enrolled MFA is flagged for mandatory setup at login.
  const adminLogin = await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' });
  ok('ITGC-AC-06: privileged user without MFA is flagged must_setup_mfa at login', adminLogin.json.must_setup_mfa === true, JSON.stringify({ setup: adminLogin.json.must_setup_mfa }));

  // 2. A non-privileged role (a Cashier — pos_sell only) is NOT required to enrol.
  await inj('POST', '/api/admin/users', admin, { username: 'cashier1', password: 'pw123456', role: 'Cashier' });
  const cashierLogin = await inj('POST', '/api/login', undefined, { username: 'cashier1', password: 'pw123456' });
  ok('ITGC-AC-06: non-privileged role not flagged for MFA', cashierLogin.json.must_setup_mfa !== true, JSON.stringify({ setup: cashierLogin.json.must_setup_mfa }));

  // 3. Enrol TOTP for fincon: setup → secret; enable with a valid code activates the factor.
  const setup = await inj('POST', '/api/auth/mfa/setup', fincon);
  const secret = setup.json.secret as string;
  const enable = await inj('POST', '/api/auth/mfa/enable', fincon, { code: authenticator.generate(secret) });
  ok('ITGC-AC-06: TOTP enrolment (setup → enable) activates the second factor', !!secret && enable.status === 200 && enable.json.enabled === true, `${enable.status} ${enable.json.enabled}`);

  // 4. With MFA enabled, password alone is rejected → 401 MFA_REQUIRED.
  const noCode = await inj('POST', '/api/login', undefined, { username: 'fincon', password: 'pw' });
  ok('ITGC-AC-06: MFA-enabled login without a code → 401 MFA_REQUIRED', noCode.status === 401 && noCode.json.error?.code === 'MFA_REQUIRED', `${noCode.status} ${noCode.json.error?.code}`);

  // 5. A wrong code is rejected → 401 MFA_INVALID.
  const badCode = await inj('POST', '/api/login', undefined, { username: 'fincon', password: 'pw', totp: '000000' });
  ok('ITGC-AC-06: MFA-enabled login with a wrong code → 401 MFA_INVALID', badCode.status === 401 && badCode.json.error?.code === 'MFA_INVALID', `${badCode.status} ${badCode.json.error?.code}`);

  // 6. Password + a valid TOTP code authenticates (and the enrolled user is no longer flagged for setup).
  const goodCode = await inj('POST', '/api/login', undefined, { username: 'fincon', password: 'pw', totp: authenticator.generate(secret) });
  ok('ITGC-AC-06: password + valid TOTP authenticates; setup flag cleared', goodCode.status === 200 && !!goodCode.json.token && goodCode.json.must_setup_mfa !== true, `${goodCode.status} setup=${goodCode.json.must_setup_mfa}`);

  // ════════════════════ ITGC-AC-10 — audit trail is tamper-evident (append-only) ════════════════════
  // The mutating calls above (user create/update, JE post/approve) are logged by the AuditInterceptor.
  const auditCount = async () => Number(((await pg.query(`SELECT count(*)::int n FROM audit_log`)).rows as any[])[0].n);
  const before = await auditCount();
  let updateBlocked = false, deleteBlocked = false;
  try { await pg.query(`UPDATE audit_log SET actor='tamper' WHERE id=(SELECT id FROM audit_log LIMIT 1)`); } catch { updateBlocked = true; }
  try { await pg.query(`DELETE FROM audit_log WHERE id=(SELECT id FROM audit_log LIMIT 1)`); } catch { deleteBlocked = true; }
  const after = await auditCount();
  ok('ITGC-AC-10: audit_log captured the mutating requests', before > 0, `rows=${before}`);
  ok('ITGC-AC-10: audit_log UPDATE blocked by DB trigger (append-only)', updateBlocked, `blocked=${updateBlocked}`);
  ok('ITGC-AC-10: audit_log DELETE blocked by DB trigger (append-only)', deleteBlocked && after === before, `blocked=${deleteBlocked} rows=${after}`);

  // ════════════════════ ITGC-AC-16 — audit trail is tamper-EVIDENT (hash-chained) ════════════════════
  const v1 = await inj('GET', '/api/admin/audit/verify', admin);
  ok('ITGC-AC-16: audit hash chain verifies intact (ok=true)', v1.json?.ok === true && v1.json?.rows_checked > 0, JSON.stringify({ ok: v1.json?.ok, n: v1.json?.rows_checked }));
  // Simulate a privileged tamper that BYPASSES the append-only trigger (the threat AC-10 alone can't detect),
  // then prove the hash chain catches it.
  await pg.exec(`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  await pg.query(`UPDATE audit_log SET actor='tamper' WHERE id = (SELECT id FROM audit_log WHERE seq IS NOT NULL ORDER BY tenant_id, seq LIMIT 1)`);
  await pg.exec(`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  const v2 = await inj('GET', '/api/admin/audit/verify', admin);
  ok('ITGC-AC-16: a past row altered behind the trigger is DETECTED → ok=false, hash mismatch', v2.json?.ok === false && /hash mismatch/.test(v2.json?.reason ?? ''), JSON.stringify({ ok: v2.json?.ok, at: v2.json?.broken_at, reason: v2.json?.reason }));

  // ════════════════════ ITGC-AC-14 — field-level before/after change log (financial tables) ════════════════════
  // The DB triggers (0116) capture OLD→NEW row images on the financial tables. The AP-PAY flow above mutated
  // ap_transactions through the app (apclerk created the bill Unpaid; fincon's approval set it Paid), so the
  // change log must hold both images with the correct actor + changed columns — captured at the DB layer.
  const apUpd = ((await pg.query(`SELECT actor, old_value->>'status' os, new_value->>'status' ns, changed_columns FROM data_change_log WHERE table_name='ap_transactions' AND op='UPDATE' AND new_value->>'txn_no'='${apNo}' ORDER BY id DESC LIMIT 1`)).rows as any[])[0];
  ok('ITGC-AC-14: change log captured AP bill OLD→NEW (Unpaid→Paid) with approver + changed columns',
    !!apUpd && apUpd.actor === 'fincon' && apUpd.os === 'Unpaid' && apUpd.ns === 'Paid' && (apUpd.changed_columns ?? []).includes('paid_amount'),
    apUpd ? `actor=${apUpd.actor} ${apUpd.os}->${apUpd.ns} cols=${JSON.stringify(apUpd.changed_columns)}` : 'no row');
  // Surfaced through the admin audit-viewer endpoint (tenant-scoped; Admin sees all).
  const chgApi = await inj('GET', '/api/admin/audit/changes?table=ap_transactions', admin);
  ok('ITGC-AC-14: change log exposed via /api/admin/audit/changes with old/new + actor', chgApi.status === 200 && (chgApi.json.rows ?? []).some((r: any) => r.op === 'UPDATE' && r.new_value && r.old_value && r.actor), `n=${(chgApi.json.rows ?? []).length}`);
  // Append-only: the change log itself cannot be rewritten.
  let dclBlocked = false;
  try { await pg.query(`UPDATE data_change_log SET actor='tamper' WHERE id=(SELECT id FROM data_change_log LIMIT 1)`); } catch { dclBlocked = true; }
  ok('ITGC-AC-14: data_change_log UPDATE blocked by DB trigger (append-only)', dclBlocked, `blocked=${dclBlocked}`);

  // ════════════════════ LYL-03 — Loyalty points liability posts to GL (TFRS 15, control acct 2250) ════════════════════
  // Seed a deterministic program: fair value 0.1 baht/point, two ACTIVE members holding 1000 + 500 points
  // (with matching sub-ledger rows so the watermark advances) ⇒ outstanding 1500 × 0.1 = ฿150 liability.
  const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
  await db.insert(s.loyaltyConfig).values({ id: 1, enabled: true, pointsPerBaht: '1', bahtPerPoint: '0.1', minRedeem: '0', expiryDays: 365 })
    .onConflictDoUpdate({ target: s.loyaltyConfig.id, set: { enabled: true, bahtPerPoint: '0.1', pointsPerBaht: '1', expiryDays: 365 } });
  const [lm1] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-LYL1', name: 'แต้ม A', balance: '1000', lifetime: '1000', active: true }).returning({ id: s.posMembers.id });
  const [lm2] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-LYL2', name: 'แต้ม B', balance: '500', lifetime: '500', active: true }).returning({ id: s.posMembers.id });
  await db.insert(s.posMemberLedger).values([
    { tenantId: t1, memberId: Number(lm1.id), txnType: 'Earn', points: '1000', balanceAfter: '1000', refDoc: 'SEED-A' },
    { tenantId: t1, memberId: Number(lm2.id), txnType: 'Earn', points: '500', balanceAfter: '500', refDoc: 'SEED-B' },
  ]);

  // 1. The read-only tie-out reports the liability against control account 2250 at fair value.
  const liab = await inj('GET', '/api/loyalty/liability', glacct);
  ok('LYL-03: liability tie-out reports outstanding × fair value on control acct 2250',
    liab.json.control_account === '2250' && near(liab.json.fair_value_per_point, 0.1) && near(liab.json.outstanding_points, 1500) && near(liab.json.liability_value, 150),
    `acct=${liab.json.control_account} out=${liab.json.outstanding_points} liab=${liab.json.liability_value}`);

  // 2. Posting the accrual books a balanced JE (Dr 5700 / Cr 2250) for the full liability — posted immediately.
  const lpost = await inj('POST', '/api/loyalty/liability/post', glacct, {});
  const ljno = String(lpost.json.journal_no ?? '');
  const lperiod = `${ljno.slice(3, 7)}-${ljno.slice(7, 9)}`;
  ok('LYL-03: accrual run posts the liability delta to the GL (Dr 5700 / Cr 2250)',
    lpost.json.posted === true && near(lpost.json.liability_delta, 150) && near(lpost.json.posted_liability, 150) && /^JE-/.test(ljno),
    `posted=${lpost.json.posted} delta=${lpost.json.liability_delta} je=${ljno}`);
  const cr2250 = await tbCredit(lperiod, '2250');
  ok('LYL-03: control account 2250 credited by outstanding × fair value (ties to sub-ledger)', near(cr2250, 150), `2250 credit=${cr2250}`);

  // 3. Trial balance stays balanced after the accrual.
  const ltb = await inj('GET', `/api/ledger/trial-balance?period=${lperiod}`, admin);
  ok('LYL-03: trial balance remains balanced after the loyalty accrual',
    ltb.json.totals?.balanced === true || near(ltb.json.totals?.debit, Number(ltb.json.totals?.credit)),
    `debit=${ltb.json.totals?.debit} credit=${ltb.json.totals?.credit}`);

  // 4. Idempotent — re-running with no new points movements posts nothing (no double accrual).
  const lpost2 = await inj('POST', '/api/loyalty/liability/post', glacct, {});
  const cr2250b = await tbCredit(lperiod, '2250');
  ok('LYL-03: re-run is idempotent (no new movements → no double posting)',
    lpost2.json.posted === false && near(cr2250b, 150), `reason=${lpost2.json.reason} 2250 credit=${cr2250b}`);

  // 5. Tenant-scoped — an HQ-tenant run sees none of T1's points (explicit tenant scope on the accrual).
  const lpostHq = await inj('POST', '/api/loyalty/liability/post', admin, {});
  ok('LYL-03: accrual is tenant-scoped (HQ-tenant run finds no T1 points)',
    lpostHq.json.posted === false && near(lpostHq.json.outstanding_points ?? 0, 0), `posted=${lpostHq.json.posted} out=${lpostHq.json.outstanding_points}`);

  // 6. The READ tie-out is tenant-scoped even for Admin (whose JWT bypasses RLS): an HQ admin must see
  // HQ's own (empty) liability, NOT T1's ฿150 commingled across tenants.
  const liabHq = await inj('GET', '/api/loyalty/liability', admin);
  ok('LYL-03: liability tie-out is tenant-scoped under Admin RLS-bypass (no cross-tenant commingling)',
    near(liabHq.json.outstanding_points ?? 0, 0) && near(liabHq.json.liability_value ?? 0, 0), `out=${liabHq.json.outstanding_points} liab=${liabHq.json.liability_value}`);

  // 7. Basis is ALL members: deactivating a balance-bearing member does NOT silently drop the liability
  // (you still owe the points) and does NOT desync the GL — the accrual stays tied at ฿150.
  await db.update(s.posMembers).set({ active: false }).where(eq(s.posMembers.id, Number(lm1.id)));
  const liabAfter = await inj('GET', '/api/loyalty/liability', glacct);
  const lpost3 = await inj('POST', '/api/loyalty/liability/post', glacct, {});
  const cr2250c = await tbCredit(lperiod, '2250');
  ok('LYL-03: liability basis covers all members (deactivation does not desync GL 2250)',
    near(liabAfter.json.outstanding_points, 1500) && near(liabAfter.json.liability_value, 150) && lpost3.json.posted === false && near(cr2250c, 150),
    `out=${liabAfter.json.outstanding_points} 2250=${cr2250c} rerun=${lpost3.json.reason}`);

  // ════════ LYL-04/05 — Points expiry (breakage) releases the liability; period-close auto-accrues ════════
  // Fresh tenant T2 isolates from the T1 checks above. Sales@T2 holds 'exec' ⇒ gl_post/gl_close + loyalty/exec.
  await db.insert(s.users).values({ username: 'salesT2', passwordHash: await pw.hash('pw'), role: 'Sales', tenantId: t2 }).onConflictDoNothing();
  const salesT2 = await login('salesT2', 'pw');
  const oldDate = new Date('2023-01-01T00:00:00Z'); // > expiry_days (365) ago ⇒ outside the earn window
  const [t2a] = await db.insert(s.posMembers).values({ tenantId: t2, memberCode: 'M-T2A', name: 'เก่า', balance: '1000', lifetime: '1000', active: true }).returning({ id: s.posMembers.id });
  const [t2b] = await db.insert(s.posMembers).values({ tenantId: t2, memberCode: 'M-T2B', name: 'ใหม่', balance: '1000', lifetime: '1000', active: true }).returning({ id: s.posMembers.id });
  await db.insert(s.posMemberLedger).values([
    { tenantId: t2, memberId: Number(t2a.id), txnType: 'Earn', points: '1000', balanceAfter: '1000', refDoc: 'SEED-OLD', txnDate: oldDate },
    { tenantId: t2, memberId: Number(t2b.id), txnType: 'Earn', points: '1000', balanceAfter: '1000', refDoc: 'SEED-NEW' },
  ]);

  const t2acc1 = await inj('POST', '/api/loyalty/liability/post', salesT2, {});            // baseline 2000 × 0.1 = ฿200
  const exp = await inj('POST', '/api/loyalty/expire', salesT2, {});                       // M-T2A's old 1000 expire
  const t2acc2 = await inj('POST', '/api/loyalty/liability/post', salesT2, {});            // release → target ฿100
  ok('LYL-04: aged points expire (breakage) and release the GL liability (Dr 2250 / Cr 5700)',
    near(t2acc1.json.posted_liability, 200) && exp.json.expired_points === 1000 && exp.json.expired_members === 1 && near(t2acc2.json.liability_delta, -100) && near(t2acc2.json.posted_liability, 100),
    `base=${t2acc1.json.posted_liability} expired=${exp.json.expired_points} delta=${t2acc2.json.liability_delta} posted=${t2acc2.json.posted_liability}`);

  // New movement, then close T2's current period → close auto-accrues the delta (no manual run needed).
  const [t2c] = await db.insert(s.posMembers).values({ tenantId: t2, memberCode: 'M-T2C', name: 'ปิดงวด', balance: '500', lifetime: '500', active: true }).returning({ id: s.posMembers.id });
  await db.insert(s.posMemberLedger).values({ tenantId: t2, memberId: Number(t2c.id), txnType: 'Earn', points: '500', balanceAfter: '500', refDoc: 'SEED-CLOSE' });
  const t2close = await inj('POST', `/api/ledger/periods/${period}/close`, salesT2);
  ok('LYL-05: closing a period auto-accrues the loyalty liability before locking the books',
    (t2close.status === 200 || t2close.status === 201) && t2close.json.status === 'Closed' && t2close.json.loyalty_accrual?.posted === true && near(t2close.json.loyalty_accrual?.liability_delta, 50) && near(t2close.json.loyalty_accrual?.posted_liability, 150),
    `status=${t2close.json.status} accrual=${JSON.stringify(t2close.json.loyalty_accrual)}`);

  // ════════ LYL-06 — Scheduled maintenance sweep (cron): expire aged points + re-accrue, per tenant ════════
  const [hqA] = await db.insert(s.posMembers).values({ tenantId: hq, memberCode: 'M-HQ-OLD', name: 'hq เก่า', balance: '1000', lifetime: '1000', active: true }).returning({ id: s.posMembers.id });
  const [hqB] = await db.insert(s.posMembers).values({ tenantId: hq, memberCode: 'M-HQ-NEW', name: 'hq ใหม่', balance: '500', lifetime: '500', active: true }).returning({ id: s.posMembers.id });
  await db.insert(s.posMemberLedger).values([
    { tenantId: hq, memberId: Number(hqA.id), txnType: 'Earn', points: '1000', balanceAfter: '1000', refDoc: 'HQ-OLD', txnDate: oldDate },
    { tenantId: hq, memberId: Number(hqB.id), txnType: 'Earn', points: '500', balanceAfter: '500', refDoc: 'HQ-NEW' },
  ]);
  const hqBase = await inj('POST', '/api/loyalty/liability/post', admin, {});            // admin.tenantId=hq ⇒ baseline 1500 × 0.1 = ฿150
  const sweep = await inj('POST', '/api/loyalty/maintenance/run', admin, { tenant_id: hq });
  const hqRes = (sweep.json.results ?? []).find((r: any) => Number(r.tenant_id) === hq);
  ok('LYL-06: maintenance sweep expires aged points then re-accrues the liability per tenant',
    near(hqBase.json.posted_liability, 150) && !!hqRes && hqRes.expired_points === 1000 && near(hqRes.accrual?.liability_delta, -100) && near(hqRes.accrual?.posted_liability, 50),
    `base=${hqBase.json.posted_liability} sweep=${JSON.stringify(hqRes)}`);

  // ════════ LYL-07 — Rewards: burn points for a single-use code, release the liability, block double-use ════════
  // execu (Sales@T1) holds marketing/exec (catalog config) + pos (redeem/use). M-LYL2 (lm2) holds 500 points.
  const rwd = await inj('POST', '/api/loyalty/rewards', execu, { name: 'ส่วนลด ฿50', type: 'evoucher', point_cost: 300, cash_value: 50, coupon_kind: 'amount', coupon_value: 50, per_member_limit: 1 });
  const rwdId = Number(rwd.json.id);
  const redeem = await inj('POST', `/api/loyalty/rewards/${rwdId}/redeem`, execu, { member_id: Number(lm2.id) });
  const accAfter = await inj('POST', '/api/loyalty/liability/post', execu, {});       // execu.tenantId=T1 ⇒ accrue T1; burn of 300 pts ⇒ −฿30
  const useResp = await inj('POST', `/api/loyalty/redemptions/${redeem.json.redemption_code}/use`, execu, { sale_no: 'SALE-T1-RWD' });
  const useAgain = await inj('POST', `/api/loyalty/redemptions/${redeem.json.redemption_code}/use`, execu, {});
  ok('LYL-07: reward burn issues a single-use code, releases the GL liability, and blocks double-use',
    (rwd.status === 200 || rwd.status === 201) && /^RDM-/.test(redeem.json.redemption_code ?? '') && redeem.json.balance === 200 && near(accAfter.json.liability_delta, -30) && useResp.json.status === 'used' && useAgain.status === 409 && useAgain.json.error?.code === 'ALREADY_USED',
    `code=${redeem.json.redemption_code} bal=${redeem.json.balance} delta=${accAfter.json.liability_delta} use=${useResp.json.status} again=${useAgain.json.error?.code}`);

  // Tenant scoping under Admin RLS-bypass: an HQ admin must NOT see T1's reward catalog nor use T1's code.
  const useCross = await inj('POST', `/api/loyalty/redemptions/${redeem.json.redemption_code}/use`, admin, {});
  const adminRewards = await inj('GET', '/api/loyalty/rewards', admin);
  ok('LYL-07: rewards are tenant-scoped under Admin RLS-bypass (no cross-tenant code use or catalog leak)',
    useCross.status === 404 && useCross.json.error?.code === 'REDEMPTION_NOT_FOUND' && !(adminRewards.json.rewards ?? []).some((r: any) => Number(r.id) === rwdId),
    `crossUse=${useCross.status}/${useCross.json.error?.code} adminSeesT1=${(adminRewards.json.rewards ?? []).some((r: any) => Number(r.id) === rwdId)}`);

  // ════════ LYL-08 — Tier auto-recompute + gamification mission claim (single-claim) ════════
  // HQ members from LYL-06: hqA (lifetime 1000), hqB (lifetime 500, balance 500). Seed a tier ladder.
  await db.insert(s.loyaltyTiers).values([
    { tenantId: hq, tier: 'Silver', minLifetime: '500', earnMult: '1', redeemMult: '1', sort: 1 },
    { tenantId: hq, tier: 'Gold', minLifetime: '1000', earnMult: '2', redeemMult: '1', sort: 2 },
  ]);
  const tierRecomp = await inj('POST', '/api/loyalty/tiers/recompute', admin, {});             // admin.tenantId=hq
  const journeyB = await inj('GET', `/api/loyalty/members/${Number(hqB.id)}/tier`, admin);      // hqB lifetime 500 → Silver, next Gold
  const mission = await inj('POST', '/api/loyalty/missions', admin, { name: 'แสตมป์ 3 ครั้ง', type: 'stamp', goal: 3, reward_kind: 'points', reward_points: 50 });
  const mid = Number(mission.json.id);
  const prog = await inj('POST', `/api/loyalty/missions/${mid}/progress`, admin, { member_id: Number(hqB.id), amount: 3 });
  const claim1 = await inj('POST', `/api/loyalty/missions/${mid}/claim`, admin, { member_id: Number(hqB.id) });
  const claim2 = await inj('POST', `/api/loyalty/missions/${mid}/claim`, admin, { member_id: Number(hqB.id) });
  ok('LYL-08: tier auto-recompute (lifetime → tier ladder) + mission claim grants bonus points, single-claim',
    tierRecomp.json.changed >= 2 && journeyB.json.current_tier === 'Silver' && journeyB.json.next_tier === 'Gold' && prog.json.completed === true && claim1.json.reward?.points === 50 && claim1.json.reward?.balance === 550 && claim2.status === 409 && claim2.json.error?.code === 'ALREADY_CLAIMED',
    `changed=${tierRecomp.json.changed} tierB=${journeyB.json.current_tier}/${journeyB.json.next_tier} done=${prog.json.completed} claim=${JSON.stringify(claim1.json.reward)} again=${claim2.json.error?.code}`);

  // ════════ LYL-09 — Member-get-member referral rewards both, once, tenant-scoped ════════
  const [refA] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-REFA', name: 'ผู้แนะนำ', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  const [refB] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-REFB', name: 'ผู้ถูกแนะนำ', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  const refCreate = await inj('POST', '/api/loyalty/referrals', execu, { referrer_member_id: Number(refA.id), referred_member_id: Number(refB.id), referrer_points: 50, referred_points: 50 });
  const refReward = await inj('POST', `/api/loyalty/referrals/${refCreate.json.id}/reward`, execu, {});
  const refReward2 = await inj('POST', `/api/loyalty/referrals/${refCreate.json.id}/reward`, execu, {});
  const refRewardCross = await inj('POST', `/api/loyalty/referrals/${refCreate.json.id}/reward`, admin, {});  // admin.tenantId=hq ⇒ not in scope
  ok('LYL-09: referral rewards both members once (single-reward) and is tenant-scoped',
    /^RFL-/.test(refCreate.json.code ?? '') && refReward.json.status === 'rewarded' && refReward.json.referrer?.balance === 50 && refReward.json.referred?.balance === 50 && refReward2.status === 409 && refReward2.json.error?.code === 'ALREADY_REWARDED' && refRewardCross.status === 404,
    `code=${refCreate.json.code} reward=${refReward.json.status} refr=${refReward.json.referrer?.balance} refd=${refReward.json.referred?.balance} again=${refReward2.json.error?.code} cross=${refRewardCross.status}`);

  // ════════ LYL-10 — Member self-service app: phone-OTP login, self-scoped access, staff routes blocked ════════
  const [appMem] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-APP', name: 'แอป', phone: '0890000001', balance: '100', lifetime: '100', active: true }).returning({ id: s.posMembers.id });
  const otpReq = await inj('POST', '/api/member/auth/request-otp', undefined, { phone: '0890000001', tenant_code: 'T1' });
  const badVerify = await inj('POST', '/api/member/auth/verify-otp', undefined, { phone: '0890000001', tenant_code: 'T1', code: '000000' });   // wrong → 401
  const otpVerify = await inj('POST', '/api/member/auth/verify-otp', undefined, { phone: '0890000001', tenant_code: 'T1', code: String(otpReq.json.dev_otp) });
  const memberTok = otpVerify.json.token as string;
  const meResp = await inj('GET', '/api/member/me', memberTok);
  const rewardsResp = await inj('GET', '/api/member/rewards', memberTok);
  const staffAttempt = await inj('GET', '/api/loyalty/members', memberTok);   // member token (no perms) → 403
  ok('LYL-10: phone-OTP login mints a member token; self-service works; staff routes blocked; wrong code rejected',
    otpReq.json.sent === true && /^[0-9]{6}$/.test(String(otpReq.json.dev_otp ?? '')) && badVerify.status === 401 && !!memberTok && meResp.json.member_code === 'M-APP' && Number(appMem.id) === meResp.json.id && Array.isArray(rewardsResp.json.rewards) && staffAttempt.status === 403,
    `otp=${otpReq.json.dev_otp} bad=${badVerify.status} me=${meResp.json.member_code} rewards=${rewardsResp.json.rewards?.length} staff=${staffAttempt.status}`);
  // LYL-10c — PDPA data-subject self-service: a member manages their OWN consent (withdraw 'marketing'),
  // recorded with source='self' and self-scoped (the endpoint uses the token's memberId).
  const cPut = await inj('PUT', '/api/member/consents', memberTok, { purpose: 'marketing', granted: false });
  const cGet = await inj('GET', '/api/member/consents', memberTok);
  const mkt = (cGet.json.consents ?? []).find((x: any) => x.purpose === 'marketing');
  ok('LYL-10c: member self-manages PDPA consent (withdraw marketing; source=self; self-scoped)',
    cPut.status < 300 && !!mkt && mkt.granted === false && mkt.source === 'self' && cGet.json.member_id === Number(appMem.id),
    JSON.stringify({ put: cPut.status, mkt }).slice(0, 140));
  // LYL-10b — OTP brute-force cap: 5 wrong guesses lock the code; even the CORRECT code is then rejected
  // (the >=5-attempt bound + invalidation; the row is locked FOR UPDATE so concurrent guesses can't bypass it).
  const otpReq2 = await inj('POST', '/api/member/auth/request-otp', undefined, { phone: '0890000001', tenant_code: 'T1' });
  let wrong5 = 0;
  for (let i = 0; i < 5; i++) { const w = await inj('POST', '/api/member/auth/verify-otp', undefined, { phone: '0890000001', tenant_code: 'T1', code: '111111' }); wrong5 = w.status; }
  const afterExhaust = await inj('POST', '/api/member/auth/verify-otp', undefined, { phone: '0890000001', tenant_code: 'T1', code: String(otpReq2.json.dev_otp) });
  ok('LYL-10b: OTP attempt-bound — 5 wrong guesses lock the code; the correct code is then rejected (brute-force cap)',
    /^[0-9]{6}$/.test(String(otpReq2.json.dev_otp ?? '')) && wrong5 === 401 && afterExhaust.status === 401,
    `wrong5=${wrong5} thenCorrect=${afterExhaust.status}`);

  // ════════ LYL-11 — Spin-the-wheel: weighted draw, free→cost, balance accounting, per-prize stock cap ════════
  const [spinMem] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-SPIN', name: 'หมุน', balance: '100', lifetime: '100', active: true }).returning({ id: s.posMembers.id });
  const wheelA = await inj('POST', '/api/loyalty/wheels', execu, { name: 'วงล้อนำโชค', cost_points: 5, daily_free_spins: 1, segments: [{ label: 'P10', prize_kind: 'points', prize_points: 10, weight: 1 }] });
  const spin1 = await inj('POST', `/api/loyalty/wheels/${wheelA.json.id}/spin`, execu, { member_id: Number(spinMem.id) });   // free spin → +10
  const spin2 = await inj('POST', `/api/loyalty/wheels/${wheelA.json.id}/spin`, execu, { member_id: Number(spinMem.id) });   // paid (5) → -5 +10
  const histW = await inj('GET', `/api/loyalty/members/${Number(spinMem.id)}/spins`, execu);
  const wheelB = await inj('POST', '/api/loyalty/wheels', execu, { name: 'รางวัลจำกัด', cost_points: 0, daily_free_spins: 99, segments: [{ label: 'L50', prize_kind: 'points', prize_points: 50, weight: 1, stock: 1 }] });
  const spinB1 = await inj('POST', `/api/loyalty/wheels/${wheelB.json.id}/spin`, execu, { member_id: Number(spinMem.id) });  // wins the only stocked prize
  const spinB2 = await inj('POST', `/api/loyalty/wheels/${wheelB.json.id}/spin`, execu, { member_id: Number(spinMem.id) });  // stock exhausted → 409
  ok('LYL-11: spin-the-wheel — weighted draw, free→cost, balance accounting, per-prize stock cap',
    spin1.json.free === true && spin1.json.prize?.points === 10 && spin1.json.balance === 110
    && spin2.json.free === false && spin2.json.cost_points === 5 && spin2.json.balance === 115
    && Array.isArray(histW.json.spins) && histW.json.spins.length === 2
    && spinB1.json.prize?.points === 50 && spinB1.json.balance === 165 && spinB2.status === 409,
    `s1=${spin1.json.balance}/${spin1.json.free} s2=${spin2.json.balance}/c${spin2.json.cost_points} hist=${histW.json.spins?.length} B1=${spinB1.json.balance} B2=${spinB2.status}`);

  // ════════ LYL-12 — Campaign orchestration: segmented send respects PDPA opt-out, audits, idempotent ════════
  const [cm1] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-CMP1', name: 'แคมเปญ1', phone: '0891111111', marketingOptIn: true, tier: 'VIPTEST', active: true }).returning({ id: s.posMembers.id });
  const [cm2] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-CMP2', name: 'แคมเปญ2', phone: '0892222222', marketingOptIn: false, tier: 'VIPTEST', active: true }).returning({ id: s.posMembers.id });
  const [cm3] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-CMP3', name: 'แคมเปญ3', phone: '0893333333', marketingOptIn: true, tier: 'VIPTEST', active: true }).returning({ id: s.posMembers.id });
  void cm1; void cm2; void cm3;
  const camp = await inj('POST', '/api/loyalty/campaigns', execu, { name: 'โปรสมาชิก VIP', channel: 'sms', audience: 'tier', tier: 'VIPTEST', body: 'รับส่วนลดพิเศษวันนี้!' });
  const sendC = await inj('POST', `/api/loyalty/campaigns/${camp.json.id}/send`, execu);
  const resend = await inj('POST', `/api/loyalty/campaigns/${camp.json.id}/send`, execu);   // already sent → 409
  ok('LYL-12: campaign — segmented send respects PDPA opt-out, audits each recipient, idempotent (no re-send)',
    String(camp.json.campaign_code ?? '').startsWith('CMP-') && sendC.json.targeted === 3 && sendC.json.sent === 2 && sendC.json.skipped === 1 && sendC.json.status === 'sent' && resend.status === 409,
    `code=${camp.json.campaign_code} targeted=${sendC.json.targeted} sent=${sendC.json.sent} skipped=${sendC.json.skipped} resend=${resend.status}`);
  // LYL-12b — a scheduled campaign is fired ONCE by run-due (claim-first: status committed before delivery, so
  // a re-run never re-sends — the at-most-once fix from the adversarial review).
  const sched = await inj('POST', '/api/loyalty/campaigns', execu, { name: 'ตั้งเวลา', channel: 'sms', audience: 'tier', tier: 'VIPTEST', body: 'โปรตั้งเวลา', schedule_at: new Date(Date.now() - 60_000).toISOString() });
  const due1 = await inj('POST', '/api/loyalty/campaigns/run-due', execu, {});
  const due2 = await inj('POST', '/api/loyalty/campaigns/run-due', execu, {});   // already sent → fires 0
  ok('LYL-12b: scheduled campaign fired once by run-due (claim-first; never re-sent on a second run)',
    sched.json.status === 'scheduled' && Number(due1.json.campaigns_sent) >= 1 && Number(due2.json.campaigns_sent) === 0,
    `sched=${sched.json.status} due1=${due1.json.campaigns_sent} due2=${due2.json.campaigns_sent}`);

  // ════════ LYL-13 — CRM SoD split (R14–R16): the granular crm_* permissions are enforced ════════
  const r14Blocked = await inj('POST', '/api/admin/users', admin, { username: 'crm_conflict', password: 'pw123456', role: 'Sales', permissions: ['crm_reward', 'pos_sell'] });   // R14: config reward + redeem at till
  const r14Msg = String(r14Blocked.json.error?.message ?? '');
  const crmClean = await inj('POST', '/api/admin/users', admin, { username: 'crm_rewardmgr', password: 'pw123456', role: 'Sales', permissions: ['crm_reward'] });   // single-duty → clean
  ok('LYL-13: CRM SoD split — crm_reward + pos_sell blocked as R14; a single-duty crm_reward role is clean',
    r14Blocked.status === 422 && r14Blocked.json.error?.code === 'SOD_CONFLICT' && r14Msg.includes('R14') && (crmClean.status === 200 || crmClean.status === 201),
    `r14=${r14Blocked.status}/${r14Blocked.json.error?.code} msg~R14=${r14Msg.includes('R14')} clean=${crmClean.status}`);

  // ════════ LYL-14 — Partner privileges: tier-gated single-use claim, per-member limit, partner redeem ════════
  const [pmA] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-PRVA', name: 'สิทธิ์A', balance: '0', lifetime: '200', active: true }).returning({ id: s.posMembers.id });
  const [pmB] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-PRVB', name: 'สิทธิ์B', balance: '0', lifetime: '50', active: true }).returning({ id: s.posMembers.id });
  const partner = await inj('POST', '/api/loyalty/partners', execu, { name: 'ร้านกาแฟพันธมิตร', category: 'dining' });
  const priv = await inj('POST', '/api/loyalty/privileges', execu, { partner_id: partner.json.id, name: 'ส่วนลด 10%', kind: 'discount_percent', value: 10, tier_min: 100, stock: 2, per_member_limit: 1 });
  const claimA = await inj('POST', `/api/loyalty/privileges/${priv.json.id}/claim`, execu, { member_id: Number(pmA.id) });
  const usePrv = await inj('POST', `/api/loyalty/privilege-claims/${claimA.json.claim_code}/use`, execu, { partner: 'ร้านกาแฟพันธมิตร' });
  const reusePrv = await inj('POST', `/api/loyalty/privilege-claims/${claimA.json.claim_code}/use`, execu, {});                  // single-use → 409
  const claimAgain = await inj('POST', `/api/loyalty/privileges/${priv.json.id}/claim`, execu, { member_id: Number(pmA.id) }); // per-member limit → 409
  const claimLow = await inj('POST', `/api/loyalty/privileges/${priv.json.id}/claim`, execu, { member_id: Number(pmB.id) });   // tier too low → 409
  ok('LYL-14: partner privilege — tier-gated single-use claim, per-member limit, partner redeem',
    String(claimA.json.claim_code ?? '').startsWith('PRV-') && usePrv.json.status === 'used' && reusePrv.status === 409 && claimAgain.status === 409 && claimLow.status === 409 && claimLow.json.error?.code === 'TIER_TOO_LOW',
    `claim=${claimA.json.claim_code} use=${usePrv.json.status} reuse=${reusePrv.status} again=${claimAgain.status} low=${claimLow.status}/${claimLow.json.error?.code}`);

  // ════════ LYL-15 — Loyalty analytics: liability + redemption funnel + churn, tenant-scoped ════════
  const analytics = await inj('GET', '/api/loyalty/analytics', execu);
  ok('LYL-15: loyalty analytics — liability + redemption funnel + churn risk (tenant-scoped)',
    analytics.status === 200 && Number(analytics.json.members?.total) > 0 && typeof analytics.json.liability?.fair_value === 'number' && typeof analytics.json.redemption?.redemption_rate_pct === 'number' && typeof analytics.json.churn_rate_pct === 'number' && typeof analytics.json.breakage_rate_pct === 'number',
    `total=${analytics.json.members?.total} fv=${analytics.json.liability?.fair_value} rr=${analytics.json.redemption?.redemption_rate_pct} churn=${analytics.json.churn_rate_pct}`);

  // ════════ LYL-16 — LINE LIFF: linked account logs in (mints member token); unlinked rejected; link works ═══════
  const [lm] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-LINE', name: 'ไลน์', balance: '0', lifetime: '0', active: true, lineUserId: 'U-line-123' }).returning({ id: s.posMembers.id });
  const lineLogin = await inj('POST', '/api/member/auth/line', undefined, { tenant_code: 'T1', id_token: 'mock:U-line-123' });
  const lineUnlinked = await inj('POST', '/api/member/auth/line', undefined, { tenant_code: 'T1', id_token: 'mock:U-nope' });
  const lineMe = await inj('GET', '/api/member/me', lineLogin.json.token);
  const relink = await inj('POST', '/api/member/link-line', lineLogin.json.token, { id_token: 'mock:U-relink-456' });
  ok('LYL-16: LINE login — linked account mints a member token; unlinked rejected; member can link',
    !!lineLogin.json.token && lineMe.json.member_code === 'M-LINE' && Number(lm.id) === lineMe.json.id && lineUnlinked.status === 401 && lineUnlinked.json.error?.code === 'LINE_NOT_LINKED' && relink.json.linked === true,
    `tok=${!!lineLogin.json.token} me=${lineMe.json.member_code} unlinked=${lineUnlinked.status}/${lineUnlinked.json.error?.code} link=${relink.json.linked}`);

  // ════════ LYL-17 — Receipt-upload-for-points: staff review gate, points via earnInTx, dup-claim blocked ════════
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const rcSubmit = await inj('POST', '/api/member/receipts', memberTok, { receipt_image: dataUrl, purchase_amount: 200, store_name: 'ร้านทดสอบ', purchase_date: '2026-06-01' });
  const rcSelfApprove = await inj('POST', `/api/loyalty/receipts/${rcSubmit.json.id}/approve`, memberTok, {});   // member token has no crm_points_adjust/loyalty/exec → 403
  const rcApprove = await inj('POST', `/api/loyalty/receipts/${rcSubmit.json.id}/approve`, execu, {});
  const rcMeAfter = await inj('GET', '/api/member/me', memberTok);
  const rcReapprove = await inj('POST', `/api/loyalty/receipts/${rcSubmit.json.id}/approve`, execu, {});   // already reviewed → 409
  const rcDup = await inj('POST', '/api/member/receipts', memberTok, { receipt_image: dataUrl, purchase_amount: 200, purchase_date: '2026-06-01' });   // same member/date/amount → blocked
  const rcSubmit2 = await inj('POST', '/api/member/receipts', memberTok, { receipt_image: dataUrl, purchase_amount: 50, purchase_date: '2026-06-02' });
  const rcReject = await inj('POST', `/api/loyalty/receipts/${rcSubmit2.json.id}/reject`, execu, { reason: 'ไม่ชัดเจน' });
  const rcMeAfterReject = await inj('GET', '/api/member/me', memberTok);
  ok('LYL-17: receipt submission is staff-reviewed (member cannot self-approve), grants points via earnInTx once, blocks duplicate claims, and reject leaves the balance untouched',
    (rcSubmit.status === 200 || rcSubmit.status === 201) && rcSubmit.json.status === 'Pending'
      && rcSelfApprove.status === 403
      && (rcApprove.status === 200 || rcApprove.status === 201) && rcApprove.json.points_granted === 200 && rcMeAfter.json.balance === 300
      && rcReapprove.status === 409 && rcReapprove.json.error?.code === 'RECEIPT_ALREADY_REVIEWED'
      && rcDup.status === 409 && rcDup.json.error?.code === 'DUPLICATE_RECEIPT'
      && (rcReject.status === 200 || rcReject.status === 201) && rcReject.json.status === 'Rejected' && rcMeAfterReject.json.balance === 300,
    `submit=${rcSubmit.status}/${rcSubmit.json.status} self=${rcSelfApprove.status} approve=${rcApprove.status}/${rcApprove.json.points_granted} bal=${rcMeAfter.json.balance} re-approve=${rcReapprove.status}/${rcReapprove.json.error?.code} dup=${rcDup.status}/${rcDup.json.error?.code} reject=${rcReject.status}/${rcReject.json.status} balAfterReject=${rcMeAfterReject.json.balance}`);

  // ════════ LYL-18 — P2P point transfer: atomic two-row move, day-capped, net-zero on the 2250 liability ════════
  const [p2pA] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-P2PA', name: 'ผู้ส่ง', phone: '0890000041', balance: '500', lifetime: '500', active: true }).returning({ id: s.posMembers.id });
  const [p2pB] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-P2PB', name: 'ผู้รับ', phone: '0890000042', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  const liaBefore18 = (await inj('GET', '/api/loyalty/liability', execu)).json;
  const p2pStaff = await inj('POST', `/api/loyalty/members/${Number(p2pA.id)}/transfer`, execu, { to_member_id: Number(p2pB.id), points: 200 });
  const p2pRows = await db.select().from(s.posMemberLedger).where(eq(s.posMemberLedger.refDoc, `P2P-${Number(p2pA.id)}-${Number(p2pB.id)}`));
  const p2pNet = p2pRows.reduce((a: number, r: any) => a + Number(r.points), 0);
  const liaAfter18 = (await inj('GET', '/api/loyalty/liability', execu)).json;
  const p2pSelfDenied = await inj('POST', `/api/loyalty/members/${Number(p2pA.id)}/transfer`, memberTok, { to_member_id: Number(p2pB.id), points: 10 }); // member token lacks crm_points_adjust/loyalty/exec → 403
  const p2pSelf = await inj('POST', '/api/member/points/transfer', memberTok, { to_phone: '0890000041', points: 50 });   // member self-service moves THEIR OWN points
  const p2pSelfSelf = await inj('POST', `/api/loyalty/members/${Number(p2pA.id)}/transfer`, execu, { to_member_id: Number(p2pA.id), points: 10 });
  await inj('PUT', '/api/loyalty/config', admin, { transfer_day_cap: 210 });
  const p2pCap = await inj('POST', `/api/loyalty/members/${Number(p2pA.id)}/transfer`, execu, { to_member_id: Number(p2pB.id), points: 20 }); // 200 already sent today → over the 210 cap
  await inj('PUT', '/api/loyalty/config', admin, { transfer_day_cap: 1000 });
  ok('LYL-18: P2P transfer — atomic two-row ledger move (net 0), staff-gated endpoint (member token 403), member self-scope path works, self-transfer rejected, day cap enforced, 2250 liability constant',
    (p2pStaff.status === 200 || p2pStaff.status === 201) && near(p2pStaff.json.from_balance, 300) && near(p2pStaff.json.to_balance, 200)
      && p2pRows.length === 2 && near(p2pNet, 0)
      && near(liaAfter18.outstanding_points, Number(liaBefore18.outstanding_points)) && near(liaAfter18.movements?.transfer_net_points ?? 0, 0)
      && p2pSelfDenied.status === 403
      && (p2pSelf.status === 200 || p2pSelf.status === 201)
      && p2pSelfSelf.status === 400 && p2pSelfSelf.json.error?.code === 'SELF_TRANSFER'
      && p2pCap.status === 409 && p2pCap.json.error?.code === 'TRANSFER_CAP',
    `staff=${p2pStaff.status} ${p2pStaff.json.from_balance}/${p2pStaff.json.to_balance} rows=${p2pRows.length} net=${p2pNet} lia ${liaBefore18.outstanding_points}→${liaAfter18.outstanding_points} denied=${p2pSelfDenied.status} self=${p2pSelf.status} selfself=${p2pSelfSelf.status}/${p2pSelfSelf.json.error?.code} cap=${p2pCap.status}/${p2pCap.json.error?.code}`);

  // V1 (docs/29) — member self-scoped expiring-points read (the /m warning chip; reads the W1 register).
  const expBy = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  await db.insert(s.loyaltyExpiryNotices).values({ tenantId: t1, memberId: Number(appMem.id), expireBy: expBy, expiringPoints: '80' }).onConflictDoNothing();
  const myExp = await inj('GET', '/api/member/points/expiring', memberTok);
  ok('V1: member reads THEIR OWN upcoming points expiry (self-scoped, from the W1 look-ahead register)',
    myExp.status === 200 && near(myExp.json.expiring_points, 80) && myExp.json.expire_by === expBy && Number(myExp.json.days_left) >= 19 && Number(myExp.json.days_left) <= 21,
    JSON.stringify(myExp.json));

  // ════════ LYL-19 — Coalition: cross-shop earn lands on the HOME ledger + balanced IC clearing; config HQ-only ════════
  // Partner shop = HQ (t2's current period is already CLOSED by the LYL-05 check above — the clearing JE
  // legs post to BOTH shops, so the partner must have an open period; the all-or-nothing behaviour on a
  // closed period is itself asserted: no points move when the clearing entry cannot post).
  await db.insert(s.users).values([{ username: 'coalB', passwordHash: await pw.hash('pw'), role: 'Customer', tenantId: hq }]).onConflictDoNothing();
  const coalB = await login('coalB', 'pw');
  const coalDenied = await inj('POST', '/api/coalition', execu, { code: 'CX', name: 'CX' });   // exec perm but not the Admin role → HQ-only guard
  const coalMk = await inj('POST', '/api/coalition', admin, { code: 'CO19', name: 'เครือ LYL-19' });
  await inj('POST', `/api/coalition/${coalMk.json.id}/members`, admin, { tenant_id: t1 });
  await inj('POST', `/api/coalition/${coalMk.json.id}/members`, admin, { tenant_id: hq });
  const [coalM] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-CO19', name: 'สมาชิกเครือ', phone: '0890000051', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  const coalEarn = await inj('POST', '/api/coalition/earn', coalB, { member_id: Number(coalM.id), net_spend: 100, ref_doc: 'CO19-S1' });
  const coalLed = await db.select().from(s.posMemberLedger).where(eq(s.posMemberLedger.refDoc, 'CO19-S1'));
  const coalIc = await inj('GET', `/api/intercompany/${coalEarn.json.ic_no}`, admin);
  const coalBurnOver = await inj('POST', '/api/coalition/redeem', coalB, { member_id: Number(coalM.id), points: 99999 });
  ok('LYL-19: coalition — partner-shop earn posts to the HOME ledger (row stays the member\'s tenant), a balanced loyalty-clearing IC entry records what the partner owes at fair value, config is HQ-only (exec ≠ Admin rejected), and the home-ledger lock still gates burns',
    coalDenied.status === 403 && coalDenied.json.error?.code === 'COALITION_HQ_ONLY'
      && (coalEarn.status === 200 || coalEarn.status === 201) && coalEarn.json.points_earned === 100 && !!coalEarn.json.ic_no
      && coalLed.length === 1 && Number((coalLed[0] as any).tenantId) === t1
      && coalIc.json.category === 'loyalty-clearing' && coalIc.json.from_tenant_id === t1 && coalIc.json.to_tenant_id === hq && near(coalIc.json.amount, 10)
      && coalBurnOver.status === 409 && coalBurnOver.json.error?.code === 'INSUFFICIENT_POINTS',
    `hq=${coalDenied.status}/${coalDenied.json.error?.code} earn=${coalEarn.status}/${coalEarn.json.error?.code ?? coalEarn.json.points_earned}/${coalEarn.json.ic_no} led=${coalLed.length}@${(coalLed[0] as any)?.tenantId} ic=${coalIc.json.category}/${coalIc.json.from_tenant_id}->${coalIc.json.to_tenant_id}/${coalIc.json.amount} burn=${coalBurnOver.status}/${coalBurnOver.json.error?.code}`);

  // ════════ LYL-20 — NPS detractor → exactly ONE owned, SLA-timed recovery case (V2, docs/29) ════════
  const [rcm20] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-LYL20', name: 'เคสกู้คืน', phone: '0890000061', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  await db.insert(s.npsResponses).values({ tenantId: t1, memberId: Number(rcm20.id), token: 'toe-lyl20-tok', expiresAt: new Date(Date.now() + 86400000) });
  const lyl20Ans = await inj('POST', '/api/nps/toe-lyl20-tok', undefined, { score: 2, comment: 'ช้ามาก' });
  const lyl20Again = await inj('POST', '/api/nps/toe-lyl20-tok', undefined, { score: 9 });
  const lyl20Cases = await db.select().from(s.recoveryCases).where(eq(s.recoveryCases.memberId, Number(rcm20.id)));
  const lyl20Case: any = lyl20Cases[0];
  const lyl20NoNote = await inj('POST', `/api/recovery/cases/${Number(lyl20Case?.id)}/resolve`, execu, {});
  const lyl20Contact = await inj('POST', `/api/recovery/cases/${Number(lyl20Case?.id)}/contact`, execu, {});
  const lyl20Resolve = await inj('POST', `/api/recovery/cases/${Number(lyl20Case?.id)}/resolve`, execu, { note: 'โทรกลับ + ชดเชย' });
  ok('LYL-20: a detractor answer opens exactly ONE Open recovery case (24h SLA; the single-use answer makes a duplicate impossible); resolution requires a note and contact/resolve are actor-stamped',
    (lyl20Ans.status === 200 || lyl20Ans.status === 201) && lyl20Ans.json.detractor === true
      && lyl20Again.status === 409
      && lyl20Cases.length === 1 && lyl20Case.status === 'Open' && lyl20Case.responseDueAt != null
      && lyl20NoNote.status === 400
      && lyl20Contact.json.status === 'Contacted' && lyl20Contact.json.contacted_by === 'execu'
      && lyl20Resolve.json.status === 'Resolved' && lyl20Resolve.json.resolved_by === 'execu',
    `ans=${lyl20Ans.status}/${lyl20Ans.json.detractor} again=${lyl20Again.status} cases=${lyl20Cases.length} noNote=${lyl20NoNote.status} contact=${lyl20Contact.json.status}/${lyl20Contact.json.contacted_by} resolve=${lyl20Resolve.json.status}`);

  // ════════ LYL-21 — paid VIP: deferred fee, monthly recognition, tier auto-revoke on lapse (V4, docs/29) ════════
  const v4plan = await inj('POST', '/api/loyalty/membership-plans', execu, { code: 'TOE-VIP', name: 'ToE VIP', tier: 'Gold', price: 600, period_months: 6 });
  const [v4m] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-VIP21', name: 'วีไอพี', phone: '0890000071', balance: '0', lifetime: '0', active: true }).returning({ id: s.posMembers.id });
  const v4start = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const v4sell = await inj('POST', '/api/loyalty/memberships/sell', execu, { member_id: Number(v4m.id), plan_id: v4plan.json.id, start_date: v4start });
  const v4rec = await inj('POST', '/api/loyalty/memberships/recognize', execu, {});
  const v4rec2 = await inj('POST', '/api/loyalty/memberships/recognize', execu, {});
  const v4gl = (await pg.query(`SELECT jl.account_code, sum(jl.debit)::float d, sum(jl.credit)::float c FROM journal_lines jl JOIN journal_entries je ON jl.entry_id=je.id WHERE je.source_ref LIKE 'VIP-${v4sell.json.id}%' GROUP BY jl.account_code`)).rows as any[];
  const bal = (code: string, side: 'd' | 'c') => Number(v4gl.find((r: any) => r.account_code === code)?.[side] ?? 0);
  ok('LYL-21: VIP fee is DEFERRED (Cr 2410) and recognized straight-line to 4300 only as months elapse (idempotent re-run posts 0) — revenue is never taken up-front',
    (v4sell.status === 200 || v4sell.status === 201) && bal('1000', 'd') === 600 && bal('2410', 'c') === 600
      && v4rec.json.posted === 2 && near(v4rec.json.amount, 200) && v4rec2.json.posted === 0
      && near(bal('2410', 'd'), 200) && near(bal('4300', 'c'), 200),
    `sell=${v4sell.status} cash=${bal('1000','d')} defer=${bal('2410','c')} rec=${v4rec.json.posted}/${v4rec.json.amount} rerun=${v4rec2.json.posted} released=${bal('2410','d')} rev=${bal('4300','c')}`);

  // ════════ MKT-12 — Lifecycle journeys: consent-gated, frequency-capped, at-most-once per step ════════
  // An opted-out member enrols but the step send is SKIPPED (audited in message_log); a re-run fires
  // nothing (the enrollment-step was claimed before delivery — claim-first, mirrors MKT-10).
  const [jm1] = await db.insert(s.posMembers).values({ tenantId: t1, memberCode: 'M-JNY1', name: 'เจอร์นีย์', phone: '0890000031', balance: '0', lifetime: '0', active: true, marketingOptIn: false }).returning({ id: s.posMembers.id });
  const jny = await inj('POST', '/api/loyalty/journeys', execu, { name: 'MKT-12 series', trigger: 'manual', cap_messages: 1, cap_window_days: 7, steps: [{ wait_days: 0, channel: 'sms', body: 'ยินดีต้อนรับ' }] });
  await inj('POST', `/api/loyalty/journeys/${jny.json.id}/activate`, execu, {});
  await inj('POST', `/api/loyalty/journeys/${jny.json.id}/enroll`, execu, { member_id: Number(jm1.id) });
  const jr1 = await inj('POST', '/api/loyalty/journeys/run-due', execu, {});
  const jr2 = await inj('POST', '/api/loyalty/journeys/run-due', execu, {});
  const jrows = await db.select().from(s.messageLog).where(and(eq(s.messageLog.tenantId, t1), eq(s.messageLog.campaign, `journey:${jny.json.code}:1`)));
  ok('MKT-12: journey step is consent-gated (opted-out ⇒ skipped, audited) and at-most-once (a re-run fires nothing)',
    jr1.json.sent === 0 && (jr1.json.skipped ?? 0) >= 1 && jr2.json.sent === 0 && (jr2.json.skipped ?? 0) === 0 && jrows.length === 1 && jrows[0].status === 'skipped',
    `run1={sent:${jr1.json.sent},skipped:${jr1.json.skipped}} run2={sent:${jr2.json.sent},skipped:${jr2.json.skipped}} audited=${jrows[0]?.status}`);

  // ════════════════════════ INV-06 — Perpetual inventory sub-ledger ↔ GL reconciliation ════════════════════════
  // Receipts/issues/adjustments post valued moves + balanced JEs; the sub-ledger value ties to the inventory
  // control account (1200). Negative/oversold stock is prevented (INV-01); duplicate receipts idempotent (INV-02);
  // adjustments must be justified (INV-04). Run as admin — reconcile() filters to the INV-* sources for this tenant.
  const invNear = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;
  await inj('POST', '/api/inventory/receipts', admin, { item_id: 'INVCTL', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'C-GRN-1' });
  await inj('POST', '/api/inventory/receipts', admin, { item_id: 'INVCTL', qty: 100, unit_cost: 12, ref_type: 'GRN', ref_id: 'C-GRN-2' }); // moving avg → 11
  const invDup = await inj('POST', '/api/inventory/receipts', admin, { item_id: 'INVCTL', qty: 100, unit_cost: 10, ref_type: 'GRN', ref_id: 'C-GRN-1' });
  ok('INV-02: duplicate goods-receipt (same ref) is idempotent — no double stock / no double GL', invDup.json.deduped === true, `dedup=${invDup.json.deduped}`);
  await inj('POST', '/api/inventory/issues', admin, { item_id: 'INVCTL', qty: 50 }); // COGS 550 @ avg 11 → bal 150
  const invNeg = await inj('POST', '/api/inventory/issues', admin, { item_id: 'INVCTL', qty: 1000 });
  ok('INV-01: issue beyond on-hand blocked in the sub-ledger (no negative/oversold stock)', invNeg.status === 400 && invNeg.json.error?.code === 'NEG_STOCK', `${invNeg.status}/${invNeg.json.error?.code}`);
  // INV-07: a write-off is maker-checker — request (admin) posts nothing; a different user (whchk) approves → applied.
  const whchk = await login('whchk', 'pw');
  const invWo = await inj('POST', '/api/inventory/adjustments', admin, { item_id: 'INVCTL', qty_delta: -10, reason: 'Spoilage' });
  ok('INV-07: stock write-off is a request (pending), nothing posted yet', invWo.json.status === 'pending_approval' && invWo.json.request_id > 0, JSON.stringify(invWo.json).slice(0, 70));
  const invWoSelf = await inj('POST', `/api/inventory/writeoffs/${invWo.json.request_id}/approve`, admin);
  ok('INV-07: requester self-approval blocked → 403 SOD_VIOLATION', invWoSelf.status === 403 && invWoSelf.json.error?.code === 'SOD_VIOLATION', `${invWoSelf.status}/${invWoSelf.json.error?.code}`);
  const invWoAppr = await inj('POST', `/api/inventory/writeoffs/${invWo.json.request_id}/approve`, whchk);
  ok('INV-07: write-off approved by a different user → applied (bal 140 @ 11 = 1540)', invWoAppr.json.status === 'Posted' && invNear(invWoAppr.json.balance_qty, 140) && invWoAppr.json.approved_by === 'whchk', JSON.stringify(invWoAppr.json).slice(0, 90));
  const invNoReason = await inj('POST', '/api/inventory/adjustments', admin, { item_id: 'INVCTL', qty_delta: -1, reason: '   ' });
  ok('INV-04: a stock adjustment without a reason is rejected (justified + audited)', invNoReason.status === 400 && invNoReason.json.error?.code === 'REASON_REQUIRED', `${invNoReason.status}/${invNoReason.json.error?.code}`);
  const invRec = await inj('GET', '/api/inventory/reconciliation', admin);
  ok('INV-06: perpetual sub-ledger value ties to the GL inventory control account (1200) — reconciled',
    invNear(invRec.json.sub_ledger_value, 1540) && invNear(invRec.json.gl_inventory, 1540) && invRec.json.reconciled === true,
    `sub=${invRec.json.sub_ledger_value} gl=${invRec.json.gl_inventory} rec=${invRec.json.reconciled}`);

  // ════════════════════════ INV-08 — Bin-capacity / location integrity ════════════════════════
  // Putaway cannot fill a bin beyond its physical capacity; layout/locate expose where stock physically is.
  await inj('POST', '/api/wms/bins', admin, { bin_code: 'CAPZ-1', bin_type: 'storage', capacity: 5, pos_x: 0, pos_y: 0, pos_z: 0 });
  const capOk = await inj('POST', '/api/wms/putaway', admin, { gr_no: 'GR-CAPZ-1', bin_code: 'CAPZ-1', item_id: 'INVCTL', qty: 4 });
  ok('INV-08: putaway within bin capacity accepted (4 ≤ 5)', capOk.status < 300, `st=${capOk.status}`);
  const capBad = await inj('POST', '/api/wms/putaway', admin, { gr_no: 'GR-CAPZ-2', bin_code: 'CAPZ-1', item_id: 'INVCTL', qty: 3 });
  ok('INV-08: putaway beyond bin capacity rejected → 422 BIN_CAPACITY_EXCEEDED', capBad.status === 422 && capBad.json.error?.code === 'BIN_CAPACITY_EXCEEDED', `${capBad.status}/${capBad.json.error?.code}`);
  const capLay = await inj('GET', '/api/wms/layout', admin);
  const capBin = (capLay.json.bins ?? []).find((b: any) => b.bin_code === 'CAPZ-1');
  ok('INV-08: layout reports the bin utilisation (4 ÷ 5 = 0.8)', !!capBin && capBin.capacity === 5 && capBin.on_hand === 4 && invNear(capBin.utilization, 0.8), JSON.stringify({ cap: capBin?.capacity, oh: capBin?.on_hand, u: capBin?.utilization }));

  // ════════════════════════ EXP-08 — Petty-cash float + disbursement maker-checker (SoD) ════════════════════════
  // A petty-cash fund holds cash capped at a credit limit; each expense/advance is a request a DIFFERENT user
  // must approve before the GL posts and the fund is decremented; a draw cannot exceed the fund balance.
  const pcFund = await inj('POST', '/api/finance/petty-cash/funds', admin, { fund_code: 'PCFZ-1', float_limit: 3000, initial_amount: 3000 });
  ok('EXP-08/G3: establish a petty-cash fund → initial funding PendingApproval (no cash yet, balance 0)', pcFund.json?.pending === true && pcFund.json?.balance === 0 && !!pcFund.json?.funding_req_no, JSON.stringify({ st: pcFund.status, bal: pcFund.json?.balance, pend: pcFund.json?.pending }));
  const pcFundSelf = await inj('POST', `/api/finance/petty-cash/requests/${pcFund.json?.funding_req_no}/approve`, admin);
  ok('EXP-08/G3: fund establishment self-approval blocked → 403 SOD_VIOLATION', pcFundSelf.status === 403 && pcFundSelf.json?.error?.code === 'SOD_VIOLATION', `${pcFundSelf.status}/${pcFundSelf.json?.error?.code}`);
  const pcFundAppr = await inj('POST', `/api/finance/petty-cash/requests/${pcFund.json?.funding_req_no}/approve`, whchk);
  ok('EXP-08/G3: an independent approver funds the imprest → Dr 1015 / Cr 1000 (balance 3000)', pcFundAppr.json?.fund_balance === 3000 && pcFundAppr.json?.approved_by === 'whchk', JSON.stringify({ fb: pcFundAppr.json?.fund_balance }));
  const pcReq = await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCFZ-1', kind: 'expense', payee: 'Office supplies', amount: 1000, expense_account: '5100', doc_ref: 'RCPT-Z1' });
  ok('EXP-08: expense request raised PendingApproval (no GL yet)', pcReq.json?.status === 'PendingApproval' && pcReq.json?.amount === 1000, JSON.stringify({ st: pcReq.json?.status }));
  const pcSelf = await inj('POST', `/api/finance/petty-cash/requests/${pcReq.json?.req_no}/approve`, admin);
  ok('EXP-08: preparer self-approval blocked → 403 SOD_VIOLATION', pcSelf.status === 403 && pcSelf.json?.error?.code === 'SOD_VIOLATION', `${pcSelf.status}/${pcSelf.json?.error?.code}`);
  const pcAppr = await inj('POST', `/api/finance/petty-cash/requests/${pcReq.json?.req_no}/approve`, whchk);
  ok('EXP-08: independent approver disburses → Dr 5100 / Cr 1015 (1000); fund 2000', pcAppr.json?.status === 'Approved' && pcAppr.json?.fund_balance === 2000 && pcAppr.json?.approved_by === 'whchk', JSON.stringify({ st: pcAppr.json?.status, fb: pcAppr.json?.fund_balance }));
  const pcOver = await inj('POST', '/api/finance/petty-cash/requests', admin, { fund_code: 'PCFZ-1', kind: 'expense', payee: 'Too big', amount: 5000 });
  ok('EXP-08: a draw beyond the fund balance is rejected → 422 INSUFFICIENT_FLOAT', pcOver.status === 422 && pcOver.json?.error?.code === 'INSUFFICIENT_FLOAT', `${pcOver.status}/${pcOver.json?.error?.code}`);

  // ════════════════════════ ITGC-AC-15 — Session revocation ════════════════════════
  await db.insert(s.users).values([
    { username: 'revokeme', passwordHash: await pw.hash('rightpw'), role: 'Sales', tenantId: t1 },
    { username: 'deactme', passwordHash: await pw.hash('rightpw'), role: 'Sales', tenantId: t1 },
    { username: 'revallme', passwordHash: await pw.hash('rightpw'), role: 'Sales', tenantId: t1 },
  ]).onConflictDoNothing();
  // Single-session revocation: logout denylists the token's jti → it stops working immediately.
  const rvTok = await login('revokeme', 'rightpw');
  const rvBefore = await inj('GET', '/api/auth/me', rvTok);
  await inj('POST', '/api/auth/logout', rvTok);
  const rvAfter = await inj('GET', '/api/auth/me', rvTok);
  ok('ITGC-AC-15: logged-out token is revoked → 401 TOKEN_REVOKED (worked before logout)', rvBefore.status === 200 && rvAfter.status === 401 && rvAfter.json?.error?.code === 'TOKEN_REVOKED', `before=${rvBefore.status} after=${rvAfter.status}/${rvAfter.json?.error?.code}`);
  // Deactivation enforced live: an existing token is rejected once the account is deactivated.
  const dvTok = await login('deactme', 'rightpw');
  await db.update(s.users).set({ isActive: false }).where(eq(s.users.username, 'deactme'));
  const dvAfter = await inj('GET', '/api/auth/me', dvTok);
  ok('ITGC-AC-15: deactivated account’s existing token is rejected → 401 USER_DEACTIVATED', dvAfter.status === 401 && dvAfter.json?.error?.code === 'USER_DEACTIVATED', `${dvAfter.status}/${dvAfter.json?.error?.code}`);
  // Revoke-all (incident response): an admin forces logout everywhere; pre-existing tokens die.
  const raTok = await login('revallme', 'rightpw');
  const raAdmin = await inj('POST', '/api/auth/users/revallme/revoke-sessions', admin);
  const raAfter = await inj('GET', '/api/auth/me', raTok);
  ok('ITGC-AC-15: revoke-all-sessions invalidates pre-existing tokens → 401', raAdmin.status === 200 && raAdmin.json?.revoked_all === true && raAfter.status === 401, `revoke=${raAdmin.status} after=${raAfter.status}`);

  // REC-04 — period-end control-account reconciliation PACK ties every sub-ledger to its GL control account.
  const recPack = await inj('GET', '/api/finance/reconciliation/controls', admin);
  const inv1200 = (recPack.json.lines ?? []).find((l: any) => l.account === '1200');
  ok('REC-04: control-account pack lists 5 accounts (1100/2000/1200/2200/2400); inventory 1200 sub-ledger ties to GL',
    (recPack.json.lines ?? []).length === 5 && ['1100', '2000', '1200', '2200', '2400'].every((a) => (recPack.json.lines ?? []).some((l: any) => l.account === a)) && inv1200?.reconciled === true && invNear(inv1200.sub_ledger, 1540) && typeof recPack.json.exceptions === 'number',
    JSON.stringify({ n: recPack.json.lines?.length, inv: inv1200?.sub_ledger, rec: inv1200?.reconciled, exc: recPack.json.exceptions }));

  // GOV-01 — pending-approvals monitor: a fresh Draft JE (not approved) surfaces in the unified worklist.
  const govJe = await inj('POST', '/api/ledger/journal', glacct, { date: today, memo: 'GOV-01 pending JE', source: 'Manual', lines: [{ account_code: '1000', debit: 321 }, { account_code: '4000', credit: 321 }] });
  const govPend = await inj('GET', '/api/finance/approvals/pending', admin);
  const govItem = (govPend.json.items ?? []).find((i: any) => i.ref === govJe.json.entry_no);
  ok('GOV-01: pending-approvals monitor surfaces the Draft JE (control GL-05, amount + age + overdue roll-up)',
    govItem?.type === 'journal' && govItem?.control === 'GL-05' && invNear(govItem?.amount, 321) && typeof govItem?.age_days === 'number' && govPend.json.count >= 1 && typeof govPend.json.overdue === 'number',
    JSON.stringify({ n: govPend.json.count, oldest: govPend.json.oldest_age_days, ctrl: govItem?.control, amt: govItem?.amount }));

  // ════════════════════════ GL-10 — Industry Chart-of-Accounts templates ════════════════════════
  // A new company picks its industry at signup → a curated, industry-named chart over the canonical codes.
  // The boot subset-assertion (this app started ⇒ it passed) keeps templates from drifting from the engine's
  // fixed posting codes; the overlay scopes presentation only (?all=true still exposes the full universe).
  const sgC = await inj('POST', '/api/auth/signup', undefined, {
    company_name: 'Resto ICFR', tenant_code: 'RESTC', admin_username: 'restc_admin', admin_password: 'restc12345', email: 'a@restc.example', industry: 'restaurant',
  });
  ok('GL-10: signup provisions the chosen industry CoA template (industry echoed)', (sgC.status === 200 || sgC.status === 201) && sgC.json?.industry === 'restaurant', `st=${sgC.status} ind=${sgC.json?.industry}`);
  const restcTok = await login('restc_admin', 'restc12345');
  const restcAcc = (await inj('GET', '/api/ledger/accounts', restcTok)).json;
  const restcAll = (await inj('GET', '/api/ledger/accounts?all=true', restcTok)).json;
  ok('GL-10: chart is overlay-scoped + industry-named, curating out non-industry accounts (no 4300 Service)',
    restcAcc.source === 'overlay' && restcAcc.accounts?.find((a: any) => a.code === '4000')?.name === 'Food & Beverage Sales' && !restcAcc.accounts?.some((a: any) => a.code === '4300'),
    `src=${restcAcc.source} n=${restcAcc.count}`);
  ok('GL-10: overlay never gates posting — ?all=true still exposes the full canonical universe (4300 present)',
    restcAll.source === 'canonical' && restcAll.accounts?.some((a: any) => a.code === '4300') && restcAll.count > restcAcc.count,
    `all=${restcAll.count} overlay=${restcAcc.count}`);

  // ════════════════════════ GL-11 — Chart-of-Accounts change control ════════════════════════
  // Two write surfaces, two duties: the GLOBAL canonical universe (`accounts`, shared by every tenant) is a
  // PLATFORM/HQ duty (role Admin + gl_coa); per-tenant chart curation (`tenant_accounts` overlay) is a tenant
  // duty (gl_coa, RLS-scoped). Exercises the CoaController now that it is reachable at /api/ledger/accounts.

  // 1. GL-27 (COA follow-up C): a canonical create by a platform Admin STAGES a change request — with more
  //    than one active Admin in the system (this DB has many) nothing touches the chart yet.
  const mkAcct = await inj('POST', '/api/ledger/accounts', admin, { code: '9990', name: 'ToE Custom Expense', type: 'Expense' });
  ok('GL-27: platform Admin canonical create → staged PendingApproval (no chart effect yet)',
    (mkAcct.status === 200 || mkAcct.status === 201) && mkAcct.json.status === 'PendingApproval' && mkAcct.json.account_code === '9990',
    `${mkAcct.status} ${JSON.stringify(mkAcct.json)}`);

  // 1b. A second request for the SAME code while one is pending is refused fail-closed.
  const dupPending = await inj('POST', '/api/ledger/accounts', admin, { code: '9990', name: 'dup while pending', type: 'Expense' });
  ok('GL-27: a second request for the same code while pending → 400 CHANGE_ALREADY_PENDING',
    dupPending.status === 400 && dupPending.json.error?.code === 'CHANGE_ALREADY_PENDING', `${dupPending.status} ${dupPending.json.error?.code}`);

  // 1c. The creator cannot approve their own request (SoD binds even Admin).
  const selfAppr = await inj('POST', `/api/ledger/accounts/change-requests/${mkAcct.json.id}/approve`, admin);
  ok('GL-27: creator self-approval → 403 SOD_VIOLATION',
    selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);

  // 1d. A DIFFERENT Admin approves → the account NOW exists (auto-defaulted normal balance + postable, GL-11 semantics).
  const apprAcct = await inj('POST', `/api/ledger/accounts/change-requests/${mkAcct.json.id}/approve`, whchk);
  ok('GL-27→GL-11: a DIFFERENT Admin approves → account created (D-normal, postable)',
    apprAcct.status === 200 && apprAcct.json.code === '9990' && apprAcct.json.normalBalance === 'D' && apprAcct.json.isPostable === true,
    `${apprAcct.status} ${JSON.stringify(apprAcct.json)}`);

  // 1d-bis. P4 guardrail: the chart keeps ONE level of sub-accounts — a create under a code that is ITSELF
  // a sub-account (126001 WIP-Earthwork, whose parent is 1260) is refused fail-closed at request time;
  // deeper analytical detail belongs to a posting dimension (cost centre / project / branch), not a code.
  const deepSub = await inj('POST', '/api/ledger/accounts', admin, { code: '126099', name: 'WIP earthwork — zone A', type: 'Asset', parentCode: '126001' });
  ok('P4/GL-27: a sub-account of a sub-account → 400 SUBACCOUNT_TOO_DEEP (use a dimension for deeper detail)',
    deepSub.status === 400 && deepSub.json.error?.code === 'SUBACCOUNT_TOO_DEEP', `${deepSub.status} ${deepSub.json.error?.code}`);

  // 1e. A rejected request leaves the chart untouched.
  const rejReq = await inj('POST', '/api/ledger/accounts', admin, { code: '9993', name: 'to be rejected', type: 'Expense' });
  const govCoa = await inj('GET', '/api/finance/approvals/pending', admin);
  ok('COA-D1 (GOV-01): the staged GL-27 request surfaces in the pending-approvals center',
    (govCoa.json.items ?? []).some((i: any) => i.type === 'coa_change' && i.control === 'GL-27' && i.ref === `COA-${rejReq.json.id}`),
    `types=${JSON.stringify(govCoa.json.by_type ?? {})}`);
  const rejDone = await inj('POST', `/api/ledger/accounts/change-requests/${rejReq.json.id}/reject`, whchk, { reason: 'not needed' });
  const rejGone = await inj('GET', '/api/ledger/accounts/9993/where-used', admin);
  ok('GL-27: reject closes the request and the account never exists',
    rejDone.status === 200 && rejDone.json.status === 'Rejected' && rejGone.status === 404,
    `${rejDone.status} ${rejDone.json.status} lookup=${rejGone.status}`);

  // 2. Duplicate code is refused fail-closed at REQUEST time (9990 now exists after 1d).
  const dupAcct = await inj('POST', '/api/ledger/accounts', admin, { code: '9990', name: 'dup', type: 'Expense' });
  ok('GL-11: duplicate account code → 400 DUPLICATE_ACCOUNT',
    dupAcct.status === 400 && dupAcct.json.error?.code === 'DUPLICATE_ACCOUNT', `${dupAcct.status} ${dupAcct.json.error?.code}`);

  // 3. A tenant gl_coa holder (FinancialController) is BLOCKED from mutating the SHARED canonical universe —
  //    it must not silently change the chart other tenants post against (the flagged cross-tenant risk).
  const fcMk = await inj('POST', '/api/ledger/accounts', fincon, { code: '9991', name: 'x', type: 'Expense' });
  ok('GL-11: a tenant gl_coa holder (non-Admin) is BLOCKED from canonical CoA writes → 403 COA_ADMIN_ONLY',
    fcMk.status === 403 && fcMk.json.error?.code === 'COA_ADMIN_ONLY', `${fcMk.status} ${fcMk.json.error?.code}`);

  // 4. A role without gl_coa (GlAccountant — SoD-separated from CoA maintenance) is blocked outright.
  const gaMk = await inj('POST', '/api/ledger/accounts', glacct, { code: '9992', name: 'x', type: 'Expense' });
  ok('GL-11: a role without gl_coa (GlAccountant) is BLOCKED from CoA writes → 403',
    gaMk.status === 403 && gaMk.json.error?.code === 'FORBIDDEN', `${gaMk.status} ${gaMk.json.error?.code}`);

  // 5. Deactivating an account that carries a balance is refused (no orphaned balance in a "closed" account).
  //    Give 9990 activity via a JE, then attempt to deactivate it.
  await inj('POST', '/api/ledger/journal', glacct, { date: today, source: 'Manual', memo: 'GL-11 balance', lines: [{ account_code: '9990', debit: 500 }, { account_code: '4000', credit: 500 }] });
  const deac = await inj('POST', '/api/ledger/accounts/9990/deactivate', admin);
  ok('GL-11: deactivating an account with a non-zero balance → 400 ACCOUNT_HAS_BALANCE',
    deac.status === 400 && deac.json.error?.code === 'ACCOUNT_HAS_BALANCE', `${deac.status} ${deac.json.error?.code}`);

  // 5b. Account-universe guard (GL-21 extension, docs/42 step 1): a manual JE naming an account that does
  //     not exist in the canonical chart is rejected fail-closed — it would otherwise post silently and
  //     then vanish from every typed report (they INNER JOIN accounts).
  const ghost = await inj('POST', '/api/ledger/journal', glacct, { date: today, source: 'Manual', memo: 'ghost account', lines: [{ account_code: '6666', debit: 100 }, { account_code: '4000', credit: 100 }] });
  ok('GL-21: manual JE to a non-existent account → 400 INVALID_POSTING_ACCOUNT (account-universe guard)',
    ghost.status === 400 && ghost.json.error?.code === 'INVALID_POSTING_ACCOUNT', `${ghost.status} ${ghost.json.error?.code}`);

  // 5c. GL-24 — posting-rule change governance (docs/43 PR-1). Rule writes are validated FAIL-CLOSED
  //     against the posting-event registry (tier/role/side/account), land PendingApproval, and only a
  //     DIFFERENT user can activate them; every action lands in the append-only audit trail.
  const prPinned = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PAYROLL.GROSS', legOrder: 9, role: 'net_pay_cash', side: 'CR', accountCode: '4000' });
  ok('GL-24: overriding a PINNED role (net-pay cash) → 400 OVERRIDE_ROLE_PINNED',
    prPinned.status === 400 && prPinned.json.error?.code === 'OVERRIDE_ROLE_PINNED', `${prPinned.status} ${prPinned.json.error?.code}`);
  const prRole = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PAYROLL.GROSS', legOrder: 9, role: 'bogus_role', side: 'DR', accountCode: '5100' });
  ok('GL-24: unknown role for the event → 400 UNKNOWN_POSTING_ROLE',
    prRole.status === 400 && prRole.json.error?.code === 'UNKNOWN_POSTING_ROLE', `${prRole.status} ${prRole.json.error?.code}`);
  const prSide = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PAYROLL.GROSS', legOrder: 9, role: 'wages_expense', side: 'CR', accountCode: '5100' });
  ok('GL-24: side mismatch (wages_expense posts DR) → 400 POSTING_SIDE_MISMATCH',
    prSide.status === 400 && prSide.json.error?.code === 'POSTING_SIDE_MISMATCH', `${prSide.status} ${prSide.json.error?.code}`);
  const prAcct = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PAYROLL.GROSS', legOrder: 9, role: 'wages_expense', side: 'DR', accountCode: '6666' });
  ok('GL-24: override to a non-existent account → 400 INVALID_POSTING_ACCOUNT (fail-closed at save)',
    prAcct.status === 400 && prAcct.json.error?.code === 'INVALID_POSTING_ACCOUNT', `${prAcct.status} ${prAcct.json.error?.code}`);
  const prOk = await inj('POST', '/api/ledger/posting-rules', admin, { eventType: 'PAYROLL.GROSS', legOrder: 1, role: 'wages_expense', side: 'DR', accountCode: '5100' });
  ok('GL-24: a VALID rule write lands PendingApproval (no posting effect yet)',
    prOk.status === 201 && prOk.json.status === 'PendingApproval', `${prOk.status} st=${prOk.json.status}`);
  const govPr = await inj('GET', '/api/finance/approvals/pending', admin);
  ok('COA-D1 (GOV-01): the pending GL-24 override surfaces in the pending-approvals center',
    (govPr.json.items ?? []).some((i: any) => i.type === 'posting_rule' && i.control === 'GL-24' && i.ref === `PRULE-${prOk.json.id}`),
    `types=${JSON.stringify(govPr.json.by_type ?? {})}`);
  const prSelf = await inj('POST', `/api/ledger/posting-rules/${prOk.json.id}/approve`, admin);
  ok('GL-24: creator self-approval → 403 SOD_VIOLATION (binds even Admin)',
    prSelf.status === 403 && prSelf.json.error?.code === 'SOD_VIOLATION', `${prSelf.status} ${prSelf.json.error?.code}`);
  const prAppr = await inj('POST', `/api/ledger/posting-rules/${prOk.json.id}/approve`, whchk);
  ok('GL-24: a DIFFERENT user approves → Approved (rule now live for the resolver)',
    prAppr.status === 200 && prAppr.json.status === 'Approved' && prAppr.json.approvedBy === 'whchk', `${prAppr.status} st=${prAppr.json.status}`);
  const prAudit = await inj('GET', '/api/ledger/posting-rules/audit', admin);
  const auditActions = (prAudit.json.audit ?? []).map((a: any) => a.action);
  ok('GL-24: append-only audit trail carries the CREATE + APPROVE rows',
    auditActions.includes('CREATE') && auditActions.includes('APPROVE'), `actions=${auditActions.slice(0, 6).join(',')}`);
  const prDeact = await inj('POST', `/api/ledger/posting-rules/${prOk.json.id}/deactivate`, admin);
  ok('GL-24: deactivate retires the rule (postings fall back to the registry default)',
    prDeact.status === 200 && prDeact.json.active === false, `${prDeact.status} active=${prDeact.json.active}`);

  // 6. Per-tenant overlay curation (gl_coa): a tenant's FinancialController shapes its OWN chart (rename 4000)
  //    without touching the canonical universe. Isolated on the freshly-provisioned RESTC restaurant tenant.
  const restcTid = await tid('RESTC');
  await db.insert(s.users).values({ username: 'restc_fc', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: restcTid }).onConflictDoNothing();
  const restcFc = await login('restc_fc', 'pw');
  const cur = await inj('PATCH', '/api/ledger/accounts/4000/overlay', restcFc, { display_name: 'Curated F&B Sales', sort_order: 3 });
  ok('GL-11: a tenant gl_coa holder curates its OWN chart via the overlay → 200',
    (cur.status === 200 || cur.status === 201) && cur.json.accountCode === '4000' && cur.json.displayName === 'Curated F&B Sales', `${cur.status} ${JSON.stringify(cur.json)}`);

  // 6a. The curation is reflected on THIS tenant's chart.
  const restcAfter = (await inj('GET', '/api/ledger/accounts', restcTok)).json;
  ok('GL-11: overlay curation is reflected on the tenant\'s own chart',
    restcAfter.accounts?.find((a: any) => a.code === '4000')?.name === 'Curated F&B Sales',
    `4000=${restcAfter.accounts?.find((a: any) => a.code === '4000')?.name}`);

  // 6b. …and NEVER leaks cross-tenant: another tenant's chart still shows 4000's canonical name (RLS-scoped).
  const t1Acc = (await inj('GET', '/api/ledger/accounts', execu)).json;
  ok('GL-11: overlay curation is RLS-scoped — another tenant\'s chart is unaffected',
    t1Acc.accounts?.find((a: any) => a.code === '4000')?.name !== 'Curated F&B Sales',
    `t1 4000=${t1Acc.accounts?.find((a: any) => a.code === '4000')?.name}`);

  // 6c. Overlay curation is a gl_coa duty — a role without gl_coa is blocked (SoD).
  const curBlocked = await inj('PATCH', '/api/ledger/accounts/5100/overlay', glacct, { active: false });
  ok('GL-11: overlay curation requires gl_coa — a non-gl_coa role is BLOCKED → 403',
    curBlocked.status === 403, `${curBlocked.status} ${curBlocked.json.error?.code}`);

  // 6d. A curated-off account is hidden from the default chart but stays visible under `?include_inactive=true`
  //     so the gl_coa curator can re-activate it (the management surface behind the /accounting ผังบัญชี edit UI).
  await inj('PATCH', '/api/ledger/accounts/5100/overlay', restcFc, { active: false });
  const iaHidden = (await inj('GET', '/api/ledger/accounts', restcFc)).json;
  const iaMgmt = (await inj('GET', '/api/ledger/accounts?include_inactive=true', restcFc)).json;
  ok('GL-11: curated-off account hidden from the default chart, still listed under include_inactive=true (active=false, re-activatable)',
    !iaHidden.accounts?.some((a: any) => a.code === '5100') && iaMgmt.accounts?.some((a: any) => a.code === '5100' && a.active === false),
    `hidden=${!iaHidden.accounts?.some((a: any) => a.code === '5100')} inMgmt=${iaMgmt.accounts?.some((a: any) => a.code === '5100')}`);
  await inj('PATCH', '/api/ledger/accounts/5100/overlay', restcFc, { active: true });
  const iaBack = (await inj('GET', '/api/ledger/accounts', restcFc)).json;
  ok('GL-11: re-activating (active=true) restores the account to the default chart',
    iaBack.accounts?.some((a: any) => a.code === '5100'), `back=${iaBack.accounts?.some((a: any) => a.code === '5100')}`);

  // ════════════════════════ EXP-01/EXP-09 — 3-way match HARD-GATES AP payment (PO↔GR↔Invoice) ════════════════════════
  // (The PwC panel referenced this as "EXP-03"; in the RCM the 3-way-match gate is EXP-01 and the AP-pay-
  //  consults-match control is EXP-09 — RCM EXP-03 is a different control, PR/PO authorization. See
  //  compliance/CONTROL_STATUS_HONEST.md for the panel↔RCM ID crosswalk.)
  // A PO-based supplier invoice that fails 3-way match (price/qty variance beyond tolerance) is BLOCKED from
  // payment until a DIFFERENT user (≠ the matcher) overrides the variance with a reason. This surfaces the
  // control in the formal ICFR ToE harness (the enforcement + variance cases also live in `match`).
  // Run LAST: the goods-receipt + unpaid bill perturb the inventory(1200)/AP(2000) control accounts, so this
  // must follow the REC-04 control-account reconciliation assertion. Run as HQ admins (matcher = admin,
  // overrider = whchk) so the match row stays RLS-consistent.
  const exOverrider = await login('whchk', 'pw'); // independent overrider (HQ Admin, ≠ admin)
  const [vExp] = await db.insert(s.vendors).values({ name: 'ผู้ขาย EXP-03', isSupplier: true, approvalStatus: 'approved', blocklisted: false }).returning({ id: s.vendors.id });
  const VEXP = Number(vExp.id);
  await db.insert(s.items).values({ itemId: 'EXP3X', itemDescription: 'วัตถุดิบ EXP-03', uom: 'EA', unitPrice: '10' }).onConflictDoNothing();
  // setup: PO 100@10 → approve → GR 100 (the "received/ordered" sides of the match)
  const exPo = await inj('POST', '/api/procurement/pos', admin, { vendor_id: VEXP, items: [{ item_id: 'EXP3X', order_qty: 100, unit_price: 10 }] });
  const exPoNo = exPo.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${exPoNo}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: exPoNo, items: [{ item_id: 'EXP3X', received_qty: 100 }] });
  // EXP-03: a GR against an UNAPPROVED (Pending) PO is BLOCKED — receiving must wait for the maker-checker
  // approval, so an unapproved PO can't trigger a GR + AP liability (defeating the 3-way match).
  const exPoPend = await inj('POST', '/api/procurement/pos', admin, { vendor_id: VEXP, items: [{ item_id: 'EXP3X', order_qty: 5, unit_price: 10 }] });
  const exGrBlocked = await inj('POST', '/api/procurement/grs', admin, { po_no: exPoPend.json.po_no, items: [{ item_id: 'EXP3X', received_qty: 5 }] });
  ok('EXP-03: GR against an unapproved (Pending) PO is BLOCKED → 403 PO_NOT_APPROVED',
    exGrBlocked.status === 403 && exGrBlocked.json.error?.code === 'PO_NOT_APPROVED', `${exGrBlocked.status} ${exGrBlocked.json.error?.code}`);
  // invoice the PO at 100@12 (+20% price variance) → match fails, not payable
  const exBill = await inj('POST', '/api/finance/ap/transactions', admin, { vendor_id: VEXP, txn_type: 'Goods', amount: 1200 });
  const exTxn = exBill.json.txn_no as string;
  const exMatch = await inj('POST', '/api/procurement/match/run', admin, { txn_no: exTxn, po_no: exPoNo, lines: [{ item_id: 'EXP3X', qty: 100, unit_price: 12 }] });
  ok('EXP-01/EXP-09: PO-based invoice with +20% price variance → match price_variance, not payable',
    exMatch.json.match_status === 'price_variance' && exMatch.json.payable === false, JSON.stringify({ st: exMatch.json.match_status, pay: exMatch.json.payable }));
  // HARD GATE: requesting payment on the failed-match invoice is blocked (no disbursement, no pending request).
  const exPayBlocked = await inj('PATCH', `/api/finance/ap/transactions/${exTxn}/pay`, admin, { amount: 1200 });
  ok('EXP-01/EXP-09: AP payment request on the unmatched invoice is BLOCKED → 409 MATCH_BLOCKED',
    exPayBlocked.status === 409 && exPayBlocked.json.error?.code === 'MATCH_BLOCKED', `${exPayBlocked.status} ${exPayBlocked.json.error?.code}`);
  // SoD: the user who RAN the match cannot override it (binds even Admin) — mirrors GL-05.
  const exSelfOvr = await inj('POST', `/api/procurement/match/${exTxn}/override`, admin, { reason: 'self-override attempt' });
  ok('EXP-01/EXP-09: matcher cannot override their own 3-way match → 403 SOD_VIOLATION (binds even Admin)',
    exSelfOvr.status === 403 && exSelfOvr.json.error?.code === 'SOD_VIOLATION', `${exSelfOvr.status} ${exSelfOvr.json.error?.code}`);
  // a DIFFERENT authorized user overrides the variance → the gate now passes; payment can be requested.
  const exOvr = await inj('POST', `/api/procurement/match/${exTxn}/override`, exOverrider, { reason: 'manager-approved price variance' });
  const exPayOk = await inj('PATCH', `/api/finance/ap/transactions/${exTxn}/pay`, admin, { amount: 1200 });
  ok('EXP-01/EXP-09: independent override (≠ matcher) unblocks → payment request now accepted (PendingApproval)',
    exOvr.json.override === true && exOvr.json.override_by !== 'admin' && (exPayOk.status === 200 || exPayOk.status === 201) && exPayOk.json.status === 'PendingApproval',
    JSON.stringify({ ovr: exOvr.json.override, by: exOvr.json.override_by, pay: exPayOk.json.status }));

  // ════════════════════════ EXP-10 — AP invoice INTAKE: scan → PO auto-map → matched-at-posting ════════════════════════
  // A scanned invoice carrying its PO number auto-posts ONLY through the 3-way match (bill + verdict in one
  // flow, payable when matched); the same vendor invoice number scanned again is never auto-posted and an
  // explicit post is refused (duplicate-payment prevention). Deeper variants (ambiguity → NeedsReview,
  // cumulative PO guard, scheduled auto re-match release) are re-performed in the `match` harness.
  const exPo2 = await inj('POST', '/api/procurement/pos', admin, { vendor_id: VEXP, items: [{ item_id: 'EXP3X', order_qty: 50, unit_price: 20 }] });
  const exPo2No = exPo2.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${exPo2No}/approve`, admin, { approve: true });
  await inj('POST', '/api/procurement/grs', admin, { po_no: exPo2No, items: [{ item_id: 'EXP3X', received_qty: 50 }] });
  const exScan = `ผู้ขาย EXP-03 จำกัด\nInvoice# IV-EXP10-1\n2026-07-01\nPO Number: ${exPo2No}\nรวมทั้งสิ้น 1,000.00`;
  const exIntake = await inj('POST', '/api/procurement/ap-intake/auto', admin, { text: exScan });
  ok('EXP-10: scanned invoice auto-maps to its PO and posts THROUGH the 3-way match → matched, payable',
    exIntake.json.po_no === exPo2No && exIntake.json.status === 'Posted' && exIntake.json.match_status === 'matched' && exIntake.json.payable === true,
    JSON.stringify({ po: exIntake.json.po_no, st: exIntake.json.status, match: exIntake.json.match_status }));
  const exDup = await inj('POST', '/api/procurement/ap-intake/auto', admin, { text: exScan });
  const exDupPost = await inj('POST', `/api/procurement/ap-intake/${exDup.json.intake_no}/post`, admin, {});
  ok('EXP-10: duplicate invoice number re-scanned → NOT auto-posted; explicit post → 409 DUPLICATE_INVOICE',
    exDup.json.auto_posted === false && exDup.json.dup_of != null && exDupPost.status === 409 && exDupPost.json.error?.code === 'DUPLICATE_INVOICE',
    JSON.stringify({ dup: exDup.json.dup_of, post: exDupPost.status }));

  // ════════════════════════ EXP-12 — blind-count receiving: over-receipt gate · claim window · close-short ════════════════════════
  // A receipt can never book more than was ordered (422 OVER_RECEIPT) — except a WEIGHT-basis line (kg),
  // which may run over by the configurable tolerance (default 5%). A supplier claim must be opened within
  // the claim window (24h of the GR) — after that the system refuses it. A short-shipped PO can be closed
  // short, and the close is binding at line level (no further receipt).
  const whrecv = await login('whrecv', 'pw'); // wh_receive only — the dock receiver (no procurement/exec)
  await db.insert(s.items).values({ itemId: 'EXP12W', itemDescription: 'เนื้อวัว EXP-12 (ชั่งน้ำหนัก)', uom: 'kg', unitPrice: '500' }).onConflictDoNothing();
  const rxPo = await inj('POST', '/api/procurement/pos', admin, { vendor_id: VEXP, items: [{ item_id: 'EXP3X', order_qty: 10, unit_price: 10 }, { item_id: 'EXP12W', order_qty: 10, unit_price: 500, uom: 'kg' }] });
  const rxPoNo = rxPo.json.po_no as string;
  await inj('PATCH', `/api/procurement/pos/${rxPoNo}/approve`, admin, { approve: true });
  // receive-lines feeds the blind-count screen: ordered / received / outstanding per line + the tolerance
  const rxLines = await inj('GET', `/api/procurement/pos/${rxPoNo}/receive-lines`, admin);
  const rxLineX = rxLines.json.lines?.find((l: any) => l.item_id === 'EXP3X');
  const rxLineW = rxLines.json.lines?.find((l: any) => l.item_id === 'EXP12W');
  ok('EXP-12: receive-lines returns ordered/received/outstanding per PO line + weight flag + tolerance',
    rxLineX?.order_qty === 10 && rxLineX?.remaining_qty === 10 && rxLineX?.is_weight === false && rxLineW?.is_weight === true && Number(rxLines.json.over_receipt_weight_pct) === 5,
    JSON.stringify({ x: rxLineX, pct: rxLines.json.over_receipt_weight_pct }));
  // over-receipt on a piece (EA) line is blocked outright
  const rxOver = await inj('POST', '/api/procurement/grs', admin, { po_no: rxPoNo, items: [{ item_id: 'EXP3X', received_qty: 12 }] });
  ok('EXP-12: receiving 12 on a 10-EA line is BLOCKED → 422 OVER_RECEIPT',
    rxOver.status === 422 && rxOver.json.error?.code === 'OVER_RECEIPT', `${rxOver.status} ${rxOver.json.error?.code}`);
  // a weight (kg) line accepts up to +5%… and refuses beyond it (aggregate per item — a 2nd GR counts too)
  const rxWOk = await inj('POST', '/api/procurement/grs', admin, { po_no: rxPoNo, items: [{ item_id: 'EXP12W', received_qty: 10.4, uom: 'kg' }] });
  const rxWOver = await inj('POST', '/api/procurement/grs', admin, { po_no: rxPoNo, items: [{ item_id: 'EXP12W', received_qty: 0.2, uom: 'kg' }] });
  ok('EXP-12: weight (kg) line accepts +4% over (within the 5% tolerance); a further 0.2 beyond the cap → 422 OVER_RECEIPT',
    (rxWOk.status === 200 || rxWOk.status === 201) && rxWOver.status === 422 && rxWOver.json.error?.code === 'OVER_RECEIPT',
    JSON.stringify({ ok: rxWOk.status, over: rxWOver.status, code: rxWOver.json.error?.code }));
  // partial receipt returns the ordered-vs-received summary (shortage surfaced immediately) + claim deadline
  const rxGr = await inj('POST', '/api/procurement/grs', admin, { po_no: rxPoNo, items: [{ item_id: 'EXP3X', received_qty: 6 }] });
  const rxSumX = rxGr.json.summary?.lines?.find((l: any) => l.item_id === 'EXP3X');
  ok('EXP-12: GR response carries the ordered-vs-received summary (EXP3X short 4) + the claim deadline',
    rxSumX?.order_qty === 10 && rxSumX?.received_total === 6 && rxSumX?.shortage_qty === 4 && !!rxGr.json.summary?.claim_deadline,
    JSON.stringify(rxSumX));
  // a claim inside the window opens (with its dock photo stored as a GRC attachment)…
  const rxPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const rxClaim = await inj('POST', '/api/claims/gr', whrecv, { gr_no: rxGr.json.gr_no, po_no: rxPoNo, item_id: 'EXP3X', gr_qty: 6, claim_qty: 2, reason: 'ของช้ำเสียหาย', image_data_url: rxPng });
  ok('EXP-12: claim inside the window opens (wh_receive) with photo evidence attached (GRC doc_attachment)',
    rxClaim.status === 201 && rxClaim.json.claim_no?.startsWith('GRC') && rxClaim.json.image_attachment_id != null,
    JSON.stringify({ st: rxClaim.status, no: rxClaim.json.claim_no, img: rxClaim.json.image_attachment_id }));
  // …and the SAME claim after the window has lapsed is refused (window auto-closes; backdate the GR 25h)
  await db.update(s.goodsReceipts).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(s.goodsReceipts.grNo, rxGr.json.gr_no as string));
  const rxLate = await inj('POST', '/api/claims/gr', whrecv, { gr_no: rxGr.json.gr_no, po_no: rxPoNo, item_id: 'EXP3X', claim_qty: 1, reason: 'สายเกินไป' });
  ok('EXP-12: claim after the 24h window → 422 CLAIM_WINDOW_CLOSED (window auto-closes)',
    rxLate.status === 422 && rxLate.json.error?.code === 'CLAIM_WINDOW_CLOSED', `${rxLate.status} ${rxLate.json.error?.code}`);
  // shortage decision: close the PO short → status Closed, and the close binds at line level
  const rxClose = await inj('POST', `/api/procurement/pos/${rxPoNo}/close-short`, whrecv, { reason: 'ผู้ขายยืนยันไม่ส่งเพิ่ม' });
  const rxAfter = await inj('POST', '/api/procurement/grs', admin, { po_no: rxPoNo, items: [{ item_id: 'EXP3X', received_qty: 4 }] });
  ok('EXP-12: close-short flips the PO Closed (short lines reported) and a further receipt → 422 PO_LINE_CLOSED',
    rxClose.json.po_status === 'Closed' && rxClose.json.short_lines?.some((l: any) => l.item_id === 'EXP3X' && l.short_qty === 4) && rxAfter.status === 422 && rxAfter.json.error?.code === 'PO_LINE_CLOSED',
    JSON.stringify({ close: rxClose.json.po_status, after: rxAfter.status, code: rxAfter.json.error?.code }));
  // the receiving tolerance is config the receiver cannot loosen — mirrors EXP-04 (wh_receive → 403)
  const rxTolBlocked = await inj('PUT', '/api/procurement/receiving-settings', whrecv, { over_receipt_weight_pct: 50 });
  ok('EXP-12: a wh_receive-only user cannot change the receiving tolerance → 403 (procurement/exec only)',
    rxTolBlocked.status === 403, `${rxTolBlocked.status} ${rxTolBlocked.json.error?.code}`);

  console.log('\n── COSO / ICFR control tests (GL-05 · GL-10 · period-lock · RLS · REV-08 · AC-09 · AC-08 · AC-06 · AC-10 · INV-01/02/04/05 · LYL-03..21) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  // docs/27 R3-3 — retained operating evidence: when EVIDENCE_OUT is set (CI), write the structured
  // run result (every control check, pass/fail, commit, timestamp) for artifact retention. This file is
  // what the SOC 2 / ICFR evidence clock samples — see compliance/soc2-readiness.md §evidence.
  if (process.env.EVIDENCE_OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.EVIDENCE_OUT, JSON.stringify({
      harness: 'compliance', run_at: new Date().toISOString(),
      commit: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF ?? null,
      total: checks.length, failed: checks.filter((c) => !c.ok).length,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail ?? '' })),
    }, null, 2));
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} compliance checks failed` : `\n✅ All ${checks.length} compliance control checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
