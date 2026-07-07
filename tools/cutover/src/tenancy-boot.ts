/**
 * Wave 2 · 4.2 — tenancy data-isolation boot check ToE.
 * Verifies evaluateTenancyBootRisk (pure) + assertTenancyBootSafe (best-effort, prod-gated): multiple
 * companies under single-company mode → warn (loud) by default, refuse under STRICT_TENANCY_BOOT; a DB-read
 * failure never blocks boot; dev/test is a no-op.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover tenancy-boot
 */
import { evaluateTenancyBootRisk, assertTenancyBootSafe } from '../../../apps/api/dist/common/tenancy-boot-check';

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail = '') => checks.push({ name, ok: cond, detail });

async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  // ── Pure decision matrix ──
  ok('multi-company → ok', evaluateTenancyBootRisk({ mode: 'multi-company', tenantCount: 9, strict: true }).level === 'ok');
  ok('single-company, 1 tenant → ok', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 1, strict: false }).level === 'ok');
  ok('single-company, 0 tenants → ok', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 0, strict: true }).level === 'ok');
  ok('single-company, 3 tenants, non-strict → warn', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 3, strict: false }).level === 'warn');
  ok('single-company, 3 tenants, strict → refuse', evaluateTenancyBootRisk({ mode: 'single-company', tenantCount: 3, strict: true }).level === 'refuse');
  ok('invalid mode treated as single-company → warn', evaluateTenancyBootRisk({ mode: 'weird', tenantCount: 2, strict: false }).level === 'warn');

  // ── assertTenancyBootSafe ──
  const nolog = { warn: () => {}, error: () => {} };
  ok('dev/test (isProd=false) → no-op even with many companies + strict',
    !(await throws(() => assertTenancyBootSafe({ isProd: false, mode: 'single-company', strict: true, countTenants: async () => 5, logger: nolog }))));
  ok('prod + single-company + 3 tenants + strict → THROWS (refuse boot)',
    await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', strict: true, countTenants: async () => 3, logger: nolog })));

  let errored = false;
  const capture = { warn: () => {}, error: () => { errored = true; } };
  ok('prod + single-company + 3 tenants + NON-strict → boots but logs error',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', strict: false, countTenants: async () => 3, logger: capture }))) && errored);

  ok('prod + multi-company + many tenants → no throw',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'multi-company', strict: true, countTenants: async () => 9, logger: nolog }))));
  ok('prod + single-company + 1 tenant → no throw',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', strict: true, countTenants: async () => 1, logger: nolog }))));
  ok('prod + countTenants THROWS → best-effort, never blocks boot',
    !(await throws(() => assertTenancyBootSafe({ isProd: true, mode: 'single-company', strict: true, countTenants: async () => { throw new Error('db down'); }, logger: nolog }))));

  console.log('\n── Wave 2 · 4.2 — tenancy data-isolation boot check (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} tenancy-boot checks failed` : `\n✅ All ${checks.length} tenancy-boot checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
