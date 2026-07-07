/**
 * Wave 2 · 4.4 — privileged-MFA enrolment gate ToE.
 * Verifies requiresMfaEnrollment (the pure decision JwtAuthGuard uses): off by default (grandfather);
 * when on, a privileged un-enrolled role is blocked everywhere except the enrolment allowlist; enrolled or
 * non-privileged roles are never blocked.
 *   NODE_OPTIONS=--experimental-sqlite pnpm --filter @ierp/cutover mfa-gate
 */
import { requiresMfaEnrollment, mfaEnrollmentAllowedPath, enforcePrivilegedMfa } from '../../../apps/api/dist/common/mfa-gate';

const checks: { name: string; ok: boolean }[] = [];
const ok = (name: string, cond: boolean) => checks.push({ name, ok: cond });

const blocked = (o: { enforce: boolean; mfaEnabled: boolean; role: string; path: string }) =>
  requiresMfaEnrollment({ enforce: o.enforce, mfaEnabled: o.mfaEnabled, role: o.role as any, path: o.path });

async function main() {
  const APP = '/api/ledger/journal';

  // ── default off = grandfather ──
  ok('enforce off: privileged un-enrolled NOT blocked (grandfather)', blocked({ enforce: false, mfaEnabled: false, role: 'Admin', path: APP }) === false);

  // ── enforce on ──
  ok('enforce on: Admin un-enrolled → BLOCKED on app route', blocked({ enforce: true, mfaEnabled: false, role: 'Admin', path: APP }) === true);
  ok('enforce on: FinancialController un-enrolled → BLOCKED', blocked({ enforce: true, mfaEnabled: false, role: 'FinancialController', path: APP }) === true);
  ok('enforce on: AccessAdmin un-enrolled → BLOCKED', blocked({ enforce: true, mfaEnabled: false, role: 'AccessAdmin', path: APP }) === true);
  ok('enforce on: Admin ENROLLED → not blocked', blocked({ enforce: true, mfaEnabled: true, role: 'Admin', path: APP }) === false);
  ok('enforce on: non-privileged (Cashier) un-enrolled → not blocked', blocked({ enforce: true, mfaEnabled: false, role: 'Cashier', path: APP }) === false);
  ok('enforce on: non-privileged (StockCounter) un-enrolled → not blocked', blocked({ enforce: true, mfaEnabled: false, role: 'StockCounter', path: APP }) === false);
  // Sales holds 'exec' (→ gl_post/gl_close), so it correctly REQUIRES MFA — verify it IS gated.
  ok('enforce on: Sales (has exec) un-enrolled → BLOCKED', blocked({ enforce: true, mfaEnabled: false, role: 'Sales', path: APP }) === true);

  // ── enrolment allowlist reachable while blocked ──
  for (const p of ['/api/auth/mfa/setup', '/api/auth/mfa/enable', '/api/auth/mfa/status', '/api/auth/me', '/api/auth/logout', '/api/auth/change-password']) {
    ok(`enforce on: Admin un-enrolled may reach ${p}`, blocked({ enforce: true, mfaEnabled: false, role: 'Admin', path: p }) === false);
    ok(`allowlist recognises ${p}`, mfaEnrollmentAllowedPath(p) === true);
  }
  ok('allowlist rejects an app route', mfaEnrollmentAllowedPath(APP) === false);

  // ── env helper ──
  process.env.ENFORCE_PRIVILEGED_MFA = 'true'; ok('enforcePrivilegedMfa true', enforcePrivilegedMfa() === true);
  process.env.ENFORCE_PRIVILEGED_MFA = 'false'; ok('enforcePrivilegedMfa false', enforcePrivilegedMfa() === false);
  delete process.env.ENFORCE_PRIVILEGED_MFA; ok('enforcePrivilegedMfa default false', enforcePrivilegedMfa() === false);

  console.log('\n── Wave 2 · 4.4 — privileged-MFA enrolment gate (cutover) ──');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n❌ ${failed}/${checks.length} mfa-gate checks failed` : `\n✅ All ${checks.length} mfa-gate checks passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
