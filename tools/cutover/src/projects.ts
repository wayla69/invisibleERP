/**
 * Cutover check — Phase 18 Project Accounting / PSA: projects, tasks, timesheets, expenses,
 * milestones, T&M + milestone billing → AR, project P&L.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover projects
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-secret';
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
import { PERMISSIONS, PERM_GROUPS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const grpOf = (k: string) => Object.entries(PERM_GROUPS).find(([, ks]) => (ks as string[]).includes(k))?.[0] ?? null;
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, c: boolean, d = '') => checks.push({ name, ok: c, detail: d });

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();
  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k, grp: grpOf(k) }))).onConflictDoNothing();
  for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((perms as string[]).map((perm) => ({ role: role as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }]).onConflictDoNothing();
  const hq = (await db.select().from(s.tenants).where(eq(s.tenants.code, 'HQ')))[0];
  await db.insert(s.users).values({ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq.id }).onConflictDoNothing();
  await db.insert(s.employees).values({ tenantId: hq.id, empCode: 'E1', name: 'Consultant', nationalId: '0000000000000' }).onConflictDoNothing?.();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const token = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token;
  ok('login', !!token);

  // create project (T&M, bill 1000/h, cost budget 50000)
  const proj = await inj('POST', '/api/projects', token, { name: 'Implementation', customer_name: 'ACME', billing_type: 'TM', default_bill_rate: 1000, cost_budget: 50000 });
  ok('create project → PRJ-', (proj.status === 200 || proj.status === 201) && /^PRJ-\d{8}-\d{3}$/.test(proj.json.code), `code=${proj.json.code}`);
  const pid = proj.json.id;
  ok('project listed', (await inj('GET', '/api/projects', token)).json.projects?.some((p: any) => p.id === pid));
  ok('create task', !!(await inj('POST', '/api/projects/tasks', token, { project_id: pid, name: 'Build', planned_hours: 40 })).json.id);

  // timesheets: billable 10h (default rate) cost 400/h → amount 10000, cost 4000; non-billable 2h cost 800
  const ts1 = await inj('POST', '/api/projects/timesheets', token, { project_id: pid, emp_code: 'E1', hours: 10, cost_rate: 400 });
  ok('billable timesheet amount/cost', ts1.json.amount === 10000 && ts1.json.cost === 4000, `amt=${ts1.json.amount} cost=${ts1.json.cost}`);
  await inj('POST', '/api/projects/timesheets', token, { project_id: pid, emp_code: 'E1', hours: 2, cost_rate: 400, billable: false });
  // expense 1000 billable +10% markup → bill value 1100
  await inj('POST', '/api/projects/expenses', token, { project_id: pid, description: 'Travel', amount: 1000, markup_pct: 10 });

  // T&M billing → AR invoice 10000 + 1100 = 11100
  const bill = await inj('POST', `/api/projects/${pid}/bill-tm`, token);
  ok('bill T&M → PINV- invoice 11100', /^PINV-\d{8}-\d{3}$/.test(bill.json.invoice_no) && bill.json.amount === 11100 && bill.json.timesheets_billed === 1 && bill.json.expenses_billed === 1, `amt=${bill.json.amount}`);
  ok('re-bill T&M → NOTHING_TO_BILL 400', (await inj('POST', `/api/projects/${pid}/bill-tm`, token)).status === 400);

  // milestone bill
  const ms = await inj('POST', '/api/projects/milestones', token, { project_id: pid, name: 'Go-live', amount: 20000 });
  const mbill = await inj('POST', `/api/projects/milestones/${ms.json.id}/bill`, token);
  ok('bill milestone → AR 20000', mbill.json.amount === 20000 && /^PINV-/.test(mbill.json.invoice_no));
  ok('re-bill milestone → ALREADY_BILLED 400', (await inj('POST', `/api/projects/milestones/${ms.json.id}/bill`, token)).status === 400);

  // P&L summary
  const sum = await inj('GET', `/api/projects/${pid}/summary`, token);
  ok('P&L: actual_cost 5800 (labor 4800 + exp 1000)', sum.json.actual_cost === 5800, `cost=${sum.json.actual_cost}`);
  ok('P&L: billed 31100 (T&M 11100 + milestone 20000)', sum.json.billed === 31100, `billed=${sum.json.billed}`);
  ok('P&L: margin 25300', sum.json.margin === 25300, `margin=${sum.json.margin}`);
  ok('P&L: hours 12, cost_used 11.6%', sum.json.hours === 12 && sum.json.cost_used_pct === 11.6, `h=${sum.json.hours} %=${sum.json.cost_used_pct}`);
  ok('P&L: 2 AR invoices linked to project', sum.json.invoices?.length === 2);

  await app.close();
  await pg.close();
  console.log('\n── Phase 18 Project Accounting / PSA ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
