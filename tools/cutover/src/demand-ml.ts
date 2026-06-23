/**
 * Phase D4 — demand ML + walk-forward backtesting (WAPE/MASE) over PGlite.
 * Proves: the demand service builds a daily series from POS sales, backtests every candidate model on a
 * hold-out window, AUTO-SELECTS the most accurate, forecasts the horizon, and persists a tenant-scoped run.
 * The accuracy gate: the advanced models beat the naive baseline on the patterns they're meant for
 *   - steady demand  → best WAPE is small,
 *   - trending demand → Holt beats SMA,
 *   - intermittent    → Croston beats SMA,
 * plus tenant isolation (RLS) on the persisted forecasts.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover demand-ml
 */
import 'reflect-metadata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'demand-ml-secret';
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
import { ymd } from '../../../apps/api/dist/database/queries';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '@ierp/shared';

const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });
const dayStr = (back: number) => ymd(new Date(Date.now() - back * 86400_000));

async function main() {
  const pg = await PGlite.create();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });
  const pw = new PasswordService();

  await db.insert(s.permissions).values(PERMISSIONS.map((k) => ({ key: k }))).onConflictDoNothing();
  for (const [r, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
    await db.insert(s.rolePermissions).values((ps as string[]).map((perm) => ({ role: r as any, perm }))).onConflictDoNothing();
  await db.insert(s.tenants).values([{ code: 'HQ', name: 'HQ' }, { code: 'T2', name: 'ร้านสอง' }]).onConflictDoNothing();
  const tid = async (c: string) => Number((await db.select().from(s.tenants).where(eq(s.tenants.code, c)))[0].id);
  const [hq, t2] = [await tid('HQ'), await tid('T2')];
  await db.insert(s.users).values([{ username: 'admin', passwordHash: await pw.hash('pw'), role: 'Admin', tenantId: hq }]).onConflictDoNothing();
  // Non-bypass users (MasterDataAdmin) in two tenants + a 'planner' grant so RLS is actually ENFORCED
  // for the isolation check (an Admin would bypass it).
  await db.insert(s.users).values([
    { username: 'plan1', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: hq },
    { username: 'plan2', passwordHash: await pw.hash('pw'), role: 'MasterDataAdmin', tenantId: t2 },
  ]).onConflictDoNothing();
  const uid = async (u: string) => Number((await db.select().from(s.users).where(eq(s.users.username, u)))[0].id);
  for (const u of ['plan1', 'plan2']) await db.insert(s.userPermissions).values({ userId: await uid(u), perm: 'planner' }).onConflictDoNothing();

  // ── seed deterministic POS demand histories (HQ tenant) ──
  // Three items, three patterns, ~140 business days each ending today (no trailing-zero gap).
  const DAYS = 140;
  const patterns: Record<string, (i: number) => number> = {
    'DM-STEADY': (i) => 10 + (i % 2),                 // ~constant — any model nails it
    'DM-TREND': (i) => Math.round((5 + 0.25 * i) * 10) / 10, // linear up — Holt should beat SMA
    'DM-INTER': (i) => (i % 14 === 0 ? 28 : 0),       // demand every 14 days — Croston should beat SMA
  };
  let saleSeq = 0;
  for (let i = 0; i < DAYS; i++) {
    const date = dayStr(DAYS - 1 - i);
    for (const [item, fn] of Object.entries(patterns)) {
      const qty = fn(i);
      if (qty <= 0) continue; // a day with no sale row = 0 demand (dense-filled by the service)
      const sale = await db.insert(s.custPosSales).values({ saleNo: `SALE-DM-${saleSeq++}`, saleDate: date, tenantId: hq, status: 'Completed', total: '0' }).returning({ id: s.custPosSales.id });
      await db.insert(s.custPosItems).values({ saleId: Number(sale[0].id), itemId: item, qty: String(qty), uom: 'unit' });
    }
  }
  // a tiny history for T2 (own item) so its forecast persists under its own tenant
  for (let i = 0; i < 30; i++) {
    const sale = await db.insert(s.custPosSales).values({ saleNo: `SALE-T2-${i}`, saleDate: dayStr(29 - i), tenantId: t2, status: 'Completed', total: '0' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(sale[0].id), itemId: 'DM-T2', qty: '7', uom: 'unit' });
  }

  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DRIZZLE).useValue(tenantAwareProxy(db)).compile();
  const app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const inj = async (m: string, url: string, token?: string, payload?: any) => {
    const res = await app.inject({ method: m as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload });
    let json: any = {}; try { json = res.json(); } catch { /* */ }
    return { status: res.statusCode, json };
  };
  const login = async (u: string) => (await inj('POST', '/api/login', undefined, { username: u, password: 'pw' })).json.token as string;
  const admin = await login('admin');

  // ── 1. backtest a steady series: all models accurate, MASE finite ──
  const bSteady = await inj('POST', '/api/demand/backtest', admin, { item_id: 'DM-STEADY' });
  const cand = (resp: any) => (resp.json.candidates ?? []) as any[];
  const byAlgo = (resp: any, a: string) => cand(resp).find((c) => c.algorithm === a);
  ok('Backtest STEADY → all 5 candidates scored', cand(bSteady).length === 5 && cand(bSteady).every((c) => typeof c.wape === 'number'), JSON.stringify(cand(bSteady).map((c) => [c.algorithm, c.wape])));
  ok('Backtest STEADY → best WAPE small (< 0.10)', (bSteady.json.best?.wape ?? 1) < 0.10, `best=${bSteady.json.best?.algorithm} wape=${bSteady.json.best?.wape}`);
  ok('Backtest STEADY → MASE computed (finite)', Number.isFinite(bSteady.json.best?.mase), `mase=${bSteady.json.best?.mase}`);

  // ── 2. trending series: Holt (trend-aware) beats the flat SMA baseline ──
  const bTrend = await inj('POST', '/api/demand/backtest', admin, { item_id: 'DM-TREND' });
  ok('Backtest TREND → Holt WAPE < SMA WAPE (captures trend)', byAlgo(bTrend, 'holt').wape < byAlgo(bTrend, 'sma').wape, `holt=${byAlgo(bTrend, 'holt').wape} sma=${byAlgo(bTrend, 'sma').wape}`);

  // ── 3. intermittent series: Croston beats the SMA baseline ──
  const bInter = await inj('POST', '/api/demand/backtest', admin, { item_id: 'DM-INTER' });
  ok('Backtest INTER → Croston WAPE < SMA WAPE (intermittent)', byAlgo(bInter, 'croston').wape < byAlgo(bInter, 'sma').wape, `croston=${byAlgo(bInter, 'croston').wape} sma=${byAlgo(bInter, 'sma').wape}`);

  // ── 4. forecast auto-selects the lowest-WAPE model + persists a run ──
  const fc = await inj('POST', '/api/demand/forecast', admin, { item_id: 'DM-TREND', horizon: 10 });
  ok('Forecast → horizon length 10, all non-negative', (fc.json.forecast?.length === 10) && fc.json.forecast.every((x: number) => x >= 0), JSON.stringify(fc.json.forecast));
  ok('Forecast → selected_by lowest_wape, algorithm = best candidate', fc.json.selected_by === 'lowest_wape' && fc.json.algorithm === fc.json.candidates[0].algorithm, `${fc.json.selected_by} ${fc.json.algorithm}`);
  ok('Forecast TREND → projects upward (last > first)', fc.json.forecast[fc.json.forecast.length - 1] > fc.json.forecast[0], JSON.stringify([fc.json.forecast[0], fc.json.forecast.at(-1)]));

  // ── 5. pin an algorithm explicitly ──
  const fcPin = await inj('POST', '/api/demand/forecast', admin, { item_id: 'DM-STEADY', horizon: 5, algorithm: 'ses' });
  ok('Forecast pinned algorithm → selected_by requested, algorithm ses', fcPin.json.selected_by === 'requested' && fcPin.json.algorithm === 'ses', `${fcPin.json.selected_by} ${fcPin.json.algorithm}`);
  const fcBad = await inj('POST', '/api/demand/forecast', admin, { item_id: 'DM-STEADY', algorithm: 'wizardry' });
  ok('Forecast unknown algorithm → 400 UNKNOWN_ALGORITHM', fcBad.status === 400 && fcBad.json.error?.code === 'UNKNOWN_ALGORITHM', `${fcBad.status} ${fcBad.json.error?.code}`);

  // ── 6. too-little history is refused ──
  const fcShort = await inj('POST', '/api/demand/forecast', admin, { item_id: 'NO-SUCH-ITEM' });
  ok('Forecast no history → 400 INSUFFICIENT_HISTORY', fcShort.status === 400 && fcShort.json.error?.code === 'INSUFFICIENT_HISTORY', `${fcShort.status} ${fcShort.json.error?.code}`);

  // ── 7. accuracy KPI aggregates the persisted runs ──
  const acc = await inj('GET', '/api/demand/accuracy', admin);
  ok('Accuracy KPI → runs ≥ 2, avg_wape finite', (acc.json.runs ?? 0) >= 2 && Number.isFinite(acc.json.avg_wape), JSON.stringify({ runs: acc.json.runs, avg_wape: acc.json.avg_wape }));

  // ── 8. RLS: a persisted forecast in HQ is invisible to T2 ──
  const plan1 = await login('plan1');
  const plan2 = await login('plan2');
  await inj('POST', '/api/demand/forecast', plan1, { item_id: 'DM-STEADY', horizon: 5 }); // persists under HQ
  await inj('POST', '/api/demand/forecast', plan2, { item_id: 'DM-T2', horizon: 5 });      // persists under T2
  const hqList = await inj('GET', '/api/demand/forecasts', plan1);
  const t2List = await inj('GET', '/api/demand/forecasts', plan2);
  ok('RLS: HQ planner sees only HQ runs (no DM-T2)', (hqList.json.forecasts ?? []).every((f: any) => f.itemId !== 'DM-T2') && (hqList.json.forecasts ?? []).length >= 1, `hq=${hqList.json.count}`);
  ok('RLS: T2 planner sees only its own run (DM-T2 only)', (t2List.json.forecasts ?? []).length >= 1 && (t2List.json.forecasts ?? []).every((f: any) => f.itemId === 'DM-T2'), `t2=${t2List.json.count} items=${JSON.stringify((t2List.json.forecasts ?? []).map((f: any) => f.itemId))}`);

  await app.close();
  await pg.close();

  console.log('\n── Phase D4 — demand ML + walk-forward backtesting (WAPE/MASE) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} demand-ml checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} demand-ml checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
