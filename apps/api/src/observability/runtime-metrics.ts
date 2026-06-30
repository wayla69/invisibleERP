// In-process runtime gauges for the ops-metrics surface (operational maturity / capacity visibility).
// These are cheap, per-process counters — NOT a substitute for OTel/pgbouncer metrics, but they give an
// at-a-glance signal of DB-connection pressure and slow paths without any external system. The
// TenantTxInterceptor brackets every request's tenant transaction with txStart/txEnd; the metrics
// endpoint reads snapshot() alongside the configured pool size to show saturation.

let inFlightTx = 0;     // requests currently holding a tenant DB transaction
let peakInFlightTx = 0; // high-water mark since boot (a proxy for pool-pressure peaks)
let slowTxCount = 0;    // requests whose DB transaction exceeded SLOW_TX_MS
let totalTx = 0;        // total bracketed transactions since boot

export function txStart(): void {
  inFlightTx++;
  if (inFlightTx > peakInFlightTx) peakInFlightTx = inFlightTx;
}

export function txEnd(durationMs: number, slowMs: number): void {
  if (inFlightTx > 0) inFlightTx--;
  totalTx++;
  if (durationMs >= slowMs) slowTxCount++;
}

export function runtimeMetrics(): {
  in_flight_tx: number; peak_in_flight_tx: number; slow_tx_count: number; total_tx: number;
} {
  return { in_flight_tx: inFlightTx, peak_in_flight_tx: peakInFlightTx, slow_tx_count: slowTxCount, total_tx: totalTx };
}

// Test-only reset (harnesses assert deltas).
export function __resetRuntimeMetrics(): void {
  inFlightTx = 0; peakInFlightTx = 0; slowTxCount = 0; totalTx = 0;
}
