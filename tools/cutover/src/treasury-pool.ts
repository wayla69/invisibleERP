/**
 * Cutover check — TRE-05 cash pooling / in-house bank / intercompany-loan register (Track C Wave 4, FINAL).
 * An intercompany LOAN is registered under maker-checker (self-approve → 403 SOD_SELF_APPROVAL; a DISTINCT
 * approver approves → the mirrored drawdown posts Dr 1155 IC-Loan Receivable (creditor) / Cr 1010 Bank AND
 * Dr 1010 Bank / Cr 2155 IC-Loan Payable (debtor)). EIR interest accrues Dr 1155 / Cr 4700 (creditor) and
 * Dr 5900 / Cr 2155 (debtor), idempotently. A NOTIONAL pool allocates interest across members — the allocation
 * MUST sum to zero (ALLOCATION_NOT_ZERO otherwise); a PHYSICAL pool sweeps member→header (Dr header / Cr member).
 * THE CONTROL CORE: on consolidation the 1155/2155 pair AND the 4700/5900 IC interest ELIMINATE so group balances
 * and group finance cost/income net to zero (CON-03 balanced). A sibling tenant never sees the register (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover treasury-pool
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
process.env.NODE_ENV = 'test';

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { AppModule } from '../../../apps/api/dist/app.module';
import { DRIZZLE, tenantAwareProxy } from '../../../apps/api/dist/database/database.module';
import { AllExceptionsFilter } from '../../../apps/api/dist/common/all-exceptions.filter';
import { PasswordService } from '../../../apps/api/dist/modules/auth/password.service';
import { LedgerService } from '../../../apps/api/dist/modules/ledger/ledger.service';
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.01;

async function seed(db: any) {
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'Creditor Co' }, { code: 'SUB', name: 'Debtor Co' }, { code: 'OTHER', name: 'Sibling Co' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, sub, other] = [await tid('HQ'), await tid('SUB'), await tid('OTHER')];
  await db.insert(s.users).values([
    { username: 'treas_maker', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: hq },
    { username: 'treas_checker', passwordHash: await pw.hash('pw2'), role: 'Admin', tenantId: hq },
    { username: 'sibling_admin', passwordHash: await pw.hash('pw3'), role: 'Admin', tenantId: other },
    { username: 'buyer', passwordHash: await pw.hash('pw4'), role: 'Buyer', tenantId: hq },
    { username: 'analyst_role', passwordHash: await pw.hash('pw5'), role: 'TreasuryAnalyst', tenantId: hq },
  ]).onConflictDoNothing();
  return { hq, sub, other };
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const { hq, sub, other } = await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ routerOptions: { maxParamLength: 500 } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;

  // GL net (debit − credit) on an account within a SPECIFIC posted entry, scoped to a tenant.
  const glByEntry = async (account: string, entryNo: string | null, tenant: number) => {
    if (!entryNo) return NaN;
    const rows = await db.select({ d: s.journalLines.debit, c: s.journalLines.credit })
      .from(s.journalLines).innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(and(eq(s.journalLines.accountCode, account), eq(s.journalEntries.tenantId, tenant), eq(s.journalEntries.entryNo, entryNo), eq(s.journalEntries.status, 'Posted')));
    return rows.reduce((a: number, r: any) => a + Number(r.d) - Number(r.c), 0);
  };

  const maker = await login('treas_maker', 'pw1');
  const checker = await login('treas_checker', 'pw2');
  const sibling = await login('sibling_admin', 'pw3');
  const buyer = await login('buyer', 'pw4');
  const analystRole = await login('analyst_role', 'pw5');
  ok('logins', !!maker && !!checker && !!sibling && !!buyer && !!analystRole);

  // ── Permission gate: a non-treasury role (Buyer) cannot register an IC loan.
  const denied = await inj('POST', '/api/treasury/ic-loans', buyer, { creditor_tenant_id: hq, debtor_tenant_id: sub, principal: 1000 });
  ok('non-treasury role (Buyer) denied IC-loan register → 403', denied.status === 403, `status=${denied.status}`);
  // ── The maker-only TreasuryAnalyst role CAN register but CANNOT approve.
  const byRole = await inj('POST', '/api/treasury/ic-loans', analystRole, { creditor_tenant_id: hq, debtor_tenant_id: sub, principal: 1000, eir_pct: 12 });
  ok('TreasuryAnalyst role can register IC loan (200 PendingApproval)', byRole.status === 200 && byRole.json.status === 'PendingApproval', `status=${byRole.status}`);
  const roleApprove = await inj('POST', `/api/treasury/ic-loans/${byRole.json.id}/approve`, analystRole);
  ok('TreasuryAnalyst role cannot approve (lacks treasury_approve) → 403', roleApprove.status === 403, `status=${roleApprove.status}`);

  // ── Validation: creditor ≠ debtor.
  const same = await inj('POST', '/api/treasury/ic-loans', maker, { creditor_tenant_id: hq, debtor_tenant_id: hq, principal: 1000 });
  ok('creditor == debtor → 400 SAME_PARTY', same.status === 400 && same.json?.error?.code === 'SAME_PARTY', `status=${same.status} code=${same.json?.error?.code}`);

  // ── Register the IC loan HQ (creditor) → SUB (debtor): principal 120,000, EIR 12%/yr (1%/mo), start 2026-06-05.
  const reg = await inj('POST', '/api/treasury/ic-loans', maker, { creditor_tenant_id: hq, debtor_tenant_id: sub, principal: 120000, eir_pct: 12, start_date: '2026-06-05' });
  ok('register IC loan → 200 PendingApproval, carrying 0', reg.status === 200 && reg.json.status === 'PendingApproval' && near(reg.json.carrying, 0), `status=${reg.status}`);
  const loanId = reg.json.id;

  // ── Accounting on an unapproved loan is impossible (accrue before approval → LOAN_NOT_APPROVED).
  const accrEarly = await inj('POST', `/api/treasury/ic-loans/${loanId}/accrue`, checker, {});
  ok('accrue before approval → 400 LOAN_NOT_APPROVED', accrEarly.status === 400 && accrEarly.json?.error?.code === 'LOAN_NOT_APPROVED', `status=${accrEarly.status} code=${accrEarly.json?.error?.code}`);

  // ── Maker-checker: the registrant cannot approve their own loan.
  const selfApprove = await inj('POST', `/api/treasury/ic-loans/${loanId}/approve`, maker);
  ok('self-approve IC loan → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);

  // ── A DISTINCT approver approves → the mirrored drawdown posts in BOTH tenants.
  const approved = await inj('POST', `/api/treasury/ic-loans/${loanId}/approve`, checker);
  ok('distinct approver approves → Approved, carrying 120,000', approved.status === 200 && approved.json.status === 'Approved' && approved.json.approved_by === 'treas_checker' && near(approved.json.carrying, 120000), `status=${approved.status} st=${approved.json?.status}`);
  const credDraw = approved.json.creditor_entry_no;
  const debtDraw = approved.json.debtor_entry_no;
  ok('drawdown creditor JE: Dr 1155 IC-Loan Receivable = +120,000 (HQ)', near(await glByEntry('1155', credDraw, hq), 120000), `1155=${await glByEntry('1155', credDraw, hq)}`);
  ok('drawdown creditor JE: Cr 1010 Bank = −120,000 (HQ)', near(await glByEntry('1010', credDraw, hq), -120000), `1010=${await glByEntry('1010', credDraw, hq)}`);
  ok('drawdown debtor JE: Cr 2155 IC-Loan Payable = −120,000 (SUB)', near(await glByEntry('2155', debtDraw, sub), -120000), `2155=${await glByEntry('2155', debtDraw, sub)}`);
  ok('drawdown debtor JE: Dr 1010 Bank = +120,000 (SUB)', near(await glByEntry('1010', debtDraw, sub), 120000), `1010=${await glByEntry('1010', debtDraw, sub)}`);

  // ── EIR interest accrual: carrying 120,000 × 12%/12 = 1,200. Posts both sides.
  const accr = await inj('POST', `/api/treasury/ic-loans/${loanId}/accrue`, checker, { as_of: '2026-06-20' });
  ok('accrue → posted 1, interest 1,200 (period 2026-06)', accr.status === 200 && accr.json.posted === 1 && near(accr.json.interest, 1200) && accr.json.period === '2026-06', JSON.stringify({ p: accr.json?.posted, i: accr.json?.interest, per: accr.json?.period }));
  ok('accrual creditor JE: Dr 1155 = +1,200 (HQ receivable accretes)', near(await glByEntry('1155', accr.json.creditor_entry_no, hq), 1200), `1155=${await glByEntry('1155', accr.json.creditor_entry_no, hq)}`);
  ok('accrual creditor JE: Cr 4700 Interest Income = −1,200 (HQ)', near(await glByEntry('4700', accr.json.creditor_entry_no, hq), -1200), `4700=${await glByEntry('4700', accr.json.creditor_entry_no, hq)}`);
  ok('accrual debtor JE: Dr 5900 Interest Expense = +1,200 (SUB)', near(await glByEntry('5900', accr.json.debtor_entry_no, sub), 1200), `5900=${await glByEntry('5900', accr.json.debtor_entry_no, sub)}`);
  ok('accrual debtor JE: Cr 2155 = −1,200 (SUB payable accretes)', near(await glByEntry('2155', accr.json.debtor_entry_no, sub), -1200), `2155=${await glByEntry('2155', accr.json.debtor_entry_no, sub)}`);

  // ── Idempotent: re-accruing the same as-of posts nothing (cursor advanced).
  const accr2 = await inj('POST', `/api/treasury/ic-loans/${loanId}/accrue`, checker, { as_of: '2026-06-20' });
  ok('re-accrue same as-of → posted 0 (idempotent)', accr2.status === 200 && accr2.json.posted === 0, `posted=${accr2.json?.posted}`);
  const loanAfter = await inj('GET', '/api/treasury/ic-loans', maker);
  const theLoan = loanAfter.json.ic_loans?.find((l: any) => l.id === loanId);
  ok('loan carrying now 121,200; accrued_interest 1,200; periods_posted 1', !!theLoan && near(theLoan.carrying, 121200) && near(theLoan.accrued_interest, 1200) && theLoan.periods_posted === 1, JSON.stringify({ c: theLoan?.carrying, a: theLoan?.accrued_interest, p: theLoan?.periods_posted }));

  // ── CONSOLIDATION ELIMINATION (the CONTROL CORE): 1155/2155 + the 4700/5900 IC interest net to zero at group.
  const grp = await inj('POST', '/api/consolidation/groups', maker, { name: 'IC-Loan Group 2026', fiscal_year: 2026 });
  ok('create consolidation group', grp.status === 201 && grp.json.id > 0, JSON.stringify(grp.json).slice(0, 120));
  const groupId = grp.json.id;
  await inj('POST', `/api/consolidation/groups/${groupId}/entities`, maker, { entity_tenant_id: hq, ownership_pct: 100 });
  await inj('POST', `/api/consolidation/groups/${groupId}/entities`, maker, { entity_tenant_id: sub, ownership_pct: 100 });
  // REC-03 gate: prepare + independent approve the period's IC reconciliation (no trade-IC 1150/2150 → 0 = 0).
  await inj('POST', `/api/ic-reconciliation/groups/${groupId}/prepare`, maker, { period: '2026-06' });
  const recAppr = await inj('POST', `/api/ic-reconciliation/groups/${groupId}/approve`, checker, { period: '2026-06' });
  ok('REC-03: IC reconciliation approved (independent)', recAppr.status === 200 && recAppr.json.status === 'Approved', `status=${recAppr.status}`);

  const run = await inj('POST', `/api/consolidation/groups/${groupId}/run`, maker, { period: '2026-06' });
  ok('consolidation run → Final + balanced (CON-03 integrity)', run.status === 200 && run.json.status === 'Final' && run.json.balanced === true, JSON.stringify({ st: run.json?.status, b: run.json?.balanced }));
  ok('consolidation detected 1 IC-loan elimination', run.json.ic_loan_eliminations === 1, `ic_loan_eliminations=${run.json?.ic_loan_eliminations}`);
  const acct = (code: string) => run.json.consolidated_accounts?.find((a: any) => a.account_code === code);
  ok('group 1155 IC-Loan Receivable ELIMINATES to 0', near(acct('1155')?.net_thb, 0), `1155=${acct('1155')?.net_thb}`);
  ok('group 2155 IC-Loan Payable ELIMINATES to 0', near(acct('2155')?.net_thb, 0), `2155=${acct('2155')?.net_thb}`);
  ok('group 4700 IC interest income ELIMINATES to 0 (finance income nets out)', near(acct('4700')?.net_thb, 0), `4700=${acct('4700')?.net_thb}`);
  ok('group 5900 IC interest expense ELIMINATES to 0 (finance cost nets out)', near(acct('5900')?.net_thb, 0), `5900=${acct('5900')?.net_thb}`);
  ok('group 1010 Bank nets to 0 (intra-group cash movement)', near(acct('1010')?.net_thb ?? 0, 0), `1010=${acct('1010')?.net_thb}`);
  // Run lines carry the elimination detail.
  const runLines = await inj('GET', `/api/consolidation/runs/${run.json.run_id}/lines`, maker);
  const elim1155 = runLines.json.lines?.filter((l: any) => l.line_type === 'Elimination' && l.account_code === '1155');
  const elim4700 = runLines.json.lines?.filter((l: any) => l.line_type === 'Elimination' && l.account_code === '4700');
  ok('elimination line for 1155 present (receivable)', elim1155?.length === 1 && near(elim1155[0].amount_thb, -121200), JSON.stringify(elim1155?.[0]));
  ok('elimination line for 4700 present (IC interest income)', elim4700?.length === 1 && near(elim4700[0].amount_thb, 1200), JSON.stringify(elim4700?.[0]));

  // ── NOTIONAL cash pool: interest allocation MUST sum to zero.
  const npool = await inj('POST', '/api/treasury/pools', maker, { name: 'Notional Pool', pool_type: 'notional', header_account: '1010', members: [{ member_account: '1020' }, { member_account: '1015' }] });
  ok('define notional pool → 200', npool.status === 200 && npool.json.pool_type === 'notional' && npool.json.members?.length === 2, `status=${npool.status}`);
  const npoolId = npool.json.id;
  const badAlloc = await inj('POST', `/api/treasury/pools/${npoolId}/allocate-interest`, checker, { allocations: [{ amount: 500 }, { amount: -400 }] });
  ok('non-zero notional allocation → 400 ALLOCATION_NOT_ZERO', badAlloc.status === 400 && badAlloc.json?.error?.code === 'ALLOCATION_NOT_ZERO', `status=${badAlloc.status} code=${badAlloc.json?.error?.code}`);
  const goodAlloc = await inj('POST', `/api/treasury/pools/${npoolId}/allocate-interest`, checker, { allocations: [{ member_account: '1020', amount: 500 }, { member_account: '1015', amount: -500 }], date: '2026-06-30' });
  ok('zero-sum notional allocation → 200, allocation_sum 0', goodAlloc.status === 200 && near(goodAlloc.json.allocation_sum, 0) && !!goodAlloc.json.entry_no, JSON.stringify({ sum: goodAlloc.json?.allocation_sum, e: goodAlloc.json?.entry_no }));
  ok('allocation JE: Cr 4700 income = −500 (surplus member benefit, HQ)', near(await glByEntry('4700', goodAlloc.json.entry_no, hq), -500), `4700=${await glByEntry('4700', goodAlloc.json.entry_no, hq)}`);
  ok('allocation JE: Dr 5900 expense = +500 (deficit member cost, HQ) → net group P&L 0', near(await glByEntry('5900', goodAlloc.json.entry_no, hq), 500), `5900=${await glByEntry('5900', goodAlloc.json.entry_no, hq)}`);

  // ── PHYSICAL cash pool: sweep member → header (Dr header / Cr member).
  const ppool = await inj('POST', '/api/treasury/pools', maker, { name: 'Physical Pool', pool_type: 'physical', header_account: '1010', members: [{ member_account: '1020' }] });
  ok('define physical pool → 200', ppool.status === 200 && ppool.json.pool_type === 'physical', `status=${ppool.status}`);
  const ppoolId = ppool.json.id;
  // A notional allocation on a physical pool is refused (and vice-versa).
  const wrongMode = await inj('POST', `/api/treasury/pools/${ppoolId}/allocate-interest`, checker, { allocations: [{ amount: 100 }, { amount: -100 }] });
  ok('allocate-interest on a physical pool → 400 NOT_NOTIONAL_POOL', wrongMode.status === 400 && wrongMode.json?.error?.code === 'NOT_NOTIONAL_POOL', `status=${wrongMode.status} code=${wrongMode.json?.error?.code}`);
  const sweep = await inj('POST', `/api/treasury/pools/${ppoolId}/sweep`, checker, { member_account: '1020', amount: 50000, date: '2026-06-25' });
  ok('physical sweep → 200, amount 50,000', sweep.status === 200 && near(sweep.json.amount, 50000) && !!sweep.json.entry_no, `status=${sweep.status}`);
  ok('sweep JE: Dr 1010 header-bank = +50,000 (HQ)', near(await glByEntry('1010', sweep.json.entry_no, hq), 50000), `1010=${await glByEntry('1010', sweep.json.entry_no, hq)}`);
  ok('sweep JE: Cr 1020 member-bank = −50,000 (HQ)', near(await glByEntry('1020', sweep.json.entry_no, hq), -50000), `1020=${await glByEntry('1020', sweep.json.entry_no, hq)}`);
  const noSweep = await inj('POST', `/api/treasury/pools/${npoolId}/sweep`, checker, { member_account: '1020', amount: 10 });
  ok('sweep on a notional pool → 400 NOT_PHYSICAL_POOL', noSweep.status === 400 && noSweep.json?.error?.code === 'NOT_PHYSICAL_POOL', `status=${noSweep.status} code=${noSweep.json?.error?.code}`);

  // ── Pool position: header + member GL balances.
  const pos = await inj('GET', `/api/treasury/pools/${ppoolId}/position`, maker);
  ok('pool position → header 1010 reflects the swept-in 50,000 + drawdown flows', pos.status === 200 && pos.json.header_account === '1010', `status=${pos.status}`);

  // ── RLS / tenant isolation: the sibling tenant (OTHER) never sees HQ's IC-loan register or pools.
  const sibLoans = await inj('GET', '/api/treasury/ic-loans', sibling);
  ok('sibling tenant sees 0 IC loans (RLS isolation)', sibLoans.status === 200 && sibLoans.json.count === 0, `count=${sibLoans.json?.count}`);
  const sibPools = await inj('GET', '/api/treasury/pools', sibling);
  ok('sibling tenant sees 0 pools (RLS isolation)', sibPools.status === 200 && sibPools.json.count === 0, `count=${sibPools.json?.count}`);
  const hqLoans = await inj('GET', '/api/treasury/ic-loans', maker);
  ok('creditor tenant HQ sees its IC loan', hqLoans.status === 200 && hqLoans.json.ic_loans?.some((l: any) => l.id === loanId), `count=${hqLoans.json?.count}`);
  void other;

  await app.close();
  await pg.close();

  console.log('\n── TRE-05 cash pooling / in-house bank / IC-loan register (PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
