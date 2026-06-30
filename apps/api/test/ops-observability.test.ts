import { describe, it, expect } from 'vitest';
import { validateEnv } from '../src/common/env.validation';
import { txStart, txEnd, runtimeMetrics, __resetRuntimeMetrics } from '../src/observability/runtime-metrics';

// Operational maturity — Step 2: observability is fail-closed in prod, with an explicit opt-out.
const baseProd = () => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SECRET: 'x'.repeat(32),
  APP_ENC_KEY: 'y'.repeat(32),
  PSP_WEBHOOK_SECRET: 'z'.repeat(16),
});

describe('env.validation — observability is fail-closed in prod', () => {
  it('REFUSES to boot in prod when Sentry/OTel are unset', () => {
    expect(() => validateEnv(baseProd())).toThrow(/observability not configured/i);
  });
  it('boots when observability is wired', () => {
    expect(() => validateEnv({ ...baseProd(), SENTRY_DSN: 'https://x@sentry.io/1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).not.toThrow();
  });
  it('allows a CONSCIOUS opt-out via ALLOW_NO_OBSERVABILITY', () => {
    expect(() => validateEnv({ ...baseProd(), ALLOW_NO_OBSERVABILITY: '1' })).not.toThrow();
  });
  it('is a no-op outside production', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
  });
  it('still fails first on a missing core secret (observability gate is secondary)', () => {
    const { JWT_SECRET, ...noJwt } = baseProd();
    expect(() => validateEnv(noJwt)).toThrow(/required production secrets/i);
  });
});

describe('runtime-metrics — in-flight gauge + slow-tx counter', () => {
  it('tracks in-flight, peak, and slow counts', () => {
    __resetRuntimeMetrics();
    txStart(); txStart();
    expect(runtimeMetrics().in_flight_tx).toBe(2);
    txEnd(50, 1000);   // fast
    txEnd(1500, 1000); // slow
    const m = runtimeMetrics();
    expect(m.in_flight_tx).toBe(0);
    expect(m.peak_in_flight_tx).toBe(2);
    expect(m.slow_tx_count).toBe(1);
    expect(m.total_tx).toBe(2);
  });

  it('raises a saturation event when in-flight crosses the pool threshold (debounced)', () => {
    const saved = process.env.DB_POOL_MAX;
    process.env.DB_POOL_MAX = '4'; // threshold 80% → fires at 4 in-flight
    try {
      __resetRuntimeMetrics();
      for (let i = 0; i < 3; i++) txStart();
      expect(runtimeMetrics().saturation_events).toBe(0); // 3/4 = 75% < 80%
      txStart(); // 4/4 = 100% → crosses
      expect(runtimeMetrics().saturation_events).toBe(1);
      txStart(); // still saturated → debounced, no new event
      expect(runtimeMetrics().saturation_events).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = saved;
      __resetRuntimeMetrics();
    }
  });
});
