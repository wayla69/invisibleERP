import { describe, it, expect } from 'vitest';
import {
  marginWeight, rankNextOffers, rankBestAudiences, rankSegmentOffer, type AffinityPair, type SkuMargin,
} from '../src/modules/marketing-activation/propensity-scoring';

// Propensity & Cross-Sell scoring (docs/61 Phase 1, MKT-23). Pure, deterministic.

const pair = (over: Partial<AffinityPair> = {}): AffinityPair => ({
  item_a: 'A', name_a: 'Coffee', item_b: 'B', name_b: 'Croissant',
  pair_count: 10, confidence_a_to_b_pct: 80, confidence_b_to_a_pct: 40, lift: 2, ...over,
});

describe('marginWeight', () => {
  it('is neutral (1) for an uncosted / zero / negative margin', () => {
    expect(marginWeight(undefined)).toBe(1);
    expect(marginWeight({ margin_pct: null })).toBe(1);
    expect(marginWeight({ margin_pct: 0 })).toBe(1);
    expect(marginWeight({ margin_pct: -5 })).toBe(1);
  });
  it('rises toward 2 with margin%, clamped at a 100% margin', () => {
    expect(marginWeight({ margin_pct: 50 })).toBeCloseTo(1.5, 6);
    expect(marginWeight({ margin_pct: 100 })).toBe(2);
    expect(marginWeight({ margin_pct: 250 })).toBe(2); // clamped
  });
});

describe('rankNextOffers', () => {
  const margins = new Map<string, SkuMargin>([
    ['B', { name: 'Croissant', margin: 30, margin_pct: 50 }],
    ['C', { name: 'Cake', margin: 60, margin_pct: 60 }],
  ]);

  it('offers the un-owned side of a pair whose owned side the customer buys, excluding what they own', () => {
    const offers = rankNextOffers(['A'], [pair()], margins);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.item_id).toBe('B');
    expect(offers[0]!.driver_item_id).toBe('A'); // "why": they buy Coffee
    // score = (80/100) × 2 × marginWeight(50%) = 0.8 × 2 × 1.5 = 2.4
    expect(offers[0]!.score).toBeCloseTo(2.4, 6);
  });

  it('never re-offers an item the customer already buys (both sides owned → no candidate)', () => {
    expect(rankNextOffers(['A', 'B'], [pair()], margins)).toHaveLength(0);
  });

  it('returns nothing when the customer owns none of the antecedents', () => {
    expect(rankNextOffers(['Z'], [pair()], margins)).toHaveLength(0);
  });

  it('keeps the STRONGEST driver per candidate and ranks by score', () => {
    const pairs = [
      pair({ item_a: 'A', item_b: 'C', confidence_a_to_b_pct: 30, lift: 1.5 }), // A→C weak
      pair({ item_a: 'D', name_a: 'Tea', item_b: 'C', confidence_a_to_b_pct: 90, lift: 3 }), // D→C strong
      pair({ item_a: 'A', item_b: 'B', confidence_a_to_b_pct: 80, lift: 2 }), // A→B
    ];
    const offers = rankNextOffers(['A', 'D'], pairs, margins);
    const c = offers.find((o) => o.item_id === 'C')!;
    expect(c.driver_item_id).toBe('D'); // the stronger driver won
    // C score = 0.9 × 3 × marginWeight(60%) = 0.9 × 3 × 1.6 = 4.32 ; B = 0.8 × 2 × 1.5 = 2.4
    expect(offers[0]!.item_id).toBe('C');
    expect(offers[0]!.score).toBeCloseTo(4.32, 6);
  });

  it('honours the direction: B→A confidence offers A when only B is owned', () => {
    const offers = rankNextOffers(['B'], [pair()], new Map());
    expect(offers[0]!.item_id).toBe('A');
    expect(offers[0]!.confidence_pct).toBe(40); // confidence_b_to_a_pct
  });

  it('filters below minLift', () => {
    expect(rankNextOffers(['A'], [pair({ lift: 0.9 })], margins, { minLift: 1 })).toHaveLength(0);
  });

  it('is deterministic — same inputs, same order', () => {
    const pairs = [pair(), pair({ item_a: 'A', item_b: 'C', confidence_a_to_b_pct: 90, lift: 3 })];
    const a = rankNextOffers(['A'], pairs, margins);
    const b = rankNextOffers(['A'], pairs, margins);
    expect(a).toEqual(b);
  });
});

describe('rankBestAudiences', () => {
  const drivers = new Set(['A', 'D']); // buying A or D implies the product P

  it('ranks segments by reach × value, excluding members who already own the product', () => {
    const members = [
      { segment: 'VIP', favorites: ['A'], owns_product: false, clv: 1000 },
      { segment: 'VIP', favorites: ['D'], owns_product: false, clv: 2000 },
      { segment: 'New', favorites: ['A'], owns_product: false, clv: 100 },
      { segment: 'VIP', favorites: ['A'], owns_product: true, clv: 9000 }, // already owns → excluded
      { segment: 'New', favorites: ['Z'], owns_product: false, clv: 500 }, // no driver → excluded
    ];
    const aud = rankBestAudiences('P', drivers, members, {});
    expect(aud.map((a) => a.segment)).toEqual(['VIP', 'New']);
    const vip = aud[0]!;
    expect(vip.count).toBe(2);
    expect(vip.avg_clv).toBe(1500);   // (1000 + 2000) / 2
    expect(vip.score).toBe(3000);     // 2 × 1500
    expect(aud[1]!.count).toBe(1);    // New: one member
  });

  it('buckets a null segment as "—" and tolerates missing CLV', () => {
    const aud = rankBestAudiences('P', drivers, [
      { segment: null, favorites: ['A'], owns_product: false, clv: null },
    ], {});
    expect(aud[0]!.segment).toBe('—');
    expect(aud[0]!.avg_clv).toBeNull();
    expect(aud[0]!.score).toBe(0);
  });
});

describe('rankSegmentOffer (the ③→① top-offer hook)', () => {
  const margins = new Map<string, SkuMargin>([
    ['B', { name: 'Croissant', margin: 30, margin_pct: 50 }],
    ['C', { name: 'Cake', margin: 60, margin_pct: 60 }],
  ]);
  const member = (...favs: string[]) => ({ favorites: favs });

  it('returns the reach-weighted top un-bought product with its driver ("why")', () => {
    // 3 members own A; one already owns B → reach for A→B is 2. conf 80% × lift 2 × mw 1.5 × reach 2 = 4.8.
    const offer = rankSegmentOffer([member('A'), member('A'), member('A', 'B')], [pair()], margins);
    expect(offer).not.toBeNull();
    expect(offer!.item_id).toBe('B');
    expect(offer!.name).toBe('Croissant');
    expect(offer!.driver_item_id).toBe('A');
    expect(offer!.reach).toBe(2);
    expect(offer!.score).toBeCloseTo(4.8, 4);
  });

  it('excludes a candidate already owned by a majority of the segment (the staple)', () => {
    // B owned by 2 of 3 members (67% > 50%) → not an offer; C (driven by A) wins instead.
    const pairs = [pair(), pair({ item_a: 'A', item_b: 'C', name_b: 'Cake', confidence_a_to_b_pct: 50, lift: 1.5 })];
    const offer = rankSegmentOffer([member('A', 'B'), member('A', 'B'), member('A')], pairs, margins);
    expect(offer!.item_id).toBe('C');
  });

  it('weights by margin — a fatter-margin candidate out-ranks a same-signal thin one', () => {
    const pairs = [
      pair({ item_b: 'B', name_b: 'Croissant' }),                     // margin_pct 50 → weight 1.5
      pair({ item_b: 'C', name_b: 'Cake' }),                          // margin_pct 60 → weight 1.6
    ];
    const offer = rankSegmentOffer([member('A')], pairs, margins);
    expect(offer!.item_id).toBe('C');
  });

  it('needs real reach — a driver nobody owns yields nothing', () => {
    expect(rankSegmentOffer([member('Z')], [pair()], margins)).toBeNull();
  });

  it('honours minLift and returns null on an empty segment or empty pairs', () => {
    expect(rankSegmentOffer([], [pair()], margins)).toBeNull();
    expect(rankSegmentOffer([member('A')], [], margins)).toBeNull();
    expect(rankSegmentOffer([member('A')], [pair({ lift: 0.9 })], margins)).toBeNull(); // default minLift 1
  });

  it('is deterministic — ties break toward the lexicographically-smaller item', () => {
    const noMargin = new Map<string, SkuMargin>();
    const pairs = [
      pair({ item_b: 'D', name_b: 'D' }),
      pair({ item_b: 'C', name_b: 'C' }),
    ];
    const a = rankSegmentOffer([member('A')], pairs, noMargin);
    const b = rankSegmentOffer([member('A')], pairs, noMargin);
    expect(a).toEqual(b);
    expect(a!.item_id).toBe('C'); // identical scores → smaller id wins
  });
});
