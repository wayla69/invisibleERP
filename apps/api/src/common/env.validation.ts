// ITGC-AC-12 — centralized, fail-closed environment/secret validation.
// Wired into ConfigModule.forRoot({ validate }) so the API refuses to boot in PRODUCTION when a
// required secret is missing, instead of failing later per-request (or, worse, silently falling back
// to an insecure default). Individual modules keep their own guards (JWT_SECRET in auth.module,
// APP_ENC_KEY in crypto.ts, PSP secret in the webhook); this is the single front-door assertion that
// makes a misconfigured prod deploy crash early and loudly.
//
// Only enforced when NODE_ENV==='production'. In development/test (and the PGlite harnesses, which run
// as NODE_ENV==='test') it is a no-op that returns the config unchanged, so nothing here can break CI.

import { Logger } from '@nestjs/common';

// Secrets with no safe default — production MUST provide them.
const REQUIRED_IN_PROD = ['DATABASE_URL', 'JWT_SECRET', 'APP_ENC_KEY'] as const;

// Observability is strongly recommended in prod but must not block boot (the orchestrator may inject
// it late). We warn rather than throw so a transient gap doesn't take the service down.
const RECOMMENDED_IN_PROD = ['SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT'] as const;

function has(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const env = (config.NODE_ENV as string | undefined) ?? 'development';
  if (env !== 'production') return config; // dev/test: no-op (keeps harnesses + local dev green)

  const logger = new Logger('EnvValidation');
  const missing = REQUIRED_IN_PROD.filter((k) => !has(config[k]));

  // A PSP webhook secret is required so the public payment webhook can verify signatures (fail-closed
  // in prod, mirroring channel-order/pos-terminal). Accept the base key or any per-provider override.
  const hasPspSecret =
    has(config.PSP_WEBHOOK_SECRET) ||
    Object.keys(config).some((k) => k.startsWith('PSP_WEBHOOK_SECRET_') && has(config[k]));
  if (!hasPspSecret) missing.push('PSP_WEBHOOK_SECRET' as (typeof REQUIRED_IN_PROD)[number]);

  if (missing.length) {
    throw new Error(
      `Refusing to boot: missing required production secrets: ${missing.join(', ')}. ` +
        `Set them via your secret store (see docs/ops/secrets.md). No insecure defaults outside dev/test.`,
    );
  }

  if (has(config.DATABASE_URL) && (config.DATABASE_URL as string).startsWith('postgres://')) {
    logger.warn('DATABASE_URL uses postgres:// — prefer postgresql:// (V1 parity note).');
  }
  if (!has(config.CORS_ORIGINS)) {
    logger.warn('CORS_ORIGINS not set — defaulting to http://localhost:3000, which is wrong for prod.');
  }
  const lacking = RECOMMENDED_IN_PROD.filter((k) => !has(config[k]));
  if (lacking.length) {
    logger.warn(
      `Observability not fully configured in production (${lacking.join(', ')} unset) — ` +
        `running with reduced visibility. See docs/ops/observability-incident.md.`,
    );
  }

  return config;
}
