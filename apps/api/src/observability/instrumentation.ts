// OpenTelemetry tracing + Sentry error reporting.
// Both are OPT-IN via env so they never break boot when unconfigured.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';

let sdk: NodeSDK | null = null;

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
