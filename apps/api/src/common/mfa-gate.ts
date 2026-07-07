// Wave 2 · 4.4 — hard privileged-MFA enrolment gate (pure decision, unit-testable).
// A privileged role (requiresMfa: Admin/finance/access-admin) that has NOT enrolled TOTP can currently log
// in on password alone — the must_setup_mfa flag is only a client nudge. When ENFORCE_PRIVILEGED_MFA is on,
// JwtAuthGuard uses this to block every route except the MFA-enrolment allowlist (mirrors the existing
// must_change_password hard gate) until the user enrols — 403 MFA_ENROLLMENT_REQUIRED.
//
// DEFAULT OFF (grandfather): existing privileged users who never enrolled are not locked out until an
// operator turns it on (after telling those users to enrol). Enrolment paths stay reachable so the user can
// always complete setup. Role-based (requiresMfa(role)) so it needs no extra per-request query.

import { requiresMfa, type Role } from '@ierp/shared';

// Routes a privileged, not-yet-enrolled user may still reach so they can enrol (and manage their session).
const MFA_ENROLLMENT_ALLOWLIST = [
  '/api/auth/mfa/status',
  '/api/auth/mfa/setup',
  '/api/auth/mfa/enable',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/change-password',
];

export function mfaEnrollmentAllowedPath(path: string): boolean {
  return MFA_ENROLLMENT_ALLOWLIST.includes(path);
}

export function enforcePrivilegedMfa(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(env.ENFORCE_PRIVILEGED_MFA ?? '').trim().toLowerCase());
}

// Should this request be blocked pending MFA enrolment?
export function requiresMfaEnrollment(opts: { enforce: boolean; mfaEnabled: boolean; role: Role; path: string }): boolean {
  if (!opts.enforce) return false;
  if (opts.mfaEnabled) return false;
  if (!requiresMfa(opts.role, null)) return false; // non-privileged role — no MFA required
  return !mfaEnrollmentAllowedPath(opts.path);
}
