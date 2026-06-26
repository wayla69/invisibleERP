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
    { username: 'apclerk', passwordHash: await pw.hash('pw'), role: 'ApClerk', tenantId: t1 },          // creditors only — AP-PAY maker
    { username: 'apdual', passwordHash: await pw.hash('pw'), role: 'Procurement', tenantId: t1 },       // creditors + approvals — residual self-approval case
    { username: 'payprep', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },            // PAY-03 payroll preparer (t1)
    { username: 'paychk', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: t1 },             // PAY-03 payroll approver (t1, ≠ preparer)
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

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

  // ════════════════════ ITGC-AC-09 — SoD preventive block on permission assignment ════════════════════
  // Raise PR / PO (procurement) + approve & pay AP (creditors) is SoD rule R03.
  const conflictPerms = ['procurement', 'creditors'];

  // 1. Assigning a conflicting permission set is BLOCKED (422 SOD_CONFLICT) and nothing is persisted.
  const blocked = await inj('POST', '/api/admin/users', admin, { username: 'sod_blocked', password: 'pw1234', role: 'Sales', permissions: conflictPerms });
  const listAfterBlock = await inj('GET', '/api/admin/users', admin);
  const notCreated = !(listAfterBlock.json.users ?? []).some((u: any) => u.username === 'sod_blocked');
  ok('ITGC-AC-09: conflicting permission set blocked → 422 SOD_CONFLICT, user NOT created',
    blocked.status === 422 && blocked.json.error?.code === 'SOD_CONFLICT' && notCreated, `${blocked.status} ${blocked.json.error?.code} created=${!notCreated}`);

  // 2. The block names the offending rule so the admin understands the conflict (rule id surfaced in message).
  const blockMsg = String(blocked.json.error?.message ?? '');
  ok('ITGC-AC-09: block identifies the violated SoD rule (R03 procurement ✗ creditors)', blockMsg.includes('R03'), blockMsg);

  // 3. Explicit override WITH a reason is honoured (justified-override path → user created).
  const overridden = await inj('POST', '/api/admin/users', admin, { username: 'sod_override', password: 'pw1234', role: 'Sales', permissions: conflictPerms, allow_sod_override: true, sod_reason: 'small entity, compensating monthly review by CFO' });
  ok('ITGC-AC-09: justified override (allow_sod_override + reason) is honoured', (overridden.status === 200 || overridden.status === 201), `${overridden.status} ${overridden.json.error?.code ?? ''}`);

  // 4. Override WITHOUT a reason is still rejected (reason is mandatory for the audit trail).
  const noReason = await inj('POST', '/api/admin/users', admin, { username: 'sod_noreason', password: 'pw1234', role: 'Sales', permissions: conflictPerms, allow_sod_override: true });
  ok('ITGC-AC-09: override without a reason is still rejected', noReason.status === 422 && noReason.json.error?.code === 'SOD_CONFLICT', `${noReason.status} ${noReason.json.error?.code}`);

  // 5. A clean single-duty set is accepted with no friction.
  const clean = await inj('POST', '/api/admin/users', admin, { username: 'sod_clean', password: 'pw1234', role: 'Sales', permissions: ['ar'] });
  ok('ITGC-AC-09: conflict-free permission set assigned normally', (clean.status === 200 || clean.status === 201), `${clean.status}`);

  // 6. The same guard applies on UPDATE, not just create.
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
  await inj('POST', '/api/admin/users', admin, { username: 'cashier1', password: 'pw1234', role: 'Cashier' });
  const cashierLogin = await inj('POST', '/api/login', undefined, { username: 'cashier1', password: 'pw1234' });
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
  const r14Blocked = await inj('POST', '/api/admin/users', admin, { username: 'crm_conflict', password: 'pw1234', role: 'Sales', permissions: ['crm_reward', 'pos_sell'] });   // R14: config reward + redeem at till
  const r14Msg = String(r14Blocked.json.error?.message ?? '');
  const crmClean = await inj('POST', '/api/admin/users', admin, { username: 'crm_rewardmgr', password: 'pw1234', role: 'Sales', permissions: ['crm_reward'] });   // single-duty → clean
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
  await inj('POST', '/api/inventory/adjustments', admin, { item_id: 'INVCTL', qty_delta: -10, reason: 'Spoilage' }); // bal 140 @ 11 = 1540
  const invNoReason = await inj('POST', '/api/inventory/adjustments', admin, { item_id: 'INVCTL', qty_delta: -1, reason: '   ' });
  ok('INV-04: a stock adjustment without a reason is rejected (justified + audited)', invNoReason.status === 400 && invNoReason.json.error?.code === 'REASON_REQUIRED', `${invNoReason.status}/${invNoReason.json.error?.code}`);
  const invRec = await inj('GET', '/api/inventory/reconciliation', admin);
  ok('INV-06: perpetual sub-ledger value ties to the GL inventory control account (1200) — reconciled',
    invNear(invRec.json.sub_ledger_value, 1540) && invNear(invRec.json.gl_inventory, 1540) && invRec.json.reconciled === true,
    `sub=${invRec.json.sub_ledger_value} gl=${invRec.json.gl_inventory} rec=${invRec.json.reconciled}`);

  console.log('\n── COSO / ICFR control tests (GL-05 · period-lock · RLS · REV-08 · AC-09 · AC-08 · AC-06 · AC-10 · INV-01/02/04/05 · LYL-03..16) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} compliance checks failed` : `\n✅ All ${checks.length} compliance control checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
