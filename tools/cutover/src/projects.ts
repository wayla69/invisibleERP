/**
 * Phase 18 — Projects/PPM. Create a project → log costs (→ project WIP) → bill the customer
 * (→ revenue + relieve WIP to cost of services), with balanced GL at every step. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover projects
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'prj-secret';
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
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = Number((await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0].id);
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;

  // ── 1. create project (T&M) ──
  const cr = await inj('POST', '/api/projects', admin, { project_code: 'PRJ-A', name: 'ระบบ ERP ลูกค้า', customer_name: 'ACME', billing_type: 'TM', contract_amount: 10000 });
  ok('Create project → status Open', cr.status < 300 && cr.json.project_code === 'PRJ-A' && cr.json.status === 'Open', JSON.stringify({ s: cr.status }));

  // ── 2. log costs: time 5000 + expense 2000 → cost_to_date 7000 ──
  await inj('POST', '/api/projects/PRJ-A/cost', admin, { entry_type: 'time', description: 'งานพัฒนา', amount: 5000 });
  const c2 = await inj('POST', '/api/projects/PRJ-A/cost', admin, { entry_type: 'expense', description: 'ค่าเดินทาง', amount: 2000 });
  ok('Log 2 costs → cost_to_date 7000', near(c2.json.cost_to_date, 7000), JSON.stringify({ c: c2.json.cost_to_date }));

  // ── 3. GL after costs: 1260 WIP dr 7000; 2390 applied cr 7000; TB balanced ──
  const tb1 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r1 = (c: string) => (tb1.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Cost GL: 1260 WIP dr 7000, 2390 applied cr 7000, TB balanced',
    tb1.json.totals?.balanced === true && near(r1('1260')?.debit, 7000) && near(r1('2390')?.credit, 7000),
    JSON.stringify({ bal: tb1.json.totals?.balanced, wip: r1('1260')?.debit }));

  // ── 4. bill 10000 → revenue 10000, relieve WIP 7000 to COGS, margin 3000 ──
  const bill = await inj('POST', '/api/projects/PRJ-A/bill', admin, { amount: 10000 });
  ok('Bill 10000 → revenue 10000, cost recognized 7000, margin 3000',
    near(bill.json.revenue, 10000) && near(bill.json.cost_recognized, 7000) && near(bill.json.margin, 3000), JSON.stringify({ m: bill.json.margin }));

  // ── 5. GL after bill: 1100 AR dr 10000; 4200 rev cr 10000; 5800 COGS dr 7000; 1260 WIP back to 0; TB balanced ──
  const tb2 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r2 = (c: string) => (tb2.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Bill GL: AR 10000, Revenue 10000, COGS 7000, WIP balance 0, TB balanced',
    tb2.json.totals?.balanced === true && near(r2('1100')?.debit, 10000) && near(r2('4200')?.credit, 10000) &&
    near(r2('5800')?.debit, 7000) && near(r2('1260')?.balance, 0),
    JSON.stringify({ bal: tb2.json.totals?.balanced, ar: r2('1100')?.debit, rev: r2('4200')?.credit, wip: r2('1260')?.balance }));

  // ── 6. project summary: wip 0, margin 3000 ──
  const get = await inj('GET', '/api/projects/PRJ-A', admin);
  ok('Project summary: wip 0, margin 3000, 2 entries', near(get.json.wip, 0) && near(get.json.margin, 3000) && get.json.entries?.length === 2, JSON.stringify({ w: get.json.wip, m: get.json.margin }));

  console.log('\n── Phase 18 — Projects/PPM (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} projects checks failed` : `\n✅ All ${checks.length} projects checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
