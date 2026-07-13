import { describe, it, expect } from 'vitest';
import { computeMmm, MAX_SENTIMENT_BOOST, type MmmChannelInput } from '../src/modules/mmm/mmm-model';

// docs/48 — the MMM attribution math is a PURE function (bounded-context rule 4: core analytical logic must
// be tested). These lock the contract the v1 lift-share heuristic exposes to persistence + the dashboard:
// contribution = attributed revenue × (1 + bounded positive-buzz uplift); ROI = contribution ÷ spend
// (null when spend is 0); lift = share of total contribution; and a ROI-proportional budget split that sums
// to EXACTLY the total spend.

const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);

describe('computeMmm — v1 lift-share attribution', () => {
  it('returns [] for no channels', () => {
    expect(computeMmm([], 1000)).toEqual([]);
  });

  it('single channel takes 100% lift and the whole budget', () => {
    const [r] = computeMmm([{ channel: 'tiktok', spend: 500, attributedRevenue: 2000, sentimentSignal: 0 }], 500);
    expect(r!.roi).toBe(4);                       // 2000 / 500
    expect(r!.salesLiftContribution).toBe(100);
    expect(r!.optimalBudgetAllocation).toBe(500);
  });

  it('ROI is null (not Infinity) when spend is 0', () => {
    const [r] = computeMmm([{ channel: 'organic', spend: 0, attributedRevenue: 900, sentimentSignal: 0 }], 0);
    expect(r!.roi).toBeNull();
    expect(r!.optimalBudgetAllocation).toBe(0);   // no budget to allocate
  });

  it('positive sentiment lifts contribution by at most MAX_SENTIMENT_BOOST for the strongest channel', () => {
    // Two channels, equal revenue; only A has buzz → A gets the full boost, B none.
    const res = computeMmm([
      { channel: 'a', spend: 100, attributedRevenue: 1000, sentimentSignal: 40 },
      { channel: 'b', spend: 100, attributedRevenue: 1000, sentimentSignal: 0 },
    ], 200);
    const a = res.find((r) => r.channel === 'a')!;
    const b = res.find((r) => r.channel === 'b')!;
    expect(a.contribution).toBe(1000 * (1 + MAX_SENTIMENT_BOOST));   // 1250
    expect(b.contribution).toBe(1000);
    expect(a.roi).toBe(12.5);
    expect(b.roi).toBe(10);
  });

  it('negative sentiment never reduces contribution below attributed revenue (boost floored at 0)', () => {
    const [r] = computeMmm([{ channel: 'x', spend: 100, attributedRevenue: 1000, sentimentSignal: -99 }], 100);
    expect(r!.contribution).toBe(1000);           // max(0, -99) → 0 boost
  });

  it('budget is split proportional to ROI and sums to EXACTLY the total (rounding drift corrected)', () => {
    // Revenues chosen so the proportional split doesn't land on clean 2-dp values.
    const res = computeMmm([
      { channel: 'a', spend: 300, attributedRevenue: 1000, sentimentSignal: 0 }, // roi 3.33…
      { channel: 'b', spend: 300, attributedRevenue: 2000, sentimentSignal: 0 }, // roi 6.66…
      { channel: 'c', spend: 300, attributedRevenue: 500, sentimentSignal: 0 },  // roi 1.66…
    ], 900);
    expect(sum(res.map((r) => r.optimalBudgetAllocation))).toBe(900);
    // Higher ROI ⇒ larger allocation.
    const [a, b, c] = ['a', 'b', 'c'].map((ch) => res.find((r) => r.channel === ch)!);
    expect(b!.optimalBudgetAllocation).toBeGreaterThan(a!.optimalBudgetAllocation);
    expect(a!.optimalBudgetAllocation).toBeGreaterThan(c!.optimalBudgetAllocation);
  });

  it('sales-lift contributions sum to 100 across channels', () => {
    const res = computeMmm([
      { channel: 'a', spend: 100, attributedRevenue: 1000, sentimentSignal: 10 },
      { channel: 'b', spend: 100, attributedRevenue: 3000, sentimentSignal: 0 },
    ], 200);
    expect(sum(res.map((r) => r.salesLiftContribution))).toBeCloseTo(100, 1);
  });

  it('falls back to an equal budget split when no channel has a positive ROI', () => {
    // Both channels have spend but zero revenue → roi 0 → equal fallback so the budget is still allocated.
    const res = computeMmm([
      { channel: 'a', spend: 100, attributedRevenue: 0, sentimentSignal: 0 },
      { channel: 'b', spend: 100, attributedRevenue: 0, sentimentSignal: 0 },
    ], 200);
    expect(res.map((r) => r.optimalBudgetAllocation)).toEqual([100, 100]);
  });

  it('is deterministic — identical inputs yield identical outputs', () => {
    const inputs: MmmChannelInput[] = [
      { channel: 'a', spend: 123.45, attributedRevenue: 987.65, sentimentSignal: 7 },
      { channel: 'b', spend: 55, attributedRevenue: 4321, sentimentSignal: 3 },
    ];
    expect(computeMmm(inputs, 178.45)).toEqual(computeMmm(inputs, 178.45));
  });
});
