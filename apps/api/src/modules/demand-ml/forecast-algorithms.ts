// Phase D4 — demand forecasting algorithms + accuracy metrics (pure, dependency-free so they run anywhere,
// including the PGlite CI harness). A Forecaster takes the demand history and a horizon and returns that many
// point forecasts. Algorithms are deliberately classic and explainable (no opaque ML) for audit.

// Optional date context (docs/27 R4-3 remainder): `lastDate` is the ISO date of the LAST history point.
// Date-blind models ignore it; calendar-aware models (th_holiday) use it to place each point on the Thai
// calendar. walkForward shifts it per fold so backtests stay honest.
// `rainDates` (docs/45 residual — weather overlay): ISO dates (YYYY-MM-DD) flagged rainy by an external
// provider (common/weather-provider.ts, Open-Meteo, opt-in), covering BOTH the history window and the
// forecast horizon. Absolute dates, not fold-relative — unlike `lastDate` it needs no per-fold shift.
export interface ForecastContext { lastDate?: string; rainDates?: Set<string> }

export type Forecaster = (history: number[], horizon: number, ctx?: ForecastContext) => number[];

export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Simple moving average — average of the last `window` points, held flat across the horizon.
export const sma = (window = 7): Forecaster => (h, hz) => {
  const w = h.slice(-window);
  return Array(hz).fill(w.length ? mean(w) : 0);
};

// Simple exponential smoothing — recursively smoothed level (recent points weighted more), flat forecast.
export const ses = (alpha = 0.3): Forecaster => (h, hz) => {
  if (!h.length) return Array(hz).fill(0);
  let level = h[0]!;
  for (let i = 1; i < h.length; i++) level = alpha * h[i]! + (1 - alpha) * level;
  return Array(hz).fill(level);
};

// Holt's linear trend (double exponential smoothing) — level + trend, extrapolated over the horizon.
export const holt = (alpha = 0.4, beta = 0.1): Forecaster => (h, hz) => {
  if (h.length < 2) return Array(hz).fill(h[0] ?? 0);
  let level = h[0]!;
  let trend = h[1]! - h[0]!;
  for (let i = 1; i < h.length; i++) {
    const prev = level;
    level = alpha * h[i]! + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return Array.from({ length: hz }, (_, k) => level + (k + 1) * trend);
};

// Seasonal naive — repeat the value observed one season (`period`) ago; falls back to the mean if the
// history is shorter than a full season.
export const seasonalNaive = (period = 7): Forecaster => (h, hz) => {
  if (h.length < period) return Array(hz).fill(h.length ? mean(h) : 0);
  return Array.from({ length: hz }, (_, k) => h[h.length - period + (k % period)]);
};

// Croston's method for intermittent demand — separately smooth the non-zero demand size (z) and the
// inter-arrival interval (x); the forecast is the stable rate z / x, held flat. Robust to the many zeros
// that make SMA jumpy and MAPE undefined.
export const croston = (alpha = 0.1): Forecaster => (h, hz) => {
  let z = 0;   // smoothed demand size
  let x = 1;   // smoothed interval
  let gap = 0; // periods since the previous demand
  let n = 0;   // number of demands seen
  for (const d of h) {
    gap++;
    if (d > 0) {
      n++;
      if (n === 1) z = d;                                  // first size; the interval isn't known yet
      else if (n === 2) { z = alpha * d + (1 - alpha) * z; x = gap; } // first real inter-arrival
      else { z = alpha * d + (1 - alpha) * z; x = alpha * gap + (1 - alpha) * x; }
      gap = 0;
    }
  }
  const rate = n >= 2 && x > 0 ? z / x : 0;
  return Array(hz).fill(rate);
};

// Croston–SBA (Syntetos–Boylan approximation) — Croston's rate is biased HIGH for intermittent demand;
// SBA applies the (1 − α/2) correction. Same inputs, same explainability (docs/27 R4-3).
export const crostonSba = (alpha = 0.1): Forecaster => (h, hz) => {
  const base = croston(alpha)(h, hz);
  const k = 1 - alpha / 2;
  return base.map((v) => v * k);
};

// Multiplicative day-of-week seasonality (docs/27 R4-3 / AUD-AI-03): learn a per-position factor over a
// weekly cycle (position = index mod period, so forecast step k continues the cycle at
// (history.length + k) mod period), deseasonalize, smooth the level with SES, then re-apply the factor.
// This is the dominant restaurant demand pattern the flat models miss (weekend ≫ weekday). Still classic,
// dependency-free and explainable — auto-selection only picks it when it WINS the walk-forward backtest.
// (The calendar-holiday variant ships as th_holiday below — docs/27 R4-3.)
export const dowSeasonal = (alpha = 0.3, period = 7): Forecaster => (h, hz) => {
  if (h.length < period * 2) return ses(alpha)(h, hz);
  const overall = mean(h);
  if (overall <= 0) return Array(hz).fill(0);
  const sums = Array(period).fill(0);
  const counts = Array(period).fill(0);
  for (let i = 0; i < h.length; i++) { sums[i % period] += h[i]!; counts[i % period]++; }
  const factors = sums.map((sm, p) => (counts[p] ? sm / counts[p] / overall : 1)).map((f) => (f > 0 ? f : 1));
  let level = h[0]! / factors[0]!;
  for (let i = 1; i < h.length; i++) level = alpha * (h[i]! / factors[i % period]!) + (1 - alpha) * level;
  return Array.from({ length: hz }, (_, k) => Math.max(0, level * factors[(h.length + k) % period]!));
};

// Fixed-date Thai public holidays (MM-DD). Deliberately FIXED-DATE ONLY — the lunar Buddhist holidays
// (Makha/Visakha/Asalha Bucha) move year-to-year and would need a real calendar table; documented scope.
export const TH_FIXED_HOLIDAYS = new Set([
  '01-01',                    // วันขึ้นปีใหม่
  '04-06',                    // วันจักรี
  '04-13', '04-14', '04-15',  // สงกรานต์
  '05-01',                    // วันแรงงาน
  '05-04',                    // วันฉัตรมงคล
  '07-28',                    // วันเฉลิมพระชนมพรรษา ร.10
  '08-12',                    // วันแม่แห่งชาติ
  '10-13',                    // วันคล้ายวันสวรรคต ร.9
  '10-23',                    // วันปิยมหาราช
  '12-05',                    // วันพ่อแห่งชาติ
  '12-10',                    // วันรัฐธรรมนูญ
  '12-31',                    // วันสิ้นปี
]);
export function addDaysYmd(ymdStr: string, days: number): string {
  const d = new Date(`${ymdStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isThHoliday = (ymdStr: string) => TH_FIXED_HOLIDAYS.has(ymdStr.slice(5));

// Thai-calendar holiday model (docs/27 R4-3 / AUD-AI-03 — the Songkran gap): day-of-week factors learned
// from NON-holiday days × a multiplicative holiday uplift learned from the holidays observed in-window
// (needs ≥2 observations, else factor 1), applied to future dates that land on a fixed Thai holiday.
// Without date context it degrades to dowSeasonal — and auto-selection only ever picks it when it WINS
// the walk-forward backtest.
export const thaiHoliday = (alpha = 0.3, period = 7): Forecaster => (h, hz, ctx) => {
  if (!ctx?.lastDate || h.length < period * 2) return dowSeasonal(alpha, period)(h, hz, ctx);
  const dates = h.map((_, i) => addDaysYmd(ctx.lastDate as string, i - (h.length - 1)));
  const hol = h.filter((_, i) => isThHoliday(dates[i]!));
  const nonHol = h.filter((_, i) => !isThHoliday(dates[i]!));
  const base = mean(nonHol.length ? nonHol : h);
  if (base <= 0) return Array(hz).fill(0);
  const holFactor = hol.length >= 2 ? Math.max(0.1, mean(hol) / base) : 1;
  // DOW factors + SES level from non-holiday days only (a holiday spike must not contaminate its weekday).
  const sums = Array(period).fill(0);
  const counts = Array(period).fill(0);
  for (let i = 0; i < h.length; i++) { if (isThHoliday(dates[i]!)) continue; sums[i % period] += h[i]!; counts[i % period]++; }
  const factors = sums.map((sm, p) => (counts[p] ? sm / counts[p] / base : 1)).map((f) => (f > 0 ? f : 1));
  let level = 0; let init = false;
  for (let i = 0; i < h.length; i++) {
    if (isThHoliday(dates[i]!)) continue;
    const d = h[i]! / factors[i % period]!;
    if (!init) { level = d; init = true; } else level = alpha * d + (1 - alpha) * level;
  }
  if (!init) return dowSeasonal(alpha, period)(h, hz, ctx);
  return Array.from({ length: hz }, (_, k) => {
    const date = addDaysYmd(ctx.lastDate as string, k + 1);
    return Math.max(0, level * factors[(h.length + k) % period]! * (isThHoliday(date) ? holFactor : 1));
  });
};

// Weather-overlay demand model (docs/45 residual — G3 follow-up to the marketing-strategy roadmap):
// structurally identical to thaiHoliday above — day-of-week factors + SES level learned from NON-rain days
// × a multiplicative uplift/dip learned from the rain days observed in-window (≥2 observations required,
// else factor 1) — but keyed off a REAL rain signal (`ctx.rainDates`, common/weather-provider.ts,
// Open-Meteo, opt-in via DEMAND_WEATHER_ENABLED) instead of a fixed calendar. Degrades to dowSeasonal
// without a rain-date context (unconfigured/disabled/geocode-miss/fetch-failure all land here — never a
// fabricated signal); auto-selection only ever picks it when it WINS the walk-forward backtest.
export const weatherOverlay = (alpha = 0.3, period = 7): Forecaster => (h, hz, ctx) => {
  if (!ctx?.lastDate || !ctx.rainDates?.size || h.length < period * 2) return dowSeasonal(alpha, period)(h, hz, ctx);
  const rainDates = ctx.rainDates;
  const dates = h.map((_, i) => addDaysYmd(ctx.lastDate as string, i - (h.length - 1)));
  const rain = h.filter((_, i) => rainDates.has(dates[i]!));
  const dry = h.filter((_, i) => !rainDates.has(dates[i]!));
  const base = mean(dry.length ? dry : h);
  if (base <= 0) return Array(hz).fill(0);
  const rainFactor = rain.length >= 2 ? Math.max(0.1, mean(rain) / base) : 1;
  // DOW factors + SES level from dry days only (a rain-day dip must not contaminate its weekday factor).
  const sums = Array(period).fill(0);
  const counts = Array(period).fill(0);
  for (let i = 0; i < h.length; i++) { if (rainDates.has(dates[i]!)) continue; sums[i % period] += h[i]!; counts[i % period]++; }
  const factors = sums.map((sm, p) => (counts[p] ? sm / counts[p] / base : 1)).map((f) => (f > 0 ? f : 1));
  let level = 0; let init = false;
  for (let i = 0; i < h.length; i++) {
    if (rainDates.has(dates[i]!)) continue;
    const d = h[i]! / factors[i % period]!;
    if (!init) { level = d; init = true; } else level = alpha * d + (1 - alpha) * level;
  }
  if (!init) return dowSeasonal(alpha, period)(h, hz, ctx);
  return Array.from({ length: hz }, (_, k) => {
    const date = addDaysYmd(ctx.lastDate as string, k + 1);
    return Math.max(0, level * factors[(h.length + k) % period]! * (rainDates.has(date) ? rainFactor : 1));
  });
};

// The candidate model set, keyed by name. Auto-selection picks the lowest-WAPE entry.
export const ALGOS: Record<string, Forecaster> = {
  sma: sma(7),
  ses: ses(0.3),
  holt: holt(0.4, 0.1),
  seasonal_naive: seasonalNaive(7),
  croston: croston(0.1),
  croston_sba: crostonSba(0.1),
  dow_seasonal: dowSeasonal(0.3, 7),
  th_holiday: thaiHoliday(0.3, 7),
  weather: weatherOverlay(0.3, 7),
};

// ── accuracy metrics ──

// WAPE — weighted absolute percentage error = Σ|actual − forecast| / Σ|actual|. Scale-free and, unlike
// MAPE, well-defined when individual actuals are zero (only the total must be non-zero).
export function wape(actual: number[], forecast: number[]): number {
  const denom = actual.reduce((s, a) => s + Math.abs(a), 0);
  const num = actual.reduce((s, a, i) => s + Math.abs(a - (forecast[i] ?? 0)), 0);
  return denom > 0 ? num / denom : num > 0 ? Infinity : 0;
}

// MASE — mean absolute scaled error = test MAE / in-sample seasonal-naive MAE. < 1 beats the naive
// baseline; > 1 is worse than naive. `period` is the seasonal lag of the naive benchmark.
export function mase(actual: number[], forecast: number[], train: number[], period = 1): number {
  const mae = actual.length ? actual.reduce((s, a, i) => s + Math.abs(a - (forecast[i] ?? 0)), 0) / actual.length : 0;
  let diffSum = 0;
  let diffCount = 0;
  for (let i = period; i < train.length; i++) { diffSum += Math.abs(train[i]! - train[i - period]!); diffCount++; }
  const naiveMae = diffCount > 0 ? diffSum / diffCount : 0;
  return naiveMae > 0 ? mae / naiveMae : mae > 0 ? Infinity : 0;
}

export function rmse(actual: number[], forecast: number[]): number {
  if (!actual.length) return 0;
  return Math.sqrt(actual.reduce((s, a, i) => s + (a - (forecast[i] ?? 0)) ** 2, 0) / actual.length);
}

// Forecast bias — mean (forecast − actual); positive = over-forecasting, negative = under-forecasting.
export function bias(actual: number[], forecast: number[]): number {
  if (!actual.length) return 0;
  return actual.reduce((s, a, i) => s + ((forecast[i] ?? 0) - a), 0) / actual.length;
}

// Walk-forward (rolling-origin) one-step-ahead backtest over the last `testSize` points: for each test
// point, refit on all history up to it and forecast a single step, then compare to the held-out actual.
export function walkForward(series: number[], f: Forecaster, testSize: number, ctx?: ForecastContext): { actual: number[]; pred: number[] } {
  const start = Math.max(1, series.length - testSize);
  const actual: number[] = [];
  const pred: number[] = [];
  for (let t = start; t < series.length; t++) {
    // Per-fold date shift: the fold's history is series[0..t), whose last point sits (series.length - t)
    // days BEFORE the full series' lastDate — calendar-aware models must not see the future's dates.
    // rainDates is a set of ABSOLUTE dates (not fold-relative), so it carries through unshifted.
    const foldCtx = ctx?.lastDate ? { lastDate: addDaysYmd(ctx.lastDate, t - series.length), rainDates: ctx.rainDates } : undefined;
    pred.push(f(series.slice(0, t), 1, foldCtx)[0]!);
    actual.push(series[t]!);
  }
  return { actual, pred };
}
