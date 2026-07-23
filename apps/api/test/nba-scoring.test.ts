import { describe, it, expect } from 'vitest';
import {
  actionUplift, expectedValue, inHoldout, suppressionReason, assembleJourney, type NbaCustomer,
} from '../src/modules/marketing-activation/nba-scoring';

// NBA Orchestrator scoring (docs/61 Phase 2, MKT-22). Pure, deterministic.

const cust = (over: Partial<NbaCustomer> = {}): NbaCustomer => ({
  member_id: 1, nba: 'UPSELL', clv: 1000, churn_risk: 0.2, opt_in: true, last_order_at: null, preferred_channel: 'sms', ...over,
});
const NOW = 1_700_000_000_000;

describe('actionUplift', () => {
  it('maps known actions and falls back for unknown/absent', () => {
    expect(actionUplift('UPSELL')).toBe(0.20);
    expect(actionUplift('winback')).toBe(0.15); // case-insensitive
    expect(actionUplift('MYSTERY')).toBe(0.05);
    expect(actionUplift(null)).toBe(0.05);
  });
});

describe('expectedValue', () => {
  it('is CLV × action uplift for a non-retention action', () => {
    expect(expectedValue(1000, 'UPSELL', 0.5)).toBe(200); // 1000 × 0.20 (churn ignored)
  });
  it('scales a retention action by churn risk', () => {
    // WINBACK: 1000 × 0.15 × (1 + 0.8) = 270
    expect(expectedValue(1000, 'WINBACK', 0.8)).toBe(270);
  });
  it('never goes negative and treats missing CLV as 0', () => {
    expect(expectedValue(null, 'UPSELL', 0.2)).toBe(0);
    expect(expectedValue(-500, 'UPSELL', 0.2)).toBe(0);
  });
});

describe('inHoldout', () => {
  it('is deterministic and honours 0% / 100%', () => {
    expect(inHoldout(42, 0)).toBe(false);
    expect(inHoldout(42, 1)).toBe(true);
    expect(inHoldout(42, 0.2)).toBe(inHoldout(42, 0.2)); // stable
  });
});

describe('suppressionReason', () => {
  it('suppresses no-consent (the PDPA gate) first', () => {
    expect(suppressionReason(cust({ opt_in: false }), NOW, 14)).toBe('CONSENT');
  });
  it('suppresses a member with no next-best-action', () => {
    expect(suppressionReason(cust({ nba: null }), NOW, 14)).toBe('NO_ACTION');
  });
  it('suppresses a recent purchaser inside the window, but not outside it', () => {
    expect(suppressionReason(cust({ last_order_at: NOW - 3 * 86400_000 }), NOW, 14)).toBe('RECENT_PURCHASE');
    expect(suppressionReason(cust({ last_order_at: NOW - 30 * 86400_000 }), NOW, 14)).toBeNull();
  });
  it('passes a consented, actionable, non-recent customer', () => {
    expect(suppressionReason(cust(), NOW, 14)).toBeNull();
  });
});

describe('assembleJourney', () => {
  it('ranks eligible customers by expected value, suppresses the rest, and records why', () => {
    const customers: NbaCustomer[] = [
      cust({ member_id: 1, nba: 'UPSELL', clv: 1000 }),          // EV 200
      cust({ member_id: 2, nba: 'NURTURE', clv: 1000 }),         // EV 50
      cust({ member_id: 3, opt_in: false }),                     // suppressed CONSENT
      cust({ member_id: 4, nba: null }),                         // suppressed NO_ACTION
      cust({ member_id: 5, last_order_at: NOW - 86400_000 }),    // suppressed RECENT_PURCHASE
    ];
    const j = assembleJourney(customers, { nowMs: NOW, controlPct: 0 });
    expect(j.targets.map((t) => t.member_id)).toEqual([1, 2]); // UPSELL before NURTURE
    expect(j.suppressed_count).toBe(3);
    expect(new Set(j.suppressed.map((s) => s.reason))).toEqual(new Set(['CONSENT', 'NO_ACTION', 'RECENT_PURCHASE']));
    expect(j.control_count).toBe(0); // controlPct 0 → all treatment
  });

  it('splits a holdout arm off the acted-on set (control is never contacted)', () => {
    const customers = Array.from({ length: 50 }, (_, i) => cust({ member_id: i + 1, clv: 1000 - i }));
    const j = assembleJourney(customers, { nowMs: NOW, controlPct: 0.5 });
    expect(j.treatment_count + j.control_count).toBe(50);
    expect(j.control_count).toBeGreaterThan(0);
    expect(j.treatment_count).toBeGreaterThan(0);
  });

  it('applies the fatigue cap (top-N by EV)', () => {
    const customers = Array.from({ length: 10 }, (_, i) => cust({ member_id: i + 1, clv: 1000 - i * 10 }));
    const j = assembleJourney(customers, { nowMs: NOW, controlPct: 0, maxTargets: 3 });
    expect(j.targets).toHaveLength(3);
    expect(j.targets[0]!.member_id).toBe(1); // highest CLV → highest EV
  });

  it('is deterministic — same inputs, same journey', () => {
    const customers = [cust({ member_id: 7 }), cust({ member_id: 8, nba: 'WINBACK', churn_risk: 0.9 })];
    expect(assembleJourney(customers, { nowMs: NOW, controlPct: 0.3 })).toEqual(assembleJourney(customers, { nowMs: NOW, controlPct: 0.3 }));
  });
});
