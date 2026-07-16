import { describe, it, expect } from 'vitest';
import { isPlatformAdmin, platformAdminUsernames } from '../src/common/decorators';
import { isJitForbiddenRole, SSO_JIT_FORBIDDEN_ROLES } from '../src/modules/identity/identity-config.service';

// ITGC-AC-18 — platform owners (cross-tenant operators) are configured via PLATFORM_ADMIN_USERNAMES.
// Empty ⇒ nobody is a platform admin (every @PlatformAdmin route 403s) — secure by default.
describe('platform-admin config', () => {
  it('parses a comma list, trimmed + lowercased', () => {
    expect(platformAdminUsernames({ PLATFORM_ADMIN_USERNAMES: ' Oshinei , HQ ' })).toEqual(['oshinei', 'hq']);
    expect(platformAdminUsernames({})).toEqual([]);
    expect(platformAdminUsernames({ PLATFORM_ADMIN_USERNAMES: '' })).toEqual([]);
  });
  it('membership is case-insensitive', () => {
    const env = { PLATFORM_ADMIN_USERNAMES: 'oshinei,hq' };
    expect(isPlatformAdmin('oshinei', env)).toBe(true);
    expect(isPlatformAdmin('OSHINEI', env)).toBe(true);
    expect(isPlatformAdmin(' HQ ', env)).toBe(true);
    expect(isPlatformAdmin('amber', env)).toBe(false);
  });
  it('nobody is a platform admin when unset (secure default)', () => {
    expect(isPlatformAdmin('oshinei', {})).toBe(false);
    expect(isPlatformAdmin(undefined, { PLATFORM_ADMIN_USERNAMES: 'oshinei' })).toBe(false);
    expect(isPlatformAdmin('', { PLATFORM_ADMIN_USERNAMES: 'oshinei' })).toBe(false);
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
