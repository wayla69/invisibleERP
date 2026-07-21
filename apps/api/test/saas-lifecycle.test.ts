import { describe, expect, it } from 'vitest';
import { planSaasLifecycle, type LifecycleEventRow, type LifecycleSubRow } from '../src/modules/billing/saas-lifecycle.service';

// A2 — the pure lifecycle planner: trial reminder windows (midnight-safe via ceil-days), grace →
// auto-suspend, ฿0-plan activation, and the PastDue dunning ladder anchored on the dunning_1 event.
const NOW = new Date('2026-07-21T10:00:00Z');
const CFG = { trialGraceDays: 7, pastDueSuspendDays: 21 };
const DAY = 86_400_000;

const sub = (over: Partial<LifecycleSubRow>): LifecycleSubRow => ({
  tenantId: 1, tenantName: 'T', status: 'Trialing', planCode: 'business', priceMonthly: 4900,
  trialEndsAt: null, suspendedAt: null, deleted: false, adminEmail: 't@x.com', ...over,
});
const ev = (event: string, daysAgo: number, tid = 1): LifecycleEventRow => ({
  event, aboutTenantId: tid, createdAt: new Date(+NOW - daysAgo * DAY),
});

describe('planSaasLifecycle (A2)', () => {
  it('fires T-7 inside the 7-day window and BOTH reminders inside the last day (dedup separates them)', () => {
    const a7 = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW + 6.5 * DAY) })], [], NOW, CFG);
    expect(a7.map((a) => a.event)).toEqual(['trial_reminder_7']);
    expect(a7[0]!.daysLeft).toBe(7);
    const a1 = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW + 0.5 * DAY) })], [], NOW, CFG);
    expect(a1.map((a) => a.event).sort()).toEqual(['trial_reminder_1', 'trial_reminder_7']);
  });

  it('is quiet with more than 7 days left, and keys reminders to the trial END date (extension re-arms)', () => {
    expect(planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW + 8.5 * DAY) })], [], NOW, CFG)).toEqual([]);
    const k1 = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW + 3 * DAY) })], [], NOW, CFG)[0]!.dedupKey;
    const k2 = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW + 4 * DAY) })], [], NOW, CFG)[0]!.dedupKey;
    expect(k1).not.toBe(k2); // a different end date is a different reminder
  });

  it('expired paid trial: grace notice inside the window, auto-suspend after it', () => {
    const inGrace = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW - 3 * DAY) })], [], NOW, CFG);
    expect(inGrace.map((a) => a.event)).toEqual(['trial_expired']);
    const pastGrace = planSaasLifecycle([sub({ trialEndsAt: new Date(+NOW - 8 * DAY) })], [], NOW, CFG);
    expect(pastGrace.map((a) => a.event)).toEqual(['trial_suspended']);
  });

  it('expired ฿0 plan activates instead of suspending (free tier / enterprise-custom)', () => {
    const a = planSaasLifecycle([sub({ planCode: 'free', priceMonthly: 0, trialEndsAt: new Date(+NOW - 10 * DAY) })], [], NOW, CFG);
    expect(a.map((x) => x.event)).toEqual(['trial_free_activated']);
  });

  it('skips suspended and deleted tenants entirely', () => {
    const rows = [
      sub({ suspendedAt: new Date(), trialEndsAt: new Date(+NOW - 30 * DAY) }),
      sub({ tenantId: 2, deleted: true, status: 'PastDue' }),
    ];
    expect(planSaasLifecycle(rows, [], NOW, CFG)).toEqual([]);
  });

  it('dunning ladder: start → day7 → day14 → suspend at day21, anchored on dunning_1', () => {
    const pd = sub({ status: 'PastDue', trialEndsAt: null });
    expect(planSaasLifecycle([pd], [], NOW, CFG).map((a) => a.event)).toEqual(['dunning_1']);
    expect(planSaasLifecycle([pd], [ev('dunning_1', 8)], NOW, CFG).map((a) => a.event)).toEqual(['dunning_2']);
    expect(planSaasLifecycle([pd], [ev('dunning_1', 15)], NOW, CFG).map((a) => a.event)).toEqual(['dunning_3']);
    expect(planSaasLifecycle([pd], [ev('dunning_1', 22)], NOW, CFG).map((a) => a.event)).toEqual(['pastdue_suspended']);
    // early in the cycle nothing new is due
    expect(planSaasLifecycle([pd], [ev('dunning_1', 2)], NOW, CFG)).toEqual([]);
  });

  it('recovery closes the ladder, and a later PastDue starts a NEW cycle', () => {
    const active = sub({ status: 'Active', trialEndsAt: null });
    expect(planSaasLifecycle([active], [ev('dunning_1', 5)], NOW, CFG).map((a) => a.event)).toEqual(['dunning_cleared']);
    // cleared → quiet while Active
    expect(planSaasLifecycle([active], [ev('dunning_1', 5), ev('dunning_cleared', 1)], NOW, CFG)).toEqual([]);
    // back to PastDue after a clear → fresh dunning_1 (not dunning_2 off the old anchor)
    const pd = sub({ status: 'PastDue', trialEndsAt: null });
    expect(planSaasLifecycle([pd], [ev('dunning_1', 30), ev('dunning_cleared', 20)], NOW, CFG).map((a) => a.event)).toEqual(['dunning_1']);
  });
});
