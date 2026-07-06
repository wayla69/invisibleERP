/**
 * Accounting Tier 3 — Bank reconciliation (การกระทบยอดธนาคาร) over PGlite:
 * house-bank GL accounts (1010), statement import, auto-match to GL cash, fee adjustment closes the difference.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover bankrec
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // GL-05 maker-checker approver
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
  const [admin, sales1, sales2] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('sales2', 'pw2')];
  const approver = await login('approver', 'admin123');
  // GL-05 maker-checker: a manual JE posts as Draft; a DIFFERENT user must approve it to affect balances.
  const postJE = async (preparer: string, payload: any) => {
    const r = await inj('POST', '/api/ledger/journal', preparer, payload);
    if (r.json?.entry_no && r.json?.pending) await inj('POST', `/api/ledger/journal/${r.json.entry_no}/approve`, preparer === approver ? admin : approver, {});
    return r;
  };

  const accJson = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('COA seeded with 1010 + 1020', ['1010', '1020'].every((c) => accJson.includes(c)));

  // create a bank account on 1010
  const acc = await inj('POST', '/api/bank/accounts', admin, { bank_name: 'กสิกรไทย', account_no: '111-2-33333', gl_account_code: '1010', opening_balance: 0 });
  ok('Bank account created (gl 1010, PendingApproval)', (acc.status === 200 || acc.status === 201) && acc.json.gl_account_code === '1010' && acc.json.status === 'PendingApproval', `${acc.status} ${JSON.stringify(acc.json).slice(0, 80)}`);
  const bankId = acc.json.id;
  // G9 maker-checker: activate the account via a DISTINCT approver (approver ≠ admin) before use.
  await inj('POST', `/api/bank/accounts/${bankId}/approve`, approver);

  // seed 2 GL cash movements on 1010: deposit +1000, payment -200
  await postJE(admin, { date: '2028-03-05', source: 'Manual', memo: 'deposit', lines: [{ account_code: '1010', debit: 1000 }, { account_code: '4000', credit: 1000 }] });
  await postJE(admin, { date: '2028-03-06', source: 'Manual', memo: 'payment', lines: [{ account_code: '5100', debit: 200 }, { account_code: '1010', credit: 200 }] });

  // import statement: 2 matching lines + 1 unmatched fee. closing = 1000 - 200 - 35 = 765
  const stmt = await inj('POST', `/api/bank/accounts/${bankId}/statements`, admin, { statement_date: '2028-03-31', opening_bal: 0, closing_bal: 765, lines: [
    { date: '2028-03-05', amount: 1000, description: 'deposit' },
    { date: '2028-03-06', amount: -200, description: 'payment' },
    { date: '2028-03-31', amount: -35, description: 'monthly fee' },
  ] });
  ok('Statement imported (BANKSTMT-, 3 lines)', /^BANKSTMT-/.test(stmt.json.statement_no ?? '') && stmt.json.line_count === 3, `${stmt.status} ${JSON.stringify(stmt.json).slice(0, 70)}`);

  // auto-match → 2 matched, 1 unmatched (the fee)
  const am = await inj('POST', `/api/bank/accounts/${bankId}/auto-match`, admin);
  ok('Auto-match: 2 matched, 1 unmatched (the fee)', am.json.matched === 2 && (am.json.unmatched_statement ?? []).length === 1 && near(am.json.unmatched_statement[0].amount, -35), `matched=${am.json.matched} ${JSON.stringify(am.json.unmatched_statement)}`);

  // reconciliation BEFORE posting the fee: gl 800, statement 765, difference 35
  const r1 = await inj('GET', `/api/bank/accounts/${bankId}/reconciliation?as_of=2028-03-31`, admin);
  ok('Reconciliation before fee: gl 800, stmt 765, difference 35', near(r1.json.gl_balance, 800) && near(r1.json.statement_balance, 765) && near(r1.json.difference, 35), JSON.stringify({ gl: r1.json.gl_balance, st: r1.json.statement_balance, d: r1.json.difference }));
  const feeLineId = r1.json.unmatched_statement.find((l: any) => near(l.amount, -35)).statement_line_id;

  // BANK-02 maker-checker: the fee adjustment is a REQUEST that posts a DRAFT JE (Dr 5100 / Cr 1010 = 35) with
  // NO balance effect — the line stays unreconciled — until a DIFFERENT user approves it.
  const adj = await inj('POST', `/api/bank/lines/${feeLineId}/adjustment`, admin, { kind: 'fee' });
  ok('BANK-02: fee adjustment requested → Draft JE, PendingApproval (no balance effect yet)', /^JE-/.test(adj.json.journal_no ?? '') && near(adj.json.amount, 35) && adj.json.status === 'PendingApproval', `${adj.status} ${JSON.stringify(adj.json).slice(0, 80)}`);
  const jAdj = (await inj('GET', '/api/ledger/journal?limit=10', admin)).json.entries.find((e: any) => e.source === 'BANKADJ');
  const leg = (j: any, c: string, side: string) => (j?.lines ?? []).filter((l: any) => l.account_code === c).reduce((a: number, l: any) => a + Number(l[side]), 0);
  ok('BANK-02: requested fee GL legs correct on the Draft JE (Dr5100=35, Cr1010=35)', near(leg(jAdj, '5100', 'debit'), 35) && near(leg(jAdj, '1010', 'credit'), 35));

  // Draft excluded from balances → reconciliation difference still 35; the request shows in the checker queue.
  const rPending = await inj('GET', `/api/bank/accounts/${bankId}/reconciliation?as_of=2028-03-31`, admin);
  ok('BANK-02: Draft adjustment excluded from GL — reconciliation difference still 35 until approved', near(rPending.json.difference, 35), JSON.stringify({ d: rPending.json.difference }));
  const pendList = await inj('GET', '/api/bank/adjustments/pending', admin);
  ok('BANK-02: pending bank adjustment appears in the checker queue', (pendList.json.pending ?? []).some((p: any) => p.statement_line_id === feeLineId) && pendList.json.count >= 1, `count=${pendList.json.count}`);

  // requester cannot self-approve → 403 SOD_VIOLATION (binds even Admin).
  const selfAppr = await inj('POST', `/api/bank/lines/${feeLineId}/adjustment/approve`, admin);
  ok('BANK-02: requester self-approval blocked → 403 SOD_VIOLATION (binds even Admin)', selfAppr.status === 403 && selfAppr.json.error?.code === 'SOD_VIOLATION', `${selfAppr.status} ${selfAppr.json.error?.code}`);

  // a DIFFERENT user approves → JE Posted, line reconciled.
  const appr = await inj('POST', `/api/bank/lines/${feeLineId}/adjustment/approve`, approver);
  ok('BANK-02: independent approver posts the adjustment → Posted', appr.status === 200 && appr.json.status === 'Posted' && appr.json.approved_by === 'approver', `${appr.status} ${JSON.stringify(appr.json).slice(0, 70)}`);

  // reconciliation AFTER approval: difference closes to 0, nothing outstanding.
  const r2 = await inj('GET', `/api/bank/accounts/${bankId}/reconciliation?as_of=2028-03-31`, admin);
  ok('Reconciliation after approved fee: difference 0, nothing outstanding', near(r2.json.difference, 0) && (r2.json.unmatched_statement ?? []).length === 0 && (r2.json.unmatched_book ?? []).length === 0, JSON.stringify({ d: r2.json.difference, us: r2.json.unmatched_statement?.length, ub: r2.json.unmatched_book?.length }));

  // re-request on an already-reconciled line → rejected (400).
  const adj2 = await inj('POST', `/api/bank/lines/${feeLineId}/adjustment`, admin, { kind: 'fee' });
  ok('Fee adjustment idempotent (already reconciled → 400)', adj2.status === 400, `${adj2.status} ${JSON.stringify(adj2.json).slice(0, 50)}`);

  // trial balance still balances
  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after bank postings', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  // RLS: T2 staff cannot see T1's bank account
  const t1acc = await inj('POST', '/api/bank/accounts', sales1, { bank_name: 'T1 bank', account_no: 'T1-AAA', gl_account_code: '1010' });
  await inj('POST', '/api/bank/accounts', sales2, { bank_name: 'T2 bank', account_no: 'T2-BBB', gl_account_code: '1010' });
  const l1 = await inj('GET', '/api/bank/accounts', sales1);
  ok('RLS: T1 sees its bank account, not T2 (and vice versa)', (l1.json.accounts ?? []).some((a: any) => a.account_no === 'T1-AAA') && !(l1.json.accounts ?? []).some((a: any) => a.account_no === 'T2-BBB'), JSON.stringify((l1.json.accounts ?? []).map((a: any) => a.account_no)));

  // ── cross-tenant guard (W2/M2): a T2 movement on the shared 1010 GL must NOT leak into T1's reconciliation ──
  // seed a Posted T2 journal entry on 1010 directly (distinctive 9999) — admin reconciling T1 bypasses RLS,
  // so only the explicit acct-tenant filter keeps it out.
  const [t2je] = await db.insert(s.journalEntries).values({ entryNo: 'JE-T2-LEAK', tenantId: t2, entryDate: '2028-03-10', source: 'Manual', status: 'Posted', memo: 'T2 deposit' }).returning({ id: s.journalEntries.id });
  await db.insert(s.journalLines).values([
    { entryId: Number(t2je.id), tenantId: t2, accountCode: '1010', debit: '9999', credit: '0' },
    { entryId: Number(t2je.id), tenantId: t2, accountCode: '4000', debit: '0', credit: '9999' },
  ]);
  const t1recon = await inj('GET', `/api/bank/accounts/${t1acc.json.id}/reconciliation`, admin);
  ok('Cross-tenant: T1 reconciliation (run by admin) excludes T2 9999 movement', near(t1recon.json.gl_balance, 0) && !(t1recon.json.unmatched_book ?? []).some((l: any) => near(l.amount, 9999)), JSON.stringify({ gl: t1recon.json.gl_balance, ub: (t1recon.json.unmatched_book ?? []).map((l: any) => l.amount) }));

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — Bank reconciliation (กระทบยอดธนาคาร) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} bank-rec checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} bank-rec checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
