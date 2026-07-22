import { describe, it, expect } from 'vitest';
import { isPlatformAdmin, platformAdminUsernames } from '../src/common/decorators';
import { auditRequired } from '../src/common/audit.interceptor';
import { platformRequireMfa } from '../src/common/guards';
import { isJitForbiddenRole, SSO_JIT_FORBIDDEN_ROLES } from '../src/modules/identity/identity-config.service';

// ITGC-AC-18 — platform owners (cross-tenant operators) are configured via PLATFORM_ADMIN_USERNAMES.
// Empty ⇒ nobody is a platform admin (every @PlatformAdmin route 403s) — secure by default.
describe('platform-admin config', () => {
  it('parses a comma list, trimmed + lowercased', () => {
    expect(platformAdminUsernames({ PLATFORM_ADMIN_USERNAMES: ' Invisible , HQ ' })).toEqual(['invisible', 'hq']);
    expect(platformAdminUsernames({})).toEqual([]);
    expect(platformAdminUsernames({ PLATFORM_ADMIN_USERNAMES: '' })).toEqual([]);
  });
  it('membership is case-insensitive', () => {
    const env = { PLATFORM_ADMIN_USERNAMES: 'invisible,hq' };
    expect(isPlatformAdmin('invisible', env)).toBe(true);
    expect(isPlatformAdmin('INVISIBLE', env)).toBe(true);
    expect(isPlatformAdmin(' HQ ', env)).toBe(true);
    expect(isPlatformAdmin('amber', env)).toBe(false);
  });
  it('nobody is a platform admin when unset (secure default)', () => {
    expect(isPlatformAdmin('invisible', {})).toBe(false);
    expect(isPlatformAdmin(undefined, { PLATFORM_ADMIN_USERNAMES: 'invisible' })).toBe(false);
    expect(isPlatformAdmin('', { PLATFORM_ADMIN_USERNAMES: 'invisible' })).toBe(false);
  });
});

// The platform surface runs under a full cross-tenant RLS bypass, so its READS are cross-tenant too —
// `GET /api/admin/tenants/:id/export` streams every row of every tenant-scoped table for any company.
// AuditInterceptor therefore audits a @PlatformAdmin route on EVERY method, not only the mutating ones.
describe('platform-surface audit coverage (ITGC-AC-16)', () => {
  it('audits every mutation on an ordinary tenant route', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(auditRequired(m, false)).toBe(true);
  });
  it('does NOT audit an ordinary tenant READ (RLS-confined; would drown the chain)', () => {
    expect(auditRequired('GET', false)).toBe(false);
    expect(auditRequired('HEAD', false)).toBe(false);
    expect(auditRequired('OPTIONS', false)).toBe(false);
  });
  it('audits a platform-owner READ — the god-export gap', () => {
    expect(auditRequired('GET', true)).toBe(true);
    expect(auditRequired('HEAD', true)).toBe(true);
  });
  it('audits a platform-owner mutation (unchanged)', () => {
    expect(auditRequired('POST', true)).toBe(true);
  });
  it('is case- and null-safe on the method', () => {
    expect(auditRequired('post', false)).toBe(true);
    expect(auditRequired('get', true)).toBe(true);
    expect(auditRequired('', true)).toBe(true);
    expect(auditRequired('', false)).toBe(false);
  });
});

// D3 — the god credential is the strongest in the system; PLATFORM_REQUIRE_MFA makes TOTP mandatory on it.
// Fail-closed parsing: anything that isn't an explicit truthy value leaves the gate OFF (grandfather).
describe('platform MFA gate (D3)', () => {
  it('is off unless explicitly enabled', () => {
    expect(platformRequireMfa({})).toBe(false);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: 'false' })).toBe(false);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: '' })).toBe(false);
    expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: 'maybe' })).toBe(false);
  });
  it('accepts the documented truthy spellings, trimmed + case-insensitive', () => {
    for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) {
      expect(platformRequireMfa({ PLATFORM_REQUIRE_MFA: v })).toBe(true);
    }
  });
});

// Pentest P2 — self-service SSO/SCIM JIT provisioning may never auto-assign a role that can escalate further.
describe('SSO JIT forbidden roles (pentest P2)', () => {
  it('forbids the privileged escalation roles (Admin, AccessAdmin)', () => {
    expect(SSO_JIT_FORBIDDEN_ROLES).toEqual(['Admin', 'AccessAdmin']);
    expect(isJitForbiddenRole('Admin')).toBe(true);
    expect(isJitForbiddenRole('AccessAdmin')).toBe(true);
  });
  it('allows ordinary non-privileged roles and is null-safe', () => {
    expect(isJitForbiddenRole('Sales')).toBe(false);
    expect(isJitForbiddenRole('ExecutiveViewer')).toBe(false);
    expect(isJitForbiddenRole(null)).toBe(false);
    expect(isJitForbiddenRole(undefined)).toBe(false);
  });
});
