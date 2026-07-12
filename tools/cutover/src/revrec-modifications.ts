/**
 * Track D — Wave 3 (REV-26): contract modifications under TFRS 15 / IFRS 15 / ASC 606 §18-21, over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover revrec-modifications
 *
 * Verifies the CLASSIFICATION (the control) and the correct effect for each of the three §18-21 branches:
 *   • cumulative_catchup (§21b) — a NOT-distinct modification adjusts revenue at the modification date via a
 *     cumulative CATCH-UP JE on the already-recognized (satisfied) portion (Dr 1265/2410 ↔ Cr 4300);
 *   • prospective (§21a) — a distinct-but-NOT-at-SSP modification RE-ALLOCATES the remaining (unrecognized)
 *     transaction price over the remaining POs with NO catch-up (already-recognized revenue is frozen);
 *   • separate_contract (§20) — a distinct-AND-at-SSP modification creates a NEW independent contract and
 *     leaves the ORIGINAL untouched;
 *   • the classification is a maker-checker management judgement: the maker may NOT approve their own
 *     modification (403 SOD_SELF_APPROVAL) and approval is MANDATORY before it drives revenue (a Pending
 *     modification changes nothing); re-approval of an applied modification is blocked (MODIFICATION_NOT_PENDING);
 *   • tenant RLS isolation on rev_contract_modifications.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'revrec-modifications-secret';
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
  const [t1, t2] = [await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    // Two Sales users (exec + ar + fin_report) in T1 so the maker (exec1) and checker (exec2) differ (SoD).
    { username: 'exec1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'exec2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t1 },
    { username: 'exec2b', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t2 },
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
  const [exec1, exec2, exec2b] = [await login('exec1', 'pw1'), await login('exec2', 'pw2'), await login('exec2b', 'pw3')];
  const bal = async (token: string, code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', token)).json;
    return Number((tb.rows ?? []).find((r: any) => r.account_code === code)?.balance ?? 0);
  };
  // recognized revenue on a credit account (4300) shows as a negative balance; measure the increase as −Δ.
  const revUp = (after: number, before: number) => -(after - before);
  const getC = async (token: string, id: number) => (await inj('GET', `/api/revenue/contracts/${id}`, token)).json;
  const alloc = (c: any, name: string) => Number((c.obligations ?? []).find((o: any) => o.name === name)?.allocated_price ?? 0);

  // ── Scenario A — cumulative_catchup (§21b): a NOT-distinct modification → catch-up on the satisfied portion ──
  // Fixed 1000 over 10 months (100/mo), decoupled (bill_upfront:false) so the catch-up builds a contract asset.
  const cA = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 1000, contract_date: '2070-01-01', description: 'REV-26 cumulative', obligations: [{ name: 'Base service', ssp: 1000, method: 'over_time', start_date: '2070-01-01', end_date: '2070-10-31' }] });
  const idA = cA.json.id;
  await inj('POST', `/api/revenue/contracts/${idA}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idA}/activate`, exec1, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idA}/schedule`, exec1, {});
  const recA = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idA, period: '2070-04' });
  ok('REV-26 setup: recognize 4 months → 400 recognized (fixed price, decoupled)', near(recA.json.total_recognized, 400), JSON.stringify({ t: recA.json.total_recognized }));

  // Maker records a NOT-distinct modification (+200). distinct_flag:false → classified cumulative_catchup.
  const mA = await inj('POST', `/api/revenue/contracts/${idA}/modify`, exec1, { added_price: 200, distinct_flag: false, at_ssp_flag: false, as_of: '2070-04-30', note: 'expanded scope of the same service' });
  ok('REV-26: not-distinct modification classified cumulative_catchup (§21b)', mA.json.type === 'cumulative_catchup' && mA.json.status === 'Pending', JSON.stringify(mA.json).slice(0, 140));
  ok('REV-26: cumulative preview_effect = 80 (400 recognized × 20% price uplift)', near(mA.json.preview_effect, 80), `preview=${mA.json.preview_effect}`);
  const modA = mA.json.id;

  // Approval MANDATORY before it drives revenue: a Pending modification changes NOTHING.
  const cAafterModify = await getC(exec1, idA);
  ok('REV-26: a Pending modification drives nothing (total still 1000)', near(cAafterModify.total_price, 1000), `total=${cAafterModify.total_price}`);

  // Maker-checker: the maker (exec1) may NOT approve their own modification.
  const selfApprove = await inj('POST', `/api/revenue/contracts/${idA}/modifications/${modA}/approve`, exec1, {});
  ok('REV-26: maker cannot approve own modification → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', `${selfApprove.status} ${selfApprove.json.error?.code}`);

  const revABefore = await bal(exec1, '4300');
  const assetABefore = await bal(exec1, '1265');
  const apprA = await inj('POST', `/api/revenue/contracts/${idA}/modifications/${modA}/approve`, exec2, {});
  ok('REV-26: distinct checker approves → Applied, new_total 1200', apprA.json.status === 'Applied' && apprA.json.approved_by === 'exec2' && near(apprA.json.new_total_price, 1200), JSON.stringify(apprA.json).slice(0, 160));
  ok('REV-26: cumulative catch-up delta = 80 (400 recognized × 20% uplift)', near(apprA.json.catch_up_delta, 80), `Δ=${apprA.json.catch_up_delta}`);
  ok('REV-26: catch-up lifted recognized revenue 4300 by 80', near(revUp(await bal(exec1, '4300'), revABefore), 80), `Δrev=${revUp(await bal(exec1, '4300'), revABefore).toFixed(2)}`);
  ok('REV-26: catch-up built a contract asset 1265 (+80, recognized ahead of billing)', near((await bal(exec1, '1265')) - assetABefore, 80), `Δ1265=${((await bal(exec1, '1265')) - assetABefore).toFixed(2)}`);

  // Re-approving an already-applied modification is blocked.
  const reApprove = await inj('POST', `/api/revenue/contracts/${idA}/modifications/${modA}/approve`, exec2, {});
  ok('REV-26: re-approve an applied modification → 400 MODIFICATION_NOT_PENDING', reApprove.status === 400 && reApprove.json.error?.code === 'MODIFICATION_NOT_PENDING', `${reApprove.status} ${reApprove.json.error?.code}`);

  // Position tie-out: recognized 480, billed 0 → contract asset 480.
  const posA = await inj('GET', `/api/revenue/contracts/${idA}/position`, exec1);
  ok('REV-26: position recognized=480 billed=0 asset=480 (tie-out after catch-up)', near(posA.json.recognized_revenue, 480) && near(posA.json.billed_to_date, 0) && near(posA.json.contract_asset, 480), JSON.stringify(posA.json).slice(0, 140));

  // ── Scenario B — prospective (§21a): distinct but NOT at SSP → re-allocate remaining, NO catch-up ──────────
  // Contract 1000 = PO-A (point-in-time, ssp 400, recognized) + PO-B (over-time, ssp 600, starts LATER → 0 recognized).
  const cB = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 1000, contract_date: '2071-01-01', description: 'REV-26 prospective', obligations: [
    { name: 'Setup (delivered)', ssp: 400, method: 'point_in_time', start_date: '2071-01-01' },
    { name: 'Support (future)', ssp: 600, method: 'over_time', start_date: '2071-07-01', end_date: '2071-12-31' },
  ] });
  const idB = cB.json.id;
  await inj('POST', `/api/revenue/contracts/${idB}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idB}/activate`, exec1, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idB}/schedule`, exec1, {});
  const recB = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idB, period: '2071-01' });
  ok('REV-26 setup: recognize the delivered setup only → 400 (support not yet due)', near(recB.json.total_recognized, 400), JSON.stringify({ t: recB.json.total_recognized }));

  // Maker records a DISTINCT-but-NOT-at-SSP modification: add-on priced 300, its SSP is 400.
  const mB = await inj('POST', `/api/revenue/contracts/${idB}/modify`, exec1, { added_price: 300, distinct_flag: true, at_ssp_flag: false, as_of: '2071-02-28', obligations: [{ name: 'Add-on module', ssp: 400, method: 'over_time', start_date: '2071-07-01', end_date: '2071-12-31' }] });
  ok('REV-26: distinct-but-not-at-SSP modification classified prospective (§21a)', mB.json.type === 'prospective' && mB.json.status === 'Pending', JSON.stringify(mB.json).slice(0, 140));
  ok('REV-26: prospective preview = re-allocated remaining 900 = (1000−400)+300', near(mB.json.preview_effect, 900), `preview=${mB.json.preview_effect}`);
  const modB = mB.json.id;

  const revBBefore = await bal(exec1, '4300');
  const apprB = await inj('POST', `/api/revenue/contracts/${idB}/modifications/${modB}/approve`, exec2, {});
  ok('REV-26: prospective applied → new_total 1300, NO catch-up (catch_up_delta 0)', apprB.json.status === 'Applied' && near(apprB.json.new_total_price, 1300) && near(apprB.json.catch_up_delta, 0), JSON.stringify(apprB.json).slice(0, 160));
  ok('REV-26: prospective posts NO catch-up — recognized revenue 4300 unchanged', near(revUp(await bal(exec1, '4300'), revBBefore), 0), `Δrev=${revUp(await bal(exec1, '4300'), revBBefore).toFixed(2)}`);

  // Re-allocation: remaining 900 over PO-B (ssp 600) + Add-on (ssp 400) = basis 1000 → 540 / 360. Setup frozen at 400.
  const cBafter = await getC(exec1, idB);
  ok('REV-26: prospective re-allocated the remaining price over remaining POs (Support 600→540)', near(alloc(cBafter, 'Support (future)'), 540), `Support=${alloc(cBafter, 'Support (future)')}`);
  ok('REV-26: the new distinct PO is added at its re-allocated share (Add-on = 360)', near(alloc(cBafter, 'Add-on module'), 360), `Add-on=${alloc(cBafter, 'Add-on module')}`);
  ok('REV-26: the satisfied PO is frozen (Setup allocation unchanged at 400)', near(alloc(cBafter, 'Setup (delivered)'), 400), `Setup=${alloc(cBafter, 'Setup (delivered)')}`);
  ok('REV-26: Σ allocated ties to the new total (400+540+360 = 1300)', near(alloc(cBafter, 'Setup (delivered)') + alloc(cBafter, 'Support (future)') + alloc(cBafter, 'Add-on module'), 1300));

  // Recognize the re-allocated support+add-on for the full window → revenue tracks the re-allocated (not old) price.
  const recB2 = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idB, period: '2071-12' });
  ok('REV-26: post-modification recognition runs at the re-allocated price (900 more → 1300 total)', near(recB2.json.total_recognized, 900), `t=${recB2.json.total_recognized}`);

  // ── Scenario C — separate_contract (§20): distinct AND at SSP → new independent contract, original untouched ──
  const cC = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 1000, contract_date: '2072-01-01', description: 'REV-26 separate', obligations: [{ name: 'Core service', ssp: 1000, method: 'over_time', start_date: '2072-01-01', end_date: '2072-10-31' }] });
  const idC = cC.json.id;
  await inj('POST', `/api/revenue/contracts/${idC}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idC}/activate`, exec1, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idC}/schedule`, exec1, {});
  await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idC, period: '2072-04' }); // 400 recognized

  // Add a DISTINCT good at SSP: added_price 500 == its ssp 500.
  const mC = await inj('POST', `/api/revenue/contracts/${idC}/modify`, exec1, { added_price: 500, distinct_flag: true, at_ssp_flag: true, as_of: '2072-04-30', obligations: [{ name: 'New licence', ssp: 500, method: 'over_time', start_date: '2072-05-01', end_date: '2072-09-30' }] });
  ok('REV-26: distinct-AND-at-SSP modification classified separate_contract (§20)', mC.json.type === 'separate_contract' && mC.json.status === 'Pending', JSON.stringify(mC.json).slice(0, 140));
  const modC = mC.json.id;

  const revCBefore = await bal(exec1, '4300');
  const apprC = await inj('POST', `/api/revenue/contracts/${idC}/modifications/${modC}/approve`, exec2, {});
  ok('REV-26: separate_contract applied → a NEW linked contract is created', apprC.json.status === 'Applied' && apprC.json.new_contract_id != null && near(apprC.json.new_total_price, 500), JSON.stringify(apprC.json).slice(0, 160));
  ok('REV-26: separate_contract posts NO immediate revenue (4300 unchanged)', near(revUp(await bal(exec1, '4300'), revCBefore), 0), `Δrev=${revUp(await bal(exec1, '4300'), revCBefore).toFixed(2)}`);

  const newC = await getC(exec1, apprC.json.new_contract_id);
  ok('REV-26: the new independent contract holds the added good at SSP (total 500, PO allocated 500)', near(newC.total_price, 500) && (newC.obligations ?? []).length === 1 && near(alloc(newC, 'New licence'), 500), JSON.stringify({ t: newC.total_price, n: (newC.obligations ?? []).length }));

  // The ORIGINAL is untouched: total 1000, still one PO, recognized still 400.
  const cCafter = await getC(exec1, idC);
  const recCafter = (cCafter.schedule ?? []).filter((r: any) => r.recognized).reduce((a: number, r: any) => a + Number(r.recognized_amount), 0);
  ok('REV-26: the ORIGINAL contract is untouched (total 1000, 1 PO, recognized 400)', near(cCafter.total_price, 1000) && (cCafter.obligations ?? []).length === 1 && near(recCafter, 400), JSON.stringify({ t: cCafter.total_price, n: (cCafter.obligations ?? []).length, r: recCafter }));

  // ── Scenario D — tenant RLS isolation on rev_contract_modifications ──
  const cD = await inj('POST', '/api/revenue/contracts', exec2b, { total_price: 400, contract_date: '2073-01-01', obligations: [{ name: 'Svc', ssp: 400, method: 'over_time', start_date: '2073-01-01', end_date: '2073-04-30' }] });
  const idD = cD.json.id;
  await inj('POST', `/api/revenue/contracts/${idD}/allocate`, exec2b, {});
  await inj('POST', `/api/revenue/contracts/${idD}/modify`, exec2b, { added_price: 100, distinct_flag: false, at_ssp_flag: false });
  const t1SeesD = await inj('GET', `/api/revenue/contracts/${idD}/modifications`, exec1);
  ok('REV-26 RLS: T1 user cannot read T2 contract modifications → 404', t1SeesD.status === 404, `${t1SeesD.status} ${t1SeesD.json.error?.code}`);
  const t2SeesD = await inj('GET', `/api/revenue/contracts/${idD}/modifications`, exec2b);
  ok('REV-26 RLS: T2 owner reads its own modification (1 row)', (t2SeesD.json.modifications ?? []).length === 1, JSON.stringify((t2SeesD.json.modifications ?? []).length));

  await app.close();
  await pg.close();

  console.log('\n── Track D Wave 3 — REV-26 contract modifications (TFRS 15 §18-21) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} revrec-modifications checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} revrec-modifications checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
