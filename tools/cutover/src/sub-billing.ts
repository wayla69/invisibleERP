/**
 * Phase 20 — subscription recurring billing → GL. Create subscription → run billing (AR + revenue
 * on the books) → pay (cash) → idempotent. Over PGlite.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover sub-billing
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sub-secret';
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

  // ── 1. subscription 1000 × 2 = 2000/month, starts 2026-06-01 ──
  const sub = await inj('POST', '/api/service/subscriptions', admin, { customer_name: 'ACME', product_code: 'SAAS-PRO', billing_cycle: 'monthly', unit_price: 1000, qty: 2, start_date: '2026-06-01' });
  ok('Create subscription', sub.status < 300 && sub.json.id, JSON.stringify({ s: sub.status }));

  // ── 2. run billing → 1 invoice + 1 GL entry ──
  const run = await inj('POST', '/api/service/billing/run', admin, { as_of_date: '2026-06-01' });
  ok('Run billing → 1 invoice, 1 GL entry posted', run.json.invoices_created === 1 && run.json.gl_entries_posted === 1, JSON.stringify(run.json));

  // ── 3. GL after billing: 1100 AR dr 2000, 4300 revenue cr 2000, TB balanced ──
  const tb1 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r1 = (c: string) => (tb1.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Billing GL: 1100 AR dr 2000, 4300 revenue cr 2000, TB balanced',
    tb1.json.totals?.balanced === true && near(r1('1100')?.debit, 2000) && near(r1('4300')?.credit, 2000),
    JSON.stringify({ bal: tb1.json.totals?.balanced, ar: r1('1100')?.debit, rev: r1('4300')?.credit }));

  // ── 4. re-run same as_of → nothing due (idempotent: nextBillingDate advanced) ──
  const rerun = await inj('POST', '/api/service/billing/run', admin, { as_of_date: '2026-06-01' });
  ok('Re-run billing → 0 new invoices (next-billing advanced)', rerun.json.invoices_created === 0, JSON.stringify(rerun.json));

  // ── 5. pay the invoice → cash GL ──
  const invs = await inj('GET', `/api/service/subscriptions/${sub.json.id}/invoices`, admin);
  const invId = (invs.json.invoices ?? invs.json ?? [])[0]?.id ?? (Array.isArray(invs.json) ? invs.json[0]?.id : undefined);
  const pay = await inj('POST', `/api/service/invoices/${invId}/pay`, admin);
  ok('Pay invoice → cash GL entry', /^JE-/.test(pay.json.entry_no ?? ''), JSON.stringify({ e: pay.json.entry_no }));

  // ── 6. GL after payment: 1000 cash dr 2000, 1100 AR back to 0, TB balanced ──
  const tb2 = await inj('GET', '/api/ledger/trial-balance', admin);
  const r2 = (c: string) => (tb2.json.rows ?? []).find((x: any) => x.account_code === c);
  ok('Payment GL: 1000 cash dr 2000, 1100 AR balance 0, TB balanced',
    tb2.json.totals?.balanced === true && near(r2('1000')?.debit, 2000) && near(r2('1100')?.balance, 0),
    JSON.stringify({ bal: tb2.json.totals?.balanced, cash: r2('1000')?.debit, ar: r2('1100')?.balance }));

  console.log('\n── Phase 20 — subscription billing → GL (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} sub-billing checks failed` : `\n✅ All ${checks.length} sub-billing checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
