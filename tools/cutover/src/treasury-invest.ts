/**
 * Cutover check — TRE-03 investment & securities register + the reusable OCI-reserve primitive (Track C Wave 2).
 * A security is bought under maker-checker (self-approve → 403 SOD_SELF_APPROVAL; a DISTINCT approver approves →
 * the buy posts Dr 1350|1360|1370 per classification / Cr 1010 Bank). Classification routes valuation:
 *   • AMORTIZED_COST → EIR interest income ties a hand-computed amortization schedule; idempotent re-run; MTM is
 *     rejected (MTM_NOT_APPLICABLE); ECL impairment Dr 5440 / Cr 1355.
 *   • FVOCI          → mark-to-market lands in the OCI equity reserve 3500 (NOT P&L).
 *   • FVTPL          → mark-to-market lands in P&L 5430.
 * The market-price register is maker-checker (an UNAPPROVED price cannot drive MTM → NO_APPROVED_PRICE). A sibling
 * tenant never sees the register (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover treasury-invest
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
    { username: 'buyer', passwordHash: await pw.hash('pw4'), role: 'Buyer', tenantId: hq.id },
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

  // ── Permission gate: a non-treasury role (Buyer) cannot create an investment.
  const denied = await inj('POST', '/api/treasury/investments', buyer, { instrument: 'X', cost: 1000 });
  ok('non-treasury role (Buyer) denied investment create → 403', denied.status === 403, `status=${denied.status}`);
  // ── The maker-only TreasuryAnalyst role CAN create but CANNOT approve.
  const byRole = await inj('POST', '/api/treasury/investments', analystRole, { instrument: 'RoleCheck', cost: 1000 });
  ok('TreasuryAnalyst role can create an investment (200 PendingApproval)', byRole.status === 200 && byRole.json.status === 'PendingApproval', `status=${byRole.status}`);
  const roleApprove = await inj('POST', `/api/treasury/investments/${byRole.json.id}/approve`, analystRole);
  ok('TreasuryAnalyst role cannot approve (lacks treasury_approve) → 403', roleApprove.status === 403, `status=${roleApprove.status}`);

  // ── AMORTIZED_COST buy: cost 100,000 @ EIR 12% (1%/mo). Maker = treas_analyst.
  const ac = await inj('POST', '/api/treasury/investments', analyst, {
    instrument: 'BBL 5Y Bond', instrument_type: 'bond', classification: 'AMORTIZED_COST', cost: 100_000, eir_pct: 12,
    trade_date: '2026-01-01', maturity_date: '2031-01-01',
  });
  ok('AMORTIZED_COST create → 200 PendingApproval', ac.status === 200 && ac.json.status === 'PendingApproval' && ac.json.classification === 'AMORTIZED_COST', `status=${ac.status}`);
  const acId = ac.json.id;

  // ── Maker-checker: the creator cannot approve their own investment (the buy would post on self-approval).
  const selfApprove = await inj('POST', `/api/treasury/investments/${acId}/approve`, analyst);
  ok('self-approve → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);

  // ── A DISTINCT approver approves → the buy posts Dr 1350 / Cr 1010.
  const acApproved = await inj('POST', `/api/treasury/investments/${acId}/approve`, manager);
  ok('distinct approver approves AMORTIZED_COST → 200 Approved, carrying 100,000', acApproved.status === 200 && acApproved.json.status === 'Approved' && near(acApproved.json.carrying_value, 100_000), `status=${acApproved.status} st=${acApproved.json?.status}`);
  ok('AMORTIZED_COST buy JE Dr 1350 = 100,000', near(await glNet('1350', 'INVEST-BUY'), 100_000), `1350=${await glNet('1350', 'INVEST-BUY')}`);

  // ── FVOCI buy: cost 50,000, 100 units (price 500), symbol FVOCI1 → Dr 1360 / Cr 1010.
  const fvociCreate = await inj('POST', '/api/treasury/investments', analyst, {
    instrument: 'SET50 Fund', instrument_type: 'fund', classification: 'FVOCI', symbol: 'FVOCI1', quantity: 100, cost: 50_000, trade_date: '2026-01-01',
  });
  const fvociId = fvociCreate.json.id;
  const fvociApproved = await inj('POST', `/api/treasury/investments/${fvociId}/approve`, manager);
  ok('FVOCI buy → Dr 1360 = 50,000, carrying 50,000', fvociApproved.status === 200 && near(await glNet('1360', 'INVEST-BUY'), 50_000) && near(fvociApproved.json.carrying_value, 50_000), `1360=${await glNet('1360', 'INVEST-BUY')}`);

  // ── FVTPL buy: cost 30,000, 100 units (price 300), symbol FVTPL1 → Dr 1370 / Cr 1010.
  const fvtplCreate = await inj('POST', '/api/treasury/investments', analyst, {
    instrument: 'PTT Shares', instrument_type: 'equity', classification: 'FVTPL', symbol: 'FVTPL1', quantity: 100, cost: 30_000, trade_date: '2026-01-01',
  });
  const fvtplId = fvtplCreate.json.id;
  const fvtplApproved = await inj('POST', `/api/treasury/investments/${fvtplId}/approve`, manager);
  ok('FVTPL buy → Dr 1370 = 30,000, carrying 30,000', fvtplApproved.status === 200 && near(await glNet('1370', 'INVEST-BUY'), 30_000) && near(fvtplApproved.json.carrying_value, 30_000), `1370=${await glNet('1370', 'INVEST-BUY')}`);
  // ── The buy cash leg nets to −180,000 (100k + 50k + 30k).
  ok('buy cash leg Cr 1010 = −180,000', near(await glNet('1010', 'INVEST-BUY'), -180_000), `1010=${await glNet('1010', 'INVEST-BUY')}`);

  // ── Price register maker-checker (FX-04 shape): post a manual FVOCI1 price → PendingApproval.
  const priceFvoci = await inj('POST', '/api/treasury/prices', analyst, { symbol: 'FVOCI1', price_date: '2026-02-01', price: 520 });
  ok('post FVOCI1 price → PendingApproval', priceFvoci.status === 200 && priceFvoci.json.status === 'PendingApproval', `status=${priceFvoci.status} st=${priceFvoci.json?.status}`);

  // ── MTM control: an UNAPPROVED price cannot drive MTM → NO_APPROVED_PRICE (this IS the TRE-03 valuation gate).
  const mtmUnapproved = await inj('POST', `/api/treasury/investments/${fvociId}/revalue`, manager, { as_of: '2026-02-01' });
  ok('MTM with an unapproved price → 400 NO_APPROVED_PRICE', mtmUnapproved.status === 400 && mtmUnapproved.json?.error?.code === 'NO_APPROVED_PRICE', `status=${mtmUnapproved.status} code=${mtmUnapproved.json?.error?.code}`);

  // ── Price maker-checker: the maker cannot approve their own price.
  const priceSelf = await inj('POST', '/api/treasury/prices/approve', analyst, { symbol: 'FVOCI1', price_date: '2026-02-01' });
  ok('price self-approve → 403 SOD_SELF_APPROVAL', priceSelf.status === 403 && priceSelf.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${priceSelf.status} code=${priceSelf.json?.error?.code}`);
  // ── A DISTINCT approver approves the price.
  const priceApprove = await inj('POST', '/api/treasury/prices/approve', manager, { symbol: 'FVOCI1', price_date: '2026-02-01' });
  ok('distinct approver approves FVOCI1 price → Approved', priceApprove.status === 200 && priceApprove.json.status === 'Approved', `status=${priceApprove.status}`);

  // ── FVOCI MTM: fair 52,000 vs carrying 50,000 → +2,000 into OCI reserve 3500 (NOT P&L).
  const fvociMtm = await inj('POST', `/api/treasury/investments/${fvociId}/revalue`, manager, { as_of: '2026-02-01' });
  ok('FVOCI MTM → 200, fair 52,000, delta +2,000 to OCI', fvociMtm.status === 200 && near(fvociMtm.json.fair_value, 52_000) && near(fvociMtm.json.delta, 2_000) && near(fvociMtm.json.oci_delta, 2_000), JSON.stringify({ fv: fvociMtm.json?.fair_value, d: fvociMtm.json?.delta }));
  ok('FVOCI MTM Cr 3500 OCI reserve = −2,000', near(await glNet('3500', 'INVEST-MTM'), -2_000), `3500=${await glNet('3500', 'INVEST-MTM')}`);
  ok('FVOCI MTM Dr 1360 asset = +2,000', near(await glNet('1360', 'INVEST-MTM'), 2_000), `1360=${await glNet('1360', 'INVEST-MTM')}`);
  ok('FVOCI MTM does NOT touch P&L 5430 (=0)', near(await glNet('5430', 'INVEST-MTM'), 0), `5430=${await glNet('5430', 'INVEST-MTM')}`);

  // ── FVTPL MTM: price 280 (feed → auto-approved), fair 28,000 vs carrying 30,000 → −2,000 through P&L 5430.
  const priceFvtpl = await inj('POST', '/api/treasury/prices', analyst, { symbol: 'FVTPL1', price_date: '2026-02-01', price: 280, source: 'feed' });
  ok('post FVTPL1 price (feed) → auto-approved', priceFvtpl.status === 200 && priceFvtpl.json.status === 'Approved', `status=${priceFvtpl.status} st=${priceFvtpl.json?.status}`);
  const fvtplMtm = await inj('POST', `/api/treasury/investments/${fvtplId}/revalue`, manager, { as_of: '2026-02-01' });
  ok('FVTPL MTM → 200, fair 28,000, delta −2,000 to P&L', fvtplMtm.status === 200 && near(fvtplMtm.json.fair_value, 28_000) && near(fvtplMtm.json.delta, -2_000) && near(fvtplMtm.json.pl_delta, -2_000), JSON.stringify({ fv: fvtplMtm.json?.fair_value, d: fvtplMtm.json?.delta }));
  ok('FVTPL MTM Dr 5430 P&L fair-value loss = +2,000', near(await glNet('5430', 'INVEST-MTM'), 2_000), `5430=${await glNet('5430', 'INVEST-MTM')}`);
  ok('FVTPL MTM Cr 1370 asset = −2,000', near(await glNet('1370', 'INVEST-MTM'), -2_000), `1370=${await glNet('1370', 'INVEST-MTM')}`);
  ok('FVTPL MTM does NOT touch OCI 3500 (still −2,000 from FVOCI only)', near(await glNet('3500', 'INVEST-MTM'), -2_000), `3500=${await glNet('3500', 'INVEST-MTM')}`);

  // ── Amortized-cost is measured at amortized cost, not fair value → MTM is rejected.
  const acMtm = await inj('POST', `/api/treasury/investments/${acId}/revalue`, manager, { as_of: '2026-02-01' });
  ok('AMORTIZED_COST MTM → 400 MTM_NOT_APPLICABLE', acMtm.status === 400 && acMtm.json?.error?.code === 'MTM_NOT_APPLICABLE', `status=${acMtm.status} code=${acMtm.json?.error?.code}`);

  // ── AMORTIZED_COST EIR interest income — hand-computed schedule @ 1%/mo on the carrying:
  //    month 1: 100,000 × 1% = 1,000 (carrying → 101,000); month 2: 101,000 × 1% = 1,010 (total income 2,010).
  const accr1 = await inj('POST', `/api/treasury/investments/${acId}/accrue`, manager, { as_of: '2026-02-01' });
  ok('accrue period 1 → interest 1,000 (Dr 1350 / Cr 4700)', accr1.status === 200 && accr1.json.posted === 1 && near(accr1.json.interest, 1_000), JSON.stringify({ p: accr1.json?.posted, i: accr1.json?.interest }));
  ok('interest income JE Cr 4700 = −1,000', near(await glNet('4700', 'INVEST-ACCR'), -1_000), `4700=${await glNet('4700', 'INVEST-ACCR')}`);
  // ── Re-run the SAME as-of → idempotent (nothing new posts).
  const accr1again = await inj('POST', `/api/treasury/investments/${acId}/accrue`, manager, { as_of: '2026-02-01' });
  ok('re-accrue same period → posted 0 (idempotent)', accr1again.status === 200 && accr1again.json.posted === 0, `posted=${accr1again.json?.posted}`);
  ok('4700 unchanged after idempotent re-run (still −1,000)', near(await glNet('4700', 'INVEST-ACCR'), -1_000), `4700=${await glNet('4700', 'INVEST-ACCR')}`);
  // ── Second month accretes on the grown carrying → 1,010; total income 2,010.
  const accr2 = await inj('POST', `/api/treasury/investments/${acId}/accrue`, manager, { as_of: '2026-03-01' });
  ok('accrue period 2 → interest 1,010 (on the 101,000 carrying)', accr2.status === 200 && accr2.json.posted === 1 && near(accr2.json.interest, 1_010), JSON.stringify({ i: accr2.json?.interest }));
  ok('two periods income: 4700 total = −2,010', near(await glNet('4700', 'INVEST-ACCR'), -2_010), `4700=${await glNet('4700', 'INVEST-ACCR')}`);
  const acAfter = await inj('GET', `/api/treasury/investments/${acId}`, analyst);
  ok('AMORTIZED_COST accrued_income 2,010, carrying 102,010, periods_posted 2', near(acAfter.json.accrued_income, 2_010) && near(acAfter.json.carrying_value, 102_010) && acAfter.json.periods_posted === 2, JSON.stringify({ ai: acAfter.json?.accrued_income, cv: acAfter.json?.carrying_value, p: acAfter.json?.periods_posted }));

  // ── ECL impairment on the AMORTIZED_COST holding: 5,000 → Dr 5440 / Cr 1355 allowance (contra-asset).
  const impair = await inj('POST', `/api/treasury/investments/${acId}/impair`, manager, { ecl: 5_000, as_of: '2026-04-01' });
  ok('ECL impairment → 200, allowance 5,000, carrying 97,010', impair.status === 200 && near(impair.json.allowance, 5_000) && near(impair.json.carrying_value, 97_010), JSON.stringify({ a: impair.json?.allowance, cv: impair.json?.carrying_value }));
  ok('ECL JE Dr 5440 Impairment = 5,000', near(await glNet('5440', 'INVEST-ECL'), 5_000), `5440=${await glNet('5440', 'INVEST-ECL')}`);
  ok('ECL JE Cr 1355 Allowance = −5,000', near(await glNet('1355', 'INVEST-ECL'), -5_000), `1355=${await glNet('1355', 'INVEST-ECL')}`);

  // ── Portfolio roll-up by classification.
  const portfolio = await inj('GET', '/api/treasury/portfolio', analyst);
  const clsRow = (c: string) => (portfolio.json.by_class ?? []).find((b: any) => b.classification === c);
  ok('portfolio: 3 approved holdings, AMORTIZED_COST carrying 97,010', portfolio.status === 200 && portfolio.json.totals?.count === 3 && near(clsRow('AMORTIZED_COST')?.carrying_value, 97_010), JSON.stringify(portfolio.json?.totals));
  ok('portfolio: FVOCI reserve totals 2,000', near(portfolio.json.totals?.fvoci_reserve, 2_000), `res=${portfolio.json?.totals?.fvoci_reserve}`);

  // ── RLS / tenant isolation: the sibling tenant (HQ2) never sees HQ's investments/prices.
  const hq2Inv = await inj('GET', '/api/treasury/investments', admin2);
  ok('sibling tenant HQ2 sees 0 investments (RLS isolation)', hq2Inv.status === 200 && hq2Inv.json.count === 0, `count=${hq2Inv.json?.count}`);
  const hq2Prices = await inj('GET', '/api/treasury/prices', admin2);
  ok('sibling tenant HQ2 sees 0 prices (RLS isolation)', hq2Prices.status === 200 && hq2Prices.json.count === 0, `count=${hq2Prices.json?.count}`);
  const hqInv = await inj('GET', '/api/treasury/investments', analyst);
  ok('tenant HQ sees its investments (incl. the bond)', hqInv.status === 200 && hqInv.json.investments?.some((i: any) => i.id === acId), `count=${hqInv.json?.count}`);

  await app.close();
  await pg.close();

  console.log('\n── TRE-03 investment & securities register + OCI-reserve primitive (PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
