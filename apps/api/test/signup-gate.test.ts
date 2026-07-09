import { describe, it, expect } from 'vitest';
import { isSignupAllowed } from '../src/modules/billing/billing.service';

// ITGC-AC-18 — public self-serve company signup is DISABLED in production unconditionally: only the
// platform owner ("god", godmimi) opens a company (direct provision, invite, or approving a request-queue
// entry). The legacy PUBLIC_SIGNUP_ENABLED escape hatch is now a no-op for provisioning. Dev/harnesses
// (NODE_ENV!=='production') stay open so tests can mint tenants directly.
describe('isSignupAllowed — public signup gate', () => {
  it('allows signup outside production (dev/test/harnesses)', () => {
    expect(isSignupAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(isSignupAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(isSignupAllowed({})).toBe(true); // NODE_ENV unset ⇒ not production
  });
  it('DENIES public self-serve signup in production — always (god-only company creation)', () => {
    expect(isSignupAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: '' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: 'false' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: '0' })).toBe(false);
  });
  it('ignores the legacy PUBLIC_SIGNUP_ENABLED escape hatch in production (now a no-op)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: v })).toBe(false);
    }
  });
});
