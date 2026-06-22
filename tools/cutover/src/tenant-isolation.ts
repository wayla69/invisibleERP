/**
 * A1 (R1) regression — per-tenant fiscal periods. Proves one tenant closing its year/period does NOT
 * lock another tenant's calendar (the old global fiscal_periods bug), and that year-end aggregation +
 * idempotency are per-tenant.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tenant-isolation
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ti-secret';
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
const rev = (tenant_id: number, date: string, amt: number) =>
  ({ date, source: 'TEST', tenant_id, memo: 'sale', lines: [{ account_code: '1000', debit: amt }, { account_code: '4000', credit: amt }] });

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
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('admin123'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();

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
  const admin = (await inj('POST', '/api/login', undefined, { username: 'admin', password: 'admin123' })).json.token as string;

  // ── 1. both tenants post June-2026 revenue (T1=1000, T2=500) ──
  const p1 = await inj('POST', '/api/ledger/journal', admin, rev(t1, '2026-06-15', 1000));
  const p2 = await inj('POST', '/api/ledger/journal', admin, rev(t2, '2026-06-15', 500));
  ok('Both tenants post June-2026 revenue', /^JE-/.test(p1.json.entry_no ?? '') && /^JE-/.test(p2.json.entry_no ?? ''), `${p1.json.entry_no} ${p2.json.entry_no}`);

  // ── 2. close T1's FY2026 (aggregates ONLY T1 → net 1000) ──
  const closeT1 = await inj('POST', `/api/ledger/close-year?fiscal_year=2026&tenant_id=${t1}`, admin);
  ok('Close T1 FY2026 → net 1000 (T1 only, not T1+T2)', near(closeT1.json.net_income, 1000) && /^JE-/.test(closeT1.json.entry_no ?? ''), JSON.stringify({ net: closeT1.json.net_income, e: closeT1.json.entry_no }));

  // ── 3. T1's June is now CLOSED → further T1 posting blocked ──
  const t1Blocked = await inj('POST', '/api/ledger/journal', admin, rev(t1, '2026-06-20', 100));
  ok('After T1 close: T1 posting into 2026-06 → 400 PERIOD_CLOSED', t1Blocked.status === 400 && t1Blocked.json.error?.code === 'PERIOD_CLOSED', `${t1Blocked.status} ${t1Blocked.json.error?.code}`);

  // ── 4. THE R1 FIX: T2's June is UNAFFECTED → T2 posting still succeeds ──
  const t2Open = await inj('POST', '/api/ledger/journal', admin, rev(t2, '2026-06-20', 200));
  ok('R1 FIX: T1 close did NOT lock T2 — T2 posts into 2026-06 fine', /^JE-/.test(t2Open.json.entry_no ?? ''), `${t2Open.status} ${t2Open.json.entry_no}`);

  // ── 5. per-tenant period state: T1 June Closed, T2 June Open ──
  const perT1 = await inj('GET', `/api/ledger/periods?tenant_id=${t1}`, admin);
  const perT2 = await inj('GET', `/api/ledger/periods?tenant_id=${t2}`, admin);
  const stat = (j: any, code: string) => (j.periods ?? []).find((p: any) => p.code === code)?.status;
  ok('Periods are per-tenant: T1 2026-06 Closed, T2 2026-06 Open', stat(perT1.json, '2026-06') === 'Closed' && stat(perT2.json, '2026-06') !== 'Closed', `T1=${stat(perT1.json, '2026-06')} T2=${stat(perT2.json, '2026-06')}`);

  // ── 6. T2 can close its OWN FY2026 → net 700 (500+200), independent of T1 ──
  const closeT2 = await inj('POST', `/api/ledger/close-year?fiscal_year=2026&tenant_id=${t2}`, admin);
  ok('T2 closes its own FY2026 → net 700 (500+200), independent', near(closeT2.json.net_income, 700) && /^JE-/.test(closeT2.json.entry_no ?? ''), `status=${closeT2.status} body=${JSON.stringify(closeT2.json)}`);

  // ── 7. idempotency is per-tenant: re-closing T1 is a no-op, T1 ref 'FY2026' not consumed by T2 ──
  const reT1 = await inj('POST', `/api/ledger/close-year?fiscal_year=2026&tenant_id=${t1}`, admin);
  ok('Per-tenant idempotency: re-close T1 FY2026 → already=true', reT1.json.already === true, JSON.stringify(reT1.json).slice(0, 50));

  console.log('\n── A1 (R1) — Per-tenant fiscal periods / tenant isolation ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} tenant-isolation checks failed` : `\n✅ All ${checks.length} tenant-isolation checks passed`);
  await app.close();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
