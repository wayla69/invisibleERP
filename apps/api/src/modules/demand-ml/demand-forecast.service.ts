import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { sql, eq, and, ne, gte, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosItems, custPosSales, demandForecasts } from '../../database/schema';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { ALGOS, walkForward, wape, mase, rmse, bias, type Forecaster } from './forecast-algorithms';

const LOOKBACK = 400;        // days of POS history to build the demand series from
const MIN_HISTORY = 14;      // need at least 2 weeks to backtest meaningfully
const SEASON = 7;            // weekly seasonality (MASE naive benchmark + seasonal_naive period)
const DEFAULT_HORIZON = 14;
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface DemandForecastDto { item_id: string; horizon?: number; algorithm?: string; test_size?: number }
export interface BacktestDto { item_id: string; test_size?: number }
export interface AlgoMetric { algorithm: string; wape: number | null; mase: number | null; rmse: number | null; bias: number | null; n_test: number }

// Demand ML: build a dense daily demand series from POS sales, backtest every candidate model with a
// walk-forward hold-out (WAPE/MASE/RMSE/bias), auto-select the most accurate, and emit a point forecast for
// the horizon. Each run is persisted (tenant-scoped) so forecast accuracy is auditable over time. This is a
// NEW service — the parity-locked ForecastingService (reorder points) is left untouched.
@Injectable()
export class DemandForecastService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Dense daily demand: sum POS qty per business day, then fill gaps with 0 from the first sale to today.
  private async dailyDemand(itemId: string): Promise<number[]> {
    const db = this.db as any;
    const cutoff = ymd(new Date(Date.now() - LOOKBACK * 86400_000));
    const rows: { d: string; q: string }[] = await db.select({
      d: custPosSales.saleDate, q: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
    }).from(custPosItems).innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosItems.itemId, itemId), ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, cutoff)))
      .groupBy(custPosSales.saleDate).orderBy(custPosSales.saleDate);
    if (!rows.length) return [];
    const byDay = new Map(rows.map((r) => [r.d, Number(r.q)]));
    const start = new Date(rows[0].d);
    const today = new Date(ymd());
    const series: number[] = [];
    for (let t = new Date(start); t <= today; t.setUTCDate(t.getUTCDate() + 1)) {
      series.push(byDay.get(t.toISOString().slice(0, 10)) ?? 0);
    }
    return series;
  }

  // Default hold-out size: a quarter of the series, clamped to [SEASON, 28].
  private testSize(len: number, requested?: number): number {
    if (requested && requested > 0) return Math.min(requested, len - 1);
    return Math.min(28, Math.max(SEASON, Math.floor(len * 0.25)));
  }

  // Backtest every candidate model; return metrics sorted best-WAPE-first.
  private evaluate(series: number[], testSize: number): AlgoMetric[] {
    const out = Object.entries(ALGOS).map(([algorithm, f]: [string, Forecaster]) => {
      const { actual, pred: raw } = walkForward(series, f, testSize);
      // Score the SAME non-negative forecast we deploy (forecast() clamps to ≥ 0), so model selection
      // reflects production behaviour rather than a model's raw (possibly negative) extrapolation.
      const pred = raw.map((x) => Math.max(0, x));
      const train = series.slice(0, series.length - actual.length);
      return {
        algorithm,
        wape: r4(wape(actual, pred)), mase: r4(mase(actual, pred, train, SEASON)),
        rmse: r4(rmse(actual, pred)), bias: r4(bias(actual, pred)), n_test: actual.length,
      };
    });
    out.sort((a, b) => (a.wape ?? Infinity) - (b.wape ?? Infinity));
    return out;
  }

  // Backtest only (no persistence) — model comparison for a planner deciding which to trust.
  async backtest(dto: BacktestDto, _user: JwtUser) {
    const series = await this.dailyDemand(dto.item_id);
    if (series.length < MIN_HISTORY) throw new BadRequestException({ code: 'INSUFFICIENT_HISTORY', message: `Need ≥${MIN_HISTORY} days of demand history`, messageTh: `ต้องมีประวัติอย่างน้อย ${MIN_HISTORY} วัน` });
    const testSize = this.testSize(series.length, dto.test_size);
    const candidates = this.evaluate(series, testSize);
    return { item_id: dto.item_id, data_days: series.length, test_size: testSize, candidates, best: candidates[0] };
  }

  // Forecast: auto-select the best model (or use a pinned one), forecast the horizon, and persist the run.
  async forecast(dto: DemandForecastDto, user: JwtUser) {
    const db = this.db as any;
    const series = await this.dailyDemand(dto.item_id);
    if (series.length < MIN_HISTORY) throw new BadRequestException({ code: 'INSUFFICIENT_HISTORY', message: `Need ≥${MIN_HISTORY} days of demand history`, messageTh: `ต้องมีประวัติอย่างน้อย ${MIN_HISTORY} วัน` });
    const horizon = dto.horizon && dto.horizon > 0 ? Math.min(dto.horizon, 90) : DEFAULT_HORIZON;
    const candidates = this.evaluate(series, this.testSize(series.length, dto.test_size));

    let chosen: AlgoMetric;
    let selectedBy: string;
    if (dto.algorithm) {
      const m = candidates.find((c) => c.algorithm === dto.algorithm);
      if (!m) throw new BadRequestException({ code: 'UNKNOWN_ALGORITHM', message: `Unknown algorithm '${dto.algorithm}'`, messageTh: 'อัลกอริทึมไม่ถูกต้อง' });
      chosen = m; selectedBy = 'requested';
    } else { chosen = candidates[0]; selectedBy = 'lowest_wape'; }

    // demand can't be negative — clamp (Holt can extrapolate below 0 on a declining trend).
    const forecast = ALGOS[chosen.algorithm](series, horizon).map((x) => Math.max(0, r2(x)));

    await db.insert(demandForecasts).values({
      tenantId: user.tenantId, itemId: dto.item_id, algorithm: chosen.algorithm, selectedBy, horizon,
      dataDays: series.length, wape: chosen.wape != null ? String(chosen.wape) : null, mase: chosen.mase != null ? String(chosen.mase) : null,
      rmse: chosen.rmse != null ? String(chosen.rmse) : null, bias: chosen.bias != null ? String(chosen.bias) : null,
      forecast, createdBy: user.username,
    });

    return { item_id: dto.item_id, algorithm: chosen.algorithm, selected_by: selectedBy, horizon, data_days: series.length, forecast, metrics: chosen, candidates };
  }

  async list(_user: JwtUser, limit = 50) {
    const db = this.db as any;
    const lim = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
    const rows = await db.select().from(demandForecasts).orderBy(desc(demandForecasts.createdAt)).limit(lim);
    return { count: rows.length, forecasts: rows };
  }

  // Forecast-accuracy KPI for the analytics plane: average WAPE/MASE across recent persisted runs, overall
  // and per algorithm. Scoped to the caller's tenant by RLS.
  async accuracy(_user: JwtUser) {
    const db = this.db as any;
    const rows: any[] = await db.select().from(demandForecasts).orderBy(desc(demandForecasts.createdAt)).limit(500);
    const num = (x: any) => (x == null ? null : Number(x));
    const avg = (xs: number[]) => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const wapes = rows.map((r) => num(r.wape)).filter((x): x is number => x != null && Number.isFinite(x));
    const mases = rows.map((r) => num(r.mase)).filter((x): x is number => x != null && Number.isFinite(x));
    const byAlgo: Record<string, { runs: number; wapes: number[] }> = {};
    for (const r of rows) { const a = (byAlgo[r.algorithm] ??= { runs: 0, wapes: [] }); a.runs++; const w = num(r.wape); if (w != null && Number.isFinite(w)) a.wapes.push(w); }
    return {
      runs: rows.length, avg_wape: avg(wapes), avg_mase: avg(mases),
      by_algorithm: Object.entries(byAlgo).map(([algorithm, v]) => ({ algorithm, runs: v.runs, avg_wape: avg(v.wapes) })),
    };
  }
}
