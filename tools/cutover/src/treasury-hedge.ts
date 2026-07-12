/**
 * Cutover check — TRE-04 hedge accounting register (Track C Wave 3; IFRS 9 / TFRS 9 · ASC 815).
 * A hedge RELATIONSHIP is DESIGNATED under maker-checker (self-approve → 403 SOD_SELF_APPROVAL; a DISTINCT
 * approver approves → Approved). THE CONTROL: no hedge/OCI accounting until Approved (designation) AND the latest
 * effectiveness test is effective=true.
 *   • measuring an undesignated/unapproved relationship → HEDGE_NOT_DESIGNATED.
 *   • CASH_FLOW: when the latest test is effective=false the OCI path is refused (HEDGE_NOT_EFFECTIVE) and the
 *     whole derivative change is routed to P&L 5450; when effective=true the EFFECTIVE portion lands in the
 *     Cash-Flow Hedge Reserve 3550 (OCI equity) and only the INEFFECTIVE portion in P&L 5450. Reclassification
 *     recycles 3550 → the hedged-item revenue line (Dr 3550 / Cr 4000).
 *   • FAIR_VALUE: the derivative change → P&L 5450 and the hedged item is BASIS-ADJUSTED (Cr 1200 / Dr 5450).
 *   • The derivative fair-value change posts Dr 1380 Derivative Asset / Cr 2460 Derivative Liability.
 *   • A sibling tenant never sees the register (RLS).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover treasury-hedge
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

  // GL net (debit − credit) on an account within a SPECIFIC posted entry (per-relationship, unambiguous).
  const glByEntry = async (account: string, entryNo: string | null) => {
    if (!entryNo) return NaN;
    const rows = await db.select({ d: s.journalLines.debit, c: s.journalLines.credit })
      .from(s.journalLines).innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(and(eq(s.journalLines.accountCode, account), eq(s.journalLines.tenantId, hq), eq(s.journalEntries.entryNo, entryNo), eq(s.journalEntries.status, 'Posted')));
    return rows.reduce((a: number, r: any) => a + Number(r.d) - Number(r.c), 0);
  };

  const analyst = await login('treas_analyst', 'pw1');
  const manager = await login('treas_manager', 'pw2');
  const admin2 = await login('admin2', 'pw3');
  const buyer = await login('buyer', 'pw4');
  const analystRole = await login('analyst_role', 'pw5');
  ok('logins', !!analyst && !!manager && !!admin2 && !!buyer && !!analystRole);

  // ── Permission gate: a non-treasury role (Buyer) cannot designate a hedge.
  const denied = await inj('POST', '/api/treasury/hedges', buyer, { hedged_item: 'X', hedging_instrument: 'Y', documentation: 'doc' });
  ok('non-treasury role (Buyer) denied hedge designate → 403', denied.status === 403, `status=${denied.status}`);
  // ── The maker-only TreasuryAnalyst role CAN designate but CANNOT approve.
  const byRole = await inj('POST', '/api/treasury/hedges', analystRole, { hedged_item: 'RoleCheck', hedging_instrument: 'Fwd', documentation: 'role documentation' });
  ok('TreasuryAnalyst role can designate (200 PendingApproval)', byRole.status === 200 && byRole.json.status === 'PendingApproval', `status=${byRole.status}`);
  const roleApprove = await inj('POST', `/api/treasury/hedges/${byRole.json.id}/approve`, analystRole);
  ok('TreasuryAnalyst role cannot approve (lacks treasury_approve) → 403', roleApprove.status === 403, `status=${roleApprove.status}`);

  // ── Documentation is required at designation (IFRS 9 6.4.1).
  const noDoc = await inj('POST', '/api/treasury/hedges', analyst, { hedged_item: 'A', hedging_instrument: 'B', documentation: '   ' });
  ok('empty documentation → 400 BAD_DOCUMENTATION', noDoc.status === 400 && noDoc.json?.error?.code === 'BAD_DOCUMENTATION', `status=${noDoc.status} code=${noDoc.json?.error?.code}`);

  // ── Designate a CASH_FLOW hedge (forecast USD sale) — reclassifies to revenue 4000.
  const cf = await inj('POST', '/api/treasury/hedges', analyst, {
    hedged_item: 'Forecast USD sale 2026-Q4', hedging_instrument: 'USD/THB forward 2026-12', hedge_type: 'CASH_FLOW',
    hedge_ratio: 1, notional: 1_000_000, documentation: 'CF hedge of a highly-probable forecast USD sale', reclass_account: '4000',
  });
  ok('CASH_FLOW designate → 200 PendingApproval', cf.status === 200 && cf.json.status === 'PendingApproval' && cf.json.hedge_type === 'CASH_FLOW', `status=${cf.status}`);
  const cfId = cf.json.id;

  // ── CONTROL: no accounting on an undesignated/unapproved relationship → HEDGE_NOT_DESIGNATED.
  const measureUndesignated = await inj('POST', `/api/treasury/hedges/${cfId}/measure`, manager, { fair_value: 10_000 });
  ok('measure an unapproved relationship → 400 HEDGE_NOT_DESIGNATED', measureUndesignated.status === 400 && measureUndesignated.json?.error?.code === 'HEDGE_NOT_DESIGNATED', `status=${measureUndesignated.status} code=${measureUndesignated.json?.error?.code}`);
  const effUndesignated = await inj('POST', `/api/treasury/hedges/${cfId}/effectiveness`, manager, { ratio_pct: 95, effective: true });
  ok('effectiveness test before approval → 400 HEDGE_NOT_DESIGNATED', effUndesignated.status === 400 && effUndesignated.json?.error?.code === 'HEDGE_NOT_DESIGNATED', `status=${effUndesignated.status} code=${effUndesignated.json?.error?.code}`);

  // ── Maker-checker: the creator cannot approve their own designation.
  const selfApprove = await inj('POST', `/api/treasury/hedges/${cfId}/approve`, analyst);
  ok('self-approve designation → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfApprove.status} code=${selfApprove.json?.error?.code}`);
  // ── A DISTINCT approver approves → Approved.
  const cfApproved = await inj('POST', `/api/treasury/hedges/${cfId}/approve`, manager);
  ok('distinct approver approves CASH_FLOW → Approved', cfApproved.status === 200 && cfApproved.json.status === 'Approved' && cfApproved.json.approved_by === 'treas_manager', `status=${cfApproved.status} st=${cfApproved.json?.status}`);

  // ── Record an effectiveness test that is NOT effective (offset ratio out of range).
  const effFalse = await inj('POST', `/api/treasury/hedges/${cfId}/effectiveness`, manager, { test_type: 'prospective', method: 'dollar_offset', ratio_pct: 60, effective: false, as_of: '2026-09-30' });
  ok('record effectiveness test effective=false → 200', effFalse.status === 200 && effFalse.json.effective === false, `status=${effFalse.status}`);

  // ── CONTROL (not effective): the OCI path is REFUSED → HEDGE_NOT_EFFECTIVE.
  const ociRefused = await inj('POST', `/api/treasury/hedges/${cfId}/measure`, manager, { fair_value: 10_000 });
  ok('CASH_FLOW OCI attempt while not effective → 400 HEDGE_NOT_EFFECTIVE', ociRefused.status === 400 && ociRefused.json?.error?.code === 'HEDGE_NOT_EFFECTIVE', `status=${ociRefused.status} code=${ociRefused.json?.error?.code}`);
  // ── … and the whole remeasurement is instead routed entirely to P&L (to_pl).
  const cfToPl = await inj('POST', `/api/treasury/hedges/${cfId}/measure`, manager, { fair_value: 10_000, to_pl: true });
  ok('CASH_FLOW not-effective → whole change to P&L (route=PL, oci_delta 0, pl_delta 10,000)', cfToPl.status === 200 && cfToPl.json.route === 'PL' && near(cfToPl.json.oci_delta, 0) && near(cfToPl.json.pl_delta, 10_000), JSON.stringify({ r: cfToPl.json?.route, o: cfToPl.json?.oci_delta, p: cfToPl.json?.pl_delta }));
  ok('to-P&L JE: Dr 1380 Derivative Asset = 10,000', near(await glByEntry('1380', cfToPl.json.entry_no), 10_000), `1380=${await glByEntry('1380', cfToPl.json.entry_no)}`);
  ok('to-P&L JE: Cr 5450 Hedge P&L = −10,000 (gain to earnings, nothing to OCI)', near(await glByEntry('5450', cfToPl.json.entry_no), -10_000), `5450=${await glByEntry('5450', cfToPl.json.entry_no)}`);
  ok('to-P&L JE: 3550 OCI reserve untouched (=0)', near(await glByEntry('3550', cfToPl.json.entry_no), 0), `3550=${await glByEntry('3550', cfToPl.json.entry_no)}`);

  // ── Now a PASSING effectiveness test (retrospective, offset ratio in range).
  const effTrue = await inj('POST', `/api/treasury/hedges/${cfId}/effectiveness`, manager, { test_type: 'retrospective', method: 'dollar_offset', ratio_pct: 95, effective: true, as_of: '2026-12-31' });
  ok('record effectiveness test effective=true → 200', effTrue.status === 200 && effTrue.json.effective === true, `status=${effTrue.status}`);

  // ── CONTROL (effective): the effective portion lands in OCI 3550, only the ineffective portion in P&L 5450.
  //    Derivative FV 10,000 → 18,000 (Δ 8,000): effective 7,000 → OCI, ineffective 1,000 → P&L.
  const cfOci = await inj('POST', `/api/treasury/hedges/${cfId}/measure`, manager, { fair_value: 18_000, effective_portion: 7_000, as_of: '2026-12-31' });
  ok('CASH_FLOW effective → route=OCI, oci_delta 7,000, pl_delta 1,000', cfOci.status === 200 && cfOci.json.route === 'OCI' && near(cfOci.json.oci_delta, 7_000) && near(cfOci.json.pl_delta, 1_000) && near(cfOci.json.delta, 8_000), JSON.stringify({ r: cfOci.json?.route, o: cfOci.json?.oci_delta, p: cfOci.json?.pl_delta, d: cfOci.json?.delta }));
  ok('effective JE: Dr 1380 Derivative Asset = +8,000', near(await glByEntry('1380', cfOci.json.entry_no), 8_000), `1380=${await glByEntry('1380', cfOci.json.entry_no)}`);
  ok('effective JE: Cr 3550 CF Hedge Reserve (OCI) = −7,000 (effective portion deferred)', near(await glByEntry('3550', cfOci.json.entry_no), -7_000), `3550=${await glByEntry('3550', cfOci.json.entry_no)}`);
  ok('effective JE: Cr 5450 Hedge P&L = −1,000 (ineffective portion only)', near(await glByEntry('5450', cfOci.json.entry_no), -1_000), `5450=${await glByEntry('5450', cfOci.json.entry_no)}`);
  ok('CASH_FLOW oci_reserve now 7,000', near(cfOci.json.oci_reserve, 7_000), `res=${cfOci.json?.oci_reserve}`);

  // ── Reclassification: the hedged cash flow occurs → recycle OCI to revenue (Dr 3550 / Cr 4000).
  const reclass = await inj('POST', `/api/treasury/hedges/${cfId}/reclassify`, manager, { amount: 7_000, as_of: '2027-01-15' });
  ok('reclassify 7,000 → 200, oci_reserve back to 0', reclass.status === 200 && near(reclass.json.reclassified, 7_000) && near(reclass.json.oci_reserve, 0), JSON.stringify({ rc: reclass.json?.reclassified, res: reclass.json?.oci_reserve }));
  ok('reclass JE: Dr 3550 CF Hedge Reserve = +7,000 (recycled out of OCI)', near(await glByEntry('3550', reclass.json.entry_no), 7_000), `3550=${await glByEntry('3550', reclass.json.entry_no)}`);
  ok('reclass JE: Cr 4000 Revenue = −7,000 (into earnings on the hedged cash flow)', near(await glByEntry('4000', reclass.json.entry_no), -7_000), `4000=${await glByEntry('4000', reclass.json.entry_no)}`);
  // ── Over-reclassify beyond the deferred reserve → OCI_INSUFFICIENT.
  const overReclass = await inj('POST', `/api/treasury/hedges/${cfId}/reclassify`, manager, { amount: 100 });
  ok('over-reclassify beyond deferred OCI → 400 OCI_INSUFFICIENT', overReclass.status === 400 && overReclass.json?.error?.code === 'OCI_INSUFFICIENT', `status=${overReclass.status} code=${overReclass.json?.error?.code}`);

  // ── FAIR_VALUE hedge: designate → approve → basis-adjust the hedged item (inventory 1200).
  const fv = await inj('POST', '/api/treasury/hedges', analyst, {
    hedged_item: 'Fixed-price commodity inventory', hedging_instrument: 'Commodity futures 2026-12', hedge_type: 'FAIR_VALUE',
    hedge_ratio: 1, notional: 500_000, documentation: 'FV hedge of inventory fair-value risk', hedged_item_account: '1200',
  });
  const fvId = fv.json.id;
  ok('FAIR_VALUE designate → 200 PendingApproval', fv.status === 200 && fv.json.hedge_type === 'FAIR_VALUE', `status=${fv.status}`);
  const fvApproved = await inj('POST', `/api/treasury/hedges/${fvId}/approve`, manager);
  ok('FAIR_VALUE approved', fvApproved.status === 200 && fvApproved.json.status === 'Approved', `status=${fvApproved.status}`);
  // ── CONTROL: a FV-hedge basis adjustment before a passing effectiveness test → HEDGE_NOT_EFFECTIVE.
  const fvNotEff = await inj('POST', `/api/treasury/hedges/${fvId}/measure`, manager, { fair_value: 5_000, hedged_item_delta: -5_000 });
  ok('FAIR_VALUE measure before an effective test → 400 HEDGE_NOT_EFFECTIVE', fvNotEff.status === 400 && fvNotEff.json?.error?.code === 'HEDGE_NOT_EFFECTIVE', `status=${fvNotEff.status} code=${fvNotEff.json?.error?.code}`);
  const fvEff = await inj('POST', `/api/treasury/hedges/${fvId}/effectiveness`, manager, { ratio_pct: 100, effective: true, as_of: '2026-12-31' });
  ok('FAIR_VALUE effectiveness test effective=true → 200', fvEff.status === 200 && fvEff.json.effective === true, `status=${fvEff.status}`);
  // ── Derivative gain 5,000; hedged item loses 5,000 (basis adjustment). Perfect hedge → net P&L 0.
  const fvMeasure = await inj('POST', `/api/treasury/hedges/${fvId}/measure`, manager, { fair_value: 5_000, hedged_item_delta: -5_000, as_of: '2026-12-31' });
  ok('FAIR_VALUE measure → route=FV, delta 5,000, basis_delta −5,000, net P&L 0', fvMeasure.status === 200 && fvMeasure.json.route === 'FV' && near(fvMeasure.json.delta, 5_000) && near(fvMeasure.json.basis_delta, -5_000) && near(fvMeasure.json.pl_delta, 0), JSON.stringify({ r: fvMeasure.json?.route, d: fvMeasure.json?.delta, b: fvMeasure.json?.basis_delta, p: fvMeasure.json?.pl_delta }));
  ok('FV JE: Dr 1380 Derivative Asset = +5,000', near(await glByEntry('1380', fvMeasure.json.entry_no), 5_000), `1380=${await glByEntry('1380', fvMeasure.json.entry_no)}`);
  ok('FV JE: Cr 1200 hedged item basis adjustment = −5,000 (carrying reduced)', near(await glByEntry('1200', fvMeasure.json.entry_no), -5_000), `1200=${await glByEntry('1200', fvMeasure.json.entry_no)}`);
  ok('FV JE: 5450 net P&L = 0 (perfect hedge — derivative gain offsets the basis loss)', near(await glByEntry('5450', fvMeasure.json.entry_no), 0), `5450=${await glByEntry('5450', fvMeasure.json.entry_no)}`);
  const fvAfter = await inj('GET', `/api/treasury/hedges/${fvId}`, analyst);
  ok('FAIR_VALUE basis_adjustment now −5,000; derivative FV 5,000', near(fvAfter.json.basis_adjustment, -5_000) && near(fvAfter.json.derivative_fv, 5_000), JSON.stringify({ b: fvAfter.json?.basis_adjustment, d: fvAfter.json?.derivative_fv }));

  // ── Rebalance an approved relationship (adjust the hedge ratio).
  const rebal = await inj('POST', `/api/treasury/hedges/${fvId}/rebalance`, analyst, { hedge_ratio: 0.9 });
  ok('rebalance FAIR_VALUE hedge ratio → 0.9, rebalances=1', rebal.status === 200 && near(rebal.json.hedge_ratio, 0.9) && rebal.json.rebalances === 1, JSON.stringify({ hr: rebal.json?.hedge_ratio, rb: rebal.json?.rebalances }));

  // ── RLS / tenant isolation: the sibling tenant (HQ2) never sees HQ's hedge register.
  const hq2Hedges = await inj('GET', '/api/treasury/hedges', admin2);
  ok('sibling tenant HQ2 sees 0 hedges (RLS isolation)', hq2Hedges.status === 200 && hq2Hedges.json.count === 0, `count=${hq2Hedges.json?.count}`);
  const hqHedges = await inj('GET', '/api/treasury/hedges', analyst);
  ok('tenant HQ sees its hedges (incl. the CF + FV relationships)', hqHedges.status === 200 && hqHedges.json.hedges?.some((h: any) => h.id === cfId) && hqHedges.json.hedges?.some((h: any) => h.id === fvId), `count=${hqHedges.json?.count}`);

  await app.close();
  await pg.close();

  console.log('\n── TRE-04 hedge accounting register (IFRS 9 / ASC 815) (PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
