/**
 * Phase B — opening balances cutover. POST /api/ledger/opening-balances → ONE balanced JE,
 * equity-balanced to 3000, idempotent on batch_ref. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover opening-balances
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ob-secret';
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

  // ── 1. post opening balances (assets 8000 dr, AP 2000 cr) → equity 6000 cr; balanced JE ──
  const ob = await inj('POST', '/api/ledger/opening-balances', admin, { batch_ref: 'OB-2026', rows: [
    { account_code: '1000', debit: 5000 }, { account_code: '1200', debit: 3000 }, { account_code: '2000', credit: 2000 },
  ] });
  ok('Opening balances → balanced JE posted (4 legs incl 3000 equity)', /^JE-/.test(ob.json.entry_no ?? '') && ob.json.balanced === true && ob.json.lines_posted === 4, JSON.stringify({ e: ob.json.entry_no, n: ob.json.lines_posted }));

  // ── 2. trial balance balanced; 3000 equity = 6000 credit ──
  const tb = await inj('GET', '/api/ledger/trial-balance', admin);
  const eq3000 = (tb.json.rows ?? []).find((r: any) => r.account_code === '3000');
  ok('Trial balance balanced; 3000 Opening-Balance Equity = 6000 cr', tb.json.totals?.balanced === true && near(eq3000?.credit, 6000), `bal=${tb.json.totals?.balanced} 3000cr=${eq3000?.credit}`);

  // ── 3. idempotent on batch_ref ──
  const ob2 = await inj('POST', '/api/ledger/opening-balances', admin, { batch_ref: 'OB-2026', rows: [{ account_code: '1000', debit: 999 }] });
  ok('Re-post same batch_ref → already (idempotent)', ob2.json.already === true, JSON.stringify(ob2.json).slice(0, 50));

  // ── 4. already-balanced input (no equity leg needed) ──
  const ob3 = await inj('POST', '/api/ledger/opening-balances', admin, { batch_ref: 'OB-B', rows: [{ account_code: '1000', debit: 1000 }, { account_code: '4000', credit: 1000 }] });
  ok('Balanced input → JE posts with exactly the given legs (no equity)', ob3.json.balanced === true && ob3.json.lines_posted === 2, JSON.stringify({ n: ob3.json.lines_posted }));

  // ── 5. invalid rows reported, valid ones still post ──
  const ob4 = await inj('POST', '/api/ledger/opening-balances', admin, { batch_ref: 'OB-C', rows: [
    { account_code: '1000', debit: 500 }, { account_code: '', debit: 100 }, { account_code: '1200' },
  ] });
  ok('Invalid rows reported (2 errors), valid leg posts + equity balances', ob4.json.entry_no && (ob4.json.row_errors?.length === 2), JSON.stringify({ e: ob4.json.entry_no, err: ob4.json.row_errors?.length }));

  console.log('\n── Phase B — opening balances (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} opening-balance checks failed` : `\n✅ All ${checks.length} opening-balance checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
