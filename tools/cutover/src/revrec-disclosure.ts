/**
 * Track D — Wave 4 (REV-27, FINAL): significant financing component (§60-65) + revenue disclosure pack (§120)
 * under TFRS 15 / IFRS 15 / ASC 606, over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover revrec-disclosure
 *
 * Verifies:
 *   • Financing component (§60-65): the transaction price is discounted to PV and the interest is UNWOUND by
 *     the effective-interest method so Σ interest == face − PV; the DISCOUNT RATE is a maker-checker judgement
 *     (the maker may NOT approve their own → 403 SOD_SELF_APPROVAL; run-financing on an unapproved component →
 *     FINANCING_NOT_APPROVED; a Pending component posts nothing). advance (prepay) posts Dr 2410 / Cr 4650
 *     interest income; arrears (deferred) posts Dr 1265 / Cr 5900. Idempotent (a re-run posts nothing).
 *   • Disclosure pack (§120): the contract-liability rollforward reconciles to GL 2410/1265
 *     (opening + billings − recognized = closing = GL); the RPO/backlog = Σ unrecognized allocated price,
 *     banded by expected timing.
 *   • tenant RLS isolation on rev_financing_schedules + the disclosure aggregators.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'revrec-disclosure-secret';
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
const near = (a: any, b: number, tol = 0.01) => Math.abs(Number(a) - b) < tol;
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T1', name: 'ร้านหนึ่ง' }, { code: 'T2', name: 'ร้านสอง' }, { code: 'T3', name: 'ร้านสาม' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [t1, t2, t3] = [await tid('T1'), await tid('T2'), await tid('T3')];
  await db.insert(s.users).values([
    { username: 'exec1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'exec2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t1 },
    { username: 'exec2b', passwordHash: await pw.hash('pw3'), role: 'Sales', tenantId: t2 },
    // T3 is a CLEAN tenant for the tenant-aggregate rollforward + RPO (isolated from the financing contracts in T1).
    { username: 'exec3', passwordHash: await pw.hash('pw4'), role: 'Sales', tenantId: t3 },
    { username: 'exec3b', passwordHash: await pw.hash('pw5'), role: 'Sales', tenantId: t3 },
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
  const [exec1, exec2, exec2b, exec3, exec3b] = [await login('exec1', 'pw1'), await login('exec2', 'pw2'), await login('exec2b', 'pw3'), await login('exec3', 'pw4'), await login('exec3b', 'pw5')];
  const bal = async (token: string, code: string) => {
    const tb = (await inj('GET', '/api/ledger/trial-balance', token)).json;
    return Number((tb.rows ?? []).find((r: any) => r.account_code === code)?.balance ?? 0);
  };
  // a credit-side amount (revenue/interest income) shows as a NEGATIVE trial-balance balance; measure it as −balance.
  const creditBal = (b: number) => round4(-b);
  const sumInterest = (sched: any[]) => round4(sched.reduce((a: number, x: any) => a + Number(x.interest_amount), 0));

  // ── Scenario A — significant financing component, ADVANCE (customer prepays → interest income 4650) ──────────
  // 1200 billed up-front (Dr 1100 / Cr 2410 1200). Financing: 12% p.a. (1%/mo) over 12 months on the 1200 face.
  const rate = 12, periods = 12, faceA = 1200;
  const pvA = round4(faceA / Math.pow(1 + rate / 100 / 12, periods));   // = 1200 / 1.01^12
  const finA = round4(faceA - pvA);
  const cA = await inj('POST', '/api/revenue/contracts', exec1, { total_price: faceA, contract_date: '2075-01-01', description: 'REV-27 financing advance', obligations: [{ name: 'Annual service', ssp: faceA, method: 'over_time', start_date: '2075-01-01', end_date: '2075-12-31' }] });
  const idA = cA.json.id;
  await inj('POST', `/api/revenue/contracts/${idA}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idA}/activate`, exec1, { bill_upfront: true }); // 2410 cr 1200

  // Maker sets the financing component (Pending — drives nothing).
  const setA = await inj('POST', `/api/revenue/contracts/${idA}/financing-component`, exec1, { discount_rate_pct: rate, periods, direction: 'advance' });
  ok('REV-27: financing component discounts the price to PV (1200 → 1200/1.01^12)', near(setA.json.present_value, pvA) && setA.json.status === 'Pending', JSON.stringify({ pv: setA.json.present_value, exp: pvA }));
  ok('REV-27: Σ interest ties to the face value (face − PV)', near(setA.json.financing_total, finA) && near(sumInterest(setA.json.schedule), finA), JSON.stringify({ fin: setA.json.financing_total, exp: finA, sched: sumInterest(setA.json.schedule) }));
  ok('REV-27: EIR unwind — last closing balance == face (nominal 1200)', near(setA.json.schedule.at(-1)?.closing_balance, faceA) && setA.json.schedule.length === periods, JSON.stringify({ last: setA.json.schedule.at(-1)?.closing_balance }));

  // Maker-checker: the maker (exec1) may NOT approve their own discount-rate judgement.
  const selfApr = await inj('POST', `/api/revenue/contracts/${idA}/financing-component/approve`, exec1, {});
  ok('REV-27: maker cannot approve own financing component → 403 SOD_SELF_APPROVAL', selfApr.status === 403 && selfApr.json.error?.code === 'SOD_SELF_APPROVAL', `${selfApr.status} ${selfApr.json.error?.code}`);

  // A Pending (unapproved) component posts nothing: run-financing is blocked.
  const runBefore = await inj('POST', `/api/revenue/contracts/${idA}/run-financing`, exec1, { period: '2075-12' });
  ok('REV-27: run-financing before approval → 400 FINANCING_NOT_APPROVED (rate judgement not blessed)', runBefore.status === 400 && runBefore.json.error?.code === 'FINANCING_NOT_APPROVED', `${runBefore.status} ${runBefore.json.error?.code}`);

  const aprA = await inj('POST', `/api/revenue/contracts/${idA}/financing-component/approve`, exec2, {});
  ok('REV-27: a different checker approves the discount rate → Approved', aprA.json.status === 'Approved' && aprA.json.approved_by === 'exec2' && aprA.json.approved_periods === periods, JSON.stringify(aprA.json));

  const inc4650Before = creditBal(await bal(exec1, '4650'));
  const runA = await inj('POST', `/api/revenue/contracts/${idA}/run-financing`, exec1, { period: '2075-12' });
  ok('REV-27: run-financing posts the full unwind (12 periods, Σ interest == face − PV)', runA.json.posted_count === periods && near(runA.json.total_interest, finA), JSON.stringify({ n: runA.json.posted_count, t: runA.json.total_interest, exp: finA }));
  ok('REV-27: advance case posts financing INTEREST INCOME to 4650 (Dr 2410 / Cr 4650)', near(creditBal(await bal(exec1, '4650')) - inc4650Before, finA), `Δ4650=${(creditBal(await bal(exec1, '4650')) - inc4650Before).toFixed(4)}`);

  // Idempotent: a re-run posts nothing more.
  const runA2 = await inj('POST', `/api/revenue/contracts/${idA}/run-financing`, exec1, { period: '2075-12' });
  ok('REV-27: run-financing is idempotent (re-run posts 0)', runA2.json.posted_count === 0, JSON.stringify({ n: runA2.json.posted_count }));

  // ── Scenario B — significant financing component, ARREARS (deferred payment → interest 5900) ─────────────────
  const faceB = 1000, periodsB = 6;
  const pvB = round4(faceB / Math.pow(1 + rate / 100 / 12, periodsB));
  const finB = round4(faceB - pvB);
  const cB = await inj('POST', '/api/revenue/contracts', exec1, { total_price: faceB, contract_date: '2076-01-01', description: 'REV-27 financing arrears', obligations: [{ name: 'Delivered goods', ssp: faceB, method: 'point_in_time', start_date: '2076-01-01' }] });
  const idB = cB.json.id;
  const setB = await inj('POST', `/api/revenue/contracts/${idB}/financing-component`, exec1, { discount_rate_pct: rate, periods: periodsB, direction: 'arrears' });
  ok('REV-27: arrears component discounts to PV + Σ interest = face − PV', near(setB.json.present_value, pvB) && near(setB.json.financing_total, finB), JSON.stringify({ pv: setB.json.present_value, fin: setB.json.financing_total, expPv: pvB }));
  await inj('POST', `/api/revenue/contracts/${idB}/financing-component/approve`, exec2, {});
  const asset1265Before = await bal(exec1, '1265');
  const int5900Before = creditBal(await bal(exec1, '5900'));
  const runB = await inj('POST', `/api/revenue/contracts/${idB}/run-financing`, exec1, { period: '2076-12' });
  ok('REV-27: arrears run posts 6 periods, total interest = face − PV', runB.json.posted_count === periodsB && near(runB.json.total_interest, finB), JSON.stringify({ n: runB.json.posted_count, t: runB.json.total_interest }));
  ok('REV-27: arrears accretes the contract asset 1265 (Dr 1265)', near((await bal(exec1, '1265')) - asset1265Before, finB), `Δ1265=${((await bal(exec1, '1265')) - asset1265Before).toFixed(4)}`);
  ok('REV-27: arrears books the financing charge to the net interest line 5900 (Cr 5900)', near(creditBal(await bal(exec1, '5900')) - int5900Before, finB), `Δ5900=${(creditBal(await bal(exec1, '5900')) - int5900Before).toFixed(4)}`);

  // A second financing component on the same contract is rejected.
  const dup = await inj('POST', `/api/revenue/contracts/${idB}/financing-component`, exec1, { discount_rate_pct: rate, periods: periodsB, direction: 'arrears' });
  ok('REV-27: one financing component per contract → FINANCING_ALREADY_SET', dup.status === 400 && dup.json.error?.code === 'FINANCING_ALREADY_SET', `${dup.status} ${dup.json.error?.code}`);

  // ── Scenario C — contract-liability rollforward (§120(b)) reconciles to GL 2410/1265 (CLEAN tenant T3) ───────
  // Decoupled contract (bill_upfront:false): bill 300 in 2075-01, recognize month 1 (100) in 2075-01.
  const cC = await inj('POST', '/api/revenue/contracts', exec3, { total_price: 1000, contract_date: '2075-01-01', description: 'REV-27 rollforward', obligations: [{ name: 'Support', ssp: 1000, method: 'over_time', start_date: '2075-01-01', end_date: '2075-10-31' }] });
  const idC = cC.json.id;
  await inj('POST', `/api/revenue/contracts/${idC}/allocate`, exec3, {});
  await inj('POST', `/api/revenue/contracts/${idC}/activate`, exec3, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idC}/schedule`, exec3, {});
  const defC = await inj('POST', `/api/revenue/contracts/${idC}/billing-schedule`, exec3, { milestones: [{ period: '2075-01', amount: 300 }] });
  const msId = defC.json.billing_schedule.find((m: any) => m.period === '2075-01').id;
  await inj('POST', `/api/revenue/contracts/${idC}/bill`, exec3b, { billing_schedule_id: msId, date: '2075-01-10' }); // 2410 cr 300 (maker exec3 ≠ biller exec3b)
  await inj('POST', '/api/revenue/contracts/recognize', exec3, { contract_id: idC, period: '2075-01' });             // Dr 2410 100 (2075-01-01)

  const rf = await inj('GET', '/api/revenue/disclosure/contract-liability-rollforward?period=2075-01', exec3);
  const cl = rf.json.contract_liability;
  ok('REV-27: rollforward billings = 300, recognized = 100 (§120(b))', near(cl.billings, 300) && near(cl.recognized, 100), JSON.stringify({ open: cl.opening, bill: cl.billings, rec: cl.recognized, close: cl.closing }));
  ok('REV-27: rollforward identity opening + billings − recognized = closing (0 + 300 − 100 = 200)', near(round4(cl.opening + cl.additions.total - cl.reductions.total), cl.closing) && near(cl.closing, 200), JSON.stringify({ open: cl.opening, add: cl.additions.total, red: cl.reductions.total, close: cl.closing }));
  ok('REV-27: rollforward RECONCILES to GL 2410 (closing == GL balance)', near(cl.closing, cl.gl_closing) && cl.reconciled === true && rf.json.reconciled === true, JSON.stringify({ close: cl.closing, gl: cl.gl_closing }));

  // ── Scenario D — RPO / backlog (§120(a)) = Σ unrecognized allocated price, banded (CLEAN tenant T3) ──────────
  // Contract C has 10×100; month 1 recognized (100) → RPO 900 across months 2..10.
  const rpo = await inj('GET', '/api/revenue/disclosure/rpo?as_of=2075-06', exec3);
  const rC = (rpo.json.by_contract ?? []).find((r: any) => r.contract_id === idC);
  ok('REV-27: RPO for the contract = Σ unrecognized allocated price (900)', !!rC && near(rC.rpo, 900), JSON.stringify({ rpo: rC?.rpo }));
  ok('REV-27: RPO timing band sums to the total (within_12m + beyond_12m = rpo)', !!rC && near(round4(rC.within_12m + rC.beyond_12m), rC.rpo), JSON.stringify({ w: rC?.within_12m, b: rC?.beyond_12m }));
  ok('REV-27: as_of=2075-06 → the 2075-07..10 backlog is inside the 12-month band', !!rC && near(rC.within_12m, 900) && near(rC.beyond_12m, 0), JSON.stringify({ w: rC?.within_12m, b: rC?.beyond_12m }));

  // ── Scenario E — tenant RLS isolation ──
  const cE = await inj('POST', '/api/revenue/contracts', exec2b, { total_price: 500, contract_date: '2077-01-01', obligations: [{ name: 'Svc', ssp: 500, method: 'over_time', start_date: '2077-01-01', end_date: '2077-05-31' }] });
  const idE = cE.json.id;
  await inj('POST', `/api/revenue/contracts/${idE}/allocate`, exec2b, {});
  await inj('POST', `/api/revenue/contracts/${idE}/schedule`, exec2b, {}); // build the recognition schedule so RPO sees the backlog
  await inj('POST', `/api/revenue/contracts/${idE}/financing-component`, exec2b, { discount_rate_pct: rate, periods: 5, direction: 'advance' });
  const t1SeesE = await inj('GET', `/api/revenue/contracts/${idE}/financing-component`, exec1);
  ok('REV-27 RLS: T1 user cannot read T2 financing component → 404', t1SeesE.status === 404, `${t1SeesE.status} ${t1SeesE.json.error?.code}`);
  const t1Rpo = await inj('GET', '/api/revenue/disclosure/rpo', exec1);
  ok('REV-27 RLS: T1 RPO excludes the T2 contract', !(t1Rpo.json.by_contract ?? []).some((r: any) => r.contract_id === idE), JSON.stringify({ ids: (t1Rpo.json.by_contract ?? []).map((r: any) => r.contract_id) }));
  const t2Rpo = await inj('GET', '/api/revenue/disclosure/rpo?as_of=2077-06', exec2b);
  ok('REV-27 RLS: T2 owner sees its own contract in RPO', (t2Rpo.json.by_contract ?? []).some((r: any) => r.contract_id === idE), JSON.stringify({ ids: (t2Rpo.json.by_contract ?? []).map((r: any) => r.contract_id) }));

  await app.close();
  await pg.close();

  console.log('\n── Track D Wave 4 — REV-27 significant financing component + revenue disclosure pack (TFRS 15 §60-65/§120) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} revrec-disclosure checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} revrec-disclosure checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
