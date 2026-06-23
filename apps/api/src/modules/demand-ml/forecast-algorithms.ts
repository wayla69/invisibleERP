// Phase D4 — demand forecasting algorithms + accuracy metrics (pure, dependency-free so they run anywhere,
// including the PGlite CI harness). A Forecaster takes the demand history and a horizon and returns that many
// point forecasts. Algorithms are deliberately classic and explainable (no opaque ML) for audit.

export type Forecaster = (history: number[], horizon: number) => number[];

export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Simple moving average — average of the last `window` points, held flat across the horizon.
export const sma = (window = 7): Forecaster => (h, hz) => {
  const w = h.slice(-window);
  return Array(hz).fill(w.length ? mean(w) : 0);
};

// Simple exponential smoothing — recursively smoothed level (recent points weighted more), flat forecast.
export const ses = (alpha = 0.3): Forecaster => (h, hz) => {
  if (!h.length) return Array(hz).fill(0);
  let level = h[0];
  for (let i = 1; i < h.length; i++) level = alpha * h[i] + (1 - alpha) * level;
  return Array(hz).fill(level);
};

// Holt's linear trend (double exponential smoothing) — level + trend, extrapolated over the horizon.
export const holt = (alpha = 0.4, beta = 0.1): Forecaster => (h, hz) => {
  if (h.length < 2) return Array(hz).fill(h[0] ?? 0);
  let level = h[0];
  let trend = h[1] - h[0];
  for (let i = 1; i < h.length; i++) {
    const prev = level;
    level = alpha * h[i] + (1 - alpha) * (level + trend);
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

// The candidate model set, keyed by name. Auto-selection picks the lowest-WAPE entry.
export const ALGOS: Record<string, Forecaster> = {
  sma: sma(7),
  ses: ses(0.3),
  holt: holt(0.4, 0.1),
  seasonal_naive: seasonalNaive(7),
  croston: croston(0.1),
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
  for (let i = period; i < train.length; i++) { diffSum += Math.abs(train[i] - train[i - period]); diffCount++; }
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
export function walkForward(series: number[], f: Forecaster, testSize: number): { actual: number[]; pred: number[] } {
  const start = Math.max(1, series.length - testSize);
  const actual: number[] = [];
  const pred: number[] = [];
  for (let t = start; t < series.length; t++) {
    pred.push(f(series.slice(0, t), 1)[0]);
    actual.push(series[t]);
  }
  return { actual, pred };
}
