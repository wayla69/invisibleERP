/**
 * Cutover check — TAX-11 current income-tax provision + ETR reconciliation (ASC 740 / IAS 12, current side).
 * run() bridges pretax book income (income statement) → permanent + temporary (REUSED from the deferred-tax
 * run, TAX-06) book-to-tax adjustments → taxable income → current CIT @ statutory rate; the ETR schedule
 * reconciles statutory → effective. Maker-checker: the runner may not post their own provision
 * (403 SOD_SELF_APPROVAL); a distinct approver posts the balanced JE Dr 5960 / Cr 2110. RLS: a sibling tenant
 * never sees the provision.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tax-provision
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
import { DeferredTaxService } from '../../../apps/api/dist/modules/ledger/deferred-tax.service';
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
    { username: 'accountant', passwordHash: await pw.hash('pw1'), role: 'Admin', tenantId: hq.id },
    { username: 'controller', passwordHash: await pw.hash('pw2'), role: 'Admin', tenantId: hq.id },
    { username: 'admin2', passwordHash: await pw.hash('pw3'), role: 'Admin', tenantId: hq2.id },
  ]).onConflictDoNothing();
  // A fixed asset with book NBV > (assumed) tax NBV — accelerated depreciation → a taxable temp diff (DTL).
  // cost 1,000,000, accum dep 200,000, NBV 800,000, no tax book ⇒ deferred-tax factor 1.5 → tax accum 300,000
  // → tax NBV 700,000 → depDiff 100,000 ⇒ DTL 20,000 @ 20%; net deferred −20,000; period delta −20,000.
  await db.insert(s.fixedAssets).values([{
    tenantId: hq.id, assetNo: 'FA-CIT-1', name: 'Machine', acquireDate: '2024-01-01', acquireCost: '1000000',
    salvageValue: '0', usefulLifeMonths: 60, accumulatedDepreciation: '200000', netBookValue: '800000', status: 'active',
  }]).onConflictDoNothing();
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

  // GL net (debit − credit) on an account for the CIT provision source, tenant HQ.
  const glNet = async (account: string) => {
    const rows = await db.select({ d: s.journalLines.debit, c: s.journalLines.credit })
      .from(s.journalLines).innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
      .where(and(eq(s.journalLines.accountCode, account), eq(s.journalLines.tenantId, hq), eq(s.journalEntries.source, 'CITPROV'), eq(s.journalEntries.status, 'Posted')));
    return rows.reduce((a: number, r: any) => a + Number(r.d) - Number(r.c), 0);
  };

  const accountant = await login('accountant', 'pw1');
  const controller = await login('controller', 'pw2');
  const admin2 = await login('admin2', 'pw3');
  ok('logins', !!accountant && !!controller && !!admin2);

  // ── Seed book income for FY2026 (revenue 1,000,000 − opex 400,000 = pretax 600,000), posted to tenant HQ.
  await ledger.postEntry({ date: '2026-06-30', source: 'SEED', tenantId: hq, currency: 'THB', memo: 'sales', createdBy: 'accountant', lines: [{ account_code: '1000', debit: 1000000 }, { account_code: '4000', credit: 1000000 }] });
  await ledger.postEntry({ date: '2026-06-30', source: 'SEED', tenantId: hq, currency: 'THB', memo: 'opex', createdBy: 'accountant', lines: [{ account_code: '5100', debit: 400000 }, { account_code: '1000', credit: 400000 }] });

  // ── Deferred tax (TAX-06) for the period → provides the temporary book-to-tax adjustment we REUSE.
  const dtSvc = app.get(DeferredTaxService);
  const dtRun = await dtSvc.runDeferredTax({ period: '2026-12', taxRate: 0.20, runBy: 'accountant', tenantId: hq });
  ok('deferred-tax run: DTL 20,000, net −20,000, delta −20,000', near(dtRun.dtl, 20000) && near(dtRun.net_deferred, -20000) && near(dtRun.delta_posted, -20000), JSON.stringify({ dtl: dtRun.dtl, net: dtRun.net_deferred, delta: dtRun.delta_posted }));
  await dtSvc.postDeferredTax({ id: dtRun.id, postedBy: 'controller' }, { username: 'controller' } as any);

  // ── Run the current provision. permanent add-back 50,000 (non-deductible); temp adj = delta/rate = −100,000.
  const run = await inj('POST', '/api/tax/provision/run', accountant, { period: '2026-12', from: '2026-01-01', to: '2026-12-31', fiscal_year: 2026, statutory_rate: 0.20, permanent_diffs: [{ name: 'Non-deductible entertainment', amount: 50000 }] });
  ok('run → 200 Open', run.status === 200 && run.json.status === 'Open', `status=${run.status} st=${run.json?.status}`);
  const id = run.json.id;
  ok('pretax book income = 600,000 (from income statement)', near(run.json.pretax_book_income, 600000), `pretax=${run.json?.pretax_book_income}`);
  ok('permanent adj total = 50,000', near(run.json.permanent_adj_total, 50000), `perm=${run.json?.permanent_adj_total}`);
  ok('temporary adj = −100,000 (reused from deferred-tax delta / rate)', near(run.json.temporary_adj_total, -100000), `temp=${run.json?.temporary_adj_total}`);
  ok('taxable income = 550,000 (600,000 + 50,000 − 100,000)', near(run.json.taxable_income, 550000), `taxable=${run.json?.taxable_income}`);
  ok('current CIT = 110,000 (550,000 × 20%)', near(run.json.current_tax, 110000), `cit=${run.json?.current_tax}`);
  ok('deferred-tax link carries deferred expense +20,000 (a charge)', run.json.deferred_tax_link && near(run.json.deferred_tax_link.deferred_tax_expense, 20000), JSON.stringify(run.json?.deferred_tax_link));
  ok('total income-tax expense = 130,000 (current 110,000 + deferred 20,000)', near(run.json.total_provision, 130000), `total=${run.json?.total_provision}`);
  ok('effective rate ≈ 21.67% (130,000 / 600,000)', near(run.json.effective_rate, 0.2166666667) || near(run.json.effective_rate, 0.2167), `etr=${run.json?.effective_rate}`);

  // ── ETR reconciliation schedule ties statutory → effective.
  const etr = await inj('GET', `/api/tax/provision/${id}/etr`, accountant);
  const byKey: Record<string, any> = {};
  for (const l of etr.json.lines ?? []) byKey[l.key] = l;
  ok('ETR statutory line = 120,000 (600,000 × 20%)', near(byKey.statutory?.tax_effect, 120000), JSON.stringify(byKey.statutory));
  ok('ETR permanent-difference line = 10,000 (50,000 × 20%)', near(byKey.permanent?.tax_effect, 10000), JSON.stringify(byKey.permanent));
  ok('ETR has rate-change + valuation-allowance + other lines', !!byKey.rate_change && !!byKey.valuation_allowance && !!byKey.other, Object.keys(byKey).join(','));
  ok('ETR effective line = total provision 130,000', near(byKey.effective?.tax_effect, 130000), JSON.stringify(byKey.effective));
  const etrSum = ['statutory', 'permanent', 'rate_change', 'valuation_allowance', 'other'].reduce((a, k) => a + Number(byKey[k]?.tax_effect ?? 0), 0);
  ok('ETR reconciles (Σ statutory→other = effective 130,000)', near(etrSum, 130000), `sum=${etrSum}`);

  // ── Maker-checker: the runner cannot post their own provision.
  const selfPost = await inj('POST', `/api/tax/provision/${id}/post`, accountant);
  ok('self-post → 403 SOD_SELF_APPROVAL', selfPost.status === 403 && selfPost.json?.error?.code === 'SOD_SELF_APPROVAL', `status=${selfPost.status} code=${selfPost.json?.error?.code}`);

  // ── A distinct approver posts → Dr 5960 / Cr 2110, balanced.
  const posted = await inj('POST', `/api/tax/provision/${id}/post`, controller);
  ok('distinct approver posts → 200 Posted + entry_no', posted.status === 200 && posted.json.status === 'Posted' && !!posted.json.posted_entry_id, `status=${posted.status} st=${posted.json?.status} je=${posted.json?.posted_entry_id}`);
  ok('provision JE Dr 5960 current CIT expense = 110,000', near(await glNet('5960'), 110000), `5960 net=${await glNet('5960')}`);
  ok('provision JE Cr 2110 CIT payable = −110,000', near(await glNet('2110'), -110000), `2110 net=${await glNet('2110')}`);
  ok('provision JE balanced (Dr 5960 = −Cr 2110)', near((await glNet('5960')) + (await glNet('2110')), 0));

  // ── Re-post a Posted provision → ALREADY_POSTED.
  const rePost = await inj('POST', `/api/tax/provision/${id}/post`, controller);
  ok('re-post a Posted provision → 400 ALREADY_POSTED', rePost.status === 400 && rePost.json?.error?.code === 'ALREADY_POSTED', `status=${rePost.status} code=${rePost.json?.error?.code}`);

  // ── RLS / tenant isolation: the sibling tenant (HQ2) never sees HQ's provision.
  const hq2List = await inj('GET', '/api/tax/provision', admin2);
  ok('sibling tenant HQ2 sees 0 provisions (isolation)', hq2List.status === 200 && hq2List.json.count === 0, `count=${hq2List.json?.count}`);
  const hqList = await inj('GET', '/api/tax/provision', accountant);
  ok('tenant HQ sees its 1 provision', hqList.status === 200 && hqList.json.count === 1 && hqList.json.provisions?.[0]?.id === id, `count=${hqList.json?.count}`);

  await app.close();
  await pg.close();

  console.log('\n── TAX-11 current income-tax provision + ETR reconciliation (PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
