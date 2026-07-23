import { describe, it, expect } from 'vitest';
import { measureLift } from '../src/common/lift-math';

// Shared holdout-lift math (MKT-19 discipline; common/lift-math.ts) — used by segment experiments,
// NBA journey measurement (MKT-22) and churn-save run measurement (MKT-24). Pure, deterministic.

describe('measureLift', () => {
  it('computes per-head revenue, lift% and incremental revenue (the MKT-19 formula)', () => {
    // 3 treatment heads earned 3000 (1000/head); 2 control heads earned 200 (100/head).
    const r = measureLift({ treatmentRevenue: 3000, treatmentN: 3, controlRevenue: 200, controlN: 2 });
    expect(r.treatment_per_head).toBe(1000);
    expect(r.control_per_head).toBe(100);
    expect(r.lift_pct).toBeCloseTo(900, 6);                 // (1000−100)/100 × 100
    expect(r.incremental_revenue).toBeCloseTo(2700, 6);     // (1000−100) × 3
  });

  it('reports negative lift when the control out-earned the treatment', () => {
    const r = measureLift({ treatmentRevenue: 100, treatmentN: 2, controlRevenue: 200, controlN: 2 });
    expect(r.lift_pct).toBeCloseTo(-50, 6);
    expect(r.incremental_revenue).toBeCloseTo(-100, 6);     // (50−100) × 2
  });

  it('yields null lift when the control earned nothing (no meaningful baseline, not infinity)', () => {
    const r = measureLift({ treatmentRevenue: 500, treatmentN: 5, controlRevenue: 0, controlN: 2 });
    expect(r.lift_pct).toBeNull();
    expect(r.incremental_revenue).toBeCloseTo(500, 6);      // (100−0) × 5 — still attributable
  });

  it('handles empty arms without dividing by zero', () => {
    expect(measureLift({ treatmentRevenue: 0, treatmentN: 0, controlRevenue: 0, controlN: 0 }))
      .toEqual({ treatment_per_head: 0, control_per_head: 0, lift_pct: null, incremental_revenue: 0 });
    const noControl = measureLift({ treatmentRevenue: 900, treatmentN: 3, controlRevenue: 0, controlN: 0 });
    expect(noControl.treatment_per_head).toBe(300);
    expect(noControl.lift_pct).toBeNull();
  });

  it('zero lift when the arms perform identically', () => {
    const r = measureLift({ treatmentRevenue: 400, treatmentN: 4, controlRevenue: 100, controlN: 1 });
    expect(r.lift_pct).toBeCloseTo(0, 6);
    expect(r.incremental_revenue).toBeCloseTo(0, 6);
  });

  it('is deterministic — same inputs, same outputs', () => {
    const i = { treatmentRevenue: 1234.56, treatmentN: 7, controlRevenue: 321.99, controlN: 3 };
    expect(measureLift(i)).toEqual(measureLift(i));
  });
});
