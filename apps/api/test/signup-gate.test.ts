import { describe, it, expect } from 'vitest';
import { isSignupAllowed } from '../src/modules/billing/billing.service';

// ITGC-AC-18 — public self-serve signup is fail-closed in production (a public tenant+Admin factory),
// enabled only via PUBLIC_SIGNUP_ENABLED. Dev/harnesses (NODE_ENV!=='production') are always allowed.
describe('isSignupAllowed — public signup gate', () => {
  it('allows signup outside production (dev/test/harnesses)', () => {
    expect(isSignupAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(isSignupAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(isSignupAllowed({})).toBe(true); // NODE_ENV unset ⇒ not production
  });
  it('DENIES signup in production by default (fail-closed)', () => {
    expect(isSignupAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: '' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: 'false' })).toBe(false);
    expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: '0' })).toBe(false);
  });
  it('allows signup in production only when explicitly opted in', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isSignupAllowed({ NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: v })).toBe(true);
    }
  });
});
