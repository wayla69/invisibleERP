/**
 * Wave 2 · 4.2 + security review H-3/H-4 — tenancy data-isolation boot-check ToE.
 * Verifies the pure decisions + best-effort, prod-gated wrappers:
 *   H-4 evaluateTenancyBootRisk / assertTenancyBootSafe — several companies under single-company mode now
 *       REFUSE by default (fail-closed); the ALLOW_SINGLE_COMPANY_MULTI_TENANT opt-out downgrades to warn.
 *   H-3 evaluateRlsBackstop / assertRlsBackstop — a superuser/BYPASSRLS base connection role REFUSES by
 *       default; the ALLOW_RLS_BYPASS_BASE_ROLE opt-out downgrades to warn.
 * Both are prod-only; a DB read/probe failure never blocks boot; dev/test is a no-op.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tenancy-boot
 */
import { evaluateTenancyBootRisk, assertTenancyBootSafe, evaluateRlsBackstop, assertRlsBackstop } from '../../../apps/api/dist/common/tenancy-boot-check';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  // ── H-4: tenancy-mode decision matrix (fail-closed by default) ──
  ok('multi-company → ok', evaluateTenancyBootRisk({ mode: 'multi-company', tenantCount: 9, allowOptOut: false }).level === 'ok');
  ok('single-company, 1 tenant → ok', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 1, allowOptOut: false }).level === 'ok');
  ok('single-company, 0 tenants → ok', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 0, allowOptOut: false }).level === 'ok');
  ok('single-company, 3 tenants, DEFAULT → refuse (fail-closed)', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 3, allowOptOut: false }).level === 'refuse');
  ok('single-company, 3 tenants, opt-out → warn', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 3, allowOptOut: true }).level === 'warn');
  ok('invalid mode treated as single-company, DEFAULT → refuse', evaluateTenancyBootRisk({ mode: 'weird', tenantCount: 2, allowOptOut: false }).level === 'refuse');

  // ── H-4: assertTenancyBootSafe ──
  const nolog = { warn: () => {}, error: () => {} };
  ok('dev/test (isProd=false) → no-op even with many companies',
    !(await throws(() => assertTenancyBootSafe({ isProd: false, mode: 'single-company', allowOptOut: false, countTenants: async () => 5, logger: nolog }))));
  ok('prod + single-company + 3 tenants + DEFAULT → THROWS (refuse boot)',
    await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: false, countTenants: async () => 3, logger: nolog })));

  let errored = false;
  const capture = { warn: () => {}, error: () => { errored = true; } };
  ok('prod + single-company + 3 tenants + opt-out → boots but logs error',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: true, countTenants: async () => 3, logger: capture }))) && errored);

  ok('prod + multi-company + many tenants → no throw',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'multi-company', allowOptOut: false, countTenants: async () => 9, logger: nolog }))));
  ok('prod + single-company + 1 tenant → no throw',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: false, countTenants: async () => 1, logger: nolog }))));
  ok('prod + countTenants THROWS → best-effort, never blocks boot',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', allowOptOut: false, countTenants: async () => { throw new Error('db down'); }, logger: nolog }))));

  // ── H-3: RLS-backstop decision matrix (fail-closed by default) ──
  // NB: this backstop doubles as automated least-privilege evidence for ITGC-AC-13 (named DB users /
  // least privilege). assertRlsBackstop probes pg_roles in prod and REFUSES boot when the app's base
  // connection role is a superuser or has BYPASSRLS — i.e. it enforces that the app connects as a
  // non-superuser, non-owner role, exactly the AC-13 "app uses non-superuser role" control assertion.
  ok('base role: non-super, non-bypass → ok', evaluateRlsBackstop({ isSuperuser: false, bypassRls: false, allowOptOut: false }).level === 'ok');
  ok('base role: SUPERUSER, DEFAULT → refuse', evaluateRlsBackstop({ isSuperuser: true, bypassRls: false, allowOptOut: false }).level === 'refuse');
  ok('base role: BYPASSRLS, DEFAULT → refuse', evaluateRlsBackstop({ isSuperuser: false, bypassRls: true, allowOptOut: false }).level === 'refuse');
  ok('base role: SUPERUSER, opt-out → warn', evaluateRlsBackstop({ isSuperuser: true, bypassRls: false, allowOptOut: true }).level === 'warn');

  // ── H-3: assertRlsBackstop ──
  ok('RLS: dev/test (isProd=false) → no-op even for a superuser base role',
    !(await throws(() => assertRlsBackstop({ isProd: false, allowOptOut: false, probe: async () => ({ isSuperuser: true, bypassRls: true }), logger: nolog }))));
  ok('RLS: prod + superuser base role + DEFAULT → THROWS (refuse boot)',
    await throws(() => assertRlsBackstop({ isProd: true, allowOptOut: false, probe: async () => ({ isSuperuser: true, bypassRls: false }), logger: nolog })));
  let rlsErrored = false;
  const rlsCapture = { warn: () => {}, error: () => { rlsErrored = true; } };
  ok('RLS: prod + superuser base role + opt-out → boots but logs error',
    !(await throws(() => assertRlsBackstop({ isProd: true, allowOptOut: true, probe: async () => ({ isSuperuser: true, bypassRls: false }), logger: rlsCapture }))) && rlsErrored);
  ok('RLS: prod + non-bypass base role → no throw',
    !(await throws(() => assertRlsBackstop({ isProd: true, allowOptOut: false, probe: async () => ({ isSuperuser: false, bypassRls: false }), logger: nolog }))));
  ok('RLS: prod + probe THROWS → best-effort, never blocks boot',
    !(await throws(() => assertRlsBackstop({ isProd: true, allowOptOut: false, probe: async () => { throw new Error('no db'); }, logger: nolog }))));

  console.log('\n── Wave 2 · 4.2 + H-3/H-4 — tenancy data-isolation boot check (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} tenancy-boot checks failed` : `\n✅ All ${checks.length} tenancy-boot checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
