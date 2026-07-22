import { describe, it, expect } from 'vitest';
import { estimateCrossElasticity } from '../src/modules/scm-planning/scm-cross-elasticity.service';

// docs/56 A3 — the pure category-scoped cross-elasticity estimator. Same identifiability discipline as
// the engine's own-price estimator (A2): recover a known slope, but suppress to null when the price is
// flat, the sample is tiny, or the fit is weak. γ = ∂log(demand_a)/∂log(price_b).

/** Build aligned demand_a / price_b maps where log(demand_a) = c + γ·log(price_b) (+ optional noise). */
function pair(gammaTrue: number, n = 40, prices = [50, 60, 72], base = 100, jitter = 0) {
  const demandA = new Map<string, number>();
  const priceB = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const ds = `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`; // unique key per i
    const p = prices[i % prices.length]!;
    let y = base * (p / 60) ** gammaTrue;
    if (jitter) y *= 1 + jitter * (((i * 7919) % 11) - 5) / 5;
    demandA.set(ds, Math.max(y, 0.1));
    priceB.set(ds, p);
  }
  return { demandA, priceB };
}

describe('A3 cross-elasticity estimator', () => {
  it('recovers a known substitute slope (γ>0)', () => {
    const { demandA, priceB } = pair(1.4);
    const r = estimateCrossElasticity(demandA, priceB);
    expect(r.gamma).not.toBeNull();
    expect(r.gamma!).toBeCloseTo(1.4, 1);
    expect(r.r2!).toBeGreaterThan(0.9);
    expect(r.nObs).toBeGreaterThanOrEqual(8);
  });

  it('recovers a known complement slope (γ<0)', () => {
    const { demandA, priceB } = pair(-0.8);
    const r = estimateCrossElasticity(demandA, priceB);
    expect(r.gamma!).toBeCloseTo(-0.8, 1);
  });

  it('returns null when the driver price is flat (not identifiable)', () => {
    const { demandA, priceB } = pair(1.5, 40, [60]); // single price
    expect(estimateCrossElasticity(demandA, priceB).gamma).toBeNull();
  });

  it('returns null with too few paired observations', () => {
    const { demandA, priceB } = pair(1.5, 6);
    const r = estimateCrossElasticity(demandA, priceB);
    expect(r.gamma).toBeNull();
    expect(r.nObs).toBeLessThan(8);
  });

  it('suppresses a weak fit to null', () => {
    const { demandA, priceB } = pair(0.03, 40, [50, 60, 72], 100, 0.9); // tiny slope, heavy noise
    expect(estimateCrossElasticity(demandA, priceB).gamma).toBeNull();
  });

  it('clamps an absurd slope', () => {
    const { demandA, priceB } = pair(9);
    const r = estimateCrossElasticity(demandA, priceB);
    expect(r.gamma).not.toBeNull();
    expect(Math.abs(r.gamma!)).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('drops days with no demand or no price', () => {
    const { demandA, priceB } = pair(1.2, 20);
    demandA.set('2026-02-01-x', 0); // zero demand — excluded
    priceB.set('2026-02-01-x', 55);
    const r = estimateCrossElasticity(demandA, priceB);
    expect(r.nObs).toBe(20); // the zero-demand day did not enter the fit
  });
});
