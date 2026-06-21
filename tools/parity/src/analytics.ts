/**
 * Phase 5 analytics test — รัน forecasting/anomalies/insights จริงของ V2 (dist) บน PGlite,
 * seed ข้อมูลที่คำนวณผลคาดหวังได้ แล้ว assert สูตร (reorder point, z-score, variance) + rule-based insight.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/parity analytics
 */
import 'reflect-metadata';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import * as s from '../../../apps/api/dist/database/schema/index';
import { ForecastingService } from '../../../apps/api/dist/modules/analytics/forecasting.service';
import { AnomaliesService } from '../../../apps/api/dist/modules/analytics/anomalies.service';
import { InsightsService } from '../../../apps/api/dist/modules/analytics/insights.service';
import { AnalyticsService } from '../../../apps/api/dist/modules/analytics/analytics.service';

delete process.env.ANTHROPIC_API_KEY; // force rule-based path
const MIGRATIONS_DIR = resolve(process.cwd(), '../../apps/api/drizzle');
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function main() {
  const { PGlite } = require('@electric-sql/pglite');
  const { drizzle } = require('drizzle-orm/pglite');
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/-->\s*statement-breakpoint/g, ''));
  const db: any = drizzle(pg, { schema: s });

  // ── seed forecasting: item X, current stock 20, 30 วันขายวันละ 2 ──
  await db.insert(s.stockSnapshots).values({ generateDate: new Date(), itemId: 'X', itemDescription: 'Item X', uom: 'EA', avQty: '20' });
  for (let i = 0; i < 30; i++) {
    const [sale] = await db.insert(s.custPosSales).values({ saleNo: `S${i}`, saleDate: ymd(daysAgo(i)), status: 'Completed', total: '100' }).returning({ id: s.custPosSales.id });
    await db.insert(s.custPosItems).values({ saleId: Number(sale.id), itemId: 'X', qty: '2', amount: '100' });
  }

  // ── seed anomalies: item Y, baseline 30 วัน (4/6 สลับ) ที่ 35–64 วันก่อน + spike 100 ที่ 5 วันก่อน ──
  for (let i = 0; i < 30; i++)
    await db.insert(s.stockMovements).values({ moveDate: daysAgo(35 + i), moveType: 'Issue', itemId: 'Y', qty: String(i % 2 === 0 ? 4 : 6) });
  await db.insert(s.stockMovements).values({ moveDate: daysAgo(5), moveType: 'Issue', itemId: 'Y', qty: '100' });
  await db.insert(s.items).values({ itemId: 'Y', itemDescription: 'Item Y' });

  // ── seed stocktake variance: system 100 vs physical 50 → 50% ──
  await db.insert(s.stocktakes).values({ stNo: 'ST1', stDate: ymd(new Date()), itemId: 'Z', systemQty: '100', physicalQty: '50', difference: '-50' });

  const f = new ForecastingService(db);
  const a = new AnomaliesService(db);
  const ins = new InsightsService();
  const an = new AnalyticsService(f, a, ins);

  // ── forecasting assertions ──
  const pred = await f.predictStockout('X');
  ok('forecast avg_daily_sales = 2', pred.avg_daily_sales === 2, `${pred.avg_daily_sales}`);
  ok('forecast stdev = 0', pred.stdev_daily === 0);
  ok('forecast lead_time fallback = 7', pred.lead_time_days === 7);
  ok('forecast reorder_point = 14 (avg*LT + 1.5σ)', pred.reorder_point === 14, `${pred.reorder_point}`);
  ok('forecast days_of_stock = 10 (20/2)', pred.days_of_stock === 10, `${pred.days_of_stock}`);
  ok('forecast urgency = warning (10 ≤ 2×LT)', pred.urgency === 'warning', pred.urgency);
  ok('forecast confidence = high (30d)', pred.confidence === 'high', pred.confidence);

  const replList = await f.getReplenishmentList(50);
  ok('replenishment list includes X', replList.some((p) => p.item_id === 'X'));

  // ── insight rule-based ──
  const insight = await ins.replenishment(pred);
  ok('rule-based insight (warning) starts with ⚡', insight.startsWith('⚡'), insight.slice(0, 20));

  // ── anomalies ──
  const anom = await a.detectStockAnomalies(30);
  const y = anom.find((x: any) => x.item_id === 'Y');
  ok('anomaly Y detected', !!y, `z=${y?.z_score}`);
  ok('anomaly Y severity critical (z>3.5)', y?.severity === 'critical', `z=${y?.z_score}`);

  const variance = await a.detectStocktakeVariance(20);
  const z = variance.find((x: any) => x.item_id === 'Z');
  ok('stocktake variance Z = 50% critical', z?.variance_pct === 50 && z?.severity === 'critical', `pct=${z?.variance_pct}`);

  // ── dashboard summary (rule-based bulk) ──
  const summary = await an.dashboardSummary();
  ok('dashboard-summary returns insight string', typeof summary.insight === 'string' && summary.insight.length > 0);
  ok('dashboard-summary has anomaly summary', summary.anomalies.total_anomalies >= 1, `total=${summary.anomalies.total_anomalies}`);

  await pg.close();
  console.log('\n── Phase 5 analytics (V2 services on PGlite) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) { console.log(`\n❌ ${failed.length}/${checks.length} analytics checks failed`); process.exit(1); }
  console.log(`\n✅ All ${checks.length} analytics checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
