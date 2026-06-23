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

  console.log('\n── COSO / ICFR control tests (GL-05 · period-lock · RLS · REV-08 · AC-09 · AC-08 · AC-06 · AC-10) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} compliance checks failed` : `\n✅ All ${checks.length} compliance control checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
