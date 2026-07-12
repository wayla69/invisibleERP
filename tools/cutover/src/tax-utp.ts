/**
 * TAX-12 — DTA valuation allowance (ASC 740-10-30 MLTN) + Uncertain Tax Positions (FIN 48) register, PGlite.
 *   • Valuation allowance: allowance = max(0, gross DTA − MLTN-recoverable); maker-checker run→post posts the
 *     delta to 5950/1700 (self-post blocked; a distinct approver posts a balanced entry).
 *   • Uncertain tax positions: memo register with maker-checker create→settle (creator ≠ settler); tenant RLS.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tax-utp
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'utp-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'CO2', name: 'Company 2' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  const t2 = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'CO2')))[0].id);
  // Non-Admin, tenant-scoped finance users (Admin would bypass RLS in single-company mode). gl_close + gl_post.
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'taxrun', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: hq }, // gl_close (maker)
    { username: 'taxchk', passwordHash: await pw.hash('pw'), role: 'GlAccountant', tenantId: hq },        // gl_post  (checker)
    { username: 'taxb', passwordHash: await pw.hash('pw'), role: 'FinancialController', tenantId: t2 },    // tenant CO2
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
  const login = async (u: string, p = 'pw') => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const taxrun = await login('taxrun');
  const taxchk = await login('taxchk');
  const taxb = await login('taxb');
  const leg = (j: any, c: string, side: string) => (j?.lines ?? []).filter((l: any) => l.account_code === c).reduce((a: number, l: any) => a + Number(l[side]), 0);
  const vaEntry = async (ref2: string) => (await inj('GET', '/api/ledger/journal?limit=50', admin)).json.entries.find((e: any) => e.source === 'DTAVA' && e.source_ref === ref2);

  const accJson = JSON.stringify((await inj('GET', '/api/ledger/accounts', admin)).json);
  ok('COA seeded with 1700 DTA + 5950 deferred tax expense', accJson.includes('1700') && accJson.includes('5950'));

  // ───────────────────── DTA valuation allowance ─────────────────────
  // 1. run with explicit gross DTA 1000 vs MLTN-recoverable 600 → allowance 400 (Open, delta 400)
  const r1 = await inj('POST', '/api/tax/valuation-allowance/run', taxrun, { period: '2032-02', dta_gross: 1000, mltn_recoverable: 600, basis: 'insufficient future taxable income' });
  ok('VA run: allowance = max(0, 1000 − 600) = 400, delta 400, Open', r1.status === 200 && near(r1.json.allowance, 400) && near(r1.json.delta_posted, 400) && r1.json.status === 'Open', `${r1.status} ${JSON.stringify(r1.json).slice(0, 120)}`);
  const vaId = r1.json.id;

  // 2. maker cannot self-post (SoD)
  const selfPost = await inj('POST', `/api/tax/valuation-allowance/${vaId}/post`, taxrun);
  ok('VA self-post blocked → 403 SELF_POST', selfPost.status === 403 && selfPost.json.error?.code === 'SELF_POST', `${selfPost.status} ${selfPost.json.error?.code}`);

  // 3. a distinct approver posts the delta → Dr 5950 / Cr 1700 = 400 (balanced)
  const post1 = await inj('POST', `/api/tax/valuation-allowance/${vaId}/post`, taxchk);
  ok('VA posted by distinct approver → Posted, delta 400', post1.status === 200 && post1.json.status === 'Posted' && near(post1.json.delta_posted, 400) && /^JE-/.test(post1.json.entry_no ?? ''), `${post1.status} ${JSON.stringify(post1.json).slice(0, 120)}`);
  const je = await vaEntry(`VA-${vaId}`);
  ok('VA GL: Dr 5950 = 400 / Cr 1700 = 400 (allowance charge)', near(leg(je, '5950', 'debit'), 400) && near(leg(je, '1700', 'credit'), 400), JSON.stringify(je?.lines));

  // 4. re-post is rejected
  const rePost = await inj('POST', `/api/tax/valuation-allowance/${vaId}/post`, taxchk);
  ok('VA re-post → 400 ALREADY_POSTED', rePost.status === 400 && rePost.json.error?.code === 'ALREADY_POSTED', `${rePost.status} ${rePost.json.error?.code}`);

  // 5. gross DTA sourced from the deferred-tax engine (TAX-06) when not supplied
  await db.insert(s.deferredTaxRuns).values({ tenantId: hq, period: '2032-01', asOfDate: '2032-01-31', taxRate: '0.20', dta: '500', dtl: '0', netDeferred: '500', deltaPosted: '500', status: 'Posted', runBy: 'seed' });
  const r2 = await inj('POST', '/api/tax/valuation-allowance/run', taxrun, { period: '2032-03', mltn_recoverable: 200 });
  ok('VA run sources gross DTA 500 from deferred_tax_runs → allowance 300', r2.status === 200 && near(r2.json.dta_gross, 500) && near(r2.json.allowance, 300), `${r2.status} ${JSON.stringify(r2.json).slice(0, 120)}`);

  const tb = (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals ?? {};
  ok('Trial balance balanced after VA post', near(tb.debit ?? tb.total_debit, tb.credit ?? tb.total_credit), JSON.stringify(tb).slice(0, 60));

  const vaList = await inj('GET', '/api/tax/valuation-allowance', taxrun);
  ok('VA list returns both periods (one Posted, one Open)', (vaList.json.allowances ?? []).length === 2, `count ${(vaList.json.allowances ?? []).length}`);

  // ───────────────────── Uncertain Tax Positions (FIN 48) ─────────────────────
  // 6. create a position: gross 100000, recognized 60000 → reserve 40000, Open, UTP-…
  const u1 = await inj('POST', '/api/tax/utp', taxrun, { tax_year: 2031, description: 'Transfer-pricing adjustment risk', gross_exposure: 100000, recognized_benefit: 60000, interest_penalty: 2500 });
  ok('UTP create: reserve = 100000 − 60000 = 40000, Open, UTP-…', (u1.status === 200 || u1.status === 201) && near(u1.json.reserve, 40000) && u1.json.status === 'Open' && /^UTP-/.test(u1.json.position_no ?? ''), `${u1.status} ${JSON.stringify(u1.json).slice(0, 140)}`);
  const utpId = u1.json.id;

  // 7. recognized > gross rejected
  const badU = await inj('POST', '/api/tax/utp', taxrun, { tax_year: 2031, description: 'bad', gross_exposure: 100, recognized_benefit: 200 });
  ok('UTP create: recognized > gross → 400 BENEFIT_EXCEEDS_EXPOSURE', badU.status === 400 && badU.json.error?.code === 'BENEFIT_EXCEEDS_EXPOSURE', `${badU.status} ${badU.json.error?.code}`);

  // 8. creator cannot self-settle (SoD)
  const selfSettle = await inj('POST', `/api/tax/utp/${utpId}/settle`, taxrun, { status: 'Settled', settlement_amount: 30000 });
  ok('UTP self-settle blocked → 403 SELF_SETTLE', selfSettle.status === 403 && selfSettle.json.error?.code === 'SELF_SETTLE', `${selfSettle.status} ${selfSettle.json.error?.code}`);

  // 9. a distinct user settles
  const settle = await inj('POST', `/api/tax/utp/${utpId}/settle`, taxchk, { status: 'Settled', settlement_amount: 30000, settlement_note: 'agreed with RD' });
  ok('UTP settled by distinct user → Settled', settle.status === 200 && settle.json.status === 'Settled' && settle.json.settled_by === 'taxchk', `${settle.status} ${JSON.stringify(settle.json).slice(0, 100)}`);

  // 10. already-settled cannot re-settle
  const reSettle = await inj('POST', `/api/tax/utp/${utpId}/settle`, taxchk, { status: 'Lapsed' });
  ok('UTP re-settle → 400 NOT_OPEN', reSettle.status === 400 && reSettle.json.error?.code === 'NOT_OPEN', `${reSettle.status} ${reSettle.json.error?.code}`);

  // 11. register totals: open reserve excludes the now-settled position
  const uList = await inj('GET', '/api/tax/utp', taxrun);
  ok('UTP list totals: gross 100000, recognized 60000, open reserve 0 (settled excluded)', near(uList.json.totals?.gross_exposure, 100000) && near(uList.json.totals?.recognized_benefit, 60000) && near(uList.json.totals?.reserve, 0), JSON.stringify(uList.json.totals));

  // 12. tenant RLS: CO2 creates a position; neither tenant sees the other's rows
  const u2 = await inj('POST', '/api/tax/utp', taxb, { tax_year: 2031, description: 'CO2 position', gross_exposure: 5000 });
  ok('UTP create under CO2 tenant', (u2.status === 200 || u2.status === 201) && /^UTP-/.test(u2.json.position_no ?? ''), `${u2.status}`);
  const hqList = await inj('GET', '/api/tax/utp', taxrun);
  const co2List = await inj('GET', '/api/tax/utp', taxb);
  const hqSeesCo2 = (hqList.json.positions ?? []).some((p: any) => p.description === 'CO2 position');
  const co2SeesHq = (co2List.json.positions ?? []).some((p: any) => p.description === 'Transfer-pricing adjustment risk');
  ok('Tenant RLS: HQ does not see CO2 position, CO2 does not see HQ position', !hqSeesCo2 && !co2SeesHq && (co2List.json.positions ?? []).length === 1, `hqSeesCo2=${hqSeesCo2} co2SeesHq=${co2SeesHq} co2Count=${(co2List.json.positions ?? []).length}`);

  await app.close();
  await pg.close();

  console.log('\n── TAX-12 — DTA valuation allowance + Uncertain Tax Positions (FIN 48) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} tax-utp checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} tax-utp checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
