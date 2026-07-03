import { describe, it, expect } from 'vitest';
import { isPlatformAdmin, platformAdminUsernames } from '../src/common/decorators';

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
