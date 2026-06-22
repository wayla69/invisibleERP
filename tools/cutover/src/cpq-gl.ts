/**
 * Phase 20 — CPQ quote-to-cash → GL. Accept a quote → book AR + revenue. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover cpq-gl
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cpqgl-secret';
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

  // ── 1. config base 50000 → quote qty 1 = 50000 ──
  const cfg = await inj('POST', '/api/cpq/configs', admin, { code: 'LAPTOP', name: 'Laptop', base_price: 50000 });
  const q = await inj('POST', '/api/cpq/quotes', admin, { customer_name: 'Corp Buyer', config_id: cfg.json.id, qty: 1 });
  ok('Create quote → total 50000', near(q.json.total, 50000), JSON.stringify({ t: q.json.total }));

  // ── 2. send → accept → GL posted ──
  await inj('POST', `/api/cpq/quotes/${q.json.id}/send`, admin);
  const acc = await inj('POST', `/api/cpq/quotes/${q.json.id}/accept`, admin);
  ok('Accept quote → AR posted 50000, GL JE', near(acc.json.ar_posted, 50000) && /^JE-/.test(acc.json.entry_no ?? ''), JSON.stringify({ ar: acc.json.ar_posted, e: acc.json.entry_no }));

  // ── 3. GL: 1100 AR dr 50000, 4000 revenue cr 50000, TB balanced ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const row = (c: string) => (tb.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('CPQ GL: 1100 AR dr 50000, 4000 revenue cr 50000, TB balanced',
    tb.json.totals?.balanced === true && near(row('1100')?.debit, 50000) && near(row('4000')?.credit, 50000),
    JSON.stringify({ bal: tb.json.totals?.balanced, ar: row('1100')?.debit, rev: row('4000')?.credit }));

  console.log('\n── Phase 20 — CPQ quote-to-cash → GL (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} cpq-gl checks failed` : `\n✅ All ${checks.length} cpq-gl checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
