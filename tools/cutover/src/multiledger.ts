/**
 * Accounting Tier 3 batch 3 — Multi-ledger / Multi-GAAP (สมุดบัญชีหลายเล่ม / หลายมาตรฐาน) over PGlite:
 * parallel TFRS/TAX/IFRS books via journal_entries.ledger_code (NULL = shared), GAAP adjustments,
 * per-ledger trial-balance/P&L/balance-sheet, and the book-tax difference report (deferred-tax basis).
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover multiledger
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ml-secret';
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
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.get(LedgerService).seedChartOfAccounts();
  await app.get(LedgerService).seedLedgers();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string, p: string) => (await inj('POST', '/api/login', undefined, { username: u, password: p })).json.token as string;
  const admin = await login('admin', 'admin123');
  const sales2 = await login('sales2', 'pw2');
  const D = '2026-03-15', FROM = '2026-01-01', TO = '2026-12-31';

  // ── 1. ledgers seeded ──
  const lg = await inj('GET', '/api/ledger/ledgers', admin);
  const codes = (lg.json.ledgers ?? []).map((l: any) => l.code);
  const tfrs = (lg.json.ledgers ?? []).find((l: any) => l.code === 'TFRS');
  ok('Ledgers seeded: TFRS (leading) + TAX + IFRS', codes.includes('TFRS') && codes.includes('TAX') && codes.includes('IFRS') && tfrs?.is_leading === true && lg.json.leading === 'TFRS', JSON.stringify(codes));

  // ── 2. shared business entries (ledger_code NULL → every book) ──
  const rev = await inj('POST', '/api/ledger/journal', admin, { date: D, source: 'TEST', tenant_id: t1, memo: 'sale', lines: [{ account_code: '1000', debit: 10000 }, { account_code: '4000', credit: 10000 }] });
  const bookDep = await inj('POST', '/api/ledger/journal', admin, { date: D, source: 'TEST', tenant_id: t1, memo: 'book depreciation', lines: [{ account_code: '5200', debit: 1000 }, { account_code: '1590', credit: 1000 }] });
  ok('Shared entries post (ledger_code NULL)', /^JE-/.test(rev.json.entry_no ?? '') && /^JE-/.test(bookDep.json.entry_no ?? ''), `${rev.json.entry_no} ${bookDep.json.entry_no}`);

  // ── 3. TAX-only adjustment: accelerated tax depreciation +1000 ──
  const adj = await inj('POST', '/api/ledger/ledgers/TAX/adjustment', admin, { date: D, tenant_id: t1, memo: 'ค่าเสื่อมเร่งทางภาษี', lines: [{ account_code: '5200', debit: 1000 }, { account_code: '1590', credit: 1000 }] });
  const adjRow = (await pg.query(`SELECT ledger_code FROM journal_entries WHERE entry_no='${adj.json.entry_no}'`)).rows as any[];
  ok('TAX adjustment posts with ledger_code=TAX', /^JE-/.test(adj.json.entry_no ?? '') && adjRow[0]?.ledger_code === 'TAX', `${adj.json.entry_no} ${adjRow[0]?.ledger_code}`);

  // ── 4-7. per-ledger income statement ──
  const isTfrs = await inj('GET', `/api/ledger/income-statement?from=${FROM}&to=${TO}&ledger=TFRS`, admin);
  ok('IS TFRS: revenue 10000, expense 1000, net 9000', near(isTfrs.json.revenue, 10000) && near(isTfrs.json.expense, 1000) && near(isTfrs.json.net_income, 9000), JSON.stringify({ r: isTfrs.json.revenue, e: isTfrs.json.expense, n: isTfrs.json.net_income }));
  const isTax = await inj('GET', `/api/ledger/income-statement?from=${FROM}&to=${TO}&ledger=TAX`, admin);
  ok('IS TAX: expense 2000 (book 1000 + tax adj 1000), net 8000', near(isTax.json.expense, 2000) && near(isTax.json.net_income, 8000), JSON.stringify({ e: isTax.json.expense, n: isTax.json.net_income }));
  const isDefault = await inj('GET', `/api/ledger/income-statement?from=${FROM}&to=${TO}`, admin);
  ok('IS default (no ledger) == leading TFRS (net 9000)', near(isDefault.json.net_income, 9000) && isDefault.json.ledger === 'TFRS', `n=${isDefault.json.net_income} ${isDefault.json.ledger}`);
  const isIfrs = await inj('GET', `/api/ledger/income-statement?from=${FROM}&to=${TO}&ledger=IFRS`, admin);
  ok('IS IFRS (no IFRS adjustment) == shared (net 9000)', near(isIfrs.json.net_income, 9000), `n=${isIfrs.json.net_income}`);

  // ── 8-9. per-ledger trial balance ──
  const tbTfrs = await inj('GET', '/api/ledger/trial-balance?ledger=TFRS', admin);
  const dep5200T = (tbTfrs.json.rows ?? []).find((r: any) => r.account_code === '5200');
  ok('TB TFRS: 5200 debit 1000, balanced', near(dep5200T?.debit, 1000) && tbTfrs.json.totals?.balanced === true, `5200=${dep5200T?.debit} bal=${tbTfrs.json.totals?.balanced}`);
  const tbTax = await inj('GET', '/api/ledger/trial-balance?ledger=TAX', admin);
  const dep5200X = (tbTax.json.rows ?? []).find((r: any) => r.account_code === '5200');
  ok('TB TAX: 5200 debit 2000, balanced', near(dep5200X?.debit, 2000) && tbTax.json.totals?.balanced === true, `5200=${dep5200X?.debit} bal=${tbTax.json.totals?.balanced}`);

  // ── 10. book-tax difference report ──
  const cmp = await inj('GET', `/api/ledger/gaap-comparison?from=${FROM}&to=${TO}&base=TFRS&compare=TAX`, admin);
  const line5200 = (cmp.json.lines ?? []).find((l: any) => l.account_code === '5200');
  ok('GAAP comparison TFRS vs TAX: net 9000 vs 8000, diff -1000; 5200 base 1000 / compare 2000 / diff 1000', near(cmp.json.base_net_income, 9000) && near(cmp.json.compare_net_income, 8000) && near(cmp.json.difference, -1000) && near(line5200?.base, 1000) && near(line5200?.compare, 2000) && near(line5200?.difference, 1000), JSON.stringify({ b: cmp.json.base_net_income, c: cmp.json.compare_net_income, d: cmp.json.difference, l: line5200 }));
  // 4000 has no divergence → excluded from the difference lines
  ok('GAAP comparison omits non-diverging accounts (4000 not listed)', !(cmp.json.lines ?? []).some((l: any) => l.account_code === '4000'), JSON.stringify((cmp.json.lines ?? []).map((l: any) => l.account_code)));

  // ── 11-12. validation ──
  const badLedger = await inj('POST', '/api/ledger/ledgers/XYZ/adjustment', admin, { date: D, tenant_id: t1, lines: [{ account_code: '5200', debit: 100 }, { account_code: '1590', credit: 100 }] });
  ok('Adjustment to unknown ledger → 404 LEDGER_NOT_FOUND', badLedger.status === 404 && badLedger.json.error?.code === 'LEDGER_NOT_FOUND', `${badLedger.status} ${badLedger.json.error?.code}`);
  const unbal = await inj('POST', '/api/ledger/ledgers/TAX/adjustment', admin, { date: D, tenant_id: t1, lines: [{ account_code: '5200', debit: 100 }, { account_code: '1590', credit: 90 }] });
  ok('Unbalanced adjustment → 400 UNBALANCED', unbal.status === 400 && unbal.json.error?.code === 'UNBALANCED', `${unbal.status} ${unbal.json.error?.code}`);

  // ── 13. RLS: another tenant sees none of T1's books ──
  const isT2 = await inj('GET', `/api/ledger/income-statement?from=${FROM}&to=${TO}&ledger=TAX`, sales2);
  ok('RLS: T2 income statement sees 0 of T1 entries', near(isT2.json.revenue ?? 0, 0) && near(isT2.json.expense ?? 0, 0), JSON.stringify({ r: isT2.json.revenue, e: isT2.json.expense }));

  // ── 14-16. per-ledger year-end close (TAX before TFRS so the leading period-close doesn't block it) ──
  const closeTax = await inj('POST', '/api/ledger/close-year?fiscal_year=2026&ledger=TAX', admin);
  const closeTfrs = await inj('POST', '/api/ledger/close-year?fiscal_year=2026', admin);
  ok('Close-year per ledger: TAX net 8000, TFRS net 9000', near(closeTax.json.net_income, 8000) && closeTax.json.ledger === 'TAX' && near(closeTfrs.json.net_income, 9000) && closeTfrs.json.ledger === 'TFRS', JSON.stringify({ tax: closeTax.json.net_income, tfrs: closeTfrs.json.net_income }));
  const bsTfrs = await inj('GET', '/api/ledger/balance-sheet?as_of=2026-12-31&ledger=TFRS', admin);
  ok('Balance sheet TFRS: retained earnings 9000, balanced', near(bsTfrs.json.retained_earnings, 9000) && bsTfrs.json.balanced === true, `re=${bsTfrs.json.retained_earnings} bal=${bsTfrs.json.balanced}`);
  const bsTax = await inj('GET', '/api/ledger/balance-sheet?as_of=2026-12-31&ledger=TAX', admin);
  ok('Balance sheet TAX: retained earnings 8000, balanced', near(bsTax.json.retained_earnings, 8000) && bsTax.json.balanced === true, `re=${bsTax.json.retained_earnings} bal=${bsTax.json.balanced}`);

  console.log('\n── Accounting Tier 3 batch 3 — Multi-ledger / Multi-GAAP (สมุดบัญชีหลายเล่ม) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} multi-ledger checks failed` : `\n✅ All ${checks.length} multi-ledger checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
