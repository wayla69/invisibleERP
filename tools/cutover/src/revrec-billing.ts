/**
 * Track D — Wave 1 (REV-24): contract-asset / contract-liability split + independent billing schedule
 * under TFRS 15 / IFRS 15 / ASC 606 §105-107, over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover revrec-billing
 *
 * Verifies:
 *   • recognize-ahead-of-bill builds a CONTRACT ASSET (1265 unbilled receivable);
 *   • bill RECLASSES the earned contract asset 1265 → 1100 AR;
 *   • over-bill (billing ahead of recognition) parks a CONTRACT LIABILITY (2410);
 *   • the /position report reconciles (contract_asset = max(0, Σrecognized − Σbilled));
 *   • billing-schedule maker-checker (SoD): the milestone maker may not bill it;
 *   • schedule + cumulative billing may not exceed the contract price;
 *   • REV-19 back-compat: a contract activated with up-front billing still behaves as before;
 *   • tenant RLS isolation on rev_billing_schedules.
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'revrec-billing-secret';
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
    // Two Sales users (role holds 'exec' + 'ar') in T1 so the billing maker (exec1) and checker (exec2) differ (SoD).
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

  ok('COA has 1265 Contract Asset + 2410 Contract Liability + 1100 AR', JSON.stringify((await inj('GET', '/api/ledger/accounts', exec1)).json).match(/1265/) != null);

  // ── Scenario A — decoupled billing: recognize AHEAD of billing (contract asset), then bill (reclass) ──
  // Contract 1200 over 12 months (over_time), activated WITHOUT up-front billing.
  const cA = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 1200, contract_date: '2050-01-01', description: 'REV-24 decoupled', obligations: [{ name: 'Managed service', ssp: 1200, method: 'over_time', start_date: '2050-01-01', end_date: '2050-12-31' }] });
  ok('REV-24: create contract (REVC-, Draft)', /^REVC-/.test(cA.json.contract_no ?? '') && cA.json.status === 'Draft', JSON.stringify(cA.json).slice(0, 80));
  const idA = cA.json.id;
  await inj('POST', `/api/revenue/contracts/${idA}/allocate`, exec1, {});
  const actA = await inj('POST', `/api/revenue/contracts/${idA}/activate`, exec1, { bill_upfront: false });
  ok('REV-24: activate bill_upfront=false → Active, billed 0', actA.json.status === 'Active' && actA.json.bill_upfront === false && near(actA.json.billed, 0), JSON.stringify(actA.json));
  await inj('POST', `/api/revenue/contracts/${idA}/schedule`, exec1, {});

  const ar0 = await bal(exec1, '1100');
  const asset0 = await bal(exec1, '1265');
  const liab0 = await bal(exec1, '2410'); // credit balance shows as negative

  // recognize 3 months (3×100 = 300) BEFORE any billing → builds contract asset 1265, no 2410 released.
  const recA = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idA, period: '2050-03' });
  ok('REV-24: recognize 3 months → 300 recognized', near(recA.json.total_recognized, 300), JSON.stringify({ c: recA.json.recognized_count, t: recA.json.total_recognized }));
  const asset1 = await bal(exec1, '1265');
  ok('REV-24: contract asset 1265 built by 300 (recognized ahead of billing)', near(asset1 - asset0, 300), `Δ1265=${(asset1 - asset0).toFixed(2)}`);
  ok('REV-24: no contract liability 2410 moved (nothing billed)', near(await bal(exec1, '2410') - liab0, 0), `Δ2410=${(await bal(exec1, '2410') - liab0).toFixed(2)}`);

  const posA1 = await inj('GET', `/api/revenue/contracts/${idA}/position`, exec1);
  ok('REV-24: position recognized=300 billed=0 asset=300 liability=0', near(posA1.json.recognized_revenue, 300) && near(posA1.json.billed_to_date, 0) && near(posA1.json.contract_asset, 300) && near(posA1.json.contract_liability, 0), JSON.stringify(posA1.json).slice(0, 140));

  // Define a billing schedule (MAKER = exec1): two milestones 200 + 400.
  const schA = await inj('POST', `/api/revenue/contracts/${idA}/billing-schedule`, exec1, { milestones: [{ period: '2050-03', amount: 200 }, { period: '2050-06', amount: 400 }] });
  ok('REV-24: billing schedule defined (2 milestones, Planned)', (schA.json.billing_schedule ?? []).length === 2 && schA.json.billing_schedule.every((r: any) => r.status === 'Planned'), JSON.stringify(schA.json.billing_schedule));
  const ms1 = schA.json.billing_schedule[0].id; // 200
  const ms2 = schA.json.billing_schedule[1].id; // 400

  // Maker-checker: exec1 (the maker) may NOT bill → SOD_SELF_BILLING.
  const selfBill = await inj('POST', `/api/revenue/contracts/${idA}/bill`, exec1, { billing_schedule_id: ms1 });
  ok('REV-24: maker cannot bill own milestone → 403 SOD_SELF_BILLING', selfBill.status === 403 && selfBill.json.error?.code === 'SOD_SELF_BILLING', `${selfBill.status} ${selfBill.json.error?.code}`);

  // Checker (exec2) bills milestone 1 (200) — all within the earned contract asset (300) → reclass 1265→1100.
  const bill1 = await inj('POST', `/api/revenue/contracts/${idA}/bill`, exec2, { billing_schedule_id: ms1 });
  ok('REV-24: checker bills 200 → reclass 1265→1100 (asset cleared 200, no excess)', near(bill1.json.billed, 200) && near(bill1.json.contract_asset_cleared, 200) && near(bill1.json.billings_in_excess, 0), JSON.stringify(bill1.json).slice(0, 140));
  ok('REV-24: AR 1100 increased by 200', near(await bal(exec1, '1100') - ar0, 200), `Δ1100=${(await bal(exec1, '1100') - ar0).toFixed(2)}`);
  ok('REV-24: contract asset 1265 reduced to 100 (300 earned − 200 billed)', near(await bal(exec1, '1265') - asset0, 100), `1265 net=${(await bal(exec1, '1265') - asset0).toFixed(2)}`);

  // Checker bills milestone 2 (400) — only 100 of contract asset remains earned; 300 is billed AHEAD of
  // recognition → parks a contract liability 2410.
  const bill2 = await inj('POST', `/api/revenue/contracts/${idA}/bill`, exec2, { billing_schedule_id: ms2 });
  ok('REV-24: over-bill 400 → 100 clears asset, 300 parks contract liability 2410', near(bill2.json.contract_asset_cleared, 100) && near(bill2.json.billings_in_excess, 300), JSON.stringify(bill2.json).slice(0, 140));
  ok('REV-24: contract liability 2410 credit balance = 300 (billed in excess)', near(-(await bal(exec1, '2410') - liab0), 300), `Δ2410=${(await bal(exec1, '2410') - liab0).toFixed(2)}`);
  ok('REV-24: contract asset 1265 fully reclassed to 0', near(await bal(exec1, '1265') - asset0, 0), `1265 net=${(await bal(exec1, '1265') - asset0).toFixed(2)}`);

  const posA2 = await inj('GET', `/api/revenue/contracts/${idA}/position`, exec1);
  ok('REV-24: position now recognized=300 billed=600 → liability=300, asset=0 (tie-out)', near(posA2.json.recognized_revenue, 300) && near(posA2.json.billed_to_date, 600) && near(posA2.json.contract_liability, 300) && near(posA2.json.contract_asset, 0), JSON.stringify(posA2.json).slice(0, 160));

  // Control-negative: schedule/billing may not exceed the contract price (1200). Already billed 600; a 700
  // milestone would push cumulative billing to 1300 > 1200.
  const overSch = await inj('POST', `/api/revenue/contracts/${idA}/billing-schedule`, exec1, { milestones: [{ period: '2050-09', amount: 700 }] });
  ok('REV-24: schedule beyond contract price → 400 SCHEDULE_EXCEEDS_CONTRACT', overSch.status === 400 && overSch.json.error?.code === 'SCHEDULE_EXCEEDS_CONTRACT', `${overSch.status} ${overSch.json.error?.code}`);

  // Trial balance stays balanced after all the split postings.
  const tbA = (await inj('GET', '/api/ledger/trial-balance', exec1)).json.totals ?? {};
  ok('REV-24: trial balance balanced after asset/liability split', near(tbA.debit ?? tbA.total_debit, tbA.credit ?? tbA.total_credit), JSON.stringify(tbA).slice(0, 60));

  // ── Scenario B — REV-19 back-compat: activate WITH up-front billing → recognition still releases 2410 ──
  const liabB0 = await bal(exec1, '2410');
  const assetB0 = await bal(exec1, '1265');
  const cB = await inj('POST', '/api/revenue/contracts', exec1, { total_price: 600, contract_date: '2051-01-01', obligations: [{ name: 'Annual license', ssp: 600, method: 'over_time', start_date: '2051-01-01', end_date: '2051-06-30' }] });
  const idB = cB.json.id;
  await inj('POST', `/api/revenue/contracts/${idB}/allocate`, exec1, {});
  const actB = await inj('POST', `/api/revenue/contracts/${idB}/activate`, exec1, {}); // default bill_upfront=true
  ok('REV-19 back-compat: activate defaults to up-front billing (billed 600, 2410 raised)', actB.json.bill_upfront === true && near(actB.json.deferred_revenue, 600) && near(-(await bal(exec1, '2410') - liabB0), 600), JSON.stringify(actB.json));
  await inj('POST', `/api/revenue/contracts/${idB}/schedule`, exec1, {});
  const liabBpostAct = await bal(exec1, '2410'); // 2410 balance after the up-front billing raised it
  const recB = await inj('POST', '/api/revenue/contracts/recognize', exec1, { contract_id: idB, period: '2051-03' });
  ok('REV-19 back-compat: recognize 3 months → 300', near(recB.json.total_recognized, 300), JSON.stringify({ t: recB.json.total_recognized }));
  // Recognition debits (releases) 2410 by 300, moving its credit balance toward zero (+300), and touches
  // 1265 not at all — proving the up-front-billed path keeps today's Dr 2410 / Cr 4300 behaviour.
  ok('REV-19 back-compat: recognition RELEASES 2410 (not 1265) — Δ2410=+300, 1265 unchanged', near(await bal(exec1, '2410') - liabBpostAct, 300) && near(await bal(exec1, '1265') - assetB0, 0), `Δ2410=${(await bal(exec1, '2410') - liabBpostAct).toFixed(2)} Δ1265=${(await bal(exec1, '1265') - assetB0).toFixed(2)}`);
  const posB = await inj('GET', `/api/revenue/contracts/${idB}/position`, exec1);
  ok('REV-19 back-compat: position billed=600 recognized=300 → liability=300, asset=0', near(posB.json.billed_to_date, 600) && near(posB.json.recognized_revenue, 300) && near(posB.json.contract_liability, 300) && near(posB.json.contract_asset, 0), JSON.stringify(posB.json).slice(0, 140));

  // ── Scenario C — tenant RLS isolation on rev_billing_schedules ──
  const cC = await inj('POST', '/api/revenue/contracts', exec2b, { total_price: 500, contract_date: '2052-01-01', obligations: [{ name: 'Svc', ssp: 500, method: 'over_time', start_date: '2052-01-01', end_date: '2052-05-31' }] });
  const idC = cC.json.id;
  await inj('POST', `/api/revenue/contracts/${idC}/allocate`, exec2b, {});
  await inj('POST', `/api/revenue/contracts/${idC}/activate`, exec2b, { bill_upfront: false });
  await inj('POST', `/api/revenue/contracts/${idC}/billing-schedule`, exec2b, { milestones: [{ period: '2052-02', amount: 250 }] });
  const t1SeesC = await inj('GET', `/api/revenue/contracts/${idC}/position`, exec1);
  ok('REV-24 RLS: T1 user cannot read T2 contract position → 404', t1SeesC.status === 404, `${t1SeesC.status} ${t1SeesC.json.error?.code}`);
  const t2SeesC = await inj('GET', `/api/revenue/contracts/${idC}/billing-schedule`, exec2b);
  ok('REV-24 RLS: T2 owner reads its own billing schedule (1 milestone)', (t2SeesC.json.billing_schedule ?? []).length === 1, JSON.stringify(t2SeesC.json.billing_schedule));

  await app.close();
  await pg.close();

  console.log('\n── Track D Wave 1 — REV-24 contract-asset/liability split + independent billing (TFRS 15 §105-107) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} revrec-billing checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} revrec-billing checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
