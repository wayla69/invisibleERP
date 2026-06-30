import { describe, it, expect } from 'vitest';
import { mapStripeStatus } from '../src/modules/billing/billing.service';

// Guards the Stripe → subscription-lifecycle mapping that the webhook drives. Fail-safe: anything not
// clearly active/trial restricts access (PastDue) rather than silently granting it.
describe('Stripe subscription status mapping (webhook → lifecycle)', () => {
  it('maps the happy-path statuses', () => {
    expect(mapStripeStatus('trialing')).toBe('Trialing');
    expect(mapStripeStatus('active')).toBe('Active');
    expect(mapStripeStatus('canceled')).toBe('Canceled');
    expect(mapStripeStatus('incomplete_expired')).toBe('Canceled');
  });
  it('fails safe — past_due / unpaid / incomplete / unknown all restrict access (PastDue)', () => {
    expect(mapStripeStatus('past_due')).toBe('PastDue');
    expect(mapStripeStatus('unpaid')).toBe('PastDue');
    expect(mapStripeStatus('incomplete')).toBe('PastDue');
    expect(mapStripeStatus('paused')).toBe('PastDue');
    expect(mapStripeStatus('something_new')).toBe('PastDue');
  });
});
