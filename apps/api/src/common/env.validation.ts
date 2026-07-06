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

// External observability backends — error-aggregation (Sentry) + distributed tracing (OTel). RECOMMENDED
// in prod but NOT required to boot: the API always emits built-in signals (structured pino logs,
// append-only audit_log, /healthz + /readyz, per-request slow-tx logging, ops-metrics), so it is never
// "silently blind". Operators who need to MANDATE these external backends (e.g. an audited environment)
// opt in with REQUIRE_OBSERVABILITY_BACKENDS=1, which restores the fail-closed boot gate (see below).
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
  // Hybrid tenancy (0196) — TENANCY_MODE selects the Admin RLS-bypass scope. Default 'single-company'
  // (HQ sees ALL tenants — correct for one company with many branches). 'multi-company' scopes an Admin
  // to its own org's tenants and REQUIRES org_id backfilled on tenants + Admin users.
  const tmode = (config.TENANCY_MODE as string | undefined) ?? 'single-company';
  if (tmode !== 'single-company' && tmode !== 'multi-company') {
    logger.warn(`TENANCY_MODE='${tmode}' is invalid — expected 'single-company' | 'multi-company'. Falling back to single-company.`);
  } else if (tmode === 'multi-company') {
    logger.warn('TENANCY_MODE=multi-company — Admin RLS bypass is org-scoped. Ensure tenants.org_id and Admin users.org_id are backfilled, or HQ Admins will see no cross-branch data.');
  }
  // ITGC-AC-18 onboarding/tenancy. In production only the platform owner ("god") opens a company — public
  // self-serve provisioning is disabled (see isSignupAllowed in billing.service). PUBLIC_SIGNUP_ENABLED is
  // now a no-op for provisioning; warn if it is still set so an operator does not assume it re-opens signup.
  const signupOn = ['1', 'true', 'yes', 'on'].includes(String(config.PUBLIC_SIGNUP_ENABLED ?? '').trim().toLowerCase());
  if (signupOn) {
    logger.warn('PUBLIC_SIGNUP_ENABLED is set but has NO effect — public self-service company signup is disabled; only the platform owner (godmimi) provisions companies, via POST /api/admin/tenants, an invite, or by approving a signup-request. Remove the flag. See docs/ops/tenancy-model.md.');
  }
  // Platform owner = "god": a global RLS bypass on every route. Surface how many are configured so a
  // break-glass account is a conscious, visible choice at boot (empty ⇒ nobody, the secure default).
  const gods = String(config.PLATFORM_ADMIN_USERNAMES ?? '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (gods.length) {
    logger.warn(`PLATFORM_ADMIN_USERNAMES configures ${gods.length} platform owner(s) with a cross-tenant "god" bypass (${gods.join(', ')}). Treat as break-glass: MFA those Admin logins and prune unused entries. See docs/ops/tenancy-model.md §2bis.`);
  }
  // AI legal gate (panel #2) — in prod the AI assistant must not transmit tenant data to Anthropic until
  // the DPA is executed. Warn loudly when a key is present but the DPA has not been acknowledged.
  if (has(config.ANTHROPIC_API_KEY) && !has(config.AI_DPA_ACKNOWLEDGED)) {
    logger.warn('ANTHROPIC_API_KEY is set but AI_DPA_ACKNOWLEDGED is not — AI endpoints will fail closed (AI_DPA_REQUIRED) until the signed Anthropic DPA is acknowledged. See docs/legal/data-processing-agreement.md.');
  }
  // Observability posture (ITGC-OP-03). The API ALWAYS emits monitorable signals — structured pino logs
  // (requestId + tenant), the append-only audit_log, /healthz + /readyz probes, per-request slow-tx
  // logging (SLOW_TX_MS), and the admin ops-metrics endpoint — so prod is never "silently blind". External
  // error-aggregation (Sentry) + distributed tracing (OTel) are RECOMMENDED enhancements layered on top,
  // not a boot requirement: a lean deployment can run on the built-in signals alone (no external SaaS).
  //
  // Operators who need to MANDATE the external backends (e.g. an audited environment) opt in with
  // REQUIRE_OBSERVABILITY_BACKENDS=1 → the boot gate then REFUSES to start when Sentry/OTel are unset,
  // still overridable with ALLOW_NO_OBSERVABILITY=1 as a loud, auditable opt-out. Without that flag the
  // absence of external APM is a silent, documented default (no scary boot WARN). See
  // docs/ops/observability-incident.md.
  const lacking = RECOMMENDED_IN_PROD.filter((k) => !has(config[k]));
  if (lacking.length && has(config.REQUIRE_OBSERVABILITY_BACKENDS)) {
    if (has(config.ALLOW_NO_OBSERVABILITY)) {
      logger.warn(
        `Observability backends mandated (REQUIRE_OBSERVABILITY_BACKENDS) but ${lacking.join(', ')} unset — ` +
          `explicitly allowed via ALLOW_NO_OBSERVABILITY. Running on built-in signals ` +
          `(logs / audit_log / healthz+readyz / ops-metrics) only. See docs/ops/observability-incident.md.`,
      );
    } else {
      throw new Error(
        `Refusing to boot: external observability backends are mandated (REQUIRE_OBSERVABILITY_BACKENDS) but ` +
          `${lacking.join(', ')} unset. Wire Sentry + OpenTelemetry, or set ALLOW_NO_OBSERVABILITY=1 to opt ` +
          `out consciously. See docs/ops/observability-incident.md.`,
      );
    }
  }

  return config;
}
