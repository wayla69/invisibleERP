/**
 * Accounting Tier 3 — Cost centers / dimensions (ศูนย์ต้นทุน) over PGlite:
 * tag journal lines with a cost center, dimensional income statement / trial balance, per-center P&L.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover costcenter
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cc-secret';
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
    { username: 'approver', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }, // GL-05 maker-checker approver
    { username: 'sales1', passwordHash: await pw.hash('pw1'), role: 'Sales', tenantId: t1 },
    { username: 'sales2', passwordHash: await pw.hash('pw2'), role: 'Sales', tenantId: t2 },
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
  const [admin, sales1, sales2] = [await login('admin', 'admin123'), await login('sales1', 'pw1'), await login('sales2', 'pw2')];
  const approver = await login('approver', 'admin123');
  // GL-05 maker-checker: a manual JE posts as Draft; a DIFFERENT user must approve it to affect balances.
  const postJE = async (preparer: string, payload: any) => {
    const r = await inj('POST', '/api/ledger/journal', preparer, payload);
    if (r.json?.entry_no && r.json?.pending) await inj('POST', `/api/ledger/journal/${r.json.entry_no}/approve`, preparer === approver ? admin : approver, {});
    return r;
  };

  // create 2 cost centers
  const ccA = await inj('POST', '/api/ledger/cost-centers', admin, { code: 'CC-A', name: 'สาขา A', type: 'branch' });
  await inj('POST', '/api/ledger/cost-centers', admin, { code: 'CC-B', name: 'สาขา B', type: 'branch' });
  ok('Cost centers created (CC-A, CC-B)', ccA.json.code === 'CC-A' && (await inj('GET', '/api/ledger/cost-centers', admin)).json.count >= 2, `${ccA.status}`);

  // post journals tagged per center + 1 untagged. Window 2029-01.
  const J = (date: string, lines: any[]) => postJE(admin, { date, source: 'Manual', lines });
  await J('2029-01-05', [{ account_code: '1000', debit: 1000, cost_center: 'CC-A' }, { account_code: '4000', credit: 1000, cost_center: 'CC-A' }]); // A revenue 1000
  await J('2029-01-06', [{ account_code: '5100', debit: 300, cost_center: 'CC-A' }, { account_code: '1000', credit: 300, cost_center: 'CC-A' }]); // A expense 300
  await J('2029-01-07', [{ account_code: '1000', debit: 500, cost_center: 'CC-B' }, { account_code: '4000', credit: 500, cost_center: 'CC-B' }]); // B revenue 500
  await J('2029-01-08', [{ account_code: '5100', debit: 200, cost_center: 'CC-B' }, { account_code: '1000', credit: 200, cost_center: 'CC-B' }]); // B expense 200
  await J('2029-01-09', [{ account_code: '1000', debit: 100, cost_center: undefined }, { account_code: '4000', credit: 100 }]); // untagged revenue 100

  const win = 'from=2029-01-01&to=2029-01-31';
  const isA = await inj('GET', `/api/ledger/income-statement?cost_center=CC-A&${win}`, admin);
  ok('P&L cost_center=CC-A: revenue 1000, expense 300, net 700', near(isA.json.revenue, 1000) && near(isA.json.expense, 300) && near(isA.json.net_income, 700), JSON.stringify({ r: isA.json.revenue, e: isA.json.expense, n: isA.json.net_income }));
  const isB = await inj('GET', `/api/ledger/income-statement?cost_center=CC-B&${win}`, admin);
  ok('P&L cost_center=CC-B: net 300', near(isB.json.net_income, 300), `net=${isB.json.net_income}`);
  const isAll = await inj('GET', `/api/ledger/income-statement?${win}`, admin);
  ok('P&L all centers: revenue 1600, expense 500, net 1100', near(isAll.json.revenue, 1600) && near(isAll.json.net_income, 1100), JSON.stringify({ r: isAll.json.revenue, n: isAll.json.net_income }));
  ok('Σ over centers + unassigned == total (700+300+100 = 1100)', near(isA.json.net_income + isB.json.net_income + 100, isAll.json.net_income));
  const isU = await inj('GET', `/api/ledger/income-statement?cost_center=__UNASSIGNED__&${win}`, admin);
  ok('P&L unassigned: revenue 100, net 100', near(isU.json.net_income, 100), `net=${isU.json.net_income}`);
  const plA = await inj('GET', `/api/ledger/cost-centers/CC-A/pl?${win}`, admin);
  ok('Per-center P&L route /cost-centers/CC-A/pl: net 700', near(plA.json.net_income, 700), `net=${plA.json.net_income}`);
  const tbA = await inj('GET', '/api/ledger/trial-balance?cost_center=CC-A', admin);
  ok('Trial balance cost_center=CC-A: balanced + only A accounts (1000/4000/5100)', tbA.json.totals?.balanced === true && (tbA.json.rows ?? []).every((r: any) => ['1000', '4000', '5100'].includes(r.account_code)), JSON.stringify(tbA.json.totals));

  // RLS: cost centers tenant-scoped
  await inj('POST', '/api/ledger/cost-centers', sales1, { code: 'T1-CC', name: 'T1 dept' });
  await inj('POST', '/api/ledger/cost-centers', sales2, { code: 'T2-CC', name: 'T2 dept' });
  const l1 = await inj('GET', '/api/ledger/cost-centers', sales1);
  ok('RLS: T1 sees its cost center, not T2', (l1.json.cost_centers ?? []).some((c: any) => c.code === 'T1-CC') && !(l1.json.cost_centers ?? []).some((c: any) => c.code === 'T2-CC'), JSON.stringify((l1.json.cost_centers ?? []).map((c: any) => c.code)));
  // un-tagged dimension is backward compatible — global P&L unaffected (existing harnesses prove this)
  ok('Cost center is a pure tag (no extra GL): trial balance still balances', (await inj('GET', '/api/ledger/trial-balance', admin)).json.totals?.balanced === true);

  await app.close();
  await pg.close();

  console.log('\n── Accounting Tier 3 — Cost centers / dimensions (ศูนย์ต้นทุน) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} cost-center checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} cost-center checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
