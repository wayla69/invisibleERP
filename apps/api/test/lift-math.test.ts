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

// docs/62 Phase 3 — statistical honesty. measureLiftDetailed adds the evidence around the point estimate.
import { measureLiftDetailed } from '../src/common/lift-math';

describe('measureLiftDetailed', () => {
  it('zero within-arm variance → CI collapses onto the point estimate; small arms still flag weak', () => {
    // 8×1000 vs 8×100/head (the MKT-19 fixture): lift 900%, SE 0, CI [900, 900] — but n=8 < 30 → weak.
    const r = measureLiftDetailed(Array(8).fill(1000), Array(8).fill(100));
    expect(r.lift_pct).toBeCloseTo(900, 6);
    expect(r.lift_se_pct).toBe(0);
    expect(r.lift_ci_low_pct).toBeCloseTo(900, 6);
    expect(r.lift_ci_high_pct).toBeCloseTo(900, 6);
    expect(r.weak_evidence).toBe(true);
    expect(r.min_arm_n).toBe(8);
  });

  it('large same-variance arms with a clear separation → strong evidence (not weak)', () => {
    // 40/arm alternating ±100 around means 1000 vs 100 — big diff, small SE, CI well above 0.
    const t = Array.from({ length: 40 }, (_, i) => 1000 + (i % 2 ? 100 : -100));
    const c = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 ? 100 : -100));
    const r = measureLiftDetailed(t, c);
    expect(r.lift_pct).toBeCloseTo(900, 6);
    expect(r.weak_evidence).toBe(false);
    expect(r.lift_ci_low_pct!).toBeGreaterThan(0);
  });

  it('a CI spanning 0 flags weak even with big arms (the lift is not distinguishable from nothing)', () => {
    // Means 105 vs 100 with a large ±100 swing — the CI comfortably includes 0.
    const t = Array.from({ length: 60 }, (_, i) => 105 + (i % 2 ? 100 : -100));
    const c = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 100 : -100));
    const r = measureLiftDetailed(t, c);
    expect(r.lift_ci_low_pct!).toBeLessThan(0);
    expect(r.lift_ci_high_pct!).toBeGreaterThan(0);
    expect(r.weak_evidence).toBe(true);
  });

  it('CI is null (and weak) when an arm has < 2 members or the control earned nothing', () => {
    const tiny = measureLiftDetailed([1000], [100, 100]);
    expect(tiny.lift_ci_low_pct).toBeNull();
    expect(tiny.weak_evidence).toBe(true);
    const zeroControl = measureLiftDetailed([500, 500], [0, 0]);
    expect(zeroControl.lift_pct).toBeNull();
    expect(zeroControl.lift_ci_low_pct).toBeNull();
    expect(zeroControl.weak_evidence).toBe(true);
  });

  it('agrees with measureLift on the shared aggregate fields', () => {
    const t = [900, 1100, 1000];
    const c = [90, 110, 100];
    const d = measureLiftDetailed(t, c);
    const a = measureLift({ treatmentRevenue: 3000, treatmentN: 3, controlRevenue: 300, controlN: 3 });
    expect(d.treatment_per_head).toBeCloseTo(a.treatment_per_head, 9);
    expect(d.lift_pct).toBeCloseTo(a.lift_pct!, 9);
    expect(d.incremental_revenue).toBeCloseTo(a.incremental_revenue, 9);
  });

  it('is deterministic', () => {
    const t = [1, 2, 3, 4];
    const c = [1, 1, 2, 2];
    expect(measureLiftDetailed(t, c)).toEqual(measureLiftDetailed(t, c));
  });
});
