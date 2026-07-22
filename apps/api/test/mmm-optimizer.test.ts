import { describe, it, expect } from 'vitest';
import {
  hillResponse, hillMarginal, curvesFromMmm, predictSales, optimizeAllocation, type ResponseCurve,
} from '../src/modules/marketing-intel/mmm-optimizer';

// Budget Optimizer math (docs/60 Phase 1). Pure, deterministic.

const curve = (over: Partial<ResponseCurve> = {}): ResponseCurve => ({
  channel: 'X', beta: 1000, kappa: 500, slope: 1, currentSpend: 500, roi: 3, derived: false, ...over,
});

describe('Hill saturation response', () => {
  it('is 0 at zero spend and approaches beta as spend → ∞', () => {
    const c = curve();
    expect(hillResponse(0, c)).toBe(0);
    expect(hillResponse(1e12, c)).toBeCloseTo(c.beta, 0);
  });

  it('equals beta/2 at the half-saturation point kappa', () => {
    const c = curve({ beta: 800, kappa: 300 });
    expect(hillResponse(300, c)).toBeCloseTo(400, 6);
  });

  it('is monotonically increasing with diminishing marginal return', () => {
    const c = curve();
    expect(hillResponse(1000, c)).toBeGreaterThan(hillResponse(500, c));
    // concavity in the saturating region: the first baht returns more than a later one
    expect(hillMarginal(100, c)).toBeGreaterThan(hillMarginal(2000, c));
  });

  it('returns 0 for degenerate params', () => {
    expect(hillResponse(500, curve({ beta: 0 }))).toBe(0);
    expect(hillMarginal(500, curve({ kappa: 0 }))).toBe(0);
  });
});

describe('curvesFromMmm', () => {
  it('uses pushed saturation params when present (not derived)', () => {
    const { curves, anyDerived } = curvesFromMmm({
      channels: [{ channel: 'FB', spend: 800, roi: 4, saturation: { beta: 5000, kappa: 900, slope: 1.3 } }],
    });
    expect(anyDerived).toBe(false);
    expect(curves[0]).toMatchObject({ channel: 'FB', beta: 5000, kappa: 900, slope: 1.3, derived: false });
  });

  it('derives a serviceable fallback when saturation params are absent', () => {
    const { curves, anyDerived } = curvesFromMmm({
      channels: [{ channel: 'Google', spend: 600, roi: 5, contribution_pct: 30 }],
    });
    expect(anyDerived).toBe(true);
    expect(curves[0]!.derived).toBe(true);
    expect(curves[0]!.kappa).toBe(600); // current spend = half-saturation point
    expect(curves[0]!.beta).toBeGreaterThan(0);
  });

  it('ignores blank channels and handles an empty payload', () => {
    expect(curvesFromMmm({}).curves).toHaveLength(0);
    expect(curvesFromMmm({ channels: [{ channel: '', spend: 100 }] }).curves).toHaveLength(0);
  });
});

describe('predictSales', () => {
  it('sums per-channel Hill responses for an allocation', () => {
    const curves = [curve({ channel: 'A', beta: 1000, kappa: 500 }), curve({ channel: 'B', beta: 2000, kappa: 1000 })];
    const r = predictSales({ A: 500, B: 1000 }, curves);
    expect(r.perChannel).toHaveLength(2);
    expect(r.total).toBeCloseTo(500 + 1000, 6); // each at its half-saturation → beta/2
  });
});

describe('optimizeAllocation (greedy water-filling)', () => {
  const curves = [
    curve({ channel: 'A', beta: 1000, kappa: 300, currentSpend: 300 }),
    curve({ channel: 'B', beta: 4000, kappa: 800, currentSpend: 400 }),
    curve({ channel: 'C', beta: 500, kappa: 200, currentSpend: 100 }),
  ];

  it('spends (approximately) the whole budget', () => {
    const res = optimizeAllocation(1_000_000, curves, { caps: { A: 1e9, B: 1e9, C: 1e9 } });
    const spent = Object.values(res.allocation).reduce((s, v) => s + v, 0);
    expect(spent).toBeCloseTo(1_000_000, -1);
  });

  it('beats an equal split on predicted sales (allocates to the best marginal return)', () => {
    const budget = 300_000;
    const opt = optimizeAllocation(budget, curves, { caps: { A: 1e9, B: 1e9, C: 1e9 } });
    const equal = predictSales({ A: budget / 3, B: budget / 3, C: budget / 3 }, curves).total;
    expect(opt.predictedSales).toBeGreaterThanOrEqual(equal);
    // channel B has the highest asymptote → it should attract the most budget
    expect(opt.allocation.B).toBeGreaterThan(opt.allocation.C!);
  });

  it('respects per-channel caps', () => {
    const res = optimizeAllocation(1_000_000, curves, { caps: { A: 50_000, B: 50_000, C: 50_000 } });
    for (const v of Object.values(res.allocation)) expect(v).toBeLessThanOrEqual(50_000 + 1e-6);
  });

  it('is deterministic (same inputs → same allocation)', () => {
    const a = optimizeAllocation(500_000, curves);
    const b = optimizeAllocation(500_000, curves);
    expect(a.allocation).toEqual(b.allocation);
  });
});
