import { describe, it, expect } from 'vitest';
import {
  liftMultiplier, rankSegmentChannel, type SegmentValue, type ChannelRoi,
} from '../src/modules/marketing-activation/segment-channel-scoring';

// Segment × Channel ROI scoring (docs/61 Phase 2, MKT-25). Pure, deterministic.

describe('liftMultiplier', () => {
  it('is 1 for a segment with no measured experiment (MMM only)', () => {
    expect(liftMultiplier(null)).toBe(1);
    expect(liftMultiplier(undefined)).toBe(1);
  });
  it('scales the channel ROI by the measured lift (+900% → 10×, 0% → 1×)', () => {
    expect(liftMultiplier(0)).toBe(1);
    expect(liftMultiplier(900)).toBe(10);
    expect(liftMultiplier(50)).toBeCloseTo(1.5, 6);
  });
  it('floors a proven-negative lift at 0 (no incremental spend earned)', () => {
    expect(liftMultiplier(-100)).toBe(0);
    expect(liftMultiplier(-250)).toBe(0);
  });
});

describe('rankSegmentChannel', () => {
  const segments: SegmentValue[] = [
    { segment: 'VIP', count: 100, avg_clv: 500 },   // value 50000
    { segment: 'New', count: 200, avg_clv: 50 },     // value 10000
  ];
  const channels: ChannelRoi[] = [
    { channel: 'facebook', roi: 3 },
    { channel: 'tiktok', roi: 1 },
  ];

  it('ranks cells by incremental ROI × segment value and emits a cell per segment×channel', () => {
    const plan = rankSegmentChannel(segments, channels, new Map(), 100000);
    expect(plan.cells).toHaveLength(4); // 2 segments × 2 channels
    const top = plan.cells[0]!;
    expect(top.segment).toBe('VIP');
    expect(top.channel).toBe('facebook');
    // score = incremental_roi(3×1) × value(50000) = 150000
    expect(top.score).toBe(150000);
    expect(plan.basis).toBe('mmm'); // no measured lift supplied
  });

  it('a measured segment lift multiplies that segment\'s cells and flips the basis', () => {
    const lift = new Map<string, number | null>([['New', 900]]); // New now 10× its MMM ROI
    const plan = rankSegmentChannel(segments, channels, lift, 100000);
    const newFb = plan.cells.find((c) => c.segment === 'New' && c.channel === 'facebook')!;
    // incremental_roi = 3 × 10 = 30 ; value 10000 → score 300000 (beats VIP×fb 150000)
    expect(newFb.incremental_roi).toBe(30);
    expect(newFb.score).toBe(300000);
    expect(plan.cells[0]!.segment).toBe('New');
    expect(plan.basis).toBe('measured+mmm');
  });

  it('splits the budget across channels proportional to their summed cell score, ~summing to budget', () => {
    const plan = rankSegmentChannel(segments, channels, new Map(), 100000);
    const total = Object.values(plan.channel_allocation).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100000, 0);
    // facebook (roi 3) earns 3× tiktok (roi 1) across identical value → 75% / 25%
    expect(plan.channel_allocation.facebook).toBeCloseTo(75000, 0);
    expect(plan.channel_allocation.tiktok).toBeCloseTo(25000, 0);
  });

  it('splits evenly when there is no signal (all zero score)', () => {
    const plan = rankSegmentChannel(
      [{ segment: 'X', count: 0, avg_clv: null }],
      channels, new Map(), 100,
    );
    expect(plan.channel_allocation.facebook).toBe(50);
    expect(plan.channel_allocation.tiktok).toBe(50);
    expect(plan.total_score).toBe(0);
  });

  it('handles no channels / no segments as a well-formed empty plan', () => {
    expect(rankSegmentChannel(segments, [], new Map(), 100).cells).toHaveLength(0);
    const empty = rankSegmentChannel([], channels, new Map(), 100);
    expect(empty.cells).toHaveLength(0);
    expect(empty.basis).toBe('none');
  });

  it('is deterministic — same inputs, same cells + allocation', () => {
    const a = rankSegmentChannel(segments, channels, new Map(), 100000);
    const b = rankSegmentChannel(segments, channels, new Map(), 100000);
    expect(a).toEqual(b);
  });
});
