import { describe, it, expect } from 'vitest';
import { LoginAttemptStore } from '../src/modules/auth/login-attempt.store';

// docs/27 R2-1 / AUD-SEC-01 — the lockout store fails OPEN on infra error (login availability wins), but
// the degradation is alerted (throttled ops alert), never silent, and never breaks the auth path.
const failingSql = Object.assign(
  () => { throw new Error('connection refused'); },
  {},
) as any;

describe('LoginAttemptStore — fail-open on store failure', () => {
  it('retryAfterSeconds returns 0 (not locked) instead of throwing', async () => {
    const store = new LoginAttemptStore(failingSql);
    await expect(store.retryAfterSeconds('admin')).resolves.toBe(0);
  });
  it('recordFailure and clear swallow the error (auth path unbroken)', async () => {
    const store = new LoginAttemptStore(failingSql);
    await expect(store.recordFailure('admin')).resolves.toBeUndefined();
    await expect(store.clear('admin')).resolves.toBeUndefined();
  });
});
