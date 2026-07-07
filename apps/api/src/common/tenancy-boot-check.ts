// Wave 2 · 4.2 — tenancy data-isolation boot check.
// The default TENANCY_MODE=single-company gives EVERY tenant Admin a GLOBAL RLS bypass ("HQ sees all") —
// correct for ONE company with many branches, but a cross-tenant DATA LEAK if several separate companies
// (tenants) are ever run on the same DB in this mode. env.validation warns on config; this check detects
// the actually-dangerous STATE (multiple companies + single-company mode) using the live tenant count.
//
// Safe by default: it LOGS a loud error but still boots (never bricks an existing prod on a heuristic).
// Set STRICT_TENANCY_BOOT=1 to make it fail-closed (refuse to boot) once you've confirmed the intended mode.
// Only meaningful in production; dev/test (and PGlite harnesses) are a no-op.

export type TenancyBootLevel = 'ok' | 'warn' | 'refuse';

// Pure decision — no I/O, unit-testable. `strict` upgrades the dangerous case from warn → refuse.
export function evaluateTenancyBootRisk(input: { mode: string; tenantCount: number; strict: boolean }): { level: TenancyBootLevel; message: string } {
  if (input.mode === 'multi-company') {
    return { level: 'ok', message: 'TENANCY_MODE=multi-company — Admin RLS bypass is org-scoped; per-company isolation holds.' };
  }
  // single-company (or an invalid value, which env.validation falls back to single-company).
  if (input.tenantCount <= 1) {
    return { level: 'ok', message: `TENANCY_MODE=single-company with ${input.tenantCount} tenant — single company, global Admin bypass is safe.` };
  }
  const message =
    `DATA-ISOLATION RISK: TENANCY_MODE=single-company but ${input.tenantCount} tenants (separate companies) exist on this DB. ` +
    `In single-company mode EVERY tenant Admin has a GLOBAL RLS bypass and can read ALL companies' data. ` +
    `Fix: set TENANCY_MODE=multi-company on every API service on this DB (and backfill tenants.org_id / Admin users.org_id), ` +
    `or consolidate to a single tenant. See docs/ops/tenancy-model.md. (Set STRICT_TENANCY_BOOT=1 to make this fail-closed.)`;
  return { level: input.strict ? 'refuse' : 'warn', message };
}

// Boot-time assertion. Best-effort: a DB-read failure NEVER blocks boot (returns quietly); only an
// evaluated `refuse` (strict mode + multiple companies in single-company mode) throws.
export async function assertTenancyBootSafe(opts: {
  isProd: boolean;
  mode: string;
  strict: boolean;
  countTenants: () => Promise<number>;
  logger: { warn: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  if (!opts.isProd) return; // dev/test/harnesses: no-op
  let tenantCount: number;
  try {
    tenantCount = await opts.countTenants();
  } catch {
    return; // never block boot on a read error — this is a safety net, not a hard dependency
  }
  const res = evaluateTenancyBootRisk({ mode: opts.mode, tenantCount, strict: opts.strict });
  if (res.level === 'ok') return;
  if (res.level === 'warn') {
    opts.logger.error(res.message);
    return;
  }
  throw new Error(`Refusing to boot: ${res.message}`);
}

// Parse the strict-mode flag consistently with the rest of the codebase.
export function strictTenancyBoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(env.STRICT_TENANCY_BOOT ?? '').trim().toLowerCase());
}
