// OpenTelemetry tracing + Sentry error reporting.
// Both are OPT-IN via env so they never break boot when unconfigured.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';
import { logger } from './logger';

let sdk: NodeSDK | null = null;

// Operational alert sink (ITGC-OP-04 — batch-job/operational monitoring). Emits a single structured
// error-level log line (alertable via the log pipeline: a rule on `alert:"ops"` / `event` routes to
// on-call) AND, when Sentry is configured, captures it there for triage. Use for operator-facing
// conditions that need attention but aren't tied to one tenant — e.g. a dead-lettered background job or a
// reaped zombie. Never throws: alerting must not break the path that raised the alert.
export function captureOpsAlert(event: string, detail: Record<string, unknown> = {}, err?: unknown): void {
  try {
    logger.error({ alert: 'ops', event, ...detail, err: err instanceof Error ? err.message : err }, `OPS ALERT: ${event}`);
  } catch { /* logging must never throw */ }
  try {
    if (!process.env.SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      scope.setTag('ops_event', event);
      scope.setLevel('error');
      scope.setExtras(detail as Record<string, unknown>);
      if (err instanceof Error) Sentry.captureException(err);
      else Sentry.captureMessage(`ops:${event}`);
    });
  } catch { /* Sentry must never block the caller */ }
}

// Forward an unhandled request failure (any 5xx the global exception filter is about to return) to
// Sentry with route context. Sentry-only — the filter already writes the server-side log line, so this
// must NOT double-log. Never throws: error reporting must never break the error response itself.
export function captureRequestException(err: unknown, ctx: { method?: string; path?: string; status?: number } = {}): void {
  try {
    if (!process.env.SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      scope.setLevel('error');
      if (ctx.method || ctx.path) scope.setTag('route', `${ctx.method ?? ''} ${ctx.path ?? ''}`.trim());
      if (ctx.status !== undefined) scope.setTag('http_status', String(ctx.status));
      if (err instanceof Error) Sentry.captureException(err);
      else Sentry.captureMessage(String(err));
    });
  } catch { /* Sentry must never block the response path */ }
}

// Init OTel NodeSDK with OTLP/HTTP exporter + HTTP/PG instrumentations.
// No-op (and never throws) if OTEL_EXPORTER_OTLP_ENDPOINT is unset.
export function startTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return; // tracing disabled — keep boot safe
  if (sdk) return; // idempotent
  try {
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'ierp-api',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION ?? '2.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
    });
    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      instrumentations: [
        new HttpInstrumentation(),
        new PgInstrumentation(),
      ],
    });
    sdk.start();
  } catch {
    // Never let observability wiring crash the API.
    sdk = null;
  }
}

// Init Sentry only if SENTRY_DSN is set. Safe no-op otherwise.
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.APP_VERSION,
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    });
  } catch {
    // ignore — Sentry must never block boot
  }
}

// Optional graceful shutdown hook (orchestrator may call on SIGTERM).
export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  } finally {
    sdk = null;
  }
}
