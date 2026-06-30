// In-process runtime gauges for the ops-metrics surface (operational maturity / capacity visibility).
// These are cheap, per-process counters — NOT a substitute for OTel/pgbouncer metrics, but they give an
// at-a-glance signal of DB-connection pressure and slow paths without any external system. The
// TenantTxInterceptor brackets every request's tenant transaction with txStart/txEnd; the metrics
// endpoint reads runtimeMetrics() alongside the configured pool size to show saturation.
import { logger as pino } from './logger';

let inFlightTx = 0;     // requests currently holding a tenant DB transaction
let peakInFlightTx = 0; // high-water mark since boot (a proxy for pool-pressure peaks)
let slowTxCount = 0;    // requests whose DB transaction exceeded SLOW_TX_MS
let totalTx = 0;        // total bracketed transactions since boot
let saturationEvents = 0; // times in-flight crossed the saturation threshold (proactive pool-pressure signal)
let warnedSaturated = false; // hysteresis: warn once per crossing, reset when it drops well below

const poolMax = () => Number(process.env.DB_POOL_MAX ?? 20);
const satPct = () => Number(process.env.POOL_SATURATION_WARN_PCT ?? 80);

export function txStart(): void {
  inFlightTx++;
  if (inFlightTx > peakInFlightTx) peakInFlightTx = inFlightTx;
  // Proactive saturation alert: when in-flight transactions cross POOL_SATURATION_WARN_PCT of the pool,
  // log a single alertable warning (debounced with hysteresis) — pool exhaustion is the #1 latency cliff
  // (the audit's ~400 rps wall) and shouldn't first surface as user-facing timeouts.
  const max = poolMax();
  const pct = max > 0 ? (inFlightTx / max) * 100 : 0;
  if (pct >= satPct() && !warnedSaturated) {
    warnedSaturated = true;
    saturationEvents++;
    pino.warn({ event: 'pool_saturation', in_flight: inFlightTx, pool_max: max, pct: Math.round(pct) }, 'DB pool nearing saturation');
  } else if (pct < satPct() * 0.7) {
    warnedSaturated = false; // recovered well below the line — re-arm the warning
  }
}

export function txEnd(durationMs: number, slowMs: number): void {
  if (inFlightTx > 0) inFlightTx--;
  totalTx++;
  if (durationMs >= slowMs) slowTxCount++;
}

export function runtimeMetrics(): {
  in_flight_tx: number; peak_in_flight_tx: number; slow_tx_count: number; total_tx: number; saturation_events: number;
} {
  return { in_flight_tx: inFlightTx, peak_in_flight_tx: peakInFlightTx, slow_tx_count: slowTxCount, total_tx: totalTx, saturation_events: saturationEvents };
}

// Test-only reset (harnesses assert deltas).
export function __resetRuntimeMetrics(): void {
  inFlightTx = 0; peakInFlightTx = 0; slowTxCount = 0; totalTx = 0; saturationEvents = 0; warnedSaturated = false;
}
