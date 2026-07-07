# Access Control & Identity Management Policy

**Policy ID:** ELC-POL-07 · **Owner:** `<<IT Security / Controller>>` · **Approved by:** `<<CISO>>`
**Version:** 0.1 (DRAFT) · **Effective:** `<<date>>` · **Last reviewed:** `<<date>>` · **Cadence:** Annual + quarterly UAR
**Related RCM controls:** ITGC-AC-01..10

> DRAFT template — many controls below are already implemented; this policy documents how they operate.

## 1. Purpose
Ensure access to the ERP and its data is granted on least-privilege, segregated, periodically reviewed, and fully logged.

## 2. Policy statements
- **Authentication:** unique named accounts; scrypt-hashed passwords; forced change on first login; JWT session expiry (`JWT_EXPIRES_IN`). MFA (TOTP) required for privileged/finance roles (AC-06).
- **Authorization (RBAC):** access via roles → fine-grained permissions (`packages/shared/src/permissions.ts`); enforced by global `JwtAuthGuard` + `PermissionsGuard`. Per-user overrides are exceptions, justified and logged.
- **Segregation of duties:** conflicting permission assignments are **blocked** unless an explicit justified override is recorded (ITGC-AC-09); the SoD conflict report is reviewed each quarter.
- **Provisioning (joiner):** access requested and approved per the DoA matrix (ELC-POL-03) before grant; default least privilege.
- **Modification (mover):** role changes re-approved; old access removed.
- **De-provisioning (leaver):** access revoked within `<<24 hours>>` of termination; evidence retained.
- **Privileged access:** Admin/HQ-bypass accounts are minimized, named, MFA-protected, and reviewed.
- **API keys:** scoped, never Admin/HQ-bypass, hashed at rest, RLS-bound, revocable (AC-05).
- **Database access:** least-privilege named DB roles; DBA actions logged (AC-13 — remediating).
- **Tenant isolation:** Postgres RLS enforces per-tenant data access (fail-closed in production).
- **Audit trail:** the append-only `audit_log` records who/what/when for mutations (AC-10).

## 3. User Access Review (UAR) — operating procedure (AC-08)
Quarterly, the reviewer pulls the access-review export (`GET /api/admin/users/access-review/export`), confirms each user × permission is appropriate, annotates keep/revoke, ensures revocations are actioned, and records the sign-off (`POST .../access-review/certify`). Retain the signed CSV + certification as evidence.

## 4. Evidence
User-access listing, UAR sign-offs, joiner/mover/leaver tickets, MFA enforcement, SoD conflict reports, audit-log samples.

## Revision history
| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-06-22 | `<<author>>` | Initial draft |
| 0.2 | 2026-07-07 | Platform / Security | **Hard privileged-MFA enrolment gate (4.4).** Previously a privileged role (Admin / finance / access-admin — `requiresMfa`) that had not enrolled TOTP could authenticate on password alone (`must_setup_mfa` was a client nudge only). With `ENFORCE_PRIVILEGED_MFA=on`, `JwtAuthGuard` now HARD-BLOCKS such a user (`403 MFA_ENROLLMENT_REQUIRED`) from every route except the MFA-setup / me / logout / change-password allowlist until they enrol — mirroring the `must_change_password` gate, on the same per-request user read. Default off (grandfather) so existing un-enrolled privileged users aren't locked out; enable after notifying them. Also the **legacy unsalted-SHA-256 login path was removed entirely** (4.5 — CodeQL `js/insufficient-password-hash`; a 64-hex hash is now rejected without any weak comparison, un-migrated accounts must be admin-reset; see vulnerability-triage). ToE: `cutover/mfa-gate` (24/24), `cutover/password-hardening`. |
