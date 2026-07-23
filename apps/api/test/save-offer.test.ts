import { describe, it, expect } from 'vitest';
import {
  cappedOffer, inHoldout, computeSavePnl, SAVE_EFFECTIVENESS, type SaveCustomer, type SavePolicy,
} from '../src/modules/marketing-activation/save-offer';

// Churn-Save Autopilot offer + P&L (docs/61 Phase 5, MKT-24). Pure, deterministic.

const policy = (over: Partial<SavePolicy> = {}): SavePolicy => ({ churn_threshold: 0.5, min_clv: 100, offer_rate: 0.1, offer_cap: 500, ...over });
const cust = (over: Partial<SaveCustomer> = {}): SaveCustomer => ({ member_id: 1, clv: 1000, churn_risk: 0.8, opt_in: true, ...over });

describe('cappedOffer', () => {
  it('is clv × rate below the cap', () => {
    expect(cappedOffer(1000, policy({ offer_rate: 0.1, offer_cap: 500 }))).toBe(100);
  });
  it('NEVER exceeds the cap (the control)', () => {
    expect(cappedOffer(100000, policy({ offer_rate: 0.1, offer_cap: 500 }))).toBe(500);
  });
  it('is 0 for a null / non-positive CLV', () => {
    expect(cappedOffer(null, policy())).toBe(0);
    expect(cappedOffer(-100, policy())).toBe(0);
  });
});

describe('inHoldout', () => {
  it('is deterministic and honours 0% / 100%', () => {
    expect(inHoldout(9, 0)).toBe(false);
    expect(inHoldout(9, 1)).toBe(true);
  });
});

describe('computeSavePnl', () => {
  it('sweeps only at-risk, save-worthy, consented customers', () => {
    const customers: SaveCustomer[] = [
      cust({ member_id: 1, churn_risk: 0.8, clv: 1000 }),       // eligible
      cust({ member_id: 2, churn_risk: 0.3, clv: 1000 }),       // below churn threshold → out
      cust({ member_id: 3, churn_risk: 0.9, clv: 50 }),         // below min_clv → out
      cust({ member_id: 4, churn_risk: 0.9, clv: 1000, opt_in: false }), // no consent → out
    ];
    const pnl = computeSavePnl(customers, policy(), { controlPct: 0 });
    expect(pnl.eligible).toBe(1);
    expect(pnl.targets.map((t) => t.member_id)).toEqual([1]);
  });

  it('caps every offer and rolls up a retention P&L over the TREATMENT arm only', () => {
    const customers = [cust({ member_id: 1, clv: 100000, churn_risk: 0.8 })]; // offer capped to 500
    const pnl = computeSavePnl(customers, policy({ offer_cap: 500 }), { controlPct: 0 });
    expect(pnl.treatment_count).toBe(1);
    expect(pnl.offer_cost).toBe(500);                       // capped, not 10000
    // expected saved = clv × churn × effectiveness = 100000 × 0.8 × 0.35 = 28000
    expect(pnl.expected_saved_revenue).toBe(Math.round(100000 * 0.8 * SAVE_EFFECTIVENESS * 100) / 100);
    expect(pnl.net_benefit).toBe(pnl.expected_saved_revenue - 500);
    expect(pnl.roi).toBe(Math.round((pnl.net_benefit / 500) * 100) / 100);
  });

  it('the control arm receives no offer and no cost (the counterfactual)', () => {
    const customers = Array.from({ length: 40 }, (_, i) => cust({ member_id: i + 1, clv: 1000, churn_risk: 0.9 }));
    const pnl = computeSavePnl(customers, policy(), { controlPct: 0.5 });
    expect(pnl.treatment_count + pnl.control_count).toBe(40);
    expect(pnl.control_count).toBeGreaterThan(0);
    // offer_cost only counts treatment (each offer = min(1000×0.1, 500) = 100)
    expect(pnl.offer_cost).toBe(pnl.treatment_count * 100);
  });

  it('is deterministic — same inputs, same P&L', () => {
    const customers = [cust({ member_id: 5 }), cust({ member_id: 6, clv: 2000 })];
    expect(computeSavePnl(customers, policy(), { controlPct: 0.3 })).toEqual(computeSavePnl(customers, policy(), { controlPct: 0.3 }));
  });
});
