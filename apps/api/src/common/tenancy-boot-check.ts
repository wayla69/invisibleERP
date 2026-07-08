// Wave 2 · 4.2 — tenancy data-isolation boot checks.
//
// Two production boot-time safety checks live here; both are pure-decision + thin async wrapper, and both
// are a NO-OP outside production (dev/test/PGlite harnesses).
//
//  (H-4) TENANCY MODE — TENANCY_MODE=single-company gives EVERY tenant Admin a GLOBAL RLS bypass ("HQ sees
//        all"), correct for ONE company with many branches but a cross-tenant DATA LEAK if several separate
//        companies (tenants) run on the same DB in this mode. This detects the actually-dangerous STATE
//        (multiple companies + single-company mode) from the live tenant count and, in production, now
//        REFUSES TO BOOT BY DEFAULT (was warn-only — security review H-4). Opt out with
//        ALLOW_SINGLE_COMPANY_MULTI_TENANT=1 to downgrade to a loud warning (NOT recommended).
//
//  (H-3) RLS BACKSTOP — RLS is enforced only INSIDE the per-request `SET LOCAL ROLE app_user` transaction.
//        Every @NoTx handler, SSE stream, raw-client query and background job runs on the base connection.
//        If that base connection role is a SUPERUSER or has BYPASSRLS (the managed-Postgres default), RLS is
//        NOT enforced there and those paths rely entirely on hand-written tenant filters — one omission is a
//        cross-tenant leak. This probes the base role and, in production, REFUSES TO BOOT BY DEFAULT when it
//        bypasses RLS. Opt out with ALLOW_RLS_BYPASS_BASE_ROLE=1 (NOT recommended). Fix properly by connecting
//        as a dedicated non-superuser, non-BYPASSRLS owner role — see docs/ops/tenancy-model.md.

export type TenancyBootLevel = 'ok' | 'warn' | 'refuse';

const truthy = (v: unknown): boolean => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

// ── H-4: tenancy-mode risk ──────────────────────────────────────────────────────────────────────────
// Pure decision — no I/O, unit-testable. `allowOptOut` downgrades the dangerous case from refuse → warn.
export function evaluateTenancyBootRisk(input: { mode: string; tenantCount: number; allowOptOut: boolean }): { level: TenancyBootLevel; message: string } {
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
    `or consolidate to a single tenant. See docs/ops/tenancy-model.md. ` +
    `(Fail-closed by default — set ALLOW_SINGLE_COMPANY_MULTI_TENANT=1 to boot with a warning instead; NOT recommended.)`;
  return { level: input.allowOptOut ? 'warn' : 'refuse', message };
}

// Boot-time assertion. Best-effort: a DB-read failure NEVER blocks boot (returns quietly); only an
// evaluated `refuse` (multiple companies in single-company mode, no opt-out) throws.
export async function assertTenancyBootSafe(opts: {
  isProd: boolean;
  mode: string;
  allowOptOut: boolean;
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
  const res = evaluateTenancyBootRisk({ mode: opts.mode, tenantCount, allowOptOut: opts.allowOptOut });
  if (res.level === 'ok') return;
  if (res.level === 'warn') {
    opts.logger.error(res.message);
    return;
  }
  throw new Error(`Refusing to boot: ${res.message}`);
}

// ── H-3: RLS-backstop risk (base connection role) ───────────────────────────────────────────────────
// Pure decision — no I/O, unit-testable. A base role that is superuser OR has BYPASSRLS does NOT enforce
// RLS on the connection, so the @NoTx/SSE/raw/job surface has no DB-level tenant backstop.
export function evaluateRlsBackstop(input: { isSuperuser: boolean; bypassRls: boolean; allowOptOut: boolean }): { level: TenancyBootLevel; message: string } {
  if (!input.isSuperuser && !input.bypassRls) {
    return { level: 'ok', message: 'DB base connection role does not bypass RLS — @NoTx / SSE / raw / job paths are backstopped by FORCE row-level security.' };
  }
  const why = input.isSuperuser ? 'is a SUPERUSER' : 'has the BYPASSRLS attribute';
  const message =
    `RLS BACKSTOP MISSING: the DB connection role ${why}, so row-level security is NOT enforced on the base connection. ` +
    `RLS is applied only inside the per-request app_user transaction; every @NoTx handler, SSE stream, raw-client query and ` +
    `background job runs on this base connection with NO DB-level tenant backstop — a single missing tenant filter is a ` +
    `cross-tenant leak. Fix: connect the API as a dedicated NON-SUPERUSER, NON-BYPASSRLS owner role (grant it app_user; ` +
    `see docs/ops/tenancy-model.md). ` +
    `(Fail-closed by default — set ALLOW_RLS_BYPASS_BASE_ROLE=1 to boot with a warning instead; NOT recommended in production.)`;
  return { level: input.allowOptOut ? 'warn' : 'refuse', message };
}

// Boot-time assertion. Best-effort: a probe failure NEVER blocks boot (returns quietly); only an evaluated
// `refuse` (base role bypasses RLS, no opt-out) throws.
export async function assertRlsBackstop(opts: {
  isProd: boolean;
  allowOptOut: boolean;
  probe: () => Promise<{ isSuperuser: boolean; bypassRls: boolean }>;
  logger: { warn: (m: string) => void; error: (m: string) => void };
}): Promise<void> {
  if (!opts.isProd) return; // dev/test/harnesses: no-op
  let r: { isSuperuser: boolean; bypassRls: boolean };
  try {
    r = await opts.probe();
  } catch {
    return; // never block boot if the probe can't run (DB not ready) — safety net, not a hard dependency
  }
  const res = evaluateRlsBackstop({ isSuperuser: r.isSuperuser, bypassRls: r.bypassRls, allowOptOut: opts.allowOptOut });
  if (res.level === 'ok') return;
  if (res.level === 'warn') {
    opts.logger.error(res.message);
    return;
  }
  throw new Error(`Refusing to boot: ${res.message}`);
}

// ── opt-out flags ────────────────────────────────────────────────────────────────────────────────────
// H-4 opt-out: downgrade the single-company-multi-tenant refusal to a warning.
export function allowSingleCompanyMultiTenant(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.ALLOW_SINGLE_COMPANY_MULTI_TENANT);
}
// H-3 opt-out: downgrade the RLS-backstop refusal to a warning.
export function allowRlsBypassBaseRole(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.ALLOW_RLS_BYPASS_BASE_ROLE);
}
