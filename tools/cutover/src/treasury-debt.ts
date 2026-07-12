/**
 * Cutover check — TRE-01 debt & borrowings register + EIR amortized-cost engine, and TRE-02 covenant-breach
 * monitor (Track C Wave 1). A facility is created under maker-checker (self-approve → 403 SOD_SELF_APPROVAL; a
 * DISTINCT approver approves); a drawdown posts Dr 1010 Bank / Cr 2550 Long-term Borrowings; the idempotent EIR
 * accrual ties to a hand-computed amortization table and re-running the same period is a no-op; a covenant
 * breach fires; the maturity ladder buckets outstanding principal; and a sibling tenant never sees the register.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover treasury-debt
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'HQ2', name: 'HQ2' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  const hq2 = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ2')))[0];
  await db.insert(s.users).values([
    { username: 'treas_analyst', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: hq.id },
    { username: 'treas_manager', passwordHash: await pw.hash('pw2'), role: 'Admin', tenantId: hq.id },
    { username: 'admin2', passwordHash: await pw.hash('pw3'), role: 'Admin', tenantId: hq2.id },
    // A non-treasury role (Buyer) to prove the permission gate.
    { username: 'buyer', passwordHash: await pw.hash('pw4'), role: 'Buyer', tenantId: hq.id },
    // A maker-only role (TreasuryAnalyst) to prove it can create but not approve.
    { username: 'analyst_role', passwordHash: await pw.hash('pw5'), role: 'TreasuryAnalyst', tenantId: hq.id },
  ]).onConflictDoNothing();
  return { hq: hq.id as number, hq2: hq2.id as number };
}

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const { hq, hq2 } = await seed(db);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const ledger = app.get(LedgerService);
  await ledger.seedChartOfAccounts();

  const inj = async (method: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;

  // GL net (debit − credit) on an account for a given source, tenant HQ.
  const glNet = async (account: string, source: string) => {
    const rows = await db.select({ d: s.journalLines.debit, c: s.journalLines.credit })
      .from(s.journalLines).innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(and(eq(s.journalLines.accountCode, account), eq(s.journalLines.tenantId, hq), eq(s.journalEntries.source, source), eq(s.journalEntries.status, 'Posted')));
    return rows.reduce((a: number, r: any) => a + Number(r.d) - Number(r.c), 0);
  };

  const analyst = await login('treas_analyst', 'pw1');
  const manager = await login('treas_manager', 'pw2');
  const admin2 = await login('admin2', 'pw3');
  const buyer = await login('buyer', 'pw4');
  const analystRole = await login('analyst_role', 'pw5');
  ok('logins', !!analyst && !!manager && !!admin2 && !!buyer && !!analystRole);

  // ── Permission gate: a non-treasury role (Buyer) cannot create a facility.
  const denied = await inj('POST', '/api/treasury/facilities', buyer, { name: 'X', limit_amount: 1000, eir_pct: 6 });
  ok('non-treasury role (Buyer) denied facility create → 403', denied.status === 403, `status=${denied.status}`);
  // ── The maker-only TreasuryAnalyst role CAN create a facility.
  const byRole = await inj('POST', '/api/treasury/facilities', analystRole, { name: 'RoleCheck', limit_amount: 1000, eir_pct: 6 });
  ok('TreasuryAnalyst role can create a facility (200)', byRole.status === 200 && byRole.json.status === 'PendingApproval', `status=${byRole.status}`);
  // ── But the maker-only TreasuryAnalyst role CANNOT approve (lacks treasury_approve) → 403.
  const roleApprove = await inj('POST', `/api/treasury/facilities/${byRole.json.id}/approve`, analystRole);
  ok('TreasuryAnalyst role cannot approve (lacks treasury_approve) → 403', roleApprove.status === 403, `status=${roleApprove.status}`);

  // ── Create a long-term facility: limit 1,000,000 @ EIR 12% (1%/month). Maker = treas_analyst (Admin).
  const created = await inj('POST', '/api/treasury/facilities', analyst, {
    name: 'Term Loan A', lender: 'BBL', facility_type: 'long_term', limit_amount: 1_000_000, eir_pct: 12,
    start_date: '2026-01-01', maturity_date: '2026-12-31',
  });
  ok('facility create → 200 PendingApproval', created.status === 200 && created.json.status === 'PendingApproval', `status=${created.status} st=${created.json?.status}`);
  const fid = created.json.id;

  // ── Maker-checker: the creator cannot approve their own facility.
  const selfApprove = await inj('POST', `/api/treasury/facilities/${fid}/approve`, analyst);
  ok('self-approve → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);

  // ── A drawdown on an unapproved facility is refused.
  const earlyDraw = await inj('POST', `/api/treasury/facilities/${fid}/drawdown`, analyst, { principal: 100_000, drawdown_date: '2026-01-01' });
  ok('drawdown before approval → 400 FACILITY_NOT_APPROVED', earlyDraw.status === 400 && earlyDraw.json?.error?.code === 'FACILITY_NOT_APPROVED', `status=${earlyDraw.status} code=${earlyDraw.json?.error?.code}`);

  // ── A DISTINCT approver approves.
  const approved = await inj('POST', `/api/treasury/facilities/${fid}/approve`, manager);
  ok('distinct approver approves → 200 Approved', approved.status === 200 && approved.json.status === 'Approved' && approved.json.approved_by === 'treas_manager', `status=${approved.status} st=${approved.json?.status}`);

  // ── Drawdown 600,000 → Dr 1010 / Cr 2550 (long-term borrowings).
  const draw = await inj('POST', `/api/treasury/facilities/${fid}/drawdown`, analyst, { principal: 600_000, drawdown_date: '2026-01-01' });
  ok('drawdown 600,000 → 200, carrying 600,000, posts to 2550', draw.status === 200 && near(draw.json.amortized_cost, 600_000) && draw.json.borrowings_account === '2550', `status=${draw.status} acct=${draw.json?.borrowings_account}`);
  ok('drawdown JE Dr 1010 Bank = 600,000', near(await glNet('1010', 'DEBT-DRAW'), 600_000), `1010=${await glNet('1010', 'DEBT-DRAW')}`);
  ok('drawdown JE Cr 2550 Long-term Borrowings = −600,000', near(await glNet('2550', 'DEBT-DRAW'), -600_000), `2550=${await glNet('2550', 'DEBT-DRAW')}`);
  ok('drawdown JE balanced', near((await glNet('1010', 'DEBT-DRAW')) + (await glNet('2550', 'DEBT-DRAW')), 0));

  // ── A drawdown beyond the available limit is refused (600,000 drawn; 500,000 more > 400,000 available).
  const over = await inj('POST', `/api/treasury/facilities/${fid}/drawdown`, analyst, { principal: 500_000, drawdown_date: '2026-01-01' });
  ok('drawdown over available limit → 400 LIMIT_EXCEEDED', over.status === 400 && over.json?.error?.code === 'LIMIT_EXCEEDED', `status=${over.status} code=${over.json?.error?.code}`);

  // ── EIR accrual, hand-computed amortization table @ 1%/month on the 600,000 carrying:
  //    each month interest = 600,000 × 0.01 = 6,000 (principal unchanged → constant at par).
  const accr1 = await inj('POST', `/api/treasury/facilities/${fid}/accrue`, manager, { as_of: '2026-02-01' });
  ok('accrue period 1 → posted 1, interest 6,000', accr1.status === 200 && accr1.json.posted === 1 && near(accr1.json.accruals?.[0]?.interest, 6_000), JSON.stringify({ posted: accr1.json?.posted, i: accr1.json?.accruals?.[0]?.interest }));
  ok('accrual JE Dr 5900 Interest Expense = 6,000', near(await glNet('5900', 'DEBT-ACCR'), 6_000), `5900=${await glNet('5900', 'DEBT-ACCR')}`);
  ok('accrual JE Cr 2450 Accrued Interest Payable = −6,000', near(await glNet('2450', 'DEBT-ACCR'), -6_000), `2450=${await glNet('2450', 'DEBT-ACCR')}`);

  // ── Re-accrue the SAME as-of → idempotent (nothing new posts).
  const accr1again = await inj('POST', `/api/treasury/facilities/${fid}/accrue`, manager, { as_of: '2026-02-01' });
  ok('re-accrue same period → posted 0 (idempotent)', accr1again.status === 200 && accr1again.json.posted === 0, `posted=${accr1again.json?.posted}`);
  ok('5900 unchanged after idempotent re-run (still 6,000)', near(await glNet('5900', 'DEBT-ACCR'), 6_000), `5900=${await glNet('5900', 'DEBT-ACCR')}`);

  // ── Accrue a second month → total interest 12,000 across two periods.
  const accr2 = await inj('POST', `/api/treasury/facilities/${fid}/accrue`, manager, { as_of: '2026-03-01' });
  ok('accrue period 2 → posted 1, interest 6,000', accr2.status === 200 && accr2.json.posted === 1 && near(accr2.json.accruals?.[0]?.interest, 6_000), JSON.stringify({ posted: accr2.json?.posted }));
  ok('two periods accrued: 5900 total = 12,000', near(await glNet('5900', 'DEBT-ACCR'), 12_000), `5900=${await glNet('5900', 'DEBT-ACCR')}`);
  const facAfter = await inj('GET', `/api/treasury/facilities/${fid}`, analyst);
  ok('drawdown accrued_interest = 12,000, periods_posted = 2', near(facAfter.json.drawdowns?.[0]?.accrued_interest, 12_000) && facAfter.json.drawdowns?.[0]?.periods_posted === 2, JSON.stringify({ ai: facAfter.json?.drawdowns?.[0]?.accrued_interest, p: facAfter.json?.drawdowns?.[0]?.periods_posted }));

  // ── Repay: 100,000 principal + 12,000 interest → Dr 2550 100,000 + Dr 2450 12,000 / Cr 1010 112,000.
  const repay = await inj('POST', `/api/treasury/facilities/${fid}/repay`, analyst, { principal: 100_000, interest: 12_000, date: '2026-03-05' });
  ok('repay 100,000 principal + 12,000 interest → 200, remaining principal 500,000', repay.status === 200 && near(repay.json.remaining_principal, 500_000), `status=${repay.status} rem=${repay.json?.remaining_principal}`);
  ok('repay JE Dr 2550 = 100,000', near(await glNet('2550', 'DEBT-REPAY'), 100_000), `2550=${await glNet('2550', 'DEBT-REPAY')}`);
  ok('repay JE Dr 2450 = 12,000', near(await glNet('2450', 'DEBT-REPAY'), 12_000), `2450=${await glNet('2450', 'DEBT-REPAY')}`);
  ok('repay JE Cr 1010 = −112,000', near(await glNet('1010', 'DEBT-REPAY'), -112_000), `1010=${await glNet('1010', 'DEBT-REPAY')}`);
  const facAfterRepay = await inj('GET', `/api/treasury/facilities/${fid}`, analyst);
  ok('facility outstanding_principal = 500,000 after repay', near(facAfterRepay.json.outstanding_principal, 500_000), `out=${facAfterRepay.json?.outstanding_principal}`);

  // ── Repaying more than the outstanding principal is refused.
  const overRepay = await inj('POST', `/api/treasury/facilities/${fid}/repay`, analyst, { principal: 900_000 });
  ok('over-repay principal → 400 REPAY_EXCEEDS_PRINCIPAL', overRepay.status === 400 && overRepay.json?.error?.code === 'REPAY_EXCEEDS_PRINCIPAL', `status=${overRepay.status} code=${overRepay.json?.error?.code}`);

  // ── Maturity ladder: the 500,000 outstanding matures 2026-12-31 → the >365d bucket from as-of 2025-06-01,
  //    but the 181-365d bucket from as-of 2026-06-01 (≈208 days out).
  const ladder = await inj('GET', '/api/treasury/facilities/maturity-ladder?as_of=2026-06-01', analyst);
  const bucket = (k: string) => (ladder.json.buckets ?? []).find((b: any) => b.key === k);
  ok('maturity ladder total_outstanding = 500,000', ladder.status === 200 && near(ladder.json.total_outstanding, 500_000), `total=${ladder.json?.total_outstanding}`);
  ok('maturity ladder buckets 500,000 into 181-365d (matures 2026-12-31)', near(bucket('181-365d')?.outstanding, 500_000), JSON.stringify(ladder.json?.buckets));

  // ── Covenants (TRE-02): create a DSCR ≥ 1.25 covenant; test a PASS then a BREACH.
  const cov = await inj('POST', `/api/treasury/facilities/${fid}/covenants`, analyst, { name: 'DSCR floor', metric: 'DSCR', operator: 'gte', threshold: 1.25, cadence: 'quarterly' });
  ok('covenant create → 200', cov.status === 200 && cov.json.metric === 'DSCR' && near(cov.json.threshold, 1.25), `status=${cov.status}`);
  const covId = cov.json.id;
  const testPass = await inj('POST', '/api/treasury/covenants/test', manager, { as_of: '2026-03-31', tests: [{ covenant_id: covId, value: 1.40 }] });
  ok('covenant test PASS (1.40 ≥ 1.25) → not breached', testPass.status === 200 && testPass.json.breached === 0, JSON.stringify({ b: testPass.json?.breached }));
  const testBreach = await inj('POST', '/api/treasury/covenants/test', manager, { as_of: '2026-06-30', tests: [{ covenant_id: covId, value: 1.10, note: 'Q2 shortfall' }] });
  ok('covenant test BREACH (1.10 < 1.25) → breached fires', testBreach.status === 200 && testBreach.json.breached === 1 && testBreach.json.breaches?.[0]?.breached === true, JSON.stringify({ b: testBreach.json?.breached }));
  const breaches = await inj('GET', '/api/treasury/covenants/breaches', manager);
  ok('breach worklist surfaces the DSCR breach (actual 1.10 < 1.25)', breaches.status === 200 && breaches.json.count === 1 && near(breaches.json.breaches?.[0]?.actual, 1.10), JSON.stringify({ c: breaches.json?.count }));

  // ── RLS / tenant isolation: the sibling tenant (HQ2) never sees HQ's facilities/covenants.
  const hq2Fac = await inj('GET', '/api/treasury/facilities', admin2);
  ok('sibling tenant HQ2 sees 0 facilities (RLS isolation)', hq2Fac.status === 200 && hq2Fac.json.count === 0, `count=${hq2Fac.json?.count}`);
  const hq2Cov = await inj('GET', '/api/treasury/covenants', admin2);
  ok('sibling tenant HQ2 sees 0 covenants (RLS isolation)', hq2Cov.status === 200 && hq2Cov.json.count === 0, `count=${hq2Cov.json?.count}`);
  const hqFac = await inj('GET', '/api/treasury/facilities', analyst);
  ok('tenant HQ sees its facilities (incl. Term Loan A)', hqFac.status === 200 && hqFac.json.facilities?.some((f: any) => f.id === fid), `count=${hqFac.json?.count}`);

  await app.close();
  await pg.close();

  console.log('\n── TRE-01/02 debt & borrowings register + EIR engine (PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
