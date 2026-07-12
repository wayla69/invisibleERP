/**
 * Track D — Wave 2 (REV-25): variable consideration + the constraint under TFRS 15 / IFRS 15 / ASC 606
 * §50-59, over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover revrec-variable
 *
 * Verifies:
 *   • EXPECTED-VALUE estimate = Σ probability × amount; MOST-LIKELY estimate = the max-probability outcome;
 *   • THE CONSTRAINT caps the recognizable price — a constrained amount above the gross estimate is rejected
 *     (CONSTRAINT_EXCEEDS_ESTIMATE); only the CONSTRAINED amount drives the transaction price;
 *   • the estimate is a management judgement: the estimator may NOT approve their own estimate
 *     (403 SOD_SELF_APPROVAL) and approval is MANDATORY before it drives revenue (reestimate before approval
 *     is a no-op);
 *   • a re-estimate TRUES-UP already-recognized revenue via a cumulative catch-up delta — building a contract
 *     asset (1265) when recognized ahead of billing, or releasing the contract liability (2410) when billed
 *     up-front (REV-19 back-compat) — and is IDEMPOTENT (a second reestimate posts nothing);
 *   • tenant RLS isolation on rev_variable_estimates.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'revrec-variable-secret';
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
    // Two Sales users (role holds exec + ar + fin_report) in T1 so the estimator (exec1) and approver (exec2) differ (SoD).
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

  // ── Scenario A — EXPECTED-VALUE estimate, constraint, and a true-up building a CONTRACT ASSET (decoupled) ──
  // Fixed price 1000 over 10 months (100/mo), activated WITHOUT up-front billing so the catch-up lands in 1265.
  const cA = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 1000, contract_date: '2060-01-01', description: 'REV-25 variable', obligations: [{ name: 'Managed service', ssp: 1000, method: 'over_time', start_date: '2060-01-01', end_date: '2060-10-31' }] });
  const idA = cA.json.id;
  await inj('POST', `/api/revenue/contracts/${idA}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idA}/activate`, exec1, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idA}/schedule`, exec1, {});
  const recA = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idA, period: '2060-04' });
  ok('REV-25 setup: recognize 4 months → 400 recognized (fixed price, decoupled)', near(recA.json.total_recognized, 400), JSON.stringify({ t: recA.json.total_recognized }));

  // Record an EXPECTED-VALUE estimate: {200 @ 50%, 0 @ 50%} → gross = 100. Constrained to 80 (highly probable).
  const e1 = await inj('POST', `/api/revenue/contracts/${idA}/variable-consideration`, exec1, {
    method: 'expected_value', scenarios: [{ amount: 200, probability: 0.5 }, { amount: 0, probability: 0.5 }], constrained_amount: 80, as_of: '2060-04-30',
  });
  ok('REV-25: expected-value gross = Σ prob×amount = 100', near(e1.json.gross_estimate, 100), JSON.stringify({ g: e1.json.gross_estimate }));
  ok('REV-25: estimate recorded Pending, constrained 80', e1.json.status === 'Pending' && near(e1.json.constrained_amount, 80), JSON.stringify(e1.json).slice(0, 100));
  const vc1 = e1.json.id;

  // Probability sanity: scenarios that do not sum to 1 are rejected.
  const badP = await inj('POST', `/api/revenue/contracts/${idA}/variable-consideration`, exec1, { method: 'expected_value', scenarios: [{ amount: 100, probability: 0.5 }], constrained_amount: 10 });
  ok('REV-25: probabilities must sum to 1 → 400 INVALID_PROBABILITIES', badP.status === 400 && badP.json.error?.code === 'INVALID_PROBABILITIES', `${badP.status} ${badP.json.error?.code}`);

  // Approval MANDATORY before it drives revenue: reestimate while the estimate is still Pending is a no-op.
  const revA0 = await bal(exec1, '4300');
  const preApprove = await inj('POST', `/api/revenue/contracts/${idA}/reestimate`, exec1, {});
  ok('REV-25: reestimate before approval is a no-op (applied:false, catch_up 0)', preApprove.json.applied === false && near(preApprove.json.catch_up_delta, 0), JSON.stringify(preApprove.json).slice(0, 120));
  ok('REV-25: no revenue moved before approval (approval is mandatory)', near(revUp(await bal(exec1, '4300'), revA0), 0), `Δrev=${revUp(await bal(exec1, '4300'), revA0).toFixed(2)}`);

  // Maker-checker: the estimator (exec1) may NOT approve their own estimate.
  const selfApprove = await inj('POST', `/api/revenue/contracts/${idA}/variable-consideration/${vc1}/approve`, exec1, {});
  ok('REV-25: estimator cannot approve own estimate → 403 SOD_SELF_APPROVAL', selfApprove.status === 403 && selfApprove.json.error?.code === 'SOD_SELF_APPROVAL', `${selfApprove.status} ${selfApprove.json.error?.code}`);

  // A different user (exec2) approves it.
  const approve = await inj('POST', `/api/revenue/contracts/${idA}/variable-consideration/${vc1}/approve`, exec2, {});
  ok('REV-25: distinct approver approves → Approved', approve.json.status === 'Approved' && approve.json.approved_by === 'exec2', JSON.stringify(approve.json));

  // Apply it: transaction price 1000 → 1080; recognized 400 trued-up ×1.08 → 432; catch-up delta 32.
  const revBefore = await bal(exec1, '4300');
  const assetBefore = await bal(exec1, '1265');
  const re1 = await inj('POST', `/api/revenue/contracts/${idA}/reestimate`, exec1, { date: '2060-04-30' });
  ok('REV-25: reestimate applies → new_total 1080 (fixed 1000 + constrained 80)', re1.json.applied === true && near(re1.json.new_total_price, 1080) && near(re1.json.constrained_amount, 80), JSON.stringify(re1.json).slice(0, 160));
  ok('REV-25: true-up catch-up delta = 32 (400 recognized × 8% uplift)', near(re1.json.catch_up_delta, 32), `Δ=${re1.json.catch_up_delta}`);
  ok('REV-25: recognized revenue 4300 rose by the catch-up 32', near(revUp(await bal(exec1, '4300'), revBefore), 32), `Δrev=${revUp(await bal(exec1, '4300'), revBefore).toFixed(2)}`);
  ok('REV-25: catch-up built a contract asset 1265 (+32, recognized ahead of billing)', near((await bal(exec1, '1265')) - assetBefore, 32), `Δ1265=${((await bal(exec1, '1265')) - assetBefore).toFixed(2)}`);

  // The constrained amount (80), NOT the gross (100), drove the price: 1080 not 1100.
  ok('REV-25: the CONSTRAINT (80) — not the gross estimate (100) — drives the price', near(re1.json.new_total_price, 1080) && !near(re1.json.new_total_price, 1100), `total=${re1.json.new_total_price}`);

  // Idempotent: a second reestimate with no new approved estimate posts nothing.
  const revBeforeIdem = await bal(exec1, '4300');
  const re2 = await inj('POST', `/api/revenue/contracts/${idA}/reestimate`, exec1, {});
  ok('REV-25: second reestimate is idempotent (applied:false, catch_up 0)', re2.json.applied === false && near(re2.json.catch_up_delta, 0), JSON.stringify(re2.json).slice(0, 120));
  ok('REV-25: no double-post — 4300 unchanged on the idempotent re-run', near(revUp(await bal(exec1, '4300'), revBeforeIdem), 0), `Δrev=${revUp(await bal(exec1, '4300'), revBeforeIdem).toFixed(2)}`);

  // Position tie-out (REV-24 endpoint): recognized 432, billed 0 → contract asset 432.
  const posA = await inj('GET', `/api/revenue/contracts/${idA}/position`, exec1);
  ok('REV-25: position recognized=432 billed=0 asset=432 (tie-out after true-up)', near(posA.json.recognized_revenue, 432) && near(posA.json.billed_to_date, 0) && near(posA.json.contract_asset, 432), JSON.stringify(posA.json).slice(0, 140));

  // Trial balance stays balanced.
  const tbA = (await inj('GET', '/api/ledger/trial-balance', exec1)).json.totals ?? {};
  ok('REV-25: trial balance balanced after the true-up', near(tbA.debit ?? tbA.total_debit, tbA.credit ?? tbA.total_credit), JSON.stringify(tbA).slice(0, 60));

  // ── Scenario B — MOST-LIKELY estimate, the constraint control-negative, and a true-up RELEASING 2410 ──
  // Fixed 500 over 5 months (100/mo), activated with up-front billing (REV-19 back-compat): billed 500, 2410=500.
  const cB = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 500, contract_date: '2061-01-01', obligations: [{ name: 'Annual license', ssp: 500, method: 'over_time', start_date: '2061-01-01', end_date: '2061-05-31' }] });
  const idB = cB.json.id;
  await inj('POST', `/api/revenue/contracts/${idB}/allocate`, exec1, {});
  await inj('POST', `/api/revenue/contracts/${idB}/activate`, exec1, {}); // default bill_upfront=true
  await inj('POST', `/api/revenue/contracts/${idB}/schedule`, exec1, {});
  await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idB, period: '2061-02' }); // 2 months = 200

  // MOST-LIKELY via scenarios: {100 @ 30%, 300 @ 70%} → gross = the max-probability outcome (300).
  const eB1 = await inj('POST', `/api/revenue/contracts/${idB}/variable-consideration`, exec1, { method: 'most_likely', scenarios: [{ amount: 100, probability: 0.3 }, { amount: 300, probability: 0.7 }], constrained_amount: 100, as_of: '2061-02-28' });
  ok('REV-25: most-likely gross = the max-probability outcome (300)', near(eB1.json.gross_estimate, 300), JSON.stringify({ g: eB1.json.gross_estimate }));

  // Control-negative: a constrained amount ABOVE the estimate is over-recognition → rejected.
  const overC = await inj('POST', `/api/revenue/contracts/${idB}/variable-consideration`, exec1, { method: 'most_likely', most_likely_amount: 100, constrained_amount: 150 });
  ok('REV-25: constrained > estimate → 400 CONSTRAINT_EXCEEDS_ESTIMATE (over-recognition blocked)', overC.status === 400 && overC.json.error?.code === 'CONSTRAINT_EXCEEDS_ESTIMATE', `${overC.status} ${overC.json.error?.code}`);

  const vcB = eB1.json.id;
  await inj('POST', `/api/revenue/contracts/${idB}/variable-consideration/${vcB}/approve`, exec2, {});
  const revBBefore = await bal(exec1, '4300');
  const liabBBefore = await bal(exec1, '2410');
  const assetBBefore = await bal(exec1, '1265');
  const reB = await inj('POST', `/api/revenue/contracts/${idB}/reestimate`, exec1, { date: '2061-02-28' });
  // new_total = 500 + 100 = 600; recognized 200 × 1.2 = 240; catch-up 40. Billed up-front (500) so the
  // catch-up RELEASES the contract liability 2410 (not a contract asset) — REV-19 back-compat path.
  ok('REV-25: most-likely true-up → new_total 600, catch-up 40', reB.json.applied === true && near(reB.json.new_total_price, 600) && near(reB.json.catch_up_delta, 40), JSON.stringify(reB.json).slice(0, 160));
  ok('REV-25: catch-up RELEASES contract liability 2410 by 40 (billed up-front)', near((await bal(exec1, '2410')) - liabBBefore, 40), `Δ2410=${((await bal(exec1, '2410')) - liabBBefore).toFixed(2)}`);
  ok('REV-25: no contract asset built (liability covered the true-up) — 1265 unchanged', near((await bal(exec1, '1265')) - assetBBefore, 0), `Δ1265=${((await bal(exec1, '1265')) - assetBBefore).toFixed(2)}`);
  ok('REV-25: recognized revenue 4300 rose by 40', near(revUp(await bal(exec1, '4300'), revBBefore), 40), `Δrev=${revUp(await bal(exec1, '4300'), revBBefore).toFixed(2)}`);

  // ── Scenario C — tenant RLS isolation on rev_variable_estimates ──
  const cC = await inj('POST', '/api/revenue/contracts', exec2b, { total_price: 400, contract_date: '2062-01-01', obligations: [{ name: 'Svc', ssp: 400, method: 'over_time', start_date: '2062-01-01', end_date: '2062-04-30' }] });
  const idC = cC.json.id;
  await inj('POST', `/api/revenue/contracts/${idC}/allocate`, exec2b, {});
  await inj('POST', `/api/revenue/contracts/${idC}/variable-consideration`, exec2b, { method: 'most_likely', most_likely_amount: 50, constrained_amount: 40 });
  const t1SeesC = await inj('GET', `/api/revenue/contracts/${idC}/variable-consideration`, exec1);
  ok('REV-25 RLS: T1 user cannot read T2 contract estimates → 404', t1SeesC.status === 404, `${t1SeesC.status} ${t1SeesC.json.error?.code}`);
  const t2SeesC = await inj('GET', `/api/revenue/contracts/${idC}/variable-consideration`, exec2b);
  ok('REV-25 RLS: T2 owner reads its own estimate (1 row)', (t2SeesC.json.estimates ?? []).length === 1, JSON.stringify((t2SeesC.json.estimates ?? []).length));

  await app.close();
  await pg.close();

  console.log('\n── Track D Wave 2 — REV-25 variable consideration + the constraint (TFRS 15 §50-59) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} revrec-variable checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} revrec-variable checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
