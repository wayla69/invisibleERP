import { Inject, Injectable } from '@nestjs/common';
import { sql, eq, and, gte, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { stockMovements, stocktakes, items } from '../../database/schema';

// ค่าคงที่ port จาก analytics/anomalies.py
const Z_THRESHOLD = 2.5, Z_CRITICAL = 3.5, VAR_THRESHOLD = 20.0, VAR_CRITICAL = 50.0;

@Injectable()
export class AnomaliesService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async detectStockAnomalies(days = 30) {
    const db = this.db;
    const histCutoff = new Date(Date.now() - (days + 60) * 86400_000);
    const recentCutoff = new Date(Date.now() - days * 86400_000);

    // baseline: per-(item,type,day) magnitude
    const baseRows: any[] = await db.select({
      item: stockMovements.itemId, type: stockMovements.moveType,
      day: sql<string>`to_char(${stockMovements.moveDate}, 'YYYY-MM-DD')`, v: sql<string>`sum(abs(${stockMovements.qty}))`,
    }).from(stockMovements).where(gte(stockMovements.moveDate, histCutoff))
      .groupBy(stockMovements.itemId, stockMovements.moveType, sql`to_char(${stockMovements.moveDate}, 'YYYY-MM-DD')`);
    const seriesMap = new Map<string, number[]>();
    const dayMap = new Map<string, string[]>(); // parallel to seriesMap — lets corrected mode split baseline vs recent days
    for (const r of baseRows) {
      const k = `${r.item}|${r.type}`;
      (seriesMap.get(k) ?? seriesMap.set(k, []).get(k)!).push(Number(r.v));
      (dayMap.get(k) ?? dayMap.set(k, []).get(k)!).push(String(r.day));
    }

    // recent aggregate
    const recRows: any[] = await db.select({
      item: stockMovements.itemId, type: stockMovements.moveType,
      total: sql<string>`sum(abs(${stockMovements.qty}))`, cnt: sql<string>`count(*)`,
    }).from(stockMovements).where(gte(stockMovements.moveDate, recentCutoff))
      .groupBy(stockMovements.itemId, stockMovements.moveType).having(sql`sum(abs(${stockMovements.qty})) > 0`);

    // Batch the item-name lookup once (was one query per anomaly → N+1).
    const recItemIds = [...new Set(recRows.map((r) => r.item).filter(Boolean))];
    const nameRows: any[] = recItemIds.length
      ? await db.select({ id: items.itemId, name: items.itemDescription }).from(items).where(inArray(items.itemId, recItemIds))
      : [];
    const nameMap = new Map<string, string>(nameRows.map((x: any) => [x.id, x.name]));

    // docs/27 R4-2 / AUD-AI-02 — the legacy port compared the recent-window SUM against a PER-DAY baseline
    // (unit mismatch: any item with many active recent days false-positives) and let the baseline include
    // the recent window itself (the spike contaminates its own reference). The CORRECTED math (default)
    // compares the recent PEAK DAILY magnitude against the pre-window per-day baseline — same units, clean
    // reference. The legacy behavior is preserved verbatim behind ANOMALY_PARITY_MODE=legacy for the
    // analytics parity harness (never silently "fix" parity-locked behavior — CLAUDE.md debug mantra #4).
    const legacy = (process.env.ANOMALY_PARITY_MODE ?? '').toLowerCase() === 'legacy';
    const recentYmd = recentCutoff.toISOString().slice(0, 10);
    const anomalies: any[] = [];
    for (const r of recRows) {
      const all = seriesMap.get(`${r.item}|${r.type}`) ?? [];
      const allDays = dayMap.get(`${r.item}|${r.type}`) ?? [];
      const baseline = legacy ? all : all.filter((_, i) => allDays[i]! < recentYmd);
      const recentDaily = legacy ? [] : all.filter((_, i) => allDays[i]! >= recentYmd);
      const value = legacy ? Number(r.total) : recentDaily.length ? Math.max(...recentDaily) : 0;
      const z = zscore(value, baseline);
      if (z > Z_THRESHOLD) {
        anomalies.push({
          item_id: r.item, item_name: nameMap.get(r.item) ?? r.item, movement_type: r.type, recent_qty: round2(value),
          hist_avg: baseline.length ? round2(mean(baseline)) : 0, z_score: round2(z), event_count: Number(r.cnt),
          severity: z > Z_CRITICAL ? 'critical' : 'warning',
        });
      }
    }
    return anomalies.sort((a, b) => b.z_score - a.z_score);
  }

  async detectStocktakeVariance(threshold = VAR_THRESHOLD) {
    const db = this.db;
    const [mx] = await db.select({ d: sql<string>`max(${stocktakes.stDate})` }).from(stocktakes);
    if (!mx?.d) return [];
    const rows: any[] = await db.select({
      item: stocktakes.itemId, system: stocktakes.systemQty, physical: stocktakes.physicalQty, diff: stocktakes.difference, name: items.itemDescription, date: stocktakes.stDate,
    }).from(stocktakes).leftJoin(items, eq(items.itemId, stocktakes.itemId)).where(eq(stocktakes.stDate, mx.d));
    const out: any[] = [];
    for (const r of rows) {
      const expected = Number(r.system ?? 0);
      const counted = Number(r.physical ?? 0);
      const variance = r.diff != null ? Number(r.diff) : counted - expected;
      const pct = expected !== 0 ? Math.abs(variance / expected) * 100 : variance !== 0 ? 100 : 0;
      if (pct >= threshold) out.push({ item_id: r.item, item_name: r.name ?? r.item, stocktake_date: r.date, expected_qty: expected, counted_qty: counted, variance, variance_pct: round1(pct), severity: pct >= VAR_CRITICAL ? 'critical' : 'warning' });
    }
    return out.sort((a, b) => b.variance_pct - a.variance_pct);
  }

  async getAnomalySummary(days = 30) {
    const [movement, variance] = await Promise.all([this.detectStockAnomalies(days), this.detectStocktakeVariance()]);
    const critical = movement.filter((a) => a.severity === 'critical').length + variance.filter((v) => v.severity === 'critical').length;
    const total = movement.length + variance.length;
    return {
      movement_anomalies: movement, stocktake_variances: variance,
      summary: { total_anomalies: total, critical_count: critical, warning_count: total - critical, analysis_days: days, generated_at: new Date().toISOString() },
    };
  }
}

function zscore(value: number, series: number[]): number {
  if (series.length < 3) return 0;
  const sd = stdev(series);
  if (sd === 0) return 0;
  return (value - mean(series)) / sd;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function stdev(a: number[]) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;
