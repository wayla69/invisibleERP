// Propensity & Cross-Sell — the PURE, deterministic scoring core (docs/61 Phase 1, control MKT-23).
// No DB, no IO — same inputs always yield the same ranking, so it is unit-tested (propensity-scoring.test.ts)
// exactly like the MKT-17 optimiser. The service layer feeds it real facts; this file only ranks.

// One association-rule pair from the menu-affinity engine (analytics module). Confidences are directional %.
export interface AffinityPair {
  item_a: string; name_a: string;
  item_b: string; name_b: string;
  pair_count: number;
  confidence_a_to_b_pct: number; // P(buys B | buys A) × 100
  confidence_b_to_a_pct: number; // P(buys A | buys B) × 100
  lift: number;                  // >1 = co-purchased more than chance
}

export interface SkuMargin { name?: string; margin?: number | null; margin_pct?: number | null }

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const r4 = (x: number): number => Math.round(x * 10000) / 10000;

// Margin weight ∈ [1, 2]: a fully-marginal item doubles the score, an uncosted/zero-margin item is neutral.
// Keeps a high-lift-but-thin item from out-ranking a slightly-lower-lift but far more profitable one.
export function marginWeight(m: SkuMargin | undefined): number {
  const pct = m?.margin_pct;
  if (pct == null || !Number.isFinite(pct) || pct <= 0) return 1;
  return 1 + clamp(pct / 100, 0, 1);
}

export interface OfferCandidate {
  item_id: string;
  name: string;
  confidence_pct: number; // best directional confidence from a driver the customer already buys
  lift: number;
  unit_margin: number | null;
  margin_pct: number | null;
  driver_item_id: string;  // the owned item that most strongly implies this offer ("why")
  driver_name: string;
  score: number;           // (confidence/100) × lift × marginWeight — advisory rank key
}

// Rank the "next product to offer" a customer: for every affinity pair with ONE side the customer already
// buys and the OTHER side they do NOT, the un-owned side is a candidate; keep the strongest driver per
// candidate. Excludes everything the customer already buys (no point re-selling it). Advisory only.
export function rankNextOffers(
  owned: Iterable<string>,
  pairs: AffinityPair[],
  marginBySku: Map<string, SkuMargin>,
  opts?: { top?: number; minLift?: number; minConfidencePct?: number },
): OfferCandidate[] {
  const own = new Set<string>();
  for (const o of owned) { const s = String(o ?? '').trim(); if (s) own.add(s); }
  const top = Math.min(Math.max(Number(opts?.top ?? 10) || 10, 1), 100);
  const minLift = Number(opts?.minLift ?? 1) || 0;         // default: only better-than-chance associations
  const minConf = Number(opts?.minConfidencePct ?? 0) || 0;

  const best = new Map<string, OfferCandidate>();
  const consider = (
    driverId: string, driverName: string, candId: string, candName: string, confPct: number, lift: number,
  ): void => {
    if (!own.has(driverId) || own.has(candId) || !candId) return; // driver owned, candidate NOT owned
    if (lift < minLift || confPct < minConf) return;
    const m = marginBySku.get(candId);
    const score = r4((confPct / 100) * lift * marginWeight(m));
    const prev = best.get(candId);
    if (prev && prev.score >= score) return;
    best.set(candId, {
      item_id: candId,
      name: m?.name ?? candName ?? candId,
      confidence_pct: r4(confPct),
      lift: r4(lift),
      unit_margin: m?.margin ?? null,
      margin_pct: m?.margin_pct ?? null,
      driver_item_id: driverId,
      driver_name: driverName,
      score,
    });
  };

  for (const p of pairs) {
    consider(p.item_a, p.name_a, p.item_b, p.name_b, p.confidence_a_to_b_pct, p.lift); // A → B
    consider(p.item_b, p.name_b, p.item_a, p.name_a, p.confidence_b_to_a_pct, p.lift); // B → A
  }

  return Array.from(best.values())
    .sort((x, y) => y.score - x.score || y.lift - x.lift || x.item_id.localeCompare(y.item_id))
    .slice(0, top);
}

export interface SegmentOffer {
  item_id: string;
  name: string;
  reach: number;           // members who own the driver but NOT the candidate (plausible next buyers)
  driver_item_id: string;  // the owned item that most strongly implies the offer ("why")
  driver_name: string;
  score: number;           // per-member offer score × reach — where the segment-level upside sits
}

// The SEGMENT-level "top un-bought products" ranking (the ③→① hook + docs/62 Phase 2 offer-level ⑤):
// aggregate the members' favourites, then rank candidate products exactly like rankNextOffers — driver
// owned / candidate not — but at segment scale: a candidate already owned by a MAJORITY of the segment is
// excluded (it is the segment's staple, not an offer), each (driver → candidate) edge is weighted by its
// actual reach (members owning the driver without the candidate), and per candidate only the STRONGEST
// driver's score is kept (mirrors rankNextOffers). Deterministic ranked list. Advisory only.
export function rankSegmentOffers(
  members: { favorites: string[] }[],
  pairs: AffinityPair[],
  marginBySku: Map<string, SkuMargin>,
  opts?: { top?: number; majorityPct?: number; minLift?: number },
): SegmentOffer[] {
  const n = members.length;
  if (n === 0 || pairs.length === 0) return [];
  const top = Math.min(Math.max(Number(opts?.top ?? 3) || 3, 1), 10);
  const majorityPct = clamp(Number(opts?.majorityPct ?? 50) || 50, 0, 100);
  const minLift = Number(opts?.minLift ?? 1) || 0;

  // Ownership counts per item across the segment (favourites de-duplicated per member).
  const ownedBy = new Map<string, Set<number>>();
  members.forEach((m, i) => {
    for (const f of m.favorites) {
      const s = String(f ?? '').trim();
      if (!s) continue;
      let set = ownedBy.get(s);
      if (!set) { set = new Set<number>(); ownedBy.set(s, set); }
      set.add(i);
    }
  });

  const best = new Map<string, SegmentOffer>();
  const consider = (
    driverId: string, driverName: string, candId: string, candName: string, confPct: number, lift: number,
  ): void => {
    if (!candId || candId === driverId || lift < minLift) return;
    const candOwners = ownedBy.get(candId)?.size ?? 0;
    if ((candOwners / n) * 100 > majorityPct) return; // segment staple — nothing left to offer
    const driverOwners = ownedBy.get(driverId);
    if (!driverOwners || driverOwners.size === 0) return;
    const candSet = ownedBy.get(candId);
    let reach = 0;
    for (const i of driverOwners) if (!candSet?.has(i)) reach += 1;
    if (reach === 0) return;
    const m = marginBySku.get(candId);
    const score = r4((confPct / 100) * lift * marginWeight(m) * reach);
    const prev = best.get(candId);
    if (prev && prev.score >= score) return; // keep the strongest driver per candidate
    best.set(candId, { item_id: candId, name: m?.name ?? candName ?? candId, reach, driver_item_id: driverId, driver_name: driverName, score });
  };

  for (const p of pairs) {
    consider(p.item_a, p.name_a, p.item_b, p.name_b, p.confidence_a_to_b_pct, p.lift); // A → B
    consider(p.item_b, p.name_b, p.item_a, p.name_a, p.confidence_b_to_a_pct, p.lift); // B → A
  }
  return Array.from(best.values())
    .sort((x, y) => y.score - x.score || x.item_id.localeCompare(y.item_id))
    .slice(0, top);
}

// The single top un-bought product (the ③→① Studio hook) — the head of the ranked list.
export function rankSegmentOffer(
  members: { favorites: string[] }[],
  pairs: AffinityPair[],
  marginBySku: Map<string, SkuMargin>,
  opts?: { majorityPct?: number; minLift?: number },
): SegmentOffer | null {
  return rankSegmentOffers(members, pairs, marginBySku, { ...opts, top: 1 })[0] ?? null;
}

export interface AudienceSegment {
  segment: string;
  count: number;         // members whose basket implies the product (drivers ∈ their favourites)
  avg_clv: number | null;
  score: number;         // count × avg_clv — where the incremental revenue most plausibly sits
}

// For ONE product, rank the segments whose members most plausibly buy it next: a member is a candidate for
// the product if any of the product's affinity ANTECEDENTS is in their favourites (and they don't already
// buy the product). Grouped by segment, ranked by reach × value. Advisory; feeds a consent-gated draft.
export function rankBestAudiences(
  productId: string,
  drivers: Set<string>, // items whose purchase implies the product (affinity antecedents)
  members: { segment: string | null; favorites: string[]; owns_product: boolean; clv: number | null }[],
  opts?: { top?: number },
): AudienceSegment[] {
  const top = Math.min(Math.max(Number(opts?.top ?? 20) || 20, 1), 100);
  const bySeg = new Map<string, { count: number; clvSum: number; clvN: number }>();
  for (const m of members) {
    if (m.owns_product) continue;
    if (!m.favorites.some((f) => drivers.has(f))) continue;
    const seg = m.segment ?? '—';
    let g = bySeg.get(seg);
    if (!g) { g = { count: 0, clvSum: 0, clvN: 0 }; bySeg.set(seg, g); }
    g.count += 1;
    if (m.clv != null && Number.isFinite(m.clv)) { g.clvSum += m.clv; g.clvN += 1; }
  }
  return Array.from(bySeg.entries())
    .map(([segment, g]) => {
      const avg = g.clvN ? r4(g.clvSum / g.clvN) : null;
      return { segment, count: g.count, avg_clv: avg, score: r4(g.count * (avg ?? 0)) };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.segment.localeCompare(b.segment))
    .slice(0, top);
}
