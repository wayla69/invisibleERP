import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateEnv } from '../src/common/env.validation';
import { txStart, txEnd, runtimeMetrics, __resetRuntimeMetrics } from '../src/observability/runtime-metrics';

vi.mock('@sentry/node', () => {
  const scope = { setTag: vi.fn(), setLevel: vi.fn(), setExtras: vi.fn() };
  return {
    init: vi.fn(),
    withScope: vi.fn((fn: (s: typeof scope) => void) => fn(scope)),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    __scope: scope,
  };
});
import * as Sentry from '@sentry/node';
import { captureRequestException } from '../src/observability/instrumentation';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import type { ArgumentsHost } from '@nestjs/common';

// Operational maturity — external observability backends (Sentry/OTel) are RECOMMENDED by default (the API
// always emits built-in signals) and can be MANDATED as a fail-closed boot gate via
// REQUIRE_OBSERVABILITY_BACKENDS (still overridable with a conscious ALLOW_NO_OBSERVABILITY opt-out).
const baseProd = () => ({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://localhost/db',
  JWT_SECRET: 'x'.repeat(32),
  APP_ENC_KEY: 'y'.repeat(32),
  PSP_WEBHOOK_SECRET: 'z'.repeat(16),
  CORS_ORIGINS: 'https://app.example.com', // required in prod (security review M-4) — set so these tests exercise the observability gate, not the CORS check
});

describe('env.validation — observability recommended by default, enforceable on demand', () => {
  it('BOOTS in prod when Sentry/OTel are unset (recommended, not required)', () => {
    expect(() => validateEnv(baseProd())).not.toThrow();
  });
  it('boots when observability is wired', () => {
    expect(() => validateEnv({ ...baseProd(), SENTRY_DSN: 'https://x@sentry.io/1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).not.toThrow();
  });
  it('REFUSES to boot when backends are MANDATED (REQUIRE_OBSERVABILITY_BACKENDS) but unset', () => {
    expect(() => validateEnv({ ...baseProd(), REQUIRE_OBSERVABILITY_BACKENDS: '1' })).toThrow(/observability backends are mandated/i);
  });
  it('allows a CONSCIOUS opt-out via ALLOW_NO_OBSERVABILITY even when mandated', () => {
    expect(() => validateEnv({ ...baseProd(), REQUIRE_OBSERVABILITY_BACKENDS: '1', ALLOW_NO_OBSERVABILITY: '1' })).not.toThrow();
  });
  it('boots when mandated AND wired', () => {
    expect(() => validateEnv({ ...baseProd(), REQUIRE_OBSERVABILITY_BACKENDS: '1', SENTRY_DSN: 'https://x@sentry.io/1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4318' })).not.toThrow();
  });
  it('is a no-op outside production (development / test only)', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow();
  });
  it('M-5: an unknown NODE_ENV is treated as production-strict (fail-closed)', () => {
    // A misspelled / non-standard env must NOT silently skip the required-secret gate.
    for (const env of ['staging', 'prod', 'Production', 'PRODUCTION']) {
      expect(() => validateEnv({ NODE_ENV: env }), env).toThrow(/required production secrets/i);
    }
    // …and a fully-configured non-standard env still boots.
    expect(() => validateEnv({ ...baseProd(), NODE_ENV: 'staging' })).not.toThrow();
  });
  it('still fails first on a missing core secret (observability gate is secondary)', () => {
    const { JWT_SECRET, ...noJwt } = baseProd();
    expect(() => validateEnv(noJwt)).toThrow(/required production secrets/i);
  });
});

// Unhandled 5xx → Sentry forwarding (docs/ops/observability-incident.md §1). The global exception
// filter is the single choke point every unhandled request failure passes through — forwarding there
// means Sentry sees EVERY 500, not only the paths that explicitly call captureOpsAlert.
describe('captureRequestException + AllExceptionsFilter — unhandled 5xx reach Sentry', () => {
  const savedDsn = process.env.SENTRY_DSN;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    if (savedDsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = savedDsn;
  });

  const mockHost = (req: { method: string; url: string }) => {
    const send = vi.fn();
    const res = { status: vi.fn(() => ({ send })) };
    return {
      host: { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost,
      res,
    };
  };

  it('is a silent no-op when SENTRY_DSN is unset', () => {
    delete process.env.SENTRY_DSN;
    expect(() => captureRequestException(new Error('boom'), { method: 'GET', path: '/api/x', status: 500 })).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures with route + status tags when configured', () => {
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    const err = new Error('boom');
    captureRequestException(err, { method: 'GET', path: '/api/x', status: 500 });
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    const scope = (Sentry as unknown as { __scope: { setTag: ReturnType<typeof vi.fn> } }).__scope;
    expect(scope.setTag).toHaveBeenCalledWith('route', 'GET /api/x');
    expect(scope.setTag).toHaveBeenCalledWith('http_status', '500');
  });

  it('filter forwards an unhandled Error (500) to Sentry with the query string stripped', () => {
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    const err = new Error('unexpected');
    const { host, res } = mockHost({ method: 'POST', url: '/api/ledger/journal?token=secret' });
    new AllExceptionsFilter().catch(err, host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(err);
    const scope = (Sentry as unknown as { __scope: { setTag: ReturnType<typeof vi.fn> } }).__scope;
    expect(scope.setTag).toHaveBeenCalledWith('route', 'POST /api/ledger/journal');
  });

  it('filter does NOT forward expected 4xx business outcomes', async () => {
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    const { NotFoundException } = await import('@nestjs/common');
    const { host, res } = mockHost({ method: 'GET', url: '/api/items/9' });
    new AllExceptionsFilter().catch(new NotFoundException(), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
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
