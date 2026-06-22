/**
 * Phase 20 Batch 1A — EPM Planning & Budgeting (xP&A) over PGlite.
 * Versioned budget plans, scenario cloning, driver-based projection, 3-way variance.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover epm-planning
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'planning-secret';
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

  await db.insert(s.permissions).values(PERMISSIONS.map((k: string) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([
    { code: 'HQ', name: 'HQ' },
    { code: 'T1', name: 'สาขาหนึ่ง' },
    { code: 'T2', name: 'สาขาสอง' },
  ]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t1, t2] = [await tid('HQ'), await tid('T1'), await tid('T2')];
  await db.insert(s.users).values([
    { username: 'admin',  passwordHash: await pw.hash('admin123'), role: 'Admin',   tenantId: hq },
    { username: 'plan1',  passwordHash: await pw.hash('pw1'),      role: 'Planner', tenantId: t1 },
    { username: 'plan2',  passwordHash: await pw.hash('pw2'),      role: 'Planner', tenantId: t2 },
  ]).onConflictDoNothing();

  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ maxParamLength: 500 }));
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
  const [admin, plan1, plan2] = [await login('admin', 'admin123'), await login('plan1', 'pw1'), await login('plan2', 'pw2')];

  // ── Seed GL actuals in 2026-01 for T1 (via admin posting as T1 context — use direct DB insert) ──
  // Insert a GL journal entry for T1 so the 3-way variance has actuals to compare against
  await db.insert(s.journalEntries).values({
    entryNo: 'JE-20260101-001', entryDate: '2026-01-10', period: '2026-01',
    memo: 'Jan sales actual', source: 'Manual', tenantId: t1, status: 'Posted',
  }).onConflictDoNothing();
  const [je] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.entryNo, 'JE-20260101-001'));
  await db.insert(s.journalLines).values([
    { entryId: Number(je.id), accountCode: '1000', debit: '1500', credit: '0', tenantId: t1 },
    { entryId: Number(je.id), accountCode: '4000', debit: '0',    credit: '1500', tenantId: t1 },
  ]).onConflictDoNothing();

  // Seed flat budget for T1 (existing budgets table) so 3-way has Budget column data
  await db.insert(s.budgets).values({
    tenantId: t1, fiscalYear: 2026, accountCode: '4000', period: '2026-01', amount: '2000', createdBy: 'seed',
  }).onConflictDoNothing();

  // ── 1. Create budget version FY2026 ──
  const ver = await inj('POST', '/api/planning/versions', plan1, { name: 'FY2026 Annual Budget', fiscal_year: 2026 });
  const versionId = ver.json.id as number;
  ok('Create version FY2026 → status=Working, versionNo=BV-2026-...', ver.status === 201 && ver.json.status === 'Working' && /^BV-2026-/.test(ver.json.version_no ?? ''), JSON.stringify({ status: ver.json.status, no: ver.json.version_no }));

  // ── 2. Add Base scenario ──
  const baseScen = await inj('POST', `/api/planning/versions/${versionId}/scenarios`, plan1, { name: 'Base', description: 'Base case', is_default: true });
  const baseScenId = baseScen.json.id as number;
  ok('Add Base scenario → id assigned, is_default=true', baseScen.status === 201 && baseScen.json.name === 'Base' && baseScen.json.is_default === true, JSON.stringify({ id: baseScenId, name: baseScen.json.name }));

  // ── 3. Upsert forecast lines in Base scenario ──
  const fl1 = await inj('PUT', `/api/planning/scenarios/${baseScenId}/lines`, plan1, {
    account_code: '4000', period: '2026-01', amount: 1800, notes: 'Revenue forecast Jan',
  });
  ok('Upsert forecast line → amount=1800, source=Manual', fl1.status === 200 && near(fl1.json.amount, 1800) && fl1.json.source === 'Manual', JSON.stringify({ amount: fl1.json.amount, source: fl1.json.source }));

  const fl2 = await inj('PUT', `/api/planning/scenarios/${baseScenId}/lines`, plan1, {
    account_code: '5100', period: '2026-01', amount: 900, notes: 'OpEx forecast Jan',
  });
  ok('Upsert second line (5100 OpEx) → amount=900', fl2.status === 200 && near(fl2.json.amount, 900), `amount=${fl2.json.amount}`);

  // ── 4. Idempotent upsert overwrites (not duplicates) ──
  await inj('PUT', `/api/planning/scenarios/${baseScenId}/lines`, plan1, { account_code: '4000', period: '2026-01', amount: 1900 });
  const lines = await inj('GET', `/api/planning/scenarios/${baseScenId}/lines?period=2026-01`, plan1);
  const rev4000 = (lines.json.lines ?? []).find((l: any) => l.account_code === '4000');
  ok('Idempotent upsert: only 1 line per account+period (latest amount=1900)', (lines.json.lines ?? []).filter((l: any) => l.account_code === '4000').length === 1 && near(rev4000?.amount, 1900), JSON.stringify({ n: lines.json.lines?.length, amt: rev4000?.amount }));

  // ── 5. Clone Base → Best scenario ──
  const bestClone = await inj('POST', `/api/planning/scenarios/${baseScenId}/clone`, plan1, { name: 'Best', description: 'Optimistic scenario' });
  const bestScenId = bestClone.json.id as number;
  ok('Clone Base → Best: new scenario id, 2 lines copied', bestClone.status === 200 && bestClone.json.name === 'Best' && bestClone.json.lines_copied === 2, JSON.stringify({ id: bestScenId, copied: bestClone.json.lines_copied }));

  // ── 6. Driver: Revenue 4000 grows 10% from GL actual ──
  const drv = await inj('POST', `/api/planning/scenarios/${bestScenId}/drivers`, plan1, {
    account_code: '4000', driver_type: 'percent', rate_value: 10, notes: 'Revenue +10% of last period',
  });
  ok('Upsert driver → percent, rate_value=10', drv.status === 201 && drv.json.driver_type === 'percent' && near(drv.json.rate_value, 10), JSON.stringify({ type: drv.json.driver_type, rate: drv.json.rate_value }));

  // ── 7. Run drivers for 2026-02 (no GL actual → amount = 0 × 1.10 = 0) ──
  //    and 2026-01 (GL actual credit on 4000 = -1500 net → 4000 credit negative movement × 1.10)
  const runResult = await inj('POST', `/api/planning/scenarios/${bestScenId}/run-drivers`, plan1, { periods: ['2026-01', '2026-02'] });
  ok('Run drivers → writes 2 lines (one per period × 1 driver)', runResult.status === 200 && runResult.json.lines_written === 2, JSON.stringify(runResult.json));

  // Check 2026-01 line updated to Driver source (actual GL 4000 net = debit-credit = 0-1500 = -1500 → × 1.10 = -1650)
  const bestLines = await inj('GET', `/api/planning/scenarios/${bestScenId}/lines?period=2026-01`, plan1);
  const bestRev = (bestLines.json.lines ?? []).find((l: any) => l.account_code === '4000');
  ok('Driver run: 4000 line source=Driver, amount=-1650 (GL net -1500 × 1.10)', bestLines.status === 200 && bestRev?.source === 'Driver' && near(bestRev?.amount, -1650), JSON.stringify({ source: bestRev?.source, amount: bestRev?.amount }));

  // ── 8. Submit version (no BUDGET workflow def → auto-approved path) ──
  const sub = await inj('POST', `/api/planning/versions/${versionId}/submit`, plan1);
  ok('Submit version → status=Submitted', sub.status === 200 && sub.json.status === 'Submitted', JSON.stringify(sub.json));

  // ── 9. Approve version → Approved ──
  const appr = await inj('POST', `/api/planning/versions/${versionId}/approve`, plan1);
  ok('Approve version → status=Approved', appr.status === 200 && appr.json.status === 'Approved', JSON.stringify(appr.json));

  // ── 10. Baseline → Baseline (locked) ──
  const base = await inj('POST', `/api/planning/versions/${versionId}/baseline`, plan1);
  ok('Baseline version → status=Baseline', base.status === 200 && base.json.status === 'Baseline', JSON.stringify(base.json));

  // ── 11. Cannot submit again after Baseline ──
  const reSub = await inj('POST', `/api/planning/versions/${versionId}/submit`, plan1);
  ok('Cannot re-submit Baseline version → 400 INVALID_STATUS', reSub.status === 400, `status=${reSub.status}`);

  // ── 12. 3-way variance: Budget(2000) vs Forecast(1900) vs Actual(-1500 net) for 4000 ──
  const variance = await inj('GET', `/api/planning/versions/${versionId}/variance?scenario_id=${baseScenId}&period=2026-01`, plan1);
  const vRow = (variance.json.lines ?? []).find((l: any) => l.account_code === '4000');
  ok(
    '3-way variance 4000: budget=2000, forecast=1900, actual=−1500 net, deltas correct',
    variance.status === 200 &&
    near(vRow?.budget, 2000) && near(vRow?.forecast, 1900) && near(vRow?.actual, -1500) &&
    near(vRow?.forecast_vs_budget, -100) && near(vRow?.actual_vs_forecast, -3400),
    JSON.stringify(vRow),
  );

  // ── 13. RLS: T2 cannot see T1 version ──
  const t2Versions = await inj('GET', '/api/planning/versions', plan2);
  const t2SeeT1 = (t2Versions.json.versions ?? []).some((v: any) => v.id === versionId);
  ok('RLS: T2 planner cannot see T1 budget version', !t2SeeT1, `T2 saw T1 version: ${t2SeeT1}`);

  // ── 14. Version detail includes scenarios ──
  const detail = await inj('GET', `/api/planning/versions/${versionId}`, plan1);
  ok('Version detail includes scenarios array (Base + Best)', detail.status === 200 && Array.isArray(detail.json.scenarios) && detail.json.scenarios.length >= 2, JSON.stringify({ scens: detail.json.scenarios?.length, status: detail.json.status }));

  // ── Results ──
  await app.close();
  let pass = 0;
  for (const c of checks) {
    const sym = c.ok ? 'PASS' : 'FAIL';
    console.log(`  [${sym}] ${c.name}${c.detail ? `  →  ${c.detail}` : ''}`);
    if (c.ok) pass++;
  }
  console.log(`\n${pass}/${checks.length} checks passed`);
  if (pass < checks.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
